# Deep-Relative Migration Runbook

**Status:** Complete — 0 residuals, Phase E executed (see §7.3)
**Branch:** `chore/deep-relatives-migration`
**Date:** 2026-08-20
**Follows:** PR #1649 (issue #1647), PR #1650 (issue #1648)

---

> **This migration is finished and its tooling is gone.** `check-deep-relatives.ts`,
> `migrate-deep-relatives.ts` and their baseline were deleted in Phase E
> (`abfa3b625`), so the commands in §§0–6 no longer run and their counts are
> frozen at the values seen during the run. Read §§0–6 as the record of how it
> was done, and §7.3 for the outcome. The one part still worth acting on is
> §7.3's technique — **nested-barrel promotion** — which is how you make a
> module reachable across directories when the parent barrel would close an
> import cycle.

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

The migration reduced **2,528 → 0** deep-relative imports. Phases C and E
initially stalled at 5 residuals (later 6); §7.3 records how nested-barrel
promotion cleared all of them and unblocked Phase E. Two codemod bugs were
found and fixed during the run — see §9.

| Class | Initial | Final | What happened |
|:---|---:|---:|:---|
| `test` | 2,344 | 0 | Phase A — 17 batches, all committed |
| `src-specifier` | 112 | 0 | Phase B — 6 batches, all committed |
| `barrel-routing` | 60¹ | 0 | Phase C — 55 routed across 21 commits, 5 escalated then cleared in §7.3 |
| `unresolved` | 17 | 0 | Phase D — `@scripts/*` alias added (13 imports), 4 JSDoc rewrites |
| **Total** | **2,533** | **0** | |

¹ 60, not the 54 in the table above — the ancestor-barrel fix (§9.2) reclassified 6 `src-specifier` cases as `barrel-routing` after this runbook was drafted.

Final ratchet state (all green):

| Ratchet | Baseline | Final |
|:---|---:|---:|
| `check:deep-relatives` | 2,845 | 0 — ratchet deleted, §7.3 |
| `check:import-cycles` | 42 loops | 135 modules — metric changed, see §7.3 |
| `check:test-typecheck` | 2,001 | 2,001 |
| `check:test-as-unknown-as` | 815 | 815 |
| `check:alias-internals` | 77 barrels | 83 barrels OK — 6 added by §7.3 |

## 1. Rules that override everything

- **Never run Biome over `test/` files.** `bun run lint` formats `src/` and
  `bin/` only — `test/` is deliberately unformatted. Reformatting it re-wraps
  unrelated casts and detaches their `// test-ratchet-allow` markers, which
  breaks `check:test-as-unknown-as`.
- **Never run `--update-baseline` on any ratchet.** Every baseline must hold
  exactly. A moved number means the batch broke something.
- **Never hand-edit a `barrel-routing` or `unresolved` import.** Those load a
  different module; changing them can create an import cycle.
- **Never lower the deep-relatives baseline** to match progress. It stayed at
  2,845 until the checker was deleted in Phase E.

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
| `check:alias-internals` | OK (barrel count rises as nested barrels are added) |
| `check:import-cycles` | 135 modules (was 29 loops during the run) |
| `check:test-typecheck` | 2,001 |
| `check:test-as-unknown-as` | 815 |
| `bun run test` | 0 fail |

`check:deep-relatives` was the only number that should move, and only
downward. (It no longer exists — see the banner.)

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
3. Run `bun scripts/check-import-cycles.ts`. **If the count rises, revert both
   edits** and leave the import as a deep relative — a deep relative is
   strictly better than a cycle. (The "above 42" in the original was written
   when actual == baseline == 42; compare against the *current* reading — now
   135, and counting modules rather than loops since the §7.2 defect was
   fixed.)
4. Record why anything was left behind.

Precedent: two imports in `src/pipeline/stages/context.ts` and
`src/pipeline/subscribers/hooks.ts` were treated as permanently exempt for this
reason — routing them through `@/execution` closes a 12-hop
`pipeline -> execution` loop. **Superseded by §7.3:** that loop only blocks
*barrel* routing, and both were cleared by promoting their targets to nested
barrels. Step 1 above ("add the missing symbol to the target's `index.ts`") is
the move that grows fat barrels and cycles; prefer nested-barrel promotion.

