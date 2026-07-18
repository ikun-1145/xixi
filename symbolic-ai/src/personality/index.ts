/**
 * MODULE: personality
 * Responsibility: render already-finalized content (reasoning results,
 * learned facts, parse failures, greetings, errors) as natural-language text
 * in a persona's voice. This is the "Answer Generation" step of the pipeline.
 *
 * STRICT BOUNDARY:
 *   - Personality NEVER computes facts, confidence, reasoning steps, or
 *     conflicts — it only consumes them (read-only, via `ResponseContext`).
 *   - Personality must NOT be imported by parser/knowledge/reasoners/memory.
 *     Dependency flows one way:
 *       parser / knowledge / reasoners / memory  →  personality  →  ui
 *
 * Depends on: types only.
 *
 * Public API:
 *   - getPersonality(id?)        resolve the active persona (defaults to Frost)
 *   - listPersonalities()        every registered persona
 *   - registerPersonality(p)     add/replace a persona at runtime (plugins)
 *   - DEFAULT_PERSONALITY_ID     "frost"
 *   - FrostPersonality           the default persona
 *   - PlainPersonality           undecorated baseline (debug/tests)
 */
export * from "./frost";
export * from "./plain";
export * from "./registry";
