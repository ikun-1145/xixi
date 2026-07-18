import { describe, expect, it } from "vitest";
import { CoreRelations } from "@/types";
import { CREATOR_RELATION, createSelfKnowledgeStore, FROST_SUBJECT, SUNLAND_SUBJECT } from "./selfKnowledge";

describe("createSelfKnowledgeStore", () => {
  it("has an 'identity' fact for Sunland AI itself", () => {
    const store = createSelfKnowledgeStore();
    const facts = store.match({ subject: SUNLAND_SUBJECT, relation: CoreRelations.Is });
    expect(facts.length).toBeGreaterThan(0);
  });

  it("has a distinct 'identity' fact for the Frost/霜蓝 personality", () => {
    const store = createSelfKnowledgeStore();
    const facts = store.match({ subject: FROST_SUBJECT, relation: CoreRelations.Is });
    expect(facts.length).toBeGreaterThan(0);
    expect(facts[0]?.object).toContain("Sunland AI");
  });

  it("has at least one 'capability' fact", () => {
    const store = createSelfKnowledgeStore();
    const facts = store.match({ subject: SUNLAND_SUBJECT, relation: CoreRelations.Can });
    expect(facts.length).toBeGreaterThan(0);
  });

  it("has a 'creator' fact", () => {
    const store = createSelfKnowledgeStore();
    const facts = store.match({ subject: SUNLAND_SUBJECT, relation: CREATOR_RELATION });
    expect(facts.length).toBeGreaterThan(0);
  });

  it("returns a fresh store each call (not a shared mutable singleton)", () => {
    const a = createSelfKnowledgeStore();
    const b = createSelfKnowledgeStore();
    expect(a).not.toBe(b);
    const strip = (records: readonly { subject: string; relation: string; object: string }[]) =>
      records.map(({ subject, relation, object }) => ({ subject, relation, object }));
    expect(strip(a.all())).toEqual(strip(b.all()));
  });
});
