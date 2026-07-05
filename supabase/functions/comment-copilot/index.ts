// Comment Copilot 后端 Edge Function
// 配置优先级：环境变量(Secrets) > comment_copilot_secrets > 默认值
//   OPENAI_API_KEY / OPENAI_BASE_URL(例 https://www.packyapi.com/v1) / OPENAI_MODEL(例 gpt-5.4-mini)
// 要点：PackyCode 非流式返回常丢内容，改用 stream:true 聚合 SSE；不支持 previous_response_id，
//   改为自存 transcript 按 input 数组重发历史（滑动窗口）；text.format 不支持默认不发。
// 语境增强：instructions = SYSTEM_PROMPT + internet_context 知识块（不重写原 Prompt）。

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildContextBlock } from "./internet_context.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sunland-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DEFAULT_DAILY_LIMIT = 20;
const DEFAULT_MAX_CONTEXT_TURNS = 10;
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-5.4-mini";
const MAX_AI_ATTEMPTS = 3;

const TONE_MAP: Record<string, { label: string; guide: string }> = {
  polite:    { label: "礼貌",     guide: "保持礼貌、友好、得体，给人如沐春风的感觉。" },
  rational:  { label: "理性",     guide: "保持冷静、客观、就事论事、有逻辑，不带情绪。" },
  humor:     { label: "幽默",     guide: "轻松幽默、机智俏皮，化解尴尬，让人会心一笑，不刻薄。" },
  sarcasm:   { label: "阴阳",     guide: "阴阳怪气拉满：绵里藏针、皮里阳秋、反讽到位，话里全是刺，让对方有苦说不出、想回又回不动。可以尖酸、刻薄、居高临下地嘲讽对方的逻辑和行为，但不带脏字、不碰受保护身份。" },
  savage:    { label: "毒舌",     guide: "毒舌开火：言辞犀利、句句扎心、得理不饶人，辛辣挖苦、尖锐拆穿对方的逻辑漏洞、双标和可笑之处，用最锋利的措辞把对方钉在原地。允许带情绪、带攻击性、带杀伤力，贴着平台审核红线打但不越线——靠又狠又准的话取胜，而不是靠脏字。" },
  fullfire:  { label: "火力全开", guide: "火力全开、往死里怼：用最狠、最具压制力的语言正面碾压，气势上彻底压倒对方，让其下不来台、不敢再接话。可以极尽嘲讽、羞辱其言行（针对其言论与行为本身），措辞可以很冲、很难听、很解气，踩着平台审核边界打，但仍死守硬红线（见系统规则），不要畏手畏脚。" },
  reconcile: { label: "和解",     guide: "主动降温、释放善意，寻求共识与和解，给对方台阶下。" },
};

