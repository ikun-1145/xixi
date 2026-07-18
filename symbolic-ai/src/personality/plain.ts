/**
 * Plain — an undecorated baseline persona.
 *
 * Not a "real" character; it exists to (a) prove the persona-switching
 * mechanism actually works with more than one entry, and (b) give tests a
 * neutral reference point for asserting that Frost's STYLE differs from a
 * bare rendering while the underlying FACTS stay identical either way
 * (see boundary.test.ts). Useful later as a debug/accessibility mode too.
 */
import type { PersonalityProfile, ResponseContext } from "@/types";

export const PlainPersonality: PersonalityProfile = {
  id: "plain",
  displayName: "Plain（无风格 / 调试用）",
  description: "不做任何语言风格修饰的基线人格，仅用于验证人格切换机制与调试输出。",
  respond(context: ResponseContext): string {
    switch (context.kind) {
      case "reasoning-result":
        // Same underlying decision (`plan.explanation`, `plan.isUncertain`)
        // as Frost, just rendered with zero decoration -- an undecorated
        // marker for uncertainty rather than a natural-language hedge.
        return context.plan.isUncertain ? `${context.plan.explanation}（不确定）` : context.plan.explanation;
      case "learned": {
        const negation = context.record.negated ? "不" : "";
        return `已记录：${context.record.subject} ${negation}${context.record.relation} ${context.record.object}`;
      }
      case "unknown-input":
        return `无法解析："${context.failure.raw}"（${context.failure.reason}）`;
      case "greeting":
        return "你好。";
      case "thanks":
        return "不客气。";
      case "farewell":
        return "再见。";
      case "identity": {
        const [first] = context.facts;
        if (!first) return `未知：关于 ${context.subject}（${context.aspect}）`;
        const negation = first.negated ? "不" : "";
        return `${first.subject} ${negation}${first.relation} ${first.object}`;
      }
      case "remembered":
        return `已记住：${context.key} = ${context.value}`;
      case "recalled":
        return context.value === null ? `未知：${context.key}` : `${context.key} = ${context.value}`;
      case "error":
        return `错误：${context.message}`;
      default: {
        const exhaustiveCheck: never = context;
        throw new Error(`Plain: unhandled response context ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  },
};