> **Note from the run:** The dry-run count was 60, not the 54 estimated above.
> The §9.2 ancestor-barrel fix reclassified 6 imports from `src-specifier` to
> `barrel-routing` because they bypass a non-immediate-parent barrel (e.g. the
> §5 precedent cases, which were previously classified as `src-specifier`).
> 55 of the 60 were routed and 5 escalated as residuals (2 runbook exemptions
> + 3 cycle raisers); all 5, plus a 6th added later, were cleared in §7.3.

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

**Done** — executed in `abfa3b625`; see §7.3. The checklist below is the
original plan, kept as written.

Only once `check:deep-relatives` reports **0**:

- Delete `scripts/check-deep-relatives.ts`,
  `scripts/migrate-deep-relatives.ts`,
  `scripts/baselines/deep-relatives-baseline.json`, and
  `test/unit/scripts/check-deep-relatives.test.ts`.
- Remove `check:deep-relatives` and `check:deep-relatives:update` from
  `package.json`, including from the `lint` chain.
- Drop the "Migration ratchet" paragraph from
  `.claude/rules/project-conventions.md` (in the event, from both rule roots —
  `.nax/rules/` is canonical). Keep the cycle ratchet and the barrel rules —
  those are permanent.
- Confirm `bun run check:gate-reachability` still passes.

If the count cannot reach 0 because Phase D is unresolved, stop and report the
residual rather than deleting anything.

### 7.1 First attempt on `review-builder.ts` — partial win, residual unchanged

Kept for the record; superseded by §7.3.

Dropped `./runner` from `src/review/index.ts`. This is a genuine improvement on
its own — `check:import-cycles` dropped from 39 to 29 — and cleaned up the
barrel's 3 real `runReview` consumers. It did **not** unblock
`review-builder.ts`: routing `SEMANTIC_CATEGORY_ENUM_LINE` through the barrel
still produced a TDZ crash (`Cannot access 'SEMANTIC_CATEGORY_ENUM_LINE'
before initialization`, failing 25 unrelated `test/unit/` files), caught by
`bun run test` and not by `check:import-cycles` or `tsc`. Root cause: a second,
independent cycle through `./adversarial`:

```
src/review/index.ts -> ./adversarial -> src/operations/adversarial-review.ts
  -> src/prompts/index.ts -> src/prompts/builders/review-builder.ts
  -> src/review/index.ts   (closes the loop)
```

It also left `run-initialization.ts` on a new deep relative, taking the
residual count from 5 to 6.

### 7.2 Second attempt — `./adversarial` split alone is still not enough

Kept for the record; superseded by §7.3.

Temporarily dropped `export * from "./adversarial";` and re-pointed
`review-builder.ts` at the barrel. `check:import-cycles` reported 0 cycles
touching either file and `tsc` passed, but `bun run test` hit the **identical
TDZ crash**. Tracing the graph by hand found a **third** independent cycle:

```
review-builder.ts -> @/review -> review-iteration-store.ts -> @/findings
  -> findings/cycle.ts -> @/operations -> operations/plan.ts -> @/prompts
  -> review-builder.ts   (closes the loop)
```

This produced the two findings that outlived the attempt: the
`check:import-cycles` DFS defect above, and the conclusion that clearing this
residual **through the barrel** would mean breaking a structural cycle spanning
review, findings, operations and prompts. That conclusion was correct, and
§7.3 makes it moot — the residual never needed the barrel.

### 7.3 Actual outcome — Phase E executed

Phases C and E stalled at **5** residuals, then **6**: commit `9c67939f9` (the
§7.1 `./runner` split) added `src/execution/lifecycle/run-initialization.ts:28
→ "../../review/runner"`, because `check:alias-internals` rejected the alias
form. All six are now cleared and the ratchet is retired.

**The blocking assumption was wrong.** Phase C read `check:deep-relatives` as
demanding *barrel routing*. It never did — it only demanded the *alias form*.
Barrel routing was `check:alias-internals`' constraint. And as that checker's
own header states, `@/foo/bar` and `../foo/bar` resolve to the same realpath
and therefore the same module instance, so converting a residual to a leaf
alias is a no-op in the module graph: no new edge, no cycle, no TDZ. Every wall
§7.1 and §7.2 hit came from routing through the barrel, which loads a
*different* module.

**The fix: nested-barrel promotion.** `classify()` in
`check-alias-internals.ts` returns `null` on an **exact** barrel match,
regardless of any parent barrel — which is why `@/review/typecheck-parsing`
(an existing nested barrel) is legal while `@/review/semantic-categories` was
not. Promoting the target with `git mv x.ts x/index.ts` makes the alias an
exact match. The import specifier is unchanged at the call site; only the
target's own sibling imports move up one level.