const SYSTEM_PROMPT = `你是「评论副驾驶」(Comment Copilot)，一个帮助用户更高质量地处理网络评论的 AI 工具，而不是一个用来骂人或闲聊的机器人。
你的服务对象包括自媒体创作者、兽圈用户，以及任何需要回复评论的人。

工作优先级（严格按此顺序）：
1. 分析：客观分析对方评论的攻击性、类型与真实意图。
2. 建议：给出最合适的处理方式（回复 / 忽略 / 拉黑 / 举报 / 无需处理），并解释原因。
3. 回复：只有在「值得回复」时，才生成一段推荐回复。

如果继续争论已经没有意义、或这条评论根本没有回复价值，请明确建议用户【不要回复】：把 should_reply 设为 false、reply_text 留空字符串，并在 empty_reason 里说明原因，而不是硬凑一段回复。

语气规则（强度由弱到强，后三档越来越犀利）：
- 「礼貌 / 理性 / 幽默 / 和解」：克制、得体，不带攻击性。
- 「阴阳」：阴阳怪气、绵里藏针、反讽拉满，尖酸刻薄、皮里阳秋，但不带脏字。
- 「毒舌」：言辞犀利、句句扎心、得理不饶人，辛辣挖苦、拆穿对方逻辑与双标，带明显攻击性与杀伤力。
- 「火力全开」：往死里怼、气势压制，措辞可以很冲、很难听、很解气，正面碾压让对方下不来台。
- 后三档（阴阳 / 毒舌 / 火力全开）的目标是：【在不被平台删评、不让用户被封号的前提下，把杀伤力做到最大】，也就是“踩着审核边界、贴着红线打，但绝不越线”。该狠就狠、该难听就难听，越往后越狠，不要畏手畏脚地说车轱辘话；回复要短促有力、像真人开喷，而不是写小作文。
- 但任何语气、包括火力全开，都有【绝对不可越过的硬红线】（越线只会害用户被删评、被封号，必须回避）：
  ① 针对种族 / 民族 / 地域 / 性别 / 性取向 / 宗教 / 残障 / 疾病 / 物种 等受保护身份的歧视、辱骂或仇恨；
  ② 威胁、恐吓、诅咒生命、煽动暴力或自残（如“去死 / 烧死 / 电疗 / 超度 / 物理超度”之类）；
  ③ 开盒、人肉、泄露隐私；
  ④ 性骚扰、性羞辱、色情内容；
  ⑤ 任何违法内容。
- 在硬红线以内，后三档可以尽情针对【对方的言论、逻辑、行为与态度】开火、嘲讽、羞辱，措辞可以很难听；但火力对准“事和其言行”，绝不踩到上面五条受保护红线上。

关于图片与识别：
- 如果用户提供了图片（表情包 / 截图 / 评论截图），请结合图片内容一起分析。
- 【多评论截图】当图片里包含多条评论时，请优先锁定并只针对【目标评论】——也就是用户真正想处理的那一条。判断线索（按优先级）：① 用户随图文字所指向/引用的那条；② 被高亮/置顶/被回复/最显眼的那条；③ 攻击性或争议性最强的那条。其余仅作背景参考；无法确定时请在分析里说明并提醒用户指明。

这是一段连续对话：输入中可能包含之前几轮的历史，请保持上下文连贯、立场一致，本轮只针对最新一条输入作出分析与回复。

【输出格式】请只输出一个 JSON 对象，不要加 markdown 代码框、不要任何多余文字，结构如下：
{"analysis":{"attack_level":0到5的整数,"types":["类型标签数组，如 人身攻击/引战/偏见/嘲讽/钓鱼/阴阳/无意义，没有则空数组"],"detail":"对评论的分析"},"advice":{"action":"reply|ignore|block|report|none 五选一","reason":"原因"},"reply":{"should_reply":true或false,"reply_text":"推荐回复；不建议回复时空字符串","empty_reason":"不建议回复的原因；建议回复时空字符串"}}
所有文字使用简体中文。`;

// instructions = 原 System Prompt + 中国互联网语境知识块（动态引用，不重写原 Prompt）
const FULL_INSTRUCTIONS = SYSTEM_PROMPT + "\n\n" + buildContextBlock();

