import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const page = readFileSync(new URL("../donate.html", import.meta.url), "utf8");
const boardCode = page.slice(page.indexOf("// 加载粉丝鸣谢榜"), page.indexOf("// 显示用户昵称/邮箱"));

function board(pages) {
  const dom = new JSDOM('<div id="thanksList"></div><button id="loadMoreBtn"></button>');
  let calls = 0;
  const context = vm.createContext({
    document: dom.window.document,
    uiText: value => value,
    formatTime: () => "10月3日 12:00",
    supabase: { from(table) {
      assert.equal(table, "thanks");
      return { select() { return this; }, order() { return this; }, async range() {
        return { data: pages[calls++], error: null };
      } };
    } },
  });
  vm.runInContext(boardCode, context);
  return { document: dom.window.document, load: reset => vm.runInContext(`loadThanks(${reset})`, context),
    setUser: () => vm.runInContext('currentUserEmail = "owner@example.test"', context) };
}

test("stored nickname, message, and id remain text rather than DOM markup", async () => {
  const row = {
    id: '\"><img src=x onerror="attack()">',
    name: '<svg onload="attack()">name</svg>',
    message: '<img src=x onerror="attack()"><script>attack()</script>',
  };
  const { document, load } = board([[row]]);
  await load(true);
  const item = document.querySelector(".thanks-item");
  assert.equal(item.dataset.id, row.id);
  assert.equal(item.querySelector(".name").textContent, row.name);
  assert.equal(item.querySelector(".msg").textContent, row.message);
  assert.equal(document.querySelectorAll("img,svg,script,[onerror],[onload]").length, 0);
});

test("safe board rendering preserves pagination, mine styling, time, and like controls", async () => {
  const row = { id: "row-1", name: "owner@example.test", message: "", created_at: "2026-10-03" };
  const { document, load, setUser } = board([Array(8).fill(row), [{ ...row, id: "row-9" }]]);
  setUser();
  await load(true);
  assert.equal(document.querySelectorAll(".thanks-item.mine").length, 8);
  assert.equal(document.querySelector(".msg").textContent, "感谢支持！");
  assert.equal(document.querySelector(".time").textContent, "10月3日 12:00");
  assert.equal(document.querySelector(".like-btn .heart").tagName, "SPAN");
  assert.equal(document.querySelector(".like-count").textContent, "0");
  assert.equal(document.getElementById("loadMoreBtn").style.display, "inline-block");
  await load(false);
  assert.equal(document.querySelectorAll(".thanks-item").length, 9);
  assert.equal(document.getElementById("loadMoreBtn").style.display, "none");
});
