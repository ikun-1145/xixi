import { describe, expect, it } from "vitest";
import type { PersonalityProfile } from "@/types";
import { FrostPersonality } from "./frost";
import { PlainPersonality } from "./plain";
import {
  DEFAULT_PERSONALITY_ID,
  getPersonality,
  listPersonalities,
  registerPersonality,
} from "./registry";

describe("personality registry", () => {
  it("defaults to Frost", () => {
    expect(DEFAULT_PERSONALITY_ID).toBe("frost");
    expect(getPersonality()).toBe(FrostPersonality);
  });

  it("resolves personas by id", () => {
    expect(getPersonality("frost")).toBe(FrostPersonality);
    expect(getPersonality("plain")).toBe(PlainPersonality);
  });

  it("throws for an unknown id", () => {
    expect(() => getPersonality("does-not-exist")).toThrow();
  });

  it("lists at least the built-in personas", () => {
    const ids = listPersonalities().map((profile) => profile.id);
    expect(ids).toEqual(expect.arrayContaining(["frost", "plain"]));
  });

  it("supports registering a new persona at runtime (plugin-style)", () => {
    const custom: PersonalityProfile = {
      id: "test-custom-persona",
      displayName: "Custom Test Persona",
      description: "registered at test time only",
      respond: () => "custom reply",
    };
    registerPersonality(custom);
    expect(getPersonality("test-custom-persona")).toBe(custom);
  });
});
