<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Curator observation axes and rollup retention

## Summary

Give the curator's chunk-observation stream the classification axes its heuristics need,
label its proposal file with the provenance it actually has, and bound the growth of the
cross-run rollup. Three defects that each independently stop the curator's largest
observation population from producing a usable proposal.

Closes #1930, #1931, #1445.

## Motivation

### 1. The chunk half of the observation stream feeds nothing (#1931)

`h5StaleChunk` (`src/plugins/builtin/curator/heuristics.ts:323`) filters `chunk-excluded`
observations on `reason === "stale"`. No producer emits that reason: `manifest-builder.ts:107-110`
emits `role-filter`, `below-min-score`, `dedupe` and `budget`, and `rebuild.ts:205` emits
`budget`. The heuristic cannot fire at any threshold.

The staleness signal itself is live, not dead. `applyStaleness` (`src/context/engine/staleness.ts:237`)
sets `staleCandidate: true` and a `scoreMultiplier`; `scoring.ts:108` honours it. Staleness
**demotes a chunk's score** — it never excludes it, and the exclusion site records only the
mechanical cause. The staleness attribution is simply lost.

Which exclusion paths a stale chunk can actually reach is narrower than it first appears, and the
narrowing is the reason this ships attribution rather than activation. `applyStaleness` has exactly
two callers (`src/context/engine/providers/feature-context.ts:292,309`), and every chunk they emit
is `kind: "feature"` (`:259`, `:284`, `:385`). `feature` is a floor kind
(`src/context/engine/packing.ts:54`), and floor kinds are exempt from both budget eviction —
`budgetExcludedIds` is built only from the non-floor partition (`packing.ts:119-132`, `:178`,
`:260-268`) — and the min-score filter (`src/context/engine/orchestrator.ts:396`). A stale chunk
can therefore only be excluded by **dedupe** (`orchestrator.ts:384`, which has no floor exemption)
or **role-filter** (feature chunks carry `role: ["implementer", "reviewer", "tdd"]`, not `"all"`).

Separately, chunk observations carry no grouping axis at all: `ChunkIncludedObservation.payload`
is `{ chunkId, label, tokens }` and `ChunkExcludedObservation.payload` is `{ chunkId, label, reason? }`
(`curator/types.ts:54-71`). In the measured `acp-catalog-pricing` run, 1,202 of 1,294 observations
(93%) were `chunk-included` and fed no heuristic. `chunkProviders` is already persisted onto the
manifest (`manifest-builder.ts:152`) and the emitter drops it.

### 2. The proposal file claims a provenance it does not have (#1930)

`curator/index.ts:121-124` runs heuristics over a 20-run rollup window, using the current run's
observations only as a fallback when that window is empty. `render.ts:36` then heads the output
with `run <runId> · <N> observations`, where `N` is this run's count. Two runs ten hours apart
(`acp-catalog-pricing`, 1,294 observations; `ledger-and-audit-field-truth`, 843) produced proposal
files whose bodies were byte-identical and whose headers differed. A file headed "1294 observations"
contained nothing derived from those 1,294 observations. `docs/guides/curator.md:151` reinforces the
wrong reading with a sample header reading `# Curator proposals — run abc123`.

Compounding: `h5`'s sibling `h6` groups fix-cycle iterations by the composite key `featureId/storyId`
(`heuristics.ts:365`) and then discards the prefix when building the proposal
(`heuristics.ts:398`, `storyIds: [storyId]`). Rendered bare, `US-001` from another feature reads as
the current run's own story.

### 3. The rollup grows without bound (#1445)

`pruneRollup` is reachable only from the manual `nax curator gc` subcommand
(`src/commands/curator.ts:565`), while `appendToRollup` runs after every run
(`curator/index.ts:104`). The rollup grows on every run and shrinks only when a human remembers
to type a command. On the machine in #1430 it reached 219 MB, of which roughly 155 MB (~71%) sat
past `MAX_WINDOW_TAIL_BYTES` (`rollup.ts:29`, 64 MB) and could never influence a heuristic again.
Appending unconditionally while pruning only on manual invocation is not a retention policy.

## Design

Three independent mechanisms, sharing one subsystem.

