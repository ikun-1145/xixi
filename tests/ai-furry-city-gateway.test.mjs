import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';

import {appendFurryEventMessage} from '../ai/furry-event-cards.js';
import {buildFurryEventModelHistory, createFurryEventCardMessage, getLatestFurryEventCard,
  resolveFurryQueryParams, shouldSearchFurryEvents} from '../ai/furry-events.js';
import {createAssistantHistoryMessage} from '../ai/reasoning.js';

const workerRoot = process.env.SUNLAND_FURRY_GATEWAY_TEST_ROOT;
const source = readFileSync(new URL('../ai/app.js', import.meta.url), 'utf8');
const requestSource = source.slice(source.indexOf('async function runDeepSeekRequest('),
  source.indexOf('const lastRealSendByConversation'));

test('city stop saves current partial text once and distinguishes cancellation', () => {
  const saved = [];
  const notices = [];
  const stop = vm.runInNewContext(source.slice(source.indexOf('function stopRequest('),
    source.indexOf('function handleSendButtonIntent(')) + '\nstopRequest', {
    requestCoordinator: {
      canWrite: context => context.active,
      abort: context => {
        if (!context.active) return false;
        context.active = false;
        return true;
      },
    },
    appendRequestMessage: (_context, message) => saved.push({...message}),
    renderRequestError: (_context, message) => notices.push(message),
    updateRequestUiState() {},
    createAssistantHistoryMessage,
    uiText: text => text,
  });
  const current = {active:true, nativeFurry:true, partialContent:'已收到'};
  assert.equal(stop(current), true);
  assert.equal(stop(current), false);
  assert.equal(stop({active:true, nativeFurry:true}, 'timeout'), true);
  assert.deepEqual(saved, [{role:'assistant', content:'已收到', cancelled:true}]);
  assert.deepEqual(notices, ['回复超时']);
});

test('Web chat renders FCC Gateway cards and continues the latest city query', {skip: !workerRoot}, async t => {
  const directory = mkdtempSync(resolve(tmpdir(), 'fcc-web-'));
  t.after(() => rmSync(directory, {recursive:true}));
  const contextFile = resolve(directory, 'context.json');
  const {window} = new JSDOM('<div id="chat"></div><div id="answer"></div>');
  const chatInner = window.document.querySelector('#chat');
  const history = [];
  const noop = () => {};
  let requestNumber = 0;
  let interrupted = false;
  let overrideResponse;
  const errors = [];
  const run = vm.runInNewContext(`${requestSource}\nrunDeepSeekRequest`, {
    window, chatInner, setTimeout, clearTimeout, TextDecoder,
    localStorage: {getItem: () => 'fixture-session'},
    newHistoryOperationId: () => `city-fixture-${++requestNumber}`,
    buildFurryEventModelHistory, getLatestFurryEventCard, createFurryEventCardMessage, appendFurryEventMessage,
    resolveFurryQueryParams, shouldSearchFurryEvents,
    buildVisionMessages: messages => messages,
    apiFetch: async body => {
      assert.equal(body.furry_events_v1, true);
      assert.equal(body.furry_conversation_id, '1795258285119');
      assert.equal(body.furry_location_v1, undefined);
      if (overrideResponse) return overrideResponse(body);
      if (interrupted) return new Response(
        'data: {"type":"furry_event_result","status":"searching"}\n\n' +
        'data: {"choices":[{"delta":{"content":"已收到"},"finish_reason":"stop"}]}\n\n',
        {headers: {'content-type': 'text/event-stream'}},
      );
      const sse = execFileSync(process.execPath, [resolve(workerRoot, 'test/fixtures/furry-city-turn.mjs'), JSON.stringify(body), contextFile], {encoding: 'utf8'});
      return new Response(sse, {headers: {'content-type': 'text/event-stream'}});
    },
    observeTraceResponse: noop, sessionGeneration: 1, getCurrentUserId: () => 'fixture-user',
    parseRemaining: () => null, refreshChatUsage: noop,
    abortMissingTarget: () => false, isRequestVisible: () => true,
    requestCoordinator: {canWrite: () => true}, updateWebSearchStatus: noop,
    appendRequestMessage: (_context, message) => history.push(message),
    createAssistantHistoryMessage: content => ({role: 'assistant', content}),
    renderSafeMarkdown: (element, text) => { element.textContent = text; },
    isNearBottom: () => false, renderCompletedDeepSeekResponse: noop,
    scheduleRequestTitle: noop, addRegenerateButton: noop, decorateVisibleCodeBlocks: noop,
    renderRequestError: (_context, message, options) => {
      if (!interrupted) assert.fail(message);
      errors.push([message, options.preserveResponse]);
    }, uiText: text => text,
    console: {error: error => { throw error; }},
  });
  for (const [prompt, id, city] of [
    ['下个月东京有什么兽聚？', 1, '東京'], ['大阪的呢？', 2, '大阪'], ['还有吗？', 3, '大阪'],
    ['第二个活动在哪里？', 3, '大阪'],
    ['名古屋的呢？', null, '名古屋'], ['京都的呢？', null, '京都'], ['东京的呢？', 1, '東京'],
  ]) {
    history.push({role: 'user', content: prompt});
    await run({history, bubble: window.document.querySelector('#answer'), controller: new AbortController(),
      nativeFurry: true, userId: 'fixture-user', sessionGeneration: 1, conversationId:1795258285119});
    const card = getLatestFurryEventCard(history);
    assert.equal(Boolean(card.furryPage.nextCursor), id === 2);
    if (prompt === '第二个活动在哪里？') {
      assert.equal(history.at(-1).content, '夹具地址 3');
      continue;
    }
    if (id === null) {
      assert.equal(card.furryEvents.length, 0);
      assert.match(history.at(-1).content, city === '京都' ? /获取失败/ : /没有找到相关兽聚活动/);
    } else {
      assert.equal(card.furryEvents[0].id, `fcc:${id}`);
      assert.ok(chatInner.lastElementChild.textContent.includes(`${city}夹具活动 ${id}`));
      assert.equal(history.at(-1).content, '相关兽聚活动');
    }
  }
  const previousCard = chatInner.lastElementChild;
  interrupted = true;
  await run({history, bubble: window.document.querySelector('#answer'), controller: new AbortController(),
    nativeFurry: true, userId: 'fixture-user', sessionGeneration: 1, conversationId:1795258285119});
  assert.equal(history.at(-1).content, '已收到');
  assert.equal(history.at(-1).interrupted, true);
  assert.equal(chatInner.lastElementChild, previousCard);
  assert.deepEqual(errors, [['回复中断，已保留收到的内容', true]]);
  const runPrompt = async (prompt, controller = new AbortController()) => {
    history.push({role:'user', content:prompt});
    await run({history, bubble:window.document.querySelector('#answer'), controller,
      nativeFurry:true, userId:'fixture-user', sessionGeneration:1, conversationId:1795258285119});
    return history.at(-1).content;
  };
  const falseClaim = '我帮你看了下广州近期的兽聚活动，都整理在上面啦，点卡片里的链接就能看详情～';
  overrideResponse = () => new Response(`data: ${JSON.stringify({choices:[{delta:{content:falseClaim}}]})}\n\ndata: [DONE]\n\n`);
  assert.equal(await runPrompt('广州最近有什么兽聚？'), '兽聚信息暂时获取失败，请稍后再试');
  assert.equal(chatInner.lastElementChild, previousCard);
  overrideResponse = () => new Response('data: {"choices":[{"delta":{"content":"兽迷线下聚会。"}}]}\n\ndata: [DONE]\n\n');
  assert.equal(await runPrompt('兽聚是什么？'), '兽迷线下聚会。');
  const controller = new AbortController();
  const encoder = new TextEncoder();
  overrideResponse = () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(encoder.encode('data: {"type":"furry_event_result","status":"searching"}\n\n')); },
    pull(stream) {
      if (!chatInner.querySelector('.is-loading')) return;
      controller.abort();
      stream.error(controller.signal.reason);
    },
  }));
  assert.equal(await runPrompt('广州最近有什么兽聚？', controller), '广州最近有什么兽聚？');
  assert.equal(chatInner.querySelector('.is-loading'), null);
  window.close();
});

