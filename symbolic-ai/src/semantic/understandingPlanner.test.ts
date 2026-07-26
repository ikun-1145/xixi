import type { IntentName, ParsedIntent } from "@/types";
import { describe, expect, it } from "vitest";
import { analyzeSemanticInput } from "./candidates";
import { planUnderstanding } from "./understandingPlanner";
import {
  createUnderstandingPolicy,
  DEFAULT_UNDERSTANDING_POLICY,
} from "./understandingPolicy";
import {
  createConfidence,
  type SemanticAnalysis,
  type SemanticCandidate,
  type UnderstandingDecision,
} from "./types";

function decisionFor(raw: string): UnderstandingDecision {
  return planUnderstanding(analyzeSemanticInput(raw));
}

function acceptedIntents(
  decision: UnderstandingDecision,
): readonly IntentName[] {
  if (decision.kind !== "accept") {
    return [];
  }

  return [
    decision.selectedCandidate,
    ...decision.secondaryCandidates,
  ]
    .map(({ result }) =>
      result?.type === "intent" ? result.intent : null,
    )
    .filter((intent): intent is IntentName => intent !== null);
}

function analysisWithCandidates(
  analysis: SemanticAnalysis,
  candidates: readonly SemanticCandidate[],
): SemanticAnalysis {
  return Object.freeze({
    ...analysis,
    candidates: Object.freeze([...candidates]),
  });
}

function cloneIntentCandidate(
  source: SemanticCandidate,
  intent: ParsedIntent["intent"],
  confidence: number,
): SemanticCandidate {
  const score = createConfidence(confidence);
  return Object.freeze({
    ...source,
    id: `test:intent:${intent}`,
    producer: "lexicon",
    producerWeight: score,
    result: Object.freeze({
      type: "intent",
      intent,
      entities: Object.freeze([]),
      confidence: score,
      raw: source.result?.raw ?? "",
    }),
    confidence: score,
    concepts: Object.freeze([]),
    entities: Object.freeze([]),
    evidence: Object.freeze([
      Object.freeze({
        kind: "structural",
        key: `test:${intent}`,
        weight: score,
      }),
    ]),
    missingSlots: Object.freeze([]),
    sideEffect: "none",
  });
}

