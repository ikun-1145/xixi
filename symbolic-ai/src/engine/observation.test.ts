import { describe, expect, it } from "vitest";
import {
  validateObservationSummary,
  type ObservationSummary,
} from "@/observation";
import { createSunlandEngine } from "./sunlandEngine";

const FORBIDDEN_KEYS = new Set([
  "input",
  "raw",
  "response",
  "name",
  "subject",
  "object",
  "evidence",
  "diagnostics",
  "message",
  "stack",
  "candidateId",
  "userId",
  "conversationId",
  "requestId",
  "turnId",
  "timestamp",
  "durationMs",
  "knowledgeCount",
  "pathLength",
]);

function summaryFor(input: string): ObservationSummary {
  const result = createSunlandEngine({
    semanticMode: "passive",
    personalityId: "plain",
  }).process(input, { observationMode: "summary" });

  expect(result.observationSummary).toBeDefined();
  return result.observationSummary!;
}

describe("Sunland Core privacy-safe observation", () => {
  it("defaults observationMode to off and calls no observation runtime", () => {
    let clockCalls = 0;
    let summaryCalls = 0;
    const engine = createSunlandEngine({
      personalityId: "plain",
      observationRuntime: {
        now() {
          clockCalls += 1;
          return 1;
        },
        finalizeSummary() {
          summaryCalls += 1;
          throw new Error("must not run");
        },
      },
    });

    const result = engine.process("你好");
    expect(result.response.length).toBeGreaterThan(0);
    expect(result).not.toHaveProperty("observationSummary");
    expect(clockCalls).toBe(0);
    expect(summaryCalls).toBe(0);
  });

  it("returns a valid fixed summary only when explicitly requested", () => {
    const summary = summaryFor("你好");

    expect(validateObservationSummary(summary)).toBe(true);
    expect(summary).toMatchObject({
      resultCategory: "understood",
      reasonCategory: "complete-passive-understanding",
      relationCategory: "none",
      semanticAdopted: true,
      legacyFallback: false,
      clarificationKind: "none",
    });
  });

  it("maps clarification without exposing internal candidates", () => {
    const summary = summaryFor("你会吗");

    expect(summary.resultCategory).toBe("clarification");
    expect(summary.reasonCategory).toBe("missing-object");
    expect(summary.clarificationKind).toBe("missing-object");
  });

  it("maps unknown input to a natural no-understanding category", () => {
    const summary = summaryFor("qzv-完全随机-🦊");

    expect(summary.resultCategory).toBe("no-understanding");
    expect(summary.reasonCategory).toBe("unknown-safe-fallback");
  });

  it("maps missing knowledge and uses only the canonical relation", () => {
    const summary = summaryFor("鸟有什么");

    expect(summary).toMatchObject({
      resultCategory: "missing-knowledge",
      reasonCategory: "missing-knowledge",
      relationCategory: "有",
      queriedRelation: "有",
      alternativeKnownRelation: "none",
      alignmentResult: "unavailable",
      pathLengthBucket: "none",
    });
    expect(summary.reasonerDurationBucket).not.toBe("unavailable");
  });

  it("marks an answered query aligned using its existing Reasoner result", () => {
    const engine = createSunlandEngine({
      semanticMode: "passive",
      personalityId: "plain",
    });
    engine.respond("鸟会飞");
    const result = engine.process("鸟会什么", {
      observationMode: "summary",
    });

    expect(result.observationSummary).toMatchObject({
      resultCategory: "understood",
      relationCategory: "会",
      queriedRelation: "会",
      alternativeKnownRelation: "none",
      alignmentResult: "aligned",
      pathLengthBucket: "direct",
      knowledgeCountBucket: "1-99",
    });
  });

  it("records the canonical alternative relation used by fallback", () => {
    const engine = createSunlandEngine({
      semanticMode: "passive",
      personalityId: "plain",
    });
    engine.respond("猫属于动物");
    const result = engine.process("猫是什么", {
      observationMode: "summary",
    });

    expect(result.observationSummary).toMatchObject({
      resultCategory: "understood",
      relationCategory: "是",
      queriedRelation: "是",
      alternativeKnownRelation: "属于",
      alignmentResult: "aligned",
      pathLengthBucket: "direct",
    });
  });

  it("keeps the alternative relation empty when exact knowledge wins", () => {
    const engine = createSunlandEngine({
      semanticMode: "passive",
      personalityId: "plain",
    });
    engine.respond("猫属于动物");
    const result = engine.process("猫属于什么", {
      observationMode: "summary",
    });

    expect(result.observationSummary).toMatchObject({
      queriedRelation: "属于",
      alternativeKnownRelation: "none",
      alignmentResult: "aligned",
    });
  });

  it("records context use without exposing the resolved entity", () => {
    const engine = createSunlandEngine({
      semanticMode: "passive",
      semanticContextMode: "enabled",
      personalityId: "plain",
    });
    const first = engine.process("猫会什么", {
      semanticContext: {
        schemaVersion: 1,
        version: 0,
        recentTurns: [],
      },
      turnId: "first",
    });
    expect(first.semanticContextUpdate.kind).toBe("replace");
    if (first.semanticContextUpdate.kind !== "replace") {
      throw new Error("expected a context update");
    }

    const second = engine.process("它会什么", {
      semanticContext: first.semanticContextUpdate.context,
      turnId: "second-private-turn",
      observationMode: "summary",
    });
    const serialized = JSON.stringify(second.observationSummary);

    expect(second.observationSummary).toMatchObject({
      contextUsed: true,
      relationCategory: "会",
      queriedRelation: "会",
    });
    expect(serialized).not.toContain("猫");
    expect(serialized).not.toContain("second-private-turn");
  });

  it("maps a blocked Legacy side effect without writing Memory", () => {
    const engine = createSunlandEngine({
      semanticMode: "passive",
      personalityId: "plain",
    });
    const result = engine.process("我不是小明", {
      observationMode: "summary",
    });

    expect(result.observationSummary).toMatchObject({
      resultCategory: "side-effect-blocked",
      reasonCategory: "blocked-side-effect",
    });
    expect(engine.memory.list()).toEqual([]);
    expect(engine.knowledgeStore.all()).toEqual([]);
  });

  it("maps Semantic runtime failure to a finite safe-fallback category", () => {
    const engine = createSunlandEngine({
      semanticMode: "passive",
      personalityId: "plain",
      semanticRuntime: {
        analyze() {
          throw new Error(
            "parser diagnostics include private input Alice Chen",
          );
        },
      },
    });
    const result = engine.process("你好", {
      observationMode: "summary",
    });
    const serialized = JSON.stringify(result.observationSummary);

    expect(result.response.length).toBeGreaterThan(0);
    expect(result.observationSummary).toMatchObject({
      resultCategory: "safe-fallback",
      reasonCategory: "semantic-runtime",
      semanticAdopted: false,
      legacyFallback: true,
    });
    expect(serialized).not.toMatch(
      /parser|diagnostics|private|Alice Chen/iu,
    );
  });

  it("never includes input, output, entities, identity or precise metrics", () => {
    const sensitiveInput = "我的名字是 Alice Chen";
    const result = createSunlandEngine({
      semanticMode: "passive",
      personalityId: "plain",
    }).process(sensitiveInput, {
      observationMode: "summary",
      turnId: "private-turn-id",
      semanticContext: {
        schemaVersion: 1,
        version: 0,
        recentTurns: [],
      },
    });
    const summary = result.observationSummary!;
    const serialized = JSON.stringify(summary);

    expect(serialized).not.toContain(sensitiveInput);
    expect(serialized).not.toContain("Alice Chen");
    expect(serialized).not.toContain(result.response);
    for (const key of Object.keys(summary)) {
      expect(FORBIDDEN_KEYS.has(key)).toBe(false);
    }
    expect(serialized).not.toMatch(
      /candidate|diagnostic|confidence|userId|conversationId|requestId|turnId|timestamp/iu,
    );
  });

  it("drops a throwing summary without affecting response or writes", () => {
    const engine = createSunlandEngine({
      semanticMode: "passive",
      personalityId: "plain",
      observationRuntime: {
        finalizeSummary(summary) {
          expect(summary.totalDurationBucket).not.toBeUndefined();
          expect(summary).not.toHaveProperty("totalDurationMs");
          expect(summary).not.toHaveProperty("semanticDurationMs");
          expect(summary).not.toHaveProperty("reasonerDurationMs");
          throw new Error("observation failed");
        },
      },
    });
    const result = engine.process("猫属于动物", {
      observationMode: "summary",
    });

    expect(result.response).toContain("猫");
    expect(result).not.toHaveProperty("observationSummary");
    expect(
      engine.knowledgeStore.has({
        subject: "猫",
        relation: "属于",
        object: "动物",
        negated: false,
      }),
    ).toBe(true);
  });

  it("drops an invalid custom summary instead of exporting extra data", () => {
    const engine = createSunlandEngine({
      personalityId: "plain",
      observationRuntime: {
        finalizeSummary() {
          return {
            resultCategory: "understood",
            raw: "private input",
          };
        },
      },
    });
    const result = engine.process("你好", {
      observationMode: "summary",
    });

    expect(result.response.length).toBeGreaterThan(0);
    expect(result).not.toHaveProperty("observationSummary");
  });
});
