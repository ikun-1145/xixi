# Changelog

All notable changes to Sunland Core are documented in this file. Versions
follow the policy in [`docs/versioning.md`](./docs/versioning.md).

## [Unreleased]

Changes intended for the next release must remain here until the release
checklist is complete and the target version is fixed.

### Changed

- Refined Frost's user-facing greeting, identity, unknown-input, teaching,
  and reasoning wording while preserving the existing reasoning, Knowledge,
  Memory, Semantic Context, Provider, and public SDK boundaries.

## [0.1.0] - 2026-08-01

### Added

- The single public SDK entry at `src/sdk.ts` and the dependency-free ESM
  Bundle consumed by Web and Flutter.
- Public SDK behavioral, recovery, and v0.1.0 API Surface contract tests.
- A complete `release:core` pipeline with strict type-checking, Core tests,
  single-build Web/Flutter synchronization, SHA256 manifests, post-publish
  consistency checks, and a machine-readable release report.
- Formal Semantic Version rules, SDK integration documentation, security
  boundaries, and a repeatable release checklist.
- A v0.1.0 Beta launch audit, moderated Beta test checklist, and product-level
  readiness tests for first-run, error, empty-state, Knowledge/Memory, local
  Diagnostics, and cross-platform guidance.

### Changed

- Core publication now validates the exact v0.1.0 runtime export baseline and
  the exported `SUNLAND_CORE_VERSION` before and after host synchronization.

### Compatibility

- The v0.1.0 API audit found no removed, renamed, or unexpectedly added
  runtime exports relative to the existing published SDK; all 70 runtime
  exports remain stable.
- Primary Engine, Storage Adapter, and Semantic Context Adapter signatures
  remain compatible.
- Semantic, Context, and Observation schema versions remain at `1`.
- No Symbolic Core algorithm, Provider logic, public data format, or
  Web/Flutter runtime behavior changed during release hardening.
