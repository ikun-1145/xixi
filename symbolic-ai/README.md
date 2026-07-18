# Symbolic AI · 可解释推理机

A **novel, non-LLM** AI. It answers questions by explicit symbolic reasoning
over a knowledge graph. Every step is visible and explainable.

```
Input → Language Parsing → Knowledge Graph → Reasoning Engine → Learning → Answer Generation
```

## Core diagram

```
Core
├── Parser
├── Knowledge
├── Memory
├── Reasoner
├── Planner        ← reserved for future (goal-directed reasoning), not implemented yet
├── Personality     ← implements the "Answer Generation" step
└── UI
```

## Architecture (module = one responsibility)

| Module        | Responsibility                                                    | Stage |
|---------------|---------------------------------------------------------------------|-------|
| `types`       | Shared TypeScript contracts (interfaces) for all modules            | 1 ✅  |
| `parser`      | Text → structured `ParseResult` (regex + grammar, no AI)            | 2 ✅  |
| `personality` | Wraps a `Reasoner`/`KnowledgeStore` result into styled natural text ("Answer Generation"); default persona = Frost/霜蓝 | 2.5 ✅ |
| `planner`     | Reserved placeholder for future goal-directed reasoning              | —     |
| `knowledge`   | In-memory `KnowledgeStore` of triples + indexing                     | 3     |
| `reasoners`   | `Reasoner` + `InferenceRule`s (inheritance, capability…)             | 4     |
| `rules`       | Registry of active rules & conflict resolvers (plugins)              | 4     |
| `memory`      | User-specific `MemoryStore` (kept apart from world facts)            | 5     |
| `graph`       | `GraphView` → Cytoscape mapping (rendering isolated)                  | 6     |
| `ui`          | Four-panel React interface                                            | 7     |
| `utils`       | Small pure helpers                                                     | —     |

## Design principles
- Strict TypeScript; program to interfaces, not implementations.
- Reasoners depend only on the **read-only** `KnowledgeQuery` — inference is pure.
- Knowledge is triples `(subject)-[relation]->(object)`, never free text.
- `negated` is first-class so contradictions (会 vs 不会) are detectable.
- New capabilities (temporal, probabilistic, planning) = new rule plugins, no core rewrite.
- **Dependency direction is one-way:** `parser / knowledge / reasoners / memory →
  personality → ui`. Personality (and the reserved `planner`) must never be
  imported by upstream reasoning/knowledge modules.
- **Personality only affects language style, never facts or reasoning.**
  A `PersonalityProfile` (see `src/personality/`) embeds a `ReasoningResult`'s
  `explanation` **verbatim** — it may only add opener/closer framing and a
  seeded emoji, never regenerate or edit logical content. This boundary is
  enforced by an automated test (`personality/boundary.test.ts`), which
  renders the same mock result through two different personas (Frost vs
  Plain) and asserts the styling differs while every fact/negation is
  preserved identically.

## Scripts
```bash
npm run dev        # start Vite dev server
npm run build      # typecheck + production build
npm run typecheck  # strict tsc, no emit
npm run test       # vitest
```

## Environment
Copy `.env.example` → `.env` and fill Supabase values (added in Stage 5).
