# SPEC: Context Bundle Truth

## Summary

The context engine's assembled bundle reports framing and budget numbers it does not honour. `assemble()` already applies the target agent's profile to the packing ceiling and to pull-tool gating, but **not** to the push markdown's framing — it always emits Claude's markdown sections, even though `ContextRequest.agentId` is documented to select the agent's rendering profile. `rebuildForAgent()` re-renders a prior bundle without re-packing it, so an agent swap hands a small-window agent the previous agent's larger payload, and the manifest then records a ceiling that payload provably exceeds. Packing itself documents that its density heuristic needs the bounded AC-7 repair. This feature makes each of those three numbers true: the framing matches the target agent, the rebuilt payload fits the target agent's ceiling, and packing applies the specified repair without an unbounded search.

## Motivation

Three defects, all "the engine reports something it does not deliver", all verified against `main` @ `dbeaacb4`:

1. **A codex-first run never receives codex framing.** `src/context/engine/types.ts:292-297` documents `ContextRequest.agentId` as: *"When set, bundle.agentId is populated and renderForAgent() uses this profile for the push markdown framing."* The second half is false. `assemble()` step 8 (`orchestrator.ts:423`) calls `renderChunks(packed, …)` unconditionally — the markdown-sections renderer. `renderForAgent` is reachable from exactly one call site, `orchestrator.ts:522`, inside `rebuildForAgent`.

   The rest of the profile *is* already load-bearing on the assemble path, and this story must not disturb it: the packing ceiling is already `min(stage budget, preferredPromptTokens)` (`orchestrator.ts:222`, covered by `orchestrator.test.ts:246-292`) and pull tools are already gated on `supportsToolCalls` (AC-33, covered by `orchestrator.test.ts:296-302`). Framing is the one capability the assemble path drops, so a run that starts on codex is framed for Claude for its entire life.

2. **A rebuild ignores the target agent's ceiling, then misreports it.** `rebuildForAgent` (`orchestrator.ts:485`) converts `prior.chunks` straight into packed chunks (`:503-513`, forcing `rawScore: c.score`, `belowMinScore: false`) and never calls `packChunks`. `usedTokens` comes from `rebuildUsedTokens` (`manifest-builder.ts:116`), which sums *every* prior chunk plus any injected failure note — nothing is ever dropped. Meanwhile `:568` records `effectiveBudget: Math.min(prior.manifest.effectiveBudget, targetProfile.caps.preferredPromptTokens)`. A claude→conservative-default swap therefore records a 8 000-token ceiling against an unchanged ~16 000-token payload: the manifest asserts a budget its own `usedTokens` violates, and `computeFloorOverage` in `src/metrics/tracker.ts` reads that ceiling.

3. **Packing documents its missing bounded repair.** `packing.ts:15-25` states that density-greedy needs a repair for adversarial inputs and names the permitted work: *"the standard 'best-of(greedy, largest single item that fits)' repair."* The bounded repair is missing, and deterministic property coverage does not yet verify the cases it is intended to handle.

## Design

### Integration

Verified symbols and signatures (all read from `main` @ `dbeaacb4`):

| Symbol | Location | Signature / shape |
|:---|:---|:---|
| `ContextEngine.assemble` | `src/context/engine/orchestrator.ts` | renders at step 8 via `renderChunks(packed, { priorStageDigest })` (`:423`) |
| `ContextEngine.rebuildForAgent` | `src/context/engine/orchestrator.ts:485` | `(prior: ContextBundle, options: RebuildOptions = {}) => ContextBundle` |
| `renderForAgent` | `src/context/engine/agent-renderer.ts:111` | `(chunks: PackedChunk[], agentId: string, options?: AgentRenderOptions) => string` |
| `renderChunks` | `src/context/engine/render.ts:87` | `(chunks: PackedChunk[], options?: RenderOptions) => string` |
| `packChunks` | `src/context/engine/packing.ts:82` | `(chunks: ScoredChunk[], budgetTokens: number, availableBudgetTokens?: number) => PackResult` |
| `PackResult` | `src/context/engine/packing.ts:56` | `{ packed, budgetExcludedIds, usedTokens, effectiveBudget, floorPackedIds, floorOverageIds }` |
| `FLOOR_KINDS` | `src/context/engine/packing.ts:36` | `["static", "feature", "test-coverage"]` — floor chunks are packed regardless of budget |
| `getAgentProfile` | `src/context/engine/agent-profiles.ts` | returns `{ profile }`; `profile.caps` carries `preferredPromptTokens`, `supportsToolCalls`, `systemPromptStyle` |
| `AGENT_PROFILES` | `src/context/engine/agent-profiles.ts` | registry keyed by agent id; unknown ids fall back to `CONSERVATIVE_DEFAULT_PROFILE` (`systemPromptStyle: "plain"`, `preferredPromptTokens: 8000`) |
| `rebuildUsedTokens` | `src/context/engine/manifest-builder.ts:116` | `(prior, packed, newPriorStageDigest) => number` — sums all prior chunks plus non-prior extras |
| `ContextRequest.agentId` | `src/context/engine/types.ts:297` | optional; documented at `:292-296` to drive `renderForAgent` |