**Staleness is an axis, not a reason.** The mechanical cause of an exclusion (`budget`,
`below-min-score`, `dedupe`, `role-filter`) and the fact that the chunk was stale are orthogonal
facts, and the current `reason` union conflates them by offering `"stale"` as a fifth alternative.
Adding a separate `stale` flag preserves both facts; overwriting `reason` would destroy the
mechanical cause. The `"stale"` member of the union is therefore removed — nothing produces it and
nothing will.

The flag is stamped **uniformly on all five exclusion-stamping sites** — the four mappings inside
`buildManifest` plus the inline construction in `rebuild.ts` — so the contract does not depend on
which paths production happens to reach today. Production reachability is narrower than that
contract: per the Motivation, only `dedupe` and `role-filter` can carry a stale chunk. The unit
criteria below pin the uniform stamping; the single integration criterion drives the one path a
real stale chunk can reach.

**The provider is the grouping axis.** `chunkProviders` is already persisted, so carrying `provider`
onto both chunk observations is plumbing, not new state. `ChunkKind` is deliberately **not**
persisted: it is load-bearing in memory (`scoring.ts:31` `KIND_WEIGHTS`, and the floor logic in
`packing.ts`) and for every built-in provider it is near-1:1 with the provider id
(`git-history`→`history`, `lint-config`→`lint-config`, `test-coverage`→`test-coverage`,
`static-rules`→`static`), so persisting it would buy a second axis that mostly duplicates the first.

**Pruning is size-gated.** `pruneRollup` is a two-pass, project-scoped, full-file rewrite under a
path lock, and `scanProjectRunIds` full-scans the file before it. Running that after every run is
not affordable. Reading `Bun.file(path).size` is effectively free, so the post-run hook reads the
size first and does nothing below the threshold. The threshold and keep-count are configuration,
not literals, so they are tunable and testable.

### Integration

Symbols this feature **changes** — the baseline is given only to locate the code, and is never the
interface to implement:

**`ContextManifest["excludedChunks"]` element** (`src/context/engine/manifest-types.ts:150`)
- Baseline: `{ id: string; reason: "below-min-score" | "budget" | "dedupe" | "role-filter" | "stale" }`
- Target: `{ id: string; reason: "below-min-score" | "budget" | "dedupe" | "role-filter"; stale?: boolean }`

**`buildManifest(inputs: ManifestInputs)`** (`src/context/engine/manifest-builder.ts:49`)
- Baseline: `ManifestInputs` carries `roleFiltered`, `belowMin` (chunk objects) and `dedupeDropped`,
  `budgetExcludedIds` (id strings), with no staleness input.
- Target: `ManifestInputs` additionally carries `staleIds: ReadonlySet<string>`. Each of the four
  exclusion mappings stamps `stale: staleIds.has(id)`. `reason` is unchanged on every path.
- Note for the caller: `buildManifest` has exactly one production caller,
  `src/context/engine/orchestrator.ts:446`. The set is derived there from `scored`, which is in
  scope at `:444` and is documented there as a superset of every chunk that reaches the exclusion
  lists.

**`rebuild.ts` inline exclusion construction** (`src/context/engine/rebuild.ts:203-205`) — the
fifth stamping site. `rebuild.ts` does **not** call `buildManifest`; it builds the field itself.
- Baseline: `packResult.budgetExcludedIds.filter(...).map((id) => ({ id, reason: "budget" as const }))`
- Target: the same mapping additionally stamps `stale`, derived from the `packedChunks` in scope at
  `rebuild.ts:121`, which carry `staleCandidate`.

**`ChunkIncludedObservation.payload`** (`src/plugins/builtin/curator/types.ts:54-61`)
- Baseline: `{ chunkId: string; label: string; tokens: number }`
- Target: `{ chunkId: string; label: string; tokens: number; provider?: string }`

**`ChunkExcludedObservation.payload`** (`src/plugins/builtin/curator/types.ts:64-71`)
- Baseline: `{ chunkId: string; label: string; reason?: string }`
- Target: `{ chunkId: string; label: string; reason?: string; provider?: string; stale?: boolean }`

**`h5StaleChunk`** (`src/plugins/builtin/curator/heuristics.ts:320-353`)
- Baseline: selects `chunk-excluded` observations where `payload.reason === "stale"`.
- Target: selects `chunk-excluded` observations where `payload.stale === true`. Its
  `staleChunkRuns` threshold and cross-run grouping by `chunkId` are unchanged.

