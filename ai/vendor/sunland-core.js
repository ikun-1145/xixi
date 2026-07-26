var mn = Object.defineProperty;
var gn = (e, t, n) => t in e ? mn(e, t, { enumerable: !0, configurable: !0, writable: !0, value: n }) : e[t] = n;
var L = (e, t, n) => gn(e, typeof t != "symbol" ? t + "" : t, n);
const j = {
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
}, ne = {
  Name: "name"
};
let ft = 0;
function bn() {
  return ft += 1, `k_${Date.now().toString(36)}_${ft.toString(36)}`;
}
const hn = 1, pn = "user";
function fe(e) {
  return `${e.subject} ${e.relation} ${e.object} ${e.negated}`;
}
function Te(e, t, n) {
  const r = e.get(t);
  r === void 0 ? e.set(t, /* @__PURE__ */ new Set([n])) : r.add(n);
}
function ve(e, t, n) {
  const r = e.get(t);
  r !== void 0 && (r.delete(n), r.size === 0 && e.delete(t));
}
function jn(e) {
  const t = [...e].sort((c, s) => c.size - s.size), [n, ...r] = t;
  if (n === void 0) return /* @__PURE__ */ new Set();
  let i = n;
  for (const c of r) {
    const s = /* @__PURE__ */ new Set();
    for (const a of i)
      c.has(a) && s.add(a);
    if (i = s, i.size === 0) break;
  }
  return i;
}
function yn(e, t) {
  return !(t.subject !== void 0 && e.subject !== t.subject || t.relation !== void 0 && e.relation !== t.relation || t.object !== void 0 && e.object !== t.object || t.negated !== void 0 && e.negated !== t.negated);
}
function On(e) {
  if (Number.isNaN(e) || e < 0 || e > 1)
    throw new RangeError(`confidence must be within [0, 1], got ${e}`);
}
class It {
  constructor() {
    L(this, "records", /* @__PURE__ */ new Map());
    L(this, "bySubject", /* @__PURE__ */ new Map());
    L(this, "byRelation", /* @__PURE__ */ new Map());
    L(this, "byObject", /* @__PURE__ */ new Map());
    L(this, "idByTripleKey", /* @__PURE__ */ new Map());
  }
  all() {
    return Array.from(this.records.values());
  }
  has(t) {
    return this.idByTripleKey.has(fe(t));
  }
  match(t) {
    const n = [];
    t.subject !== void 0 && n.push(this.bySubject.get(t.subject) ?? /* @__PURE__ */ new Set()), t.relation !== void 0 && n.push(this.byRelation.get(t.relation) ?? /* @__PURE__ */ new Set()), t.object !== void 0 && n.push(this.byObject.get(t.object) ?? /* @__PURE__ */ new Set());
    const r = n.length > 0 ? jn(n) : this.records.keys(), i = [];
    for (const c of r) {
      const s = this.records.get(c);
      s !== void 0 && yn(s, t) && i.push(s);
    }
    return i;
  }
  add(t, n) {
    const r = this.idByTripleKey.get(fe(t));
    if (r !== void 0) {
      const s = this.records.get(r);
      if (s !== void 0) return s;
    }
    const i = (n == null ? void 0 : n.confidence) ?? hn;
    On(i);
    const c = {
      subject: t.subject,
      relation: t.relation,
      object: t.object,
      negated: t.negated,
      id: bn(),
      confidence: i,
      source: (n == null ? void 0 : n.source) ?? pn,
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
    n !== void 0 && (this.records.delete(t), this.idByTripleKey.delete(fe(n)), ve(this.bySubject, n.subject, t), ve(this.byRelation, n.relation, t), ve(this.byObject, n.object, t));
  }
  clear() {
    this.records.clear(), this.bySubject.clear(), this.byRelation.clear(), this.byObject.clear(), this.idByTripleKey.clear();
  }
  insertRecord(t) {
    this.records.set(t.id, t), this.idByTripleKey.set(fe(t), t.id), Te(this.bySubject, t.subject, t.id), Te(this.byRelation, t.relation, t.id), Te(this.byObject, t.object, t.id);
  }
}
const En = [
  { subject: "猫", relation: j.IsA, object: "哺乳动物", negated: !1 },
  { subject: "哺乳动物", relation: j.IsA, object: "动物", negated: !1 },
  { subject: "苏格拉底", relation: j.Is, object: "人", negated: !1 },
  { subject: "人", relation: j.IsA, object: "动物", negated: !1 },
  { subject: "鸟", relation: j.Can, object: "飞", negated: !1 },
  { subject: "企鹅", relation: j.IsA, object: "鸟", negated: !1 },
  { subject: "企鹅", relation: j.Can, object: "飞", negated: !0 },
  { subject: "猫", relation: j.Likes, object: "鱼", negated: !1 },
  { subject: "猫", relation: j.LocatedIn, object: "屋顶", negated: !1 }
];
function Sn(e) {
  for (const t of En)
    e.add(t, { source: "seed" });
}
function wn(e, t, n) {
  t.setItem(n, JSON.stringify(e.all()));
}
function Cn(e, t, n) {
  const r = t.getItem(n);
  if (r === null) return;
  let i;
  try {
    i = JSON.parse(r);
  } catch {
    return;
  }
  Array.isArray(i) && e.addMany(i);
}
const V = "Sunland AI · Beta", Rn = "霜蓝", Nt = "开发者", kn = [
  {
    subject: V,
    relation: j.Is,
    object: "一个基于符号推理与知识图谱的AI系统：不依赖大语言模型，而是用显式的知识（事实）和推理规则来理解、学习与回答问题",
    negated: !1
  },
  {
    subject: Rn,
    relation: j.Is,
    object: "Sunland AI · Beta 目前的默认人格，说话自然温和、带一点点俏皮，仅负责语气，不改变任何事实或推理结论",
    negated: !1
  },
  {
    subject: V,
    relation: j.Can,
    object: "记住你教给它的知识（比如「猫属于哺乳动物」），并在之后的对话里用上",
    negated: !1
  },
  {
    subject: V,
    relation: j.Can,
    object: "基于已知事实做推理、回答问题，并且能解释自己是怎么得出这个答案的",
    negated: !1
  },
  {
    subject: V,
    relation: Nt,
    object: "由一名独立开发者持续设计与打磨，目前仍在成长中",
    negated: !1
  }
];
function zn() {
  const e = new It();
  for (const t of kn)
    e.add(t, { source: "seed" });
  return e;
}
function In() {
  return new It();
}
let dt = 0;
function Nn() {
  return dt += 1, `mem_${Date.now().toString(36)}_${dt.toString(36)}`;
}
class Tn {
  constructor() {
    L(this, "records", /* @__PURE__ */ new Map());
  }
  remember(t, n) {
    const r = (/* @__PURE__ */ new Date()).toISOString(), i = this.records.get(t), c = i ? { ...i, value: n, updatedAt: r } : { id: Nn(), key: t, value: n, createdAt: r, updatedAt: r };
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
function vn(e, t, n) {
  t.setItem(n, JSON.stringify(e.list()));
}
function An(e, t, n) {
  const r = t.getItem(n);
  if (r === null) return;
  let i;
  try {
    i = JSON.parse(r);
  } catch {
    return;
  }
  Array.isArray(i) && e.restore(i);
}
function xn() {
  return new Tn();
}
const Ln = /\s+/gu, $n = /[呀啊呢哦啦~～]+$/u;
function mt(e) {
  return e.replace(Ln, "").replace($n, "").toLowerCase();
}
function ye(e, t, n = 0.95) {
  const r = new Set(t.map(mt));
  return {
    intent: e,
    match(i) {
      return r.has(mt(i)) ? { entities: [], confidence: n } : null;
    }
  };
}
const _n = [
  "你好",
  "您好",
  "哈喽",
  "哈啰",
  "嗨",
  "hi",
  "hello",
  "hey"
];
function Kn() {
  return ye("Greeting", _n);
}
const Mn = [
  "谢谢",
  "谢了",
  "感谢",
  "多谢",
  "thanks",
  "thank you",
  "thx"
];
function Pn() {
  return ye("Thanks", Mn);
}
const qn = [
  "再见",
  "拜拜",
  "88",
  "bye",
  "goodbye",
  "see you"
];
function Dn() {
  return ye("Farewell", qn);
}
const gt = "Sunland AI · Beta", Un = "霜蓝";
function Bn(e) {
  return e.includes("霜蓝") || e.includes("frost") ? Un : e.includes("sunland") || e.includes("你") ? gt : null;
}
const Fn = ["谁开发", "谁做的", "谁创造", "谁写的", "开发者"], Wn = ["能做什么", "会做什么", "能干什么", "能做啥", "会做啥", "能干嘛", "有什么能力", "擅长什么"], Vn = ["是谁", "叫什么", "是什么", "你的名字", "名字是"];
function Gn(e) {
  return Fn.some((t) => e.includes(t)) ? "creator" : Wn.some((t) => e.includes(t)) ? "capability" : Vn.some((t) => e.includes(t)) ? "identity" : null;
}
function Yn() {
  return {
    intent: "Identity",
    match(e) {
      const t = e.toLowerCase(), n = Bn(t), r = Gn(t);
      return n === null || r === null ? null : { entities: [n, r], confidence: 0.9 };
    }
  };
}
const Hn = [
  "我叫什么",
  "我叫什么名字",
  "你知道我的名字吗",
  "你记得我叫什么吗",
  "你记得我的名字吗",
  "你还记得我的名字吗",
  "还记得我是谁吗"
];
function Qn() {
  return ye("RecallName", Hn);
}
const Pe = Object.freeze({
  maxInputLength: 160,
  maxNameLength: 64,
  maxRelationMentions: 1
}), Jn = /[,，;；。.!！?？\r\n]/u, Xn = /[。.!！]+$/u, Zn = /[?？]|(?:是不是|会不会|有没有|能不能|属不属于|为什么|怎么|什么|啥|谁|哪里|哪儿|吗|呢)(?:[啊呀呢哦啦]?[。.!！]?)$/u, er = /(?:还是|或者|或是|然后|并且|而且|同时|接着|另外)/u, tr = /(?:不要|别|无需|不用|禁止)(?:再)?(?:记住|记|保存|学习|教)/u, nr = Object.freeze([
  "指的是",
  "意思是",
  "是一种",
  "属于",
  "喜欢",
  "拥有",
  "具备",
  "会",
  "有",
  "是",
  "在"
]);
function Tt(e) {
  return e.trim().replace(Xn, "").trim();
}
function rr(e) {
  return Jn.test(
    Tt(e)
  );
}
function ir(e) {
  return Zn.test(e.trim());
}
function vt(e) {
  return er.test(e);
}
function At(e) {
  return tr.test(e);
}
function xt(e) {
  let t = e, n = 0;
  for (const r of nr) {
    let i = t.indexOf(r);
    for (; i >= 0; )
      n += 1, t = t.slice(0, i) + " ".repeat(r.length) + t.slice(i + r.length), i = t.indexOf(r);
  }
  return n;
}
function Je(e) {
  const t = e.trim();
  return t.length === 0 || t.length > Pe.maxInputLength || rr(t) || ir(t) || vt(t) || At(t) || xt(t) > Pe.maxRelationMentions;
}
function qe(e) {
  return Tt(e).replace(/\s+/gu, " ").trim();
}
const cr = [
  /^我\s*叫\s*(.+)$/iu,
  /^我的名字\s*是\s*(.+)$/iu,
  /^你可以\s*叫我\s*(.+)$/iu,
  /^叫我\s*(.+)$/iu
], sr = /* @__PURE__ */ new Set(["什么", "什么名字", "谁"]), ar = /^(?:你好|您好|嗨|哈喽|hello|hi)[,，]\s*/iu, or = /[呀啊呢哦啦吧~～]+$/u, ur = /^[\p{P}\p{S}\s]+$/u;
function lr(e) {
  const t = e.trim().replace(ar, "");
  if (Je(t))
    return null;
  for (const n of cr) {
    const r = n.exec(t);
    if (!r) continue;
    const i = qe(r[1] ?? "").replace(or, "").trim();
    return i.length === 0 || i.length > Pe.maxNameLength || sr.has(i) || ur.test(i) || vt(i) || xt(i) > 0 ? null : i;
  }
  return null;
}
function fr() {
  return {
    intent: "RememberName",
    match(e, t) {
      const n = lr(t ?? e);
      return n === null ? null : { entities: [n], confidence: 0.95 };
    }
  };
}
const dr = [
  Kn(),
  Pn(),
  Dn(),
  Qn(),
  Yn(),
  fr()
], mr = /\s+/gu, gr = /[?？!！。.,，;；]+$/u;
function br(e) {
  return e.replace(mr, "").replace(gr, "");
}
function Oe(e) {
  return e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function hr(e) {
  return [...e].map((t) => Oe(t)).join("\\s*");
}
function De(e, t = [e]) {
  const n = [...t].sort((i, c) => c.length - i.length).map(hr).join("|"), r = new RegExp(
    `^\\s*(.+?)\\s*(不|没)?\\s*(?:${n})\\s*(.+?)\\s*[。.!！]*\\s*$`,
    "u"
  );
  return {
    name: `statement:${e}`,
    match(i, c) {
      const s = c ?? i;
      if (Je(s))
        return null;
      const a = r.exec(s);
      if (!a) return null;
      const [, o, d, l] = a;
      if (!o || !l) return null;
      const g = qe(o), b = qe(l);
      return !g || !b ? null : {
        type: "statement",
        subject: g,
        relation: e,
        object: b,
        negated: d === "不" || d === "没",
        raw: s
      };
    }
  };
}
function pr(e) {
  const t = Oe(e), n = new RegExp(`^(.+?)${t}什么$`, "u");
  return {
    name: `query:object-of:${e}`,
    match(r) {
      const i = n.exec(r);
      if (!i) return null;
      const [, c] = i;
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
function jr(e) {
  return `${e.charAt(0)}不${e}`;
}
function yr(e) {
  const t = jr(e), n = Oe(t), r = new RegExp(`^(.+?)${n}(.+)$`, "u");
  return {
    name: `query:verify:${e}`,
    match(i) {
      const c = r.exec(i);
      if (!c) return null;
      const [, s, a] = c;
      return !s || !a ? null : {
        type: "query",
        subject: s,
        relation: e,
        object: a,
        kind: "verify",
        raw: i
      };
    }
  };
}
const Or = /^(.+?)在哪里$/u;
function Er() {
  return {
    name: "query:locate",
    match(e) {
      const t = Or.exec(e);
      if (!t) return null;
      const [, n] = t;
      return n ? {
        type: "query",
        subject: n,
        relation: j.LocatedIn,
        kind: "locate",
        raw: e
      } : null;
    }
  };
}
function Sr(e) {
  const t = Oe(e), n = new RegExp(`^(.+?)为什么${t}(.+)$`, "u");
  return {
    name: `query:why:${e}`,
    match(r) {
      const i = n.exec(r);
      if (!i) return null;
      const [, c, s] = i;
      return !c || !s ? null : {
        type: "query",
        subject: c,
        relation: e,
        object: s,
        kind: "verify",
        explain: !0,
        raw: r
      };
    }
  };
}
const de = [
  j.IsA,
  j.Is,
  j.Can,
  j.Likes,
  j.LocatedIn
], wr = [
  De("意思是", ["指的是", "意思是"]),
  De("有")
], Cr = [
  Er(),
  ...de.map(Sr),
  ...de.map(yr),
  ...de.map(pr),
  ...wr,
  ...de.map(
    (e) => De(e)
  )
];
class Rr {
  constructor(t = Cr, n = dr) {
    L(this, "patterns");
    L(this, "intentMatchers");
    this.patterns = t, this.intentMatchers = n;
  }
  parse(t) {
    const n = br(t);
    if (!n)
      return { type: "unknown", raw: t, reason: "输入为空" };
    for (const r of this.intentMatchers) {
      const i = r.match(n, t);
      if (i)
        return {
          type: "intent",
          intent: r.intent,
          entities: i.entities ?? [],
          confidence: i.confidence,
          raw: t
        };
    }
    for (const r of this.patterns) {
      const i = r.match(n, t);
      if (i)
        return { ...i, raw: t };
    }
    return {
      type: "unknown",
      raw: t,
      reason: `没有匹配的语法规则："${n}"`
    };
  }
}
function Lt() {
  return new Rr();
}
function $(...e) {
  return e.filter((t) => !!(t && t.length > 0)).join(" ");
}
function kr(e) {
  let t = 0;
  for (let n = 0; n < e.length; n += 1)
    t = t * 31 + e.charCodeAt(n) | 0;
  return Math.abs(t);
}
function O(e, t) {
  if (e.length === 0)
    throw new Error("pickBySeed: `items` must not be empty");
  const n = kr(t) % e.length;
  return e[n];
}
const zr = ["✨", "🌸", "🐾", "💙"], Ir = [
  "让我查一下知识图谱。",
  "嗯，这个我知道。",
  "好，我来说说。",
  "这个问题我有答案。"
], Nr = [
  "如果还有其他想问的，随时说。",
  "还想了解更多的话，尽管问我。",
  "这就是我推理出来的结论。",
  "如果这跟你在琢磨兽设或者创作有关，我也挺好奇后续的。"
  // furry nod
], Tr = [
  "唔，这个我目前还没有相关的知识。",
  "抱歉，我暂时还不知道这个。",
  "这个我还没学过。"
], vr = [
  "如果你知道答案，可以教教我，我会把它记下来。",
  "要是愿意告诉我，我会记住的，下次就能直接回答。",
  "随时欢迎补充知识给我，多多益善。"
], Ar = [
  "不过这个我不是很有把握，仅供参考～",
  "这个我没有十足的信心，你可以再和我确认一下～",
  "这只是我的推测，不一定完全准确～"
], xr = [
  "好，我记下来了：",
  "明白了，这条知识我存起来了：",
  "收到，这条我记住了："
], Lr = [
  "以后可以直接问我这个。",
  "下次遇到相关问题，我就能用上它了。",
  "谢谢你教我新知识。"
], $r = [
  "这个问题我暂时还没理解清楚。",
  "唔，我暂时还没弄明白你想问什么。"
], _r = [
  "你可以换一种说法，或者再告诉我一点相关信息。",
  "可以再多说一点，或者换个方式告诉我。"
], Kr = [
  "你好呀～有什么想聊的，或者想教我点新知识吗？",
  "嗨，我在这里，想问点什么都可以。",
  "欢迎回来～需要我帮忙推理点什么吗？",
  "嗨，无论是新知识还是兽设点子，我都很乐意听听。"
  // furry nod
], Mr = [
  "不客气～能帮上忙我也很开心。",
  "不用谢，这是我应该做的。",
  "嘿嘿，随时欢迎再来问我。",
  "能帮到你就好，有别的问题也尽管说。"
], Pr = [
  "拜拜～下次再聊！",
  "再见，期待下次和你聊天。",
  "先这样啦，有需要随时回来找我。",
  "路上小心～我在这里等你回来。"
], qr = [
  "关于我是谁，",
  "让我介绍一下自己：",
  "问得好，"
], Dr = [
  "如果还想了解更多，随时问我。",
  "有什么想知道的都可以接着问～"
], Ur = [
  "我目前能做的事情大概有这些：",
  "说说看我能帮上什么忙："
], Br = [
  "随着你教给我更多知识，我会越来越强。",
  "以后应该还会有更多能力，敬请期待～"
], Fr = [
  "说到这个呀，",
  "关于这个问题，"
], Wr = [
  "希望我能越来越好用。",
  "也谢谢你愿意花时间和我聊天～"
], Vr = [
  "好呀，",
  "记住啦，",
  "收到～"
], Gr = [
  "以后见面我都会记得你。",
  "很高兴认识你！",
  "下次再聊我就认得你啦。"
], Yr = [
  "你叫",
  "我记得，你是",
  "当然记得呀，你是"
], Hr = [
  "，对吧？",
  "呀！",
  "，很高兴又和你聊天。"
], Qr = [
  "目前你还没有告诉我你的名字。",
  "我还不知道你的名字诶，要不要告诉我？"
], Jr = [
  "好，我记住了：",
  "收到，这个我记下了："
], Xr = [
  "以后我都会记得。",
  "谢谢你告诉我～"
], Zr = [
  "这个你还没有告诉过我。",
  "唔，这个我暂时还不知道。"
];
function y(e, t) {
  const n = O(zr, t);
  return `${e} ${n}`;
}
function ei(e, t) {
  const n = `${e.query.subject}:${e.query.relation}:${e.query.kind}`, r = t.mode !== "no-answer", i = O(
    r ? Ir : Tr,
    n
  ), c = O(
    r ? Nr : vr,
    `${n}:closer`
  ), s = t.isUncertain ? O(Ar, `${n}:hedge`) : void 0;
  return y($(i, t.explanation, s, c), n);
}
function ti(e) {
  const t = `${e.subject}:${e.relation}:${e.object}`, n = O(xr, t), r = O(Lr, `${t}:closer`), i = e.negated ? "不" : "", c = `${e.subject} ${i}${e.relation} ${e.object}`;
  return y($(n, c, r), t);
}
function ni(e) {
  const t = e.raw.trim();
  if (!t)
    return y("好像还没有输入内容呢，可以跟我说点什么。", "empty-input");
  const n = t, r = O($r, n), i = O(_r, `${n}:closer`);
  return y($(r, i), n);
}
function ri(e) {
  const t = e && e.length > 0 ? e : "greeting", n = O(Kr, t);
  return y(n, t);
}
function ii(e) {
  const t = e && e.length > 0 ? e : "thanks", n = O(Mr, t);
  return y(n, t);
}
function ci(e) {
  const t = e && e.length > 0 ? e : "farewell", n = O(Pr, t);
  return y(n, t);
}
function si(e) {
  var r;
  const t = new Set(e.candidateLabels), n = [
    e.clarificationKind,
    e.focus,
    e.relation ?? "",
    ...e.candidateLabels
  ].join(":");
  if (t.has("identity") && t.has("query"))
    return y(
      "这个问题里像是同时问了我的名字和能力，可以分开问我哦。",
      n
    );
  if (e.focus === "subject" && (((r = e.contextLabels) == null ? void 0 : r.length) ?? 0) >= 2) {
    const i = e.contextLabels ?? [], c = [
      i.slice(0, -1).join("、"),
      i.at(-1)
    ].join("还是");
    return y(
      `你指的是${c}呢？可以再告诉我一下哦。`,
      n
    );
  }
  return e.focus === "object" && e.relation === "会" ? y("你想问我会做什么呢？可以再具体一点点哦。", n) : e.focus === "object" ? y(
    "这里好像还缺少要说明的内容，可以再告诉我它是什么吗？",
    n
  ) : e.focus === "subject" ? y("你想问的是谁或什么呢？可以再告诉我一点点。", n) : e.focus === "relation" ? y("你想了解它哪一方面呢？可以再说具体一点点。", n) : e.focus === "name" ? y("你是在问名字，还是想告诉我你的名字呢？", n) : t.has("teaching") ? y(
    "这个知识好像还没说完整，可以再告诉我对象和它们的关系吗？",
    n
  ) : y(
    "我好像看到了不止一种意思，可以换一种更具体的说法吗？",
    n
  );
}
function ai(e, t, n, r) {
  const i = r && r.length > 0 ? r : `identity:${t}:${e}`;
  if (e === "capability") {
    const d = O(Ur, i), l = O(Br, `${i}:closer`), g = n.length > 0 ? n.map((b) => `· ${b.object}`).join(`
`) : `关于「${t}」能做什么，我目前还没有明确的答案。`;
    return y($(d, g, l), i);
  }
  if (e === "creator") {
    const d = O(Fr, i), l = O(Wr, `${i}:closer`), [g] = n, b = g ? g.object : "这个我暂时还不清楚。";
    return y($(d, b, l), i);
  }
  const c = O(qr, i), s = O(Dr, `${i}:closer`), [a] = n, o = a ? `${a.subject} ${a.negated ? "不" : ""}${a.relation} ${a.object}` : `关于「${t}」，我目前还没有明确的答案。`;
  return y($(c, o, s), i);
}
function oi(e, t, n) {
  const r = n && n.length > 0 ? n : `remembered:${e}`;
  if (e === ne.Name) {
    const s = O(Vr, r), a = O(Gr, `${r}:closer`);
    return y($(s, `你叫 ${t}`, a), r);
  }
  const i = O(Jr, r), c = O(Xr, `${r}:closer`);
  return y($(i, t, c), r);
}
function ui(e, t, n) {
  const r = n && n.length > 0 ? n : `recalled:${e}`;
  if (e === ne.Name) {
    if (t === null)
      return y(O(Qr, r), r);
    const i = O(Yr, r), c = O(Hr, `${r}:closer`);
    return y($(i, t, c), r);
  }
  return y(t === null ? O(Zr, r) : t, r);
}
function li(e) {
  return "抱歉，我现在遇到了一点问题，请稍后再试一次。";
}
const Ue = {
  id: "frost",
  displayName: "霜蓝 Frost",
  description: "温柔友善、带一点活力的兽圈朋友型人格。默认人格。仅影响语言风格与语气，不改变任何推理结论、置信度或知识内容。",
  respond(e) {
    switch (e.kind) {
      case "reasoning-result":
        return ei(e.result, e.plan);
      case "clarification":
        return si(e.plan);
      case "learned":
        return ti(e.record);
      case "unknown-input":
        return ni(e.failure);
      case "greeting":
        return ri(e.raw);
      case "thanks":
        return ii(e.raw);
      case "farewell":
        return ci(e.raw);
      case "identity":
        return ai(e.aspect, e.subject, e.facts, e.raw);
      case "remembered":
        return oi(e.key, e.value, e.raw);
      case "recalled":
        return ui(e.key, e.value, e.raw);
      case "error":
        return li(e.message);
      default: {
        const t = e;
        throw new Error(`Frost: unhandled response context ${JSON.stringify(t)}`);
      }
    }
  }
}, bt = {
  id: "plain",
  displayName: "Plain（无风格 / 调试用）",
  description: "不做任何语言风格修饰的基线人格，仅用于验证人格切换机制与调试输出。",
  respond(e) {
    var t;
    switch (e.kind) {
      case "reasoning-result":
        return e.plan.isUncertain ? `${e.plan.explanation}（不确定）` : e.plan.explanation;
      case "clarification":
        if (e.plan.focus === "subject" && (((t = e.plan.contextLabels) == null ? void 0 : t.length) ?? 0) >= 2) {
          const n = e.plan.contextLabels ?? [];
          return `你指的是${[
            n.slice(0, -1).join("、"),
            n.at(-1)
          ].join("还是")}？请再说明一下。`;
        }
        return e.plan.focus === "object" && e.plan.relation === "会" ? "你想问会做什么？请再具体一点。" : e.plan.focus === "object" ? "缺少要说明的内容，请补充完整。" : e.plan.focus === "subject" ? "缺少要询问的对象，请补充完整。" : e.plan.focus === "relation" ? "缺少要询问的方面，请补充完整。" : e.plan.focus === "name" ? "请说明你是在询问名字，还是提供名字。" : "这句话有多种可能的意思，请换一种更具体的说法。";
      case "learned": {
        const n = e.record.negated ? "不" : "";
        return `已记录：${e.record.subject} ${n}${e.record.relation} ${e.record.object}`;
      }
      case "unknown-input":
        return e.failure.raw.trim() ? "这个问题我暂时还没理解清楚。你可以换一种说法，或者再告诉我一点相关信息。" : "好像还没有输入内容呢，可以跟我说点什么。";
      case "greeting":
        return "你好。";
      case "thanks":
        return "不客气。";
      case "farewell":
        return "再见。";
      case "identity": {
        const [n] = e.facts;
        if (!n) return `未知：关于 ${e.subject}（${e.aspect}）`;
        const r = n.negated ? "不" : "";
        return `${n.subject} ${r}${n.relation} ${n.object}`;
      }
      case "remembered":
        return `已记住：${e.key} = ${e.value}`;
      case "recalled":
        return e.value === null ? `未知：${e.key}` : `${e.key} = ${e.value}`;
      case "error":
        return "暂时无法完成这次请求，请稍后再试。";
      default: {
        const n = e;
        throw new Error(`Plain: unhandled response context ${JSON.stringify(n)}`);
      }
    }
  }
}, fi = Ue.id, re = /* @__PURE__ */ new Map();
function di() {
  re.set(Ue.id, Ue), re.set(bt.id, bt);
}
di();
function ja(e) {
  re.set(e.id, e);
}
function ya() {
  return Array.from(re.values());
}
function mi(e = fi) {
  const t = re.get(e);
  if (!t)
    throw new Error(`getPersonality: unknown personality id "${e}"`);
  return t;
}
const gi = 0.75;
function $t(e) {
  const { subject: t, relation: n, object: r, negated: i } = e.conclusion;
  return `${t} ${i ? "不" : ""}${n} ${r}`;
}
function bi(e) {
  const t = $t(e);
  return e.steps.length === 0 ? t : `${t}（推理路径：${e.path.join(" → ")}）`;
}
function hi(e) {
  return Math.min(...e.map((t) => t.confidence));
}
const pi = Object.freeze([
  "subject",
  "relation",
  "object",
  "name",
  "intent"
]);
function ji(e) {
  for (const t of pi)
    if (e.missingSlots.includes(t)) return t;
  return e.clarificationKind === "uncertain-name" ? "name" : "intent";
}
const ht = {
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
    const r = n.explain === !0, i = hi(t);
    return {
      mode: r ? "explained" : "direct",
      showEvidence: r,
      isUncertain: i < gi,
      confidence: i,
      explanation: (r ? t.map(bi) : t.map($t)).join("；")
    };
  },
  planClarification(e) {
    return Object.freeze({
      clarificationKind: e.clarificationKind,
      focus: ji(e),
      candidateLabels: Object.freeze([...e.candidateLabels]),
      reasonCategory: e.reasonCategory,
      ...e.relation === void 0 ? {} : { relation: e.relation },
      ...e.contextLabels === void 0 ? {} : {
        contextLabels: Object.freeze([
          ...e.contextLabels
        ])
      }
    });
  }
}, _t = "isa-transitivity";
function yi(e) {
  const t = e.match({ relation: j.IsA, negated: !1 }), n = /* @__PURE__ */ new Map();
  for (const r of t) {
    const i = n.get(r.subject) ?? [];
    i.push(r), n.set(r.subject, i);
  }
  return n;
}
function Oi(e) {
  const t = [];
  let n = {
    subject: e[0].subject,
    relation: j.IsA,
    object: e[0].object,
    negated: !1
  };
  for (let r = 1; r < e.length; r += 1) {
    const i = e[r], c = {
      subject: n.subject,
      relation: j.IsA,
      object: i.object,
      negated: !1
    };
    t.push({
      ruleId: _t,
      description: `${n.subject} 属于 ${n.object}，${i.subject} 属于 ${i.object} ⇒ ${c.subject} 属于 ${c.object}`,
      premises: [n, { subject: i.subject, relation: j.IsA, object: i.object, negated: !1 }],
      conclusion: c
    }), n = c;
  }
  return t;
}
function Ei(e) {
  const t = e[0].subject, n = e[e.length - 1].object, r = [t, ...e.map((c) => c.object)], i = e.reduce((c, s) => c * s.confidence, 1);
  return {
    conclusion: { subject: t, relation: j.IsA, object: n, negated: !1 },
    confidence: i,
    steps: Oi(e),
    path: r
  };
}
const Kt = {
  id: _t,
  name: "isA transitivity",
  description: "若 A 属于 B 且 B 属于 C，则推出 A 属于 C（可多级传递）。",
  apply(e) {
    const t = yi(e), n = [];
    for (const r of t.keys()) {
      const i = /* @__PURE__ */ new Set([r]), c = [{ node: r, path: [r], records: [] }];
      for (; c.length > 0; ) {
        const s = c.shift(), a = t.get(s.node) ?? [];
        for (const o of a) {
          if (i.has(o.object)) continue;
          i.add(o.object);
          const d = [...s.records, o];
          c.push({ node: o.object, path: [...s.path, o.object], records: d }), d.length >= 2 && n.push(Ei(d));
        }
      }
    }
    return n;
  }
}, Si = "graph-v1", wi = "目前还没有已知的相关事实。";
function Ci(e, t) {
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
function Ri(e, t) {
  return e.relation !== j.IsA ? [] : Kt.apply(t).filter(
    (n) => n.conclusion.subject === e.subject && (e.object === void 0 || n.conclusion.object === e.object)
  );
}
function ki(e) {
  const { subject: t, relation: n, object: r, negated: i } = e.conclusion, c = i ? "不" : "";
  return e.steps.length === 0 ? `${t} ${c}${n} ${r}` : `${t} ${c}${n} ${r}（推理路径：${e.path.join(" → ")}）`;
}
const zi = {
  id: Si,
  answer(e, t) {
    const n = Ci(e, t), r = new Set(n.map((a) => a.conclusion.object)), i = Ri(e, t).filter((a) => !r.has(a.conclusion.object)), c = [...n, ...i], s = c.length > 0 ? c.map(ki).join("；") : wi;
    return { query: e, answers: c, conflicts: [], explanation: s };
  },
  materialize(e) {
    return Kt.apply(e);
  }
};
function Xe(e) {
  return e !== null && Number.isFinite(e) && e >= 0;
}
function Ae(e) {
  return Xe(e) ? e < 1 ? "under-1ms" : e < 5 ? "1-5ms" : e < 16 ? "5-16ms" : e < 50 ? "16-50ms" : "over-50ms" : "unavailable";
}
function Ii(e) {
  return !Xe(e) || !Number.isSafeInteger(e) ? "unavailable" : e === 0 ? "0" : e < 100 ? "1-99" : e < 1e3 ? "100-999" : e < 5e3 ? "1000-4999" : "5000-plus";
}
function Ni(e) {
  return !Xe(e) || !Number.isSafeInteger(e) ? "unavailable" : e === 0 ? "none" : e === 1 ? "direct" : e <= 5 ? "2-5" : e <= 20 ? "6-20" : e <= 50 ? "21-50" : "51-plus";
}
const Mt = "0.1.0", Pt = 1, qt = 1, Dt = 1, Ti = Object.freeze([
  "understood",
  "clarification",
  "no-understanding",
  "missing-knowledge",
  "relation-unsupported",
  "context-unresolved",
  "side-effect-blocked",
  "safe-fallback"
]), vi = Object.freeze([
  "complete-passive-understanding",
  "missing-subject",
  "missing-relation",
  "missing-object",
  "ambiguous-intent",
  "conflicting-candidates",
  "insufficient-evidence",
  "missing-knowledge",
  "unsupported-relation",
  "unresolved-context",
  "blocked-side-effect",
  "semantic-runtime",
  "reasoner-error",
  "unknown-safe-fallback",
  "unclassified"
]), Ai = Object.freeze([
  "属于",
  "是",
  "会",
  "喜欢",
  "在",
  "有",
  "意思是",
  "开发者",
  "none",
  "unknown"
]), xi = Object.freeze([
  "ambiguous-intent",
  "missing-subject",
  "missing-relation",
  "missing-object",
  "uncertain-name",
  "uncertain-teaching",
  "conflicting-candidates",
  "none"
]), Li = Object.freeze([
  "under-1ms",
  "1-5ms",
  "5-16ms",
  "16-50ms",
  "over-50ms",
  "unavailable"
]), $i = Object.freeze([
  "0",
  "1-99",
  "100-999",
  "1000-4999",
  "5000-plus",
  "unavailable"
]), _i = Object.freeze([
  "direct",
  "2-5",
  "6-20",
  "21-50",
  "51-plus",
  "none",
  "unavailable"
]), Ki = Object.freeze([
  "aligned",
  "possible-mismatch",
  "no-alternative-known",
  "unavailable"
]), Be = Object.freeze([
  "schemaVersion",
  "sunlandCoreVersion",
  "semanticSchemaVersion",
  "contextSchemaVersion",
  "resultCategory",
  "reasonCategory",
  "relationCategory",
  "semanticAdopted",
  "legacyFallback",
  "contextUsed",
  "clarificationKind",
  "pathLengthBucket",
  "knowledgeCountBucket",
  "totalDurationBucket",
  "semanticDurationBucket",
  "reasonerDurationBucket",
  "queriedRelation",
  "alternativeKnownRelation",
  "alignmentResult"
]), Ut = new Set(
  Ti
), Bt = new Set(
  vi
), G = new Set(
  Ai
), Ft = new Set(
  xi
), Mi = new Set(_i), Pi = new Set(
  $i
), xe = new Set(Li), Wt = new Set(
  Ki
);
function qi(e) {
  return typeof e == "object" && e !== null;
}
function z(e, t) {
  return typeof e == "string" && t.has(e);
}
function Di(e) {
  const t = Reflect.ownKeys(e);
  return t.length === Be.length && t.every(
    (n) => typeof n == "string" && Be.includes(n)
  );
}
function Ui(e) {
  return Be.every((t) => {
    const n = Object.getOwnPropertyDescriptor(e, t);
    return n !== void 0 && "value" in n && n.get === void 0 && n.set === void 0;
  });
}
function Bi(e) {
  return Object.freeze({
    schemaVersion: Dt,
    sunlandCoreVersion: Mt,
    semanticSchemaVersion: Pt,
    contextSchemaVersion: qt,
    resultCategory: Ut.has(e.resultCategory) ? e.resultCategory : "safe-fallback",
    reasonCategory: Bt.has(e.reasonCategory) ? e.reasonCategory : "unclassified",
    relationCategory: G.has(e.relationCategory) ? e.relationCategory : "unknown",
    semanticAdopted: e.semanticAdopted === !0,
    legacyFallback: e.legacyFallback === !0,
    contextUsed: e.contextUsed === !0,
    clarificationKind: Ft.has(
      e.clarificationKind
    ) ? e.clarificationKind : "none",
    pathLengthBucket: Ni(
      e.reasonerPathLength
    ),
    knowledgeCountBucket: Ii(
      e.knowledgeCount
    ),
    totalDurationBucket: Ae(e.totalDurationMs),
    semanticDurationBucket: Ae(
      e.semanticDurationMs
    ),
    reasonerDurationBucket: Ae(
      e.reasonerDurationMs
    ),
    queriedRelation: G.has(e.queriedRelation) ? e.queriedRelation : "unknown",
    alternativeKnownRelation: G.has(
      e.alternativeKnownRelation
    ) ? e.alternativeKnownRelation : "unknown",
    alignmentResult: Wt.has(e.alignmentResult) ? e.alignmentResult : "unavailable"
  });
}
function Fi(e) {
  try {
    return !qi(e) || !Di(e) || !Ui(e) ? !1 : e.schemaVersion === Dt && e.sunlandCoreVersion === Mt && e.semanticSchemaVersion === Pt && e.contextSchemaVersion === qt && z(e.resultCategory, Ut) && z(e.reasonCategory, Bt) && z(e.relationCategory, G) && typeof e.semanticAdopted == "boolean" && typeof e.legacyFallback == "boolean" && typeof e.contextUsed == "boolean" && z(e.clarificationKind, Ft) && z(e.pathLengthBucket, Mi) && z(
      e.knowledgeCountBucket,
      Pi
    ) && z(
      e.totalDurationBucket,
      xe
    ) && z(
      e.semanticDurationBucket,
      xe
    ) && z(
      e.reasonerDurationBucket,
      xe
    ) && z(e.queriedRelation, G) && z(
      e.alternativeKnownRelation,
      G
    ) && z(e.alignmentResult, Wt);
  } catch {
    return !1;
  }
}
function Wi(e) {
  return Fi(e) ? Object.freeze({
    schemaVersion: e.schemaVersion,
    sunlandCoreVersion: e.sunlandCoreVersion,
    semanticSchemaVersion: e.semanticSchemaVersion,
    contextSchemaVersion: e.contextSchemaVersion,
    resultCategory: e.resultCategory,
    reasonCategory: e.reasonCategory,
    relationCategory: e.relationCategory,
    semanticAdopted: e.semanticAdopted,
    legacyFallback: e.legacyFallback,
    contextUsed: e.contextUsed,
    clarificationKind: e.clarificationKind,
    pathLengthBucket: e.pathLengthBucket,
    knowledgeCountBucket: e.knowledgeCountBucket,
    totalDurationBucket: e.totalDurationBucket,
    semanticDurationBucket: e.semanticDurationBucket,
    reasonerDurationBucket: e.reasonerDurationBucket,
    queriedRelation: e.queriedRelation,
    alternativeKnownRelation: e.alternativeKnownRelation,
    alignmentResult: e.alignmentResult
  }) : null;
}
function Vi(e) {
  return typeof e == "number" && Number.isFinite(e) && e >= 0 && e <= 1;
}
function v(e) {
  if (!Vi(e))
    throw new RangeError("Confidence must be a finite number between 0 and 1.");
  return e;
}
function Gi(e) {
  return Object.freeze({
    ...e,
    aliases: Object.freeze([...e.aliases]),
    baseWeight: v(e.baseWeight),
    constraints: Object.freeze({
      ...e.constraints,
      allowedCandidateKinds: Object.freeze([
        ...e.constraints.allowedCandidateKinds
      ])
    })
  });
}
const Yi = Object.freeze(
  [
    {
      id: "greeting",
      canonical: "你好",
      aliases: ["你好", "您好", "嗨", "哈喽", "hello", "hi", "hey"],
      category: "conversation",
      baseWeight: 0.92,
      constraints: {
        matchMode: "whole-input",
        allowedCandidateKinds: ["intent"]
      },
      sideEffectSafe: !1
    },
    {
      id: "thanks",
      canonical: "谢谢",
      aliases: ["谢谢", "谢了", "感谢", "多谢", "thanks", "thank you", "thx"],
      category: "conversation",
      baseWeight: 0.92,
      constraints: {
        matchMode: "whole-input",
        allowedCandidateKinds: ["intent"]
      },
      sideEffectSafe: !1
    },
    {
      id: "goodbye",
      canonical: "再见",
      aliases: ["再见", "拜拜", "先走", "bye", "goodbye", "see you"],
      category: "conversation",
      baseWeight: 0.92,
      constraints: {
        matchMode: "whole-input",
        allowedCandidateKinds: ["intent"]
      },
      sideEffectSafe: !1
    },
    {
      id: "identity-name",
      canonical: "你叫什么",
      aliases: ["你叫什么", "你叫啥", "你的名字是什么"],
      category: "identity",
      baseWeight: 0.94,
      constraints: {
        matchMode: "whole-input",
        allowedCandidateKinds: ["query"]
      },
      sideEffectSafe: !1
    },
    {
      id: "identity-self",
      canonical: "你是谁",
      aliases: [
        "你是谁",
        "你是什么",
        "sunland ai是什么",
        "sunland ai 是什么"
      ],
      category: "identity",
      baseWeight: 0.94,
      constraints: {
        matchMode: "whole-input",
        allowedCandidateKinds: ["query"]
      },
      sideEffectSafe: !1
    },
    {
      id: "remember-name",
      canonical: "我叫",
      aliases: ["我叫", "我的名字是", "你可以叫我", "叫我"],
      category: "memory",
      baseWeight: 0.9,
      constraints: {
        matchMode: "prefix",
        allowedCandidateKinds: ["statement"],
        requiresFollowingEntity: !0
      },
      sideEffectSafe: !0
    },
    {
      id: "recall-name",
      canonical: "我叫什么",
      aliases: [
        "我叫什么",
        "我叫什么名字",
        "你记得我叫什么吗",
        "你记得我的名字吗",
        "你还记得我的名字吗",
        "还记得我是谁吗"
      ],
      category: "memory",
      baseWeight: 0.93,
      constraints: {
        matchMode: "whole-input",
        allowedCandidateKinds: ["query"]
      },
      sideEffectSafe: !1
    },
    {
      id: "teaching",
      canonical: "教你",
      aliases: ["教你", "告诉你一个知识", "记住这个事实"],
      category: "knowledge",
      baseWeight: 0.82,
      constraints: {
        matchMode: "prefix",
        allowedCandidateKinds: ["statement"],
        requiresFollowingEntity: !0
      },
      sideEffectSafe: !0
    },
    {
      id: "query-definition",
      canonical: "是什么",
      aliases: ["是什么", "是啥", "指什么", "什么意思"],
      category: "knowledge",
      baseWeight: 0.84,
      constraints: {
        matchMode: "infix",
        allowedCandidateKinds: ["query"]
      },
      sideEffectSafe: !1
    },
    {
      id: "is-a",
      canonical: "属于",
      aliases: ["属于", "是一种", "算是", "归类为", "是"],
      category: "relation",
      baseWeight: 0.86,
      constraints: {
        matchMode: "infix",
        allowedCandidateKinds: ["statement", "query"]
      },
      sideEffectSafe: !0
    },
    {
      id: "can",
      canonical: "会",
      aliases: ["会", "能", "能够"],
      category: "relation",
      baseWeight: 0.78,
      constraints: {
        matchMode: "infix",
        allowedCandidateKinds: ["statement", "query"]
      },
      sideEffectSafe: !0
    },
    {
      id: "has",
      canonical: "有",
      aliases: ["有", "拥有", "具备"],
      category: "relation",
      baseWeight: 0.8,
      constraints: {
        matchMode: "infix",
        allowedCandidateKinds: ["statement", "query"]
      },
      sideEffectSafe: !0
    },
    {
      id: "means",
      canonical: "意思是",
      aliases: ["意思是", "是什么意思", "表示", "指的是"],
      category: "relation",
      baseWeight: 0.84,
      constraints: {
        matchMode: "infix",
        allowedCandidateKinds: ["statement", "query"]
      },
      sideEffectSafe: !0
    }
  ].map(Gi)
), Hi = Object.freeze({
  "，": ",",
  "。": ".",
  "？": "?",
  "！": "!",
  "；": ";",
  "：": ":",
  "（": "(",
  "）": ")",
  "【": "[",
  "】": "]",
  "“": '"',
  "”": '"',
  "‘": "'",
  "’": "'",
  "～": "~"
}), Qi = /* @__PURE__ */ new Set(["嗯", "呃", "唔"]), Ji = /* @__PURE__ */ new Set(["呀", "啊", "呢", "哦", "啦"]), Xi = /[\s,.;:!?'"()[\]~]/u;
function P(e, t) {
  return Object.freeze({ start: e, end: t });
}
function Y(e) {
  return Object.freeze({
    ...e,
    rawRange: Object.freeze({ ...e.rawRange })
  });
}
function Zi(e) {
  const t = [];
  let n = 0;
  for (const r of e) {
    const i = n;
    n += r.length, t.push(
      Object.freeze({
        text: r,
        rawRange: P(i, n)
      })
    );
  }
  return t;
}
function ec(e, t) {
  const n = Zi(e), r = [];
  let i = 0;
  for (; i < n.length; ) {
    const c = n[i];
    if (/\s/u.test(c.text)) {
      const a = i;
      let o = i + 1;
      for (; o < n.length && /\s/u.test(n[o].text); )
        o += 1;
      const d = n.slice(a, o), l = P(
        d[0].rawRange.start,
        d[d.length - 1].rawRange.end
      ), g = e.slice(l.start, l.end);
      a === 0 || o === n.length ? t.push(
        Y({
          stage: "surface",
          kind: "whitespace-trimmed",
          rawRange: l,
          sourceText: g,
          targetText: ""
        })
      ) : (r.push(Object.freeze({ text: " ", rawRange: l })), g !== " " && t.push(
        Y({
          stage: "surface",
          kind: "whitespace-collapsed",
          rawRange: l,
          sourceText: g,
          targetText: " "
        })
      )), i = o;
      continue;
    }
    const s = Hi[c.text];
    s !== void 0 ? (r.push(
      Object.freeze({
        text: s,
        rawRange: c.rawRange
      })
    ), t.push(
      Y({
        stage: "surface",
        kind: "punctuation-normalized",
        rawRange: c.rawRange,
        sourceText: c.text,
        targetText: s
      })
    )) : r.push(c), i += 1;
  }
  return r;
}
function me(e) {
  return e !== void 0 && Xi.test(e.text);
}
function tc(e, t) {
  let n = 0, r = e.length;
  for (; n < r && Qi.has(e[n].text) && me(e[n + 1]); ) {
    const i = e[n];
    let c = n + 1;
    for (; c < r && me(e[c]); )
      c += 1;
    const s = e.slice(n, c), a = P(
      i.rawRange.start,
      s[s.length - 1].rawRange.end
    );
    t.push(
      Y({
        stage: "match-key",
        kind: "edge-filler-removed",
        rawRange: a,
        sourceText: s.map((o) => o.text).join(""),
        targetText: ""
      })
    ), n = c;
  }
  for (; r > n && Ji.has(e[r - 1].text) && me(e[r - 2]); ) {
    const i = e[r - 1];
    let c = r - 1;
    for (; c > n && me(e[c - 1]); )
      c -= 1;
    const s = e.slice(c, r), a = P(
      s[0].rawRange.start,
      i.rawRange.end
    );
    t.push(
      Y({
        stage: "match-key",
        kind: "edge-filler-removed",
        rawRange: a,
        sourceText: s.map((o) => o.text).join(""),
        targetText: ""
      })
    ), r = c;
  }
  return e.slice(n, r);
}
function nc(e, t) {
  const n = tc(
    e,
    t
  ), r = [];
  for (const i of n) {
    const c = i.text.toLocaleLowerCase("und");
    r.push(Object.freeze({ text: c, rawRange: i.rawRange })), c !== i.text && t.push(
      Y({
        stage: "match-key",
        kind: "case-folded",
        rawRange: i.rawRange,
        sourceText: i.text,
        targetText: c
      })
    );
  }
  return r;
}
function pt(e) {
  const t = [];
  let n = "";
  for (const r of e) {
    n += r.text;
    for (let i = 0; i < r.text.length; i += 1)
      t.push(r.rawRange);
  }
  return Object.freeze({
    text: n,
    mapping: Object.freeze(t)
  });
}
function rc(e) {
  const t = [], n = ec(e, t), r = nc(n, t), i = pt(n), c = pt(r);
  return Object.freeze({
    raw: e,
    surface: i.text,
    matchKey: c.text,
    surfaceToRaw: i.mapping,
    matchKeyToRaw: c.mapping,
    transformations: Object.freeze(t)
  });
}
function D(e, t, n, r) {
  const i = t === "surface" ? e.surface : e.matchKey, c = t === "surface" ? e.surfaceToRaw : e.matchKeyToRaw;
  if (!Number.isInteger(n) || !Number.isInteger(r) || n < 0 || r < n || r > i.length)
    throw new RangeError(
      `Normalized range must be within ${t} UTF-16 bounds.`
    );
  if (n === r) {
    if (n < c.length)
      return P(c[n].start, c[n].start);
    if (c.length > 0) {
      const o = c[c.length - 1];
      return P(o.end, o.end);
    }
    return P(0, 0);
  }
  let s = c[n].start, a = c[n].end;
  for (let o = n + 1; o < r; o += 1)
    s = Math.min(s, c[o].start), a = Math.max(a, c[o].end);
  return P(s, a);
}
const h = v, m = Object.freeze({
  producerWeight: Object.freeze({
    "legacy-regex": h(0.9),
    lexicon: h(0.8),
    "relation-pattern": h(0.72),
    context: h(0.64)
  }),
  legacy: Object.freeze({
    unknown: h(0.08),
    statement: h(0.91),
    query: h(0.92),
    intentFloor: h(0.88)
  }),
  lexicon: Object.freeze({
    aliasWeightShare: h(0.82),
    coverageWeightShare: h(0.18),
    exactInputBonus: h(0.04),
    entityCompleteBonus: h(0.08),
    sideEffectPenalty: h(0.03)
  }),
  relation: Object.freeze({
    base: h(0.48),
    conceptWeightShare: h(0.2),
    subjectBonus: h(0.12),
    objectBonus: h(0.12),
    queryShapeBonus: h(0.12),
    statementShapeBonus: h(0.14),
    missingSlotPenalty: h(0.16),
    sideEffectPenalty: h(0.05),
    weakSingleCharacterPenalty: h(0.08)
  }),
  context: Object.freeze({
    resolvedQuery: h(0.86),
    unresolvedReference: h(0.48),
    inheritedSubject: h(0.14),
    inheritedRelation: h(0.12)
  }),
  feature: Object.freeze({
    directSelf: h(0.9),
    indirectSelf: h(0.7),
    explicitName: h(0.94),
    questionCue: h(0.75),
    negationCue: h(0.9),
    structuralTeaching: h(0.68),
    definitionQuery: h(0.84)
  }),
  producerTieBreak: Object.freeze({
    "legacy-regex": 0,
    lexicon: 1,
    "relation-pattern": 2,
    context: 3
  })
});
function he(e) {
  return v(Math.min(1, Math.max(0, e)));
}
function Ee(e, t = [], n = []) {
  const r = t.reduce((c, s) => c + s, 0), i = n.reduce((c, s) => c + s, 0);
  return he(e + r - i);
}
function ic(e, t, n, r) {
  const i = n.length === 0 ? 0 : Math.min(1, t.length / n.length), c = e * m.lexicon.aliasWeightShare + i * m.lexicon.coverageWeightShare;
  return Ee(
    c,
    r ? [m.lexicon.exactInputBonus] : []
  );
}
const cc = Object.freeze(
  [
    "为什么",
    "有没有",
    "是不是",
    "会不会",
    "还是",
    "什么",
    "啥",
    "谁",
    "哪里",
    "哪",
    "怎么",
    "吗",
    "?"
  ].map(
    (e) => Object.freeze({
      value: e,
      kind: "question-cue",
      key: `question:${e}`
    })
  )
), sc = Object.freeze(
  ["不是", "不会", "不能", "没有", "不", "没", "别"].map(
    (e) => Object.freeze({
      value: e,
      kind: "negation-cue",
      key: `negation:${e}`
    })
  )
), ac = Object.freeze([
  Object.freeze({
    value: "sunland ai",
    canonical: "Sunland AI · Beta",
    confidence: m.feature.directSelf
  }),
  Object.freeze({
    value: "你",
    canonical: "Sunland AI · Beta",
    confidence: m.feature.directSelf
  }),
  Object.freeze({
    value: "霜蓝",
    canonical: "霜蓝",
    confidence: m.feature.indirectSelf
  })
]), oc = /* @__PURE__ */ new Set(["is-a", "can", "has", "means"]), uc = /* @__PURE__ */ new Set(["什么", "什么名字", "谁", "吗"]), Fe = /[a-z0-9]/iu, We = /[\s,.;:!?'"()[\]~]/u;
function Ze(e, t) {
  return Object.freeze({ start: e, end: t });
}
function ie(e, t, n, r, i) {
  return Object.freeze({
    kind: e,
    key: t,
    value: n,
    rawRange: Object.freeze({ ...r }),
    weight: i
  });
}
function jt(e, t) {
  return t < 0 || t >= e.length ? !0 : !Fe.test(e[t]);
}
function Vt(e, t, n, r) {
  const i = t[0], c = t[t.length - 1], s = i === void 0 || !Fe.test(i) || jt(e, n - 1), a = c === void 0 || !Fe.test(c) || jt(e, r);
  return s && a;
}
function Gt(e, t) {
  return e.start < t.end && t.start < e.end;
}
function lc(e) {
  const t = [];
  for (const n of Yi) {
    const r = [], i = [...n.aliases].sort(
      (s, a) => a.length - s.length || s.localeCompare(a)
    );
    for (const s of i) {
      const a = s.trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
      let o = 0;
      for (; a.length > 0; ) {
        const d = e.matchKey.indexOf(a, o);
        if (d < 0)
          break;
        const l = d + a.length;
        if (o = d + 1, !Vt(e.matchKey, a, d, l))
          continue;
        const g = D(
          e,
          "matchKey",
          d,
          l
        ), b = ic(
          n.baseWeight,
          a,
          e.matchKey,
          e.matchKey === a
        ), w = ie(
          "lexicon-alias",
          n.id,
          s,
          g,
          b
        ), R = Object.freeze({
          id: n.id,
          canonical: n.canonical,
          matchedAlias: s,
          confidence: b,
          evidence: Object.freeze([w])
        });
        r.push(
          Object.freeze({
            entry: n,
            alias: s,
            start: d,
            end: l,
            rawRange: g,
            feature: w,
            concept: R
          })
        );
      }
    }
    r.sort(
      (s, a) => s.start - a.start || a.end - a.start - (s.end - s.start) || s.alias.localeCompare(a.alias)
    );
    const c = [];
    for (const s of r)
      c.some((a) => Gt(a, s)) || c.push(s);
    t.push(...c);
  }
  return Object.freeze(
    t.sort(
      (n, r) => n.start - r.start || n.end - r.end || n.entry.id.localeCompare(r.entry.id)
    )
  );
}
function yt(e, t, n) {
  const r = [], i = [...t].sort(
    (c, s) => s.value.length - c.value.length
  );
  for (const c of i) {
    let s = 0;
    for (; c.value.length > 0; ) {
      const a = e.matchKey.indexOf(c.value, s);
      if (a < 0)
        break;
      const o = a + c.value.length;
      if (s = a + 1, r.some(
        (l) => a < l.end && l.start < o
      ))
        continue;
      const d = D(
        e,
        "matchKey",
        a,
        o
      );
      r.push(
        Object.freeze({
          start: a,
          end: o,
          feature: ie(
            c.kind,
            c.key,
            c.value,
            d,
            n
          )
        })
      );
    }
  }
  return Object.freeze(
    r.sort(
      (c, s) => c.start - s.start || c.end - s.end
    ).map((c) => c.feature)
  );
}
function fc(e, t, n) {
  let r = t, i = n;
  for (; r < i && We.test(e[r]); )
    r += 1;
  for (; i > r && We.test(e[i - 1]); )
    i -= 1;
  return Ze(r, i);
}
function et(e, t, n, r, i, c) {
  const s = D(
    e,
    "matchKey",
    r,
    i
  );
  return Object.freeze({
    kind: t,
    value: n,
    rawText: e.raw.slice(s.start, s.end),
    start: s.start,
    end: s.end,
    source: "explicit",
    confidence: c
  });
}
function dc(e) {
  const t = [];
  for (const n of ac) {
    let r = 0;
    for (; n.value.length > 0; ) {
      const i = e.matchKey.indexOf(n.value, r);
      if (i < 0)
        break;
      const c = i + n.value.length;
      r = c, Vt(
        e.matchKey,
        n.value,
        i,
        c
      ) && t.push(
        et(
          e,
          "self",
          n.canonical,
          i,
          c,
          n.confidence
        )
      );
    }
  }
  return Object.freeze(t);
}
function mc(e, t) {
  const n = [];
  for (const r of t) {
    if (r.entry.id !== "remember-name")
      continue;
    let i = r.end, c = e.matchKey.length;
    for (; i < c && We.test(e.matchKey[i]); )
      i += 1;
    const s = e.matchKey.slice(i).search(/[,;!?]/u);
    s >= 0 && (c = i + s);
    const a = fc(e.matchKey, i, c);
    if (a.start >= a.end)
      continue;
    const o = D(
      e,
      "matchKey",
      a.start,
      a.end
    ), d = e.raw.slice(o.start, o.end).trim().replace(/\s+/gu, " "), l = d.toLocaleLowerCase("und");
    d.length === 0 || uc.has(l) || /^(?:不|没|别)/u.test(l) || n.push(
      et(
        e,
        "person-name",
        d,
        a.start,
        a.end,
        m.feature.explicitName
      )
    );
  }
  return Object.freeze(
    n.filter(
      (r, i) => n.findIndex(
        (c) => c.start === r.start && c.end === r.end && c.value === r.value
      ) === i
    )
  );
}
function gc(e, t) {
  const n = t.filter(
    (i) => oc.has(i.entry.id)
  ).sort(
    (i, c) => i.start - c.start || c.end - c.start - (i.end - i.start) || i.entry.id.localeCompare(c.entry.id)
  ), r = [];
  for (const i of n)
    r.some((c) => Gt(c, i)) || r.push(i);
  return Object.freeze(
    r.map((i) => {
      const c = et(
        e,
        "relation",
        i.entry.canonical,
        i.start,
        i.end,
        i.concept.confidence
      );
      return Object.freeze({
        conceptId: i.entry.id,
        canonical: i.entry.canonical,
        alias: i.alias,
        matchKeyRange: Ze(i.start, i.end),
        entity: c,
        confidence: i.concept.confidence,
        evidence: Object.freeze([i.feature])
      });
    })
  );
}
function bc(e, t) {
  return t.length > 0 ? Object.freeze([]) : Object.freeze(
    e.map(
      (n) => ie(
        "teaching-cue",
        `teaching:${n.conceptId}`,
        n.alias,
        Ze(n.entity.start, n.entity.end),
        m.feature.structuralTeaching
      )
    )
  );
}
function hc(e) {
  const t = lc(e), n = Object.freeze(
    t.map((b) => b.concept)
  ), r = yt(
    e,
    cc,
    m.feature.questionCue
  ), i = yt(
    e,
    sc,
    m.feature.negationCue
  ), c = dc(e), s = mc(e, t), a = gc(e, t), o = t.filter((b) => b.entry.id === "teaching").map(
    (b) => ie(
      "teaching-cue",
      "teaching:explicit",
      b.alias,
      b.rawRange,
      b.concept.confidence
    )
  ), d = Object.freeze([
    ...o,
    ...bc(a, r)
  ]), l = Object.freeze(
    t.filter((b) => b.entry.id === "query-definition").map(
      (b) => ie(
        "definition-query",
        "query:definition",
        b.alias,
        b.rawRange,
        m.feature.definitionQuery
      )
    )
  ), g = Object.freeze([
    ...c,
    ...s,
    ...a.map((b) => b.entity)
  ]);
  return Object.freeze({
    input: e,
    concepts: n,
    entities: g,
    questionCues: r,
    negationCues: i,
    selfReferences: c,
    personNames: s,
    relations: a,
    teachingCues: d,
    definitionQueryCues: l
  });
}
const N = Object.freeze({
  maximumTurns: 6,
  maximumConceptsPerTurn: 8,
  maximumEntitiesPerTurn: 4,
  maximumEntityValueLength: 80,
  maximumRelationLength: 48,
  maximumTurnIdLength: 128
}), pc = /* @__PURE__ */ new Set([
  "Greeting",
  "Thanks",
  "Farewell",
  "Identity",
  "RememberName",
  "RecallName"
]), jc = /* @__PURE__ */ new Set([
  "object-of",
  "verify",
  "locate"
]), yc = /* @__PURE__ */ new Set([
  "subject",
  "object",
  "self"
]), Oc = /* @__PURE__ */ new Set([
  "它",
  "这个",
  "那个",
  "这",
  "那"
]), Ec = /* @__PURE__ */ new Set([
  "你",
  "sunland ai",
  "sunland ai · beta"
]);
function Se(e) {
  return typeof e == "object" && e !== null;
}
function H(e, t) {
  if (typeof e != "string") return null;
  const n = e.trim().replace(/\s+/gu, " ");
  return n.length === 0 || n.length > t ? null : n;
}
function tt(e) {
  return Oc.has(
    e.trim().replace(/\s+/gu, " ").toLocaleLowerCase("und")
  );
}
function nt(e) {
  return Ec.has(
    e.trim().replace(/\s+/gu, " ").toLocaleLowerCase("und")
  );
}
function Ot(e) {
  if (!Se(e) || !yc.has(e.kind))
    return null;
  const t = H(
    e.value,
    N.maximumEntityValueLength
  );
  return t === null ? null : Object.freeze({
    kind: e.kind,
    value: t
  });
}
function Sc(e) {
  if (!Se(e) || !jc.has(e.kind))
    return;
  const t = H(
    e.relation,
    N.maximumRelationLength
  );
  if (!(t === null || typeof e.hasObject != "boolean"))
    return Object.freeze({
      kind: e.kind,
      relation: t,
      hasObject: e.hasObject
    });
}
function wc(e) {
  if (!Se(e) || e.speaker !== "user" && e.speaker !== "assistant")
    return null;
  const t = H(
    e.turnId,
    N.maximumTurnIdLength
  );
  if (t === null) return null;
  const n = typeof e.acceptedIntent == "string" && pc.has(e.acceptedIntent) ? e.acceptedIntent : void 0, r = Object.freeze(
    (Array.isArray(e.concepts) ? e.concepts : []).map(
      (o) => H(
        o,
        N.maximumEntityValueLength
      )
    ).filter((o) => o !== null).slice(0, N.maximumConceptsPerTurn)
  ), i = Object.freeze(
    (Array.isArray(e.entityReferences) ? e.entityReferences : []).map(Ot).filter(
      (o) => o !== null
    ).slice(0, N.maximumEntitiesPerTurn)
  ), c = Ot(e.focusEntity), s = H(
    e.relation,
    N.maximumRelationLength
  ), a = Sc(e.queryShape);
  return Object.freeze({
    turnId: t,
    speaker: e.speaker,
    ...n === void 0 ? {} : { acceptedIntent: n },
    concepts: r,
    entityReferences: i,
    ...c === null ? {} : { focusEntity: c },
    ...s === null ? {} : { relation: s },
    ...a === void 0 ? {} : { queryShape: a }
  });
}
function Yt() {
  return Object.freeze({
    schemaVersion: 1,
    version: 0,
    recentTurns: Object.freeze([])
  });
}
function J(e) {
  if (!Se(e)) return Yt();
  const t = typeof e.version == "number" && Number.isSafeInteger(e.version) && e.version >= 0 ? e.version : 0, n = Object.freeze(
    (Array.isArray(e.recentTurns) ? e.recentTurns : []).map(wc).filter((r) => r !== null).slice(-N.maximumTurns)
  );
  return Object.freeze({
    schemaVersion: 1,
    version: t,
    recentTurns: n
  });
}
function Le(e, t) {
  return Object.freeze({ kind: e, value: t.trim().replace(/\s+/gu, " ") });
}
function Et(e) {
  return nt(e);
}
function Cc(e) {
  const t = [
    e.selectedCandidate,
    ...e.secondaryCandidates
  ];
  return Object.freeze(
    [...new Set(t.flatMap(({ concepts: n }) => n.map(({ id: r }) => r)))].sort().slice(0, N.maximumConceptsPerTurn)
  );
}
function Rc(e, t, n) {
  const r = Cc(n);
  switch (t.type) {
    case "query": {
      const i = Le(
        Et(t.subject) ? "self" : "subject",
        Et(t.subject) ? "Sunland AI · Beta" : t.subject
      );
      return Object.freeze({
        turnId: e,
        speaker: "user",
        concepts: r,
        entityReferences: Object.freeze([i]),
        focusEntity: i,
        relation: t.relation,
        queryShape: Object.freeze({
          kind: t.kind,
          relation: t.relation,
          hasObject: t.object !== void 0
        })
      });
    }
    case "statement": {
      const i = Le("subject", t.subject);
      return Object.freeze({
        turnId: e,
        speaker: "user",
        concepts: r,
        entityReferences: Object.freeze([i]),
        focusEntity: i,
        relation: t.relation
      });
    }
    case "intent": {
      if (t.intent === "Identity") {
        const i = Le("self", "Sunland AI · Beta");
        return Object.freeze({
          turnId: e,
          speaker: "user",
          acceptedIntent: t.intent,
          concepts: r,
          entityReferences: Object.freeze([i]),
          focusEntity: i,
          relation: t.entities[1] === "capability" ? "会" : "是"
        });
      }
      return t.intent === "RememberName" ? Object.freeze({
        turnId: e,
        speaker: "user",
        acceptedIntent: t.intent,
        concepts: r,
        entityReferences: Object.freeze([])
      }) : null;
    }
    case "unknown":
      return null;
  }
}
function kc(e) {
  const t = J(e.context);
  if (!e.canCommit || e.decision.kind !== "accept" || e.executedResult === null)
    return Object.freeze({
      kind: "none",
      baseVersion: t.version
    });
  const n = H(
    e.turnId,
    N.maximumTurnIdLength
  );
  if (n === null)
    return Object.freeze({
      kind: "none",
      baseVersion: t.version
    });
  const r = Rc(
    n,
    e.executedResult,
    e.decision
  );
  if (r === null)
    return Object.freeze({
      kind: "none",
      baseVersion: t.version
    });
  const i = t.version + 1, c = Object.freeze({
    schemaVersion: 1,
    version: i,
    recentTurns: Object.freeze(
      [...t.recentTurns, r].slice(
        -N.maximumTurns
      )
    )
  });
  return Object.freeze({
    kind: "replace",
    baseVersion: t.version,
    nextVersion: i,
    context: c
  });
}
function Oa(e, t) {
  const n = J(e);
  return t.kind !== "replace" || t.baseVersion !== n.version || t.nextVersion !== t.baseVersion + 1 || t.context.version !== t.nextVersion ? n : J(t.context);
}
function we(e) {
  return e.trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
}
function zc(e) {
  return [...e.recentTurns].reverse().find(
    (t) => t.relation !== void 0 || t.focusEntity !== void 0 || t.entityReferences.length > 0
  );
}
function Ht(e) {
  const t = zc(e);
  if (t === void 0)
    return Object.freeze({ kind: "none", entities: Object.freeze([]) });
  if (t.focusEntity !== void 0)
    return Object.freeze({
      kind: "unique",
      entities: Object.freeze([t.focusEntity])
    });
  const n = /* @__PURE__ */ new Set(), r = Object.freeze(
    t.entityReferences.filter(({ kind: i }) => i === "subject" || i === "self").filter((i) => {
      const c = we(i.value);
      return n.has(c) ? !1 : (n.add(c), !0);
    })
  );
  return r.length === 1 ? Object.freeze({ kind: "unique", entities: r }) : r.length > 1 ? Object.freeze({ kind: "ambiguous", entities: r }) : Object.freeze({ kind: "none", entities: r });
}
function Ic(e) {
  var t;
  return ((t = [...e.recentTurns].reverse().find(({ relation: n }) => n !== void 0)) == null ? void 0 : t.relation) ?? null;
}
function pe(e, t, n, r, i) {
  return Object.freeze({
    kind: e,
    value: t,
    rawText: n,
    start: r.start,
    end: r.end,
    source: i,
    confidence: m.context.resolvedQuery
  });
}
function ce(e, t, n, r) {
  return Object.freeze({
    kind: "context-reference",
    key: e,
    value: t,
    weight: n,
    ...r === void 0 ? {} : { rawRange: Object.freeze({ ...r }) }
  });
}
function St(e, t, n) {
  return Object.freeze({
    id: e,
    canonical: t,
    confidence: m.context.resolvedQuery,
    evidence: n
  });
}
function se(e, t, n, r, i, c) {
  return Object.freeze({
    id: e,
    producer: "context",
    producerWeight: m.producerWeight.context,
    result: t,
    concepts: Object.freeze([...c]),
    entities: Object.freeze([...n]),
    confidence: t === null ? m.context.unresolvedReference : m.context.resolvedQuery,
    evidence: Object.freeze([...r]),
    missingSlots: Object.freeze([...i]),
    sideEffect: "none"
  });
}
function rt(e, t) {
  const n = e.input.matchKey.indexOf(t);
  return n < 0 ? Object.freeze({ start: 0, end: 0 }) : D(
    e.input,
    "matchKey",
    n,
    n + t.length
  );
}
function Ve(e) {
  return tt(e);
}
function X(e) {
  return nt(e);
}
function $e(e, t, n, r, i) {
  const c = rt(e, we(n.subject)), s = e.input.raw.slice(c.start, c.end), a = pe(
    X(r) ? "self" : "subject",
    X(r) ? "Sunland AI · Beta" : r,
    s,
    c,
    i
  ), o = Object.freeze({
    ...n,
    subject: a.value
  }), d = ce(
    "context:resolved-subject",
    a.value,
    m.context.inheritedSubject,
    c
  );
  return se(
    `context:query:${o.subject}:${o.relation}:${o.kind}`,
    o,
    Object.freeze([
      a,
      ...t.entities.filter(({ kind: l }) => l !== "subject")
    ]),
    Object.freeze([...t.evidence, d]),
    Object.freeze([]),
    t.concepts
  );
}
function Nc(e, t, n, r) {
  const i = rt(e, we(n.subject)), c = Object.freeze([
    ...t.evidence,
    ce(
      r.kind === "ambiguous" ? "context:ambiguous-subject" : "context:missing-subject",
      n.subject,
      m.context.unresolvedReference,
      i
    )
  ]), s = r.entities.map(
    (a) => pe(
      a.kind === "self" ? "self" : "subject",
      a.value,
      "",
      Object.freeze({ start: 0, end: 0 }),
      "context"
    )
  );
  return se(
    `context:partial:${n.relation}:${r.kind}`,
    null,
    Object.freeze(s),
    c,
    Object.freeze(["subject"]),
    t.concepts
  );
}
function Tc(e, t, n) {
  const r = Ht(n), i = [], c = [], s = t.some(
    ({ result: a }) => (a == null ? void 0 : a.type) === "query" && a.kind === "object-of" && a.relation === "意思是"
  );
  for (const a of t) {
    const o = a.result;
    if (s && a.producer === "legacy-regex" && (o == null ? void 0 : o.type) === "intent" && o.intent === "Identity") {
      c.push(a.id);
      continue;
    }
    if ((o == null ? void 0 : o.type) === "statement" && Ve(o.subject)) {
      const d = rt(
        e,
        we(o.subject)
      ), l = ce(
        "context:side-effect-subject-prohibited",
        o.subject,
        m.context.unresolvedReference,
        d
      );
      i.push(
        se(
          `context:partial:side-effect-subject:${o.relation}`,
          null,
          Object.freeze([]),
          Object.freeze([...a.evidence, l]),
          Object.freeze(["subject"]),
          a.concepts
        )
      ), c.push(a.id);
      continue;
    }
    if ((o == null ? void 0 : o.type) === "query") {
      if (o.kind === "object-of" && o.relation === "意思是") {
        i.push(
          $e(
            e,
            a,
            o,
            o.subject,
            "explicit"
          )
        ), c.push(a.id);
        continue;
      }
      if (X(o.subject)) {
        i.push(
          $e(
            e,
            a,
            o,
            "Sunland AI · Beta",
            "explicit"
          )
        ), c.push(a.id);
        continue;
      }
      Ve(o.subject) && (c.push(a.id), r.kind === "unique" ? i.push(
        $e(
          e,
          a,
          o,
          r.entities[0].value,
          "context"
        )
      ) : i.push(
        Nc(
          e,
          a,
          o,
          r
        )
      ));
    }
  }
  return Object.freeze({
    candidates: Object.freeze(i),
    supersededCandidateIds: Object.freeze(c)
  });
}
function vc(e, t) {
  var a;
  const n = e.input.surface.toLocaleLowerCase("und"), r = /^(?:那\s*)?(.+?)\s*呢$/u.exec(
    n
  );
  if (r === null) return null;
  const i = ((a = r[1]) == null ? void 0 : a.trim()) ?? "";
  if (i.length === 0) return null;
  const c = n.indexOf(i), s = D(
    e.input,
    "surface",
    c,
    c + i.length
  );
  if (X(i))
    return Object.freeze({
      value: "Sunland AI · Beta",
      rawRange: s,
      source: "explicit",
      ambiguousEntities: Object.freeze([])
    });
  if (Ve(i)) {
    const o = Ht(t);
    return o.kind !== "unique" ? Object.freeze({
      value: "",
      rawRange: s,
      source: "context",
      ambiguousEntities: o.entities
    }) : Object.freeze({
      value: o.entities[0].value,
      rawRange: s,
      source: "context",
      ambiguousEntities: Object.freeze([])
    });
  }
  return Object.freeze({
    value: e.input.raw.slice(s.start, s.end).trim().replace(/\s+/gu, " "),
    rawRange: s,
    source: "explicit",
    ambiguousEntities: Object.freeze([])
  });
}
function Ac(e, t) {
  const n = vc(e, t);
  if (n === null) return null;
  const r = Ic(t), i = ce(
    n.value.length === 0 ? "context:ambiguous-subject" : "context:ellipsis-subject",
    n.value,
    m.context.inheritedSubject,
    n.rawRange
  );
  if (n.value.length === 0 || r === null) {
    const l = Object.freeze([
      ...n.value.length === 0 ? ["subject"] : [],
      ...r === null ? ["relation"] : []
    ]), g = n.ambiguousEntities.map(
      (b) => pe(
        b.kind === "self" ? "self" : "subject",
        b.value,
        "",
        Object.freeze({ start: 0, end: 0 }),
        "context"
      )
    );
    return se(
      `context:ellipsis:partial:${l.join("+")}`,
      null,
      Object.freeze(g),
      Object.freeze([i]),
      l,
      Object.freeze([
        St(
          "context-ellipsis",
          "context ellipsis",
          Object.freeze([i])
        )
      ])
    );
  }
  const c = pe(
    X(n.value) ? "self" : "subject",
    X(n.value) ? "Sunland AI · Beta" : n.value,
    e.input.raw.slice(
      n.rawRange.start,
      n.rawRange.end
    ),
    n.rawRange,
    n.source
  ), s = ce(
    "context:inherited-relation",
    r,
    m.context.inheritedRelation
  ), a = r === "在" ? "locate" : "object-of", o = Object.freeze({
    type: "query",
    subject: c.value,
    relation: r,
    kind: a,
    raw: e.input.raw
  }), d = Object.freeze([i, s]);
  return se(
    `context:ellipsis:query:${c.value}:${r}`,
    o,
    Object.freeze([c]),
    d,
    Object.freeze([]),
    Object.freeze([
      St("context-ellipsis", "context ellipsis", d)
    ])
  );
}
function xc(e, t, n) {
  var s;
  const r = Tc(
    e,
    t,
    n
  ), i = Ac(e, n), c = ((s = i == null ? void 0 : i.result) == null ? void 0 : s.type) === "query" ? t.filter(
    ({ producer: a, result: o }) => a === "legacy-regex" && (o == null ? void 0 : o.type) === "intent" && o.intent === "Identity"
  ).map(({ id: a }) => a) : [];
  return Object.freeze({
    candidates: Object.freeze([
      ...r.candidates,
      ...i === null ? [] : [i]
    ]),
    supersededCandidateIds: Object.freeze([
      ...r.supersededCandidateIds,
      ...c
    ])
  });
}
const Lc = Object.freeze({
  Greeting: Object.freeze(["greeting"]),
  Thanks: Object.freeze(["thanks"]),
  Farewell: Object.freeze(["goodbye"]),
  Identity: Object.freeze(["identity-name", "identity-self"]),
  RememberName: Object.freeze(["remember-name"]),
  RecallName: Object.freeze(["recall-name"])
});
function $c(e) {
  switch (e.type) {
    case "intent":
      return `intent:${e.intent}:${e.entities.join("|")}`;
    case "statement":
      return `statement:${e.subject}:${e.relation}:${e.object}:${e.negated}`;
    case "query":
      return `query:${e.kind}:${e.subject}:${e.relation}:${e.object ?? ""}`;
    case "unknown":
      return "unknown";
  }
}
function _c(e, t) {
  if (e.type === "intent") {
    const n = Lc[e.intent] ?? [];
    return Object.freeze(
      t.concepts.filter((r) => n.includes(r.id))
    );
  }
  return e.type === "statement" || e.type === "query" ? Object.freeze(
    t.concepts.filter(
      (n) => t.relations.some(
        (r) => r.conceptId === n.id && r.canonical === e.relation
      )
    )
  ) : Object.freeze([]);
}
function Kc(e) {
  switch (e.type) {
    case "intent":
      return v(
        Math.max(
          m.legacy.intentFloor,
          he(e.confidence)
        )
      );
    case "statement":
      return m.legacy.statement;
    case "query":
      return m.legacy.query;
    case "unknown":
      return m.legacy.unknown;
  }
}
function Mc(e) {
  const t = Lt().parse(e.input.raw), n = Kc(t), r = Object.freeze({
    start: 0,
    end: e.input.raw.length
  }), i = Object.freeze([
    Object.freeze({
      kind: "legacy-regex",
      key: `legacy:${t.type}`,
      value: t.type,
      rawRange: r,
      weight: n
    })
  ]);
  return Object.freeze({
    id: `legacy-regex:${$c(t)}`,
    producer: "legacy-regex",
    producerWeight: m.producerWeight["legacy-regex"],
    result: t,
    concepts: _c(t, e),
    entities: e.entities,
    confidence: n,
    evidence: i,
    missingSlots: t.type === "unknown" ? Object.freeze(["interpretation"]) : Object.freeze([]),
    sideEffect: t.type === "statement" ? "knowledge-write" : "none"
  });
}
const Pc = Object.freeze({
  greeting: Object.freeze({ intent: "Greeting", sideEffect: "none" }),
  thanks: Object.freeze({ intent: "Thanks", sideEffect: "none" }),
  goodbye: Object.freeze({ intent: "Farewell", sideEffect: "none" }),
  "identity-name": Object.freeze({
    intent: "Identity",
    sideEffect: "none"
  }),
  "identity-self": Object.freeze({
    intent: "Identity",
    sideEffect: "none"
  }),
  "remember-name": Object.freeze({
    intent: "RememberName",
    sideEffect: "memory-write"
  }),
  "recall-name": Object.freeze({
    intent: "RecallName",
    sideEffect: "none"
  })
});
function Qt(e) {
  return e.evidence[0] ?? null;
}
function qc(e, t) {
  var r, i;
  const n = ((i = (r = Qt(e)) == null ? void 0 : r.rawRange) == null ? void 0 : i.end) ?? 0;
  return [...t.personNames].filter((c) => c.start >= n).sort(
    (c, s) => c.start - s.start || c.end - s.end
  )[0] ?? null;
}
function Dc(e, t, n) {
  var i, c;
  const r = ((c = (i = Qt(e)) == null ? void 0 : i.rawRange) == null ? void 0 : c.start) ?? 0;
  return n.negationCues.some((s) => {
    const a = s.rawRange;
    return a !== void 0 && a.start >= r && a.end <= t.end;
  });
}
function Uc(e) {
  var n;
  const t = ((n = e.selfReferences[0]) == null ? void 0 : n.value) ?? "Sunland AI · Beta";
  return Object.freeze([t, "identity"]);
}
function Bc(e, t, n, r) {
  return Object.freeze({
    type: "intent",
    intent: e,
    entities: Object.freeze([...t]),
    confidence: n,
    raw: r
  });
}
function Fc(e, t) {
  const n = Pc[e.id];
  if (n === void 0)
    return null;
  let r = Object.freeze([]), i = Object.freeze([]);
  if (n.intent === "Identity" && (r = t.selfReferences, i = Uc(t)), n.intent === "RememberName") {
    const l = qc(e, t);
    if (l === null || Dc(e, l, t))
      return null;
    r = Object.freeze([l]), i = Object.freeze([l.value]);
  }
  const c = r.length > 0 ? [m.lexicon.entityCompleteBonus] : [], s = n.sideEffect === "none" ? [] : [m.lexicon.sideEffectPenalty], a = Ee(
    e.confidence,
    c,
    s
  ), o = Bc(
    n.intent,
    i,
    a,
    t.input.raw
  ), d = Object.freeze([
    ...e.evidence,
    ...r.map(
      (l) => Object.freeze({
        kind: "entity-pattern",
        key: `entity:${l.kind}`,
        value: l.value,
        rawRange: Object.freeze({
          start: l.start,
          end: l.end
        }),
        weight: l.confidence
      })
    )
  ]);
  return Object.freeze({
    id: `lexicon:intent:${n.intent}:${i.join("|")}`,
    producer: "lexicon",
    producerWeight: m.producerWeight.lexicon,
    result: o,
    concepts: Object.freeze([e]),
    entities: r,
    confidence: a,
    evidence: d,
    missingSlots: Object.freeze([]),
    sideEffect: n.sideEffect
  });
}
function Wc(e) {
  const t = e.concepts.some(
    ({ id: n }) => n === "recall-name"
  );
  return Object.freeze(
    e.concepts.filter(
      ({ id: n }) => !(t && n === "remember-name")
    ).map((n) => Fc(n, e)).filter(
      (n) => n !== null
    )
  );
}
const Jt = /[,;!?]/u, wt = /[\s,.;:!?'"()[\]~]/u, Xt = /* @__PURE__ */ new Set(["什么", "啥", "谁", "哪", "哪里"]), Zt = /[吗呢]$/u, Vc = /(?:不是|不会|不能|没有|不|没)$/u;
function Gc(e, t) {
  let n = 0;
  for (let c = t - 1; c >= 0; c -= 1)
    if (Jt.test(e[c])) {
      n = c + 1;
      break;
    }
  const r = e.slice(n, t), i = r.lastIndexOf("和");
  return i >= 0 && /(?:什么|啥|谁|吗|呢|\?)/u.test(r.slice(0, i)) ? n + i + 1 : n;
}
function Yc(e, t) {
  for (let n = t; n < e.length; n += 1)
    if (Jt.test(e[n]))
      return n;
  return e.length;
}
function je(e, t, n) {
  let r = t, i = n;
  for (; r < i && wt.test(e[r]); )
    r += 1;
  for (; i > r && wt.test(e[i - 1]); )
    i -= 1;
  return r >= i ? null : Object.freeze({
    start: r,
    end: i,
    value: e.slice(r, i)
  });
}
function Hc(e, t) {
  if (t === null)
    return Object.freeze({ segment: null, negated: !1 });
  const n = Vc.exec(t.value);
  return Object.freeze(n === null ? { segment: t, negated: !1 } : {
    segment: je(
      e,
      t.start,
      t.end - n[0].length
    ),
    negated: !0
  });
}
function Qc(e, t) {
  if (t === null)
    return null;
  const n = Zt.exec(t.value);
  return n === null ? t : je(
    e,
    t.start,
    t.end - n[0].length
  );
}
function en(e, t) {
  return D(
    e.input,
    "matchKey",
    t.start,
    t.end
  );
}
function Jc(e, t) {
  const n = en(e, t);
  return e.input.raw.slice(n.start, n.end).trim().replace(/\s+/gu, " ").replace(/^["“”'‘’]+|["“”'‘’]+$/gu, "");
}
function Ct(e, t, n, r) {
  const i = en(e, n);
  return Object.freeze({
    kind: t,
    value: Jc(e, n),
    rawText: e.input.raw.slice(i.start, i.end),
    start: i.start,
    end: i.end,
    source: "explicit",
    confidence: r
  });
}
function Xc(e, t) {
  return e.concepts.find(
    (n) => n.id === t.conceptId && n.evidence.some(
      (r) => {
        var i;
        return ((i = r.rawRange) == null ? void 0 : i.start) === t.entity.start && r.rawRange.end === t.entity.end;
      }
    )
  ) ?? Object.freeze({
    id: t.conceptId,
    canonical: t.canonical,
    matchedAlias: t.alias,
    confidence: t.confidence,
    evidence: t.evidence
  });
}
function Zc(e, t) {
  return e.concepts.filter(
    (n) => n.id === "remember-name" || n.id === "recall-name"
  ).some(
    (n) => n.evidence.some((r) => {
      const i = r.rawRange;
      return i !== void 0 && t.entity.start >= i.start && t.entity.end <= i.end;
    })
  );
}
function es(e, t, n, r) {
  if (r !== null && Xt.has(r.value.replace(Zt, "")))
    return !0;
  const i = t < n ? D(
    e.input,
    "matchKey",
    t,
    n
  ) : null;
  return e.questionCues.some((c) => {
    const s = c.rawRange;
    return s !== void 0 && i !== null && s.start >= i.start && s.end <= i.end;
  });
}
function ts(e, t, n, r, i, c) {
  return n === null ? null : i === "object-of" ? Object.freeze({
    type: "query",
    subject: n.value,
    relation: t.canonical,
    kind: "object-of",
    raw: e.input.raw
  }) : i === "verify" ? r === null ? null : Object.freeze({
    type: "query",
    subject: n.value,
    relation: t.canonical,
    object: r.value,
    kind: "verify",
    raw: e.input.raw
  }) : r === null ? null : Object.freeze({
    type: "statement",
    subject: n.value,
    relation: t.canonical,
    object: r.value,
    negated: c,
    raw: e.input.raw
  });
}
function ns(e, t) {
  if (Zc(e, t))
    return null;
  const n = e.input.matchKey, r = Gc(n, t.matchKeyRange.start), i = Yc(n, t.matchKeyRange.end), c = je(
    n,
    r,
    t.matchKeyRange.start
  ), s = Hc(n, c), a = je(
    n,
    t.matchKeyRange.end,
    i
  ), o = Qc(n, a), d = es(
    e,
    r,
    i,
    o
  ), l = t.alias === "是什么意思" || o !== null && Xt.has(o.value), g = l ? "object-of" : d ? "verify" : null, b = l ? null : o, w = s.segment === null ? null : Ct(
    e,
    "subject",
    s.segment,
    t.confidence
  ), R = b === null ? null : Ct(
    e,
    "object",
    b,
    t.confidence
  ), S = ts(
    e,
    t,
    w,
    R,
    g,
    s.negated
  ), B = [];
  w === null && B.push("subject"), (g === null || g === "verify") && R === null && B.push("object");
  const ae = (S == null ? void 0 : S.type) === "statement" ? "knowledge-write" : "none", A = [
    t.confidence * m.relation.conceptWeightShare,
    ...w === null ? [] : [m.relation.subjectBonus],
    ...R === null ? [] : [m.relation.objectBonus],
    g !== null ? m.relation.queryShapeBonus : m.relation.statementShapeBonus
  ], Ce = [
    ...B.map(
      () => m.relation.missingSlotPenalty
    ),
    ...ae === "none" ? [] : [m.relation.sideEffectPenalty],
    ...t.alias.length === 1 ? [m.relation.weakSingleCharacterPenalty] : []
  ], Re = Ee(
    m.relation.base,
    A,
    Ce
  ), oe = Object.freeze(
    [w, t.entity, R].filter(
      (k) => k !== null
    )
  ), x = Object.freeze([
    ...t.evidence,
    ...oe.filter((k) => k.kind !== "relation").map(
      (k) => Object.freeze({
        kind: "relation-pattern",
        key: `slot:${k.kind}`,
        value: k.value,
        rawRange: Object.freeze({
          start: k.start,
          end: k.end
        }),
        weight: k.confidence
      })
    ),
    ...g !== null ? e.questionCues : e.teachingCues,
    ...s.negated ? e.negationCues : []
  ]), ke = S === null ? `partial:${t.canonical}:${t.entity.start}` : S.type === "query" ? `query:${S.subject}:${S.relation}` : `statement:${S.subject}:${S.relation}:${S.object}:${S.negated}`;
  return Object.freeze({
    id: `relation-pattern:${ke}`,
    producer: "relation-pattern",
    producerWeight: m.producerWeight["relation-pattern"],
    result: S,
    concepts: Object.freeze([Xc(e, t)]),
    entities: oe,
    confidence: Re,
    evidence: x,
    missingSlots: Object.freeze(B),
    sideEffect: ae
  });
}
function rs(e) {
  var s;
  const t = e.teachingCues.filter(
    ({ key: a }) => a === "teaching:explicit"
  );
  if (t.length === 0 || e.relations.length > 0)
    return null;
  const n = e.concepts.filter(
    ({ id: a }) => a === "teaching"
  ), r = Object.freeze([
    "subject",
    "relation",
    "object"
  ]), i = Ee(
    m.relation.base,
    [],
    r.map(
      () => m.relation.missingSlotPenalty
    )
  ), c = (s = t[0]) == null ? void 0 : s.rawRange;
  return Object.freeze({
    id: `relation-pattern:partial-teaching:${(c == null ? void 0 : c.start) ?? 0}`,
    producer: "relation-pattern",
    producerWeight: m.producerWeight["relation-pattern"],
    result: null,
    concepts: Object.freeze(n),
    entities: Object.freeze([]),
    confidence: i,
    evidence: Object.freeze(t),
    missingSlots: r,
    sideEffect: "none"
  });
}
function is(e) {
  const t = rs(e);
  return Object.freeze(
    [
      ...e.relations.map(
        (n) => ns(e, n)
      ),
      t
    ].filter(
      (n) => n !== null
    )
  );
}
function cs(e) {
  if (e === null)
    return "partial";
  switch (e.type) {
    case "intent":
      return `intent:${e.intent}:${e.entities.join("|")}`;
    case "statement":
      return `statement:${e.subject}:${e.relation}:${e.object}:${e.negated}`;
    case "query":
      return `query:${e.kind}:${e.subject}:${e.relation}:${e.object ?? ""}`;
    case "unknown":
      return "unknown";
  }
}
function ss(e) {
  const t = e.result === null ? e.id : cs(e.result);
  return [
    e.producer,
    t,
    [...e.missingSlots].sort().join(",")
  ].join("::");
}
function as(e) {
  var t, n;
  return [
    e.kind,
    e.key,
    e.value ?? "",
    ((t = e.rawRange) == null ? void 0 : t.start) ?? "",
    ((n = e.rawRange) == null ? void 0 : n.end) ?? ""
  ].join(":");
}
function os(e) {
  var n, r;
  const t = e.evidence[0];
  return [
    e.id,
    ((n = t == null ? void 0 : t.rawRange) == null ? void 0 : n.start) ?? "",
    ((r = t == null ? void 0 : t.rawRange) == null ? void 0 : r.end) ?? ""
  ].join(":");
}
function us(e) {
  return [
    e.kind,
    e.start,
    e.end,
    e.value
  ].join(":");
}
function _e(e, t) {
  const n = /* @__PURE__ */ new Set(), r = [];
  for (const i of e) {
    const c = t(i);
    n.has(c) || (n.add(c), r.push(i));
  }
  return Object.freeze(r);
}
function ls(e, t) {
  const n = {
    none: 0,
    "memory-write": 1,
    "knowledge-write": 2
  };
  return n[e] >= n[t] ? e : t;
}
function fs(e, t) {
  return Object.freeze({
    id: e.id.localeCompare(t.id) <= 0 ? e.id : t.id,
    producer: e.producer,
    producerWeight: he(
      Math.max(e.producerWeight, t.producerWeight)
    ),
    result: e.result ?? t.result,
    concepts: _e(
      [...e.concepts, ...t.concepts],
      os
    ),
    entities: _e(
      [...e.entities, ...t.entities],
      us
    ),
    confidence: he(
      Math.max(e.confidence, t.confidence)
    ),
    evidence: _e(
      [...e.evidence, ...t.evidence],
      as
    ),
    missingSlots: Object.freeze(
      [.../* @__PURE__ */ new Set([...e.missingSlots, ...t.missingSlots])].sort()
    ),
    sideEffect: ls(
      e.sideEffect,
      t.sideEffect
    )
  });
}
function ds(e) {
  const t = /* @__PURE__ */ new Map();
  for (const n of e) {
    const r = ss(n), i = t.get(r);
    t.set(
      r,
      i === void 0 ? n : fs(i, n)
    );
  }
  return Object.freeze([...t.values()]);
}
function ms(e) {
  return Object.freeze(
    [...e].sort(
      (t, n) => n.confidence - t.confidence || t.missingSlots.length - n.missingSlots.length || m.producerTieBreak[t.producer] - m.producerTieBreak[n.producer] || t.id.localeCompare(n.id)
    )
  );
}
function gs(e, t, n) {
  const r = [];
  return e.trim().length === 0 && r.push(
    Object.freeze({
      level: "info",
      code: "semantic.empty-input",
      message: "Input contains no semantic surface content."
    })
  ), t.every(
    (i) => {
      var c;
      return i.producer === "legacy-regex" && ((c = i.result) == null ? void 0 : c.type) === "unknown";
    }
  ) && r.push(
    Object.freeze({
      level: "debug",
      code: "semantic.no-structured-candidate",
      message: "No structured semantic candidate was generated."
    })
  ), n !== void 0 && t.some(({ producer: i }) => i === "context") && r.push(
    Object.freeze({
      level: "debug",
      code: "semantic.context-candidate-generated",
      message: "A bounded context candidate was generated."
    })
  ), Object.freeze(r);
}
function bs(e, t) {
  const n = rc(e), r = hc(n), i = [
    Mc(r),
    ...Wc(r),
    ...is(r)
  ], c = t === void 0 ? void 0 : J(t), s = c === void 0 ? Object.freeze({
    candidates: Object.freeze([]),
    supersededCandidateIds: Object.freeze([])
  }) : xc(
    r,
    i,
    c
  ), a = new Set(s.supersededCandidateIds), o = [
    ...i.filter(({ id: l }) => !a.has(l)),
    ...s.candidates
  ], d = ms(
    ds(o)
  );
  return Object.freeze({
    input: n,
    extraction: r,
    candidates: d,
    diagnostics: gs(
      e,
      d,
      c
    )
  });
}
const hs = /^(?:你好|您好|嗨|哈喽|hello|hi)[,，]\s*/iu;
function tn(e) {
  return e.type === "intent" && e.intent === "RememberName";
}
function nn(e) {
  return e.type === "statement" || tn(e);
}
function rn(e) {
  var t, n;
  return e.sideEffect !== "none" || ((t = e.result) == null ? void 0 : t.type) === "statement" || ((n = e.result) == null ? void 0 : n.type) === "intent" && e.result.intent === "RememberName";
}
function be(e) {
  return e.trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
}
function ps(e, t) {
  let n = be(e.relation), r = be(e.object);
  const i = t.extraction.relations.some(
    ({ conceptId: c }) => c === "is-a"
  );
  return n === "是" && i && (n = "属于"), n === "属于" && r.startsWith("一种") && r.length > 2 && (r = r.slice(2)), n === "指的是" && (n = "意思是"), Object.freeze([
    be(e.subject),
    n,
    r,
    e.negated
  ]);
}
function Ge(e, t) {
  if ((e == null ? void 0 : e.type) === "statement")
    return `knowledge:${ps(e, t).join("|")}`;
  if ((e == null ? void 0 : e.type) === "intent" && e.intent === "RememberName") {
    const n = e.entities[0];
    return n === void 0 ? null : `memory:name:${be(n)}`;
  }
  return null;
}
function js(e) {
  return e.kind === "accept" ? Object.freeze([
    e.selectedCandidate,
    ...e.secondaryCandidates
  ]) : Object.freeze([]);
}
function ys(e) {
  return new Set(
    e.candidates.filter(rn).filter(
      (t) => t.result !== null && t.result.type !== "unknown" && t.missingSlots.length === 0
    ).map(
      (t) => Ge(t.result, e)
    ).filter((t) => t !== null)
  );
}
function Os(e) {
  return tn(e) ? e.raw.trim().replace(hs, "") : e.raw;
}
function M(e) {
  return Object.freeze({
    kind: "block-and-no-understanding",
    reason: e
  });
}
function Es(e, t, n) {
  if (!nn(t))
    return Object.freeze({
      kind: "allow-passive-legacy",
      reason: "not-a-side-effect"
    });
  if (e.kind === "clarify")
    return Object.freeze({
      kind: "block-and-clarify",
      reason: "semantic-clarification-required",
      decision: e
    });
  if (e.kind === "reject-side-effect")
    return M("semantic-side-effect-rejected");
  if (e.kind !== "accept")
    return M("semantic-side-effect-not-accepted");
  if (n.extraction.negationCues.length > 0)
    return M("negation-detected");
  if (n.extraction.questionCues.length > 0)
    return M("question-detected");
  if (At(n.input.raw))
    return M("explicit-prohibition");
  if (Je(
    Os(t)
  ))
    return M("unsafe-input-structure");
  const r = js(
    e
  ).filter(rn);
  if (r.length === 0 || r.some(
    (s) => s.result === null || s.missingSlots.length > 0
  ))
    return M(
      r.length === 0 ? "semantic-side-effect-not-accepted" : "missing-required-slot"
    );
  if (ys(n).size > 1)
    return M("compound-or-conflicting-side-effect");
  const i = Ge(
    t,
    n
  ), c = new Set(
    r.map(
      (s) => Ge(s.result, n)
    ).filter((s) => s !== null)
  );
  return i === null || !c.has(i) ? Object.freeze({
    kind: "reject",
    reason: "side-effect-interpretation-mismatch"
  }) : Object.freeze({
    kind: "allow-legacy-side-effect",
    reason: "semantic-side-effect-confirmed"
  });
}
const Ss = /* @__PURE__ */ new Set([
  "Greeting",
  "Thanks",
  "Farewell",
  "Identity",
  "RecallName"
]), ws = /* @__PURE__ */ new Set([
  "subject",
  "relation",
  "object",
  "name",
  "intent"
]);
function E(e) {
  return e.trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
}
function cn(e) {
  var t, n;
  return e.sideEffect !== "none" || ((t = e.result) == null ? void 0 : t.type) === "statement" || ((n = e.result) == null ? void 0 : n.type) === "intent" && e.result.intent === "RememberName";
}
function Cs(e) {
  return e.type === "query" || e.type === "intent" && Ss.has(e.intent);
}
function sn(e, t) {
  if (e.type !== t.type) return !1;
  switch (e.type) {
    case "intent":
      return t.type !== "intent" ? !1 : e.intent === t.intent && e.entities.length === t.entities.length && e.entities.every(
        (n, r) => E(n) === E(t.entities[r] ?? "")
      );
    case "query":
      return t.type === "query" && e.kind === t.kind && E(e.subject) === E(t.subject) && E(e.relation) === E(t.relation) && E(e.object ?? "") === E(t.object ?? "") && e.explain === t.explain;
    case "statement":
      return t.type === "statement" && E(e.subject) === E(t.subject) && E(e.relation) === E(t.relation) && E(e.object) === E(t.object) && e.negated === t.negated;
    case "unknown":
      return t.type === "unknown";
  }
}
function Rs(e, t) {
  const n = e.result;
  return e.producer !== "context" || (n == null ? void 0 : n.type) !== "query" ? !1 : t.type === "intent" && t.intent === "Identity" ? n.relation === "意思是" || e.concepts.some(({ id: r }) => r === "context-ellipsis") : t.type !== "query" || !tt(t.subject) && !nt(t.subject) ? !1 : E(n.relation) === E(t.relation) && n.kind === t.kind && E(n.object ?? "") === E(t.object ?? "");
}
function ks(e) {
  const t = e.result;
  if ((t == null ? void 0 : t.type) === "intent")
    switch (t.intent) {
      case "Greeting":
        return "greeting";
      case "Thanks":
        return "thanks";
      case "Farewell":
        return "farewell";
      case "Identity":
        return "identity";
      case "RecallName":
        return "recall-name";
      case "RememberName":
        return "remember-name";
    }
  return (t == null ? void 0 : t.type) === "query" ? "query" : (t == null ? void 0 : t.type) === "statement" || e.concepts.some(({ id: n }) => n === "teaching") ? "teaching" : "unknown";
}
function zs(e) {
  var n;
  const t = e == null ? void 0 : e.result;
  return (t == null ? void 0 : t.type) === "query" || (t == null ? void 0 : t.type) === "statement" ? t.relation : (n = e == null ? void 0 : e.entities.find(({ kind: r }) => r === "relation")) == null ? void 0 : n.value;
}
function Is(e) {
  return e.clarificationKind === "ambiguous-intent" || e.clarificationKind === "conflicting-candidates" ? "ambiguous" : e.clarificationKind === "uncertain-name" || e.clarificationKind === "uncertain-teaching" ? "uncertain" : "missing-information";
}
function an(e) {
  const t = Object.freeze(
    [...new Set(e.missingSlots)].filter(
      (c) => ws.has(c)
    ).sort()
  ), n = Object.freeze(
    [...new Set(e.candidateOptions.map(ks))].sort()
  ), r = Object.freeze(
    [
      ...new Set(
        e.candidateOptions.flatMap(
          ({ entities: c }) => c.filter(
            ({ source: s, kind: a }) => s === "context" && (a === "subject" || a === "self")
          ).map(({ value: s }) => s)
        )
      )
    ].filter((c) => c.length > 0 && c.length <= 80).slice(0, 3)
  ), i = zs(e.candidateOptions[0]);
  return Object.freeze({
    clarificationKind: e.clarificationKind,
    missingSlots: t,
    candidateLabels: n,
    reasonCategory: Is(e),
    ...i === void 0 ? {} : { relation: i },
    ...r.length === 0 ? {} : { contextLabels: r }
  });
}
function Ns(e, t) {
  return t.type === "unknown" || t.type === "query" && tt(t.subject) && e.missingSlots.includes("subject") && e.candidateOptions.some(
    ({ producer: n }) => n === "context"
  ) || e.reasonCodes.includes("compound-query") && e.candidateOptions.length >= 2 && e.candidateOptions.every(
    (n) => !cn(n)
  ) ? !0 : t.type === "statement" && e.missingSlots.includes("object") && /^(?:吗|呢|什么|啥|\?)$/u.test(t.object.trim()) && e.candidateOptions.some(
    (n) => n.evidence.some(({ kind: r }) => r === "question-cue")
  );
}
function Ye(e, t) {
  return Object.freeze({
    kind: "no-understanding",
    failure: Object.freeze({
      type: "unknown",
      raw: e.raw,
      reason: t
    })
  });
}
function Ts(e, t) {
  switch (e.kind) {
    case "allow-passive-legacy":
      return null;
    case "allow-legacy-side-effect":
      return Object.freeze({
        kind: "fallback-legacy",
        result: t,
        reason: "side-effect-prohibited"
      });
    case "block-and-clarify":
      return Object.freeze({
        kind: "clarification",
        context: an(e.decision)
      });
    case "block-and-no-understanding":
      return Ye(
        t,
        `legacy-side-effect-blocked:${e.reason}`
      );
    case "reject":
      return Ye(
        t,
        `legacy-side-effect-rejected:${e.reason}`
      );
  }
}
function vs(e, t, n) {
  const r = Ts(
    Es(
      e,
      t,
      n
    ),
    t
  );
  if (r !== null) return r;
  switch (e.kind) {
    case "accept": {
      if ([
        e.selectedCandidate,
        ...e.secondaryCandidates
      ].some(cn))
        return Object.freeze({
          kind: "fallback-legacy",
          result: t,
          reason: "side-effect-prohibited"
        });
      const c = e.selectedCandidate.result;
      return c === null || c.type === "unknown" ? Object.freeze({
        kind: "fallback-legacy",
        result: t,
        reason: "incomplete-result"
      }) : e.selectedCandidate.missingSlots.length > 0 || !Cs(c) ? Object.freeze({
        kind: "fallback-legacy",
        result: t,
        reason: "unsupported-result"
      }) : t.type !== "unknown" && !sn(c, t) && !Rs(
        e.selectedCandidate,
        t
      ) ? Object.freeze({
        kind: "fallback-legacy",
        result: t,
        reason: "legacy-conflict"
      }) : Object.freeze({ kind: "adopt", result: c });
    }
    case "clarify":
      return Ns(e, t) ? Object.freeze({
        kind: "clarification",
        context: an(e)
      }) : Object.freeze({
        kind: "fallback-legacy",
        result: t,
        reason: "legacy-conflict"
      });
    case "reject-side-effect":
      return t.type === "unknown" ? Ye(
        t,
        "semantic-side-effect-rejected"
      ) : Object.freeze({
        kind: "fallback-legacy",
        result: t,
        reason: "side-effect-rejected"
      });
    case "no-understanding":
      return t.type === "unknown" ? Object.freeze({
        kind: "no-understanding",
        failure: t
      }) : Object.freeze({
        kind: "fallback-legacy",
        result: t,
        reason: "legacy-conflict"
      });
  }
}
function As(e) {
  switch (e.kind) {
    case "accept":
      return e.selectedCandidate;
    case "clarify":
      return e.candidateOptions[0];
    case "reject-side-effect":
      return e.rejectedCandidate;
    case "no-understanding":
      return;
  }
}
function xs(e) {
  var t;
  return e === void 0 ? null : ((t = e.result) == null ? void 0 : t.type) ?? "partial";
}
function Ls(e) {
  if (e === void 0) return null;
  const t = e.result;
  return (t == null ? void 0 : t.type) === "intent" ? `semantic:${e.producer}:intent:${t.intent}` : `semantic:${e.producer}:${(t == null ? void 0 : t.type) ?? "partial"}`;
}
function $s(e) {
  return Object.freeze([...e.reasonCodes]);
}
function _s(e, t) {
  return e.kind === "accept" ? e.confidence : (t == null ? void 0 : t.confidence) ?? null;
}
function Ks(e, t, n, r) {
  const i = As(n), c = (i == null ? void 0 : i.result) === void 0 || i.result === null ? !1 : sn(i.result, t), s = e === "passive" && r.kind !== "fallback-legacy";
  return Object.freeze({
    mode: e,
    legacyType: t.type,
    decisionType: n.kind,
    selectedCandidateId: Ls(i),
    selectedCandidateType: xs(i),
    confidence: _s(n, i),
    reasonCodes: $s(n),
    equivalentToLegacy: c,
    semanticAdopted: s,
    fellBackToLegacy: e === "shadow" || r.kind === "fallback-legacy",
    adapterKind: r.kind,
    semanticError: !1
  });
}
function Ms(e, t) {
  return Object.freeze({
    mode: e,
    legacyType: t.type,
    decisionType: "error",
    selectedCandidateId: null,
    selectedCandidateType: null,
    confidence: null,
    reasonCodes: Object.freeze([]),
    equivalentToLegacy: !1,
    semanticAdopted: !1,
    fellBackToLegacy: !0,
    adapterKind: "error",
    semanticError: !0
  });
}
const Ps = Object.freeze({
  passiveIntentAcceptThreshold: v(0.72),
  queryAcceptThreshold: v(0.74),
  sideEffectAcceptThreshold: v(0.82),
  minimumCandidateMargin: v(0.08),
  partialCandidateThreshold: v(0.35),
  maximumAlternatives: 3,
  minimumSideEffectEvidenceUnits: 2,
  weakAliasMaximumLength: 1,
  missingSlotPolicy: Object.freeze({
    partialDecision: "clarify",
    sideEffectDecision: "reject-side-effect",
    clarifyExplicitTeaching: !0
  }),
  negationPolicy: Object.freeze({
    preserveNegatedCandidate: !0,
    rejectNegatedSideEffects: !0
  })
}), on = /* @__PURE__ */ new Set(["Greeting", "Thanks", "Farewell"]), qs = /* @__PURE__ */ new Set([
  "Greeting+Identity",
  "Greeting+RememberName",
  "Farewell+Thanks"
]), Ds = Object.freeze({
  "threshold-met": 0,
  "corroborated-producers": 1,
  "compatible-secondary-candidate": 2,
  "partial-candidate": 3,
  "missing-required-slot": 4,
  "insufficient-confidence": 5,
  "insufficient-margin": 6,
  "conflicting-candidates": 7,
  "compound-query": 8,
  "side-effect-evidence-insufficient": 9,
  "negation-conflict": 10,
  "no-viable-candidate": 11
}), Us = Object.freeze({
  "confidence-threshold": 0,
  "candidate-margin": 1,
  "complete-slots": 2,
  "explicit-name": 3,
  "complete-triple": 4,
  "strong-non-alias-evidence": 5,
  "non-question-assertion": 6,
  "non-negated-assertion": 7
});
function un(e, t) {
  return Object.freeze(
    [...new Set(e)].sort(
      (n, r) => t[n] - t[r] || n.localeCompare(r)
    )
  );
}
function U(e) {
  return un(e, Ds);
}
function ln(e) {
  return un(e, Us);
}
function Q(e) {
  return e.trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
}
function Bs(e) {
  return e.extraction.relations.some(
    ({ conceptId: t }) => t === "is-a"
  );
}
function He(e, t) {
  return Bs(e) && (t === "是" || t === "属于") ? "属于" : t;
}
function Rt(e, t, n) {
  const r = Q(n);
  return He(e, t) === "属于" && r.startsWith("一种") && r.length > 2 ? r.slice(2) : r;
}
function Fs(e, t) {
  const n = t.result;
  if (n === null)
    return `partial:${t.id}`;
  switch (n.type) {
    case "intent":
      return [
        "intent",
        n.intent,
        ...n.entities.map(Q)
      ].join(":");
    case "statement":
      return [
        "statement",
        Q(n.subject),
        He(e, n.relation),
        Rt(e, n.relation, n.object),
        n.negated
      ].join(":");
    case "query":
      return [
        "query",
        n.kind,
        Q(n.subject),
        He(e, n.relation),
        n.object === void 0 ? "" : Rt(
          e,
          n.relation,
          n.object
        )
      ].join(":");
    case "unknown":
      return `unknown:${t.id}`;
  }
}
function Qe(e) {
  const t = new Set(
    e.entities.map(
      ({ kind: n, start: r, end: i, value: c }) => `${n}:${r}:${i}:${c}`
    )
  );
  return e.evidence.length + t.size;
}
function q(e) {
  var t, n;
  return ((t = e.result) == null ? void 0 : t.type) === "intent" && e.result.intent === "RememberName" ? "memory-write" : ((n = e.result) == null ? void 0 : n.type) === "statement" ? "knowledge-write" : e.sideEffect;
}
function te(e, t) {
  const n = q(e) === e.sideEffect ? 0 : 1, r = q(t) === t.sideEffect ? 0 : 1;
  return n - r || t.confidence - e.confidence || Qe(t) - Qe(e) || e.missingSlots.length - t.missingSlots.length || m.producerTieBreak[e.producer] - m.producerTieBreak[t.producer] || e.id.localeCompare(t.id);
}
function Ws(e, t) {
  const n = /* @__PURE__ */ new Map(), r = [...t].sort(te);
  for (const i of r) {
    const c = Fs(e, i), s = n.get(c);
    s === void 0 ? n.set(c, [i]) : s.push(i);
  }
  return Object.freeze(
    [...n.entries()].map(([i, c]) => {
      const s = Object.freeze(
        [...c].sort(te)
      );
      return Object.freeze({
        key: i,
        representative: s[0],
        supporters: s
      });
    }).sort(
      (i, c) => te(
        i.representative,
        c.representative
      )
    )
  );
}
function Vs(e, t) {
  if (q(e) !== "none")
    return t.sideEffectAcceptThreshold;
  const n = e.result;
  return (n == null ? void 0 : n.type) === "intent" && on.has(n.intent) ? t.passiveIntentAcceptThreshold : (n == null ? void 0 : n.type) === "query" || (n == null ? void 0 : n.type) === "intent" && (n.intent === "Identity" || n.intent === "RecallName") ? t.queryAcceptThreshold : t.partialCandidateThreshold;
}
function it(e) {
  var t;
  return ((t = e.result) == null ? void 0 : t.type) === "statement" && e.result.negated;
}
function Gs(e) {
  var n;
  if (((n = e.result) == null ? void 0 : n.type) !== "intent" || e.result.intent !== "RememberName")
    return !1;
  const t = e.result.entities[0];
  return t === void 0 ? !1 : e.entities.some(
    (r) => r.kind === "person-name" && Q(r.value) === Q(t)
  );
}
function Ys(e) {
  const t = e.result;
  return (t == null ? void 0 : t.type) === "statement" && t.subject.trim().length > 0 && t.relation.trim().length > 0 && t.object.trim().length > 0;
}
function Hs(e, t) {
  const n = /* @__PURE__ */ new Set([
    "legacy-regex",
    "relation-pattern",
    "entity-pattern",
    "teaching-cue"
  ]);
  return e.evidence.some(({ kind: i }) => n.has(i)) ? !0 : !(e.evidence.length > 0 && e.evidence.every(
    ({ kind: i, value: c }) => i === "lexicon-alias" && ((c == null ? void 0 : c.length) ?? 0) <= t.weakAliasMaximumLength
  )) && Qe(e) >= t.minimumSideEffectEvidenceUnits;
}
function fn(e, t, n) {
  var s;
  const r = q(e);
  if (r === "none")
    return Object.freeze({
      safe: !0,
      requiredEvidence: Object.freeze([]),
      reasonCodes: Object.freeze([])
    });
  const i = [], c = [];
  return (e.missingSlots.length > 0 || e.result === null) && (i.push("complete-slots"), c.push("missing-required-slot")), e.confidence < n.sideEffectAcceptThreshold && (i.push("confidence-threshold"), c.push("insufficient-confidence")), n.negationPolicy.rejectNegatedSideEffects && it(e) && (i.push("non-negated-assertion"), c.push("negation-conflict")), ((s = e.result) == null ? void 0 : s.type) === "statement" && t.extraction.questionCues.length > 0 && (i.push("non-question-assertion"), c.push("side-effect-evidence-insufficient")), r === "memory-write" && !Gs(e) && (i.push("explicit-name"), c.push("side-effect-evidence-insufficient")), r === "knowledge-write" && !Ys(e) && (i.push("complete-triple"), c.push("side-effect-evidence-insufficient")), Hs(e, n) || (i.push("strong-non-alias-evidence"), c.push("side-effect-evidence-insufficient")), Object.freeze({
    safe: i.length === 0,
    requiredEvidence: ln(i),
    reasonCodes: U(c)
  });
}
function Qs(e) {
  return e.result !== null && e.result.type !== "unknown" && e.missingSlots.length === 0;
}
function Js(e, t, n) {
  return it(e) && !n.negationPolicy.preserveNegatedCandidate ? !1 : Qs(e) && e.confidence >= Vs(e, n) && fn(e, t, n).safe;
}
function Xs(e, t) {
  const n = e.candidates.filter(
    (r) => Js(r, e, t)
  );
  return Ws(e, n);
}
function kt(e) {
  var t;
  return ((t = e.result) == null ? void 0 : t.type) === "intent" ? e.result.intent : null;
}
function zt(e, t) {
  const n = kt(e), r = kt(t);
  if (n === null || r === null)
    return !1;
  const i = [n, r].sort().join("+");
  return qs.has(i);
}
function dn(e) {
  const t = e.result;
  return (t == null ? void 0 : t.type) === "query" || (t == null ? void 0 : t.type) === "intent" && (t.intent === "Identity" || t.intent === "RecallName");
}
function Zs(e) {
  var t;
  return q(e) !== "none" ? "high" : dn(e) ? "low" : ((t = e.result) == null ? void 0 : t.type) === "intent" && on.has(e.result.intent) ? "none" : "medium";
}
function Ke(e, t) {
  return Object.freeze(
    e.slice(0, t.maximumAlternatives).map(({ representative: n }) => n)
  );
}
function ea(e) {
  return e.concepts.some(({ id: t }) => t === "remember-name") ? "uncertain-name" : e.concepts.some(({ id: t }) => t === "teaching") && e.missingSlots.length > 1 ? "uncertain-teaching" : e.missingSlots.includes("relation") ? "missing-relation" : e.missingSlots.includes("subject") ? "missing-subject" : e.missingSlots.includes("object") ? "missing-object" : "ambiguous-intent";
}
function ta(e) {
  return e.result === null && e.concepts.some(({ id: t }) => t === "teaching");
}
function na(e, t) {
  if (t.missingSlotPolicy.partialDecision !== "clarify")
    return null;
  const n = e.candidates.filter(
    (i) => i.result === null || i.missingSlots.length > 0
  ).filter(
    (i) => q(i) === "none" && (i.confidence >= t.partialCandidateThreshold || t.missingSlotPolicy.clarifyExplicitTeaching && ta(i))
  ).sort(te), r = n[0];
  return r === void 0 ? null : Object.freeze({
    kind: "clarify",
    candidateOptions: Object.freeze(
      n.slice(0, t.maximumAlternatives)
    ),
    missingSlots: Object.freeze([...r.missingSlots]),
    clarificationKind: ea(r),
    reasonCodes: U([
      "partial-candidate",
      "missing-required-slot",
      ...r.confidence < t.partialCandidateThreshold ? ["insufficient-confidence"] : []
    ])
  });
}
function ra(e, t) {
  const r = e.candidates.filter((i) => q(i) !== "none").filter(
    (i) => !it(i) || t.negationPolicy.preserveNegatedCandidate
  ).map(
    (i) => Object.freeze({
      candidate: i,
      assessment: fn(i, e, t)
    })
  ).filter(({ assessment: i }) => !i.safe).sort(
    (i, c) => te(i.candidate, c.candidate)
  )[0];
  return r === void 0 ? null : Object.freeze({
    kind: "reject-side-effect",
    rejectedCandidate: r.candidate,
    requiredEvidence: r.assessment.requiredEvidence,
    reasonCodes: r.assessment.reasonCodes
  });
}
function ia(e) {
  return Object.freeze({
    count: e.diagnostics.length,
    codes: Object.freeze(
      [...new Set(e.diagnostics.map(({ code: t }) => t))].sort()
    )
  });
}
function ca(e, t = Ps) {
  const n = Xs(e, t), r = n.filter(
    ({ representative: g }) => dn(g)
  );
  if (e.extraction.questionCues.length >= 2 && r.length >= 2)
    return Object.freeze({
      kind: "clarify",
      candidateOptions: Ke(r, t),
      missingSlots: Object.freeze([]),
      clarificationKind: "ambiguous-intent",
      reasonCodes: U([
        "compound-query",
        "conflicting-candidates"
      ])
    });
  const i = n[0];
  if (i === void 0) {
    const g = na(e, t);
    if (g !== null)
      return g;
    const b = ra(
      e,
      t
    );
    if (b !== null)
      return b;
    const w = e.candidates.some(
      (R) => R.result !== null && R.result.type !== "unknown"
    );
    return Object.freeze({
      kind: "no-understanding",
      diagnosticsSummary: ia(e),
      reasonCodes: U([
        ...w ? ["insufficient-confidence"] : [],
        "no-viable-candidate"
      ])
    });
  }
  const c = i.representative, s = n.slice(1).filter(
    ({ representative: g }) => zt(c, g)
  ), a = n.slice(1).filter(
    ({ representative: g }) => !zt(c, g)
  ), o = a[0];
  if (o !== void 0 && c.confidence - o.representative.confidence < t.minimumCandidateMargin)
    return q(c) !== "none" ? Object.freeze({
      kind: "reject-side-effect",
      rejectedCandidate: c,
      requiredEvidence: ln(["candidate-margin"]),
      reasonCodes: U([
        "insufficient-margin",
        "conflicting-candidates"
      ])
    }) : Object.freeze({
      kind: "clarify",
      candidateOptions: Ke(
        [i, o],
        t
      ),
      missingSlots: Object.freeze([]),
      clarificationKind: "conflicting-candidates",
      reasonCodes: U([
        "insufficient-margin",
        "conflicting-candidates"
      ])
    });
  const d = Object.freeze(
    s.slice(0, t.maximumAlternatives).map(({ representative: g }) => g)
  ), l = Ke(
    a,
    t
  );
  return Object.freeze({
    kind: "accept",
    selectedCandidate: c,
    secondaryCandidates: d,
    confidence: v(c.confidence),
    reasonCodes: U([
      "threshold-met",
      ...i.supporters.length > 1 ? ["corroborated-producers"] : [],
      ...d.length > 0 ? ["compatible-secondary-candidate"] : []
    ]),
    alternatives: l,
    riskLevel: Zs(c)
  });
}
const sa = {
  identity: j.Is,
  capability: j.Can,
  creator: Nt
};
function aa(e) {
  return e === "identity" || e === "capability" || e === "creator";
}
const oa = /* @__PURE__ */ new Set([
  "属于",
  "是",
  "会",
  "喜欢",
  "在",
  "有",
  "意思是",
  "开发者",
  "none",
  "unknown"
]);
function Me(e) {
  return e === void 0 || e.length === 0 ? "none" : oa.has(
    e
  ) ? e : "unknown";
}
function ua() {
  var e;
  try {
    const t = (e = globalThis.performance) == null ? void 0 : e.now();
    return typeof t == "number" && Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}
function ge(e, t) {
  return e === null || t === null || !Number.isFinite(e) || !Number.isFinite(t) || t < e ? null : t - e;
}
function la(e) {
  switch (e.kind) {
    case "accept":
      return [
        e.selectedCandidate,
        ...e.secondaryCandidates
      ];
    case "clarify":
      return e.candidateOptions;
    case "reject-side-effect":
      return [e.rejectedCandidate];
    case "no-understanding":
      return [];
  }
}
function fa(e) {
  switch (e) {
    case "missing-subject":
      return "missing-subject";
    case "missing-relation":
      return "missing-relation";
    case "missing-object":
      return "missing-object";
    case "ambiguous-intent":
      return "ambiguous-intent";
    case "conflicting-candidates":
      return "conflicting-candidates";
    case "uncertain-name":
    case "uncertain-teaching":
      return "insufficient-evidence";
    case "none":
      return "unclassified";
  }
}
function da(e) {
  return {
    startedAt: e,
    resultCategory: "safe-fallback",
    reasonCategory: "unclassified",
    relationCategory: "none",
    semanticAdopted: !1,
    legacyFallback: !1,
    contextUsed: !1,
    clarificationKind: "none",
    reasonerPathLength: 0,
    semanticDurationMs: null,
    reasonerDurationMs: null,
    queriedRelation: "none",
    alternativeKnownRelation: "none",
    alignmentResult: "unavailable",
    classificationLocked: !1
  };
}
function ma(e, t) {
  const [n = V, r] = e.entities, i = aa(r) ? r : "identity", c = sa[i], s = t.match({ subject: n, relation: c });
  return { kind: "identity", aspect: i, subject: n, facts: s, raw: e.raw };
}
function ga(e, t) {
  const [n] = e.entities, r = t.remember(ne.Name, n ?? "");
  return { kind: "remembered", key: r.key, value: r.value, raw: e.raw };
}
function ba(e, t) {
  const n = t.recall(ne.Name);
  return { kind: "recalled", key: ne.Name, value: (n == null ? void 0 : n.value) ?? null, raw: e.raw };
}
function ha(e, t, n) {
  switch (e.intent) {
    case "Greeting":
      return { kind: "greeting", raw: e.raw };
    case "Thanks":
      return { kind: "thanks", raw: e.raw };
    case "Farewell":
      return { kind: "farewell", raw: e.raw };
    case "Identity":
      return ma(e, t);
    case "RememberName":
      return ga(e, n);
    case "RecallName":
      return ba(e, n);
    default: {
      const r = e.intent;
      throw new Error(`createSunlandEngine: unhandled intent "${String(r)}"`);
    }
  }
}
function Ea(e = {}) {
  var ct, st, at, ot;
  const t = e.knowledgeStore ?? In(), n = e.memory ?? xn(), r = mi(e.personalityId), i = e.parser ?? Lt(), c = e.storage, s = e.semanticMode ?? "passive", a = e.semanticContextMode ?? "off", o = e.semanticDebug === !0, d = ((ct = e.semanticRuntime) == null ? void 0 : ct.analyze) ?? bs, l = ((st = e.semanticRuntime) == null ? void 0 : st.plan) ?? ca, g = ((at = e.observationRuntime) == null ? void 0 : at.now) ?? ua, b = ((ot = e.observationRuntime) == null ? void 0 : ot.finalizeSummary) ?? ((f) => f);
  let w = null;
  const R = zn(), S = c ? `${c.key}::memory` : void 0;
  c && Cn(t, c.adapter, c.key), S && c && An(n, c.adapter, S), e.seedDemoData === !0 && t.all().length === 0 && Sn(t);
  function B() {
    c && wn(t, c.adapter, c.key);
  }
  function ae() {
    c && S && vn(n, c.adapter, S);
  }
  function A() {
    try {
      const f = g();
      return typeof f == "number" && Number.isFinite(f) ? f : null;
    } catch {
      return null;
    }
  }
  function Ce(f, p) {
    if ((f.type === "query" || f.type === "statement") && (p.relationCategory = Me(
      f.relation
    )), f.type === "query" && (p.queriedRelation = Me(
      f.relation
    )), !p.classificationLocked) {
      if (f.type === "unknown") {
        p.resultCategory = "no-understanding", p.reasonCategory = "unknown-safe-fallback";
        return;
      }
      p.resultCategory = "understood", p.reasonCategory = p.semanticAdopted ? "complete-passive-understanding" : "unclassified";
    }
  }
  function Re(f, p, u) {
    if (f.semanticAdopted = s === "passive" && u.kind !== "fallback-legacy", f.legacyFallback = s === "shadow" || u.kind === "fallback-legacy", f.contextUsed = u.kind !== "fallback-legacy" && la(p).some(
      ({ producer: T }) => T === "context"
    ), u.kind === "clarification") {
      f.clarificationKind = u.context.clarificationKind, u.context.clarificationKind === "missing-subject" && f.contextUsed ? (f.resultCategory = "context-unresolved", f.reasonCategory = "unresolved-context") : (f.resultCategory = "clarification", f.reasonCategory = fa(
        u.context.clarificationKind
      )), f.classificationLocked = !0;
      return;
    }
    u.kind === "no-understanding" && (u.failure.reason.startsWith(
      "legacy-side-effect-blocked:"
    ) || u.failure.reason.startsWith(
      "legacy-side-effect-rejected:"
    ) || u.failure.reason === "semantic-side-effect-rejected" ? (f.resultCategory = "side-effect-blocked", f.reasonCategory = "blocked-side-effect") : (f.resultCategory = "no-understanding", f.reasonCategory = "unknown-safe-fallback"), f.classificationLocked = !0);
  }
  function oe(f, p, u) {
    if (u.relationCategory = Me(
      f.relation
    ), u.queriedRelation = u.relationCategory, p.length === 0) {
      u.reasonerPathLength = 0, u.classificationLocked || (u.resultCategory = "missing-knowledge", u.reasonCategory = "missing-knowledge"), u.alignmentResult = "unavailable";
      return;
    }
    u.reasonerPathLength = p.reduce(
      (T, _) => Math.max(T, Math.max(1, _.path.length - 1)),
      1
    ), u.alignmentResult = "aligned";
  }
  function x(f, p) {
    switch (p !== void 0 && Ce(f, p), f.type) {
      case "statement": {
        const u = t.add(
          { subject: f.subject, relation: f.relation, object: f.object, negated: f.negated },
          { source: "user" }
        );
        return B(), r.respond({ kind: "learned", record: u });
      }
      case "query": {
        const u = f.subject.trim().toLocaleLowerCase("und") === V.toLocaleLowerCase("und") ? R : t, T = p === void 0 ? null : A(), _ = zi.answer(f, u);
        p !== void 0 && (p.reasonerDurationMs = ge(
          T,
          A()
        ), oe(
          f,
          _.answers,
          p
        ));
        const ue = ht.plan(_);
        return r.respond({ kind: "reasoning-result", result: _, plan: ue });
      }
      case "intent": {
        const u = ha(f, R, n);
        return f.intent === "RememberName" && ae(), r.respond(u);
      }
      case "unknown":
        return r.respond({ kind: "unknown-input", failure: f });
      default: {
        const u = f;
        throw new Error(`createSunlandEngine: unhandled parse result ${JSON.stringify(u)}`);
      }
    }
  }
  function ke(f) {
    const p = ht.planClarification(f);
    return r.respond({ kind: "clarification", plan: p });
  }
  function k(f, p = {}) {
    const u = p.observationMode === "summary" ? da(A()) : void 0, T = J(a === "enabled" ? p.semanticContext : p.semanticContext ?? Yt()), _ = () => Object.freeze({
      kind: "none",
      baseVersion: T.version
    }), ue = (C) => {
      if (u === void 0) return C;
      try {
        let ee = null;
        try {
          const Ne = t.all().length;
          ee = Number.isSafeInteger(Ne) && Ne >= 0 ? Ne : null;
        } catch {
          ee = null;
        }
        const Ie = {
          resultCategory: u.resultCategory,
          reasonCategory: u.reasonCategory,
          relationCategory: u.relationCategory,
          semanticAdopted: u.semanticAdopted,
          legacyFallback: u.legacyFallback,
          contextUsed: u.contextUsed,
          clarificationKind: u.clarificationKind,
          reasonerPathLength: u.reasonerPathLength,
          knowledgeCount: ee,
          totalDurationMs: ge(
            u.startedAt,
            A()
          ),
          semanticDurationMs: u.semanticDurationMs,
          reasonerDurationMs: u.reasonerDurationMs,
          queriedRelation: u.queriedRelation,
          alternativeKnownRelation: u.alternativeKnownRelation,
          alignmentResult: u.alignmentResult
        }, W = Bi(Ie), le = Wi(
          b(W)
        );
        return le === null ? C : Object.freeze({
          response: C.response,
          semanticContextUpdate: C.semanticContextUpdate,
          observationSummary: le
        });
      } catch {
        return C;
      }
    }, Z = (C) => ue(
      Object.freeze({
        response: C,
        semanticContextUpdate: _()
      })
    ), ut = (C, ee, Ie) => {
      let W = a === "enabled";
      if (W && p.canCommitSemanticContext !== void 0)
        try {
          W = p.canCommitSemanticContext();
        } catch {
          W = !1;
        }
      const le = s === "passive" ? kc({
        context: T,
        decision: ee,
        executedResult: Ie,
        turnId: p.turnId ?? `turn-${T.version + 1}`,
        canCommit: W
      }) : _();
      return ue(
        Object.freeze({ response: C, semanticContextUpdate: le })
      );
    }, K = i.parse(f);
    if (w = null, s === "off")
      return u !== void 0 && (u.legacyFallback = !0), Z(
        x(K, u)
      );
    let ze, F, I;
    const lt = u === void 0 ? null : A();
    try {
      ze = d(
        f,
        a === "enabled" ? T : void 0
      ), F = l(
        ze,
        e.understandingPolicy
      ), I = vs(
        F,
        K,
        ze
      ), u !== void 0 && (u.semanticDurationMs = ge(
        lt,
        A()
      ), Re(
        u,
        F,
        I
      )), o && (w = Ks(
        s,
        K,
        F,
        I
      ));
    } catch {
      u !== void 0 && (u.semanticDurationMs = ge(
        lt,
        A()
      ), u.semanticAdopted = !1, u.legacyFallback = !0), o && (w = Ms(
        s,
        K
      ));
      const C = nn(K) ? x({
        type: "unknown",
        raw: K.raw,
        reason: "semantic-side-effect-validation-unavailable"
      }, u) : x(K, u);
      return u !== void 0 && (u.resultCategory = "safe-fallback", u.reasonCategory = "semantic-runtime", u.classificationLocked = !0), Z(C);
    }
    if (s === "shadow")
      return Z(
        x(K, u)
      );
    switch (I.kind) {
      case "adopt":
        return ut(
          x(I.result, u),
          F,
          I.result
        );
      case "clarification":
        return Z(
          ke(I.context)
        );
      case "no-understanding":
        return Z(
          x(I.failure, u)
        );
      case "fallback-legacy":
        return ut(
          x(I.result, u),
          F,
          I.result
        );
      default: {
        const C = I;
        throw new Error(
          `createSunlandEngine: unhandled semantic adaptation ${JSON.stringify(C)}`
        );
      }
    }
  }
  return {
    knowledgeStore: t,
    memory: n,
    semanticMode: s,
    semanticContextMode: a,
    getLastSemanticShadow() {
      return o ? w : null;
    },
    respond(f) {
      return k(f).response;
    },
    process: k
  };
}
function Sa() {
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
  qt as CONTEXT_SCHEMA_VERSION,
  Nt as CREATOR_RELATION,
  fi as DEFAULT_PERSONALITY_ID,
  Li as DURATION_BUCKETS,
  qn as FAREWELL_PHRASES,
  Rn as FROST_SUBJECT,
  Ue as FrostPersonality,
  _n as GREETING_PHRASES,
  It as InMemoryKnowledgeStore,
  $i as KNOWLEDGE_COUNT_BUCKETS,
  Pe as LEGACY_SIDE_EFFECT_LIMITS,
  xi as OBSERVATION_CLARIFICATION_KINDS,
  vi as OBSERVATION_REASON_CATEGORIES,
  Ai as OBSERVATION_RELATION_CATEGORIES,
  Ti as OBSERVATION_RESULT_CATEGORIES,
  Dt as OBSERVATION_SCHEMA_VERSION,
  bt as PlainPersonality,
  _i as REASONER_PATH_BUCKETS,
  Hn as RECALL_NAME_PHRASES,
  Ki as RELATION_ALIGNMENT_RESULTS,
  Rr as RegexParser,
  Pt as SEMANTIC_SCHEMA_VERSION,
  Mt as SUNLAND_CORE_VERSION,
  V as SUNLAND_SUBJECT,
  Mn as THANKS_PHRASES,
  Oa as applySemanticContextUpdate,
  Ae as bucketDuration,
  Ii as bucketKnowledgeCount,
  Ni as bucketReasonerPath,
  xt as countKnownRelationMentions,
  Yt as createEmptySemanticContext,
  Dn as createFarewellIntentMatcher,
  Kn as createGreetingIntentMatcher,
  Yn as createIdentityIntentMatcher,
  ye as createKeywordIntentMatcher,
  In as createKnowledgeStore,
  Er as createLocatePattern,
  Sa as createMemoryStorageAdapter,
  pr as createObjectOfPattern,
  Bi as createObservationSummary,
  Lt as createParser,
  Qn as createRecallNameIntentMatcher,
  fr as createRememberNameIntentMatcher,
  zn as createSelfKnowledgeStore,
  De as createStatementPattern,
  Ea as createSunlandEngine,
  Pn as createThanksIntentMatcher,
  yr as createVerifyPattern,
  Sr as createWhyPattern,
  dr as defaultIntentMatchers,
  Cr as defaultPatterns,
  mi as getPersonality,
  vt as hasChoiceOrSequenceStructure,
  At as hasExplicitSideEffectProhibition,
  rr as hasInternalClauseBoundary,
  ir as hasQuestionStructure,
  Je as hasUnsafeLegacySideEffectStructure,
  ya as listPersonalities,
  Cn as loadKnowledgeStore,
  qe as normalizeCapturedValue,
  br as normalizeInput,
  J as normalizeSemanticContext,
  ja as registerPersonality,
  Wi as sanitizeObservationSummary,
  wn as saveKnowledgeStore,
  Sn as seedKnowledgeStore,
  En as seedTriples,
  kn as selfKnowledgeTriples,
  Tt as stripTrailingDeclarativePunctuation,
  Fi as validateObservationSummary
};
