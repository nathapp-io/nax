# SPEC: Effectiveness → Scoring Feedback Loop

<!-- spec-writing: completed-through-phase-5 -->

## Summary

Close the context engine's effectiveness→scoring loop (gap §23) by deriving a
per-provider score multiplier from the `ignored` verdicts already recorded on
prior stories' context manifests, and extend scoped attribution (`scopePaths`)
to `GitHistoryProvider` and `CodeNeighborProvider` — the two non-floor providers
whose scores that multiplier can actually act on.

The multiplier is learned from the `ignored` verdict only and can only reduce a
score, never raise one. Weights are derived per story from the current feature's
stored manifests; nothing new is persisted.

## Motivation

`chunkEffectiveness` has been written to stored manifests since Amendment A
AC-45 and has never been read back into scoring. §23 called for a per-provider
learned multiplier and was held blocked on §9, because learning from a
classifier that saturated to `followed` past ~250 diff lines "would teach the
engine that every rule chunk is always useful".

#1570 closed §9 with scope-limited attribution. The bias is reduced, not
retired: mean `followed` per 12 chunks fell 5.8 → 0.2 for 25–100 line diffs, but
only 12.0 → 7.9 above 1.5k lines, because most rules declare
`appliesTo: src/**/*.ts`, which admits nearly every changed file.

Two consequences drive this spec's shape:

1. **Only the `ignored` half of the signal is safe to consume.** The residual
   bias runs toward false `followed`; there is no known bias toward false
   `ignored`. Learning only from `ignored`, and only downward, means a biased
   signal can make the engine more conservative but never amplify a chunk it
   wrongly believes was followed.

2. **Scoped attribution currently exists only where scoring is a no-op.**
   `orchestrator.ts` drops `belowMinScore` chunks for every kind except
   `FLOOR_KINDS = ["static", "feature", "test-coverage"]`, and `packChunks`
   includes floor chunks regardless of budget. #1570 populated `scopePaths` on
   `StaticRulesProvider` — a floor provider, whose score can never change
   inclusion. Every provider the loop can act on still classifies against the
   whole diff. Extending `scopePaths` to those providers is a prerequisite for
   the loop, not an independent enhancement.

## Design

### Integration

Verified integration points:

| Symbol | Location | Role |
|:---|:---|:---|
| `scoreChunk(chunk, callerRole, minScore, stale)` | `src/context/engine/scoring.ts` | Gains a fifth multiplier operand |
| `scoreChunks(chunks, callerRole, minScore)` | `src/context/engine/scoring.ts` | Threads weights to `scoreChunk` |
| `enrichRaw(chunk, providerId)` | `src/context/engine/orchestrator.ts` | Sets `RawChunk.providerId`; runs **before** scoring |
| `FLOOR_KINDS` | `src/context/engine/packing.ts` | Kinds exempt from `belowMinScore` and budget |
| `buildManifest(inputs)` | `src/context/engine/manifest-builder.ts` | Builds sibling maps from `inputs.packed` |
| `loadContextManifests(projectDir, storyId, featureId?)` | `src/context/engine/manifest-store.ts` | Loads one story's manifests |
| `_manifestStoreDeps.listFeatureDirs` | `src/context/engine/manifest-store.ts` | Directory-glob precedent |
| `contextStage.execute(ctx)` | `src/pipeline/stages/context.ts` | Outermost production entry point |
| `_contextStageDeps` | `src/pipeline/stages/context.ts` | DI seam for stubbing |
| `scoreEffectiveness`, `loadLabelSet` | `src/context/engine/effectiveness-eval.ts` | Existing evaluation harness |

Patterns this feature mirrors:

- **Sibling ID-keyed maps on the manifest.** `chunkTokens` (#1421) and
  `chunkScopePaths` (#1570) are both `Record<chunkId, T>` siblings rather than
  shape changes to `includedChunks`, which is "a persisted schema other readers
  index by ID". `chunkProviders` follows that precedent exactly.
- **Caller-controlled scoring inputs travel on `ContextRequest`.** `minScore` is
  set at `src/pipeline/stages/context.ts:158` with the stated intent "passed
  through ContextRequest so callers control it without coupling the orchestrator
  to NaxConfig." `providerWeights` follows the same route.
- **Absent optional manifest fields degrade, never throw.** `effectiveBudget`
  documents the contract: "downstream consumers must treat absence as 'unknown
  ceiling' and fall back gracefully."

A gap this feature must close: **the manifest records no chunk-ID → provider
mapping.** `includedChunks` is `string[]` and `chunkEffectiveness` is keyed by
chunk ID alone, so per-provider aggregation has nothing to group by. Deriving
the provider by splitting the chunk ID on `:` is a convention, not an invariant,
and plugin providers are free to break it. US-003 therefore persists an explicit
`chunkProviders` sibling map.

A second gap: **`loadContextManifests` requires a `storyId`** and so cannot load
a whole feature. US-003 adds a feature-wide loader alongside it.

### Approach

The multiplier is a function of the `ignored` ratio alone:

```
weight(provider) = clamp(1 - k × ignoredRatio(provider), MIN_WEIGHT, 1.0)
```

applied only once a provider has at least `MIN_OBSERVATIONS` classified chunks
in the window; below that the weight is exactly `1.0`.

`k`, `MIN_WEIGHT` and `MIN_OBSERVATIONS` are **not** pinned by acceptance
criteria — they are not knowable at authoring time. The ACs pin the properties
(monotone non-increasing, never above `1.0`, identity below the observation
gate, never below `MIN_WEIGHT`) and the constants are whatever satisfies them.
This follows the §9 arc, where pinning a classifier constant was rejected for
the same reason.

Vocabulary note, since "floor" is otherwise overloaded in this subsystem:
`MIN_WEIGHT` is the multiplier's lower clamp; `FLOOR_KINDS` is the
always-included chunk-kind set. They are unrelated.

The score formula becomes:

```
adjustedScore = rawScore × roleMultiplier × kindWeight × freshnessMultiplier × effectivenessMultiplier
```

`RawChunk.scoreMultiplier` is already owned by staleness and is not overloaded.
The effectiveness multiplier is caller-derived rather than provider-declared, so
it reaches the orchestrator through `ContextRequest.providerWeights`.

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| No prior manifests for the feature (story 1) | All weights identity `1.0`; no provider is downweighted |
| Manifest file malformed or unreadable | Skipped; remaining manifests still contribute |
| Manifest predates `chunkProviders` (absent field) | Contributes no observations; degrades toward identity |
| A packed chunk carries no `providerId` | Omitted from `chunkProviders`; contributes no observations |
| Provider below `MIN_OBSERVATIONS` in the window | Weight is exactly `1.0` |
| `ContextRequest.providerWeights` absent | Every chunk scores at multiplier `1.0` — current behaviour |
| Weight present for a `FLOOR_KINDS` chunk | Score changes; inclusion does not — floor chunks stay packed |

Every row fails open toward the current behaviour. No condition can raise a
score or silence a provider.

## Out of Scope

- Cross-run persistence of learned effectiveness weights is out of scope; weights are derived per story from the current feature's stored manifests and nothing new is written to disk.
- Per-rule-section or per-chunk weight granularity is out of scope; `providerId` is the only learning key, because chunk IDs embed a content hash and do not survive a content edit.
- LLM-judged chunk attribution is out of scope; all effectiveness classification remains deterministic.
- Counterfactual attribution from run outcomes is out of scope.
- Populating `scopePaths` for `SessionScratchProvider`, `FeatureContextProvider`, `TestCoverageProvider` and plugin providers is out of scope; chunks from those providers keep whole-diff fail-open classification.
- Consuming the `followed` effectiveness verdict in any scoring path is out of scope; only the `ignored` verdict drives the multiplier.
- Changing `FLOOR_KINDS` or the floor-inclusion policy is out of scope; static, feature and test-coverage chunks remain always-included regardless of any learned weight, so this feature cannot prune static rules.
- Raising the `MIN_SCORE` default is out of scope.
- Surfacing learned weights through a CLI command or report is out of scope.

## Stories

### US-001 — Scope attribution for GitHistoryProvider

Populate `RawChunk.scopePaths` on the git-history chunk with the files that
actually contributed a history section. `fetchFileHistory` returns `null` for
files with no history and those are filtered out, so scope must be derived from
the files that produced a section — not from the input `filesToProcess` list,
which would claim scope over files the chunk says nothing about.

- Context Files: `src/context/engine/providers/git-history.ts`, `src/context/engine/types.ts`, `test/fixtures/effectiveness/labels.sample.json`
- Creates: `test/unit/context/engine/providers/git-history-scope.test.ts`
- Depends on: none

### US-002 — Scope attribution for CodeNeighborProvider

Populate `RawChunk.scopePaths` on the code-neighbor chunk with each analysed
file plus the neighbour paths listed beneath it.
`src/context/engine/providers/code-neighbor.ts` is 613 lines — over the
600-line limit and grandfathered by `bun run check:file-sizes`, so it cannot
grow. Extract the chunk-assembly path into a sibling module.

- Context Files: `src/context/engine/providers/code-neighbor.ts`, `src/context/engine/types.ts`, `test/fixtures/effectiveness/labels.sample.json`
- Creates: `src/context/engine/providers/code-neighbor-chunk.ts`, `test/unit/context/engine/providers/code-neighbor-scope.test.ts`
- Depends on: none

### US-003 — Per-provider weight derivation

Persist a `chunkProviders` sibling map on the manifest, add a feature-wide
manifest loader, and derive per-provider weights from `ignored` verdicts.

- Context Files: `src/context/engine/manifest-builder.ts`, `src/context/engine/manifest-types.ts`, `src/context/engine/manifest-store.ts`, `src/context/engine/index.ts`
- Creates: `src/context/engine/provider-weights.ts`, `test/unit/context/engine/provider-weights.test.ts`
- Depends on: none

### US-004 — Wire weights into scoring

Thread the derived weights from the context stage through `ContextRequest` into
`scoreChunk`, and pin that floor kinds remain included at any weight.

- Context Files: `src/context/engine/scoring.ts`, `src/context/engine/orchestrator.ts`, `src/context/engine/types.ts`, `src/pipeline/stages/context.ts`, `src/context/engine/provider-weights.ts` — created by US-003, consumed here
- Creates: `test/unit/context/engine/scoring-effectiveness-weight.test.ts`, `test/unit/pipeline/stages/context-provider-weights.test.ts`
- Depends on: US-003

### Modifies

No story requires modifying an existing test's assertions. The provider tests
(`git-history.test.ts`, `code-neighbor.test.ts`) assert on `result.pullTools`
and captured matchers, not on closed-world chunk shape.
`manifest-builder.test.ts` exercises `buildManifest` with hand-built
`PackedChunk` fixtures, so its closed-world `chunkScopePaths` key assertion is
unaffected by provider-side changes and by the addition of a sibling
`chunkProviders` map.

### Seams

- **US-003 → US-004.** `deriveProviderWeights` is a new export consumed by the
  context stage. US-004 declares the seam invariant: stub the symbol, trigger
  `contextStage.execute`, assert it was invoked and its result reached scoring.
- **US-003 internal.** `loadFeatureManifests` is a new export from
  `manifest-store`; `deriveProviderWeights`'s own ACs exercise it.
- **US-001 / US-002 → existing carrier.** Both providers write to the existing
  `RawChunk.scopePaths` field already forwarded by `buildManifest`; no new
  carrier and therefore no new seam.

## Acceptance Criteria

### US-001 — Scope attribution for GitHistoryProvider

1. `[unit]` Calling `GitHistoryProvider.fetch` with `touchedFiles` of two relative paths where only the first has commit history returns one chunk whose `scopePaths` equals a list containing only the first path.
2. `[unit]` Calling `GitHistoryProvider.fetch` where every requested file has commit history returns a chunk whose `scopePaths` lists those files in the same order they appear in `touchedFiles`.
3. `[unit]` Calling `GitHistoryProvider.fetch` where no requested file has commit history returns an empty `chunks` list.
4. `[unit]` Whenever `GitHistoryProvider.fetch` returns a chunk, that chunk's `scopePaths` is a non-empty list.
5. `[unit]` Passing a packed git-history chunk carrying `scopePaths` to `buildManifest` produces a manifest whose `chunkScopePaths` maps that chunk's id to the same list.
6. `[unit]` Running `scoreEffectiveness` over the committed effectiveness fixture extended with a `history`-kind labelled case yields a `sizeCorrelation` whose magnitude is strictly smaller than the same fixture scored with whole-diff classification.

**Out of scope:** US-001 only: attributing scope to files a commit touched but the story did not declare in `touchedFiles` — the chunk only reports history for requested files.

### US-002 — Scope attribution for CodeNeighborProvider

1. `[unit]` Calling `CodeNeighborProvider.fetch` for a story touching one file that has neighbours returns a chunk whose `scopePaths` contains that touched file's path.
2. `[unit]` The chunk returned by `CodeNeighborProvider.fetch` has `scopePaths` containing each neighbour path rendered in the chunk body.
3. `[unit]` Calling `CodeNeighborProvider.fetch` when no touched file has neighbours returns an empty `chunks` list.
4. `[unit]` The chunk-assembly function extracted to `code-neighbor-chunk.ts` is importable from that module and, given a list of per-file neighbour sections, returns a chunk whose `kind` is `neighbor` and whose `scopePaths` is non-empty.
5. `[unit]` Passing a packed code-neighbor chunk carrying `scopePaths` to `buildManifest` produces a manifest whose `chunkScopePaths` maps that chunk's id to the same list.
6. `[unit]` Running `scoreEffectiveness` over the committed effectiveness fixture extended with a `neighbor`-kind labelled case yields a `sizeCorrelation` whose magnitude is strictly smaller than the same fixture scored with whole-diff classification.

Verification note: the 600-line source limit on `code-neighbor.ts` is enforced by the build/static gate `bun run lint` (which runs `check:file-sizes`), not by an acceptance criterion.

**Out of scope:** US-002 only: cross-package neighbour scope when `crossPackageDepth` is greater than zero — scope is recorded for the paths the chunk renders, whichever package they resolve to.

### US-003 — Per-provider weight derivation

1. `[unit]` Passing packed chunks that each carry a `providerId` to `buildManifest` produces a manifest whose `chunkProviders` maps each chunk id to its provider id.
2. `[unit]` Passing a packed chunk with no `providerId` to `buildManifest` produces a manifest whose `chunkProviders` has no key for that chunk's id.
3. `[unit]` Passing only chunks without `providerId` to `buildManifest` produces a manifest whose `chunkProviders` is absent.
4. `[unit]` Calling `loadFeatureManifests` for a feature whose directory contains two story subdirectories, each holding one manifest file, returns both manifests.
5. `[unit]` Calling `loadFeatureManifests` for a feature directory containing a stray non-directory entry alongside its story directories returns the story manifests and does not throw.
6. `[unit]` Calling `deriveProviderWeights` with an empty manifest list returns a mapping that yields weight `1.0` for any provider id queried.
7. `[unit]` Calling `deriveProviderWeights` where a provider has fewer classified chunks than the minimum observation count returns weight `1.0` for that provider.
8. `[unit]` Calling `deriveProviderWeights` where a provider clears the observation count with no `ignored` verdicts returns weight `1.0` for that provider.
9. `[unit]` Calling `deriveProviderWeights` with two providers that both clear the observation count, where the first has a strictly higher ignored ratio than the second, returns a weight for the first that is less than or equal to the weight for the second.
10. `[unit]` Calling `deriveProviderWeights` with any input returns no weight greater than `1.0`.
11. `[unit]` Calling `deriveProviderWeights` for a provider whose every classified chunk is `ignored` returns a weight greater than zero.
12. `[unit]` Calling `deriveProviderWeights` with a manifest that has `chunkEffectiveness` but no `chunkProviders` returns weight `1.0` for every provider id queried.
13. `[unit]` Calling `deriveProviderWeights` where one manifest in the list is malformed returns weights derived from the remaining well-formed manifests and does not throw.
14. `[unit]` Calling `deriveProviderWeights` on manifests whose only `ignored` verdicts belong to providers of a `FLOOR_KINDS` chunk kind still returns a weight for those providers — the derivation does not special-case floor kinds.

**Out of scope:** US-003 only: consuming the `followed`, `contradicted` or `unknown` verdicts — only `ignored` contributes to the ratio.

### US-004 — Wire weights into scoring

1. `[unit]` Calling `scoreChunk` for a chunk whose `providerId` has a weight below `1.0` in the supplied weights returns a score equal to the score computed without weights multiplied by that weight.
2. `[unit]` Calling `scoreChunk` for a chunk whose `providerId` is absent from the supplied weights returns the same score as calling it with no weights supplied.
3. `[unit]` Calling `scoreChunk` with no weights supplied returns the same score as before this feature for the same chunk, role and minimum score.
4. `[unit]` Calling `scoreChunks` with a weights mapping applies each chunk's own provider weight, so two chunks from different providers with equal `rawScore`, kind and role receive different scores when their providers' weights differ.
5. `[integration]` Assembling context where a `static`-kind chunk's provider carries a weight low enough to put its score below the minimum score returns a bundle whose manifest lists that chunk in `includedChunks` and not in `excludedChunks`.
6. `[integration]` Assembling context where a `neighbor`-kind chunk's provider carries a weight low enough to put its score below the minimum score returns a manifest listing that chunk in `excludedChunks` with reason `below-min-score`.
7. `[integration]` Stubbing `deriveProviderWeights` to return a known weight mapping and invoking `contextStage.execute` with a pipeline context whose `config.context.v2.enabled` is true results in `deriveProviderWeights` being invoked once.
8. `[integration]` Stubbing `deriveProviderWeights` to return a weight below `1.0` for a non-floor provider and invoking `contextStage.execute` with `config.context.v2.enabled` true produces a written manifest in which that provider's chunk scores strictly lower than the same run with the stub returning weight `1.0`.
9. `[unit]` Constructing a `ContextRequest` without `providerWeights` and passing it to the orchestrator produces a bundle identical to the pre-feature behaviour for the same providers and budget.

**Out of scope:** US-004 only: clamping or validating weights at the consumption site — `deriveProviderWeights` owns the clamp, and the scorer applies whatever mapping it is given.
