# Symbolic AI · 可解释推理机

A **novel, non-LLM** AI. It answers questions by explicit symbolic reasoning
over a knowledge graph. Every step is visible and explainable.

```
Input → Language Parsing → Knowledge Graph → Reasoning Engine → Learning → Answer Generation
```

正式的 Core SDK 架构、公开接口与宿主集成契约见
[`docs/architecture.md`](./docs/architecture.md)。

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
npm run release:core # typecheck + test + build once + publish + verify + release report
npm run check:core-release # verify both published bundles and manifests without writing
npm run typecheck  # strict tsc, no emit
npm run test       # vitest
npm run test:contract # public SDK black-box contract tests
npm run test:api-surface # exact v0.1.0 exports + primary TypeScript signatures
```

`release:core` first runs strict type-checking and the complete Core test suite,
then builds once and publishes those exact bytes to Web and Flutter. It writes
deterministic `sunland-core.manifest.json` files beside both bundles, verifies
their bytes, hash, manifest and exported runtime version, and writes the
machine-readable release report to
`dist/core/sunland-core.release-report.json`. The default layout expects the
Flutter checkout at `../../../sunland_ai_app` relative to this package; set
`SUNLAND_FLUTTER_ROOT` when using a different workspace layout.

Semantic Version 规则与发布操作清单分别见
[`docs/versioning.md`](./docs/versioning.md) 和
[`docs/release-checklist.md`](./docs/release-checklist.md)。
小规模用户测试前，另需阅读
[`docs/beta-launch-audit-v0.1.0.md`](./docs/beta-launch-audit-v0.1.0.md) 并执行
[`docs/beta-test-checklist.md`](./docs/beta-test-checklist.md)。

## Environment
Copy `.env.example` → `.env` and fill Supabase values (added in Stage 5).
