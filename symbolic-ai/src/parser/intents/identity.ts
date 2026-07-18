import type { IdentityAspect, IntentMatch, IntentMatcher } from "@/types";

/**
 * Identity intent: "who/what are you", "what can you do", "who made you".
 *
 * Unlike Greeting/Thanks/Farewell (closed exact-phrase lists), Identity
 * questions have a variable SUBJECT ("你" / "Sunland AI" / "霜蓝") and
 * variable QUESTION FORM ("是谁"/"叫什么"/"能做什么"/"是谁开发的"), so an
 * exact-match `Set` (`createKeywordIntentMatcher`) doesn't fit. Instead this
 * classifies the input along two small, independent, keyword-driven axes
 * instead of writing one rule per full sentence:
 *
 *   1. WHICH self is being asked about -> `entities[0]` (subject)
 *   2. WHAT aspect is being asked      -> `entities[1]` (an `IdentityAspect`)
 *
 * The matcher never decides the ANSWER -- it only recognizes intent +
 * extracts these two entities. The actual facts live in a knowledge store
 * (`knowledge/selfKnowledge.ts`) and are resolved/rendered downstream (see
 * `engine/sunlandEngine.ts`'s `answerIdentity`), per "Parser must not
 * generate replies".
 */

const SUNLAND_SUBJECT = "Sunland AI";
const FROST_SUBJECT = "霜蓝";

/** Which canonical "self" the question refers to, or `null` if it isn't self-referential at all. */
function detectSubject(key: string): string | null {
  if (key.includes("霜蓝") || key.includes("frost")) return FROST_SUBJECT;
  if (key.includes("sunland")) return SUNLAND_SUBJECT;
  if (key.includes("你")) return SUNLAND_SUBJECT; // "你是谁" etc. -- talking to the AI directly
  return null;
}

// Order matters: checked in this order below, most-specific first. A
// "creator" question like "是谁开发了你" contains the substring "是谁", so
// creator must be tried before "identity" or it would be misclassified.
const CREATOR_KEYWORDS = ["谁开发", "谁做的", "谁创造", "谁写的", "开发者"];
const CAPABILITY_KEYWORDS = ["能做什么", "会做什么", "能干什么", "能做啥", "会做啥", "能干嘛", "有什么能力", "擅长什么"];
const IDENTITY_KEYWORDS = ["是谁", "叫什么", "是什么", "你的名字", "名字是"];

function detectAspect(key: string): IdentityAspect | null {
  if (CREATOR_KEYWORDS.some((kw) => key.includes(kw))) return "creator";
  if (CAPABILITY_KEYWORDS.some((kw) => key.includes(kw))) return "capability";
  if (IDENTITY_KEYWORDS.some((kw) => key.includes(kw))) return "identity";
  return null;
}

export function createIdentityIntentMatcher(): IntentMatcher {
  return {
    intent: "Identity",
    match(normalizedInput): IntentMatch | null {
      const key = normalizedInput.toLowerCase();
      const subject = detectSubject(key);
      const aspect = detectAspect(key);
      // Both axes must resolve -- e.g. "你喜欢猫" mentions "你" but has no
      // identity/capability/creator aspect keyword, so it correctly falls
      // through to the ordinary statement/query grammar instead.
      if (subject === null || aspect === null) return null;
      return { entities: [subject, aspect], confidence: 0.9 };
    },
  };
}
