/**
 * MODULE: reasoners
 * Responsibility: Reasoner implementations + concrete InferenceRules
 * (inheritance, capability propagation) + conflict resolution.
 * Depends on: types, (read-only) knowledge query, `@/rules`. Pure &
 * side-effect free -- never mutates a `KnowledgeStore`, never decides tone.
 * Implemented in: Stage 6 (Knowledge Graph v1) — isA (属于) transitivity +
 * path reasoning + explainable derivation chains. Broader multi-relation
 * inheritance/capability propagation/conflict resolution remain future work
 * (this is a deliberately-scoped-down first Reasoner, not the full
 * originally-envisioned Stage 4 Reasoning Engine -- see `CLAUDE.md`'s
 * naming note on this).
 *
 * Public API:
 *   - graphReasoner   the active Reasoner (implements `Reasoner`)
 */
export * from "./graphReasoner";
