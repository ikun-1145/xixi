import { describe, expect, it } from "vitest";
import { defaultResponsePlanner } from "./responsePlanner";
import type { Inference, ParsedQuery, ReasoningResult } from "@/types";

function makeQuery(overrides: Partial<ParsedQuery> = {}): ParsedQuery {
  return {
    type: "query",
    subject: "猫",
    relation: "属于",
    kind: "object-of",
    raw: "猫属于什么",
    ...overrides,
  };
}

function makeAnswer(overrides: Partial<Inference> = {}): Inference {
  return {
    conclusion: { subject: "猫", relation: "属于", object: "动物", negated: false },
    confidence: 1,
    steps: [],
    path: ["猫", "动物"],
    ...overrides,
  };
}

function makeResult(overrides: Partial<ReasoningResult> = {}): ReasoningResult {
  return {
    query: makeQuery(),
    answers: [makeAnswer()],
    conflicts: [],
    explanation: "猫 属于 动物",
    ...overrides,
  };
}

describe("defaultResponsePlanner", () => {
  it("has a stable id", () => {
    expect(defaultResponsePlanner.id).toBe("default-v1");
  });

  describe("mode: no-answer", () => {
    it("passes through the Reasoner's neutral explanation when nothing is known", () => {
      const result = makeResult({ answers: [], explanation: "目前还没有已知的相关事实。" });
      const plan = defaultResponsePlanner.plan(result);

      expect(plan.mode).toBe("no-answer");
      expect(plan.showEvidence).toBe(false);
      expect(plan.isUncertain).toBe(false);
      expect(plan.confidence).toBe(0);
      expect(plan.explanation).toBe("目前还没有已知的相关事实。");
    });
  });

  describe("mode: direct (normal answer)", () => {
    it("answers plainly, with no derivation chain, when the query did not ask why", () => {
      const result = makeResult({ query: makeQuery() });
      const plan = defaultResponsePlanner.plan(result);

      expect(plan.mode).toBe("direct");
      expect(plan.showEvidence).toBe(false);
      expect(plan.explanation).toBe("猫 属于 动物");
      expect(plan.explanation).not.toContain("推理路径");
    });

    it("still omits the derivation chain for a multi-hop answer when not asked why", () => {
      const multiHop = makeAnswer({
        conclusion: { subject: "猫", relation: "属于", object: "生物", negated: false },
        steps: [
          {
            ruleId: "isa-transitivity",
            description: "猫 属于 动物，动物 属于 生物 ⇒ 猫 属于 生物",
            premises: [],
            conclusion: { subject: "猫", relation: "属于", object: "生物", negated: false },
          },
        ],
        path: ["猫", "动物", "生物"],
      });
      const result = makeResult({ answers: [multiHop] });
      const plan = defaultResponsePlanner.plan(result);

      expect(plan.mode).toBe("direct");
      expect(plan.explanation).toBe("猫 属于 生物");
      expect(plan.explanation).not.toContain("推理路径");
    });

    it("joins multiple direct answers with '；'", () => {
      const result = makeResult({
        answers: [
          makeAnswer({ conclusion: { subject: "猫", relation: "属于", object: "动物", negated: false } }),
          makeAnswer({ conclusion: { subject: "猫", relation: "属于", object: "哺乳动物", negated: false } }),
        ],
      });
      const plan = defaultResponsePlanner.plan(result);
      expect(plan.explanation).toBe("猫 属于 动物；猫 属于 哺乳动物");
    });

    it("preserves negation in the bare fact", () => {
      const result = makeResult({
        answers: [makeAnswer({ conclusion: { subject: "企鹅", relation: "会", object: "飞", negated: true } })],
      });
      const plan = defaultResponsePlanner.plan(result);
      expect(plan.explanation).toBe("企鹅 不会 飞");
    });
  });

  describe("mode: explained (auto-explain on 'why')", () => {
    it("surfaces the derivation chain (Evidence) when the query explicitly asked why", () => {
      const multiHop = makeAnswer({
        conclusion: { subject: "猫", relation: "属于", object: "生物", negated: false },
        steps: [
          {
            ruleId: "isa-transitivity",
            description: "猫 属于 动物，动物 属于 生物 ⇒ 猫 属于 生物",
            premises: [],
            conclusion: { subject: "猫", relation: "属于", object: "生物", negated: false },
          },
        ],
        path: ["猫", "动物", "生物"],
      });
      const result = makeResult({
        query: makeQuery({ kind: "verify", object: "生物", explain: true }),
        answers: [multiHop],
      });
      const plan = defaultResponsePlanner.plan(result);

      expect(plan.mode).toBe("explained");
      expect(plan.showEvidence).toBe(true);
      expect(plan.explanation).toBe("猫 属于 生物（推理路径：猫 → 动物 → 生物）");
    });

    it("degrades to a bare fact when 'why' was asked but the answer has no derivation (direct fact)", () => {
      const result = makeResult({ query: makeQuery({ kind: "verify", object: "动物", explain: true }) });
      const plan = defaultResponsePlanner.plan(result);

      expect(plan.mode).toBe("explained");
      expect(plan.explanation).toBe("猫 属于 动物");
      expect(plan.explanation).not.toContain("推理路径");
    });
  });

  describe("isUncertain (confidence-based hedging)", () => {
    it("does not flag uncertainty for a full-confidence answer", () => {
      const result = makeResult({ answers: [makeAnswer({ confidence: 1 })] });
      const plan = defaultResponsePlanner.plan(result);
      expect(plan.isUncertain).toBe(false);
      expect(plan.confidence).toBe(1);
    });

    it("flags uncertainty when confidence drops below the threshold", () => {
      const result = makeResult({ answers: [makeAnswer({ confidence: 0.4 })] });
      const plan = defaultResponsePlanner.plan(result);
      expect(plan.isUncertain).toBe(true);
      expect(plan.confidence).toBe(0.4);
    });

    it("uses the LOWEST confidence among multiple answers (one weak link hedges all)", () => {
      const result = makeResult({
        answers: [makeAnswer({ confidence: 1 }), makeAnswer({ confidence: 0.3 })],
      });
      const plan = defaultResponsePlanner.plan(result);
      expect(plan.isUncertain).toBe(true);
      expect(plan.confidence).toBe(0.3);
    });

    it("is independent of mode -- an explained answer can also be uncertain", () => {
      const result = makeResult({
        query: makeQuery({ kind: "verify", object: "动物", explain: true }),
        answers: [makeAnswer({ confidence: 0.2 })],
      });
      const plan = defaultResponsePlanner.plan(result);
      expect(plan.mode).toBe("explained");
      expect(plan.isUncertain).toBe(true);
    });
  });
});
