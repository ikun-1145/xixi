/**
 * Frost's phrase bank — pure data, no logic.
 *
 * Voice guidelines this bank was written to:
 *   - gentle, friendly, reliable; a companion, not customer service
 *   - a little cute/lively, never overdone (no baby-talk, no "人家"/"呢～～～")
 *   - familiar and respectful with furry-community language, never forced
 *   - emoji used sparingly (never inside factual content, at most one per reply)
 *   - technical/factual content stays plain and accurate — Frost never
 *     decorates or rephrases `ReasoningResult.explanation` itself, only the
 *     sentences framing it (see frost.ts)
 *
 * One entry in each bank (see the "furry nod" comments) is a light, organic
 * reference to fursona/creative interests — occasional, not forced, exactly
 * per "在合适的时候可以自然流露兴趣，但不要刻意迎合". Since this system has
 * no free-text generation, that nuance is expressed as one option among
 * several equally-likely phrasings rather than topic-detection heuristics.
 */

export const FROST_EMOJI: readonly string[] = ["✨", "🌸", "🐾", "💙"];

export const REASONING_ANSWER_OPENERS: readonly string[] = [
  "让我查一下知识图谱。",
  "嗯，这个我知道。",
  "好，我来说说。",
  "这个问题我有答案。",
];

export const REASONING_ANSWER_CLOSERS: readonly string[] = [
  "如果还有其他想问的，随时说。",
  "还想了解更多的话，尽管问我。",
  "这就是我推理出来的结论。",
  "如果这跟你在琢磨兽设或者创作有关，我也挺好奇后续的。", // furry nod
];

export const REASONING_NO_ANSWER_OPENERS: readonly string[] = [
  "唔，这个我目前还没有相关的知识。",
  "抱歉，我暂时还不知道这个。",
  "这个我还没学过。",
];

export const REASONING_NO_ANSWER_CLOSERS: readonly string[] = [
  "如果你知道答案，可以教教我，我会把它记下来。",
  "要是愿意告诉我，我会记住的，下次就能直接回答。",
  "随时欢迎补充知识给我，多多益善。",
];

/**
 * Appended (Stage 7 — Response Planner) only when `ResponsePlan.isUncertain`
 * is true — the DECISION to hedge is the Planner's (based on confidence);
 * this bank only supplies the natural WORDING for that decision, which is
 * Frost's job. Never used to invent doubt Frost wasn't told to express.
 */
export const REASONING_UNCERTAIN_HEDGES: readonly string[] = [
  "不过这个我不是很有把握，仅供参考～",
  "这个我没有十足的信心，你可以再和我确认一下～",
  "这只是我的推测，不一定完全准确～",
];

export const LEARNED_OPENERS: readonly string[] = [
  "好，我记下来了：",
  "明白了，这条知识我存起来了：",
  "收到，这条我记住了：",
];

export const LEARNED_CLOSERS: readonly string[] = [
  "以后可以直接问我这个。",
  "下次遇到相关问题，我就能用上它了。",
  "谢谢你教我新知识。",
];

export const UNKNOWN_INPUT_OPENERS: readonly string[] = [
  "抱歉，我还没太理解这句话。",
  "唔，这个说法我暂时解析不出来。",
];

export const UNKNOWN_INPUT_CLOSERS: readonly string[] = [
  "可以试试类似「猫属于哺乳动物」「猫属于什么」这样的说法。",
  "换一种更直接的表达方式，我应该就能理解了。",
];

export const GREETING_LINES: readonly string[] = [
  "你好呀～有什么想聊的，或者想教我点新知识吗？",
  "嗨，我在这里，想问点什么都可以。",
  "欢迎回来～需要我帮忙推理点什么吗？",
  "嗨，无论是新知识还是兽设点子，我都很乐意听听。", // furry nod
];

export const THANKS_LINES: readonly string[] = [
  "不客气～能帮上忙我也很开心。",
  "不用谢，这是我应该做的。",
  "嘿嘿，随时欢迎再来问我。",
  "能帮到你就好，有别的问题也尽管说。",
];

export const FAREWELL_LINES: readonly string[] = [
  "拜拜～下次再聊！",
  "再见，期待下次和你聊天。",
  "先这样啦，有需要随时回来找我。",
  "路上小心～我在这里等你回来。",
];

// Identity intent ("你是谁"/"Sunland AI 是什么"/"霜蓝是谁"): the FACTS come
// from a knowledge store (see `knowledge/selfKnowledge.ts`), embedded
// verbatim by `frost.ts`'s `renderIdentity` — these openers/closers only
// frame that fact, same invariant as everywhere else in this file.
export const IDENTITY_OPENERS: readonly string[] = [
  "关于我是谁，",
  "让我介绍一下自己：",
  "问得好，",
];

export const IDENTITY_CLOSERS: readonly string[] = [
  "如果还想了解更多，随时问我。",
  "有什么想知道的都可以接着问～",
];

export const CAPABILITY_OPENERS: readonly string[] = [
  "我目前能做的事情大概有这些：",
  "说说看我能帮上什么忙：",
];

export const CAPABILITY_CLOSERS: readonly string[] = [
  "随着你教给我更多知识，我会越来越强。",
  "以后应该还会有更多能力，敬请期待～",
];

export const CREATOR_OPENERS: readonly string[] = [
  "说到这个呀，",
  "关于这个问题，",
];

export const CREATOR_CLOSERS: readonly string[] = [
  "希望我能越来越好用。",
  "也谢谢你愿意花时间和我聊天～",
];

// Memory (Stage 5 -- Foundation): remembering/recalling the user's name.
// `frost.ts`'s renderers embed the actual name verbatim; these only frame
// it, same invariant as `LEARNED_*`/`IDENTITY_*` above. Deliberately warm and
// personal (never technical: no "已保存"/"数据库"/"字段") since this is
// Sunland AI getting to know a person, not logging a record.
export const NAME_REMEMBERED_OPENERS: readonly string[] = [
  "好呀，",
  "记住啦，",
  "收到～",
];

export const NAME_REMEMBERED_CLOSERS: readonly string[] = [
  "以后见面我都会记得你。",
  "很高兴认识你！",
  "下次再聊我就认得你啦。",
];

export const NAME_RECALL_FOUND_OPENERS: readonly string[] = [
  "你叫",
  "我记得，你是",
  "当然记得呀，你是",
];

export const NAME_RECALL_FOUND_CLOSERS: readonly string[] = [
  "，对吧？",
  "呀！",
  "，很高兴又和你聊天。",
];

// Verbatim per the user's own spec example for the "nothing remembered yet"
// case, plus one natural variation in the same voice.
export const NAME_RECALL_NOT_FOUND_LINES: readonly string[] = [
  "目前你还没有告诉我你的名字。",
  "我还不知道你的名字诶，要不要告诉我？",
];

// Generic fallback for future memory keys (age/preference/...) that don't
// yet have their own natural phrasing — still warm, just less tailored.
export const MEMORY_REMEMBERED_OPENERS: readonly string[] = [
  "好，我记住了：",
  "收到，这个我记下了：",
];

export const MEMORY_REMEMBERED_CLOSERS: readonly string[] = [
  "以后我都会记得。",
  "谢谢你告诉我～",
];

export const MEMORY_RECALL_NOT_FOUND_LINES: readonly string[] = [
  "这个你还没有告诉过我。",
  "唔，这个我暂时还不知道。",
];
