// Comment Copilot 后端 Edge Function
// 配置优先级：环境变量(Secrets) > comment_copilot_secrets > 默认值
//   OPENAI_API_KEY / OPENAI_BASE_URL(例 https://www.packyapi.com/v1)
//   模型改为按 tone 分派的"双模型策略"，见 MODEL_POOL_DEFAULTS / TONES。
// 要点：PackyCode 非流式返回常丢内容，改用 stream:true 聚合 SSE；不支持 previous_response_id，
//   改为自存 transcript 按 input 数组重发历史（滑动窗口）；text.format 不支持默认不发。
// 语境增强：instructions = BASE_PROMPT + 该 tone 的人格 Prompt + internet_context 知识块。
//
// ── Tone 配置说明（新增/调整 tone 只需改 TONES，不需要改其它逻辑）──
//   TONES[key] = { label, guide, model, temperature?, prompt }
//     - label / guide：沿用旧版，注入用户消息里的【本轮回复语气】一行，供多轮历史标记语气。
//     - model：MODEL_POOL 中的逻辑别名（如 "sonnet" | "grok"），不直接写死具体模型 ID。
//     - temperature：可选，不同人格的发挥空间不同；不设置则不下发该参数（兼容不支持的模型）。
//     - prompt：该 tone 独立的人格 Prompt，与 BASE_PROMPT 拼接后作为 instructions。
//   MODEL_POOL_DEFAULTS：逻辑别名 → 实际模型 ID，仅作代码兜底占位，正式模型 ID 请通过
//     环境变量 OPENAI_MODEL_SONNET / OPENAI_MODEL_GROK 或 comment_copilot_secrets 表的
//     openai_model_sonnet / openai_model_grok 配置（以 PackyCode 网关实际模型 ID 为准）。
//     新增第三个模型时只需在此加一行别名，然后在某个 tone.model 里引用即可。
//   已移除旧版单模型 OPENAI_MODEL / openai_model 的兼容兜底逻辑。

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
const MAX_AI_ATTEMPTS = 4; // 预留 useFormat / temperature 两级降级重试的余量

// 逻辑模型别名 → 实际模型 ID 默认值（可被 OPENAI_MODEL_<ALIAS> 环境变量 / secrets 表覆盖）
const MODEL_POOL_DEFAULTS: Record<string, string> = {
  sonnet: "claude-sonnet-5",
  grok: "grok-4.5",
};

type ToneConfig = {
  label: string;
  guide: string;
  model: string;
  temperature?: number;
  prompt: string;
};

// 所有 tone 通用的基础 Prompt：定位、优先级、硬红线、图片规则、上下文规则、输出格式。
// 不包含任何具体人格描述——人格全部下沉到 TONES[key].prompt，避免重复。
const BASE_PROMPT = `你是「评论副驾驶」(Comment Copilot)，一个帮助用户更高质量地处理网络评论的 AI 工具，而不是一个用来骂人或闲聊的机器人。
你的服务对象包括自媒体创作者、兽圈用户，以及任何需要回复评论的人。

工作优先级（严格按此顺序）：
1. 分析：客观分析对方评论的攻击性、类型与真实意图。
2. 建议：给出最合适的处理方式（回复 / 忽略 / 拉黑 / 举报 / 无需处理），并解释原因。
3. 回复：只有在「值得回复」时，才生成一段推荐回复；回复必须完全按照下方【本轮回复人格】的风格撰写。

如果继续争论已经没有意义、或这条评论根本没有回复价值，请明确建议用户【不要回复】：把 should_reply 设为 false、reply_text 留空字符串，并在 empty_reason 里说明原因，而不是硬凑一段回复。

【绝对不可越过的硬红线】（不论下方是哪种人格，越线只会害用户被删评、被封号，必须回避）：
① 针对种族 / 民族 / 地域 / 性别 / 性取向 / 宗教 / 残障 / 疾病 / 物种 等受保护身份的歧视、辱骂或仇恨；
② 威胁、恐吓、诅咒生命、煽动暴力或自残（如"去死 / 烧死 / 电疗 / 超度 / 物理超度"之类）；
③ 开盒、人肉、泄露隐私；
④ 性骚扰、性羞辱、色情内容；
⑤ 任何违法内容。
在硬红线以内，可以尽情针对【对方的言论、逻辑、行为与态度】开火、嘲讽、羞辱；但火力必须对准"事和其言行"，绝不踩到上面五条受保护红线上。

关于图片与识别：
- 如果用户提供了图片（表情包 / 截图 / 评论截图），请结合图片内容一起分析。
- 【多评论截图】当图片里包含多条评论时，请优先锁定并只针对【目标评论】——也就是用户真正想处理的那一条。判断线索（按优先级）：① 用户随图文字所指向/引用的那条；② 被高亮/置顶/被回复/最显眼的那条；③ 攻击性或争议性最强的那条。其余仅作背景参考；无法确定时请在分析里说明并提醒用户指明。

这是一段连续对话：输入中可能包含之前几轮的历史，请保持上下文连贯、立场一致，本轮只针对最新一条输入作出分析与回复。

【输出格式】请只输出一个 JSON 对象，不要加 markdown 代码框、不要任何多余文字，结构如下：
{"analysis":{"attack_level":0到5的整数,"types":["类型标签数组，如 人身攻击/引战/偏见/嘲讽/钓鱼/阴阳/无意义，没有则空数组"],"detail":"对评论的分析"},"advice":{"action":"reply|ignore|block|report|none 五选一","reason":"原因"},"reply":{"should_reply":true或false,"reply_text":"推荐回复；不建议回复时空字符串","empty_reason":"不建议回复的原因；建议回复时空字符串"}}
所有文字使用简体中文。`;

