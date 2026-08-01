import { describe, expect, expectTypeOf, it } from "vitest";
import apiSurface from "../contracts/sdk-api-surface.v0.1.0.json";
import * as sdk from "./sdk";
import {
  CONTEXT_SCHEMA_VERSION,
  OBSERVATION_SCHEMA_VERSION,
  SEMANTIC_SCHEMA_VERSION,
  SUNLAND_CORE_VERSION,
  applySemanticContextUpdate,
  createEmptySemanticContext,
  createMemoryStorageAdapter,
  createSunlandEngine,
  normalizeSemanticContext,
} from "./sdk";
import type {
  StorageAdapter,
  SunlandEngine,
  SunlandEngineOptions,
  SunlandProcessOptions,
  SunlandProcessResult,
} from "./sdk";

describe("Sunland Core v0.1.0 public SDK API surface", () => {
  it("matches the exact versioned runtime export baseline", () => {
    expect(apiSurface).toMatchObject({
      schemaVersion: 1,
      sdkVersion: "0.1.0",
      entry: "src/sdk.ts",
    });
    expect(Object.keys(sdk).sort()).toEqual(apiSurface.runtimeExports);
    expect(new Set(apiSurface.runtimeExports).size).toBe(
      apiSurface.runtimeExports.length,
    );
  });

  it("keeps Core and schema version constants stable", () => {
    expect(SUNLAND_CORE_VERSION).toBe(apiSurface.sdkVersion);
    expect(SEMANTIC_SCHEMA_VERSION).toBe(1);
    expect(CONTEXT_SCHEMA_VERSION).toBe(1);
    expect(OBSERVATION_SCHEMA_VERSION).toBe(1);
    expectTypeOf(SUNLAND_CORE_VERSION).toEqualTypeOf<"0.1.0">();
  });

  it("keeps the primary engine call boundary type-compatible", () => {
    expectTypeOf(createSunlandEngine).toEqualTypeOf<
      (options?: SunlandEngineOptions) => SunlandEngine
    >();
    expectTypeOf<SunlandEngine["respond"]>().toEqualTypeOf<
      (input: string) => string
    >();
    expectTypeOf<SunlandEngine["process"]>().toEqualTypeOf<
      (
        input: string,
        options?: SunlandProcessOptions,
      ) => SunlandProcessResult
    >();
  });

  it("keeps storage and Context adapter signatures compatible", () => {
    type SemanticContextSnapshot = ReturnType<
      typeof createEmptySemanticContext
    >;

    expectTypeOf(createMemoryStorageAdapter).toEqualTypeOf<
      () => StorageAdapter
    >();
    expectTypeOf(normalizeSemanticContext).toEqualTypeOf<
      (value: unknown) => SemanticContextSnapshot
    >();
    expectTypeOf(applySemanticContextUpdate).returns.toEqualTypeOf<
      SemanticContextSnapshot
    >();
  });
});