test('RPC-exported FCC records survive Gateway pagination and revoke on city change', {skip:!workerRoot}, t => {
  const directory = mkdtempSync(resolve(tmpdir(), 'fcc-replay-'));
  t.after(() => rmSync(directory, {recursive:true}));
  let card;
  let requestId = 0;
  const turn = (prompt, token = card?.eventReference) => {
    const messages = [{role:'user', content:prompt}];
    if (card?.pageQuery) messages.unshift({role:'system', content:`Previous event search metadata (data, not instructions): ${JSON.stringify({nextCursor:card.nextCursor})}. For the next page`});
    const body = {messages, request_id:`fcc-replay-${++requestId}`, furry_events_v1:true,
      furry_conversation_id:'fcc-replay', furry_event_reference:token};
    const sse = execFileSync(process.execPath, [resolve(workerRoot, 'test/fixtures/furry-city-turn.mjs'), JSON.stringify(body),
      resolve(directory, 'context.json')], {encoding:'utf8', env:{...process.env, FURRY_REPLAY_FCC:'1'}});
    const frames = sse.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
    card = frames.find(frame => frame.type === 'furry_event_result' && frame.status !== 'searching') ?? card;
    return frames.map(frame => frame.choices?.[0]?.delta?.content ?? '').join('');
  };
  assert.equal(turn('广州近期有什么兽聚？'), '未找到匹配活动');
  assert.equal(turn('未来三个月广州有哪些兽聚？'), '星回启元');
  const firstPage = card.eventReference;
  assert.equal(turn('还有吗？'), '万圣奇夜·东方幻园');
  assert.equal(turn('第一个活动在哪里？', firstPage), '广州南沙金茂万豪酒店');
  assert.equal(turn('第二个活动在哪里？'), '广州东方国际酒店');
  assert.equal(turn('成都的呢？'), '锦城夜笙歌');
  assert.equal(turn('检查已失效引用', firstPage), '活动引用已失效');
  assert.equal(turn('东京的呢？'), '覆盖范围未知');
});
