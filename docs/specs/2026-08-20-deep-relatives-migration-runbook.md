# Deep-Relative Migration Runbook

**Status:** Complete — 5 residuals (Phase E blocked per §7)
**Branch:** `chore/deep-relatives-migration`
**Date:** 2026-08-20
**Follows:** PR #1649 (issue #1647), PR #1650 (issue #1648)

---

Steps 3 and 4 of the plan behind #1647: convert the remaining relative imports
to path aliases, then retire the ratchet. 97% is scripted.

Follow this in order and do not improvise. Every escalation in Phases C and D
is a genuine engineering decision, not a blocked script.

## 0. Where things stand

Start from `chore/deep-relatives-migration`, not `main`. The branch already
carries the codemod and one finished batch.

| Class | Count | How |
|:---|---:|:---|
| `test` | 2,344 | scripted — Phase A |
| `src-specifier` | 112 | scripted — Phase B |
| `barrel-routing` | 54 | manual — Phase C, escalate |
| `unresolved` | 18 | manual — Phase D, escalate |
| **Total** | **2,528** | |

Re-read these counts at any time:

```bash
bun scripts/migrate-deep-relatives.ts --dry-run
```

### Outcome (post-run)

The migration reduced **2,528 → 5** deep-relative imports (99.8%). The 5
residuals are intentional — see §7. Two codemod bugs were found and fixed
during the run — see §9.

| Class | Initial | Final | What happened |
|:---|---:|---:|:---|
| `test` | 2,344 | 0 | Phase A — 17 batches, all committed |
| `src-specifier` | 112 | 0 | Phase B — 6 batches, all committed |
| `barrel-routing` | 60¹ | 5 | Phase C — 55 routed across 21 commits, 5 escalated |
| `unresolved` | 17 | 0 | Phase D — `@scripts/*` alias added (13 imports), 4 JSDoc rewrites |
| **Total** | **2,533** | **5** | |

¹ 60, not the 54 in the table above — the ancestor-barrel fix (§9.2) reclassified 6 `src-specifier` cases as `barrel-routing` after this runbook was drafted.

Final ratchet state (all green):

| Ratchet | Baseline | Final |
|:---|---:|---:|
| `check:deep-relatives` | 2,845 | 5 |
| `check:import-cycles` | 42 | 39 |
| `check:test-typecheck` | 2,001 | 2,001 |
| `check:test-as-unknown-as` | 815 | 815 |
| `check:alias-internals` | 77 barrels | 77 barrels OK |

## 1. Rules that override everything

- **Never run Biome over `test/` files.** `bun run lint` formats `src/` and
  `bin/` only — `test/` is deliberately unformatted. Reformatting it re-wraps
  unrelated casts and detaches their `// test-ratchet-allow` markers, which
  breaks `check:test-as-unknown-as`.
- **Never run `--update-baseline` on any ratchet.** Every baseline must hold
  exactly. A moved number means the batch broke something.
- **Never hand-edit a `barrel-routing` or `unresolved` import.** Those load a
  different module; changing them can create an import cycle.
- **Never lower the deep-relatives baseline** to match progress. It stays at
  2,845 until the file is deleted in Phase E.

## 2. The verification block

Run after *every* batch, before committing.

```bash
bun run lint
bun run typecheck
bun run check:test-typecheck
bun run check:test-as-unknown-as
bun run test
```

| Check | Must read |
|:---|---:|
| `check:alias-internals` | OK, 77 barrels |
| `check:import-cycles` | 42 |
| `check:test-typecheck` | 2,001 |
| `check:test-as-unknown-as` | 815 |
| `bun run test` | 0 fail |

`check:deep-relatives` is the only number that should move, and only downward.

If anything else changes, run `git checkout -- .` to drop the batch, then
escalate with the failing output. Do not try to fix it.

The pre-commit hook re-runs all of this, so a commit that succeeds is proof.

## 3. Phase A — test/ imports (2,344)

One directory per batch, one commit per batch. Largest first, so failures
surface early.

```bash
bun scripts/migrate-deep-relatives.ts --scope test --dir test/unit/execution
# ...verification block...
git add -A && git commit -m "refactor(test): migrate test/unit/execution imports to aliases"
```

| Batch | Imports | Batch | Imports |
|:---|---:|:---|---:|
| `test/unit/execution` | 342 | `test/unit/config` | 87 |
| `test/unit/context` | 163 | `test/unit/prompts` | 80 |
| `test/unit/review` | 137 | `test/unit/plugins` | 64 |
| `test/unit/pipeline` | 135 | `test/unit/runtime` | 63 |
| `test/unit/agents` | 117 | `test/unit/session` | 50 |
| `test/unit/debate` | 103 | `test/unit/metrics` | 50 |
| `test/unit/operations` | 102 | `test/unit/routing` | 40 |
| `test/unit/cli` | 88 | `test/integration` | 441 |

