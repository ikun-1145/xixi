/**
 * MODULE: planner (Response Planner, Stage 7)
 *
 * Pipeline position: Parser -> Knowledge -> Reasoner -> **Response Planner**
 * -> Personality -> Output.
 *
 * Reads only a `Reasoner`'s already-computed `ReasoningResult` (Answer +
 * Confidence + Evidence) and decides the ANSWER STRATEGY on top of it —
 * whether to answer at all, whether to surface the derivation chain
 * (Evidence), whether to hedge on low confidence. It never decides tone
 * (that's Personality's job) and never re-derives facts (that's the
 * Reasoner's). See `types/planner.ts` for the full contract and
 * `responsePlanner.ts` for the (only, v1) implementation.
 *
 * Depends on: types only (reads a plain `ReasoningResult` object). Must NOT
 * depend on personality/ui; must NOT be depended on by
 * parser/knowledge/reasoners/memory.
 *
 * This module's doc comment previously described a broader, not-yet-started
 * future capability ("goal-directed, multi-step reasoning — path finding,
 * action sequencing"); the Response Planner implemented here is the FIRST,
 * narrower slice of that same architectural slot (answer-strategy decisions
 * only, per this stage's explicit scope) — the same module boundary, not a
 * different one. Multi-step planning beyond "how to phrase this one answer"
 * remains a future extension of this module, not a separate one.
 */
export * from "./responsePlanner";