**`renderProposals`** (`src/plugins/builtin/curator/render.ts:30`)
- Baseline: `renderProposals(proposals, runId, observationCount)`, header
  `> generated at <ts> · run <runId> · <N> observations`.
- Target: `renderProposals(proposals, runId, observationCount, provenance?)` where `provenance` is
  `{ runCount: number; observationCount: number }` describing the heuristic window. The header
  states the window the proposals derive from and the run's own count separately, so neither fact
  is lost.
- **The fourth parameter is optional, and this is load-bearing.** There are two production callers
  — `curator/index.ts:125` (the post-run path, which has a window) and `src/commands/curator.ts:526`
  inside `curatorDryrun` (which runs heuristics over a single run's `observations.jsonl` at
  `:522-525` and has no window to report). A required parameter would break the dryrun caller and
  all 18 existing call sites in `test/unit/plugins/builtin/curator-render.test.ts` under the wired
  `tsconfig.test.json` typecheck gate. Omitted, `provenance` defaults to
  `{ runCount: 1, observationCount }` — the single-run reading, which is exactly correct for the
  dryrun.
- Existing header assertions in `curator-render.test.ts` (`:28` `"generated at"`, `:35` `"42"`,
  `:103` `"10"`, `:198` `"run-abc-123"`, `:204` `"1000000"`) survive because the run's own count
  stays in the header. That is a requirement, not a coincidence — see US-003 AC2.

**`h6` proposal `storyIds`** (`src/plugins/builtin/curator/heuristics.ts:398`)
- Baseline: `storyIds: [storyId]`, discarding the `featureId` the grouping key already carries.
- Target: `storyIds: ["<featureId>/<storyId>"]`, the same composite key the group was built under
  at `heuristics.ts:365`.

**`CuratorConfigSchema`** (`src/config/schemas-infra.ts:451`) and **`CuratorConfig`**
(`src/config/runtime-types.ts:583`)
- Baseline: `{ enabled, rollupPath?, thresholds }`.
- Target: additionally `retention?: { pruneThresholdBytes: number; keepRuns: number }` — optional on
  the interface, mirroring the existing `enabled?`, `rollupPath?` and `thresholds?`, with zod
  defaults `67108864` (64 MiB, the value of `MAX_WINDOW_TAIL_BYTES`) and `50` (the value of
  `DEFAULT_KEEP` at `src/commands/curator.ts:533`).
- **File-size constraint, and why it forces a move rather than an addition:**
  `src/config/runtime-types.ts` is at exactly 600 lines, the hard `SRC_LIMIT` in
  `scripts/check-file-sizes.ts:30`, and is **not** grandfathered in
  `scripts/baselines/file-sizes-baseline.json`, so it cannot grow by even one line. Adding
  `retention` to `CuratorConfig` in place, plus an import and a re-export line, would take it to
  603 and leave `quality.commands.lint` permanently red with no legal move available to the
  implementer.
  The resolution is a net reduction. `CuratorThresholds` (`:574-581`) and `CuratorConfig`
  (`:583-590`) move **wholesale** into a new leaf file `src/config/runtime-types-curator.ts`,
  joining the new `CuratorRetentionConfig`, and the vacated seventeen lines are replaced by one
  block: `export type { CuratorConfig, CuratorRetentionConfig, CuratorThresholds } from "./runtime-types-curator";`.
  That takes the file to roughly 584. Note the existing re-export at `:591-600` carries a
  different `from` clause (`./runtime-types-agent`), so the new names cannot be folded into it.
  Every *external* importer of `@/config/runtime-types` keeps working through the re-export — the
  only one is `src/config/types.ts:30`, a re-export chain that resolves.
  **One in-file reference must also change, and a re-export does not cover it.**
  `runtime-types.ts:564` reads `curator?: CuratorConfig;` inside `NaxConfig`, and a bare
  `export type { … } from "./runtime-types-curator";` does not bind the name in local scope, so
  that line becomes an unresolved-name error. Rewrite it as
  `curator?: import("./runtime-types-curator").CuratorConfig;`, the idiom its four immediate
  neighbours already use (`mcp?`, `project?`, `debate?`, `autoPr`). This is net zero lines, so the
  ~584 budget above still holds.