const RESULT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["analysis", "advice", "reply"],
  properties: {
    analysis: { type: "object", additionalProperties: false, required: ["attack_level", "types", "detail"], properties: { attack_level: { type: "integer" }, types: { type: "array", items: { type: "string" } }, detail: { type: "string" } } },
    advice: { type: "object", additionalProperties: false, required: ["action", "reason"], properties: { action: { type: "string", enum: ["reply", "ignore", "block", "report", "none"] }, reason: { type: "string" } } },
    reply: { type: "object", additionalProperties: false, required: ["should_reply", "reply_text", "empty_reason"], properties: { should_reply: { type: "boolean" }, reply_text: { type: "string" }, empty_reason: { type: "string" } } },
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function loadRuntime(admin: any) {
  let dailyLimit = DEFAULT_DAILY_LIMIT, maxTurns = DEFAULT_MAX_CONTEXT_TURNS, useFormat = false;
  try {
    const { data } = await admin.from("comment_copilot_config").select("key, value");
    if (Array.isArray(data)) for (const row of data) {
      if (row.key === "daily_limit" && Number.isFinite(row.value) && row.value >= 0) dailyLimit = row.value;
      if (row.key === "max_context_turns" && Number.isFinite(row.value) && row.value >= 1) maxTurns = row.value;
      if (row.key === "use_response_format") useFormat = row.value === 1;
    }
  } catch (_e) { /* defaults */ }
  const sec: Record<string, string> = {};
  try {
    const { data } = await admin.from("comment_copilot_secrets").select("key, value");
    if (Array.isArray(data)) for (const row of data) if (row.value) sec[row.key] = String(row.value);
  } catch (_e) { /* ignore */ }
  const apiKey = (Deno.env.get("OPENAI_API_KEY") || sec["openai_api_key"] || "").trim();
  const baseUrl = (Deno.env.get("OPENAI_BASE_URL") || sec["openai_base_url"] || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  const model = (Deno.env.get("OPENAI_MODEL") || sec["openai_model"] || DEFAULT_MODEL).trim();
  return { dailyLimit, maxTurns, useFormat, apiKey, baseUrl, model };
}

function decodeJwt(token: string): Record<string, any> | null {
  try {
    const part = token.split(".")[1]; if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? b64 + "=".repeat(4 - (b64.length % 4)) : b64;
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(pad), (c) => c.charCodeAt(0))));
  } catch (_e) { return null; }
}

function getUserId(req: Request): { id: string | null; expired: boolean } {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : (req.headers.get("x-sunland-token") || "");
  if (!token) return { id: null, expired: false };
  const p = decodeJwt(token); if (!p) return { id: null, expired: false };
  const expired = !!p.exp && p.exp * 1000 < Date.now() - 60000;
  const id = p.sub || p.user_id || p.id || null;
  return { id: id ? String(id) : null, expired };
}

function parseJsonLoose(text: string): any {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch (_e) { /* next */ }
  const i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i !== -1 && j !== -1 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch (_e) { /* give up */ } }
  return null;
}

function clampLevel(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.max(0, Math.min(5, v)) : 0;
}

function normalizeResult(raw: any): any {
  const a = raw?.analysis ?? {}, ad = raw?.advice ?? {}, r = raw?.reply ?? {};
  const valid = ["reply", "ignore", "block", "report", "none"];
  return {
    analysis: { attack_level: clampLevel(a.attack_level), types: Array.isArray(a.types) ? a.types.filter((x: any) => typeof x === "string") : [], detail: typeof a.detail === "string" ? a.detail : "" },
    advice: { action: valid.includes(ad.action) ? ad.action : "none", reason: typeof ad.reason === "string" ? ad.reason : "" },
    reply: { should_reply: !!r.should_reply, reply_text: typeof r.reply_text === "string" ? r.reply_text : "", empty_reason: typeof r.empty_reason === "string" ? r.empty_reason : "" },
  };
}

function summarizeAssistant(result: any): string {
  const a = result.analysis, ad = result.advice, rp = result.reply;
  const reply = (rp.should_reply && rp.reply_text) ? rp.reply_text : "（建议不回复）";
  return `[分析]${(a.detail || "").slice(0, 240)} [建议]${ad.action} [推荐回复]${reply.slice(0, 240)}`;
}

