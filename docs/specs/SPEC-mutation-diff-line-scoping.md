# SPEC: Mutation Spot-Check Diff-Line Scoping

<!-- spec-writing: completed-through-phase-5 -->

## Summary

The mutation spot-check mutates whole changed **files** rather than the lines a story changed, so a surviving mutant may sit on code the story never touched. This feature carries git diff hunk line ranges through to mutant generation and restricts candidates to added or modified lines. When the ranges for a file cannot be obtained, that file is skipped rather than mutated blind, and a story that ends up checking nothing says so at run end instead of looking indistinguishable from a clean pass.

## Motivation

`mutationCheckOp` gets a changed-**file** list from `getChangedNonTestFiles`, then reads each file in full and generates candidates over every line. The original design (`docs/specs/2026-07-05-mutation-spot-check-design.md` §1 and §4) specifies mutating "lines within the story's changed source diff" — the reachability heuristic that makes a small sample meaningful.

A survivor on an untouched line is not evidence about *this story's* tests; it is a pre-existing coverage gap attributed to an unrelated change. The effect compounds with `maxMutants: 3`: a large file contributes at most a few samples and the odds any land inside the story's real diff are poor. PR #1480 fixed the *selection bias* (candidates gathered across all changed files, sampled evenly); the *candidate pool* is still every line of every changed file.

