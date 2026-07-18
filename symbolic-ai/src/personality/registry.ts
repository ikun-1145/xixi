/**
 * Personality registry.
 *
 * The chat pipeline (built in Stage 7) should depend ONLY on this file to
 * resolve "the active persona" — never import `FrostPersonality` directly —
 * so switching the default, or letting a user pick a different persona,
 * never requires touching parser/knowledge/reasoner code.
 *
 * `registerPersonality` allows future personas (including user- or
 * plugin-contributed ones) to be added at runtime without modifying this
 * file, mirroring the plugin pattern already used for InferenceRule /
 * ConflictResolver.
 */
import type { PersonalityProfile } from "@/types";
import { FrostPersonality } from "./frost";
import { PlainPersonality } from "./plain";

/** Frost is the default persona for this furry-community-facing AI. */
export const DEFAULT_PERSONALITY_ID: string = FrostPersonality.id;

const registry = new Map<string, PersonalityProfile>();

function registerBuiltIns(): void {
  registry.set(FrostPersonality.id, FrostPersonality);
  registry.set(PlainPersonality.id, PlainPersonality);
}
registerBuiltIns();

/** Register (or replace) a persona under its own `id`. */
export function registerPersonality(profile: PersonalityProfile): void {
  registry.set(profile.id, profile);
}

/** All currently-registered personas. */
export function listPersonalities(): readonly PersonalityProfile[] {
  return Array.from(registry.values());
}

/** Resolve a persona by id, falling back to Frost when `id` is omitted. */
export function getPersonality(id: string = DEFAULT_PERSONALITY_ID): PersonalityProfile {
  const persona = registry.get(id);
  if (!persona) {
    throw new Error(`getPersonality: unknown personality id "${id}"`);
  }
  return persona;
}
