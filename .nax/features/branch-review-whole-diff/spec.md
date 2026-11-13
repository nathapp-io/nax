# SPEC: branch-review-whole-diff — one branch review session reads the whole branch diff

## Summary

The workflow branch review goes back to one session that reviews the whole branch, and it is given the
whole branch diff to read. nax writes the full `git diff -U10` of the branch into numbered diff parts
next to the branch review package, each part small enough for one whole `Read`, and lists the parts and
the files each one holds in the package. The reviewer reads every part in order. A required file counts
as read when the reviewer lists it in `inspectedFiles`, when the session read the file whole, or when the
session read whole every part that holds the file's diff. The coverage retry names the part that holds
each unread file. The slicing added by #2862 (`planReviewSlices`, `mergeSliceVerdicts`, the
`workflow.review.sliceFiles` key, the slice line of the prompt and the `slices` field of the verdict) is
removed.

## Motivation

1. **The branch review should judge the branch as a whole.** Its remit is cross-story integration,
   contracts between packages and reachability, which only a reviewer that sees the whole branch can
   judge. #2862 (`branch-review-coverage`, merged 2026-11-11) split the review into fresh sessions of at
   most 15 files each (`workflow.review.sliceFiles`). A slice sees its own files and only names the rest.
   The owner's ruling (2026-11-13): the branch review is not sliced.
2. **Slicing restates every carried item once per slice.** The branch prompt tells the reviewer to
   "Repeat in your cannotVerify every one you still cannot verify" (`CARRY_CANNOT_VERIFY`,
   `workflow-branch-builder.ts`), and every slice receives the same carried list. `mergeSliceVerdicts`
   drops only exact-text duplicates. On #2884 (`fault-and-run-summary`, 96 changed files, 5 slices) the
   merged `branch-review.json` held 52 cannot-verify items for about 12 distinct facts; they became 52
   item threads, and posting them hit GitHub's secondary rate limit (#2886).
