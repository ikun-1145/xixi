import { describe, expect, it } from "vitest";
import {
  applySemanticContextUpdate,
  createEmptySemanticContext,
  type SemanticContext,
} from "@/semantic";
import { createSunlandEngine } from "./sunlandEngine";

const INTERNAL_TERMS =
  /parser|intent|candidate|confidence|reasoncodes|diagnostics|语法规则/iu;

function applyResult(
  context: SemanticContext,
  result: ReturnType<
    ReturnType<typeof createSunlandEngine>["process"]
  >,
): SemanticContext {
  return applySemanticContextUpdate(
    context,
    result.semanticContextUpdate,
  );
}

describe("SunlandEngine Stage 8.6A conversation context", () => {
  it("keeps context disabled by default and preserves respond compatibility", () => {
    const engine = createSunlandEngine();
    const context = createEmptySemanticContext();
    const result = engine.process("猫是什么", {
      semanticContext: context,
      turnId: "turn-1",
    });

    expect(engine.semanticContextMode).toBe("off");
    expect(result.response).toBe(engine.respond("猫是什么"));
    expect(result.semanticContextUpdate).toEqual({
      kind: "none",
      baseVersion: 0,
    });
  });

  it("resolves 猫是什么 → 它会什么 from the caller-owned snapshot", () => {
    const engine = createSunlandEngine({
      personalityId: "plain",
      semanticContextMode: "enabled",
    });
    engine.knowledgeStore.add(
      {
        subject: "猫",
        relation: "会",
        object: "爬树",
        negated: false,
      },
      { source: "user" },
    );
    let context = createEmptySemanticContext();

    const first = engine.process("猫是什么", {
      semanticContext: context,
      turnId: "turn-1",
    });
    context = applyResult(context, first);
    const second = engine.process("它会什么", {
      semanticContext: context,
      turnId: "turn-2",
    });
    context = applyResult(context, second);

    expect(second.response).toContain("爬树");
    expect(context.recentTurns.at(-1)).toMatchObject({
      turnId: "turn-2",
      focusEntity: { kind: "subject", value: "猫" },
      relation: "会",
      queryShape: { kind: "object-of", hasObject: false },
    });
  });

  it("does not apply Relation Alignment fallback to a context-completed query", () => {
    const engine = createSunlandEngine({
      personalityId: "plain",
      semanticContextMode: "enabled",
    });
    engine.knowledgeStore.add(
      {
        subject: "猫",
        relation: "是",
        object: "一种猫科动物",
        negated: false,
      },
      { source: "user" },
    );
    engine.knowledgeStore.add(
      {
        subject: "鸟",
        relation: "属于",
        object: "动物",
        negated: false,
      },
      { source: "user" },
    );
    let context = createEmptySemanticContext();
    context = applyResult(
      context,
      engine.process("猫是什么", {
        semanticContext: context,
        turnId: "turn-1",
      }),
    );

    const followUp = engine.process("鸟呢", {
      semanticContext: context,
      turnId: "turn-2",
      observationMode: "summary",
    });

    expect(followUp.response).not.toContain("动物");
    expect(followUp.observationSummary).toMatchObject({
      contextUsed: true,
      queriedRelation: "是",
      alternativeKnownRelation: "none",
      alignmentResult: "unavailable",
    });
  });

  it("resolves 猫会什么 → 鸟呢 by inheriting only the relation", () => {
    const engine = createSunlandEngine({
      personalityId: "plain",
      semanticContextMode: "enabled",
    });
    engine.knowledgeStore.add(
      {
        subject: "鸟",
        relation: "会",
        object: "飞",
        negated: false,
      },
      { source: "user" },
    );
    let context = createEmptySemanticContext();
    context = applyResult(
      context,
      engine.process("猫会什么", {
        semanticContext: context,
        turnId: "turn-1",
      }),
    );
    const followUp = engine.process("鸟呢", {
      semanticContext: context,
      turnId: "turn-2",
    });
    context = applyResult(context, followUp);

    expect(followUp.response).toContain("飞");
    expect(context.recentTurns.at(-1)).toMatchObject({
      focusEntity: { kind: "subject", value: "鸟" },
      relation: "会",
    });
  });

  it("resolves 猫有什么 → 那你呢 to the Sunland self entity", () => {
    const engine = createSunlandEngine({
      personalityId: "plain",
      semanticContextMode: "enabled",
    });
    let context = createEmptySemanticContext();
    context = applyResult(
      context,
      engine.process("猫有什么", {
        semanticContext: context,
        turnId: "turn-1",
      }),
    );
    const followUp = engine.process("那你呢", {
      semanticContext: context,
      turnId: "turn-2",
    });
    context = applyResult(context, followUp);

    expect(followUp.response).not.toMatch(INTERNAL_TERMS);
    expect(context.recentTurns.at(-1)).toMatchObject({
      focusEntity: {
        kind: "self",
        value: "Sunland AI · Beta",
      },
      relation: "有",
    });
  });

  it("resolves definition ellipsis without inventing a fact or object", () => {
    const engine = createSunlandEngine({
      personalityId: "plain",
      semanticContextMode: "enabled",
    });
    let context = createEmptySemanticContext();
    const first = engine.process("霜蓝是什么意思", {
      semanticContext: context,
      turnId: "turn-1",
    });
    context = applyResult(context, first);
    const followUp = engine.process("Sunland AI 呢", {
      semanticContext: context,
      turnId: "turn-2",
    });
    context = applyResult(context, followUp);

    expect(engine.knowledgeStore.all()).toEqual([]);
    expect(context.recentTurns.at(-1)).toMatchObject({
      focusEntity: {
        kind: "self",
        value: "Sunland AI · Beta",
      },
      relation: "意思是",
      queryShape: {
        kind: "object-of",
        hasObject: false,
      },
    });
  });

  it("clarifies ambiguous or missing focus without updating context", () => {
    const engine = createSunlandEngine({
      semanticContextMode: "enabled",
    });
    const ambiguous: SemanticContext = Object.freeze({
      schemaVersion: 1,
      version: 4,
      recentTurns: Object.freeze([
        Object.freeze({
          turnId: "turn-multi",
          speaker: "user",
          concepts: Object.freeze([]),
          entityReferences: Object.freeze([
            Object.freeze({ kind: "subject", value: "猫" }),
            Object.freeze({ kind: "subject", value: "狗" }),
          ]),
          relation: "属于",
        }),
      ]),
    });

    const ambiguousResult = engine.process("它是什么", {
      semanticContext: ambiguous,
      turnId: "turn-5",
    });
    const emptyResult = engine.process("它会什么", {
      semanticContext: createEmptySemanticContext(),
      turnId: "turn-empty",
    });

    expect(ambiguousResult.response).toMatch(/猫.*狗|狗.*猫/);
    expect(ambiguousResult.response).not.toMatch(INTERNAL_TERMS);
    expect(ambiguousResult.response).not.toContain("turn-multi");
    expect(ambiguousResult.semanticContextUpdate).toEqual({
      kind: "none",
      baseVersion: 4,
    });
    expect(emptyResult.response).toMatch(/谁|什么/);
    expect(emptyResult.semanticContextUpdate.kind).toBe("none");
  });

  it("does not use context to complete a teaching side effect", () => {
    const engine = createSunlandEngine({
      semanticContextMode: "enabled",
    });
    let context = createEmptySemanticContext();
    context = applyResult(
      context,
      engine.process("猫是什么", {
        semanticContext: context,
        turnId: "turn-1",
      }),
    );
    const attemptedTeaching = engine.process("它是动物", {
      semanticContext: context,
      turnId: "turn-2",
    });

    expect(engine.knowledgeStore.all()).toEqual([]);
    expect(attemptedTeaching.response).not.toMatch(INTERNAL_TERMS);
    expect(attemptedTeaching.semanticContextUpdate).toEqual({
      kind: "none",
      baseVersion: context.version,
    });
  });

  it("updates context only after admitted Legacy writes complete", () => {
    const engine = createSunlandEngine({
      semanticContextMode: "enabled",
    });
    let context = createEmptySemanticContext();
    const remember = engine.process("我叫小明", {
      semanticContext: context,
      turnId: "turn-name",
    });
    context = applyResult(context, remember);
    const teaching = engine.process("猫属于动物", {
      semanticContext: context,
      turnId: "turn-teaching",
    });
    context = applyResult(context, teaching);

    expect(engine.memory.recall("name")?.value).toBe("小明");
    expect(engine.knowledgeStore.all()).toHaveLength(1);
    expect(context.recentTurns).toEqual([
      expect.objectContaining({
        turnId: "turn-name",
        acceptedIntent: "RememberName",
        entityReferences: [],
      }),
      expect.objectContaining({
        turnId: "turn-teaching",
        focusEntity: { kind: "subject", value: "猫" },
        relation: "属于",
      }),
    ]);
  });

  it("drops updates after abort/cancellation and after Semantic failure", () => {
    const cancelled = createSunlandEngine({
      semanticContextMode: "enabled",
    });
    const cancelledResult = cancelled.process("猫是什么", {
      semanticContext: createEmptySemanticContext(),
      turnId: "turn-cancelled",
      canCommitSemanticContext: () => false,
    });
    const failed = createSunlandEngine({
      semanticContextMode: "enabled",
      semanticRuntime: {
        analyze() {
          throw new Error("semantic failed");
        },
      },
    });
    const failedResult = failed.process("猫是什么", {
      semanticContext: createEmptySemanticContext(),
      turnId: "turn-failed",
    });

    expect(cancelledResult.semanticContextUpdate.kind).toBe("none");
    expect(failedResult.semanticContextUpdate.kind).toBe("none");
    expect(failedResult.response).not.toMatch(INTERNAL_TERMS);
  });

  it("isolates contexts supplied for different users/conversations", () => {
    const engine = createSunlandEngine({
      semanticContextMode: "enabled",
    });
    let conversationA = createEmptySemanticContext();
    const conversationB = createEmptySemanticContext();
    conversationA = applyResult(
      conversationA,
      engine.process("猫是什么", {
        semanticContext: conversationA,
        turnId: "a-1",
      }),
    );

    const aFollowUp = engine.process("它会什么", {
      semanticContext: conversationA,
      turnId: "a-2",
    });
    const bFollowUp = engine.process("它会什么", {
      semanticContext: conversationB,
      turnId: "b-1",
    });

    expect(aFollowUp.semanticContextUpdate.kind).toBe("replace");
    expect(bFollowUp.semanticContextUpdate.kind).toBe("none");
    expect(bFollowUp.response).toMatch(/谁|什么/);
  });
});