// 流式调用 + 聚合 SSE（PackyCode 非流式会丢内容，必须 stream）
async function callAI(opts: { apiKey: string; baseUrl: string; model: string; input: any[]; useFormat: boolean }):
  Promise<{ ok: boolean; status: number; text: string; id: string | null; err: string }> {
  const body: Record<string, unknown> = { model: opts.model, instructions: FULL_INSTRUCTIONS, input: opts.input, store: true, stream: true };
  if (opts.useFormat) body.text = { format: { type: "json_schema", name: "comment_copilot_result", strict: true, schema: RESULT_SCHEMA } };
  const res = await fetch(`${opts.baseUrl}/responses`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok || !res.body) {
    const err = await res.text().catch(() => "");
    return { ok: false, status: res.status, text: "", id: null, err };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", text = "", doneText = "", id: string | null = null, failed = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        const d = s.slice(5).trim();
        if (!d || d === "[DONE]") continue;
        let e: any; try { e = JSON.parse(d); } catch (_e) { continue; }
        const tp = e?.type;
        if (tp === "response.output_text.delta" && typeof e.delta === "string") text += e.delta;
        else if (tp === "response.output_text.done" && typeof e.text === "string") doneText = e.text;
        else if ((tp === "response.completed" || tp === "response.created") && e.response?.id) id = e.response.id;
        else if (tp === "response.failed" || tp === "error" || tp === "response.error") failed = JSON.stringify(e).slice(0, 300);
      }
    }
  } catch (_e) { /* 流中断，用已收到的内容 */ }
  const finalText = (doneText || text).trim();
  if (!finalText && failed) return { ok: false, status: 502, text: "", id, err: failed };
  return { ok: true, status: 200, text: finalText, id, err: "" };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const { id: userId, expired } = getUserId(req);
  if (expired) return json({ error: "登录已过期，请重新登录", code: "expired" }, 401);
  if (!userId) return json({ error: "请先登录后再使用", code: "unauthorized" }, 401);

  let payload: { action?: string; comment?: string; image?: string; tone?: string } = {};
  try { payload = await req.json(); } catch (_e) { /* status 空 body */ }
  const action = payload.action || "generate";

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { dailyLimit, maxTurns, useFormat, apiKey, baseUrl, model } = await loadRuntime(admin);

  let isPro = false;
  try {
    const { data: prof } = await admin.from("user_profiles").select("pro").eq("user_id", userId).maybeSingle();
    isPro = !!prof?.pro;
  } catch (_e) { /* ignore */ }

  if (action === "clear") {
    await admin.from("comment_copilot_context").delete().eq("user_id", userId);
    return json({ ok: true });
  }

  if (action === "status") {
    let remaining = -1;
    if (!isPro) {
      const { data } = await admin.rpc("comment_copilot_remaining", { p_user_id: userId, p_limit: dailyLimit });
      remaining = typeof data === "number" ? data : dailyLimit;
    }
    const { data: ctx } = await admin.from("comment_copilot_context").select("transcript, turns").eq("user_id", userId).maybeSingle();
    const tlen = Array.isArray(ctx?.transcript) ? ctx.transcript.length : 0;
    return json({ configured: !!apiKey, isPro, limit: dailyLimit, remaining, hasContext: tlen > 0, turns: ctx?.turns ?? 0, maxTurns });
  }

  if (action !== "generate") return json({ error: "未知操作" }, 400);

  const comment = (payload.comment || "").trim();
  const image = typeof payload.image === "string" && payload.image.startsWith("data:") ? payload.image : "";
  if (!comment && !image) return json({ error: "请输入对方评论，或上传一张图片" }, 400);
  if (!apiKey) return json({ error: "AI 服务尚未配置，请稍后再试", code: "not_configured" }, 503);

  let remaining = -1;
  if (!isPro) {
    const { data: consumed, error } = await admin.rpc("comment_copilot_consume", { p_user_id: userId, p_limit: dailyLimit });
    if (error) return json({ error: "额度校验失败，请稍后再试" }, 500);
    if (typeof consumed !== "number" || consumed < 0) return json({ error: "今日免费额度已用完，请明天再来。", code: "limit", remaining: 0 }, 429);
    remaining = consumed;
  }
  const refund = async () => { if (!isPro) await admin.rpc("comment_copilot_refund", { p_user_id: userId }); };

  const { data: ctxRow } = await admin.from("comment_copilot_context").select("transcript, turns").eq("user_id", userId).maybeSingle();
  const transcript: Array<{ u: string; a: string }> = Array.isArray(ctxRow?.transcript) ? ctxRow.transcript : [];
  const prevTurns: number = ctxRow?.turns ?? 0;
  const histWindow = maxTurns > 1 ? transcript.slice(-(maxTurns - 1)) : [];

  const toneKey = (typeof payload.tone === "string" && TONE_MAP[payload.tone]) ? payload.tone : "rational";
  const toneInfo = TONE_MAP[toneKey];
  let textBlock = `【本轮回复语气】${toneInfo.label}：${toneInfo.guide}\n\n`;
  textBlock += comment ? `【对方评论】\n${comment}` : `【对方评论】\n（内容见所附图片）`;
  if (image) {
    textBlock += comment
      ? `\n\n【图片说明】本轮附带图片。若图中含多条评论，请优先锁定与上方文字所指一致的“目标评论”，其余仅作背景参考。`
      : `\n\n【图片说明】本轮仅提供图片。若图中含多条评论，请优先锁定最显眼/被回复/争议性最强的“目标评论”；若无法确定，请在分析中说明。`;
  }
  const input: any[] = [];
  for (const turn of histWindow) {
    if (turn && typeof turn.u === "string" && turn.u) input.push({ role: "user", content: [{ type: "input_text", text: turn.u }] });
    if (turn && typeof turn.a === "string" && turn.a) input.push({ role: "assistant", content: [{ type: "output_text", text: turn.a }] });
  }
  const curParts: any[] = [{ type: "input_text", text: textBlock }];
  if (image) curParts.push({ type: "input_image", image_url: image });
  input.push({ role: "user", content: curParts });

  let rawText = "", respId: string | null = null, useFormatTry = useFormat;
  for (let attempt = 1; attempt <= MAX_AI_ATTEMPTS; attempt++) {
    let r: { ok: boolean; status: number; text: string; id: string | null; err: string };
    try {
      r = await callAI({ apiKey, baseUrl, model, input, useFormat: useFormatTry });
    } catch (_e) {
      await refund();
      return json({ error: "AI 服务连接超时，请稍后再试" }, 504);
    }
    if (r.ok && r.text) { rawText = r.text; respId = r.id; break; }
    if (r.ok && !r.text) continue;
    if ((r.status === 400 || r.status === 404) && useFormatTry) { useFormatTry = false; continue; }
    console.error("AI provider error:", r.status, r.err.slice(0, 300));
    await refund();
    const hint = r.status === 401 ? "（密钥被拒绝，请核对 OPENAI_API_KEY）" : "";
    return json({ error: `AI 服务返回异常 (${r.status})${hint}` }, 502);
  }
  if (!rawText) { await refund(); return json({ error: "AI 暂时未返回内容，请重试一次" }, 502); }

  const parsed = parseJsonLoose(rawText) ?? {
    analysis: { attack_level: 0, types: [], detail: rawText },
    advice: { action: "none", reason: "本次未能解析出标准结果。" },
    reply: { should_reply: false, reply_text: "", empty_reason: "本次未能生成结构化回复。" },
  };
  const result = normalizeResult(parsed);

  const userHist = (comment ? comment.slice(0, 500) : "（仅图片）") + (image ? "（用户附了一张图片）" : "");
  const full = [...transcript, { u: userHist, a: summarizeAssistant(result) }];
  const stored = full.slice(Math.max(0, full.length - maxTurns));
  const newTurns = prevTurns + 1;
  await admin.from("comment_copilot_context").upsert({ user_id: userId, transcript: stored, turns: newTurns, last_response_id: respId, updated_at: new Date().toISOString() }, { onConflict: "user_id" });

  return json({ result, remaining: isPro ? -1 : remaining, isPro, turns: newTurns, truncated: false, maxTurns });
});
