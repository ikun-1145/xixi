import { describe, expect, it } from "vitest";
import { analyzeSemanticInput } from "./candidates";
import {
  applySemanticContextUpdate,
  createEmptySemanticContext,
  normalizeSemanticContext,
  SEMANTIC_CONTEXT_LIMITS,
} from "./context";
import type {
  SemanticContext,
  SemanticContextEntityReference,
  SemanticContextUpdate,
  SemanticTurnSummary,
} from "./types";

function entity(
  value: string,
  kind: SemanticContextEntityReference["kind"] = "subject",
): SemanticContextEntityReference {
  return Object.freeze({ kind, value });
}

function turn(
  turnId: string,
  options: {
    readonly focusEntity?: SemanticContextEntityReference;
    readonly entityReferences?: readonly SemanticContextEntityReference[];
    readonly relation?: string;
  },
): SemanticTurnSummary {
  return Object.freeze({
    turnId,
    speaker: "user",
    concepts: Object.freeze([]),
    entityReferences: Object.freeze([
      ...(options.entityReferences ?? []),
    ]),
    ...(options.focusEntity === undefined
      ? {}
      : { focusEntity: options.focusEntity }),
    ...(options.relation === undefined
      ? {}
      : { relation: options.relation }),
  });
}

function context(
  recentTurns: readonly SemanticTurnSummary[],
  version = recentTurns.length,
): SemanticContext {
  return Object.freeze({
    schemaVersion: 1,
    version,
    recentTurns: Object.freeze([...recentTurns]),
  });
}

function contextQueries(raw: string, semanticContext: SemanticContext) {
  return analyzeSemanticInput(raw, semanticContext).candidates.filter(
    ({ producer }) => producer === "context",
  );
}