Finish with `--scope test` and no `--dir` to catch the tail (`test/ui`,
`test/helpers`, smaller directories).

## 4. Phase B — src/ imports (112)

These touch production code, so keep batches small. Unlike `test/`, **do** run
Biome here — `src/` is formatted by CI.

```bash
bun scripts/migrate-deep-relatives.ts --scope src --dir src/pipeline
bun x biome check --fix $(git diff --name-only)
# ...verification block...
```

Batches: `src/pipeline` (45), `src/execution` (45), `src/context` (24),
`src/agents` (16), `src/prompts` (12), then `--scope src` with no `--dir`.

## 5. Phase C — barrel routing (54) — escalate

Imports that would have to load a *different* module to satisfy the barrel
rule. Do not attempt mechanically. Procedure for a human or stronger model:

1. Add the missing symbol to the target directory's `index.ts`.
2. Repoint the importer at the barrel.
3. Run `bun scripts/check-import-cycles.ts`. **If the count rises above 42,
   revert both edits** and leave the import as a deep relative — a deep
   relative is strictly better than a cycle.
4. Record why anything was left behind.

Precedent: two imports in `src/pipeline/stages/context.ts` and
`src/pipeline/subscribers/hooks.ts` are permanently exempt for this reason.
Routing them through `@/execution` closes a 12-hop `pipeline -> execution` loop.

> **Note from the run:** The dry-run count was 60, not the 54 estimated above.
> The §9.2 ancestor-barrel fix reclassified 6 imports from `src-specifier` to
> `barrel-routing` because they bypass a non-immediate-parent barrel (e.g. the
> §5 precedent cases, which were previously classified as `src-specifier`).
> 55 of the 60 were routed; 5 are residuals (2 runbook exemptions + 3 cycle
> raisers). See §7 for the full list.

## 6. Phase D — no alias exists (18) — escalate

Two groups, each needing a decision rather than an edit:

- **13 in `test/unit/scripts/`** (one fewer than the 14 estimated here —
  one was a string-literal fixture in `check-gate-reachability.test.ts` that
  the §9.1 fix reclassified) importing `../../../scripts/*`. No `@scripts/*`
  alias exists. Either add one to `tsconfig.json` and `tsconfig.test.json`, or
  accept them as the permanent tail.
- **4 JSDoc code-fence examples** in
  `test/helpers/{index,deps,warn-spy,pipeline-context}.ts`. Not real imports —
  the checker regexes raw lines. Rewriting them to `@test/helpers` is correct
  anyway, since docs should show the form we want copied.

The baseline cannot reach 0 until both groups are settled.

## 7. Phase E — retire the ratchet

Only once `check:deep-relatives` reports **0**:

- Delete `scripts/check-deep-relatives.ts`,
  `scripts/migrate-deep-relatives.ts`,
  `scripts/baselines/deep-relatives-baseline.json`, and
  `test/unit/scripts/check-deep-relatives.test.ts`.
- Remove `check:deep-relatives` and `check:deep-relatives:update` from
  `package.json`, including from the `lint` chain.
- Drop the "Migration ratchet" paragraph from
  `.claude/rules/project-conventions.md`. Keep the cycle ratchet and the barrel
  rules — those are permanent.
- Confirm `bun run check:gate-reachability` still passes.

If the count cannot reach 0 because Phase D is unresolved, stop and report the
residual rather than deleting anything.

### Actual outcome — Phase E blocked

`check:deep-relatives` reports **5**, not 0. Phase D is fully resolved (the
`@scripts/*` alias was added and all 13 imports in `test/unit/scripts/` were
routed; the 4 JSDoc code-fence examples in `test/helpers/` were rewritten to
`@test/helpers`). The 5 residuals come from Phase C — they cannot be cleared
without barrel-splitting work outside the scope of this migration, so **Phase E
was not executed**. The baseline stays at 2,845. The codemod, checker, and
their baseline file remain in place.

The 5 residuals:

| File:Line | Spec | Why it stays |
|:---|:---|:---|
| `src/pipeline/stages/context.ts:43` | `../../execution/helpers` | Runbook §5 exemption — routing through `@/execution` closes a 12-hop pipeline → execution loop |
| `src/pipeline/subscribers/hooks.ts:16` | `../../execution/story-context` | Runbook §5 exemption — same loop |
| `src/prompts/builders/review-builder.ts:22` | `../../review/semantic-categories` | Phase C cycle-raiser — `@/review` → `runner` → `semantic` → `@/prompts` → `review-builder` (TDZ) |
| `src/prompts/builders/debate-builder.ts:22` | `../../debate/personas` | Phase C cycle-raiser — 7 new cycles via `@/debate` → `runner` → `runner-plan` → `verifiers` → ... |
| `src/debate/verifiers/plan-checklist.ts:19` | `../../plan/spec-deltas` | Phase C cycle-raiser — 40 new cycles via `@/plan` → `strategies` → `cli` → `agents`/`operations` |

