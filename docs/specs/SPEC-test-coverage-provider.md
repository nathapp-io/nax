# SPEC: TestCoverageProvider (Context Engine v2)

> **Status:** Draft. Blocks v1 `context.testCoverage` removal. Independent of other v2 amendments — shippable on its own.

## Summary

Port the v1 test-coverage summary into a Context Engine v2 provider so the legacy `context.testCoverage` config and its in-builder call site can be deprecated and eventually removed. The new `TestCoverageProvider` wraps the existing scanner (`generateTestCoverageSummary()`) and emits a single floor-included chunk, preserving v1's duplication-prevention signal under the v2 scoring/packing pipeline.

## Motivation

- v1 injects a markdown summary of existing `describe()` / `test()` / `it()` blocks into every story prompt so the agent does **not duplicate test coverage** across isolated story sessions. Current call site: [src/context/builder.ts:173-202](src/context/builder.ts#L173-L202).
- v2 has no equivalent provider. Removing `context.testCoverage` today would silently drop the "DO NOT duplicate this coverage" instruction — a functional regression observed by any project where stories share a package.
- The scanner logic itself is stable (ADR-009-aligned, per-package aware, token-budgeted). We only need a thin adapter, not a rewrite.

This is the last missing v2 piece before the four legacy `context.*` fields (`fileInjection`, `autoDetect`, `testCoverage`, `featureEngine`) can be deprecated as a group.

## Non-goals

- **Not a rewrite of the scanner.** `generateTestCoverageSummary()` and the regex-based extraction stay exactly as in [src/context/test-scanner.ts](src/context/test-scanner.ts).
- **Not new UX.** No change to the markdown format the agent sees — v1 output is reproduced byte-for-byte for the parity window.
- **Not a v1/v2 toggle.** Once shipped, v2 becomes the only path for test-coverage injection; v1's `addTestCoverageElement()` is removed in the same release that flips the default.
- **Not AST-based.** Continue with regex extraction. A future AST-backed provider is a separate spec.
- **Not cross-package.** Scope stays at `packageDir` (matches v1 and [monorepo-awareness.md](../../.claude/rules/monorepo-awareness.md) §7 package-scoped).

## Design

### Provider shape

New file: `src/context/engine/providers/test-coverage.ts`.

```typescript
export class TestCoverageProvider implements IContextProvider {
  readonly id = "test-coverage";
  readonly kind = "test-coverage";   // new ChunkKind; floor-included by packer rule

  constructor(
    private readonly story: UserStory,
    private readonly config: NaxConfig,
  ) {}

  async fetch(request: ContextRequest): Promise<ContextProviderResult> {
    const tcConfig = this.config.context?.testCoverage;
    if (tcConfig?.enabled === false) return { chunks: [], pullTools: [] };
    if (!request.packageDir) return { chunks: [], pullTools: [] };

    const resolved = await resolveTestFilePatterns(
      this.config, request.repoRoot, this.story.workdir,
    );
    const scan = await generateTestCoverageSummary({
      workdir: request.packageDir,
      testDir: tcConfig?.testDir,
      resolvedTestGlobs: resolved?.globs,
      maxTokens: tcConfig?.maxTokens ?? 500,
      detail: tcConfig?.detail ?? "names-and-counts",
      contextFiles: getContextFiles(this.story),
      scopeToStory: tcConfig?.scopeToStory ?? true,
    });
    if (!scan.summary) return { chunks: [], pullTools: [] };

    const chunk: RawChunk = {
      id: `test-coverage:${contentHash8(scan.summary)}`,
      kind: "test-coverage",
      scope: "story",
      role: ["implementer", "tdd"],    // reviewer does not need it
      content: scan.summary,
      tokens: scan.tokens,
      rawScore: 0.85,                  // matches v1 priority 85 for traceability
    };
    return { chunks: [chunk], pullTools: [] };
  }
}
```

### Chunk classification

| Field | Value | Rationale |
|:---|:---|:---|
| `kind` | `"test-coverage"` **(new)** | Added to `ChunkKind` in `src/context/engine/types.ts`. Not `"feature"` — that kind means "accumulated feature learning from `.nax/features/<id>/context.md`" and mixing structurally different data muddies manifest analytics and any future role/floor rule tuned for features. Marked as floor-included by the packer so v1's unconditional-injection guarantee is preserved. |
| `scope` | `"story"` | Rendered between Feature and Session sections in push markdown — matches where v1 places it. |
| `role` | `["implementer", "tdd"]` | Reviewer does not write tests; excluding saves budget in review stages. This is a v2 improvement over v1 (v1 had no role concept and injected everywhere). |
| `rawScore` | `0.85` | Matches v1 priority 85 for manifest readability. Score adjustments by the orchestrator's role × freshness rules still apply. |

### `ChunkKind` extension

Add `"test-coverage"` to the union in [src/context/engine/types.ts](src/context/engine/types.ts):

```typescript
export type ChunkKind =
  | "static"         // always floor-included
  | "feature"        // always floor-included
  | "test-coverage"  // NEW — always floor-included; story-scoped test summary
  | "session"
  | "history"
  | "neighbor"
  | "rag"
  | "graph"
  | "kb";
```

Update the packer's floor-include rule (currently matches `static | feature`) to also include `test-coverage`. Update any `switch`/`if` arms on `ChunkKind` — expected touch points: packer, scoring, manifest analytics.

### Registration

Register in [src/context/engine/orchestrator-factory.ts](src/context/engine/orchestrator-factory.ts) alongside `FeatureContextProviderV2`:

```typescript
providers.push(new TestCoverageProvider(story, config));
```

Gate via the existing `context.testCoverage.enabled` field (default `true`). No new config key in this spec.

### Stage config

Add `"test-coverage"` to the default stage config for `implementer` and `tdd` stages in [src/context/engine/stage-config.ts](src/context/engine/stage-config.ts). Review and rectify stages omit it.

### Config migration

Once the provider ships and is enabled by default:

1. Mark `context.testCoverage` as deprecated in [src/config/schemas.ts](src/config/schemas.ts) with a comment pointing to this spec.
2. Move the field under `context.v2.providers.testCoverage` as the canonical location. Keep the legacy path as an alias via a migration shim (same pattern as [src/config/migrations.ts](src/config/migrations.ts) handles `testPattern`).
3. After one release, `rejectLegacyAgentKeys`-style hard-rejection per [config-patterns.md](../../.claude/rules/config-patterns.md) — not silent stripping.

This migration is **out of scope for the initial PR**; it lands in the follow-up `v1-context-removal` PR once all four legacy fields have v2 replacements or clean removal paths.

## Acceptance criteria

- **AC-1** A new `TestCoverageProvider` class exists at `src/context/engine/providers/test-coverage.ts` implementing `IContextProvider`.
- **AC-2** When `context.testCoverage.enabled: true` and `context.v2.enabled: true`, the implementer and tdd stages receive a chunk with `id` prefix `test-coverage:` and content matching `generateTestCoverageSummary()` output byte-for-byte.
- **AC-3** When `context.testCoverage.enabled: false`, the provider returns `{ chunks: [], pullTools: [] }` without scanning.
- **AC-4** The provider is **package-scoped**: uses `request.packageDir` (not `request.repoRoot`) as the scan root. Logs include `storyId` and `packageDir` per [monorepo-awareness.md](../../.claude/rules/monorepo-awareness.md) §9.
- **AC-5** Review and rectify stages do **not** receive the chunk (role filter excludes `reviewer`).
- **AC-6** The chunk is floor-included even when the computed `score` falls below `minScore`, matching v1's unconditional injection. Enforced by extending the packer's floor rule to `kind ∈ {static, feature, test-coverage}`.
- **AC-7** Provider failure (e.g. scanner throws) returns empty chunks and logs a warning — never throws. Same resilience pattern as `FeatureContextProviderV2`.
- **AC-8** Manifest `providerResults` entry records `providerId: "test-coverage"` with status `ok` / `empty` / `failed` and `tokensProduced`.
- **AC-9** Unit tests under `test/unit/context/engine/providers/test-coverage.test.ts` cover: enabled/disabled gating, empty-result path, scoped-to-story filtering, monorepo `packageDir` anchoring, failure-returns-empty path, role filter.
- **AC-10** An integration test asserts byte-equality of push-markdown output against the v1 builder's output on a fixture package for the default config — parity proof for the deprecation path.

## Rollout plan

1. **PR 1 — provider + tests** (this spec). Lands with `context.testCoverage` legacy path untouched. No behavior change for v1 users.
2. **PR 2 — stage config + orchestrator registration.** Flag-gated by `context.v2.enabled`. Still no change for v1 users.
3. **PR 3 — parity validation.** Run a dogfood pass comparing v1 vs v2 output on representative packages. Close this spec when AC-10 passes on CI.
4. **PR 4 — deprecation (separate spec).** Flip v2 default-on, deprecate the four legacy `context.*` fields, add loader rejection shim.

## Resolved decisions

- **RD-1** (was OQ-1) **Aggregate chunk, not per-file.** Matches v1 byte-for-byte, simplest to prove parity (AC-10), preserves the `## Existing Test Coverage (N tests across M files)` header agents have seen in prior runs. Revisit only if manifest data shows the whole chunk getting evicted under budget pressure — at which point per-file emission is a natural Phase 2.
- **RD-2** (was OQ-2) **No pull-tool variant.** The summary is small (~500 tokens) and universally useful in implementer/tdd stages. Push is the right mode; pull adds latency + infra with no win.
- **RD-3** (was OQ-3) **Add dedicated `"test-coverage"` `ChunkKind`.** Cleaner semantics than overloading `"feature"`, trivial code cost (one union member + packer floor-rule extension), and keeps manifest analytics honest when operators break down tokens by kind.

## References

- [SPEC-context-engine-v2.md](./SPEC-context-engine-v2.md) — v2 pipeline and `IContextProvider` contract
- [SPEC-context-engine-v2-amendments.md](./SPEC-context-engine-v2-amendments.md) — Amendment C (monorepo scoping) constraints
- [src/context/test-scanner.ts](../../src/context/test-scanner.ts) — existing scanner (reused as-is)
- [src/context/builder.ts:173-202](../../src/context/builder.ts#L173-L202) — v1 call site being superseded
- ADR-009 — test-file pattern SSOT
- [monorepo-awareness.md](../../.claude/rules/monorepo-awareness.md) — per-package scoping rules