3. **The real cause of #2858 was a package with no diff in it.** `writeBranchReviewPackage` writes the
   commits, the `--stat`, and the changed-file names, "without a diff body" (nax#2622): the earlier inline
   diff was cut by `truncateDiff`, so the reviewer saw only the first files. The reviewer then has to
   choose which files to open, and on large branches it opened 13 of 58. The fix that keeps the whole
   branch in one session is to give the reviewer the whole diff, uncut, in pieces it can read whole.
4. **Sizes fit one session.** The full `-U10` diffs of the last three features were 331 KB (#2884,
   96 files), 222 KB (#2887, 36 files) and 399 KB (#2888, 72 files): about 9-13 parts of 32 KB each.
   nax-agent caps one model-facing tool result at `MODEL_MAX_BYTES` (40 000) bytes and `MODEL_MAX_LINES`
   (1 000) lines, so the diff has to arrive in parts below both caps.

## Design

### Approach

Six stories: a pure splitter (US-001), the part writer (US-002), part credit (US-003), the prompt and
coverage retry (US-004), the one-session review with the package's `readingNote` option (US-005), and
the slicing removal (US-006). No LLM call is added.

**Splitting (US-001).** `splitDiffIntoParts(diff: string): readonly DiffPartText[]`, with
`DiffPartText = { text: string; files: readonly string[] }`, is a pure function over `git diff` text:

- The diff is cut into per-file sections at each line starting with `diff --git `. The diff is run with
  `--no-renames` and `-c core.quotePath=false`, so the line reads `diff --git a/<path> b/<path>` with the
  same path twice; a section's file is that path, taken as the first `(length - 3) / 2` characters after
  `diff --git a/`. A header whose path git still quotes (it starts with `"`) has no file: the section is
  packed as usual and adds nothing to `files`.
- A diff line longer than `DIFF_PART_MAX_LINE_CHARS` (1 900) characters is wrapped before packing into
  lines of at most 1 900 characters; every line after the first starts with `\ continued: `. A part
  therefore never holds a line the `Read` tool would cut at `MODEL_MAX_LINE_CHARS` (2 000).
- A section's header is its lines from `diff --git` up to, not including, its first line starting with
  `@@`. A section with no `@@` line (a binary or mode-only change) is all header.
- Sections are packed greedily in diff order: a section joins the current part while the part stays at
  or under `DIFF_PART_MAX_BYTES` (32 000) UTF-8 bytes and `DIFF_PART_MAX_LINES` (900) lines; otherwise
  the current part closes and the section starts the next part.
- A section over either limit on its own is cut into pieces, and each piece is a part of its own: no
  other section joins it, and the next section starts a new part. The section is cut before its `@@`
  lines, consecutive hunks staying together while the piece fits, so each such piece is the header
  followed by whole hunks, each with its own `@@` line. A single hunk that does not fit is cut at line
  boundaries; every piece of it is the header, then that hunk's `@@` line, then the next run of the
  hunk's lines. The header and the repeated `@@` line count toward the piece's limits.
- A part's `files` are the files of the sections or pieces it holds, in order, without repeats; a file
  cut into pieces is in the `files` of every part that holds one of its pieces.
- An empty diff yields `[]`.

**Writing (US-002).** `writeBranchDiffParts(projectDir, from, packagePath): Promise<DiffPart[]>`, with
`DiffPart = { path: string; files: readonly string[] }`, runs one
`git -c core.quotePath=false diff --text --no-ext-diff --no-textconv --no-renames --unified=10 <from>..HEAD -- . <ALWAYS_EXCLUDED>`
through `_workflowDeps.git` (the flags and pathspec the static-mode patch already uses), splits it with
`splitDiffIntoParts`, and writes each part next to the package as `<stem>-part-<NN>.diff`, where `<stem>`
is the package file name without `.diff` (`package-branch` for `package-branch.diff`) and `<NN>` is the
1-based part number zero-padded to two digits, or to three when there are more than 99 parts. Before
writing, it deletes every `<stem>-part-*.diff` already in the package directory, so an earlier review of
the same run leaves no stale part. It then appends to the package a section headed `## Diff parts (<N>)`
with one line per part: `- <absolute part path>: <file>, <file>`. File-system calls go through a new
`_branchDiffPartsDeps = { list, remove, write }` seam (list the package directory's file names, delete one
file, write one file).

**The package's reading note (US-005).** `writeBranchReviewPackage` gains `readingNote?: boolean`
(default `true`). When `staticMode` is not `true` and `readingNote` is `false`, the package is written
without the "## How to read the diff" note. `staticMode: true` writes the full patch section as today and
ignores `readingNote`. `nax bot review` passes neither option change and keeps today's package.

**Part credit (US-003).** `toolReadParts(calls: readonly ToolCallRecord[], parts: readonly DiffPart[]):
string[]` returns, in part order without repeats, the files whose every holding part was shown whole by a
`Read` call: `tool: "Read"`, `outcome: "ok"`, `truncated: false`, `resultBytes <=
TOOL_READ_CREDIT_MAX_BYTES`, no `offset` and no `limit`, and `input.path` equal to the part's absolute
path. These are the gates the private `creditedPaths` applies; `toolReadParts` applies them itself. The
part path is compared as-is, because the run directory may sit outside the repository, where
`normalizeReviewPath` drops it. `ToolCallRecord` is the type `@nathapp/nax-agent` exports.

**Prompt and coverage retry (US-004).** `BranchReviewPromptInput` gains `diffParts?: readonly
DiffPart[]`. When it is non-empty, `buildWorkflowBranchReviewPrompt` describes the package as "commits,
--stat, changed files and the list of diff parts" and puts `buildBranchDiffPartsNote(parts)` where the
pull-each-file note was: a `## How to read the diff` section saying the parts hold the whole branch diff
with 10 lines of context, listing every part's absolute path, and telling the reviewer to Read every part
whole and in order, with no `offset` or `limit`, to open a changed file itself only for context the diff
does not show, and to list in `inspectedFiles` every file whose diff it read. With `diffParts` absent or
empty the prompt is byte-for-byte today's. `workflowBranchReviewOp`'s input gains `diffParts?: readonly
DiffPart[]`; the op turns it into a map from file to part file names and passes it to
`buildWorkflowBranchCoverageRetry` as the new optional `partsOf`. With `partsOf`, the retry tells the
reviewer to Read whole the part named beside each file, and lists each unread file as
`- <file> (<part file name>[, <part file name>])`; a file absent from the map is listed as today. The
retry stays in the same session with the same `workflow.review.coverageRetries` budget. Its `missing`
list stays the self-reported `inspectedFiles` comparison: tool-audit credit is read only after the
session ends (the audit file is flushed at hop end), so it shortens the final unread list, never a retry.

**One session (US-005).** `runBranchReview` writes the package with `readingNote: false`, calls
`_branchReviewDeps.writeBranchDiffParts`, classifies the required set as today, and makes exactly one
`callOp` of `workflowBranchReviewOp` inside one `underReviewLimit`, with `requiredFiles` the whole required
set and `diffParts` the written parts (absent when there are none). After the call it reads the session's
tool calls once with `readSessionToolCalls` (the query `observedToolReads` builds today) and derives both
`toolReadPaths(calls, projectDir)` and `toolReadParts(calls, parts)` from them. The unread set is the
required files not covered by the self-reported `inspectedFiles`, the tool reads, or the part reads. The
verdict carries `diffParts: { part: <part file name>; files }[]` when at least one part was written, and
neither `diffParts` nor `slices` otherwise.

**Removal (US-006).** `branch-review-slices.ts` (`planReviewSlices`, `mergeSliceVerdicts`,
`SliceResult`), the `BranchReviewSlice` type, the verdict's `slices` field, the prompt input's `slice`
field and its prompt line, `runSlice`, and the `workflow.review.sliceFiles` schema field, runtime type
field and config description are deleted. `workflow.review.sliceFiles` is added to `REMOVED_CONFIG_KEYS`
with the hint `the branch review is no longer split into slices; it reads the whole branch diff in one
session`.

### Integration (extends existing code)

Read-only (verified at `a23f3e11f`):

- `ALWAYS_EXCLUDED` (`@/review`) — the pathspec exclusions every review package uses.
- `ToolCallRecord` (`@nathapp/nax-agent`); `TOOL_READ_CREDIT_MAX_BYTES` (40 000),
  `readSessionToolCalls(query)`, `toolReadPaths(calls, repoRoot)` (`workflow/review-tool-reads.ts`).
- `unreadFiles(required, inspected, repoRoot)` (`operations/workflow-review-coverage.ts`).
- `reviewRequiredFiles(paths, fc)` (`workflow/review-coverage.ts`).
- `underReviewLimit`, `reviewPackageFailure` (`workflow/story-review.ts`).
- `_workflowDeps.git(args, cwd)` (`workflow/step-context.ts`).
- `MODEL_MAX_BYTES` (40 000), `MODEL_MAX_LINES` (1 000), `MODEL_MAX_LINE_CHARS` (2 000)
  (`nax-agent/src/tools/truncate.ts`). A whole `Read` adds a one-line `[N lines]` header to the body, so a
  part at 32 000 bytes and 900 lines stays under both caps.
- `stripKeysAtPaths` over `REMOVED_CONFIG_KEYS` (`config/removed-config-keys.ts`), which warns
  `Config key "<key>" has been removed — <hint>. Remove it from your config.`

Changed symbols. The baseline locates the code and is never the interface to implement.

- `writeBranchReviewPackage` (`workflow/git.ts`)
  - Baseline: `(projectDir, from, path, options?: { staticMode: boolean }): Promise<string[]>`
  - Target: `(projectDir, from, path, options?: { staticMode?: boolean; readingNote?: boolean }): Promise<string[]>`
- `runBranchReview(fc, input)` (`workflow/branch-review.ts`)
  - Baseline: plans slices with `planReviewSlices`, runs `runSlice` per slice, merges with `mergeSliceVerdicts`, and reads tool calls through `observedToolReads`.
  - Target: one `callOp` per review over the whole required set with `diffParts`; tool calls read once and credited by `toolReadPaths` and `toolReadParts`.
- `_branchReviewDeps` (`workflow/branch-review.ts`)
  - Baseline: `{ writeBranchReviewPackage, reviewRequiredFiles }`
  - Target: `{ writeBranchReviewPackage, writeBranchDiffParts, reviewRequiredFiles }`
- `BranchReviewPromptInput` (`prompts/builders/workflow-branch-builder.ts`)
  - Baseline: carries `slice?: { index; count; otherFiles }`.
  - Target: carries `diffParts?: readonly DiffPart[]` (US-004) and no `slice` (US-006).
- `buildWorkflowBranchCoverageRetry` (`prompts/builders/workflow-branch-builder.ts`)
  - Baseline: `(range, missing, staticMode = false, progress?)`
  - Target: `(range, missing, staticMode = false, progress?, partsOf?: ReadonlyMap<string, readonly string[]>)`
- `workflowBranchReviewOp` input (`operations/workflow-branch-review.ts`)
  - Target: gains `diffParts?: readonly DiffPart[]`.
- `BranchReviewVerdict` (`operations/workflow-types.ts`)
  - Baseline: `slices?: readonly BranchReviewSlice[]`
  - Target: `diffParts?: readonly { readonly part: string; readonly files: readonly string[] }[]` (US-005) and no `slices` (US-006).
- `WorkflowConfig["review"]` (`config/runtime-types-workflow.ts`) and `WorkflowReviewConfigSchema`
  (`config/schemas-workflow.ts`)
  - Baseline: `{ sliceFiles: number; coverageRetries: number }`
  - Target: `{ coverageRetries: number }`

New file `packages/nax/src/workflow/branch-diff-parts.ts`: `DiffPartText`, `DIFF_PART_MAX_BYTES`,
`DIFF_PART_MAX_LINES`, `DIFF_PART_MAX_LINE_CHARS`, `splitDiffIntoParts` (US-001); `DiffPart`, `_branchDiffPartsDeps`,
`writeBranchDiffParts` (US-002); `toolReadParts` (US-003). New prompt builder `buildBranchDiffPartsNote`
in `workflow-branch-builder.ts`, exported through `@/prompts` (US-004).

### Failure Handling

| Case | Behaviour |
|:---|:---|
| The `git diff` run by `writeBranchDiffParts` exits non-zero | throws `NaxError` code `WORKFLOW_REVIEW_PACKAGE_FAILED`; `runBranchReview` returns `{ ran: false }` without calling the op, as for any package failure today |
| Deleting a stale part fails | throws `WORKFLOW_REVIEW_PACKAGE_FAILED` before any part is written |
| The branch diff is empty | no part is written, `## Diff parts (0)` is appended, the op gets no `diffParts`, and the prompt keeps today's note |
| The session's tool audit cannot be read | `readSessionToolCalls` yields no calls, so no tool-read or part credit: only self-reported files count |
| A part was read with `offset` or `limit`, or the read was cut | that part earns no credit |

## Out of Scope

- The branch review keeps one `workflow.timeouts.reviewMs` (default 30 minutes) for its one session, coverage retries included, where each slice used to get its own; a branch that needs longer raises that key.
- Part credit and coverage-retry part names for a file whose path git quotes in the `diff --git` header (a double quote, backslash or control character in the path); such a file is still credited by the reviewer's own `inspectedFiles`.
- `nax bot review` keeps its current package (no diff parts) and its current coverage rules; `writeBranchReviewPackage` without the new option behaves as today.
- The branch fix re-review package (`package-branch-fix.diff`, written by `writeReviewPackage` through `truncateDiff`) is unchanged.
- No ceiling on the total branch diff size: a branch whose parts do not fit the reviewer's context is left to coverage, and files it did not read keep the PR a draft as today.
- Part credit inside a coverage retry: tool-audit credit is read after the session ends and shortens only the final unread list.
- Part credit for ACP sessions: their tool-audit rows carry no `truncated` field, so they earn no part credit, as they earn no tool-read credit today.
- Deduplicating restated cannot-verify items beyond today's exact-text merge; with one session the carried list is restated once.
- Pacing and retrying item-thread posts, writing the item index after a rate limit, and `nax workflow status` reading the decisions sidecar (#2886) are a separate feature.
- Starved CI checks (#2889) are a separate feature.
- Removing `workflow.review` or `workflow.review.coverageRetries`.
- Stripping `workflow.review.sliceFiles` from project or profile configs; no checked-in nax config sets it, and the removal warning names it for any that does.

## Stories

### US-001 — split a diff into whole-readable parts

Workdir: packages/nax. No dependencies.

Add `branch-diff-parts.ts` with `DiffPartText`, the part limits and the pure `splitDiffIntoParts`.

### US-002 — write the diff parts beside the branch package

Workdir: packages/nax. Depends on US-001.

Add `DiffPart`, `_branchDiffPartsDeps` and `writeBranchDiffParts` to `branch-diff-parts.ts`.

### US-003 — credit whole reads of diff parts

Workdir: packages/nax. Depends on US-002.

Add `toolReadParts` to `branch-diff-parts.ts`.

### US-004 — the branch prompt and coverage retry name the diff parts

Workdir: packages/nax. Depends on US-002.

Add `diffParts` to `BranchReviewPromptInput` and the op input, `buildBranchDiffPartsNote`, and the
`partsOf` lines of the coverage retry.

### US-005 — run the branch review as one session over the diff parts

Workdir: packages/nax. Depends on US-002, US-003, US-004.

`runBranchReview` writes the package without its reading note (the new `readingNote` option of
`writeBranchReviewPackage`) and the parts, makes one review call over the whole required set, credits
part reads, and records `diffParts` on the verdict.

### US-006 — remove branch review slicing

Workdir: packages/nax. Depends on US-005.

Delete the slicing code, types, prompt input and `workflow.review.sliceFiles`, and register
`workflow.review.sliceFiles` as a removed config key.

### Context Files

**US-001**
- `packages/nax/src/workflow/git.ts` — the static-mode patch flags, for the diff shape.
- `packages/nax/src/workflow/review-tool-reads.ts` — module layout and doc-comment conventions in `workflow/`.

**US-002**
- `packages/nax/src/workflow/git.ts` — `nameStatusArgs`, the static-mode patch flags.
- `packages/nax/src/workflow/step-context.ts` — `_workflowDeps.git`.
- `packages/nax/src/review/index.ts` — `ALWAYS_EXCLUDED`.
- `packages/nax/src/workflow/branch-diff-parts.ts` — created by US-001, extended here.

**US-003**
- `packages/nax/src/workflow/review-tool-reads.ts` — `creditedPaths`, `TOOL_READ_CREDIT_MAX_BYTES`.
- `packages/nax/src/workflow/branch-diff-parts.ts` — created by US-001 and US-002, extended here.

**US-004**
- `packages/nax/src/prompts/builders/workflow-branch-builder.ts` — `buildWorkflowBranchReviewPrompt`, `buildBranchPackageReadingNote`, `buildWorkflowBranchCoverageRetry`.
- `packages/nax/src/operations/workflow-branch-review.ts` — `workflowBranchReviewOp`.
- `packages/nax/src/prompts/index.ts` — the `@/prompts` barrel.
- `packages/nax/src/workflow/branch-diff-parts.ts` — `DiffPart`, created by US-002.

**US-005**
- `packages/nax/src/workflow/git.ts` — `writeBranchReviewPackage`.
- `packages/nax/src/workflow/branch-review.ts` — `runBranchReview`, `_branchReviewDeps`, `mergeBranchReview`, `observedToolReads`.
- `packages/nax/src/operations/workflow-types.ts` — `BranchReviewVerdict`.
- `packages/nax/src/workflow/review-tool-reads.ts` — `readSessionToolCalls`, `toolReadPaths`.
- `packages/nax/src/workflow/branch-diff-parts.ts` — created by US-001 to US-003, consumed here.

**US-006**
- `packages/nax/src/workflow/branch-review-slices.ts` — deleted.
- `packages/nax/src/operations/workflow-types.ts` — `BranchReviewSlice`, `slices`.
- `packages/nax/src/config/schemas-workflow.ts` — `WorkflowReviewConfigSchema`.
- `packages/nax/src/config/runtime-types-workflow.ts` — `WorkflowConfig["review"]`.
- `packages/nax/src/config/removed-config-keys.ts` — `REMOVED_CONFIG_KEYS`.

### Creates

**US-001**
- `packages/nax/src/workflow/branch-diff-parts.ts`
- `packages/nax/test/unit/workflow/branch-diff-parts-split.test.ts`

**US-002**
- `packages/nax/test/unit/workflow/branch-diff-parts-write.test.ts`

**US-003**
- `packages/nax/test/unit/workflow/branch-diff-parts-credit.test.ts`

**US-004**
- `packages/nax/test/unit/prompts/workflow-branch-builder-parts.test.ts`

**US-005**
- `packages/nax/test/unit/workflow/branch-review-diff-parts.test.ts`

### Modifies

**US-001**
None. The story only adds a new file.

**US-002**
None. The story only extends the new file.

**US-003**
None. The story only extends the new file.

**US-004**
None. With `diffParts` and `partsOf` absent the prompt and the retry are byte-for-byte today's, which is what the existing builder tests pin.

**US-005**
- `packages/nax/test/unit/workflow/branch-review-sliced.test.ts` — a branch with more than 15 required files no longer runs one session per slice: `callOp` is called once with the whole required set and the verdict has no `slices`; rewrite the multi-session and merge assertions to the one-session behaviour, or delete the tests that pin only slicing.
- `packages/nax/test/unit/workflow/branch-review-tool-reads.test.ts` — the review runs one session, not one per slice; tests that script one reply per slice script one reply, and the tool-call stub is read once for both tool-read and part credit.
- `packages/nax/test/unit/workflow/pr-step-context.test.ts` — the branch package is written with `readingNote: false`, so `git diff ${base}..HEAD -- <path>` is no longer in `package-branch.diff`; assert instead that the package holds `## Diff parts (1)` and a part line naming `change.txt`.

**US-006**
- `packages/nax/test/unit/workflow/branch-review-slices.test.ts` — tests `planReviewSlices` and `mergeSliceVerdicts`, which are deleted; delete the file.
- `packages/nax/test/unit/prompts/workflow-branch-builder-coverage.test.ts` — "AC-8/9: states slice context only when supplied" passes the deleted `slice` input; delete that test.
- `packages/nax/test/unit/config/schemas-workflow-review.test.ts` — `workflow.review` now parses to `{ coverageRetries: 3 }`: the `sliceFiles: 15` expectations become `{ coverageRetries: 3 }` (and `{ coverageRetries: 1 }`), "AC-3: review.sliceFiles: 0 fails to parse" is deleted, and the description test drops `workflow.review.sliceFiles` from its list.
- `packages/nax/test/unit/config/workflow-config.test.ts` — the expected resolved `review` block becomes `{ coverageRetries: 3 }`.
- `packages/nax/test/unit/operations/bot-pr-review-coverage.test.ts` — its config fixture sets `workflow.review.sliceFiles: 15`, which no longer type-checks; drop `sliceFiles` from the fixture.
- `packages/nax/test/unit/config/removed-config-keys.test.ts` — "REMOVED_CONFIG_KEYS is exactly the closed set of keys C1 removed" lists the closed key set; add `workflow.review.sliceFiles` to the expected list.

### Seams

- US-005 consumes US-002's `writeBranchDiffParts` through `_branchReviewDeps` (seam ACs US-005 #1, #2),
  US-003's `toolReadParts` (US-005 #6, #7), and US-004's prompt and op input (US-005 #3). The trigger is
  `runBranchReview` with a seed, which is what the feature graph's `branchReviewStep` calls through
  `FeatureEnv.steps.branchReview` once its `!rec.seed` guard passes.
- US-004's `buildBranchDiffPartsNote` and `partsOf` are created and consumed in the same story.
- US-006 consumes nothing new; its removals are verified by `bun run typecheck` and `bun run lint`.

## Acceptance Criteria

### US-001

1. [unit] `splitDiffIntoParts("")` returns `[]`.
2. [unit] A diff of two files of a few lines each, `a.ts` then `b.ts`, yields one part.
3. [unit] In the same case, the part's `files` are `["a.ts", "b.ts"]`.
4. [unit] In the same case, the part's `text` equals the input diff.
5. [unit] For a diff of 40 files of 2 000 bytes each, every part's `text` is at most `DIFF_PART_MAX_BYTES` (32 000) UTF-8 bytes.
6. [unit] For a diff of 40 files of 30 lines each, every part's `text` is at most `DIFF_PART_MAX_LINES` (900) lines.
7. [unit] For a diff of files that all fit the limits, the parts' `text` joined in order equals the input diff.
8. [unit] A file whose section has three hunks of 15 000 bytes each is cut into at least two parts, and each of those parts' `text` starts with that file's header lines.
9. [unit] In the same case, the file is in the `files` of every part that holds one of its hunks.
10. [unit] In the same case, a small file after the large one starts a new part instead of joining the large file's last piece.
11. [unit] A single hunk of 2 000 lines is cut into pieces of at most 900 lines each, header and repeated `@@` line included.
12. [unit] In the same case, every piece's `text` is the file's header, then the hunk's `@@` line, then hunk lines.
13. [unit] A diff line of 5 000 characters is written as three lines of at most 1 900 characters, the second and third starting with `\ continued: `.
14. [unit] For a header `diff --git a/dir with space/a.ts b/dir with space/a.ts`, the section's file is `dir with space/a.ts`.
15. [unit] A section whose header path is quoted (`diff --git "a/q\"x.ts" "b/q\"x.ts"`) adds nothing to its part's `files`.
16. [unit] `DIFF_PART_MAX_BYTES` is 32 000, `DIFF_PART_MAX_LINES` is 900 and `DIFF_PART_MAX_LINE_CHARS` is 1 900.

### US-002

1. [integration] In a temporary git repository with a seed commit and a second commit that changes `a.ts` and `b.ts`, `writeBranchDiffParts(repo, seed, <dir>/package-branch.diff)` writes `<dir>/package-branch-part-01.diff`.
2. [integration] In the same case, it returns one `DiffPart` whose `path` is that absolute path and whose `files` are `["a.ts", "b.ts"]`.
3. [integration] In the same case, the part file holds every line the second commit added to `a.ts`.
4. [integration] In the same case, the package file ends with a section headed `## Diff parts (1)` whose line names the part's absolute path and `a.ts, b.ts`.
5. [integration] A change to a path in `ALWAYS_EXCLUDED` is in no returned part's `files`.
6. [unit] With `_workflowDeps.git` returning a diff that splits into 3 parts, the written part names are `package-branch-part-01.diff`, `package-branch-part-02.diff` and `package-branch-part-03.diff`.
7. [unit] With a diff that splits into 120 parts, the first and last written part names are `package-branch-part-001.diff` and `package-branch-part-120.diff`.
8. [unit] With `_branchDiffPartsDeps.list` returning `["package-branch-part-07.diff", "other.diff"]`, `writeBranchDiffParts` calls `_branchDiffPartsDeps.remove` for `package-branch-part-07.diff` and not for `other.diff`.
9. [unit] When `_branchDiffPartsDeps.remove` throws, `writeBranchDiffParts` throws a `NaxError` with code `WORKFLOW_REVIEW_PACKAGE_FAILED`.
10. [unit] In the same case, `_branchDiffPartsDeps.write` is never called.
11. [unit] When `_workflowDeps.git` returns exit code 128 for the diff, `writeBranchDiffParts` throws a `NaxError` with code `WORKFLOW_REVIEW_PACKAGE_FAILED`.
12. [unit] When the diff is empty, `writeBranchDiffParts` returns `[]` and writes no part file.
13. [unit] In the same case, it appends a section headed `## Diff parts (0)` to the package.

### US-003

Every call below is a `Read` with `outcome: "ok"`, `truncated: false`, `resultBytes` 30 000, and no `offset` or `limit`, unless the AC says otherwise. The parts are `[{ path: "/run/package-branch-part-01.diff", files: ["a.ts"] }, { path: "/run/package-branch-part-02.diff", files: ["a.ts", "b.ts"] }]`.

1. [unit] With one call reading `/run/package-branch-part-02.diff`, `toolReadParts` returns `["b.ts"]`.
2. [unit] With calls reading both parts, `toolReadParts` returns `["a.ts", "b.ts"]`.
3. [unit] A call with `offset` 1 earns no credit.
4. [unit] A call with `limit` 100 earns no credit.
5. [unit] A call with `truncated: true` earns no credit.
6. [unit] A call with no `truncated` field earns no credit.
7. [unit] A call with `outcome: "error"` earns no credit.
8. [unit] A call with `resultBytes` 40 001 earns no credit.
9. [unit] A `Git` call whose input names `/run/package-branch-part-02.diff` earns no credit.

### US-004

1. [unit] `buildWorkflowBranchReviewPrompt` with two `diffParts` returns a prompt whose `## How to read the diff` section names both parts' absolute paths.
2. [unit] In the same case, the section tells the reviewer to Read every part whole and in order, without `offset` or `limit`.
3. [unit] In the same case, the prompt does not include `This package holds no diff`.
4. [unit] In the same case, the prompt describes the package as `commits, --stat, changed files and the list of diff parts`.
5. [unit] `buildWorkflowBranchReviewPrompt` with `diffParts: []` returns the same text as with `diffParts` absent.
6. [unit] `buildWorkflowBranchCoverageRetry("s..HEAD", ["a.ts"], false, { attempt: 1, max: 3 }, new Map([["a.ts", ["package-branch-part-03.diff"]]]))` returns a prompt with the line `- a.ts (package-branch-part-03.diff)`.
7. [unit] In the same case, the prompt tells the reviewer to Read whole the part named beside each file.
8. [unit] With `partsOf` holding `a.ts` in two parts, the line is `- a.ts (package-branch-part-01.diff, package-branch-part-02.diff)`.
9. [unit] With `partsOf` that lacks `b.ts`, the line for `b.ts` is `- b.ts`.
10. [unit] `buildWorkflowBranchCoverageRetry` without `partsOf` returns the same text it returns today for the same arguments.
11. [integration] `callOp` of `workflowBranchReviewOp` with `diffParts` holding `a.ts` in `/run/package-branch-part-02.diff`, `requiredFiles` `["a.ts"]`, and an agent stub whose first reply omits `a.ts` from `inspectedFiles`, sends a second prompt that includes `- a.ts (package-branch-part-02.diff)`.

### US-005

1. [unit] `runBranchReview` with `_branchReviewDeps.writeBranchDiffParts` stubbed calls it once with the project dir, the review seed and the run dir's `package-branch.diff` path.
2. [unit] With 40 required files, `writeBranchDiffParts` stubbed to return 3 parts, and `_workflowDeps.callOp` stubbed, `runBranchReview` calls `callOp` exactly once with `workflowBranchReviewOp`.
3. [unit] In the same case, the op input's `requiredFiles` holds all 40 files and its `diffParts` equals the 3 stubbed parts.
4. [unit] In the same case, the prompt passed to `callOp` names the absolute path of each of the 3 parts.
5. [unit] `runBranchReview` calls `_branchReviewDeps.writeBranchReviewPackage` with an options object whose `readingNote` is `false`.
6. [unit] When the reviewer's `inspectedFiles` omits `a.ts` and the session's tool calls hold a whole `Read` of every part that holds `a.ts`, the verdict's `unreadFiles` does not include `a.ts`.
7. [unit] When `a.ts` is held by parts 1 and 2 and the tool calls show only part 1 read whole, the verdict's `unreadFiles` includes `a.ts`.
8. [unit] When the session's tool audit yields no calls and the reviewer's `inspectedFiles` omits `a.ts`, the verdict's `unreadFiles` includes `a.ts`.
9. [unit] With 3 parts written, the verdict's `diffParts` lists each part's file name and files, in order.
10. [unit] With 3 parts written, the verdict has no `slices` field.
11. [unit] When `writeBranchDiffParts` returns `[]`, the verdict has no `diffParts` field.
12. [unit] When `writeBranchDiffParts` returns `[]`, the op input has no `diffParts` and the prompt includes `git diff <seed>..HEAD -- <path>`.
13. [unit] When `writeBranchDiffParts` throws `WORKFLOW_REVIEW_PACKAGE_FAILED`, `runBranchReview` returns `ran: false` with a `why` and never calls `callOp`.
14. [integration] `writeBranchReviewPackage(repo, seed, path, { readingNote: false })` writes a package with a `## Changed files` section and no `## How to read the diff` section.
15. [integration] `writeBranchReviewPackage(repo, seed, path)` writes the `## How to read the diff` section, as today.
16. [integration] `writeBranchReviewPackage(repo, seed, path, { staticMode: true, readingNote: false })` writes the `## Full patch` section, as static mode does today.

### US-006

1. [unit] `NaxConfigSchema.parse({}).workflow.review` equals `{ coverageRetries: 3 }`.
2. [integration] Loading a project config whose `workflow.review` is `{ "sliceFiles": 20, "coverageRetries": 2 }` warns `Config key "workflow.review.sliceFiles" has been removed`.
3. [integration] In the same case, the resolved `workflow.review` is `{ coverageRetries: 2 }`.
4. [unit] `REMOVED_CONFIG_KEYS["workflow.review.sliceFiles"]` is `the branch review is no longer split into slices; it reads the whole branch diff in one session`.

Verification note: the deletion of `branch-review-slices.ts`, `runSlice`, `BranchReviewSlice`, the verdict's
`slices`, the prompt's `slice` input and the `sliceFiles` runtime type field is verified by
`bun run typecheck` and `bun run lint`.