describe("planUnderstanding representative decisions", () => {
  it("accepts a Greeting", () => {
    const decision = decisionFor("你好");

    expect(decision.kind).toBe("accept");
    expect(acceptedIntents(decision)).toContain("Greeting");
    if (decision.kind === "accept") {
      expect(decision.reasonCodes).toContain("threshold-met");
      expect(decision.riskLevel).toBe("none");
    }
  });

  it("accepts compatible Greeting and RememberName candidates together", () => {
    const decision = decisionFor("你好，我叫小明");

    expect(decision.kind).toBe("accept");
    expect(acceptedIntents(decision)).toEqual(
      expect.arrayContaining(["Greeting", "RememberName"]),
    );
    if (decision.kind === "accept") {
      expect(decision.reasonCodes).toContain(
        "compatible-secondary-candidate",
      );
    }
  });

  it.each([
    ["你好，你是谁", ["Greeting", "Identity"]],
    ["谢谢，再见", ["Thanks", "Farewell"]],
  ])(
    "supports the bounded compatible intent pair in %s",
    (raw, expectedIntents) => {
      const decision = decisionFor(raw);

      expect(decision.kind).toBe("accept");
      expect(acceptedIntents(decision)).toEqual(
        expect.arrayContaining(expectedIntents),
      );
    },
  );

  it("accepts an explicit RememberName candidate", () => {
    const decision = decisionFor("我叫小明");

    expect(decision.kind).toBe("accept");
    expect(acceptedIntents(decision)).toContain("RememberName");
    if (decision.kind === "accept") {
      expect(decision.riskLevel).toBe("high");
    }
  });

  it("does not accept RememberName from a negated statement", () => {
    const decision = decisionFor("我不是小明");

    expect(decision.kind).toBe("reject-side-effect");
    if (decision.kind === "reject-side-effect") {
      expect(decision.reasonCodes).toContain("negation-conflict");
      expect(decision.rejectedCandidate.result).toMatchObject({
        type: "statement",
        negated: true,
      });
    }
  });

  it("does not guess an interpretation for a lone name keyword", () => {
    expect(decisionFor("名字").kind).toBe("no-understanding");
  });

  it("accepts RecallName as a non-writing query-like intent", () => {
    const decision = decisionFor("你记得我的名字吗");

    expect(decision.kind).toBe("accept");
    expect(acceptedIntents(decision)).toContain("RecallName");
  });

  it("accepts a complete teaching statement", () => {
    const decision = decisionFor("猫是一种动物");

    expect(decision.kind).toBe("accept");
    if (decision.kind === "accept") {
      expect(decision.selectedCandidate.result).toMatchObject({
        type: "statement",
        subject: "猫",
        relation: "属于",
        object: "动物",
      });
      expect(decision.selectedCandidate.sideEffect).toBe(
        "knowledge-write",
      );
    }
  });

  it("clarifies an incomplete statement instead of allowing a write", () => {
    const decision = decisionFor("猫是");

    expect(decision).toMatchObject({
      kind: "clarify",
      clarificationKind: "missing-object",
      missingSlots: ["object"],
    });
  });

  it("clarifies explicit teaching with an incomplete triple", () => {
    const decision = decisionFor("教你一个事实");

    expect(decision).toMatchObject({
      kind: "clarify",
      clarificationKind: "uncertain-teaching",
      missingSlots: ["subject", "relation", "object"],
    });
  });

  it("preserves a negated statement while rejecting positive write execution", () => {
    const decision = decisionFor("猫不是狗");

    expect(decision.kind).toBe("reject-side-effect");
    if (decision.kind === "reject-side-effect") {
      expect(decision.rejectedCandidate.result).toMatchObject({
        type: "statement",
        subject: "猫",
        object: "狗",
        negated: true,
      });
      expect(decision.requiredEvidence).toContain(
        "non-negated-assertion",
      );
    }
  });

  it("plans an object clarification for a weak partial relation", () => {
    const decision = decisionFor("你会吗");

    expect(decision).toMatchObject({
      kind: "clarify",
      clarificationKind: "missing-object",
      missingSlots: ["object"],
    });
  });

  it("does not silently select the first interpretation of a compound query", () => {
    const decision = decisionFor("你叫什么和你会什么");

    expect(decision.kind).toBe("clarify");
    if (decision.kind === "clarify") {
      expect(decision.candidateOptions.length).toBeGreaterThanOrEqual(2);
      expect(decision.reasonCodes).toEqual(
        expect.arrayContaining([
          "compound-query",
          "conflicting-candidates",
        ]),
      );
    }
  });

  it("returns no-understanding for unrelated input", () => {
    expect(decisionFor("完全未知的表达 🐾").kind).toBe(
      "no-understanding",
    );
  });
});

