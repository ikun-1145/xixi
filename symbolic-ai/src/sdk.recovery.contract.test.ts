import { describe, expect, it } from "vitest";
import {
  applySemanticContextUpdate,
  createEmptySemanticContext,
  createMemoryStorageAdapter,
  createSunlandEngine,
  normalizeSemanticContext,
} from "./sdk";

describe("Sunland Core public SDK recovery contract", () => {
  it("restores persisted Knowledge and Memory in a new engine", () => {
    const storage = createMemoryStorageAdapter();
    const key = "sdk-recovery-user";
    const first = createSunlandEngine({
      personalityId: "plain",
      storage: { adapter: storage, key },
    });

    first.respond("猫会爬树");
    first.respond("我叫小蓝");

    const restored = createSunlandEngine({
      personalityId: "plain",
      storage: { adapter: storage, key },
    });
    expect(restored.respond("猫会什么")).toContain("爬树");
    expect(restored.respond("我叫什么")).toContain("小蓝");
  });

  it("fails closed on damaged storage and remains recoverable", () => {
    const repairedValues = new Map<string, string>();
    const damagedStorage = {
      getItem(key: string): string | null {
        return repairedValues.get(key) ?? "{";
      },
      setItem(key: string, value: string): void {
        repairedValues.set(key, value);
      },
      removeItem(key: string): void {
        repairedValues.delete(key);
      },
    };
    const key = "sdk-damaged-storage-user";
    const recovered = createSunlandEngine({
      personalityId: "plain",
      storage: { adapter: damagedStorage, key },
    });

    expect(recovered.knowledgeStore.all()).toEqual([]);
    expect(recovered.memory.list()).toEqual([]);
    expect(() => recovered.respond("猫会爬树")).not.toThrow();
    expect(() => recovered.respond("我叫小蓝")).not.toThrow();

    const restored = createSunlandEngine({
      personalityId: "plain",
      storage: { adapter: damagedStorage, key },
    });
    expect(restored.respond("猫会什么")).toContain("爬树");
    expect(restored.respond("我叫什么")).toContain("小蓝");
  });

  it("restores serialized Context for a follow-up turn", () => {
    const engine = createSunlandEngine({
      personalityId: "plain",
      semanticContextMode: "enabled",
    });
    engine.respond("猫会爬树");
    const initial = createEmptySemanticContext();
    const first = engine.process("猫是什么", {
      semanticContext: initial,
      turnId: "recovery-turn-1",
    });
    const committed = applySemanticContextUpdate(
      initial,
      first.semanticContextUpdate,
    );
    const restored = normalizeSemanticContext(
      JSON.parse(JSON.stringify(committed)),
    );

    const followUp = engine.process("它会什么", {
      semanticContext: restored,
      turnId: "recovery-turn-2",
    });

    expect(followUp.response).toContain("爬树");
  });

  it("normalizes damaged Context and keeps processing available", () => {
    const engine = createSunlandEngine({
      personalityId: "plain",
      semanticContextMode: "enabled",
    });
    const recovered = normalizeSemanticContext("damaged-context");

    expect(recovered).toEqual(createEmptySemanticContext());
    expect(
      engine.process("你好", {
        semanticContext: recovered,
        turnId: "recovery-damaged-context",
      }).response,
    ).not.toHaveLength(0);
  });

  it("rejects a late Context update after a newer snapshot is committed", () => {
    const engine = createSunlandEngine({
      personalityId: "plain",
      semanticContextMode: "enabled",
    });
    engine.respond("猫会爬树");
    engine.respond("狗会游泳");
    const initial = createEmptySemanticContext();
    const first = engine.process("猫会什么", {
      semanticContext: initial,
      turnId: "recovery-current-turn",
    });
    const late = engine.process("狗会什么", {
      semanticContext: initial,
      turnId: "recovery-late-turn",
    });
    const current = applySemanticContextUpdate(
      initial,
      first.semanticContextUpdate,
    );

    expect(applySemanticContextUpdate(current, late.semanticContextUpdate)).toEqual(
      current,
    );
  });
});
