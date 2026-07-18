/**
 * MODULE: rules
 * Responsibility: registry/config of active InferenceRules & ConflictResolvers.
 * Enables rule plugins without touching the reasoning core.
 * Depends on: types only. Must NOT import parser/knowledge/personality/ui.
 * Implemented in: Stage 6 (Knowledge Graph v1) — isA (属于) transitivity is
 * the first (and, for now, only) active rule; see `isaTransitivity.ts`.
 *
 * Public API:
 *   - isaTransitivityRule   the isA/属于 transitivity InferenceRule
 *   - defaultRules          the ordered array of currently-active rules
 */
export * from "./isaTransitivity";
export * from "./registry";
