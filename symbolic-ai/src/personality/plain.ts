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
      case "clarification":
        if (
          context.plan.focus === "subject" &&
          (context.plan.contextLabels?.length ?? 0) >= 2
        ) {
          const labels = context.plan.contextLabels ?? [];
          const alternatives = [
            labels.slice(0, -1).join("、"),
            labels.at(-1),
          ].join("还是");
          return `你指的是${alternatives}？请再说明一下。`;
        }
        if (context.plan.focus === "object" && context.plan.relation === "会") {
          return "你想问会做什么？请再具体一点。";
        }
        if (context.plan.focus === "object") {
          return "缺少要说明的内容，请补充完整。";
        }
        if (context.plan.focus === "subject") {
          return "缺少要询问的对象，请补充完整。";
        }
        if (context.plan.focus === "relation") {
          return "缺少要询问的方面，请补充完整。";
        }
        if (context.plan.focus === "name") {
          return "请说明你是在询问名字，还是提供名字。";
        }
        return "这句话有多种可能的意思，请换一种更具体的说法。";
      case "learned": {
        const negation = context.record.negated ? "不" : "";
        return `已记录：${context.record.subject} ${negation}${context.record.relation} ${context.record.object}`;
      }
      case "unknown-input":
        return context.failure.raw.trim()
          ? "这个问题我暂时还没理解清楚。你可以换一种说法，或者再告诉我一点相关信息。"
          : "好像还没有输入内容呢，可以跟我说点什么。";
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
        return "暂时无法完成这次请求，请稍后再试。";
      default: {
        const exhaustiveCheck: never = context;
        throw new Error(`Plain: unhandled response context ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  },
};
