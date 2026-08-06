# Code Review — mutation spot-check, context-engine v2 rules, spec→PRD fidelity

**Date:** 2026-08-06
**Range reviewed:** `e7721ea5afad2a6b4a62c084ccf0afa27520d468..7a894aca` (30 commits, 301 files, ~38k insertions)
**Baseline at review time:** `bun run typecheck` exit 0, `bun run lint` exit 0.

**Method:** manual read of the highest-churn source paths in the range, plus a runtime probe to
confirm finding 3. Coverage was concentrated on three subsystems, which together account for most
of the new source in the range:

| Subsystem | Entry points |
|:---|:---|
| Mutation spot-check | `src/verification/mutation/*`, `src/verification/changed-line-ranges.ts`, `src/operations/mutation-check.ts` |
| Context-engine v2 rules | `src/context/rules/*`, `src/context/engine/providers/static-rules.ts`, `src/cli/rules.ts`, `src/cli/rules-lint.ts` |
| Spec→PRD fidelity | `src/prd/markdown-scan.ts`, `src/prd/{modifies,out-of-scope,context-files}-extract.ts`, `src/operations/plan-fidelity.ts` |

Not re-reviewed in depth: the `nax-finish` PR-body work, `src/metrics/tracker.ts`, and the
`src/context/engine/manifest-*` type split — these read as mechanical and are well covered by the
new tests in the range.

---

## Severity summary

| # | Finding | Severity | Status |
|:--|:--------|:--------:|:------:|
| 1 | An unreverted mutant reaches a commit | **HIGH** | Fixed |
| 2 | `mutation-check` compares symlinked against realpath'd paths | **MEDIUM** | Fixed |
| 3 | `applySectionBudget` interleaves and shreds rules | **MEDIUM** | Fixed |
| 4 | `splitRuleIntoSections` splits on `## ` inside fenced code blocks | **LOW** (latent) | Fixed |
| 5a | Mutants generated inside string literals and inline comments | **LOW** | Fixed |
| 5b | `#558` early return omits `scopingReport` | **LOW** | Fixed |
| 5c | Scope-filtered-to-empty reported as a budget failure | **LOW** | Fixed |
| 5d | Two token estimators over the same rule content | **LOW** | Fixed |
| 5e | `isSafeRelativePath` rejects paths merely *containing* `..` | **LOW** | Fixed |
| 5f | Diff parser assumes `diff.noprefix=false` | **LOW** | Fixed |

---

## 1. An unreverted mutant reaches a commit — HIGH

`src/operations/mutation-check.ts` correctly refuses to overwrite a line whose content it cannot
account for, and records `revertFailed`. But the op returns `success: true` on every path, and the
only consumer of the flag was a printed block at run end (`src/log-format/mutation-summary.ts`).

Meanwhile `autoCommitIfDirty` runs *after* the verify stage at three sites:

- `src/review/runner.ts` (post-review)
- `src/execution/post-run.ts` (post-execution)
- `src/execution/runner-completion.ts` (run summary)

So the failure path was: mutation applied → revert unconfirmed → story continues → deliberately
broken source is committed to the story branch, and with `autoPR` enabled, pushed.

The crash-durable journal does not cover this case. It is swept only at the start of the *next*
mutation-check in the same working tree, and in parallel mode each story's worktree is removed on
merge (`src/execution/parallel-batch.ts`), taking the journal with it.

The feature being advisory justifies not *failing* the story. It does not justify letting an
injected mutation into a commit.

**Fix applied.** `NaxRuntime` gained a `dirtyWorktrees: Set<string>` register. `mutationCheckOp`
adds the worktree path when a revert cannot be confirmed, and `autoCommitIfDirty` takes an optional
`blockedWorktrees` set and refuses to stage when the git root it would `git add -A` from overlaps
one, logging an error that points at the mutation-check log. The three story-path call sites
(`review/runner.ts`, `execution/post-run.ts`, `execution/runner-completion.ts`) pass
`runtime.dirtyWorktrees`.

Two call sites were deliberately handled differently:

- `pipeline/stages/acceptance-setup.ts` commits **pre-run**, before any story's `storyGitRef` is
  captured, so it cannot run after a mutation. Left unwired.
- `tdd/rollback.ts` `captureSnapshotRef` is reachable after the verify stage, and it commits as its
  *first* act — which would both capture the defect and leave the tree clean, so every later guard
  would see nothing to block. Rather than block the commit there, `runNonBlockingFix` now skips the
  whole best-effort pass when its workdir is blocked, degrading to "nbf did not run" exactly as the
  existing snapshot-failure path does. The check sits before the snapshot for that reason.