**Plugin-side size gate** (new, `src/plugins/builtin/curator/auto-prune.ts`)
- Baseline: none. `pruneRollup` requires `projectKey` and a `keepRunIds: ReadonlySet<string>`
  (`rollup-prune.ts:72-84`) that only `scanProjectRunIds(rollupPath, projectKey)`
  (`rollup-prune.ts:55`) can produce in most-recent-first order, and its `PruneResult`
  (`rollup-prune.ts:32`) has no failure channel.
- Target: `maybePruneRollup(input: { rollupPath: string; projectKey: string; retention: CuratorRetentionConfig }): Promise<{ pruned: boolean; result?: PruneResult; error?: string }>`.
  It reads the size via `Bun.file(input.rollupPath).size`, returns `{ pruned: false }` unchanged
  when the size is at or below `retention.pruneThresholdBytes`, and otherwise derives `keepRunIds`
  from the first `retention.keepRuns` ids of `scanProjectRunIds` before calling `pruneRollup`.
  A rejection from either call is caught and reported on `error` with `pruned: false`.
  `projectKey` is available at the production call site on `CuratorPostRunContext`
  (used at `curator/index.ts:108`).

**Plugin-side retention resolver** (new, `src/plugins/builtin/curator/auto-prune.ts`)
- Baseline: none. `PostRunContext.config` is typed `config?: unknown`
  (`src/plugins/extensions.ts:263`), so the zod default never reaches the post-run site. The
  existing plugin hand-rolls its own defaults for the same reason — `DEFAULT_THRESHOLDS`
  (`curator/index.ts:22-29`) and `getCuratorThresholds` (`:51-64`).
- Target: a `DEFAULT_RETENTION` constant and a `getCuratorRetention(context)` resolver mirroring
  that pair, so the post-run site resolves the same two defaults the schema declares.

Symbols this feature only **reads**, verified at these signatures:

- `applyStaleness(chunk, { isStale, scoreMultiplier })` → `RawChunk` — `src/context/engine/staleness.ts:232`
- `RawChunk.staleCandidate?: boolean` — `src/context/engine/types.ts:509`
- `ContextOrchestrator.assemble(request: ContextRequest): Promise<ContextBundle>` — `src/context/engine/orchestrator.ts:193`; calls `buildManifest` at `:446`
- `ContextManifest.chunkProviders?: Record<string, string>` — `src/context/engine/manifest-types.ts:319`
- `pruneRollup(input: PruneRollupInput): Promise<PruneResult>` — `src/plugins/builtin/curator/rollup-prune.ts:94`
- `scanProjectRunIds` — `src/plugins/builtin/curator/rollup-prune.ts`, exported alongside `pruneRollup`
- `readHeuristicWindow(rollupPath, windowRuns, { projectKey })` returning `{ observations, runIds, truncated, unattributedRows }` — `src/plugins/builtin/curator/rollup.ts:180`
- `MAX_WINDOW_TAIL_BYTES = 64 * 1024 * 1024` — `src/plugins/builtin/curator/rollup.ts:29`
- `DEFAULT_KEEP = 50` — `src/commands/curator.ts:533`

Patterns to follow: the injectable-dependency object (`_orchestratorDeps` in
`src/context/engine/orchestrator.ts`, `_curatorCmdDeps` in `src/commands/curator.ts`) is this
repo's substitute for module mocking, which is forbidden. File size is read with
`Bun.file(path).size`, the idiom already used at `src/plugins/builtin/curator/rollup.ts:187-189`.

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| Reading the rollup's size throws (file absent, permission denied) | Treat as below threshold: skip pruning, `logger.warn`, return success. The curator is an observer; it must not fail a run that otherwise succeeded. |
| `pruneRollup` throws mid-prune | Catch, `logger.warn` with the error message, return success from the post-run action. The rollup's own two-phase rename leaves the original intact. |
| The manifest carries no `chunkProviders` entry for a chunk | `provider` is omitted from that observation rather than set to a placeholder. |
| The heuristic window is empty and the current run's observations are used instead | The rendered provenance describes that fallback (one run) rather than claiming a 20-run window. |

## Out of Scope

- Changing what `applyStaleness`, `detectContradictions` or `selectStaleByAge` classify as stale. This feature only
  attributes an existing signal; the detection rules are untouched.
- Persisting `ChunkKind` onto the context manifest. It remains an in-memory field consumed by
  scoring and packing, and is neither persisted nor removed.
