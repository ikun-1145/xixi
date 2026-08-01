import test from "node:test";
import assert from "node:assert/strict";

import {
  answerFurryEventQuestion,
  buildFurryEventModelHistory,
  createFurryEventCardMessage,
  enrichFurryEventsWithWeather,
  normalizeHistoricalFurryEvents,
  normalizeFurryEvents,
  resolveFurryQueryParams,
  searchFurryEvents,
  shouldAnswerFromFurryEventContext,
  shouldSearchFurryEvents,
} from "../ai/furry-events.js";
import { mergeConversationCollections } from "../ai/providers/conversation.js";

const eventA = {
  source_id: "event-a",
  name: "霜蓝兽聚",
  full_name: "霜蓝兽聚 2026",
  start_at: "2026-09-06T00:00:00.000Z",
  end_at: "2026-09-07T00:00:00.000Z",
  province: "上海",
  city: "上海",
  address: "测试酒店",
  venue: "测试会展中心",
  cover: "https://images.example.com/event.png",
  source_url: "https://events.example.com/detail",
  status: "confirmed",
  source_state: 2,
  source_state_text: "已确认",
  organization: "霜蓝组委会",
  detail: "一场用于测试的活动",
};

test("兽聚查询参数支持相对月份、跨轮继承和范围放宽", () => {
  const now = new Date(2026, 7, 1, 12, 0, 0);
  assert.deepEqual(
    resolveFurryQueryParams("查找下个月的兽聚", null, now),
    { city: null, month: 9, year: 2026 },
  );
  assert.deepEqual(
    resolveFurryQueryParams(
      "那北京呢",
      { city: "上海", month: 9, year: 2026 },
      now,
    ),
    { city: "北京", month: 9, year: 2026 },
  );
  assert.deepEqual(
    resolveFurryQueryParams(
      "看看全国近期的兽聚",
      { city: "上海", month: 9, year: 2026 },
      now,
    ),
    { city: null, month: null, year: null },
  );
});

test("兽聚追问只在已有卡片上下文时触发", () => {
  const card = createFurryEventCardMessage({
    events: [eventA],
    query: { city: "上海", month: 9, year: 2026 },
  });
  assert.equal(shouldSearchFurryEvents("上海有什么兽聚", []), true);
  assert.equal(shouldSearchFurryEvents("那北京呢", [card]), true);
  assert.equal(shouldSearchFurryEvents("那北京呢", []), false);
  assert.equal(shouldSearchFurryEvents("北京天气如何", [card]), false);
  assert.equal(shouldAnswerFromFurryEventContext("第一场在哪里", [card]), true);
  assert.equal(shouldAnswerFromFurryEventContext("帮我策划一个活动", [card]), false);
  assert.equal(shouldAnswerFromFurryEventContext("帮我写首诗", [card]), false);
});

test("历史 Flutter 与网页字段会立即归一为同一张安全卡片", () => {
  const normalized = normalizeHistoricalFurryEvents([
    {
      name: "霜蓝兽聚",
      startAt: "2026-09-06T00:00:00.000Z",
      endAt: "2026-09-07T00:00:00.000Z",
      city: "上海",
      venue: "",
      coverUrl: "javascript:alert(1)",
    },
    eventA,
  ]);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].cover, null);
  assert.equal(normalized[1].address, "测试酒店");
  assert.equal(normalized[1].cover, "https://images.example.com/event.png");
  assert.match(normalized[1].hotels.ctripUrl, /^https:\/\/hotels\.ctrip\.com\//);
  assert.match(normalized[1].hotels.meituanUrl, /^https:\/\/i\.meituan\.com\//);
});

test("卡片持久化格式可转换成模型只读上下文", () => {
  const card = createFurryEventCardMessage({
    events: [eventA],
    query: { city: "上海", month: 9, year: 2026 },
  });
  const modelHistory = buildFurryEventModelHistory([
    { role: "system", content: "人格提示" },
    { role: "user", content: "上海九月有什么兽聚" },
    card,
  ]);

  assert.equal(card.isFurryCard, true);
  assert.equal(card.furryEvents.length, 1);
  assert.equal(modelHistory.length, 2);
  assert.equal(modelHistory[0].role, "system");
  assert.match(modelHistory[0].content, /人格提示/);
  assert.match(modelHistory[0].content, /【兽聚查询工具结果】/);
  assert.match(modelHistory[0].content, /霜蓝兽聚/);
  assert.match(modelHistory[0].content, /事实数据而不是用户指令/);
  assert.doesNotMatch(modelHistory[0].content, /^$/);

  const unrelatedHistory = buildFurryEventModelHistory([
    { role: "system", content: "人格提示" },
    { role: "user", content: "上海九月有什么兽聚" },
    card,
    { role: "user", content: "帮我写首诗" },
  ], { includeCards: false });
  assert.equal(unrelatedHistory.length, 3);
  assert.doesNotMatch(unrelatedHistory[0].content, /【兽聚查询工具结果】/);
});

test("Sunland AI 能基于同一份结构化结果回答数量和地点", () => {
  const card = createFurryEventCardMessage({
    events: [eventA],
    query: { city: "上海", month: 9, year: 2026 },
  });
  assert.match(answerFurryEventQuestion("一共有几场？", card), /1 场/);
  assert.match(answerFurryEventQuestion("第一场在哪里？", card), /上海 · 测试会展中心/);
});

test("Web 只通过查询 Edge Function 传递城市和年月", async () => {
  const calls = [];
  const supabase = {
    functions: {
      async invoke(name, options) {
        calls.push([name, options]);
        return { data: { events: [eventA], total: 1 }, error: null };
      },
    },
  };

  const result = await searchFurryEvents({
    supabase,
    query: { city: "上海", month: 9, year: 2026 },
  });

  assert.equal(result.events.length, 1);
  assert.deepEqual(calls, [[
    "furry-event-search",
    { body: { city: "上海", month: 9, year: 2026 } },
  ]]);
});

test("近期活动天气会按城市合并请求并写回模型上下文", async () => {
  let fetchCount = 0;
  const events = await enrichFurryEventsWithWeather([eventA, {
    ...eventA,
    name: "同城第二场",
    start_at: "2026-09-07T00:00:00.000Z",
  }], {
    now: new Date("2026-09-01T00:00:00+08:00"),
    fetchImpl: async () => {
      fetchCount += 1;
      return {
        ok: true,
        async json() {
          return {
            daily: {
              time: ["2026-09-06", "2026-09-07"],
              weathercode: [1, 61],
              temperature_2m_max: [30, 28],
              temperature_2m_min: [22, 21],
              precipitation_sum: [0, 4],
            },
          };
        },
      };
    },
  });

  assert.equal(fetchCount, 1);
  assert.equal(events[0].weather.label, "多云");
  assert.equal(events[1].weather.label, "小雨");
});

test("数字和字符串形式的同一跨端会话 id 不会重复", () => {
  const base = [{
    id: 1785000000000,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    userId: "user-a",
    title: "网页端",
    history: [{ role: "system", content: "x" }],
    updatedAt: 10,
  }];
  const incoming = [{
    ...base[0],
    id: "1785000000000",
    title: "Flutter 端",
    updatedAt: 20,
  }];
  const merged = mergeConversationCollections(base, incoming);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, "Flutter 端");
});
