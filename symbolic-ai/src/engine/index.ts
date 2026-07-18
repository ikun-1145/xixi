/**
 * MODULE: engine
 * Responsibility: the Sunland Core composition root -- wires
 * Parser -> KnowledgeStore -> (MVP direct-match, pending Stage 4 Reasoner)
 * -> Personality into one `respond(input)` call any host can use.
 * Depends on: types, parser, knowledge, personality. Zero DOM dependency,
 * so it can run identically in a browser, Node, or a CLI.
 * Implemented in: Stage 3.5.
 *
 * Public API:
 *   - createSunlandEngine(options?)   build a ready-to-use engine instance
 *   - SunlandEngine / SunlandEngineOptions   the types
 */
export * from "./sunlandEngine";
