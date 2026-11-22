import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';

import {appendFurryEventMessage} from '../ai/furry-event-cards.js';
import {buildFurryEventModelHistory, createFurryEventCardMessage, getLatestFurryEventCard} from '../ai/furry-events.js';
import {createAssistantHistoryMessage} from '../ai/reasoning.js';

const workerRoot = process.env.SUNLAND_FURRY_GATEWAY_TEST_ROOT;
const explorationArtifact = process.env.SUNLAND_FURRY_EXPLORATION_ARTIFACT;
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

async function verifyWebTurns(t, exploration = false, mocked = false) {
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
      const sse = execFileSync(process.execPath, [resolve(workerRoot, 'test/fixtures/furry-city-turn.mjs'), JSON.stringify(body), contextFile], {
        encoding:'utf8', env:exploration ? {...process.env,SUNLAND_FURRY_EXPLORATION_FIXTURE:'1',SUNLAND_FURRY_PUBLIC_FIXTURE:'1',
          SUNLAND_FURRY_WORKER_ARTIFACT:explorationArtifact} : process.env,
      });
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
  if (mocked) {
    history.push({role:'user', content:'广州最近有什么兽聚？'});
    const outcome = {type:'furry_event_result',status:'unavailable'};
    const reply = '好的，这次不查兽聚。';
    const frame = {choices:[{delta:{content:reply}}]};
    const runFrames = async (...frames) => {
      overrideResponse = () => new Response(frames.map(item => `data: ${JSON.stringify(item)}\n\n`).join('') + 'data: [DONE]\n\n');
      await run({history,bubble:window.document.querySelector('#answer'),controller:new AbortController(),
        nativeFurry:true,userId:'fixture-user',sessionGeneration:1,conversationId:1795258285119});
    };
    await runFrames(outcome);
    assert.equal(history.at(-1).content, '兽聚信息暂时获取失败，请稍后再试');
    history.at(-2).furryPage = {query:{},nextCursor:null};
    const previousView = chatInner.lastElementChild;
    history.push({role:'user',content:'不要查兽聚'});
    await runFrames(frame);
    assert.equal(history.at(-1).content, reply);
    assert.equal(window.document.querySelector('#answer').textContent, reply);
    assert.equal(chatInner.lastElementChild, previousView);
    window.close();
    return;
  }
  if (exploration) {
    let recommendations;
    for (const [prompt, cards, expected] of [
      ['兽聚是什么？',0,/兽迷线下交流/],
      ['最近有什么兽聚？',4,/FCC 共找到 4 场活动，本页显示 4 场/],
      ['推荐5个你觉得适合的',4,/推荐 4 场[\s\S]+夹具场馆 1/],
      ['把刚才推荐的几个再显示一下',4,/相关兽聚活动/],
      ['宁波的',0,/没有找到相关兽聚活动/],
      ['显示几个卡片给我看',0,/没有找到相关兽聚活动/],
      ['换成杭州的',0,/获取失败/],
      ['重试杭州的查询',1,/杭州夹具活动 4/],
      ['再显示这几场',1,/相关兽聚活动/],
      ['只要下个月的',1,/杭州夹具活动 4/],
      ['第一个怎么样',0,/杭州夹具活动 4在夹具场馆 4/],
      ['再给我看三个',0,/全部看过/],
      ['讲个冷笑话',0,/冰箱说/],
    ]) {
      const previousView = chatInner.lastElementChild;
      history.push({role:'user',content:prompt});
      await run({history,bubble:window.document.querySelector('#answer'),controller:new AbortController(),
        nativeFurry:true,userId:'fixture-user',sessionGeneration:1,conversationId:1795258285119});
      const view = chatInner.lastElementChild;
      const rendered = view && view !== previousView ? [...view.querySelectorAll('.furry-event-title')].map(node=>node.textContent) : [];
      assert.equal(rendered.length,cards,prompt);
      assert.match(history.at(-1).content,expected,prompt);
      if (prompt === '推荐5个你觉得适合的') recommendations = rendered;
      if (prompt === '把刚才推荐的几个再显示一下') assert.deepEqual(rendered,recommendations);
      if (prompt === '宁波的' || prompt === '显示几个卡片给我看') {
        assert.equal(getLatestFurryEventCard(history).furryPage.query.location_scope.name,'宁波');
        assert.equal(getLatestFurryEventCard(history).furryPage.eventReference,undefined);
      }
    }
    window.close();
    return;
  }
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
      assert.match(history.at(-1).content, city === '京都' ? /记录不足以确认/ : /没有找到相关兽聚活动/);
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
  overrideResponse = () => new Response('data: {"choices":[{"delta":{"content":"兽迷线下聚会。"}}]}\n\ndata: [DONE]\n\n');
  assert.equal(await runPrompt('兽聚是什么？'), '兽迷线下聚会。');
  assert.equal(chatInner.lastElementChild, previousCard);
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
}

test('Web preserves a normal reply after a city search and renders explicit Gateway failures', t => verifyWebTurns(t,false,true));
test('Web chat renders FCC Gateway cards and continues the latest city query', {skip: !workerRoot}, t => verifyWebTurns(t));
test('Web exploration renders grounded recommendations, redisplays and replaces city conditions',
  {skip: !workerRoot || !explorationArtifact}, t => verifyWebTurns(t,true));

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
