import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createObservationSummary,
  sanitizeObservationSummary,
  validateObservationSummary,
  type ObservationSummaryInput,
} from "./summary";
import { SUNLAND_CORE_VERSION } from "./types";

function validInput(): ObservationSummaryInput {
  return {
    resultCategory: "understood",
    reasonCategory: "complete-passive-understanding",
    relationCategory: "属于",
    semanticAdopted: true,
    legacyFallback: false,
    contextUsed: false,
    clarificationKind: "none",
    reasonerPathLength: 1,
    knowledgeCount: 42,
    totalDurationMs: 3,
    semanticDurationMs: 0.5,
    reasonerDurationMs: 1,
    queriedRelation: "属于",
    alternativeKnownRelation: "none",
    alignmentResult: "aligned",
  };
}

describe("privacy-safe observation summary", () => {
  it("keeps the explicit Core version aligned with package SemVer", () => {
    const packageJson = JSON.parse(
      readFileSync(
        new URL("../../package.json", import.meta.url),
        "utf8",
      ),
    ) as { readonly version?: unknown };

    expect(SUNLAND_CORE_VERSION).toBe(packageJson.version);
  });

  it("constructs one fixed, JSON-safe whitelist object", () => {
    const summary = createObservationSummary(validInput());

    expect(validateObservationSummary(summary)).toBe(true);
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.keys(summary)).toEqual([
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
      "alignmentResult",
    ]);
  });

  it("drops arbitrary input properties instead of copying objects", () => {
    const summary = createObservationSummary({
      ...validInput(),
      raw: "我的名字是 Alice Chen",
      subject: "猫",
      object: "秘密",
      diagnostics: { message: "private" },
    } as ObservationSummaryInput);
    const serialized = JSON.stringify(summary);

    expect(serialized).not.toMatch(
      /Alice Chen|猫|秘密|private|raw|subject|object|diagnostics/u,
    );
  });

  it("collapses invalid runtime enum values to safe fixed values", () => {
    const summary = createObservationSummary({
      ...validInput(),
      resultCategory: "private result" as never,
      reasonCategory: "private reason" as never,
      relationCategory: "user relation" as never,
      clarificationKind: "private clarification" as never,
      queriedRelation: "private query" as never,
      alternativeKnownRelation: "private alternative" as never,
      alignmentResult: "private alignment" as never,
    });

    expect(summary).toMatchObject({
      resultCategory: "safe-fallback",
      reasonCategory: "unclassified",
      relationCategory: "unknown",
      clarificationKind: "none",
      queriedRelation: "unknown",
      alternativeKnownRelation: "unknown",
      alignmentResult: "unavailable",
    });
  });

  it("rejects extra properties, illegal enums and accessors at runtime", () => {
    const summary = createObservationSummary(validInput());
    expect(
      validateObservationSummary({ ...summary, raw: "private" }),
    ).toBe(false);
    expect(
      validateObservationSummary({
        ...summary,
        resultCategory: "illegal",
      }),
    ).toBe(false);

    const accessor = { ...summary } as Record<string, unknown>;
    Object.defineProperty(accessor, "resultCategory", {
      enumerable: true,
      get: () => "understood",
    });
    expect(validateObservationSummary(accessor)).toBe(false);
  });

  it("sanitizes by rebuilding validated values and rejects hostile proxies", () => {
    const source = Object.create({ hidden: "prototype text" }) as Record<
      string,
      unknown
    >;
    Object.assign(source, createObservationSummary(validInput()));
    const sanitized = sanitizeObservationSummary(source);

    expect(sanitized).not.toBeNull();
    expect(Object.getPrototypeOf(sanitized)).toBe(Object.prototype);
    expect("hidden" in (sanitized ?? {})).toBe(false);

    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("private stack");
        },
      },
    );
    expect(validateObservationSummary(hostile)).toBe(false);
    expect(sanitizeObservationSummary(hostile)).toBeNull();
  });
});