All 5 carry in-tree `// (#Phase C escalation)` comments documenting the cycle
path.

The two runbook exemptions are **permanent by design** — they are the §5
precedent. The three cycle-raisers can be cleared by future barrel-splitting
work:

- Split `src/review/index.ts` to drop `./runner` (clears `review-builder.ts`).
- Split `src/debate/index.ts` to drop the runner chain (clears `debate-builder.ts`).
- Split `src/plan/index.ts` to drop `./strategies` (clears `plan-checklist.ts`).

After those three barrel splits and a fresh Phase C pass on the affected
imports, expect `check:deep-relatives` → 2 (the two runbook exemptions only).
At that point, **Phase E is unblocked**: deleting the four files and removing
the two `package.json` scripts is a straightforward cleanup with no further
decisions.

### §7.1 First attempt on `review-builder.ts` — partial win, residual unchanged

Dropped `./runner` from `src/review/index.ts` (commit pending). This is a
genuine improvement on its own — `check:import-cycles` dropped from 39 to 29 —
and cleaned up the barrel's 3 real `runReview` consumers
(`src/execution/lifecycle/run-initialization.ts` and two
`test/integration/review/*.test.ts` files) to import `runner.ts` directly
instead of through a barrel that never should have carried it.

It did **not**, however, unblock `review-builder.ts`. Routing
`SEMANTIC_CATEGORY_ENUM_LINE` through the (now-`runner`-free) `@/review`
barrel still produces a TDZ crash
(`ReferenceError: Cannot access 'SEMANTIC_CATEGORY_ENUM_LINE' before
initialization`, first observed failing 25 unrelated `test/unit/` files,
e.g. `test/unit/prompts/builders/one-shot-builder.test.ts`) — caught by
`bun run test`, not by `check:import-cycles` or `tsc`, since the cycle
checker only tracks `src/` and this path is exercised at test-runtime
module-init order.

Root cause: a **second, independent cycle** through `./adversarial` (already
barrel-exported, line 11 of `index.ts`, ahead of `./semantic-categories` at
line 28):

```
src/review/index.ts -> ./adversarial -> src/operations/adversarial-review.ts
  -> src/prompts/index.ts -> src/prompts/builders/review-builder.ts
  -> src/review/index.ts   (closes the loop)
```

`review-builder.ts` reverted to leaf-importing `../../review/semantic-categories`
(unchanged behavior; only its header comment was corrected). The residual
count is still **5** — the `./runner` split alone doesn't move it.

**Clearing `review-builder.ts` for real requires also splitting `./adversarial`
out of the barrel** (or breaking the `operations/adversarial-review.ts` ->
`@/prompts` edge some other way). Before attempting that: `./adversarial`'s
barrel exports (`runAdversarialReview`, `_adversarialDeps`, etc.) have a wider
consumer footprint than `./runner` did — check every `@/review` importer that
touches adversarial-specific exports before repeating this approach, and treat
`bun run test` (not just `check:import-cycles`) as load-bearing verification,
since this class of regression is a runtime TDZ, not a static cycle-count
change.

### §7.2 Second attempt — `./adversarial` split alone is still not enough,
### and `check:import-cycles` has a real blind spot

