import test from "node:test";
import assert from "node:assert/strict";

import {
  UpstreamContractError,
  handleRequest,
  normalizeSnapshot,
} from "../src/index.mjs";

const fetchedAt = "2026-08-01T00:00:00.000Z";

function upstreamEvent(overrides = {}) {
  return {
    id: "event-1",
    name: "霜蓝兽聚",
    fullName: "霜蓝兽聚 2026",
    time_start: "2026.08.08",
    time_end: "2026.08.09",
    address: "广东·深圳",
    image: "https://images.example.com/top.jpg",
    path: "/events/frost",
    state: 2,
    stateText: "已确认",
    title: "霜蓝工作室",
    matchedEvent: {
      address: "测试会展中心",
      coverUrl: "https://images.example.com/matched.jpg",
      cnUrl: "https://old.example.com/cn",
      globalUrl: "https://old.example.com/global",
      detail: "活动详情",
      organization: { name: "霜蓝组委会" },
    },
    ...overrides,
  };
}

function payload(events, overrides = {}) {
  return {
    success: true,
    data: events,
    total: events.length,
    lastUpdated: "2026-07-31T12:00:00+08:00",
    ...overrides,
  };
}

test("正常活动会映射为固定契约", () => {
  const result = normalizeSnapshot(payload([upstreamEvent()]), fetchedAt);
  assert.deepEqual(result.events[0], {
    source_id: "event-1",
    name: "霜蓝兽聚",
    full_name: "霜蓝兽聚 2026",
    start_at: "2026-08-08T00:00:00+08:00",
    end_at: "2026-08-09T00:00:00+08:00",
    province: "广东",
    city: "深圳",
    address: "广东·深圳",
    venue: "测试会展中心",
    cover: "https://images.example.com/top.jpg",
    status: "confirmed",
    source_state: 2,
    source_state_text: "已确认",
    source_url: "https://www.furryfusion.net/events/frost",
    source_path: "/events/frost",
    detail: "活动详情",
    organization: "霜蓝组委会",
    updated_at: "2026-07-31T04:00:00.000Z",
  });
});

test("matchedEvent 为 null 时保留可用顶层字段", () => {
  const event = normalizeSnapshot(payload([upstreamEvent({
    matchedEvent: null,
    title: "顶层组织",
  })]), fetchedAt).events[0];
  assert.equal(event.venue, null);
  assert.equal(event.detail, null);
  assert.equal(event.organization, "顶层组织");
});

test("单段地址写入 city，多段地址只按第一个分隔符拆分", () => {
  const events = normalizeSnapshot(payload([
    upstreamEvent({ id: "single", address: "呼和浩特" }),
    upstreamEvent({ id: "multi", name: "多段兽聚", address: "中国台湾·台中·西屯" }),
  ]), fetchedAt).events;
  assert.deepEqual(
    [events[0].province, events[0].city],
    [null, "呼和浩特"],
  );
  assert.deepEqual(
    [events[1].province, events[1].city],
    ["中国台湾", "台中·西屯"],
  );
});

test("顶层 image 和 path 分别优先于 matchedEvent 候选", () => {
  const event = normalizeSnapshot(payload([upstreamEvent()]), fetchedAt).events[0];
  assert.equal(event.cover, "https://images.example.com/top.jpg");
  assert.equal(event.source_url, "https://www.furryfusion.net/events/frost");
});

test("非法顶层图片回退合法 matchedEvent 图片，全部非法则为 null", () => {
  const events = normalizeSnapshot(payload([
    upstreamEvent({ image: "javascript:alert(1)" }),
    upstreamEvent({
      id: "event-2",
      name: "无图兽聚",
      image: "not-a-url",
      matchedEvent: { coverUrl: "data:image/png;base64,abc" },
    }),
  ]), fetchedAt).events;
  assert.equal(events[0].cover, "https://images.example.com/matched.jpg");
  assert.equal(events[1].cover, null);
});

test("未知 state 保留原值但不猜测业务状态", () => {
  const event = normalizeSnapshot(payload([upstreamEvent({ state: 3 })]), fetchedAt).events[0];
  assert.equal(event.status, null);
  assert.equal(event.source_state, 3);
});

test("结构异常的 state 会使整批失败", () => {
  assert.throws(
    () => normalizeSnapshot(payload([upstreamEvent({ state: "2" })]), fetchedAt),
    error => error.code === "UPSTREAM_EVENT_INVALID"
      && error.details.rejected[0].reason === "INVALID_STATE",
  );
});

test("合法空快照由 Worker 原样接受", () => {
  assert.deepEqual(normalizeSnapshot(payload([]), fetchedAt), { events: [] });
});

test("任意单条无效时整批失败且列出拒绝项", () => {
  assert.throws(
    () => normalizeSnapshot(payload([
      upstreamEvent(),
      upstreamEvent({ id: "bad", name: "坏日期", time_start: "2026.02.30" }),
    ]), fetchedAt),
    error => {
      assert.equal(error instanceof UpstreamContractError, true);
      assert.equal(error.code, "UPSTREAM_EVENT_INVALID");
      assert.equal(error.details.rejected[0].reason, "INVALID_START_DATE");
      return true;
    },
  );
});

test("重复 (name, start_at) 整批失败，重复 source_id 的不同活动可保留", () => {
  assert.throws(
    () => normalizeSnapshot(payload([
      upstreamEvent(),
      upstreamEvent({ id: "event-2" }),
    ]), fetchedAt),
    error => error.code === "UPSTREAM_DUPLICATE_EVENT",
  );
  const valid = normalizeSnapshot(payload([
    upstreamEvent(),
    upstreamEvent({
      name: "另一场兽聚",
      time_start: "2026.09.01",
      time_end: "2026.09.02",
    }),
  ]), fetchedAt);
  assert.equal(valid.events.length, 2);
  assert.equal(valid.events[0].source_id, valid.events[1].source_id);
});

test("total 与 data.length 不一致及顶层异常均失败", () => {
  assert.throws(
    () => normalizeSnapshot(payload([upstreamEvent()], { total: 2 }), fetchedAt),
    error => error.code === "UPSTREAM_SCHEMA_INVALID",
  );
  assert.throws(
    () => normalizeSnapshot([], fetchedAt),
    error => error.code === "UPSTREAM_SCHEMA_INVALID",
  );
});

test("HTTP 入口只允许 GET/OPTIONS，契约错误返回结构化 502", async () => {
  const post = await handleRequest(new Request("https://worker.test", { method: "POST" }));
  assert.equal(post.status, 405);

  const invalid = await handleRequest(
    new Request("https://worker.test"),
    async () => new Response(JSON.stringify(payload([
      upstreamEvent({ time_start: "invalid" }),
    ])), { status: 200 }),
  );
  assert.equal(invalid.status, 502);
  assert.deepEqual(await invalid.json(), {
    error: "UPSTREAM_EVENT_INVALID",
    message: "One or more upstream events could not be normalized",
    details: {
      total: 1,
      rejected: [{ source_id: "event-1", index: 0, reason: "INVALID_START_DATE" }],
    },
  });
});
