# Mutation Spot-Check: Diff-Line Scoping

**Date:** 2026-08-06
**Issue:** [#1482](https://github.com/nathapp-io/nax/issues/1482) (gap-analysis G3)
**Status:** Design approved, not implemented

## Problem

`mutationCheckOp` mutates whole changed **files**, not the lines the story changed. It gets a changed-file list from `getChangedNonTestFiles`, reads each file in full, and generates candidates over every line:

```ts
// src/operations/mutation-check.ts
const changedFiles = await deps.getChangedNonTestFiles(...);   // file granularity
for (const file of absoluteChangedFiles) {
  const source = await Bun.file(file).text();                  // whole file
  for (const m of generateMutants({ source, language, file })) mutants.push(m);
}
```

The original design (`docs/specs/2026-07-05-mutation-spot-check-design.md` §1 and §4) specifies mutating "lines **within the story's changed source diff**" — the reachability heuristic that makes a 3-mutant sample meaningful.

A survivor on an untouched line is not evidence about *this story's* tests; it is a pre-existing coverage gap attributed to a change that has nothing to do with it. The effect compounds with `maxMutants: 3`: a large file contributes at most a few samples, and the odds any of them land inside the story's actual diff are poor. PR #1480 fixed the *selection bias* (candidates gathered across all changed files, sampled evenly); the *candidate pool* is still every line of every changed file.

## Approach

Carry diff hunk line ranges through to `generateMutants` and filter candidates to added/modified lines.

Two alternatives were considered and rejected:

- **Filter after generation in the op.** No change to `mutator.ts`, but it builds a full candidate list for a 900-line file to discard 95% of it, and puts eligibility logic in the op where the next reader will not look for it.
- **Slice the source before generation.** Avoids the wasted work, but every mutant's line number then needs translating back to original-file coordinates — an off-by-one class of bug in the exact field (`line`) the survivor report points people at.

Filtering at generation costs one optional input field and one guard in a loop that already skips comment lines.

## Components

### `src/utils/diff-files.ts` (extended, ~25 → ~70 lines)

Already parses `+++ b/<path>` headers, skips `/dev/null`, handles CRLF, and is covered by `test/unit/utils/diff-files.test.ts`. Used by adversarial review (#986) for the `fileInDiff` axis.

Gains a second pure export sharing that header convention, so a second `+++ b/` parser cannot drift from the first:

```ts
export interface LineRange { readonly start: number; readonly end: number }  // 1-based, inclusive, new side
export function extractDiffLineRanges(diff: string): Map<string, LineRange[]>
```

### `src/verification/changed-line-ranges.ts` (new, ~120 lines)

The only genuinely new module — a thin async wrapper composing existing helpers:

```ts
export async function getChangedLineRanges(
  workdir: string,
  baseRef?: string,
): Promise<Map<string, LineRange[]> | null>
```

- Runs `gitWithTimeout(["diff", "--unified=0", ref], workdir)` — the same timeout wrapper `getChangedNonTestFiles` uses, so a hung git cannot orphan a process (BUG-039).
- Resolves each parsed path against `getGitRoot(workdir)` so **keys are absolute**.
- Returns `null` only when the diff was *unobtainable* (non-zero exit, spawn throw). An empty map means the diff was read and named no files. These two must stay distinguishable: the first triggers skip-everything, the second is a legitimate no-op.

Absolute keys are deliberate. `getChangedNonTestFiles` already performs non-trivial prefix surgery for the case where the git root sits above `repoRoot`, and the op anchors its results into `absoluteChangedFiles`. Keying absolutely lets the op look up by a value it already holds, instead of duplicating prefix logic in a second place where it can drift.

No existing helper returns full diff text for a ref — `captureDiffSummary` is `--stat`, everything else is `--name-only`.

### `src/verification/mutation/mutator.ts` (~60 → ~75 lines)

`GenerateMutantsInput` gains `lineRanges?: readonly LineRange[]`. Lines outside every range are skipped by the same `continue` that already skips comment lines.

Undefined means "every line". The mutator is a pure library function whose natural default is unrestricted; the *policy* (skip a file we cannot attribute) belongs to the op, which has exactly one code path. Existing mutator tests keep working unchanged.

### `src/operations/mutation-check.ts` (~208 → ~240 lines)

Fetches the range map once before the file loop.

- Map is `null` → warn, record a zero-candidate summary, return `success: true`.
- Per file: no entry, or an entry with no ranges → debug log, skip that file.
- Otherwise pass ranges into `generateMutants`.

Selection (`selectEvenlySpaced`) and the mutate → scoped-test → classify → revert loop are untouched. The op additionally counts total candidates generated.

### `src/runtime/mutation-summary.ts` and `src/log-format/mutation-summary.ts`

`MutationStorySummary` gains `candidates: number` and `checked: boolean`. `formatMutationSummary` grows a `NOT CHECKED` block listing stories where `checked && candidates === 0`:

```
SURVIVING MUTANTS
  US-002  src/config/merge.ts:88  ts:cmp-flip

NOT CHECKED (no mutable lines in diff)
  US-001  US-004
```

`checked` is load-bearing: the op records a summary entry for *every* story including when the feature is disabled, so without it a run with `mutationCheck.enabled: false` would report every story as not-checked.

`checked` is `true` exactly when the op got as far as looking for candidates — the feature is enabled **and** a test command resolved. The two early returns before that point (`!cfg.enabled`, no test command) record `checked: false`. A diff that could not be read records `checked: true`: the check was attempted and found nothing, which is precisely what the `NOT CHECKED` block exists to surface.

## Data flow

```
storyGitRef ─→ getChangedLineRanges ──→ Map<absPath, LineRange[]> | null
                                              │
changedFiles ─→ absoluteChangedFiles ─────────┤ lookup per file
                                              ↓
                      generateMutants({ source, language, file, lineRanges })
                                              ↓
                             selectEvenlySpaced(all candidates, maxMutants)
                                              ↓
                          apply → scoped tests → classify → revert  (unchanged)
```

## Error handling

Every path stays fail-open; the op is advisory and must never fail a story.

| Situation | Behaviour |
|:---|:---|
| `git diff` non-zero exit or spawn throws | `null` → warn with `storyId`, no candidates, summary `{checked: true, candidates: 0}` → story appears under `NOT CHECKED` |
| Malformed or partial diff text | Parser never throws; unrecognised lines ignored, whatever parsed cleanly is returned |
| Changed file absent from the map | Debug log with `storyId` + file; file skipped |
| Ranges present, no mutable lines | Zero candidates — not an error, not a warning |

**Rejected alternative:** falling back to whole-file candidates when ranges are unavailable. That keeps the gate running but reintroduces the misattribution this design exists to remove. A gate that goes quiet and says so beats one that reports a survivor it cannot attribute.

### Diff shapes the parser must handle

Each is a test case, not an assumption:

| Shape | Meaning | Contributes |
|:---|:---|:---|
| `@@ -1 +1 @@` | omitted count means 1, not 0 | one 1-line range |
| `@@ -0,0 +1,5 @@` | new file — every line added | one 5-line range |
| `@@ -5,3 +0,0 @@` | pure deletion, new-side count 0 | **no** range |
| `+++ /dev/null` | deleted file | dropped, never keyed |

Binary files produce no hunks and fall out naturally. Renames report the new path on the `+++` side and need no special handling.

## Monorepo awareness

Package scoping is **inherited, not re-implemented**. Candidate files still come from `getChangedNonTestFiles(..., packagePrefix, repoRoot)`, which already handles packagePrefix filtering, git-root prefix surgery, and `.naxignore`. The range map is consulted only for files already in that scoped list, so a story in `packages/api` cannot pick up hunks from `packages/web`.

Scoping the `git diff` itself with a `-- <prefix>/` pathspec (mirroring `captureDiffSummary`'s `scopePrefix`) was considered and rejected: that pathspec must be git-root-relative, duplicating the exact prefix logic this design avoids by keying absolutely. `--unified=0` output scales with the size of the change, not the repo.

Per `.claude/rules/monorepo-awareness.md`: no `process.cwd()` (workdir and repoRoot stay threaded as parameters), `storyId` first in every log line with `packageDir` alongside for package-scoped stories, and no new config keys — so there is no per-package layering obligation.

## Language agnosticism

The parser works at the git level and knows nothing about languages. Operator selection stays with `getOperatorsForLanguage` (five languages; empty otherwise, so unsupported languages remain a clean no-op), and `detectLanguage(packageDir)` is already package-scoped. Nothing new hardcodes a file extension, test marker, import syntax, or test-runner command. The existing Python-vs-C-style comment prefixes in `mutator.ts` are untouched.

## Testing

| Unit | Cases |
|:---|:---|
| `extractDiffLineRanges` (pure) | the four diff shapes above, multi-file diff, CRLF, empty input |
| `getChangedLineRanges` (injected git dep) | exit ≠ 0 → `null`; spawn throws → `null`; success → absolute keys; git root above `repoRoot` |
| `mutator.ts` | inclusive start boundary, inclusive end boundary, disjoint ranges, regression that `undefined` still means every line |
| `mutation-check.ts` (DI) | `null` map → zero candidates and still `success: true`; file missing from map is skipped; candidate count recorded on the summary |
| `formatMutationSummary` | `NOT CHECKED` renders; absent when nothing qualifies; absent when `checked` is false |

## Sizing

Three stories, dependent in a line:

1. **Diff-range parsing** — `extractDiffLineRanges` + `getChangedLineRanges`
2. **Candidate filtering** — `mutator.ts` `lineRanges` + op wiring, skip policy, candidate counting
3. **Summary surfacing** — `checked` / `candidates` on the summary + `NOT CHECKED` block

All touched files stay well under the 600-line source limit: `mutator.ts` 60, `mutation-check.ts` 208, `diff-files.ts` 25, new module ~120.

## Out of scope

Named here so planning does not wander into them:

- **G6** — `operators.test.ts` (`getOperatorsForLanguage` has no direct tests)
- **G8, G13, G14** — loop-invariant `selectScopedTests`, mutant dedupe and equivalence detection, run-level budget and parallelism
- **G9, G10** — content-verified revert, crash/interrupt cleanup
- Any config knob to choose diff-vs-file scoping — there is one behaviour
- In-diff / out-of-diff tagging on `Mutant` and `SurvivingMutant`
- **`maxMutants` stays at 3.** Diff-scoping shrinks the candidate pool sharply, so 3 now covers a much larger fraction of what changed; the default could arguably move either way. That is a call for the field data PR #1481 just started collecting, not a guess made here.