describe("thresholds and candidate comparison", () => {
  it("applies separate passive, query, side-effect and partial thresholds", () => {
    expect(
      planUnderstanding(
        analyzeSemanticInput("你好"),
        createUnderstandingPolicy({
          passiveIntentAcceptThreshold: 1,
        }),
      ).kind,
    ).toBe("no-understanding");

    expect(
      planUnderstanding(
        analyzeSemanticInput("猫会什么"),
        createUnderstandingPolicy({ queryAcceptThreshold: 1 }),
      ).kind,
    ).toBe("no-understanding");

    expect(
      planUnderstanding(
        analyzeSemanticInput("我叫小明"),
        createUnderstandingPolicy({
          sideEffectAcceptThreshold: 0.99,
        }),
      ).kind,
    ).toBe("reject-side-effect");

    expect(
      planUnderstanding(
        analyzeSemanticInput("猫是"),
        createUnderstandingPolicy({
          partialCandidateThreshold: 0.99,
        }),
      ).kind,
    ).toBe("no-understanding");
  });

  it("uses candidate margin to clarify close conflicting candidates", () => {
    const analysis = analyzeSemanticInput("你好");
    const greeting = analysis.candidates.find(
      ({ result }) =>
        result?.type === "intent" && result.intent === "Greeting",
    )!;
    const first = cloneIntentCandidate(greeting, "Greeting", 0.86);
    const second = cloneIntentCandidate(greeting, "Thanks", 0.82);
    const closeAnalysis = analysisWithCandidates(analysis, [
      first,
      second,
    ]);

    expect(planUnderstanding(closeAnalysis)).toMatchObject({
      kind: "clarify",
      clarificationKind: "conflicting-candidates",
    });
    expect(
      planUnderstanding(
        closeAnalysis,
        createUnderstandingPolicy({ minimumCandidateMargin: 0.03 }),
      ).kind,
    ).toBe("accept");
  });

  it("is stable when candidate input order changes", () => {
    const analysis = analyzeSemanticInput("你好，我叫小明");
    const reversed = analysisWithCandidates(
      analysis,
      [...analysis.candidates].reverse(),
    );

    expect(planUnderstanding(reversed)).toEqual(
      planUnderstanding(analysis),
    );
  });

  it("produces the same default behavior through an explicit default policy", () => {
    const analysis = analyzeSemanticInput("猫会什么");

    expect(planUnderstanding(analysis)).toEqual(
      planUnderstanding(
        analysis,
        createUnderstandingPolicy(),
      ),
    );
    expect(DEFAULT_UNDERSTANDING_POLICY).toBeDefined();
  });

  it("allows the negation policy to omit rejected negated candidates", () => {
    const decision = planUnderstanding(
      analyzeSemanticInput("猫不是狗"),
      createUnderstandingPolicy({
        negationPolicy: {
          preserveNegatedCandidate: false,
        },
      }),
    );

    expect(decision.kind).toBe("no-understanding");
  });
});

describe("side-effect safety", () => {
  it("rejects a high-confidence write candidate backed only by a weak alias", () => {
    const analysis = analyzeSemanticInput("我叫小明");
    const source = analysis.candidates.find(
      ({ result }) =>
        result?.type === "intent" &&
        result.intent === "RememberName",
    )!;
    const score = createConfidence(0.95);
    const weak = Object.freeze({
      ...source,
      id: "test:weak-name-write",
      producer: "lexicon" as const,
      confidence: score,
      producerWeight: score,
      entities: Object.freeze([]),
      evidence: Object.freeze([
        Object.freeze({
          kind: "lexicon-alias" as const,
          key: "remember-name",
          value: "叫",
          weight: score,
        }),
      ]),
    });
    const decision = planUnderstanding(
      analysisWithCandidates(analysis, [weak]),
    );

    expect(decision.kind).toBe("reject-side-effect");
    if (decision.kind === "reject-side-effect") {
      expect(decision.requiredEvidence).toEqual(
        expect.arrayContaining([
          "explicit-name",
          "strong-non-alias-evidence",
        ]),
      );
    }
  });

  it("rejects side effects with required slots missing", () => {
    const analysis = analyzeSemanticInput("猫是");
    const partial = analysis.candidates.find(
      ({ result }) => result === null,
    )!;
    const unsafe = Object.freeze({
      ...partial,
      id: "test:partial-write",
      sideEffect: "knowledge-write" as const,
      confidence: createConfidence(0.95),
    });
    const decision = planUnderstanding(
      analysisWithCandidates(analysis, [unsafe]),
    );

    expect(decision.kind).toBe("reject-side-effect");
    if (decision.kind === "reject-side-effect") {
      expect(decision.requiredEvidence).toContain("complete-slots");
      expect(decision.reasonCodes).toContain("missing-required-slot");
    }
  });
});

describe("decision output safety", () => {
  it("summarizes diagnostics by code without copying diagnostic messages", () => {
    const analysis = analyzeSemanticInput("完全未知的表达 🐾");
    const decision = planUnderstanding(analysis);
    const serialized = JSON.stringify(decision);

    expect(decision.kind).toBe("no-understanding");
    expect(serialized).not.toContain(
      analysis.diagnostics[0]?.message ?? "__no_message__",
    );
    if (decision.kind === "no-understanding") {
      expect(Object.keys(decision.diagnosticsSummary).sort()).toEqual([
        "codes",
        "count",
      ]);
    }
  });
});