Tested §7.1's follow-up directly: temporarily dropped `export * from
"./adversarial";` from `src/review/index.ts` and re-pointed
`review-builder.ts` at the (now `runner`- and `adversarial`-free) `@/review`
barrel.

- Consumer footprint for `./adversarial`'s barrel-only exports
  (`runAdversarialReview`, `_adversarialDeps`, `RunAdversarialReviewOptions`)
  is small and safe: 4 files, all `test/unit/review/*.test.ts`, all exempt
  from `check:alias-internals`. No `src/` consumer needs them via the barrel.
- `check:import-cycles` reported **0 cycles** touching `review-builder.ts` or
  `adversarial` — looked clean.
- `tsc --noEmit` passed clean.
- `bun run test` still hit the **identical TDZ crash** from §7.1
  (`Cannot access 'SEMANTIC_CATEGORY_ENUM_LINE' before initialization`).

Traced the real module graph by hand (BFS over value-only imports, same
semantics as the checker) and found a **third, independent cycle** the
checker silently misses:

```
review-builder.ts -> @/review -> review-iteration-store.ts -> @/findings
  -> findings/cycle.ts -> @/operations -> operations/plan.ts -> @/prompts
  -> review-builder.ts   (closes the loop)
```

`review-iteration-store.ts` is already barrel-exported (`index.ts` line 8)
and has nothing to do with `./runner` or `./adversarial`.

**Root cause of the false negative:** `scripts/check-import-cycles.ts`'s DFS
marks each node `DONE` after its first visit and never re-examines it. When a
node participates in more than one simple cycle within the same strongly
connected component, only the first cycle discovered during traversal gets
recorded — the others are silently dropped. This is a real defect in the
checker, not a fluke of this cycle. `check:import-cycles` reporting 0 is
**not sufficient proof** a barrel change is safe; `bun run test` is the only
reliable gate for this class of change.

**Net assessment:** splitting `./adversarial` alone does not unblock
`review-builder.ts`. Fully clearing this residual would additionally require
breaking the `review-iteration-store.ts -> findings -> operations -> prompts`
chain — a materially larger, deeper structural cycle spanning four core
modules (review, findings, operations, prompts), not a narrow leaf-file
split. That is a different order of risk and should not be attempted
opportunistically alongside the other two. Recommendation: leave
`review-builder.ts` on its leaf import permanently, same as the two §5
exemptions — don't reopen this without a dedicated investigation into the
`review-iteration-store.ts` / `findings/cycle.ts` coupling first.

## 8. Why the rules exist

Both non-obvious rules come from failures hit while building this, not caution.

- **`@test/<dir>/<internal>` is not exempt from the barrel rule.** A first pass
  treated everything under `test/` as safe and failed `check:alias-internals`
  on 8 `test/helpers` imports. The codemod now verifies per import that the
  barrel already exports every name, and refuses otherwise.
- **Biome on `test/` broke a ratchet.** Shortened import lines changed Biome's
  wrapping, splitting one cast across lines and joining another. That moved
  their line-scoped `// test-ratchet-allow` markers and shifted
  `check:test-as-unknown-as` from 815 to 816. The codemod's own edits were
  innocent.

## 9. Bug fixes during the run

Two bugs in the codemod and checker were caught and fixed while executing the
phases. Both are recorded here so the next person who touches the migration
tooling knows the pitfalls.

### 9.1 Checker regexed string literals (commit 01d76a834)

The checker's regex matched `from "../../foo"` even when the entire pattern
sat inside a `'…'` / `"…"` / `` `…` `` string literal — typical in test
fixtures that exercise the parser with realistic input. The codemod then
blindly rewrote those fixtures, breaking the parser tests that depended on the
deep-relative text as test data (8 failures in
`test/unit/scripts/check-deep-relatives.test.ts`).

Fix: precompute string-literal ranges for the whole file (single, double,
backtick; respects `\\` escapes; supports multi-line template literals and
unterminated quotes) and skip matches whose start offset falls inside one.
Comments are still flagged (runbook §6 wants JSDoc examples rewritten to show
the alias form). Cross-line string state is tracked by passing `content` to
`stringRanges` and matching `cursor + m.index` against the returned ranges.

This dropped 26 false positives from the ratchet (476 → 450) and unblocked the
Phase A tail batch.

### 9.2 Codemod missed nested barrels (commit 53ba31d84)

`targetDirHasBarrel` originally checked only the **immediate parent** of the
target file for a barrel (`src/context/engine/providers/plugin-loader` checked
`src/context/engine/providers/index.ts`, not `src/context/engine/index.ts`).
That misses the §5 precedent — the two imports in
`src/pipeline/stages/context.ts` and `src/pipeline/subscribers/hooks.ts` —
which are precisely the cases the runbook calls out as **permanently exempt**.
The codemod rewrote them anyway, producing `@/context/engine/providers/...`
aliases that bypass `src/context/engine/index.ts` and failed
`check:alias-internals` (77 barrels).

Fix: walk every ancestor from the target's directory up to the anchor (`src/`
or `test/`) and classify as `barrel-routing` if any of them has an `index.ts`.

This reclassified 6 imports from `src-specifier` to `barrel-routing`, leaving
them for Phase C manual escalation instead of producing broken rewrites.

### 9.3 `@scripts/*` alias added (commit 55328ec96)

Phase D required routing `test/unit/scripts/*.test.ts` imports of
`../../../scripts/*` to a path alias. No `@scripts/*` alias existed, so:

1. Added `@scripts/*: ["./scripts/*"]` to `tsconfig.json` (inherited by
   `tsconfig.test.json`).
2. Extended `suggestAlias` in the checker to recognize `scripts/` as an
   anchor and return `@scripts/<sub>`.
3. Extended `classify` in the codemod to accept `@scripts/` aliases (same
   exemption test files already get for `@/` and `@test/`).

13 test imports were then rewritten in commit 5c2e908cf.