This is an established convention here, not a loophole: the repo already had
**29 nested barrels**, two of them inside `src/review/` itself. A directory
plus `index.ts` is a deliberate, reviewable declaration that the module is a
public sub-entry — which for all six is simply true, since that is why they are
imported across directories at all. It also avoids the alternative the gate
otherwise pushes you toward — widening the parent barrel — which is exactly
what produced the fat `@/review` barrel and the cycle hell in §7.1/§7.2.

| Residual | Promoted to | Cleared |
|:---|:---|:---|
| `src/prompts/builders/review-builder.ts` | `src/review/semantic-categories/index.ts` | `6a87c6643` |
| `src/prompts/builders/debate-builder.ts` | `src/debate/personas/index.ts` | `03c22c408` |
| `src/debate/verifiers/plan-checklist.ts` | `src/plan/spec-deltas/index.ts` | `51790c326` |
| `src/pipeline/stages/context.ts` | `src/execution/helpers/index.ts` | `ffece9d72` |
| `src/pipeline/subscribers/hooks.ts` | `src/execution/story-context/index.ts` | `bfefa9514` |
| `src/execution/lifecycle/run-initialization.ts` | `src/review/runner/index.ts` | `285393a7f` |

`check:import-cycles` held at 29 loops — its metric at the time — and the full
suite stayed green through every commit, as expected for a change that alters
no module identity. **The two §5
"permanent by design" exemptions were retired too**; that verdict was an
artifact of only ever attempting barrel routing.

Phase E then ran as written (`abfa3b625`): the checker, codemod, baseline and
test are deleted, both `package.json` scripts are gone including from the
`lint` chain, and the "Migration ratchet" paragraph is dropped from both rule
roots. `check:gate-reachability` reports 22 scripts (was 23).
`check:alias-internals`' header was reframed — its purpose is encapsulation,
not guarding a migration — and nested-barrel promotion is documented there as
the escape for cycle-forced cross-directory imports.

#### Two path couplings the file moves broke

Neither was found by grepping for import specifiers; both failed a gate:

- `scripts/check-dispatch-context.sh`'s ADR-020 allowlist pinned
  `src/review/runner\.ts:` as a literal regex.
- `scripts/baselines/coverage-per-file-baseline.json` keyed
  `src/execution/story-context.ts`. A renamed path reads as a *new* file below
  the floor, which fails the ratchet. The key was renamed — same file, same
  coverage, verified at 106 files below floor against a baseline of 106.

When moving a file, sweep `scripts/**` and `scripts/baselines/**` for its
literal path, not just its import specifier.

#### Known-open items, out of scope here

- **`bun run test:coverage` is red on this branch**, and was already red at
  `098ee85bb` before any of this work: `src/pipeline/stages/context.ts` sits at
  67.46% against a recorded 67.97%. Measured in a clean worktree at that
  commit — identical numbers, so it is not caused by the migration. It is not
  in `bun run lint`, `check:all`, or the pre-commit hook, only in CI.
- ~~**`check:import-cycles` has a real blind spot**~~ — **fixed** in
  `58728075a`. Its DFS marked each node `DONE` after the first visit, so within
  one strongly connected component only the first loop discovered was ever
  reported; a module could join an existing component and the check still read
  clean. It now uses Tarjan's SCC algorithm and counts the **modules** inside a
  cycle rather than the loops — complete and linear, where enumerating every
  simple cycle is not viable (`src/`'s largest component has 94 modules). A
  newly cyclic module also fails the check even when the total drops, so one
  added cycle cannot hide behind two removed. Baseline re-derived: 29 loops →
  135 modules, which is the extent the DFS was hiding, not a regression.
  Verified against the old script on the §7.2 change: its `--list` mentions
  `review-builder.ts` zero times, while the new one prints the full 8-hop loop
  §7.2 had to trace by hand.
- **The two rule roots have drifted.** `.claude/rules/project-conventions.md`
  and `test-architecture.md` are marked auto-generated from `.nax/rules/`, but
  carry hand-added #1647 content the canonical files lack. Running
  `nax rules export --agent=claude` today would delete it. Both roots were
  edited by hand here instead. Reconciling them is separate work.

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
phases. Both scripts have since been deleted (Phase E), so this section is kept
for the reasoning: the string-literal and ancestor-barrel pitfalls apply to any
future import-rewriting codemod, not just this one.

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