describe("Semantic Conversation Context", () => {
  it("creates a serializable empty context without hidden state", () => {
    const empty = createEmptySemanticContext();

    expect(empty).toEqual({
      schemaVersion: 1,
      version: 0,
      recentTurns: [],
    });
    expect(JSON.parse(JSON.stringify(empty))).toEqual(empty);
    expect(normalizeSemanticContext(undefined)).toEqual(empty);
  });

  it("restores a valid serialized context without retaining raw messages", () => {
    const original = context([
      turn("turn-cat", {
        focusEntity: entity("猫"),
        entityReferences: [entity("猫")],
        relation: "会",
      }),
    ], 3);
    const restored = normalizeSemanticContext(
      JSON.parse(JSON.stringify(original)),
    );

    expect(restored).toEqual(original);
    expect(JSON.stringify(restored)).not.toContain("raw");
    expect(JSON.stringify(restored)).not.toContain("parseResult");
  });

  it("drops damaged turns individually and enforces the bounded window", () => {
    const validTurns = Array.from(
      { length: SEMANTIC_CONTEXT_LIMITS.maximumTurns + 2 },
      (_, index) =>
        turn(`turn-${index}`, {
          focusEntity: entity(`实体-${index}`),
          entityReferences: [entity(`实体-${index}`)],
          relation: "会",
        }),
    );
    const normalized = normalizeSemanticContext({
      schemaVersion: 999,
      version: 7,
      recentTurns: [
        { turnId: "", speaker: "user" },
        ...validTurns,
        { turnId: "broken", speaker: "system" },
      ],
    });

    expect(normalized.schemaVersion).toBe(1);
    expect(normalized.version).toBe(7);
    expect(normalized.recentTurns).toHaveLength(
      SEMANTIC_CONTEXT_LIMITS.maximumTurns,
    );
    expect(normalized.recentTurns[0]?.turnId).toBe("turn-2");
    expect(normalized.recentTurns.at(-1)?.turnId).toBe("turn-7");
  });

  it("resolves a pronoun only from one explicit focus", () => {
    const analysis = analyzeSemanticInput(
      "它会什么",
      context([
        turn("turn-cat", {
          focusEntity: entity("猫"),
          entityReferences: [entity("猫")],
          relation: "属于",
        }),
      ]),
    );
    const resolved = analysis.candidates.find(
      ({ producer, result }) =>
        producer === "context" &&
        result?.type === "query" &&
        result.subject === "猫" &&
        result.relation === "会",
    );

    expect(resolved).toBeDefined();
    expect(resolved?.sideEffect).toBe("none");
    expect(
      analysis.candidates.some(
        ({ result }) =>
          result?.type === "query" && result.subject === "它",
      ),
    ).toBe(false);
  });

  it("inherits the previous relation for an explicit replacement subject", () => {
    const candidates = contextQueries(
      "鸟呢",
      context([
        turn("turn-cat", {
          focusEntity: entity("猫"),
          entityReferences: [entity("猫")],
          relation: "会",
        }),
      ]),
    );

    expect(candidates).toContainEqual(
      expect.objectContaining({
        producer: "context",
        result: expect.objectContaining({
          type: "query",
          subject: "鸟",
          relation: "会",
          kind: "object-of",
        }),
        missingSlots: [],
        sideEffect: "none",
      }),
    );
  });

  it.each(["那你呢", "你呢", "Sunland AI 呢"])(
    "switches %s to the canonical Sunland self entity",
    (raw) => {
      const candidates = contextQueries(
        raw,
        context([
          turn("turn-cat", {
            focusEntity: entity("猫"),
            entityReferences: [entity("猫")],
            relation: "会",
          }),
        ]),
      );

      expect(candidates).toContainEqual(
        expect.objectContaining({
          result: expect.objectContaining({
            type: "query",
            subject: "Sunland AI · Beta",
            relation: "会",
          }),
        }),
      );
    },
  );

  it("keeps definition relation while replacing the subject", () => {
    const candidates = contextQueries(
      "Sunland AI 呢",
      context([
        turn("turn-frost", {
          focusEntity: entity("霜蓝"),
          entityReferences: [entity("霜蓝")],
          relation: "意思是",
        }),
      ]),
    );

    expect(candidates).toContainEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          type: "query",
          subject: "Sunland AI · Beta",
          relation: "意思是",
        }),
      }),
    );
  });

  it("returns a missing-subject candidate for ambiguous focus", () => {
    const candidates = contextQueries(
      "它是什么",
      context([
        turn("turn-multi", {
          entityReferences: [entity("猫"), entity("狗")],
          relation: "属于",
        }),
      ]),
    );
    const partial = candidates.find(({ result }) => result === null);

    expect(partial?.missingSlots).toEqual(["subject"]);
    expect(
      partial?.entities.map(({ value }) => value).sort(),
    ).toEqual(["狗", "猫"]);
  });

  it("never lets context override an explicit subject", () => {
    const analysis = analyzeSemanticInput(
      "狗会什么",
      context([
        turn("turn-cat", {
          focusEntity: entity("猫"),
          entityReferences: [entity("猫")],
          relation: "属于",
        }),
      ]),
    );

    expect(
      analysis.candidates.some(
        ({ result }) =>
          result?.type === "query" &&
          result.subject === "狗" &&
          result.relation === "会",
      ),
    ).toBe(true);
    expect(
      analysis.candidates.some(
        ({ producer, result }) =>
          producer === "context" &&
          result?.type === "query" &&
          result.subject === "猫",
      ),
    ).toBe(false);
  });

  it("inherits no object and cannot turn a contextual statement into a write", () => {
    const semanticContext = context([
      turn("turn-cat", {
        focusEntity: entity("猫"),
        entityReferences: [entity("猫"), entity("鱼", "object")],
        relation: "会",
      }),
    ]);
    const ellipsis = contextQueries("鸟呢", semanticContext).find(
      ({ result }) => result?.type === "query",
    );
    const statementAnalysis = analyzeSemanticInput(
      "它是动物",
      semanticContext,
    );

    expect(ellipsis?.result).not.toHaveProperty("object");
    expect(
      statementAnalysis.candidates.some(
        ({ result, sideEffect }) =>
          result?.type === "statement" ||
          sideEffect !== "none",
      ),
    ).toBe(false);
    expect(
      statementAnalysis.candidates.some(({ missingSlots }) =>
        missingSlots.includes("subject"),
      ),
    ).toBe(true);
  });

  it("rejects a late optimistic update instead of overwriting new context", () => {
    const base = context([
      turn("turn-1", {
        focusEntity: entity("猫"),
        entityReferences: [entity("猫")],
        relation: "会",
      }),
    ], 1);
    const newer = context([
      ...base.recentTurns,
      turn("turn-2", {
        focusEntity: entity("鸟"),
        entityReferences: [entity("鸟")],
        relation: "有",
      }),
    ], 2);
    const lateUpdate: SemanticContextUpdate = Object.freeze({
      kind: "replace",
      baseVersion: 1,
      nextVersion: 2,
      context: context([
        ...base.recentTurns,
        turn("late", {
          focusEntity: entity("狗"),
          entityReferences: [entity("狗")],
          relation: "属于",
        }),
      ], 2),
    });

    expect(applySemanticContextUpdate(newer, lateUpdate)).toEqual(newer);
  });
});