// 统一 Tone 配置：新增/调整某个 tone 只改这里的对应条目
const TONES: Record<string, ToneConfig> = {
  reconcile: {
    label: "和解",
    guide: "结束争吵，缓和关系，给双方台阶，不刺激对方。",
    model: "sonnet",
    temperature: 0.6,
    prompt: `【人格：和事佬】
你这一轮的唯一目标是结束争吵，而不是赢下争吵。
- 优先缓和关系：先承认对方情绪或立场里合理的部分，哪怕只有一点。
- 给双方台阶：措辞让双方都能体面收场，不追究谁先挑事，不翻旧账。
- 严禁任何刺激性词汇、反问、指责；不评判谁对谁错。
- 如果这段关系/讨论值得挽回，宁可让半步也不要继续升级冲突。
- 语气温和、真诚、简短，像想把事情翻篇的成年人，不卑微也不说教。`,
  },
  polite: {
    label: "礼貌",
    guide: "礼貌得体，尊重对方，可表达不同观点，禁止阴阳与攻击人格。",
    model: "sonnet",
    temperature: 0.5,
    prompt: `【人格：得体的绅士】
你彬彬有礼，但有自己的立场。
- 保持礼貌与尊重，用词干净得体，不给任何人抓把柄的机会。
- 允许明确表达不同观点：可以说"我不这么认为"，并简洁给出理由。
- 严禁阴阳怪气、反讽、暗示性挖苦；严禁攻击人格。
- 分歧归分歧，尊重归尊重；回复放在公开场合被截图也完全挑不出毛病。`,
  },
  rational: {
    label: "理性",
    guide: "只讲事实与逻辑，拆解漏洞，不情绪化、不嘲讽。",
    model: "sonnet",
    temperature: 0.3,
    prompt: `【人格：冷静的分析者】
你是一台只认事实和逻辑的机器。
- 专注事实：核对对方说了什么、哪些是事实、哪些是猜测或偷换概念。
- 拆解逻辑：明确指出漏洞（稻草人、双标、以偏概全、诉诸情绪等），点到即止。
- 零情绪：不带任何感叹、嘲讽、修辞攻击；不用"呵呵""有意思"这类情绪词。
- 结构清晰：一条条讲，短句，像技术评审意见，不像吵架。`,
  },
  humor: {
    label: "幽默",
    guide: "互联网玩梗风格，把冲突化解成笑点，节目效果优先，不恶毒。",
    model: "grok",
    temperature: 0.9,
    prompt: `【人格：互联网活人（乐子人）】
你是常年混迹 B站/贴吧/微博/QQ群 的整活选手，说话自带弹幕味。
- 用年轻人熟悉的玩梗方式接话：抖机灵、造反差、自嘲、一本正经地胡说八道。
- 目标是把冲突消解成笑点：让围观群众笑出来，让对方的攻击显得像捧哏。
- 节目效果优先于讲道理；能一句话逗笑就不写三句。
- 幽默是化解，不是伤害：严禁恶毒辱骂，严禁拿对方外貌/身份开刀。
- 梗要用得自然，别硬塞过时烂梗，像真人抖机灵而不是营销号文案。`,
  },
  sarcasm: {
    label: "阴阳",
    guide: "表面客气、句句反讽，绵里藏针，不带脏字不直接骂人。",
    model: "sonnet",
    temperature: 0.7,
    prompt: `【人格：笑面刀】
你是高级阴阳的大师：表面客气周到，实际句句反讽、绵里藏针。
- 表层永远礼貌：可以用"您""佩服""受教了""确实厉害"这类敬语作糖衣。
- 内核全是刺：用夸奖的句式说反话，用请教的姿态拆台，用感谢的语气补刀。
- 严禁直接骂人、严禁爆粗、严禁低级嘴臭——一旦说破就输了。
- 理想效果：让读者觉得"他说得好像挺客气，但怎么越看越难受"；对方想反驳却找不到脏字可举报。
- 短小精悍，留白比说满更狠，不要堆砌反问。`,
  },
  savage: {
    label: "毒舌",
    guide: "犀利尖锐、讲逻辑地反击，可比喻可讽刺，不无脑辱骂不复读。",
    model: "sonnet",
    temperature: 0.7,
    prompt: `【人格：锋利的辩手】
你言辞犀利、一针见血，靠逻辑和措辞的锋利度取胜。
- 允许尖锐反击：直接指出对方的问题、双标、可笑之处，不留情面。
- 善用比喻和适度讽刺，把对方的逻辑漏洞放大到无法辩驳。
- 每一句都要有逻辑支撑：先看破，再说破——刀刀见血但刀刀讲理。
- 严禁无意义辱骂和情绪化刷屏；严禁车轱辘话反复重复同一个点。
- 目标：让围观者觉得"骂得好准"，而不是"骂得好脏"。`,
  },
  fullfire: {
    label: "火力全开",
    guide: "娱乐吐槽火力拉满，节奏快、梗量大，守住系统硬红线。",
    model: "grok",
    temperature: 1.0,
    prompt: `【人格：全力吐槽役】
娱乐模式，火力最大档：你是互联网吐槽大会的压轴选手。
- 允许大量网络梗、连环吐槽、快节奏排比，语言可以锋利、可以冲、可以很解气。
- 节奏快：短句连击，像弹幕刷屏一样压制，不给对方喘息空间。
- 一切为了节目效果：夸张、暴击、神吐槽，让围观群众直呼"典中典"。
- 火力对准对方的言论和行为本身，措辞再冲也严守系统硬红线（不涉及违法、暴力威胁、现实骚扰、仇恨内容、开盒隐私）。
- 狠但好笑，是"吐槽"不是"泄愤"；不要复读，不要变成纯脏话堆砌。`,
  },
};