- Deleting per-run curator artifacts (`observations.jsonl`, `curator-proposals.md`) from evicted
  run directories in the automatic prune path. That deletion stays exclusive to the manual
  `nax curator gc` subcommand; the automatic path prunes rollup rows only.
- Changing the location, filename or markdown structure that `nax curator commit` and
  `nax curator show` parse out of `curator-proposals.md`. Only the header provenance line changes.
- Fixing H1 recurrence detection (nax#1863). It is closed by ruling and must not be reopened here.
- Retiring the human-readable prompt-audit `.txt` generation (nax#2155).
- Adding any new heuristic. H5 is retargeted and H6 is corrected; no seventh heuristic is introduced.

## Stories

**US-001 — Attribute staleness on excluded chunks** (no dependencies)
Add the orthogonal `stale` flag to the manifest's excluded-chunk entries, fed by a stale-id set the
callers already have in hand, and remove the never-produced `"stale"` member of the `reason` union.

**US-002 — Carry provider onto chunk observations and staleness onto excluded ones** (depends on US-001)
Forward `provider` (from the already-persisted `chunkProviders`) and `stale` onto both chunk
observations, and retarget `h5StaleChunk` from the dead `reason` check to the new flag.

**US-003 — Label proposals with their real provenance** (no dependencies)
Render the heuristic window's run count and observation count alongside the run's own count, and
restore the feature prefix that `h6` discards.

**US-004 — Size-gated automatic rollup pruning** (no dependencies)
Add curator retention configuration and a post-run prune that runs only when the rollup exceeds the
configured size, never failing the run.

US-003 and US-004 both modify `src/plugins/builtin/curator/index.ts` and must not run concurrently.

### Context Files

**US-001**
- `src/context/engine/manifest-builder.ts`
- `src/context/engine/manifest-types.ts`
- `src/context/engine/orchestrator.ts`
- `src/context/engine/rebuild.ts`
- `src/context/engine/staleness.ts`

**US-002**
- `src/plugins/builtin/curator/types.ts`
- `src/plugins/builtin/curator/collect.ts`
- `src/plugins/builtin/curator/heuristics.ts`
- `src/context/engine/manifest-types.ts`

**US-003**
- `src/plugins/builtin/curator/render.ts`
- `src/plugins/builtin/curator/heuristics.ts`
- `src/plugins/builtin/curator/index.ts`
- `src/plugins/builtin/curator/rollup.ts`
- `src/commands/curator.ts`

**US-004**
- `src/plugins/builtin/curator/index.ts`
- `src/plugins/builtin/curator/rollup-prune.ts`
- `src/config/schemas-infra.ts`
- `src/config/runtime-types.ts`
- `src/plugins/builtin/curator/rollup.ts`

### Creates

**US-002**
- `test/unit/plugins/builtin/curator-collector-chunk-axes.test.ts` — a new test file for this story's collector criteria. `test/unit/plugins/builtin/curator-collector.test.ts` is at 748 of the 800-line test limit and is not grandfathered, so it has no room for six new criteria.

**US-004**
- `src/config/runtime-types-curator.ts` — the new `CuratorRetentionConfig` interface **together with** `CuratorThresholds` and `CuratorConfig` moved out of `runtime-types.ts`, which sits at its 600-line hard limit and is not grandfathered. Moving all three and replacing them with a single re-export block is a net reduction; adding the field in place is not possible.
- `src/plugins/builtin/curator/auto-prune.ts` — the size gate, the `DEFAULT_RETENTION` / `getCuratorRetention` resolver, and the injectable dependency object, kept out of `index.ts`.
- `test/unit/plugins/builtin/curator-auto-prune.test.ts`

### Modifies

**US-001**
- `test/unit/context/engine/rebuild.test.ts` — line 370 asserts `expect(rebuilt.manifest.excludedChunks).toEqual([{ id: "drop", reason: "budget" }])`, a closed-world equality on an excluded-chunk element. The replacing invariant: the rebuilt budget exclusion carries `stale: false` alongside its unchanged `reason`, because the flag is stamped on every exclusion path whether or not the chunk is stale.

- `test/unit/context/engine/manifest-builder.test.ts` — its `makeInputs` factory at line 48 is annotated `(overrides: Partial<ManifestInputs> = {}): ManifestInputs`, so it must supply every required member; adding `staleIds` breaks it across 12 `buildManifest` call sites. The replacing invariant: `makeInputs` supplies `staleIds: new Set()` by default, overridable per test.
- `test/unit/context/engine/manifest-builder-us003.test.ts` — its `makeInputs` factory at line 51 carries the same `: ManifestInputs` return annotation, breaking across 9 `buildManifest` call sites. The replacing invariant: `makeInputs` supplies `staleIds: new Set()` by default, overridable per test.
- `test/unit/context/engine/manifest-builder-eviction.test.ts` — its `makeInputs` factory at line 42 carries the same `: ManifestInputs` return annotation, breaking across 6 `buildManifest` call sites. The replacing invariant: `makeInputs` supplies `staleIds: new Set()` by default, overridable per test.

**US-002**
- `test/unit/plugins/builtin/curator-heuristics-h4-h6.test.ts` — its H5 fixtures at lines 146 and 157 construct `chunk-excluded` payloads with `reason: "stale"` to make the heuristic fire. The replacing invariant: H5 fires on `payload.stale === true`, and `reason` on those fixtures carries the mechanical cause instead.
- `test/unit/plugins/builtin/curator-collector.test.ts` — its fixture at line 327 writes `excludedChunks: [{ id: "rules:def", reason: "stale" }]` into a manifest file and line 410 asserts the emitted observation has `payload.reason === "stale"`. Both sit in the same test. The replacing invariant: the fixture expresses staleness as `stale: true` alongside the mechanical reason that excluded the chunk, and the assertion reads `payload.stale === true`. Note the fixture at line 327 is inside a `JSON.stringify` call and so is invisible to the typecheck gate — it will not fail the build, and must be changed deliberately.

**US-003**
- `test/unit/plugins/builtin/curator-render.test.ts` — 18 existing call sites pass `renderProposals` three arguments, and lines 28, 35, 103, 198 and 204 assert substrings of the current header. The replacing invariant: the three-argument form keeps working via the optional fourth parameter, the run's own observation count remains in the header, and this story's new criteria are added to this file. Lines 99-105 additionally assert on the zero-proposal line at `render.ts:40`, which still reads "No heuristics fired for this run" — the same per-run misattribution this story corrects — and must be reworded with it.
- `docs/guides/curator.md` — line 148 states "Each run produces a proposal file" and line 151 shows a sample header carrying only a run id, both of which teach the per-run reading this story corrects. The replacing invariant: the guide states that proposals derive from the rolling heuristic window and shows the corrected header.

**US-004**
None. Curator retention configuration is new, no existing test asserts that the post-run action leaves the rollup unpruned, and the new leaf type file means no existing config file changes shape.

### Seams

- **US-001 → the context assembly pipeline.** `buildManifest` gains a required input, so the
  production caller at `orchestrator.ts:446` must supply it. US-001's integration criterion drives
  `ContextOrchestrator.assemble` and asserts the resulting manifest carries the flag — not that the
  call site exists. It uses the `dedupe` exclusion path, the one a real stale chunk can reach.
- **US-002 → H5.** The emitters are the producer and `h5StaleChunk` the consumer; US-002 asserts
  the heuristic fires on observations produced by the real emitter, not on hand-built fixtures alone.
- **US-004 → the curator post-run action.** `maybePruneRollup` is a new exported symbol whose only
  production caller is the curator plugin's `execute`. The seam is guarded by the size threshold,
  so it carries both a fires-above-threshold criterion and a does-not-fire-below-threshold one.
  The rollup block in `curator/index.ts:87` is additionally wrapped in `if (context.outputDir)`,
  so every integration criterion for this story must supply a context with `outputDir` set — the
  fires-above criterion fails without it, and the does-not-fire criterion would otherwise pass
  vacuously.

## Acceptance Criteria

### US-001 — Attribute staleness on excluded chunks

Criteria 1-6 pin the stamping contract on `buildManifest`, a pure function, using supplied inputs;
they hold on every exclusion path whether or not production can reach it with a real stale chunk.
Criterion 7 is the production path.

1. `[unit]` Calling `buildManifest` with `staleIds` containing an id that also appears in `budgetExcludedIds` yields an `excludedChunks` entry for that id whose `stale` is `true`.
2. `[unit]` Calling `buildManifest` with `staleIds` containing an id that also appears in `budgetExcludedIds` yields an `excludedChunks` entry for that id whose `reason` is `"budget"` — the mechanical cause is preserved, not replaced.
3. `[unit]` Calling `buildManifest` with an id in `staleIds` that also appears in `belowMin` yields an `excludedChunks` entry for that id whose `stale` is `true`.
4. `[unit]` Calling `buildManifest` with an id in `staleIds` that also appears in `dedupeDropped` yields an `excludedChunks` entry for that id whose `stale` is `true`.
5. `[unit]` Calling `buildManifest` with an id in `staleIds` that also appears in `roleFiltered` yields an `excludedChunks` entry for that id whose `stale` is `true`.
6. `[unit]` Calling `buildManifest` with an empty `staleIds` set yields every `excludedChunks` entry with `stale` equal to `false`.
7. `[integration]` Driving `ContextOrchestrator.assemble` with two providers whose chunk contents have a trigram Jaccard similarity at or above `SIMILARITY_THRESHOLD` (`src/context/engine/dedupe.ts:21`, `0.9` — identical content satisfies this), the lower-scoring of which `applyStaleness` has marked `staleCandidate: true` with a `scoreMultiplier` below `1`, yields a bundle whose manifest has an `excludedChunks` entry for the dropped chunk with `stale` `true` and `reason` `"dedupe"`.
8. `[unit]` Driving the rebuild path with a packed chunk carrying `staleCandidate: true` that the budget excludes yields a rebuilt manifest whose `excludedChunks` entry for that chunk has `stale` `true`.
9. `[unit]` Driving the rebuild path with a packed chunk carrying no `staleCandidate` that the budget excludes yields a rebuilt manifest whose `excludedChunks` entry for that chunk has `stale` `false`.

**Verification note:** removing the `"stale"` member from the `reason` union is an absence, not a runtime behaviour. It is verified by the build/static gate — `bun x tsc --noEmit` and `bun x tsc --noEmit -p tsconfig.test.json`, both wired in `quality.commands.typecheck`. Note the gate has little to catch: the only typed reference to the member is its own declaration at `manifest-types.ts:150`, and the one fixture using the string (`curator-collector.test.ts:327`) sits inside a `JSON.stringify` call and is untyped. The removal's blast radius is nil by measurement, not by assumption.

**Out of scope (US-001 only):** making a stale chunk reachable by the budget or min-score exclusion paths. Stale chunks are always `kind: "feature"`, a floor kind exempt from both by deliberate design (`packing.ts:54`, `orchestrator.ts:396`), and changing that exemption reopens a settled budget-floor decision well outside this feature.

### US-002 — Carry provider onto chunk observations and staleness onto excluded ones

1. `[unit]` Collecting observations from a manifest whose `chunkProviders` maps an included chunk id to `"static-rules"` yields a `chunk-included` observation for that chunk whose `payload.provider` is `"static-rules"`.
2. `[unit]` Collecting observations from a manifest whose `chunkProviders` has no entry for an included chunk yields a `chunk-included` observation for that chunk with `payload.provider` absent.
3. `[unit]` Collecting observations from a manifest whose `chunkProviders` maps an excluded chunk id to `"git-history"` yields a `chunk-excluded` observation for that chunk whose `payload.provider` is `"git-history"`.
4. `[unit]` Collecting observations from a manifest whose `excludedChunks` entry carries `stale: true` yields a `chunk-excluded` observation whose `payload.stale` is `true`.
5. `[unit]` Collecting observations from a manifest whose `excludedChunks` entry carries `stale: false` yields a `chunk-excluded` observation whose `payload.stale` is `false`.
6. `[unit]` Running the heuristics over `chunk-excluded` observations for one chunk id carrying `payload.stale === true` across a number of distinct runs equal to the `staleChunkRuns` threshold produces an `H5` proposal naming that chunk id.
7. `[unit]` Running the heuristics over `chunk-excluded` observations for one chunk id carrying `payload.stale === false` across the same number of runs produces no `H5` proposal.
8. `[integration]` Collecting observations from a manifest whose excluded chunk carries `stale: true`, then running the heuristics over the collected observations across enough distinct runs to meet the `staleChunkRuns` threshold, produces an `H5` proposal — the emitter and the heuristic agree on the field without a hand-built fixture between them.

### US-003 — Label proposals with their real provenance

1. `[unit]` Calling `renderProposals` with a provenance whose `runCount` is `20` and `observationCount` is `4000`, and a run observation count of `1294`, returns markdown whose header states both `20` runs and `4000` window observations.
2. `[unit]` Calling `renderProposals` with the same arguments returns markdown whose header also states the run's own count of `1294`, distinctly from the window's count.
3. `[unit]` Calling `renderProposals` with a provenance whose `runCount` is `1` returns markdown whose header states one run — the empty-window fallback is described as such, not as a 20-run window.
4. `[unit]` Running the heuristics over fix-cycle iteration observations carrying `featureId` `"context-providers-22"` and `storyId` `"US-001"`, enough consecutive `unchanged` outcomes to meet the `unchangedOutcome` threshold, produces an `H6` proposal whose `storyIds` contains `"context-providers-22/US-001"`.
5. `[unit]` Running the heuristics over fix-cycle iteration observations for `storyId` `"US-001"` under two different `featureId` values, each meeting the `unchangedOutcome` threshold, produces two distinct `H6` proposals whose `storyIds` differ.
6. `[integration]` Executing the curator post-run action, with a context whose `outputDir` is set, against a rollup holding observations from more than one run writes a `curator-proposals.md` whose header states the window's run count rather than `1`.
7. `[unit]` Calling `renderProposals` with only three arguments returns markdown whose header states one run and a window observation count equal to the run's own count — the default that keeps the single-run dryrun caller correct.
8. `[integration]` Executing the curator post-run action, with a context whose `outputDir` is set, against an empty rollup writes a `curator-proposals.md` whose header states one run and a window observation count equal to this run's own observation count — the empty-window fallback reports the run it actually used, not the zero runs the window returned.
9. `[unit]` Calling `renderProposals` with an empty proposal list returns markdown whose no-heuristics-fired line attributes the observation count to the heuristic window rather than to this run.

### US-004 — Size-gated automatic rollup pruning

1. `[unit]` Parsing a curator configuration through `CuratorConfigSchema` with `retention.pruneThresholdBytes` unset yields `67108864`.
2. `[unit]` Parsing a curator configuration through `CuratorConfigSchema` with `retention.keepRuns` unset yields `50`.
3. `[unit]` Calling `maybePruneRollup` against a rollup file whose size exceeds the configured `pruneThresholdBytes` invokes `pruneRollup` once, with `keepRunIds` holding at most `keepRuns` entries.
4. `[unit]` Calling `maybePruneRollup` against a rollup file whose size is below the configured `pruneThresholdBytes` does not invoke `pruneRollup`.
5. `[unit]` Calling `maybePruneRollup` against a rollup file whose size exactly equals the configured `pruneThresholdBytes` does not invoke `pruneRollup` — the gate opens above the threshold, not at it.
6. `[unit]` Calling `maybePruneRollup` when `pruneRollup` rejects returns a result reporting the failure rather than propagating the rejection.
7. `[unit]` Calling `maybePruneRollup` against a rollup path that does not exist does not invoke `pruneRollup` and returns without rejecting.
8. `[integration]` Executing the curator post-run action, with a context whose `outputDir` is set, against a rollup larger than the configured `pruneThresholdBytes` invokes `pruneRollup` once.
9. `[integration]` Executing the curator post-run action, with a context whose `outputDir` is set, against a rollup smaller than the configured `pruneThresholdBytes` does not invoke `pruneRollup`.
10. `[integration]` Executing the curator post-run action, with a context whose `outputDir` is set, when `pruneRollup` rejects returns a post-run action result whose `success` is `true`.
11. `[integration]` Executing the curator post-run action, with a context whose `outputDir` is set, against a rollup exceeding the threshold leaves `observations.jsonl` and `curator-proposals.md` present in the run directories of runs the prune evicted — artifact deletion remains exclusive to the manual `gc` subcommand.
12. `[unit]` Calling `getCuratorRetention` with a post-run context carrying no curator configuration yields `pruneThresholdBytes` `67108864` and `keepRuns` `50` — the post-run site resolves the same defaults the schema declares, since `PostRunContext.config` is untyped and the schema default cannot reach it.

**Out of scope (US-004 only):** concurrent invocation of the automatic prune and `nax curator gc` against the same rollup. Both already serialise through the path-keyed file lock that `pruneRollup` and `appendToRollup` share (`rollup-prune.ts:100`), and this story adds no new concurrency surface.
