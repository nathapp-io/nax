# Phase 9 — PRD Fidelity Report

**Spec:** `docs/specs/SPEC-worktree-isolation-residuals.md`
**PRD:** `.nax/features/worktree-isolation-residuals/prd.json`
**Reviewed against:** `repos/nax` @ `2814ada6a` (main `945e1edde`)
**Date:** 2026-09-19
**Planner:** `nax plan --profile native` — `agentName: native`, `model: openai-codex/gpt-5.6-terra[high]`, one 137s session turn
**Verdict:** ⚠️ 1 blocker found and fixed in place → ✅ ready

## Verdict table

| # | Check | Result |
|---|---|---|
| 1 | Spec AC → PRD AC mapping | ✅ 16 → 19, all traced; 3 compound ACs split correctly |
| 2 | Behavioural fidelity + signature reality | ✅ no grep-style rewrites; asserted call shapes match real signatures |
| 3 | Orphan PRD ACs | ✅ none |
| 4 | File-role delta | ✅ a/b/c clean; **d** 1 minor (helpful additions) |
| 5 | Meta-AC survival | ✅ spec declares none |
| 5b | Correction survival (`analysis` is not evidence) | ✅ all 3 corrections in `description`/`acceptanceCriteria` |
| 5c | **PRD-AC satisfiability (Class B trace)** | ❌ **1 blocker** — fixed |
| 6 | Out-of-scope preservation | ✅ a/b/c/d/e clean, 6/6 present |
| 7 | Terminal-cleanup story | ✅ n/a — spec declares none |
| 8 | `Modifies` → `modifiedFiles`, by path | ✅ 1 path → 1 entry, `reason` 491 chars verbatim |

## Blocker — 5c: three ACs name a precondition that does not reach the code path

**Origin: the spec, not the planner.** The planner faithfully carried the spec's wording; the spec's wording was wrong. It survived phases 1–8 because Phase 8's Class B rule is scoped to *invocation-shaped* ACs and these read as outcome assertions.

**PRD ACs:** US-002 #1, #4, #6 (from spec AC-2.1, 2.3, 2.5)

All three said *"Given `handlePipelineFailure` has run **in worktree mode**"*. That points at `execution.storyIsolation`. The real gate is not the config:

```
handlePipelineFailure (pipeline-result-handler.ts:333)
  switch (pipelineResult.finalAction)                          :343
    case "pause":  if (hasWorktree(ctx.workdir, story.id))     :357  → removeWorktreeDirectory
    case "fail":   if (hasWorktree(ctx.workdir, story.id))     :394  → removeWorktreeDirectory
hasWorktree = existsSync(join(projectRoot, ".nax-wt", storyId)) :47
```

Two preconditions the ACs never stated:

1. **`hasWorktree` is a directory probe, not a config read.** Per MEM-6 (`:44-48`) cleanup keys off whether a worktree actually exists *"regardless of `storyIsolation` mode"*. A fixture that sets only the config takes the short-circuit branch.
2. **`finalAction` must be `"pause"` or the tier-exhausted `"fail"`.** No other branch reaches the cleanup path at all.

The existing `pipeline-result-handler-worktree-cleanup.test.ts` establishes both explicitly — `_resultHandlerDeps.existsSync = () => true` at `:88` and `maxAttemptsTotal: 1` at `:85` to force exhaustion. That the only passing test in the repo has to do this is the confirmation.

**Why this blocks.** It is 5c's second condition exactly: *"path exists only behind an enabling flag/config guard that nothing in the spec establishes — the test's default fixture takes the short-circuit branch."* A test written from the wording as shipped never calls `removeWorktreeDirectory`. AC #6 could never go green; AC #4 would pass **vacuously** (the branch still resolves because nothing ran), which is worse — it ships a green signal over untested code. `beforeEach` in that suite defaults `existsSync` to `() => false`, so this is the default outcome, not an edge case.

**Cost if it had shipped:** acceptance diagnosis returns only `source_bug`, `test_bug`, or `both` — it has no verdict meaning *"the criterion is wrong"* — so it would blame correct code and burn `rectification.maxAttemptsTotal` (12) plus tier escalation before blocking, never naming the cause.

**Fix applied.** Both artifacts patched in place; no re-plan (the PRD is otherwise faithful, so a re-plan would be a billed call that risks re-drawing the 18 correct ACs).

- **Spec** — AC-2.1/2.3/2.5 now state both preconditions, plus a new `### Reachability of the cleanup path` Design block recording the gate, the two branches with line numbers, and why the config is not the gate.
- **PRD** — US-002 ACs #1/#4/#6 rewritten to match; the reachability note appended to `description`, so it reaches the implementer prompt (a correction that lives only in `analysis` reaches nobody).

**Structural diff** (`prd-before.json` vs patched): top-level keys identical; US-001 `changed keys: []`; US-002 changed `description` and `acceptanceCriteria` only, indices `[0, 3, 5]`, count 9 → 9. Nothing else moved.

## Minor — 4d: two helpful `contextFiles` additions

The planner added `test/unit/execution/pipeline-result-handler-worktree-cleanup.test.ts` and `test/unit/execution/worktree-manager.test.ts` to US-002's `contextFiles`. Both exist on disk and appear in the spec only inside `Modifies` prose. As reads this is correct and useful — the first is the exact fixture pattern the corrected ACs now require. Not a finding.

## Notes on checks that passed for a non-obvious reason

- **5b.** The three spec-review corrections (entry point at `handlePipelineFailure`; the shared `naxOrphanRefName` helper; the source-ref `update-ref` form) all reached `description` or `acceptanceCriteria`. None was stranded in `analysis` (5045 chars, rendered into no prompt).
- **Baseline/Target pairing held.** The planner dropped every `Baseline:` line and synthesised `**Interface**` blocks from targets only — `interface ContextRequest { execRoot?: string }` and `naxOrphanRefName(storyId: string): string`. No pre-change signature was promoted into a block that would contradict the story's own ACs.
- **The Phase 8 blocker fix survived.** No PRD AC reintroduced the module-private `removeWorktreeDirectory` as a test trigger.
- **6c.** No out-of-scope statement surfaced in any story's `acceptanceCriteria`. Checked specifically against exclusion #2 (`historyScope` / `storyWorkdir`) versus US-001 #6/#7, which assert a git working directory, not history scope; and exclusion #4 (no segment-joining derivation) versus US-001 #8, which asserts an expected *value*, not a derivation method.