Tracked as [#1482](https://github.com/nathapp-io/nax/issues/1482), gap-analysis item G3 — the last HIGH remaining on this feature.

## Design

Full design rationale, including rejected alternatives: `docs/superpowers/specs/2026-08-06-mutation-diff-line-scoping-design.md`.

### Approach

Filter **at generation**: `generateMutants` receives the eligible line ranges and skips lines outside them, using the same `continue` that already skips comment lines. Two alternatives were rejected — filtering after generation (builds a full candidate list to discard most of it, and hides eligibility logic in the op) and slicing the source before generation (forces line-number translation back to file coordinates, an off-by-one hazard in the exact field the survivor report cites).

Ranges come from **one** `git diff --unified=0 <ref>` per story, parsed into a map, not a spawn per file.

### Integration

Existing symbols this feature extends, with their verified current shapes:

| Symbol | Location | Change |
|:---|:---|:---|
| `extractDiffFiles(diff: string): Set<string>` | `src/utils/diff-files.ts` | unchanged — new sibling parser joins it in the same module, sharing its `+++ b/` and `/dev/null` conventions |
| `gitWithTimeout(args: string[], workdir: string, timeoutMs?: number): Promise<{stdout: string; exitCode: number}>` | `src/utils/git.ts` | unchanged — reused by the new fetcher |
| `getGitRoot(workdir: string): Promise<string \| null>` | `src/utils/git.ts` | unchanged — reused to anchor parsed paths |
| `GenerateMutantsInput { source, language, file }` | `src/verification/mutation/mutator.ts` | gains optional `lineRanges` |
| `MutationCheckDeps` / `_mutationCheckDeps` | `src/operations/mutation-check.ts` | gains `getChangedLineRanges` for injection |
| `MutationStorySummary { storyId, survivors, outcomes }` | `src/runtime/mutation-summary.ts` | gains `candidates: number` and `checked: boolean` |
| `formatMutationSummary(summaries): string` | `src/log-format/mutation-summary.ts` | gains the `NOT CHECKED` block |

New symbols:

```ts
// src/utils/diff-files.ts (extended)
export interface LineRange { readonly start: number; readonly end: number }  // 1-based, inclusive, new side
export function extractDiffLineRanges(diff: string): Map<string, LineRange[]>

// src/verification/changed-line-ranges.ts (new)
export async function getChangedLineRanges(
  workdir: string,
  baseRef?: string,
): Promise<Map<string, LineRange[]> | null>
```

Patterns to follow:

- `getChangedNonTestFiles` (`src/verification/smart-runner.ts:399`) is the model for the new fetcher: `gitWithTimeout` for the spawn, `baseRef ?? "HEAD~1"` for the default ref, and a `try/catch` returning a neutral value rather than throwing.
- `mutationCheckOp` imports its verification collaborators by **leaf path** (`../verification/smart-runner`, `../verification/runners`). The new fetcher is imported the same way, mirroring the `getChangedNonTestFiles` import directly above it — do not reroute it through the `src/verification` barrel.
- `_mutationCheckDeps` is the established DI seam for this op; tests inject fakes through it rather than mocking modules.

Keys in the returned map are **absolute paths**. `getChangedNonTestFiles` already performs prefix surgery for the case where the git root sits above `repoRoot`, and the op anchors its results into `absoluteChangedFiles`; keying absolutely lets the op look up by a value it already holds instead of duplicating that logic where it can drift.

### File Format

`git diff --unified=0` output. The parser must handle four hunk-header shapes:

| Header | Meaning | Yields |
|:---|:---|:---|
| `@@ -1 +1 @@` | omitted count means 1 | one range `{start: 1, end: 1}` |
| `@@ -0,0 +1,5 @@` | new file, all lines added | one range `{start: 1, end: 5}` |
| `@@ -5,3 +0,0 @@` | pure deletion, new-side count 0 | no range |
| `+++ /dev/null` | deleted file | no map entry |

For a header `@@ -a,b +c,d @@`, the range is `{start: c, end: c + d - 1}`. Binary files produce no hunks and yield no entry. Renames report the new path on the `+++` side and need no special handling.

### Failure Handling

Every path is fail-open — the op is advisory and must never fail a story.

| Situation | Behaviour | Owning story |
|:---|:---|:---|
| `git diff` exits non-zero, or the spawn throws | `getChangedLineRanges` returns `null`; the op logs a warning with `storyId`, generates no candidates, records `checked: true` with `candidates: 0`, and returns `success: true` | US-002, US-003 |
| Diff text is malformed or truncated | Parser never throws; unrecognised lines are ignored and whatever parsed cleanly is returned | US-001 |
| A changed file has no entry in the map | The op logs at debug with `storyId` and the file path, and skips that file | US-003 |
| A file's ranges contain no mutable lines | Zero candidates for that file — not an error, no warning | US-003 |

### Monorepo and language scope

Package scoping is inherited, not re-implemented: candidate files still come from `getChangedNonTestFiles(..., packagePrefix, repoRoot)`, which already applies packagePrefix filtering, git-root prefix surgery, and `.naxignore`. The range map is consulted only for files already in that scoped list. Scoping the `git diff` itself with a `-- <prefix>/` pathspec was rejected: that pathspec must be git-root-relative, duplicating the very prefix logic absolute keying avoids.

No `process.cwd()` — `workdir` and `repoRoot` stay threaded as parameters. Log lines put `storyId` first. No new config keys, so there is no per-package layering obligation.

The parser works at the git level and knows nothing about languages. Operator selection stays with `getOperatorsForLanguage`, and `detectLanguage(packageDir)` is already package-scoped. Nothing new hardcodes a file extension, test marker, import syntax, or test-runner command.

## Out of Scope

- `operators.ts` has no direct test file; adding `test/unit/verification/mutation/operators.test.ts` and covering the untested operator ids is deferred (gap item G6).
- `selectScopedTests` is recomputed per mutant although it is loop-invariant; hoisting it is deferred (gap item G8).
- Mutant dedupe across operators and equivalent-mutant detection are deferred (gap item G13).
- Serial mutant execution, the flat per-mutant timeout, and the absence of a run-level time budget are unchanged (gap item G14).
- Content-verified revert (revert is positional today) is deferred (gap item G9).
- Crash and interrupt cleanup for a partially applied mutant is deferred (gap item G10).
- No config key is added to choose between diff-scoped and whole-file candidate generation; diff-scoped is the only behaviour.
- Mutants are not tagged with in-diff or out-of-diff provenance, and the surviving-mutant report does not distinguish them.
- The `execution.mutationCheck.maxMutants` default stays at 3; retuning it against field evidence is deferred.
- Deleted lines are not mutated; only added and modified lines on the new side of the diff are eligible.

## Stories

1. **US-001: Parse hunk line ranges from a unified diff** — no dependencies
2. **US-002: Fetch changed line ranges for a story** — depends on US-001
3. **US-003: Restrict mutant candidates to changed lines** — depends on US-002
4. **US-004: Surface candidate counts and unchecked stories** — depends on US-003

### US-001 — Parse hunk line ranges from a unified diff

Add `extractDiffLineRanges` beside the existing `extractDiffFiles` in `src/utils/diff-files.ts`, sharing its header conventions. Pure function, no I/O.

#### Context Files
- `src/utils/diff-files.ts` — existing `+++ b/` parser to extend and mirror
- `test/unit/utils/diff-files.test.ts` — existing test patterns for this module

### US-002 — Fetch changed line ranges for a story

New module wrapping one `git diff --unified=0` call and anchoring parsed paths to absolute form.

#### Context Files
- `src/verification/smart-runner.ts` — `getChangedNonTestFiles` is the pattern to mirror (spawn wrapper, default ref, catch-and-return)
- `src/utils/git.ts` — `gitWithTimeout` and `getGitRoot` signatures
- `src/utils/diff-files.ts` — `extractDiffLineRanges` from US-001, called here

#### Creates
- `src/verification/changed-line-ranges.ts` — the fetcher
- `test/unit/verification/changed-line-ranges.test.ts` — its tests

### US-003 — Restrict mutant candidates to changed lines

Thread ranges into `generateMutants` and wire the op: fetch once, skip files without ranges, count candidates.

**Test-file placement:** `test/unit/operations/mutation-check.test.ts` is at 772 of the 800-line hard limit. New op-level tests for this story go in the new `test/unit/operations/mutation-check-diff-scope.test.ts` — do not append to the existing file.

#### Context Files
- `src/verification/mutation/mutator.ts` — `generateMutants` and `GenerateMutantsInput`
- `src/operations/mutation-check.ts` — the op, its `_mutationCheckDeps` seam, and the file loop
- `test/unit/operations/mutation-check.test.ts` — existing DI/fake patterns for this op
- `test/unit/verification/mutation/mutator.test.ts` — existing mutator test patterns

#### Creates
- `test/unit/operations/mutation-check-diff-scope.test.ts` — op-level tests for diff scoping

### US-004 — Surface candidate counts and unchecked stories

Add `candidates` and `checked` to the story summary and render a `NOT CHECKED` block at run end.

`checked` is `true` exactly when the op reached candidate gathering — the feature is enabled **and** a test command resolved. The two early returns before that point record `checked: false`. A diff that could not be read records `checked: true`: the check was attempted and found nothing, which is what the block exists to surface.

### Modifies

- `test/unit/operations/mutation-check.test.ts` — the two `expect(mutationSummaries.get("US-004")).toEqual({...})` assertions (the disabled short-circuit at ~line 78 and the no-test-command case at ~line 101) assert the summary's exact shape and **must** be updated to include `checked: false` and `candidates: 0`. They are closed-world `toEqual` checks; adding fields necessarily breaks them.
- `test/unit/log-format/mutation-summary.test.ts` — the `makeSummary()` helper constructs a `MutationStorySummary` literal and must gain the two new fields.

#### Context Files
- `src/runtime/mutation-summary.ts` — `MutationStorySummary` and `MutationOutcomeSummary`
- `src/log-format/mutation-summary.ts` — `formatMutationSummary` and the existing `SURVIVING MUTANTS` block
- `src/operations/mutation-check.ts` — the `record()` helper and the early returns that must set `checked`
- `test/unit/log-format/mutation-summary.test.ts` — existing formatter tests and the `makeSummary()` helper
- `test/unit/operations/mutation-check.test.ts` — carries the two closed-world assertions listed above

### Seams

- **US-001 → US-002:** US-002's tests feed a known diff through the stubbed git dep and assert the returned map matches the ranges that diff encodes — proving `extractDiffLineRanges` is actually called, not merely present.
- **US-002 → US-003:** US-003's tests inject `getChangedLineRanges` through `_mutationCheckDeps`, invoke `mutationCheckOp.execute`, and assert it was called with the story's workdir and git ref.
- **US-003 → US-004:** US-004's tests invoke `mutationCheckOp.execute` and assert the recorded summary carries the candidate count the op counted.

## Acceptance Criteria

### US-001 — Parse hunk line ranges from a unified diff

- [unit] `extractDiffLineRanges` is importable from `src/utils/diff-files` and returns a `Map` when called with a diff string.
- [unit] For a diff whose only hunk header is `@@ -0,0 +1,5 @@` under `+++ b/src/a.ts`, the map entry for `src/a.ts` is a single range with `start` 1 and `end` 5.
- [unit] For a hunk header with an omitted new-side count (`@@ -1 +1 @@`), the produced range has `start` 1 and `end` 1.
- [unit] For a hunk header whose new-side count is zero (`@@ -5,3 +0,0 @@`), no range is produced for that file.
- [unit] For a diff containing two files, the returned map has one entry per file path, each holding only that file's ranges.
- [unit] A file whose header is `+++ /dev/null` produces no entry in the returned map.
- [unit] For a file with two hunks at `@@ -10,0 +11,2 @@` and `@@ -30,0 +40,1 @@`, the entry holds both ranges in the order they appear in the diff.
- [unit] A diff using CRLF line endings yields the same map as the same diff using LF endings.
- [unit] `extractDiffLineRanges("")` returns an empty map.
- [unit] A diff containing lines that match no recognised header form returns a map built from the headers that did parse, and does not throw.

### US-002 — Fetch changed line ranges for a story

- [unit] `getChangedLineRanges` is importable from `src/verification/changed-line-ranges` and resolves to a `Map` when the git call succeeds.
- [unit] When the git call succeeds, the arguments passed to the injected git runner are `diff`, `--unified=0`, and the supplied ref, in that order.
- [unit] When `baseRef` is omitted, the ref passed to the injected git runner is `HEAD~1`.
- [unit] When the git call returns a non-zero exit code, `getChangedLineRanges` resolves to `null`.
- [unit] When the injected git runner throws, `getChangedLineRanges` resolves to `null` rather than propagating the error.
- [unit] When the git call succeeds with empty output, `getChangedLineRanges` resolves to an empty `Map`, not `null`.
- [unit] Given a git root of `/repo` and a diff naming `src/a.ts`, the returned map's key is the absolute path `/repo/src/a.ts`.
- [unit] When the git-root lookup resolves to `null`, paths are anchored to the supplied `workdir` instead.
- [unit] Given stubbed git output containing a hunk at `@@ -0,0 +2,3 @@` for one file, the returned map's entry for that file holds a range with `start` 2 and `end` 4.

### US-003 — Restrict mutant candidates to changed lines

- [unit] `generateMutants` given `lineRanges` covering only line 5 returns mutants whose `line` is 5, and none for mutable lines outside that range.
- [unit] `generateMutants` includes a mutant for a mutable line equal to a range's `start`.
- [unit] `generateMutants` includes a mutant for a mutable line equal to a range's `end`.
- [unit] `generateMutants` given two disjoint ranges returns mutants from both and none from the lines between them.
- [unit] `generateMutants` called without `lineRanges` returns mutants for every mutable line in the source, unchanged from current behaviour.
- [unit] `generateMutants` given an empty `lineRanges` array returns no mutants.
- [unit] When the injected `getChangedLineRanges` resolves to `null`, `mutationCheckOp.execute` resolves with `success` true and `outcomes` of zero killed, zero survived, and zero errored.
- [unit] When the injected `getChangedLineRanges` resolves to `null`, `mutationCheckOp.execute` never invokes the injected regression runner.
- [unit] When the returned map has no entry for a changed file, `mutationCheckOp.execute` generates no mutants for that file and still resolves with `success` true.
- [unit] When the returned map holds ranges for a changed file, the `lineRanges` passed to mutant generation for that file are the ranges the map holds for it.
- [unit] `mutationCheckOp.execute` invokes the injected `getChangedLineRanges` once with the story's `workdir` and `storyGitRef`.
- [unit] When a file's ranges cover only lines holding no mutable content, `mutationCheckOp.execute` resolves with `success` true and never invokes the injected regression runner.

### US-004 — Surface candidate counts and unchecked stories

- [unit] After `mutationCheckOp.execute` runs with the check enabled and candidates generated, the summary recorded for the story has `checked` true.
- [unit] After `mutationCheckOp.execute` runs with `mutationCheck.enabled` false, the summary recorded for the story has `checked` false.
- [unit] After `mutationCheckOp.execute` runs with no resolvable test command, the summary recorded for the story has `checked` false.
- [unit] After `mutationCheckOp.execute` runs with the injected `getChangedLineRanges` resolving to `null`, the summary recorded for the story has `checked` true and `candidates` zero.
- [unit] After `mutationCheckOp.execute` generates candidates for a story, the recorded summary's `candidates` equals the number of mutants generated before budget selection.
- [unit] `formatMutationSummary` given one summary with `checked` true and `candidates` zero returns text containing `NOT CHECKED` and that summary's story id.
- [unit] `formatMutationSummary` given one summary with `checked` false and `candidates` zero returns text that omits `NOT CHECKED`.
- [unit] `formatMutationSummary` given one summary with `checked` true and `candidates` greater than zero returns text that omits `NOT CHECKED`.
- [unit] `formatMutationSummary` given one summary with a survivor and another with `checked` true and `candidates` zero returns text containing both `SURVIVING MUTANTS` and `NOT CHECKED`, with `SURVIVING MUTANTS` first.
- [unit] `formatMutationSummary` given two summaries that both have `checked` true and `candidates` zero lists both story ids under `NOT CHECKED`.
- [unit] `formatMutationSummary` given only summaries with `checked` false returns an empty string.