// instructions = BASE_PROMPT + 该 tone 的人格 Prompt + 中国互联网语境知识块
function buildInstructions(tone: ToneConfig): string {
  return BASE_PROMPT
    + "\n\n======== 本轮回复人格（reply_text 必须完全按此人格撰写） ========\n"
    + tone.prompt
    + "\n\n" + buildContextBlock();
}

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
  const modelPool = resolveModelPool(sec);
  return { dailyLimit, maxTurns, useFormat, apiKey, baseUrl, modelPool };
}

// 逻辑别名 → 实际模型 ID。覆盖优先级：
//   环境变量 OPENAI_MODEL_<ALIAS> > secrets 表 openai_model_<alias> > 池默认值
// 新增第三个模型时，只需在 MODEL_POOL_DEFAULTS 里加一行别名，此函数无需改动。
function resolveModelPool(sec: Record<string, string>): Record<string, string> {
  const pool: Record<string, string> = {};
  for (const [alias, def] of Object.entries(MODEL_POOL_DEFAULTS)) {
    pool[alias] = (
      Deno.env.get(`OPENAI_MODEL_${alias.toUpperCase()}`) ||
      sec[`openai_model_${alias}`] ||
      def
    ).trim();
  }
  return pool;
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
async function callAI(opts: {
  apiKey: string; baseUrl: string; model: string; input: any[]; useFormat: boolean;
  instructions: string; temperature?: number;
}): Promise<{ ok: boolean; status: number; text: string; id: string | null; err: string }> {
  const body: Record<string, unknown> = { model: opts.model, instructions: opts.instructions, input: opts.input, store: true, stream: true };
  if (typeof opts.temperature === "number") body.temperature = opts.temperature;
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
  const { dailyLimit, maxTurns, useFormat, apiKey, baseUrl, modelPool } = await loadRuntime(admin);

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

  const toneKey = (typeof payload.tone === "string" && TONES[payload.tone]) ? payload.tone : "rational";
  const tone = TONES[toneKey];
  const model = modelPool[tone.model] ?? modelPool["sonnet"];
  const instructions = buildInstructions(tone);
  let textBlock = `【本轮回复语气】${tone.label}：${tone.guide}\n\n`;
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

  let rawText = "", respId: string | null = null, useFormatTry = useFormat, temperatureTry = tone.temperature;
  for (let attempt = 1; attempt <= MAX_AI_ATTEMPTS; attempt++) {
    let r: { ok: boolean; status: number; text: string; id: string | null; err: string };
    try {
      r = await callAI({ apiKey, baseUrl, model, input, useFormat: useFormatTry, instructions, temperature: temperatureTry });
    } catch (_e) {
      await refund();
      return json({ error: "AI 服务连接超时，请稍后再试" }, 504);
    }
    if (r.ok && r.text) { rawText = r.text; respId = r.id; break; }
    if (r.ok && !r.text) continue;
    if ((r.status === 400 || r.status === 404) && useFormatTry) { useFormatTry = false; continue; }
    if (r.status === 400 && typeof temperatureTry === "number") { temperatureTry = undefined; continue; }
    console.error("AI provider error:", r.status, "model=", model, r.err.slice(0, 500));
    await refund();
    const hint = r.status === 401 ? "（密钥被拒绝，请核对 OPENAI_API_KEY）" : "";
    // detail：透出上游（PackyCode）返回的原始错误体，便于定位是“模型不存在/端点不支持/过载”等
    return json({ error: `AI 服务返回异常 (${r.status})${hint}`, code: "provider_error", provider_status: r.status, model, detail: (r.err || "").slice(0, 500) }, 502);
  }
  if (!rawText) { await refund(); return json({ error: "AI 暂时未返回内容，请重试一次", code: "empty", model }, 502); }

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