A `git checkout -- <file>` style restore was rejected: the mutated file also holds the story's
legitimate implementation, so discarding it would destroy real work to undo one line.

## 2. `mutation-check` compares symlinked against realpath'd paths — MEDIUM

`getGitRoot` returns git's realpath — `git rev-parse --show-toplevel` run from `/tmp/repo` answers
`/private/tmp/repo` (`src/utils/git.ts`). `src/verification/mutation/journal.ts` documents this
hazard at length and normalizes for it via `realOrRaw`/`isInside`. `mutation-check.ts` did not:

- `anchor` was `input.repoRoot` (caller-supplied, unresolved) in the `packagePrefix && repoRoot`
  branch, and `getGitRoot(workdir)` (resolved) otherwise.
- `rangeMap` keys are always resolved (`src/verification/changed-line-ranges.ts`).
- `scopeRoot` was always `input.repoRoot ?? input.workdir` — unresolved.

Two distinct failures followed. In the `packagePrefix && repoRoot` branch, unresolved candidate
paths never matched resolved range-map keys, so every file landed in `unmappedFiles` and the check
produced zero candidates. In the other branch the mismatch is worse: `anchor` is resolved but
`scopeRoot` is not, so the containment filter dropped *every* file, leaving
`absoluteChangedFiles` empty — which also skips the zero-candidate warning, since that warning is
guarded on `absoluteChangedFiles.length > 0`. The result was a silent no-op with no diagnostic.

On macOS, where `/tmp` is a symlink to `/private/tmp` and worktrees are created under temp
directories, this is the common case rather than an edge case.

**Fix applied.** The symlink normalisation in `journal.ts` was promoted to a shared helper
(`src/utils/realpath.ts`) and both modules now use it. `mutation-check` carries each candidate as a
`{ path, resolved }` pair: `resolved` is used for the containment filter and the range-map lookup
(whose keys are re-keyed through the same normaliser), while `path` keeps the caller's spelling and
is what gets read, mutated, journalled, and reported — so a survivor still names the path the
operator recognises rather than an unfamiliar `/private/...` twin.

`realOrRaw` also had to be strengthened while promoting it. The original resolved only the
immediate parent when a path did not exist, which leaves several segments unresolved for a file
under a directory that was never created — and a half-resolved path compares unequal to a
fully-resolved root, reintroducing the same false-negative containment. It now walks up to the
nearest existing ancestor and re-attaches the remainder.

## 3. `applySectionBudget` interleaves and shreds rules — MEDIUM

`src/context/rules/rule-budget.ts` sorted by `(priority, ordinal)` with no rule-identity
tiebreaker. Because `priority` defaults to 100 for every rule, sections from different files
interleaved by ordinal. Confirmed with a runtime probe against the real code:

```
input   : alpha#preamble | alpha#a | alpha#b | alpha#c | beta#preamble | beta#a | beta#b | beta#c
retained: alpha#preamble | beta#preamble | alpha#a | beta#a | alpha#b
dropped : beta#b | alpha#c | beta#c
```

This contradicts the module's own stated contract. Its header says "ascending by `ordinal` **within
a rule**" and "the boundary file contributes its leading sections instead of being dropped whole" —
but there is no boundary file. Every rule is truncated at the same ordinal, and `alpha` keeps a
section that `beta` loses at the same position.

Under `enforceBudget: true` (the schema default; note `StaticRulesProvider`'s constructor fallback
is deliberately `false`) this interleaved, shredded ordering is what ships to the agent.

**Fix applied.** A rule-identity tiebreaker now sits between `priority` and `ordinal`, so sections
sort priority-major, then rule-major, then ordinal — making the retained set a contiguous prefix
per rule and restoring the single-boundary-file property the docstring describes.

## 4. `splitRuleIntoSections` splits on `## ` inside fenced code blocks — LOW (latent)

`src/context/rules/rule-sections.ts` tested `/^## /` line-by-line with no fence tracking. A rule
file that documents markdown by example would be split mid-fence, and budget truncation could
deliver a section with an unclosed fence.

This is exactly the hazard `src/prd/markdown-scan.ts` devotes several paragraphs to as "not a
detail" for the sibling spec parser — and its `fencedLineIndices` helper was already available.

No rule file currently in `.nax/rules/` triggers it (scanned), so the finding is latent rather
than active.