Existing pattern to mirror: `rebuildForAgent` already resolves the target profile (`orchestrator.ts:549`) and already uses it to strip pull tools when `supportsToolCalls` is false (`:550`). Re-packing follows the same shape — resolve the profile once, apply its ceiling.

### Approach

- **Framing selection is a registry lookup, not a heuristic.** US-002 routes `assemble()`'s render step through the same `renderForAgent` the rebuild path already uses, keyed on `request.agentId`. When `request.agentId` is absent, behaviour is unchanged (`renderChunks`), so unconfigured repos see no difference.
- **Re-packing on rebuild reuses `packChunks`.** `PackedChunk extends ScoredChunk`, so the chunks reconstructed from `prior.chunks` are already valid `packChunks` input — no new scoring path is introduced. The rebuild ceiling is `min(prior.manifest.effectiveBudget, targetProfile.caps.preferredPromptTokens)`, the value `:568` already computes; the change is that it now *bounds the payload* instead of only being recorded.
- **`packChunks` is used for selection only; emission order stays the prior order.** `packChunks` returns floor chunks first and then non-floor chunks sorted by density, so its output order differs from `prior.chunks`. `rebuildInfo.chunkIdMap` is built by zipping `priorChunkIds` against the emitted chunks **by index** (`orchestrator.ts:537-542`), so adopting the packer's order would silently pair unrelated chunk ids. The rebuild must therefore take the *set* of chunks `packChunks` keeps and emit them in their original `prior.chunks` relative order, with any injected failure-note chunk kept last.
- **The rebuild recomputes floor-overage from its own pack result.** `rebuildForAgent` builds its manifest by spreading `...prior.manifest` and never calls `buildManifest`, so `floorOverageItems` (`manifest-types.ts:137`, normally filled from `PackResult.floorOverageIds` at `manifest-builder.ts:90`) currently carries the *prior* bundle's value. Once the rebuild packs, it must overwrite that field from the new `PackResult` — otherwise the manifest reports the previous agent's overage against the new agent's ceiling, which is the same class of untruth this feature exists to remove.
- **Stubbing goes through `_orchestratorDeps`, never `mock.module()`.** `mock.module()` is a forbidden pattern in this repo (it leaks globally in Bun and poisons other test files). `src/context/engine/orchestrator.ts:73` already exports `_orchestratorDeps = { now, uuid, getLogger }`; US-001 adds the extracted rebuild function to that object so the delegation seam can be stubbed the sanctioned way.
- **AC-7 uses the repair named in the source comment**, not a DP: `best-of(greedy, largest single item that fits)`. Applied to the non-floor pass only — floor chunks are exempt from the budget by `FLOOR_KINDS` and must stay exempt.
- **The repair changes the expected outcome of an existing shipped test, and US-004 owns that update.** `test/unit/context/engine/packing.test.ts:65-76` ("non-floor chunks are ordered by score density, not raw score", the #1448 regression test) packs `bulky` (score 0.9, 900 tokens) against `dense` (score 0.5, 100 tokens) at budget 900 and asserts `packed` is exactly `["dense"]`. That fixture is itself an AC-7 violation: `bulky` alone is feasible and scores 0.9, so greedy's 0.5 is 56% of optimal, and the repair must return `bulky`. Leaving the test unchanged would deadlock the story. US-004 therefore updates that fixture so it still discriminates a density sort from a raw-score sort **without** triggering the repair — two 100-token chunks scoring 0.5 each (jointly 1.0) against the same 900-token `bulky` (0.9) at budget 900: density packs both small chunks, raw-score packs only `bulky`, and no single item beats the greedy result.

#### Worked shape — the AC-7 property test (novel shape)

The repo has no property/fuzz test precedent (`test/unit/` contains no seeded-random or generator-based test), so the shape is specified here rather than left to pattern gravity. The generator must be deterministic — a fixed seed, not the platform RNG — so a failure is reproducible.

The generator creates two deterministic case classes. In the first, the
budget admits every item, so density-greedy is optimal. In the second, it
creates one feasible bulky item whose score exceeds the combined score of the
small items density-greedy selects, so the largest-single repair is optimal.
The exhaustive comparison is only a test oracle; production packing remains
the bounded greedy/largest-item repair.

Each of at least 200 fixed-seed cases is generated from that repair envelope: half have a budget large enough for every item, and half contain one feasible bulky item whose score exceeds the combined score of the small items density-greedy selects. The test compares the packed score with an exhaustive oracle to confirm at least 95% of the optimum for cases the bounded repair is intended to cover; production code never performs subset enumeration.

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| `request.agentId` names an agent absent from `AGENT_PROFILES` | Fail-open: render via the conservative default profile (`plain` framing) and log a warning — same posture `rebuildForAgent` already takes at `orchestrator.ts:490-496`. |
| A rebuild's target ceiling is smaller than the floor chunks alone | Floor chunks are still emitted in full (the `FLOOR_KINDS` rule is unchanged); the manifest records the overage through the existing `floorOverageIds` channel rather than silently truncating. |
| `prior.manifest.effectiveBudget` is absent on the prior bundle | Treat the prior ceiling as unbounded and use the target profile's `preferredPromptTokens` alone — matches the `?? Number.POSITIVE_INFINITY` already at `orchestrator.ts:569`. |

## Out of Scope

- Re-scoring chunks during a rebuild — `scoreChunks(chunks, callerRole, minScore)` requires `RawChunk[]` and a `callerRole`, and `ContextBundle` carries neither, so re-scoring needs a new carrier that this feature does not introduce.
- Re-running de-duplication (`dedupeChunks`) during a rebuild.
- Making `AgentCapabilities.supportsMarkdown` load-bearing — every profile in `AGENT_PROFILES` and `CONSERVATIVE_DEFAULT_PROFILE` sets it to `true`, so no observable behaviour can be tested against it today.
- Scoring-axis work: freshness, per-stage kind weights, and the semantic kind taxonomy.
- Per-provider soft budgets — the `IContextProvider.fetch` signature keeps its `(request, signal)` shape.
- Wiring `AgentResult.agentFallbacks` into `PipelineContext.agentFallbacks`, and emitting the `context.fallback.triggered` event.
- A cross-stage content cache for `CodeNeighborProvider` — `contentCache` stays per-fetch.
- Manifest prune, retention, or TTL in `manifest-store.ts`.
- Changes to the effectiveness classifier or `pollutionRatio`.
- The v2 write path (extractor, fragment writer, merger, summarization and promotion gates).
- Populating `ContextManifest.pullCalls`.
- Renaming `pull.maxCallsPerRun` to reflect its per-story-attempt scope.

## Stories

1. **US-001: Extract the rebuild path into its own module** — no dependencies
2. **US-002: `assemble()` frames the bundle for the requested agent** — no dependencies
3. **US-003: A rebuilt bundle fits, and reports, the target agent's ceiling** — depends on US-001
4. **US-004: Packing applies the bounded AC-7 repair** — no dependencies

### US-001 — Extract the rebuild path into its own module

`src/context/engine/orchestrator.ts` is 585 lines against the project's 600-line source limit, enforced by `bun run check:file-sizes` as a ratchet. US-003 cannot add re-packing to `rebuildForAgent` in place without breaching it. This story moves the rebuild logic into `src/context/engine/rebuild.ts` as an exported function and leaves `ContextEngine.rebuildForAgent` as a delegating wrapper. Behaviour is unchanged.

#### Context Files
- `src/context/engine/orchestrator.ts` — the `rebuildForAgent` method being moved
- `src/context/engine/manifest-builder.ts` — `rebuildUsedTokens`, called by the moved code
- `src/context/engine/agent-renderer.ts` — `renderForAgent`, called by the moved code
- `test/unit/context/engine/orchestrator-rebuild.test.ts` — existing rebuild coverage to keep green

#### Creates
- `src/context/engine/rebuild.ts` — the extracted rebuild implementation

### US-002 — `assemble()` frames the bundle for the requested agent

Route `assemble()`'s render step through `renderForAgent` when `request.agentId` is set, so the documented contract at `types.ts:292-296` becomes true. Absent `agentId`, the existing `renderChunks` path is kept.

#### Context Files
- `src/context/engine/orchestrator.ts` — render step 8 at `:423`
- `src/context/engine/agent-renderer.ts` — `renderForAgent` and its three styles
- `src/context/engine/agent-profiles.ts` — `AGENT_PROFILES`, `CONSERVATIVE_DEFAULT_PROFILE`
- `test/unit/context/engine/orchestrator.test.ts` — existing assemble coverage, including the profile-ceiling and pull-tool-gate tests this story must keep green

#### Creates
- `test/unit/context/engine/orchestrator-agent-framing.test.ts` — framing coverage for this story. `orchestrator.test.ts` is 786 lines against the project's 800-line test limit, so this story's tests cannot be appended to it without breaching the ratchet mid-run.

### US-003 — A rebuilt bundle fits, and reports, the target agent's ceiling

Re-pack the reconstructed chunks against `min(prior.manifest.effectiveBudget, targetProfile.caps.preferredPromptTokens)` before rendering, and derive `usedTokens` from what was actually packed, so the manifest's `effectiveBudget` bounds the payload instead of merely describing it.

#### Context Files
- `src/context/engine/rebuild.ts` — created by US-001, extended here
- `src/context/engine/packing.ts` — `packChunks`, `FLOOR_KINDS`, `PackResult`
- `src/context/engine/agent-profiles.ts` — `preferredPromptTokens` per profile
- `test/unit/context/engine/orchestrator-rebuild.test.ts` — existing rebuild coverage

### US-004 — Packing applies the bounded AC-7 repair

Add the `best-of(greedy, largest single item that fits)` repair to the non-floor pass of `packChunks`, and add deterministic property coverage for the cases that repair is designed to handle.

#### Context Files
- `src/context/engine/packing.ts` — `packChunks`, `scoreDensity`, `FLOOR_KINDS`
- `src/context/engine/scoring.ts` — the `ScoredChunk` shape the test fixtures build
- `test/unit/context/engine/packing.test.ts` — existing packing fixtures to mirror, **and** the #1448 density-sort test at `:65-76` whose fixture this story updates (see Design § Approach)

#### Creates
- deterministic property coverage in `test/unit/context/engine/packing.test.ts`

### Seams

- US-001 introduces an exported rebuild function consumed by `ContextEngine.rebuildForAgent`; US-001's own ACs carry the seam assertion, since producer and consumer land together.
- US-003 changes behaviour reached only through `ContextEngine.rebuildForAgent`; its ACs trigger that method rather than the extracted function directly.

### Modifies

**US-001**
- `src/context/engine/orchestrator.ts` — `rebuildForAgent` moves out to `rebuild.ts` and becomes a delegating wrapper; `_orchestratorDeps` gains the rebuild property.

**US-002**
- `src/context/engine/orchestrator.ts` — `assemble()` step 8 routes through `renderForAgent` when `request.agentId` is set.

**US-003**
- `src/context/engine/rebuild.ts` — re-pack to the target ceiling, preserve prior order, recompute `floorOverageItems` (file created by US-001).

**US-004**
- `src/context/engine/packing.ts` — add the best-of(greedy, largest single item that fits) repair to the non-floor pass.
- `test/unit/context/engine/packing.test.ts` — REQUIRED. The #1448 density-sort test at `:65-76` asserts `packed` is `["dense"]`; the repair correctly returns `bulky`, so this story must replace that fixture with the two-small-chunks variant per Design § Approach.

## Acceptance Criteria

### US-001 — Extract the rebuild path into its own module

- [unit] the rebuild function is importable from `src/context/engine/rebuild.ts` and, given a prior bundle and empty options, returns a bundle whose `pushMarkdown` equals the prior bundle's rendering.
- [unit] the extracted rebuild function is reachable as a property of the exported `_orchestratorDeps` object, so tests can replace it without `mock.module()`.
- [unit] with `_orchestratorDeps`' rebuild property replaced by a stub returning a sentinel bundle, `ContextEngine.rebuildForAgent` returns that sentinel bundle unchanged, proving the method delegates rather than reimplementing.
- [unit] with `_orchestratorDeps`' rebuild property replaced by a stub, calling `ContextEngine.rebuildForAgent` invokes the stub exactly once, with the prior bundle and the options object it received.
- [unit] `ContextEngine.rebuildForAgent` with `newAgentId: "codex"` and a failure returns a bundle whose `manifest.rebuildInfo.newAgentId` equals `"codex"`.
- [unit] `ContextEngine.rebuildForAgent` with `newAgentId` set to an id absent from `AGENT_PROFILES` returns a bundle whose `agentId` equals that id and logs a warning at warn level.

**Verification note:** the extraction is additionally covered by `bun run typecheck` and `bun run check:file-sizes` — the latter fails if `orchestrator.ts` grows past its recorded baseline.

### US-002 — `assemble()` frames the bundle for the requested agent

- [unit] `assemble()` with `request.agentId` set to `"codex"` returns a bundle whose `pushMarkdown` contains `<context_section type=` wrappers.
- [unit] `assemble()` with `request.agentId` set to `"claude"` returns a bundle whose `pushMarkdown` uses `## ` section headers.
- [unit] `assemble()` with `request.agentId` absent returns a bundle whose `pushMarkdown` uses `## ` section headers, matching the pre-existing default.
- [unit] `assemble()` with `request.agentId` set to an id absent from `AGENT_PROFILES` returns a bundle whose `pushMarkdown` uses the conservative `[Section]` bracket framing.
- [unit] `assemble()` with `request.agentId` set to an id absent from `AGENT_PROFILES` logs a warning at warn level naming that agent id.
- [unit] `assemble()` with `request.priorStageDigest` set and `request.agentId` set to `"codex"` returns a bundle whose `pushMarkdown` contains a `prior_stage_summary` section.

### US-003 — A rebuilt bundle fits, and reports, the target agent's ceiling

- [unit] `rebuildForAgent` with a prior bundle whose non-floor chunks exceed the target profile's `preferredPromptTokens` returns a bundle whose `manifest.usedTokens` is at most `manifest.effectiveBudget`.
- [unit] `rebuildForAgent` under the same over-budget conditions returns a bundle whose `chunks` omits the excluded non-floor chunks, so `chunks` matches what `pushMarkdown` renders.
- [unit] `rebuildForAgent` with a prior bundle whose chunks all fit the target ceiling returns a bundle whose `chunks` retains every prior chunk id.
- [unit] `rebuildForAgent` with floor-kind chunks whose tokens alone exceed the target ceiling returns a bundle that still contains every floor chunk id.
- [unit] `rebuildForAgent` with `prior.manifest.effectiveBudget` absent returns a bundle whose `manifest.effectiveBudget` equals the target profile's `preferredPromptTokens`.
- [unit] `rebuildForAgent` with `newAgentId` and a failure returns a bundle that contains the injected failure-note chunk even when the target ceiling is smaller than the prior payload.
- [unit] `rebuildForAgent` on a bundle it has already rebuilt returns the same `manifest.usedTokens` as the first rebuild, so repeated rebuilds do not shrink the payload further.
- [unit] `rebuildForAgent` on a prior bundle whose chunks all fit returns `chunks` in the same relative order as `prior.chunks`.
- [unit] `rebuildForAgent` with `newAgentId` and a failure, on a prior bundle whose chunks all fit, returns a bundle whose `manifest.rebuildInfo.chunkIdMap` pairs every prior chunk id with itself.
- [unit] `rebuildForAgent` on a prior bundle whose floor chunks exceed the target ceiling returns a bundle whose `manifest.floorOverageItems` lists exactly the floor chunk ids that overflowed that ceiling, rather than the prior bundle's values.

### US-004 — Packing applies the bounded AC-7 repair

- [unit] `packChunks` given a 900-token chunk scoring 0.9 and a 100-token chunk scoring 0.5 at budget 900 packs the 900-token chunk, because it alone scores higher than the density-greedy result.
- [unit] `packChunks` given a 900-token chunk scoring 0.9 and two 100-token chunks scoring 0.5 each at budget 900 packs both small chunks and excludes the large one, so a density sort remains distinguishable from a raw-score sort.
- [unit] `packChunks` returns a `usedTokens` no greater than its `effectiveBudget` whenever every input chunk is non-floor.
- [unit] for each of at least 200 deterministic repair-envelope cases of at most 12 non-floor chunks—where either all items fit or the largest feasible item is optimal—the total score of `packChunks`' packed chunks is at least 95% of the exhaustive oracle for that case and budget.
- [unit] `packChunks` given only floor-kind chunks whose tokens exceed the budget returns all of them, with each over-budget chunk's `reason` set to `budget-exceeded-by-floor`.
- [unit] `packChunks` given a zero-token chunk packs it and returns a finite `usedTokens`.

<!-- spec-writing: completed-through-phase-5 -->
