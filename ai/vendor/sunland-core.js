var K = Object.defineProperty;
var B = (e, t, n) => t in e ? K(e, t, { enumerable: !0, configurable: !0, writable: !0, value: n }) : e[t] = n;
var g = (e, t, n) => B(e, typeof t != "symbol" ? t + "" : t, n);
const i = {
  /** Inheritance / subclass-of, e.g. 猫 属于 哺乳动物 */
  IsA: "属于",
  /** Identity / instance-of, e.g. 苏格拉底 是 人 */
  Is: "是",
  /** Capability, e.g. 鸟 会 飞 */
  Can: "会",
  /** Preference, e.g. 猫 喜欢 鱼 */
  Likes: "喜欢",
  /** Spatial location, e.g. 猫 在 屋顶 */
  LocatedIn: "在"
}, S = {
  Name: "name"
};
let _ = 0;
function F() {
  return _ += 1, `k_${Date.now().toString(36)}_${_.toString(36)}`;
}
const W = 1, G = "user";
function p(e) {
  return `${e.subject} ${e.relation} ${e.object} ${e.negated}`;
}
function w(e, t, n) {
  const r = e.get(t);
  r === void 0 ? e.set(t, /* @__PURE__ */ new Set([n])) : r.add(n);
}
function A(e, t, n) {
  const r = e.get(t);
  r !== void 0 && (r.delete(n), r.size === 0 && e.delete(t));
}
function Y(e) {
  const t = [...e].sort((c, o) => c.size - o.size), [n, ...r] = t;
  if (n === void 0) return /* @__PURE__ */ new Set();
  let s = n;
  for (const c of r) {
    const o = /* @__PURE__ */ new Set();
    for (const a of s)
      c.has(a) && o.add(a);
    if (s = o, s.size === 0) break;
  }
  return s;
}
function J(e, t) {
  return !(t.subject !== void 0 && e.subject !== t.subject || t.relation !== void 0 && e.relation !== t.relation || t.object !== void 0 && e.object !== t.object || t.negated !== void 0 && e.negated !== t.negated);
}
function H(e) {
  if (Number.isNaN(e) || e < 0 || e > 1)
    throw new RangeError(`confidence must be within [0, 1], got ${e}`);
}
class M {
  constructor() {
    g(this, "records", /* @__PURE__ */ new Map());
    g(this, "bySubject", /* @__PURE__ */ new Map());
    g(this, "byRelation", /* @__PURE__ */ new Map());
    g(this, "byObject", /* @__PURE__ */ new Map());
    g(this, "idByTripleKey", /* @__PURE__ */ new Map());
  }
  all() {
    return Array.from(this.records.values());
  }
  has(t) {
    return this.idByTripleKey.has(p(t));
  }
  match(t) {
    const n = [];
    t.subject !== void 0 && n.push(this.bySubject.get(t.subject) ?? /* @__PURE__ */ new Set()), t.relation !== void 0 && n.push(this.byRelation.get(t.relation) ?? /* @__PURE__ */ new Set()), t.object !== void 0 && n.push(this.byObject.get(t.object) ?? /* @__PURE__ */ new Set());
    const r = n.length > 0 ? Y(n) : this.records.keys(), s = [];
    for (const c of r) {
      const o = this.records.get(c);
      o !== void 0 && J(o, t) && s.push(o);
    }
    return s;
  }
  add(t, n) {
    const r = this.idByTripleKey.get(p(t));
    if (r !== void 0) {
      const o = this.records.get(r);
      if (o !== void 0) return o;
    }
    const s = (n == null ? void 0 : n.confidence) ?? W;
    H(s);
    const c = {
      subject: t.subject,
      relation: t.relation,
      object: t.object,
      negated: t.negated,
      id: F(),
      confidence: s,
      source: (n == null ? void 0 : n.source) ?? G,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    return this.insertRecord(c), c;
  }
  addMany(t) {
    for (const n of t)
      this.records.has(n.id) || this.insertRecord(n);
  }
  remove(t) {
    const n = this.records.get(t);
    n !== void 0 && (this.records.delete(t), this.idByTripleKey.delete(p(n)), A(this.bySubject, n.subject, t), A(this.byRelation, n.relation, t), A(this.byObject, n.object, t));
  }
  clear() {
    this.records.clear(), this.bySubject.clear(), this.byRelation.clear(), this.byObject.clear(), this.idByTripleKey.clear();
  }
  insertRecord(t) {
    this.records.set(t.id, t), this.idByTripleKey.set(p(t), t.id), w(this.bySubject, t.subject, t.id), w(this.byRelation, t.relation, t.id), w(this.byObject, t.object, t.id);
  }
}
const q = [
  { subject: "猫", relation: i.IsA, object: "哺乳动物", negated: !1 },
  { subject: "哺乳动物", relation: i.IsA, object: "动物", negated: !1 },
  { subject: "苏格拉底", relation: i.Is, object: "人", negated: !1 },
  { subject: "人", relation: i.IsA, object: "动物", negated: !1 },
  { subject: "鸟", relation: i.Can, object: "飞", negated: !1 },
  { subject: "企鹅", relation: i.IsA, object: "鸟", negated: !1 },
  { subject: "企鹅", relation: i.Can, object: "飞", negated: !0 },
  { subject: "猫", relation: i.Likes, object: "鱼", negated: !1 },
  { subject: "猫", relation: i.LocatedIn, object: "屋顶", negated: !1 }
];
function z(e) {
  for (const t of q)
    e.add(t, { source: "seed" });
}
function V(e, t, n) {
  t.setItem(n, JSON.stringify(e.all()));
}
function x(e, t, n) {
  const r = t.getItem(n);
  if (r === null) return;
  let s;
  try {
    s = JSON.parse(r);
  } catch {
    return;
  }
  Array.isArray(s) && e.addMany(s);
}
const m = "Sunland AI", Q = "霜蓝", k = "开发者", X = [
  {
    subject: m,
    relation: i.Is,
    object: "一个基于符号推理与知识图谱的AI系统：不依赖大语言模型，而是用显式的知识（事实）和推理规则来理解、学习与回答问题",
    negated: !1
  },
  {
    subject: Q,
    relation: i.Is,
    object: "Sunland AI 目前的默认人格，说话自然温和、带一点点俏皮，仅负责语气，不改变任何事实或推理结论",
    negated: !1
  },
  {
    subject: m,
    relation: i.Can,
    object: "记住你教给它的知识（比如「猫属于哺乳动物」），并在之后的对话里用上",
    negated: !1
  },
  {
    subject: m,
    relation: i.Can,
    object: "基于已知事实做推理、回答问题，并且能解释自己是怎么得出这个答案的",
    negated: !1
  },
  {
    subject: m,
    relation: k,
    object: "由一名独立开发者持续设计与打磨，目前仍在成长中",
    negated: !1
  }
];
function Z() {
  const e = new M();
  for (const t of X)
    e.add(t, { source: "seed" });
  return e;
}
function ee() {
  return new M();
}
let O = 0;
function te() {
  return O += 1, `mem_${Date.now().toString(36)}_${O.toString(36)}`;
}
class ne {
  constructor() {
    g(this, "records", /* @__PURE__ */ new Map());
  }
  remember(t, n) {
    const r = (/* @__PURE__ */ new Date()).toISOString(), s = this.records.get(t), c = s ? { ...s, value: n, updatedAt: r } : { id: te(), key: t, value: n, createdAt: r, updatedAt: r };
    return this.records.set(t, c), c;
  }
  recall(t) {
    return this.records.get(t) ?? null;
  }
  forget(t) {
    this.records.delete(t);
  }
  list() {
    return Array.from(this.records.values());
  }
  search(t) {
    const n = t.toLowerCase();
    return this.list().filter(
      (r) => r.key.toLowerCase().includes(n) || r.value.toLowerCase().includes(n)
    );
  }
  restore(t) {
    for (const n of t)
      this.records.has(n.key) || this.records.set(n.key, n);
  }
}
function re(e, t, n) {
  t.setItem(n, JSON.stringify(e.list()));
}
function se(e, t, n) {
  const r = t.getItem(n);
  if (r === null) return;
  let s;
  try {
    s = JSON.parse(r);
  } catch {
    return;
  }
  Array.isArray(s) && e.restore(s);
}
function ce() {
  return new ne();
}
const oe = /\s+/gu, ae = /[呀啊呢哦啦~～]+$/u;
function T(e) {
  return e.replace(oe, "").replace(ae, "").toLowerCase();
}
function $(e, t, n = 0.95) {
  const r = new Set(t.map(T));
  return {
    intent: e,
    match(s) {
      return r.has(T(s)) ? { entities: [], confidence: n } : null;
    }
  };
}
const ie = [
  "你好",
  "您好",
  "哈喽",
  "哈啰",
  "嗨",
  "hi",
  "hello",
  "hey"
];
function ue() {
  return $("Greeting", ie);
}
const le = [
  "谢谢",
  "谢了",
  "感谢",
  "多谢",
  "thanks",
  "thank you",
  "thx"
];
function de() {
  return $("Thanks", le);
}
const fe = [
  "再见",
  "拜拜",
  "88",
  "bye",
  "goodbye",
  "see you"
];
function be() {
  return $("Farewell", fe);
}
const L = "Sunland AI", he = "霜蓝";
function ge(e) {
  return e.includes("霜蓝") || e.includes("frost") ? he : e.includes("sunland") || e.includes("你") ? L : null;
}
const Ee = ["谁开发", "谁做的", "谁创造", "谁写的", "开发者"], je = ["能做什么", "会做什么", "能干什么", "能做啥", "会做啥", "能干嘛", "有什么能力", "擅长什么"], me = ["是谁", "叫什么", "是什么", "你的名字", "名字是"];
function Se(e) {
  return Ee.some((t) => e.includes(t)) ? "creator" : je.some((t) => e.includes(t)) ? "capability" : me.some((t) => e.includes(t)) ? "identity" : null;
}
function ye() {
  return {
    intent: "Identity",
    match(e) {
      const t = e.toLowerCase(), n = ge(t), r = Se(t);
      return n === null || r === null ? null : { entities: [n, r], confidence: 0.9 };
    }
  };
}
const pe = [
  "我叫什么",
  "我叫什么名字",
  "你知道我的名字吗",
  "你记得我的名字吗"
];
function Re() {
  return $("RecallName", pe);
}
const $e = [/^我叫(.+)$/u, /^我的名字是(.+)$/u, /^叫我(.+)$/u], Ne = /* @__PURE__ */ new Set(["什么", "什么名字", "谁"]);
function we() {
  return {
    intent: "RememberName",
    match(e) {
      for (const t of $e) {
        const n = t.exec(e);
        if (!n) continue;
        const [, r] = n;
        return !r || Ne.has(r) ? null : { entities: [r], confidence: 0.95 };
      }
      return null;
    }
  };
}
const Ae = [
  ue(),
  de(),
  be(),
  ye(),
  Re(),
  we()
], Ie = /\s+/gu, _e = /[?？!！。.,，;；]+$/u;
function Oe(e) {
  return e.replace(Ie, "").replace(_e, "");
}
function N(e) {
  return e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function Te(e) {
  const t = N(e), n = new RegExp(`^(.+?)(不)?${t}(.+)$`, "u");
  return {
    name: `statement:${e}`,
    match(r) {
      const s = n.exec(r);
      if (!s) return null;
      const [, c, o, a] = s;
      return !c || !a ? null : {
        type: "statement",
        subject: c,
        relation: e,
        object: a,
        negated: o === "不",
        raw: r
      };
    }
  };
}
function Le(e) {
  const t = N(e), n = new RegExp(`^(.+?)${t}什么$`, "u");
  return {
    name: `query:object-of:${e}`,
    match(r) {
      const s = n.exec(r);
      if (!s) return null;
      const [, c] = s;
      return c ? {
        type: "query",
        subject: c,
        relation: e,
        kind: "object-of",
        raw: r
      } : null;
    }
  };
}
function Ce(e) {
  return `${e.charAt(0)}不${e}`;
}
function Me(e) {
  const t = Ce(e), n = N(t), r = new RegExp(`^(.+?)${n}(.+)$`, "u");
  return {
    name: `query:verify:${e}`,
    match(s) {
      const c = r.exec(s);
      if (!c) return null;
      const [, o, a] = c;
      return !o || !a ? null : {
        type: "query",
        subject: o,
        relation: e,
        object: a,
        kind: "verify",
        raw: s
      };
    }
  };
}
const ke = /^(.+?)在哪里$/u;
function ve() {
  return {
    name: "query:locate",
    match(e) {
      const t = ke.exec(e);
      if (!t) return null;
      const [, n] = t;
      return n ? {
        type: "query",
        subject: n,
        relation: i.LocatedIn,
        kind: "locate",
        raw: e
      } : null;
    }
  };
}
function Pe(e) {
  const t = N(e), n = new RegExp(`^(.+?)为什么${t}(.+)$`, "u");
  return {
    name: `query:why:${e}`,
    match(r) {
      const s = n.exec(r);
      if (!s) return null;
      const [, c, o] = s;
      return !c || !o ? null : {
        type: "query",
        subject: c,
        relation: e,
        object: o,
        kind: "verify",
        explain: !0,
        raw: r
      };
    }
  };
}
const R = [
  i.IsA,
  i.Is,
  i.Can,
  i.Likes,
  i.LocatedIn
], De = [
  ve(),
  ...R.map(Pe),
  ...R.map(Me),
  ...R.map(Le),
  ...R.map(Te)
];
class Ue {
  constructor(t = De, n = Ae) {
    g(this, "patterns");
    g(this, "intentMatchers");
    this.patterns = t, this.intentMatchers = n;
  }
  parse(t) {
    const n = Oe(t);
    if (!n)
      return { type: "unknown", raw: t, reason: "输入为空" };
    for (const r of this.intentMatchers) {
      const s = r.match(n);
      if (s)
        return {
          type: "intent",
          intent: r.intent,
          entities: s.entities ?? [],
          confidence: s.confidence,
          raw: t
        };
    }
    for (const r of this.patterns) {
      const s = r.match(n);
      if (s)
        return { ...s, raw: t };
    }
    return {
      type: "unknown",
      raw: t,
      reason: `没有匹配的语法规则："${n}"`
    };
  }
}
function Ke() {
  return new Ue();
}
function E(...e) {
  return e.filter((t) => !!(t && t.length > 0)).join(" ");
}
function Be(e) {
  let t = 0;
  for (let n = 0; n < e.length; n += 1)
    t = t * 31 + e.charCodeAt(n) | 0;
  return Math.abs(t);
}
function u(e, t) {
  if (e.length === 0)
    throw new Error("pickBySeed: `items` must not be empty");
  const n = Be(t) % e.length;
  return e[n];
}
const Fe = ["✨", "🌸", "🐾", "💙"], We = [
  "让我查一下知识图谱。",
  "嗯，这个我知道。",
  "好，我来说说。",
  "这个问题我有答案。"
], Ge = [
  "如果还有其他想问的，随时说。",
  "还想了解更多的话，尽管问我。",
  "这就是我推理出来的结论。",
  "如果这跟你在琢磨兽设或者创作有关，我也挺好奇后续的。"
  // furry nod
], Ye = [
  "唔，这个我目前还没有相关的知识。",
  "抱歉，我暂时还不知道这个。",
  "这个我还没学过。"
], Je = [
  "如果你知道答案，可以教教我，我会把它记下来。",
  "要是愿意告诉我，我会记住的，下次就能直接回答。",
  "随时欢迎补充知识给我，多多益善。"
], He = [
  "不过这个我不是很有把握，仅供参考～",
  "这个我没有十足的信心，你可以再和我确认一下～",
  "这只是我的推测，不一定完全准确～"
], qe = [
  "好，我记下来了：",
  "明白了，这条知识我存起来了：",
  "收到，这条我记住了："
], ze = [
  "以后可以直接问我这个。",
  "下次遇到相关问题，我就能用上它了。",
  "谢谢你教我新知识。"
], Ve = [
  "抱歉，我还没太理解这句话。",
  "唔，这个说法我暂时解析不出来。"
], xe = [
  "可以试试类似「猫属于哺乳动物」「猫属于什么」这样的说法。",
  "换一种更直接的表达方式，我应该就能理解了。"
], Qe = [
  "你好呀～有什么想聊的，或者想教我点新知识吗？",
  "嗨，我在这里，想问点什么都可以。",
  "欢迎回来～需要我帮忙推理点什么吗？",
  "嗨，无论是新知识还是兽设点子，我都很乐意听听。"
  // furry nod
], Xe = [
  "不客气～能帮上忙我也很开心。",
  "不用谢，这是我应该做的。",
  "嘿嘿，随时欢迎再来问我。",
  "能帮到你就好，有别的问题也尽管说。"
], Ze = [
  "拜拜～下次再聊！",
  "再见，期待下次和你聊天。",
  "先这样啦，有需要随时回来找我。",
  "路上小心～我在这里等你回来。"
], et = [
  "关于我是谁，",
  "让我介绍一下自己：",
  "问得好，"
], tt = [
  "如果还想了解更多，随时问我。",
  "有什么想知道的都可以接着问～"
], nt = [
  "我目前能做的事情大概有这些：",
  "说说看我能帮上什么忙："
], rt = [
  "随着你教给我更多知识，我会越来越强。",
  "以后应该还会有更多能力，敬请期待～"
], st = [
  "说到这个呀，",
  "关于这个问题，"
], ct = [
  "希望我能越来越好用。",
  "也谢谢你愿意花时间和我聊天～"
], ot = [
  "好呀，",
  "记住啦，",
  "收到～"
], at = [
  "以后见面我都会记得你。",
  "很高兴认识你！",
  "下次再聊我就认得你啦。"
], it = [
  "你叫",
  "我记得，你是",
  "当然记得呀，你是"
], ut = [
  "，对吧？",
  "呀！",
  "，很高兴又和你聊天。"
], lt = [
  "目前你还没有告诉我你的名字。",
  "我还不知道你的名字诶，要不要告诉我？"
], dt = [
  "好，我记住了：",
  "收到，这个我记下了："
], ft = [
  "以后我都会记得。",
  "谢谢你告诉我～"
], bt = [
  "这个你还没有告诉过我。",
  "唔，这个我暂时还不知道。"
];
function d(e, t) {
  const n = u(Fe, t);
  return `${e} ${n}`;
}
function ht(e, t) {
  const n = `${e.query.subject}:${e.query.relation}:${e.query.kind}`, r = t.mode !== "no-answer", s = u(
    r ? We : Ye,
    n
  ), c = u(
    r ? Ge : Je,
    `${n}:closer`
  ), o = t.isUncertain ? u(He, `${n}:hedge`) : void 0;
  return d(E(s, t.explanation, o, c), n);
}
function gt(e) {
  const t = `${e.subject}:${e.relation}:${e.object}`, n = u(qe, t), r = u(ze, `${t}:closer`), s = e.negated ? "不" : "", c = `${e.subject} ${s}${e.relation} ${e.object}`;
  return d(E(n, c, r), t);
}
function Et(e) {
  const t = e.raw, n = u(Ve, t), r = u(xe, `${t}:closer`);
  return d(E(n, `（${e.reason}）`, r), t);
}
function jt(e) {
  const t = e && e.length > 0 ? e : "greeting", n = u(Qe, t);
  return d(n, t);
}
function mt(e) {
  const t = e && e.length > 0 ? e : "thanks", n = u(Xe, t);
  return d(n, t);
}
function St(e) {
  const t = e && e.length > 0 ? e : "farewell", n = u(Ze, t);
  return d(n, t);
}
function yt(e, t, n, r) {
  const s = r && r.length > 0 ? r : `identity:${t}:${e}`;
  if (e === "capability") {
    const h = u(nt, s), j = u(rt, `${s}:closer`), l = n.length > 0 ? n.map((f) => `· ${f.object}`).join(`
`) : `关于「${t}」能做什么，我目前还没有明确的答案。`;
    return d(E(h, l, j), s);
  }
  if (e === "creator") {
    const h = u(st, s), j = u(ct, `${s}:closer`), [l] = n, f = l ? l.object : "这个我暂时还不清楚。";
    return d(E(h, f, j), s);
  }
  const c = u(et, s), o = u(tt, `${s}:closer`), [a] = n, b = a ? `${a.subject} ${a.negated ? "不" : ""}${a.relation} ${a.object}` : `关于「${t}」，我目前还没有明确的答案。`;
  return d(E(c, b, o), s);
}
function pt(e, t, n) {
  const r = n && n.length > 0 ? n : `remembered:${e}`;
  if (e === S.Name) {
    const o = u(ot, r), a = u(at, `${r}:closer`);
    return d(E(o, `你叫 ${t}`, a), r);
  }
  const s = u(dt, r), c = u(ft, `${r}:closer`);
  return d(E(s, t, c), r);
}
function Rt(e, t, n) {
  const r = n && n.length > 0 ? n : `recalled:${e}`;
  if (e === S.Name) {
    if (t === null)
      return d(u(lt, r), r);
    const s = u(it, r), c = u(ut, `${r}:closer`);
    return d(E(s, t, c), r);
  }
  return d(t === null ? u(bt, r) : t, r);
}
function $t(e) {
  return `抱歉，出了点问题：${e}`;
}
const I = {
  id: "frost",
  displayName: "霜蓝 Frost",
  description: "温柔友善、带一点活力的兽圈朋友型人格。默认人格。仅影响语言风格与语气，不改变任何推理结论、置信度或知识内容。",
  respond(e) {
    switch (e.kind) {
      case "reasoning-result":
        return ht(e.result, e.plan);
      case "learned":
        return gt(e.record);
      case "unknown-input":
        return Et(e.failure);
      case "greeting":
        return jt(e.raw);
      case "thanks":
        return mt(e.raw);
      case "farewell":
        return St(e.raw);
      case "identity":
        return yt(e.aspect, e.subject, e.facts, e.raw);
      case "remembered":
        return pt(e.key, e.value, e.raw);
      case "recalled":
        return Rt(e.key, e.value, e.raw);
      case "error":
        return $t(e.message);
      default: {
        const t = e;
        throw new Error(`Frost: unhandled response context ${JSON.stringify(t)}`);
      }
    }
  }
}, C = {
  id: "plain",
  displayName: "Plain（无风格 / 调试用）",
  description: "不做任何语言风格修饰的基线人格，仅用于验证人格切换机制与调试输出。",
  respond(e) {
    switch (e.kind) {
      case "reasoning-result":
        return e.plan.isUncertain ? `${e.plan.explanation}（不确定）` : e.plan.explanation;
      case "learned": {
        const t = e.record.negated ? "不" : "";
        return `已记录：${e.record.subject} ${t}${e.record.relation} ${e.record.object}`;
      }
      case "unknown-input":
        return `无法解析："${e.failure.raw}"（${e.failure.reason}）`;
      case "greeting":
        return "你好。";
      case "thanks":
        return "不客气。";
      case "farewell":
        return "再见。";
      case "identity": {
        const [t] = e.facts;
        if (!t) return `未知：关于 ${e.subject}（${e.aspect}）`;
        const n = t.negated ? "不" : "";
        return `${t.subject} ${n}${t.relation} ${t.object}`;
      }
      case "remembered":
        return `已记住：${e.key} = ${e.value}`;
      case "recalled":
        return e.value === null ? `未知：${e.key}` : `${e.key} = ${e.value}`;
      case "error":
        return `错误：${e.message}`;
      default: {
        const t = e;
        throw new Error(`Plain: unhandled response context ${JSON.stringify(t)}`);
      }
    }
  }
}, Nt = I.id, y = /* @__PURE__ */ new Map();
function wt() {
  y.set(I.id, I), y.set(C.id, C);
}
wt();
function qt(e) {
  y.set(e.id, e);
}
function zt() {
  return Array.from(y.values());
}
function At(e = Nt) {
  const t = y.get(e);
  if (!t)
    throw new Error(`getPersonality: unknown personality id "${e}"`);
  return t;
}
const It = 0.75;
function v(e) {
  const { subject: t, relation: n, object: r, negated: s } = e.conclusion;
  return `${t} ${s ? "不" : ""}${n} ${r}`;
}
function _t(e) {
  const t = v(e);
  return e.steps.length === 0 ? t : `${t}（推理路径：${e.path.join(" → ")}）`;
}
function Ot(e) {
  return Math.min(...e.map((t) => t.confidence));
}
const Tt = {
  id: "default-v1",
  plan(e) {
    const { answers: t, query: n } = e;
    if (t.length === 0)
      return {
        mode: "no-answer",
        showEvidence: !1,
        isUncertain: !1,
        confidence: 0,
        explanation: e.explanation
      };
    const r = n.explain === !0, s = Ot(t);
    return {
      mode: r ? "explained" : "direct",
      showEvidence: r,
      isUncertain: s < It,
      confidence: s,
      explanation: (r ? t.map(_t) : t.map(v)).join("；")
    };
  }
}, P = "isa-transitivity";
function Lt(e) {
  const t = e.match({ relation: i.IsA, negated: !1 }), n = /* @__PURE__ */ new Map();
  for (const r of t) {
    const s = n.get(r.subject) ?? [];
    s.push(r), n.set(r.subject, s);
  }
  return n;
}
function Ct(e) {
  const t = [];
  let n = {
    subject: e[0].subject,
    relation: i.IsA,
    object: e[0].object,
    negated: !1
  };
  for (let r = 1; r < e.length; r += 1) {
    const s = e[r], c = {
      subject: n.subject,
      relation: i.IsA,
      object: s.object,
      negated: !1
    };
    t.push({
      ruleId: P,
      description: `${n.subject} 属于 ${n.object}，${s.subject} 属于 ${s.object} ⇒ ${c.subject} 属于 ${c.object}`,
      premises: [n, { subject: s.subject, relation: i.IsA, object: s.object, negated: !1 }],
      conclusion: c
    }), n = c;
  }
  return t;
}
function Mt(e) {
  const t = e[0].subject, n = e[e.length - 1].object, r = [t, ...e.map((c) => c.object)], s = e.reduce((c, o) => c * o.confidence, 1);
  return {
    conclusion: { subject: t, relation: i.IsA, object: n, negated: !1 },
    confidence: s,
    steps: Ct(e),
    path: r
  };
}
const D = {
  id: P,
  name: "isA transitivity",
  description: "若 A 属于 B 且 B 属于 C，则推出 A 属于 C（可多级传递）。",
  apply(e) {
    const t = Lt(e), n = [];
    for (const r of t.keys()) {
      const s = /* @__PURE__ */ new Set([r]), c = [{ node: r, path: [r], records: [] }];
      for (; c.length > 0; ) {
        const o = c.shift(), a = t.get(o.node) ?? [];
        for (const b of a) {
          if (s.has(b.object)) continue;
          s.add(b.object);
          const h = [...o.records, b];
          c.push({ node: b.object, path: [...o.path, b.object], records: h }), h.length >= 2 && n.push(Mt(h));
        }
      }
    }
    return n;
  }
}, kt = "graph-v1", vt = "目前还没有已知的相关事实。";
function Pt(e, t) {
  return t.match({
    subject: e.subject,
    relation: e.relation,
    ...e.object !== void 0 ? { object: e.object } : {}
  }).map((r) => ({
    conclusion: { subject: r.subject, relation: r.relation, object: r.object, negated: r.negated },
    confidence: r.confidence,
    steps: [],
    path: [r.subject, r.object]
  }));
}
function Dt(e, t) {
  return e.relation !== i.IsA ? [] : D.apply(t).filter(
    (n) => n.conclusion.subject === e.subject && (e.object === void 0 || n.conclusion.object === e.object)
  );
}
function Ut(e) {
  const { subject: t, relation: n, object: r, negated: s } = e.conclusion, c = s ? "不" : "";
  return e.steps.length === 0 ? `${t} ${c}${n} ${r}` : `${t} ${c}${n} ${r}（推理路径：${e.path.join(" → ")}）`;
}
const Kt = {
  id: kt,
  answer(e, t) {
    const n = Pt(e, t), r = new Set(n.map((a) => a.conclusion.object)), s = Dt(e, t).filter((a) => !r.has(a.conclusion.object)), c = [...n, ...s], o = c.length > 0 ? c.map(Ut).join("；") : vt;
    return { query: e, answers: c, conflicts: [], explanation: o };
  },
  materialize(e) {
    return D.apply(e);
  }
}, Bt = {
  identity: i.Is,
  capability: i.Can,
  creator: k
};
function Ft(e) {
  return e === "identity" || e === "capability" || e === "creator";
}
function Wt(e, t) {
  const [n = m, r] = e.entities, s = Ft(r) ? r : "identity", c = Bt[s], o = t.match({ subject: n, relation: c });
  return { kind: "identity", aspect: s, subject: n, facts: o, raw: e.raw };
}
function Gt(e, t) {
  const [n] = e.entities, r = t.remember(S.Name, n ?? "");
  return { kind: "remembered", key: r.key, value: r.value, raw: e.raw };
}
function Yt(e, t) {
  const n = t.recall(S.Name);
  return { kind: "recalled", key: S.Name, value: (n == null ? void 0 : n.value) ?? null, raw: e.raw };
}
function Jt(e, t, n) {
  switch (e.intent) {
    case "Greeting":
      return { kind: "greeting", raw: e.raw };
    case "Thanks":
      return { kind: "thanks", raw: e.raw };
    case "Farewell":
      return { kind: "farewell", raw: e.raw };
    case "Identity":
      return Wt(e, t);
    case "RememberName":
      return Gt(e, n);
    case "RecallName":
      return Yt(e, n);
    default: {
      const r = e.intent;
      throw new Error(`createSunlandEngine: unhandled intent "${String(r)}"`);
    }
  }
}
function Vt(e = {}) {
  const t = e.knowledgeStore ?? ee(), n = e.memory ?? ce(), r = At(e.personalityId), s = e.parser ?? Ke(), c = e.storage, o = Z(), a = c ? `${c.key}::memory` : void 0;
  c && x(t, c.adapter, c.key), a && c && se(n, c.adapter, a), e.seedDemoData === !0 && t.all().length === 0 && z(t);
  function b() {
    c && V(t, c.adapter, c.key);
  }
  function h() {
    c && a && re(n, c.adapter, a);
  }
  return {
    knowledgeStore: t,
    memory: n,
    respond(j) {
      const l = s.parse(j);
      switch (l.type) {
        case "statement": {
          const f = t.add(
            { subject: l.subject, relation: l.relation, object: l.object, negated: l.negated },
            { source: "user" }
          );
          return b(), r.respond({ kind: "learned", record: f });
        }
        case "query": {
          const f = Kt.answer(l, t), U = Tt.plan(f);
          return r.respond({ kind: "reasoning-result", result: f, plan: U });
        }
        case "intent": {
          const f = Jt(l, o, n);
          return l.intent === "RememberName" && h(), r.respond(f);
        }
        case "unknown":
          return r.respond({ kind: "unknown-input", failure: l });
        default: {
          const f = l;
          throw new Error(`createSunlandEngine: unhandled parse result ${JSON.stringify(f)}`);
        }
      }
    }
  };
}
function xt() {
  const e = /* @__PURE__ */ new Map();
  return {
    getItem(t) {
      return e.get(t) ?? null;
    },
    setItem(t, n) {
      e.set(t, n);
    },
    removeItem(t) {
      e.delete(t);
    }
  };
}
export {
  k as CREATOR_RELATION,
  Nt as DEFAULT_PERSONALITY_ID,
  fe as FAREWELL_PHRASES,
  Q as FROST_SUBJECT,
  I as FrostPersonality,
  ie as GREETING_PHRASES,
  M as InMemoryKnowledgeStore,
  C as PlainPersonality,
  pe as RECALL_NAME_PHRASES,
  Ue as RegexParser,
  m as SUNLAND_SUBJECT,
  le as THANKS_PHRASES,
  be as createFarewellIntentMatcher,
  ue as createGreetingIntentMatcher,
  ye as createIdentityIntentMatcher,
  $ as createKeywordIntentMatcher,
  ee as createKnowledgeStore,
  ve as createLocatePattern,
  xt as createMemoryStorageAdapter,
  Le as createObjectOfPattern,
  Ke as createParser,
  Re as createRecallNameIntentMatcher,
  we as createRememberNameIntentMatcher,
  Z as createSelfKnowledgeStore,
  Te as createStatementPattern,
  Vt as createSunlandEngine,
  de as createThanksIntentMatcher,
  Me as createVerifyPattern,
  Pe as createWhyPattern,
  Ae as defaultIntentMatchers,
  De as defaultPatterns,
  At as getPersonality,
  zt as listPersonalities,
  x as loadKnowledgeStore,
  Oe as normalizeInput,
  qt as registerPersonality,
  V as saveKnowledgeStore,
  z as seedKnowledgeStore,
  q as seedTriples,
  X as selfKnowledgeTriples
};
