# Context Engine v2 — Final Code Review

**Date:** 2026-04-17
**Reviewer:** code-reviewer agent (Opus 4.7 1M)
**Scope:** All context-engine commits from 2026-04-10 through 2026-04-17
**Verdict:** **Block until CRITICAL + HIGH items are resolved.**

## Summary

Opus-1M review of the v2 context engine (commits `9457c120` … `5937b721`). Implementation
is broadly on-spec and test coverage is substantive. However there are several
**ship-blocking** issues:

- AC-24 (determinism) and AC-51 (planDigestBoost) do not flow through most stages.
- AC-41 (fallback observability metric) is entirely missing.
- A **path-traversal vulnerability** exists in `CodeNeighborProvider` / `GitHistoryProvider`
  reading user-supplied `touchedFiles`.
- A silent error-swallow in effectiveness annotation hides real bugs.

## Commits Reviewed

| SHA | Subject |
|:----|:--------|
| `5937b721` | feat(context-engine): AC-42 cross-agent scratch neutralization |
| `c0767776` | feat(context-engine): Amendment A — context pollution prevention (AC-45/46/47/48/49) |
| `0a07f626` | feat(context-engine): Amendment B AC-51 — planDigestBoost |
| `14d6b84e` | feat(context-engine): AC-25 provider cost accounting (#499) |
| `421b392d` | feat(context-engine): AC-24 determinism mode (#498) |
| `536c2ea7` | feat(cli): AC-19 nax context inspect (#497) |
| `6d67c000` | feat(session): AC-20 session scratch retention (#496) |
| `cbfaf4f3` | feat(metrics): AC-18 context.providers metrics (#495) |
| `8b877fb4` | fix(context-engine): #479 post-review fixes — AC-62 workspace |
| `e28ed70a` | feat(context-engine): AC-56/AC-62 CodeNeighborProvider |
| `5e3b69f7` | feat(context-engine): AC-55 GitHistoryProvider historyScope |
| `0b2d8536` | feat(context-engine): AC-57 per-package canonical rules (#490) |
| `9457c120` | feat(context-engine): Amendment C AC-54/AC-60/AC-61 |

---

## CRITICAL (must fix before shipping v2)

### C1. Path traversal via `touchedFiles` → arbitrary file read

**File:** `src/context/engine/providers/code-neighbor.ts:167-168`
(and `src/context/engine/providers/git-history.ts` equivalent call site)

`collectNeighbors()` does `Bun.file(join(workdir, filePath)).exists()` and `.text()`
with `filePath` coming straight from `request.touchedFiles`, which in turn comes
from story `contextFiles` in the PRD. The PRD schema validator
(`src/prd/schema.ts:200-204`) does **not** reject `..` or absolute paths for
`contextFiles` (it does reject them for `workdir` at line 195).

An LLM-generated or attacker-influenced PRD with
`contextFiles: ["../../../etc/passwd"]` will read arbitrary files and echo
fragments of their content into the neighbor chunk — and into the persisted
context manifest.

**Fix (both places):**
- In `src/prd/schema.ts` apply the same `..`/absolute-path guard to `contextFiles` entries.
- In `code-neighbor.ts` and `git-history.ts`, call a shared
  `validateRelativePath(filePath, workdir)` helper and drop entries that escape
  `workdir` before any `fs` / `Bun.file` / `git --` call.

**Follow-up issue:** Create immediately. Label: `security`, `ship-blocker`.

---

## HIGH (ship-blocking quality issues)

### H1. AC-24 determinism does not reach most stages

**File:** `src/context/engine/stage-assembler.ts:160-184`

`pipeline/stages/context.ts:131` sets `deterministic: ctx.config.context.v2.deterministic`,
but `stage-assembler.ts` — used by `execution`, `tdd-test-writer`, `tdd-implementer`,
`verify`, `rectify`, `review-*`, `acceptance` — does **not** pass `deterministic`
on the `ContextRequest`. The orchestrator's `deterministic` filter at
`orchestrator.ts:230-233` therefore only engages for the initial `context` stage.

AC-24 says "two runs with identical inputs produce identical push blocks"; that
guarantee does not hold across the rest of the pipeline.

**Fix:** add `deterministic: ctx.config.context.v2.deterministic` to the
`ContextRequest` in `assembleForStage()`.

### H2. AC-51 `planDigestBoost` also not propagated from stage-assembler

**File:** Same as H1 — `stage-assembler.ts:160-184`

`planDigestBoost` is set only in `pipeline/stages/context.ts:134` (reading
`ctx.routing?.testStrategy`). For stages re-assembled via `stage-assembler.ts`
(execution / single-session / tdd-simple / no-test / batch / rectify) the
orchestrator never sees `planDigestBoost`, so the boost chunk is only injected
on the first assemble (the `context` stage). Tests only cover the orchestrator
path, not the stage-assembler integration.

**Fix:** in `assembleForStage()` look up `getStageContextConfig(stage).planDigestBoost`
and pass it on the request.

### H3. AC-41 — `context.fallback.triggered` metric never emitted

**Files:** `src/execution/escalation/agent-swap.ts`, `src/metrics/tracker.ts`

A repo-wide grep for `fallback.triggered` or any equivalent structured metric
returns nothing. AC-41 mandates emission of
`{ storyId, priorAgent, newAgent, outcome, category, hop }`. Without this,
fallback behaviour cannot be observed in run summaries (the second half of AC-41
is also unmet). `StoryMetrics` has no `fallback` field.

**Fix:** emit the event from `rebuildForSwap()` (or the caller in `execution.ts`)
and add a field to `RunMetrics` / `StoryMetrics` so the run summary can surface
fallback counts.

### H4. Effectiveness annotation silently swallows errors

**File:** `src/context/engine/effectiveness.ts:197-204`

```typescript
try { … } catch { /* Best-effort — non-fatal */ }
```

No logging. A JSON-parse bug, write-permission issue, or schema drift will make
every manifest appear un-annotated forever and no operator will ever know.
Downstream consequence: pollution metrics silently report zero.

**Fix:**

```typescript
logger.warn("effectiveness", "Failed to annotate manifest", {
  storyId,
  path: item.path,
  error: errorMessage(err),
});
```

### H5. `historyScope` / `neighborScope` / `crossPackageDepth` not exposed via config

**Files:**
- `src/context/engine/providers/git-history.ts:92-96`
- `src/context/engine/providers/code-neighbor.ts:265-271`
- `src/context/engine/orchestrator-factory.ts:50-51`

The provider constructors accept these options but the factory instantiates both
with no options, and there are zero references to any of these strings in
`src/config/`. Whatever the user sets in config cannot influence behaviour.
AC-55 / AC-56 / AC-62 list these as configurable. Defaults happen to satisfy the
ACs today, but swapping to `"repo"` is impossible without code changes —
partial AC.

**Fix:** add fields to `ContextV2Config` schema, thread them through the
factory — or document that these are constants and downgrade the spec.

### H6. AC-27 agent profile registry missing 3 of 5 built-ins

**File:** `src/context/engine/agent-profiles.ts:92-115`

Only `claude` and `codex` are registered. AC-27 names `claude`, `codex`,
`gemini`, `cursor`, `local`. The comment at line 90 acknowledges "Phase 8 adds
gemini, cursor, local" — but the AC is in the v2 spec, not Phase 8. Either
implement the three missing profiles, or amend the spec. As shipped, three of
the named agents silently degrade to the conservative default profile.

---

## MEDIUM (worth a follow-up issue)

### M1. AC-42 neutralization partial — `verify-result.rawOutputTail` not neutralized

**File:** `src/context/engine/providers/session-scratch.ts:75-82`

Only the `tdd-session` branch (line 91) neutralizes `outputTail`.
`verify-result.rawOutputTail` is a Bun-test or pytest output tail that may
contain captured agent-tool phrases (e.g. when tests log an agent's own prints).

**Fix:** apply
`neutralizeForAgent(entry.rawOutputTail, entry.writtenByAgent ?? "", targetAgentId ?? "")`
consistently.

### M2. AC-42 neutralization does not run on rebuild path

**Files:** `src/context/engine/orchestrator.ts:442-502`, `src/context/engine/agent-renderer.ts`

`rebuildForAgent` reuses already-rendered `prior.chunks`. If the prior assemble
ran under Claude and the swap target is Codex, the content was neutralized for
Claude → Claude (no-op) and never for Claude → Codex. The session-scratch chunk
in the prior bundle still carries "the Read tool" phrasing.

**Fix:** re-run neutralization per chunk when `prior.agentId !== targetAgentId`
(requires tracking `sourceAgent` on `ContextChunk` or re-fetching scratch).

### M3. AC-28 default violates spec — legacy CLAUDE.md read by default

**Files:** `src/config/schemas.ts:497`, `src/context/engine/providers/static-rules.ts:80`

`allowLegacyClaudeMd` defaults to `true`. AC-28 literally says the engine does
not read `CLAUDE.md` at assembly time, and AC-31 says "with the flag off
(default)". Either flip the default to `false` and gate on an explicit opt-in
(breaks migration path) or amend the ACs. The current test fixture "remove
CLAUDE.md and confirm push block unchanged" (per AC-28) only passes because the
default fallback finds no file.

### M4. AC-35 — unconfigured-fallback-candidate warning not emitted at run start

No evidence anywhere (`src/execution/**`) of the pre-flight warning when
`fallback.map.claude = ["codex", "gemini"]` but Gemini is not configured.
Operators will only discover the bad config when fallback fires mid-run.

**Fix:** add a pre-flight pass in `lifecycle/run-setup.ts`.

### M5. AC-39 — no separate `rebuild-manifest.json` and no old→new chunk-ID mapping

**File:** `src/context/engine/orchestrator.ts:478-487`

The implementation stamps `rebuildInfo` on the regular manifest only; the AC
asks for a distinct `rebuild-manifest.json` correlating old chunk IDs to new
chunk IDs. Today `includedChunks` after rebuild is just
`packedChunks.map(c => c.id)` — the orchestrator doesn't know which IDs changed.

### M6. AC-46 granularity — whole chunk marked stale

**File:** `src/context/engine/providers/feature-context.ts:96-101`

`isStale = contradicted.size > 0 || ageStale.size > 0` taints the entire
feature-context chunk if any entry is stale. The spec says "chunks from entries
older than `maxStoryAge`". Today a 50-entry `context.md` with one old entry
gets the whole chunk downweighted.

**Fix:** split feature context into per-section chunks (larger change) or tune
the threshold.

### M7. `orchestrator-factory.ts:40` missing optional chaining

**File:** `src/context/engine/orchestrator-factory.ts:40`

Dereferences `config.context.v2.rules.allowLegacyClaudeMd` without optional
chaining. Same regression class that was fixed in `completion.ts` with
`ctx.config.context?.v2?.enabled`. Tests bypassing Zod will crash here.

**Fix:** add `?.` or document the precondition.

### M8. `appendScratchEntry` is read-modify-write, not append-atomic

**File:** `src/session/scratch-writer.ts:127-133`

Two stages writing to the same `scratch.jsonl` concurrently will drop entries.
Phase 1 comment acknowledges "safe for Phase 1" but parallel batch mode already
ships.

**Fix:** use `Bun.write` with an append flag, or hold a per-file mutex.

### M9. PRD `contextFiles` path validation missing

**File:** `src/prd/schema.ts:200-204`

Already listed as C1 but also tracked as a MEDIUM hardening item: add a Zod
`.refine()` string validation.

### M10. Rules-load logger uses sentinel `storyId: "_rules"`

**File:** `src/context/rules/canonical-loader.ts:160, 182`

Breaks the project convention "storyId first key with the real value" —
downstream log filters looking for a real story won't match.

**Fix:** pass the caller's `storyId` in, or omit the `storyId` field entirely
for genuinely story-less context.

### M11. `MAX_GLOB_FILES` is a silent truncation

**File:** `src/context/engine/providers/code-neighbor.ts:84`

No log / metric when the reverse-dep glob hits the 200-file cap. Large packages
silently see partial neighbor data.

### M12. AC-23 plugin provider warning for unknown `id`

AC-16 says `context.providers` with unknown `id` must fail validation with a
clear error listing available providers. The schema at `src/config/schemas.ts`
treats plugin module specifiers, not provider IDs; there's no stage-configured
allow-list validation.

**Fix:** add a unit test that a config entry with a bogus
`providerIds: ["does-not-exist"]` in a stage override is caught.

---

## AC Coverage Table

Legend: ✅ satisfied · ⚠️ partial / needs review · ❌ missing or regression

### SPEC-context-engine-v2.md (ACs 1–43)

| AC | Status | Justification |
|:--|:--|:--|
| 1 Orchestrator contract | ✅ | `orchestrator.ts:200-410` returns `ContextBundle` with all fields; deterministic path verified in tests |
| 2 Parity with v1 | ✅ | `FeatureContextProviderV2` delegates to v1 provider unchanged |
| 3 Provider interface | ✅ | `IContextProvider` in `types.ts` + `plugin-loader.ts` registration |
| 4 Parallel fetch | ✅ | `Promise.all` at `orchestrator.ts:237` |
| 5 Per-provider timeout | ✅ | `fetchWithTimeout` at `orchestrator.ts:79-89`, 5000ms, logged-not-thrown |
| 6 Budget enforcement | ✅ | `packing.ts` + tests for floor overage |
| 7 Packing correctness | ✅ | Greedy in `packing.ts`; property tests exist |
| 8 Role filtering | ✅ | `orchestrator.ts:330-340` with post-dedupe re-check |
| 9 Dedup + audience union | ✅ | `dedupe.ts` + `orchestrator.ts:328-335` |
| 10 Digest propagation | ✅ | `priorStageDigest` threaded through `stage-assembler` |
| 11 Session scratch read | ✅ | `SessionScratchProvider` + tests |
| 12 Manifest writing | ✅ | `writeContextManifest` at `stage-assembler.ts:188` |
| 13 Pull tool registration | ✅ | `buildPullToolDescriptors` + registry |
| 14 Pull tool budget | ✅ | Descriptor `maxCallsPerSession` enforced |
| 15 Graceful degradation | ✅ | Agent-cap gate at `orchestrator.ts:316-318` |
| 16 Config validation | ⚠️ | Plugin module validation exists; stage-level unknown provider ID not obviously errored — see M12 |
| 17 No-op when disabled | ✅ | `stage-assembler.ts:142` early return |
| 18 Provider metrics | ✅ | `deriveContextMetrics` populates all fields |
| 19 `nax context inspect` | ✅ | CLI at `src/cli/context.ts` wired at `bin/nax.ts:1278` |
| 20 Session scratch retention | ✅ | `purgeStaleScratch` wired in `run-completion.ts:246` |
| 21 v1 read path preserved | ✅ | v1 provider still used inside V2 adapter |
| 22 Builder migration | ✅ | bundles consumed via `getBundleMarkdown` |
| 23 Plugin provider integration | ✅ | `plugin-loader.ts` + integration test |
| 24 Determinism mode | ❌ | **H1** — only enabled in the `context` stage; other stages ignore it |
| 25 Cost accounting | ✅ | `tracker.ts:65, 74` + provider result `costUsd` |
| 26 Self-dogfooding | n/a | process directive |
| 27 Agent profile registry | ⚠️ | **H6** — only `claude`, `codex`; `gemini`, `cursor`, `local` fall through |
| 28 Canonical rules delivery | ⚠️ | **M3** — default `allowLegacyClaudeMd: true` means CLAUDE.md still read |
| 29 Neutrality linter | ✅ | `canonical-loader.ts:78-98`, throws `NeutralityLintError` |
| 30 Rules export | ✅ | `src/cli/rules.ts` |
| 31 Legacy compat flag | ⚠️ | Works but default opposite of spec — M3 |
| 32 Agent-dim budget resolution | ✅ | `orchestrator.ts:222-225` + `availableBudgetTokens` path in packing |
| 33 Tool gating on capability | ✅ | `orchestrator.ts:316-318` |
| 34 Fallback trigger categories | ✅ | `shouldAttemptSwap` at `agent-swap.ts:58-70` |
| 35 Fallback map resolution | ⚠️ | Resolution present; **M4** — no start-of-run warning for unconfigured candidates |
| 36 Fallback same tier | ✅ | tier is preserved by virtue of not running tier escalation on availability |
| 37 Rebuild portable state | ✅ | `rebuildForAgent` preserves chunk IDs/hashes + injects failure note |
| 38 Rebuild latency | ✅ | Pure in-memory, no I/O; covered by rebuild tests |
| 39 Rebuild manifest | ⚠️ | **M5** — stamps `rebuildInfo` but no separate file and no old→new chunk ID map |
| 40 Fallback hop bound | ✅ | `maxHopsPerStory` check at `agent-swap.ts:67` |
| 41 Fallback observability | ❌ | **H3** — no `context.fallback.triggered` metric, no run-summary surfacing |
| 42 Cross-agent scratch neutralization | ⚠️ | Works for `tdd-session.outputTail`; **M1** (verify-result not neutralized) and **M2** (not applied on rebuild) |
| 43 Failure-note determinism | ✅ | `buildFailureNoteChunk` at `orchestrator.ts:141-172` is pure |

### SPEC-context-engine-v2-amendments.md (Amendments A/B/C)

| AC | Status | Justification |
|:--|:--|:--|
| 44 Min-score threshold | ✅ | `scoring.ts` + `packing.ts` floor exemption |
| 45 Effectiveness signal | ✅ | `effectiveness.ts:107-151` deterministic classification |
| 46 Staleness flag | ⚠️ | **M6** — whole chunk marked stale if any entry stale |
| 47 Contradiction detection | ✅ | `staleness.ts:171-196` |
| 48 Pollution metrics | ✅ | `pollution.ts` + `tracker.ts:82-89`; `nax status` warn clause not verified |
| 49 No runtime cost | ✅ | Both paths are pure string ops |
| 50 Stage sequences documented | ✅ | In spec |
| 51 Plan digest boost | ❌ | **H2** — boost only applied in the `context` stage, not stage-assembler |
| 52 Scratch write coverage | ✅ | Verified via `writtenByAgent` sites: `verify.ts`, `rectify.ts`, `tdd/orchestrator.ts` |
| 53 No-test rectify scope | ✅ | Rectify config in `stage-config.ts:152-157` |
| 54 Dual workdir | ✅ | `ContextRequest` has `repoRoot` + `packageDir`; `stage-assembler.ts:158` |
| 55 GitHistory package scope | ⚠️ | Default is "package" ✅, but **H5** — not config-driven |
| 56 CodeNeighbor package scope | ⚠️ | Same as 55 — **H5** |
| 57 Per-package rules overlay | ✅ | `static-rules.ts:87-100` |
| 58 Feature context repo-scoped | ✅ | `FeatureContextProviderV2` uses `request.repoRoot` |
| 59 Per-package stage budgets | ✅ | `stage-assembler.ts:169` reads `ctx.config.context.v2.stages[stage].budgetTokens` |
| 60 Manifest records package | ✅ | `orchestrator.ts:387-388` |
| 61 Non-monorepo no-op | ✅ | `packageDir === repoRoot` when `story.workdir` unset |
| 62 Cross-package neighbor | ✅ | `resolveExtraGlobWorkdirs` at `code-neighbor.ts:234-251`, with **H5** caveat |

### Coverage Totals

- **v2 spec (1–43):** 33 ✅ · 8 ⚠️ · 2 ❌
- **Amendments A/B/C (44–62):** 16 ✅ · 3 ⚠️ · 1 ❌

---

## Files with Load-Bearing Findings

- `src/context/engine/orchestrator.ts`
- `src/context/engine/stage-assembler.ts`
- `src/context/engine/orchestrator-factory.ts`
- `src/context/engine/effectiveness.ts`
- `src/context/engine/agent-profiles.ts`
- `src/context/engine/providers/code-neighbor.ts`
- `src/context/engine/providers/git-history.ts`
- `src/context/engine/providers/session-scratch.ts`
- `src/context/engine/providers/static-rules.ts`
- `src/context/engine/providers/feature-context.ts`
- `src/context/engine/scratch-neutralizer.ts`
- `src/context/rules/canonical-loader.ts`
- `src/session/scratch-writer.ts`
- `src/session/scratch-purge.ts`
- `src/pipeline/stages/context.ts`
- `src/execution/escalation/agent-swap.ts`
- `src/execution/lifecycle/run-completion.ts`
- `src/prd/schema.ts`
- `src/config/schemas.ts`
- `src/cli/context.ts`
- `bin/nax.ts`

**Not reviewed exhaustively** (spot-checked, no obvious issues, next targets for
line-by-line review): `manifest-store.ts`, `dedupe.ts`, `digest.ts`, `packing.ts`,
`render-utils.ts`, `agent-renderer.ts`, `pull-tools.ts`, `scoring.ts`.

---

## Recommended Gating

| Severity | Action |
|:---------|:-------|
| **C1** | Open immediately. Security-labelled. Fix before next release. |
| **H1–H4** | Open this sprint. Block v2 "shipped" status. |
| **H5, H6** | Release-with-known-issues acceptable if Phase 8 is scheduled and specs amended. |
| **M1–M12** | Standard follow-up backlog. |

## Suggested Follow-Up Issue Split

1. **Security: PRD `contextFiles` path traversal** (C1 + M9) — hotfix.
2. **AC-24/AC-51 propagation through stage-assembler** (H1 + H2) — one PR.
3. **AC-41 fallback observability** (H3) — metric emission + run summary.
4. **Effectiveness / rules logging hygiene** (H4 + M10) — small PR.
5. **Config-drive history/neighbor scope options** (H5) — schema + threading.
6. **Phase 8 agent profiles OR spec amendment** (H6) — decision + implementation.
7. **AC-42 completeness** (M1 + M2) — neutralize `rawOutputTail`; handle rebuild path.
8. **AC-28 default behaviour** (M3) — decide: flip default or amend spec.
9. **AC-35 pre-flight warning** (M4).
10. **AC-39 rebuild manifest** (M5).
11. **AC-46 staleness granularity** (M6).
12. **Scratch append atomicity under parallel** (M8).
13. **Misc hardening**: M7, M11, M12.