**Fix applied.** `fencedLineIndices` was moved to a shared, dependency-free helper
(`src/utils/markdown-fence.ts`) — `src/prd/markdown-scan.ts` re-exports it for its existing
consumers — and `splitRuleIntoSections` now consults it, ignoring H2 candidates inside a fence.
A shared util rather than a cross-subsystem import: `src/context/rules` reaching into the `src/prd`
barrel for one pure markdown primitive is the wrong dependency direction.

## 5. Smaller items

**5a — mutants inside strings and inline comments.** `src/verification/mutation/mutator.ts` skipped
only whole-line comments. Flipping `==` inside a regex literal, a string, or a trailing `// ...`
comment produces a mutant that is either always-killed or meaningless, wasting scarce `maxMutants`
slots. *Fixed:* operators now see only the line's leading **code region** — everything before the
first string delimiter or comment marker — and the remainder is carried through verbatim so
`before`/`after` still span the whole line for apply/revert. A prefix rather than a full segment map
is deliberate: mutating each code segment between literals would require aligning an operator's
variants across segments, and `MutationOperator.apply` returns bare strings with no variant identity
to align on. The cost is losing code that follows a literal on the same line; for a check that
samples a handful of sites, fewer-and-sound beats more-and-noisy.

**5b — `#558` early return omits `scopingReport`.** `static-rules.ts` returns early when canonical
rules exist but none apply to the package context, without the scoping report the rest of the path
populates — making that case invisible to manifest telemetry. *Fixed:* the report is now built and
returned on that path.

**5c — misleading budget warning.** When `scopedRules` is emptied by `stages:`/`appliesTo:`
filtering rather than by the budget, the warning still read "No rule sections fit in static rules
budget" — misleading for exactly the diagnostic a user would reach for. *Fixed:* the two causes are
now distinguished.

**5d — two token estimators.** `static-rules.ts` defined a local `estimateTokens` (`len/4`) while
`rule-sections.ts` uses `estimateTokens` from `@/optimizer` for the budget — two estimators over
the same content. *Fixed:* collapsed onto the `@/optimizer` one.

**5e — `isSafeRelativePath` over-rejects.** `src/prd/modifies.ts` rejected any path *containing*
`..`, so a legitimate `src/foo..bar.ts` was dropped. Safe direction, but wrong. *Fixed:* the check
is now segment-wise (`..` as a whole path segment), which still rejects every traversal.

**5f — diff parser assumes `diff.noprefix=false`.** `src/utils/diff-files.ts` parses `+++ b/` only.
With `diff.noprefix=true` in a user's git config every hunk is discarded and the mutation check
degrades to zero ranges — fail-open, but silent. *Fixed:* the parser accepts the unprefixed form,
gated on the header pairing. An ADDED line whose content begins `++ ` renders as `+++ ...` inside a
hunk and is indistinguishable from an unprefixed header on its own, so the unprefixed form is only
honoured immediately after a `---` line — which unified diff always emits. The `b/` form keeps its
existing unconditional handling.

---

## Not findings

Reviewed and found correct:

- `resolveStoryPathAnchors` (`src/execution/build-plan-for-strategy.ts`) — handles both input
  shapes and the trailing-separator case correctly.
- The effort-suffix strip in `src/agents/cost/calculate.ts` (`#1464`).
- `flipWithPairs` longest-first alternation (`#1487`) — the `!==` → `!!=` fix is sound, and the
  shared-`lastIndex` hazard on `COMPARISON_GT`/`COMPARISON_LT` is handled.
- `selectRegressedGateFindings` and the carve-out change in `rectification.ts` (`#1452`).

---

## Verification

All fixes carry regression tests that fail against the pre-fix code:

| Fix | Tests |
|:---|:---|
| 1 | `test/unit/utils/git-auto-commit-block.test.ts` (new), `test/unit/operations/mutation-check-revert.test.ts`, `test/unit/execution/non-blocking-fix.test.ts` |
| 2 | `test/unit/utils/realpath.test.ts` (new) |
| 3 | `test/unit/context/rules/rule-budget.test.ts` |
| 4 | `test/unit/context/rules/rule-sections.test.ts` |
| 5a | `test/unit/verification/mutation/mutator.test.ts` |
| 5b, 5c | `test/unit/context/engine/providers/static-rules-scoping.test.ts` |
| 5e | `test/unit/prd/modifies.test.ts` |
| 5f | `test/unit/utils/diff-files.test.ts` |

`bun run lint`, `bun run typecheck`, and `bun run test` all pass.
