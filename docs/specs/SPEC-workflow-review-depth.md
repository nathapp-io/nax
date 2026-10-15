# SPEC: Workflow Review Depth

## Summary

Workflow mode's two reviewers (the per-story review and the whole-branch review) get an explicit
code-quality checklist and a per-function enumeration step, and the branch review stops relying on an
inline diff that the 50 KB cap cuts arbitrarily. The branch review package carries the commit list, the
`--stat` and every changed file with its status, and no diff body; the reviewer runs
`git diff <seed>..HEAD -- <path>` per file. nax computes the branch's changed files minus tests, docs, lockfiles and images, and
checks them against the reviewer's `inspectedFiles`: a verdict that misses some is re-asked once in the
same session, naming the missing files, and if files are still unread the verdict is kept and the PR
stays a draft with a readiness reason naming them. Closes nathapp-io/nax#2532 (items A, B and D; C was
dropped).

Closes: #2532

## Motivation

A workflow run of 8 stories and 82 changed files finished `publish ready`. Its branch review reported
`spec: pass, quality: approved` and 2 minors. A post-implementation review of the same PR then found 7
real defects (1 critical, 3 high, 3 medium), all confirmed and fixed by hand:

| Severity | Defect class |
|---|---|
| Critical | Data-store semantics: identity columns on a case-insensitive collation could merge distinct records |
| High | Production wiring: an in-memory sequence used where the platform provides a shared generator |
| High | Concurrency: a stale submission racing an approval could allow a second owner |
| High | Test isolation: integration tests depended on preceding test bodies |
| Medium | Input safety: a lookup table accepted inherited object keys (`constructor`, `__proto__`) |
| Medium | Reachability: a list showed only its first page, older items unreachable |
| Medium | Performance: about 3 serial database calls per row on a 500-row batch path |

The run artifacts show why both review layers missed them:

- **The story review has no checklist for these classes.** Its prompt
  (`buildWorkflowStoryReviewPrompt`) asks for the `quality` verdict on "correctness, error handling, edge
  cases, conventions of the surrounding code". The reviewer of the story holding the concurrency defect
  read the two service files containing it (15 files in total) and approved quality.
- **The branch review is told not to look.** `buildWorkflowBranchReviewPrompt` says "Do not re-review each
  story line by line; the story reviews did that" and scopes the remit to cross-story contracts.
- **The branch review package hides most of the branch.** `writeReviewPackage` inlines the diff truncated
  at `DIFF_CAP_BYTES` (51,200). The cut kept the first 6 of 82 files in diff order, mostly two i18n
  message files. Every file holding a defect was in the omitted list.
- **Nothing checks how much was read.** The branch reviewer made 7 tool calls in 37 seconds, all on the
  storage-width bullet, returned no `inspectedFiles` (the branch reply shape does not ask for them), and
  its `cannotVerify` said "I did not read every handler, service and controller line by line". The
  verdict was accepted as `approved`.

The defect classes come from the post-implementation review's code-quality dimension, which is what
found all 7.

## Design

### Approach

1. **One shared checklist (`WORKFLOW_QUALITY_CHECKLIST`).** A prompt constant naming eight defect classes,
   each with the concrete shapes to look for. Both reviewer prompts embed it verbatim, together with an
   enumeration instruction: walk every function or method the diff adds or changes and judge it against
   the checklist before giving the `quality` verdict. The story review's existing noise guard stays:
   a critical or important finding about what the code does carries a verbatim `observed` excerpt.

   The checklist text (the constant's content, verbatim):

   ```
   ## Code-quality checklist
   Judge the changed code against each class. Report only what you can quote from a file.
   - Concurrency and atomicity: a check and the write it guards in separate statements or transactions; two writers racing on one row, slot or counter; shared mutable state without synchronisation.
   - Data-store semantics: the collation or case-sensitivity of identity and unique columns; uniqueness enforced only in code, not by the store; transaction boundaries; column types and widths against the values written.
   - Production wiring: an in-memory, fake or test stand-in on a production path where the project provides a shared implementation (an id or sequence generator, cache, lock, queue, storage).
   - Test isolation: a test that depends on state another test created; ordering dependence; shared mutable fixtures; globals, environment or files not restored.
   - Input safety: untrusted keys used for object lookup (inherited keys such as __proto__ or constructor); unbounded lengths or sizes reaching storage; unvalidated input reaching a query, path or command.
   - Performance: a database or network call per item inside a loop on a batch path; serial awaits that could be one batched call.
   - Error handling: a swallowed failure; a result or exit code never checked; a default substituted on error so the caller cannot tell empty from broken.
   - Reachability: a list with no way past its first page; a state a user or caller cannot reach or leave.
   ```

   The enumeration instruction (verbatim, in both prompts):
   `Before you give the quality verdict, walk every function or method the diff adds or changes and judge it against the checklist.`

2. **Branch review package without a diff body (`writeBranchReviewPackage`).** A new writer next to
   `writeReviewPackage` in `src/workflow/git.ts`. It writes:

   ```
   ## Commits (<seed>..HEAD)
   <git log --oneline>

   ## Stat
   <git diff --stat>

   ## Changed files (<count>)
   - M packages/nax/src/a.ts
   - A packages/nax/src/b.ts
   - D packages/nax/src/c.ts
   - R packages/nax/src/old.ts -> packages/nax/src/new.ts

   ## How to read the diff
   No diff is inlined. For each changed file run `git diff <seed>..HEAD -- <path>`, or Read a file the branch added. Start with production source, then migrations and schema, then tests.
   ```

   An empty log prints `(none)` and an empty stat prints `(no changes)`, as `writeReviewPackage` does; an
   empty changed-file list prints `## Changed files (0)` and no lines.

   The "How to read the diff" paragraph is built by `buildBranchPackageReadingNote(range)` in
   `src/prompts/builders/workflow-branch-builder.ts` (instructional text lives under `src/prompts/builders/`);
   the writer imports it from `@/prompts`.

   The changed-file list comes from `git diff --name-status -z <seed>..HEAD -- . <ALWAYS_EXCLUDED>`,
   one line per record, status letter only (a score is dropped). `R` (rename) and `C` (copy) records
   carry two paths and print as `<old> -> <new>`; every other status (`M`, `A`, `D`, `T`) carries one. The writer returns the changed
   paths that still exist at HEAD: deletions are excluded, a rename or copy contributes its new path, a type change (`T`) counts like `M`. The story
   review, the story re-review and the branch re-review keep `writeReviewPackage` and its inline diff.

3. **The required set (`reviewRequiredFiles`).** From the writer's returned paths, nax removes:
   - test files, classified per package: the path's owning package is the longest entry of
     `FeatureContext.packageDirs` that prefixes it, and that package's `resolveTestFilePatterns(...).regex`
     classifies it; a path under no package dir uses the root patterns (`packageDir` undefined);
   - documentation and non-source files, matched on the basename, case-insensitively, at any depth: a
     basename ending `.md` or `.mdx`; the lockfiles `bun.lock`,
     `bun.lockb`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `go.sum`,
     `poetry.lock`, `uv.lock`; image and document files ending `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`,
     `.ico`, `.webp`, `.pdf`.

   `runBranchReview` calls `writeBranchReviewPackage` and then `reviewRequiredFiles` inside the
   `writePackage` callback it hands `underReviewLimit`, storing the result in a local the op call reads; a
   throw from either becomes a skipped review (`review package failed: ...`).

   What remains is the set the reviewer must inspect. It is deliberately broad: configuration, JSON,
   YAML, i18n message files and test helpers that do not match the test patterns stay required, since a
   per-file `git diff` of them is cheap and a wrong value in them is a real defect.

4. **Coverage (`unreadFiles`).** A pure helper in `src/operations/workflow-review-coverage.ts` (it lives in
   `src/operations` because the branch op uses it, and `src/operations` never imports `src/workflow`).
   An inspected entry covers a required path when, after stripping a leading `./`, it equals the path or
   ends with `/` followed by the path. `runBranchReview` treats a verdict with no `inspectedFiles` as an
   empty list. `unreadFiles(required, inspected)` returns the required paths no
   entry covers, in required order. Entries that match no required path are ignored.

5. **Same-session coverage retry.** `workflowBranchReviewOp`'s input gains `requiredFiles` and `range`.
   Its `retry` validates a parsed verdict as complete only when `unreadFiles(requiredFiles,
   verdict.inspectedFiles)` is empty. On an incomplete verdict the retry prompt is
   `buildWorkflowBranchCoverageRetry(range, missing)`, which lists each missing path, asks the reviewer
   to inspect them and re-send the whole JSON object, and says
   `List in inspectedFiles every file you have read or diffed in this session, not only the new ones.`; on an unparseable reply it stays
   `buildWorkflowReviewJsonRetry()`. Parse retries run as further turns of the same session
   (`sendWithParseRetry` re-sends through the session's `send`), so the reviewer keeps what it has read.
   To build that prompt, `ParseRetryOpts.prompts.invalid` receives the last output:
   `invalid: (lastOutput: string) => string`. Existing zero-argument prompt functions stay valid.
   Both `validate` and `op.parse` call the shared shape check `parseBranchReviewReply`; `validate`
   additionally calls `isCompleteBranchVerdict(verdict, requiredFiles)` (exported next to `unreadFiles`).
   This is a deliberate, ruled exception (recorded in `.nax/rules/retry-strategy.md`) to the retry-strategy rule that `validate` and `op.parse` share
   acceptance criteria: coverage decides whether to ask again, never whether the verdict is usable, so
   `parse` stays lenient and an incomplete verdict is kept rather than discarded.
   When the one retry is spent, the verdict is kept because `parse` stays lenient: `callOp` takes
   `op.parse(rawOutput)` of the last reply. `exhaustedFallback` returns `parseBranchReviewReply(lastOutput, minorIds)`
   as the strategy-level mirror of that, so a parseable but incomplete verdict is kept, findings included.
   The parse and coverage retries share the one retry turn (`maxAttempts` 2): a reply that is unparseable
   on the first turn and parseable but incomplete on the second gets no further turn, and that second
   verdict is kept with `unreadFiles`. The op passes `looksTruncated` so that only an unparseable reply
   can be treated as truncated: a reply `parseBranchReviewReply` parses always gets the coverage prompt,
   never `buildWorkflowReviewJsonRetryCondensed()`.

6. **Unread files reach the PR.** `runBranchReview` sets `unreadFiles` on the verdict it returns when the
   list is non-empty. The feature machine's branch-review step stores it as `reviewUnread` on the feature
   record and writes one ledger note. `publish` passes it to `readinessReasons` as `branchReviewUnread`,
   which adds a reason, so the PR stays a draft and the advisor's approval is never asked. The verdict's
   findings go to the branch fix as today. The reason and the ledger note share one formatter,
   `describeUnread(files)`:
   `branch review did not read <N> changed file(s): <a>, <b>, ...` listing at most 5 paths, then
   `, +<M> more` when there are more.

7. **Branch prompt remit.** The "Do not re-review each story line by line" sentence is removed whole,
   including its clause after the semicolon ("the story reviews did that, ... is yours to check"). The
   branch reviewer reviews every required file for the checklist as well as for cross-story contracts.
   The existing remit bullets (cross-story integration, reachability, consistency, storage against
   contracts, minor triage) stay, and so do the "What nax already checked" block and `CANNOT_VERIFY_RULE`
   added by #2535. The prompt's reply shape gains `"inspectedFiles": ["path"]` and the
   finding field `"observed"`, and the prompt asks for the most severe findings first. The prompt says
   `List in inspectedFiles every file you read or diffed.` The old package sentence about truncation
   ("When the diff is truncated, the package ends with \"Files not shown in the diff\" ...") is removed,
   since the branch package no longer carries a diff.

### Integration

Read-only symbols (verified at `main` `6ec276e57`, after #2535):

- `parseBranchReviewReply(output: string, minorIds: readonly string[]): BranchReviewVerdict | null` —
  `src/operations/workflow-replies.ts`; already parses `inspectedFiles` through `parseStoryReviewReply`.
- `parseStoryReviewReply(output: string): StoryReviewVerdict | null` — same file.
- `buildWorkflowReviewJsonRetry(): string`, `buildWorkflowReviewJsonRetryCondensed(): string` —
  `src/prompts/builders/workflow-story-review-builder.ts`.
- `underReviewLimit(sc, writePackage: () => Promise<void>, run)` — `src/workflow/story-review.ts`.
- `resolveTestFilePatterns(config, workdir, packageDir?, options?): Promise<ResolvedTestPatterns>`,
  with `ResolvedTestPatterns.regex: readonly RegExp[]` — `src/test-runners/resolver.ts`.
- `ALWAYS_EXCLUDED: string[]` — `src/review/diff-utils.ts`.
- `ledgerText.note(text)` — `src/workflow/ledger.ts`.
- `FeatureContext.packageDirs: readonly string[]` (repo-relative story package dirs) —
  `src/workflow/feature-context.ts`.
- `sendWithParseRetry` in `src/operations/call-dispatch-run.ts` — retries are further turns of the same
  session.

Changed symbols. The baseline exists only to locate the code; it is never the interface to implement.

- `buildWorkflowStoryReviewPrompt` — `src/prompts/builders/workflow-story-review-builder.ts`.
  Baseline: the `quality` bullet names "correctness, error handling, edge cases, conventions of the
  surrounding code". Target: same signature; the prompt also embeds `WORKFLOW_QUALITY_CHECKLIST` and the
  enumeration instruction.
- `BranchReviewPromptInput` / `buildWorkflowBranchReviewPrompt` —
  `src/prompts/builders/workflow-branch-builder.ts`. Baseline: no `range` field; the prompt describes the
  package as a "full diff with context" and says "Do not re-review each story line by line". Target:
  `BranchReviewPromptInput` gains `readonly range: string`; the prompt names the package as commits,
  stat and changed files with no diff, gives `git diff <range> -- <path>`, embeds the checklist and the
  enumeration instruction, drops the do-not-re-review sentence, asks for the most severe findings first,
  and its reply shape includes `inspectedFiles` and `observed`.
- `runBranchReview(fc, input)` — `src/workflow/branch-review.ts`. Baseline: writes the package with
  `writeReviewPackage` and calls the op with `{ prompt, timeoutMs, minorIds }`. Target: writes it with
  `writeBranchReviewPackage`, computes `reviewRequiredFiles`, calls the op with
  `{ prompt, timeoutMs, minorIds, requiredFiles, range }`, and returns the verdict with `unreadFiles` when
  non-empty.
- `WorkflowBranchReviewInput` / `workflowBranchReviewOp` — `src/operations/workflow-branch-review.ts`.
  Baseline: input `{ prompt, model?, timeoutMs, minorIds }`; `validate: parsed !== null`;
  `exhaustedFallback: () => null`. Target: input adds `readonly requiredFiles: readonly string[]` and
  `readonly range: string`; `validate` also requires an empty `unreadFiles`; the invalid prompt depends
  on the last output; `looksTruncated` is true only for a reply `parseBranchReviewReply` cannot parse;
  `exhaustedFallback` returns the parsed verdict or `null`.
- `ParseRetryOpts.prompts.invalid` — `src/agents/retry/parse-retry.ts`. Baseline: `() => string`.
  Target: `(lastOutput: string) => string`, called with `ctx.lastOutput`.
- `BranchReviewVerdict` — `src/operations/workflow-types.ts`. Target: adds
  `readonly unreadFiles?: readonly string[]` (set by `runBranchReview`, never parsed from the reply).
- `WorkflowFeatureRecord` — `src/workflow/types.ts`. Target: adds `readonly reviewUnread?: readonly string[]`.
- `ReadinessFacts` / `readinessReasons` — `src/workflow/approval.ts`. Target: `ReadinessFacts` adds
  `readonly branchReviewUnread?: readonly string[]`; `readinessReasons` appends
  `describeUnread(branchReviewUnread)` as the last reason when the list is non-empty.
- `publish(fc, input)` — `src/workflow/finalize.ts`. Target: the facts it builds carry
  `branchReviewUnread` from `input.record.reviewUnread`.
- `_workflowDeps` — `src/workflow/step-context.ts`. Target: adds
  `resolveTestPatterns: typeof resolveTestFilePatterns` so tests can inject test-file classification.

New symbols:

- `WORKFLOW_QUALITY_CHECKLIST: string` — `src/prompts/builders/workflow-quality-checklist.ts`, exported
  from `@/prompts`.
- `WORKFLOW_ENUMERATION_INSTRUCTION: string` — same file, same export.
- `buildWorkflowBranchCoverageRetry(range: string, missing: readonly string[]): string` —
  `src/prompts/builders/workflow-branch-builder.ts`, exported from `@/prompts` (`src/prompts/index.ts`).
- `writeBranchReviewPackage(projectDir: string, from: string, path: string): Promise<string[]>` —
  `src/workflow/git.ts`.
- `reviewRequiredFiles(paths: readonly string[], fc: Pick<FeatureContext, "config" | "projectDir" | "packageDirs">): Promise<string[]>`
  — `src/workflow/review-coverage.ts`.
- `isCompleteBranchVerdict(verdict: BranchReviewVerdict, requiredFiles: readonly string[]): boolean` —
  `src/operations/workflow-review-coverage.ts`, `true` when `unreadFiles` is empty.
- `buildBranchPackageReadingNote(range: string): string` — `src/prompts/builders/workflow-branch-builder.ts`,
  exported from `@/prompts`.
- `unreadFiles(required: readonly string[], inspected: readonly string[]): string[]` —
  `src/operations/workflow-review-coverage.ts`, exported from `@/operations` (`src/operations/index.ts`);
  `src/workflow` imports it through that barrel.
- `describeUnread(files: readonly string[]): string` — `src/workflow/approval.ts`.

### Failure Handling

| Failure | Behaviour |
|---|---|
| A git call in `writeBranchReviewPackage` exits non-zero | Throws `NaxError` code `WORKFLOW_REVIEW_PACKAGE_FAILED`, as `writeReviewPackage` does; `underReviewLimit` turns it into a skipped review (`review package failed: ...`), and the existing "branch review did not run" reason keeps the PR a draft. |
| `resolveTestFilePatterns` throws for a package | Logged at warn with `storyId: "_run"`; no path in that package is classified as a test file (the required set is larger, never smaller). |
| The reply is unparseable on both attempts | Unchanged: the op returns `null` and the review is skipped as `unparseable reply`. |
| The verdict still misses required files after the retry | The verdict is kept with its findings; `unreadFiles` is set; ledger note and readiness reason as in Approach 6. |
| The first reply is unparseable and the retry reply is parseable but incomplete | No further turn (the one retry is spent); the retry verdict is kept with `unreadFiles`; ledger note and readiness reason as in Approach 6. |
| A parseable but incomplete reply contains text that looks like truncated JSON | It gets the coverage prompt; only an unparseable reply gets the condensed truncation prompt. |
| The required set is empty (a branch of only tests and docs) | Coverage always passes; no retry for coverage. |
| The first verdict is incomplete and the retry reply is unparseable | `exhaustedFallback` sees only the retry reply and returns `null`: the first verdict is not kept, the review is recorded as `unparseable reply`, and "branch review did not run" keeps the PR a draft. |
| The coverage retry turn runs past `workflow.timeouts.reviewMs` | Unchanged step-limit behaviour: `underReviewLimit` reports `{ ran: false, why: "timeout" }`, the first-turn verdict is not kept, and the existing "branch review did not run" reason keeps the PR a draft. |

## Out of Scope

- Verifying `inspectedFiles` against the tool audit. The list is self-reported by the reviewer; nax trusts it.
- A coverage floor or retry for the story review, the story re-review or the branch re-review — only the whole-branch review gets one.
- Changing `DIFF_CAP_BYTES`, `writeReviewPackage`, or the packages of the story review, story re-review and branch re-review — they keep the inline diff.
- Reviewer model selection, pinning or agent fallback.
- Fix rounds spent on an evidence-only finding such as a missing report (nathapp-io/nax#2509).
- Confidence thresholds or severity calibration per checklist class.
- Listing unread files in the PR body beyond the readiness reason.
- Matching `inspectedFiles` entries in other forms: a package-relative path, a path with a line or range suffix (`src/a.ts:12`), a directory, or a different letter case counts as not covering the required path.
- Dedicated tests for the empty-log, empty-stat and empty changed-file renderings of the branch package.
- Per-package overrides of the non-source exclusion list (markdown, lockfiles, images).
- Keeping the first-turn branch verdict when the coverage retry turn hits the review step limit — the review is recorded as not run (timeout), as for any review that times out.

## Stories

### US-001 — Code-quality checklist in both reviewer prompts

Workdir: `packages/nax`

Adds `WORKFLOW_QUALITY_CHECKLIST` and `WORKFLOW_ENUMERATION_INSTRUCTION`, embeds both in the story review
and branch review prompts, and rewrites the branch prompt's package and remit text: the package is
commits, stat and changed files with no diff, read with `git diff <range> -- <path>`; the
do-not-re-review sentence goes; the reply shape gains `inspectedFiles` and `observed`; most severe
findings first. `BranchReviewPromptInput` gains `range`, and `runBranchReview` passes
`<seed>..HEAD`. Also adds `buildBranchPackageReadingNote` and the pure coverage helper `unreadFiles`,
which US-002 and US-003 consume.

Dependencies: none.

### US-002 — Branch review package without a diff body, and the required set

Workdir: `packages/nax`

Adds `writeBranchReviewPackage`, `reviewRequiredFiles` and the `_workflowDeps.resolveTestPatterns`
dep; `runBranchReview` switches to the new package, passes `requiredFiles` and `range` to the op, and
returns `unreadFiles` on the verdict when non-empty.

Dependencies: US-001.

### US-003 — Coverage retry and the draft reason

Workdir: `packages/nax`

Passes the last output to `ParseRetryOpts.prompts.invalid`; adds `buildWorkflowBranchCoverageRetry`
`isCompleteBranchVerdict` and the branch op's coverage validation through it, retry prompt and verdict-keeping fallback; stores
`reviewUnread` on the feature record with a ledger note; adds `describeUnread` and the
`branchReviewUnread` readiness reason, fed by `publish`.

Dependencies: US-002.

Story split rationale: the project's `maxAcCount` is 24, counted as atomic assertions. US-001 is prompt
text plus `unreadFiles` (placed first so both later stories can import it). US-002 is the
package writer and the required-set computation, the data US-003 consumes. US-003 is the retry and the
readiness consequence; merged with US-002 it would exceed 24 assertions.

Sequencing note: this spec builds on `workflow-verification-fidelity` (#2535, `6ec276e57`), which
added `repoGates` with the "What nax already checked" block and `CANNOT_VERIFY_RULE` to the branch
prompt, and `gates` with `CANNOT_VERIFY_RULE` to the story prompt. All of those stay unchanged.

### Context Files

**US-001**
- `packages/nax/src/prompts/builders/workflow-branch-builder.ts`
- `packages/nax/src/prompts/builders/workflow-story-review-builder.ts`
- `packages/nax/src/prompts/index.ts`
- `packages/nax/src/workflow/branch-review.ts`
- `packages/nax/test/unit/prompts/workflow-branch-builder.test.ts`

**US-002**
- `packages/nax/src/workflow/git.ts`
- `packages/nax/src/workflow/branch-review.ts`
- `packages/nax/src/operations/workflow-types.ts`
- `packages/nax/src/test-runners/resolver.ts`
- `packages/nax/src/workflow/step-context.ts`

**US-003**
- `packages/nax/src/agents/retry/parse-retry.ts`
- `packages/nax/src/operations/workflow-branch-review.ts`
- `packages/nax/src/workflow/feature-machine.ts`
- `packages/nax/src/workflow/approval.ts`
- `packages/nax/src/workflow/finalize.ts`
- `packages/nax/test/unit/operations/call-op-retry.test.ts`

### Creates

**US-001**
- `packages/nax/src/prompts/builders/workflow-quality-checklist.ts` — `WORKFLOW_QUALITY_CHECKLIST`, `WORKFLOW_ENUMERATION_INSTRUCTION`, exported from the `src/prompts/index.ts` barrel
- `packages/nax/test/unit/prompts/workflow-quality-checklist.test.ts`
- `packages/nax/src/operations/workflow-review-coverage.ts` — `unreadFiles` (US-003 adds `isCompleteBranchVerdict` to it), exported from the `src/operations/index.ts` barrel
- `packages/nax/test/unit/operations/workflow-review-coverage.test.ts`

**US-002**
- `packages/nax/src/workflow/review-coverage.ts` — `reviewRequiredFiles`
- `packages/nax/test/unit/workflow/review-coverage.test.ts`

**US-003**

None. The op retry ACs extend the existing `packages/nax/test/unit/operations/workflow-branch-review.test.ts`.

### Modifies

**US-001**
- `packages/nax/test/unit/prompts/workflow-branch-builder.test.ts` — one test asserts the branch prompt contains "Do not re-review each story line by line". US-001 removes that sentence; US-001 owns replacing the assertion with one that the prompt contains `WORKFLOW_QUALITY_CHECKLIST`, keeping the test's other remit assertions ("Cross-story integration", "Reachability", the `minorTriage` shape).
- `packages/nax/test/unit/prompts/workflow-branch-builder.test.ts` — the test "checks storage against every declared limit and points at omitted files (nax#2486)" asserts the branch prompt contains "Files not shown in the diff". US-001 removes that truncation sentence because the branch package carries no diff; US-001 owns replacing that one assertion with one that the prompt contains "git diff seed0..HEAD -- <path>", keeping the test's "Storage against contracts", "column type and width" and "migration" assertions.
- `packages/nax/test/unit/prompts/workflow-branch-builder.test.ts` — its prompt-input fixtures `prompt`, `empty` and the spread base `gateBase` build `BranchReviewPromptInput` without `range`, which becomes a required field. US-001 owns adding `range: "seed0..HEAD"` to those three fixtures; no other assertion changes, and the #2535 tests built on `gateBase` keep passing.

**US-002**
- `packages/nax/test/unit/operations/workflow-branch-review.test.ts` — the shared fixture `input` is typed `WorkflowBranchReviewInput` and built as `{ prompt, timeoutMs, minorIds }`; US-002 makes `requiredFiles` and `range` required on that type, so the fixture no longer typechecks. US-002 owns adding `requiredFiles: []` and `range: "seed0..HEAD"` to it; no assertion changes.

The existing `runBranchReview` tests stub `_workflowDeps.git` to return empty stdout, so the changed-file list and the required set are empty, the verdict carries no `unreadFiles`, and `toEqual({ ran: true, verdict })` and the `seed0..HEAD` call check still hold.

**US-003**
- `packages/nax/test/integration/workflow/feature-e2e.test.ts` — the scripted `workflowBranchReviewOp` verdicts (in `setup` and in `scriptB3`) carry no `inspectedFiles`, while the fixture repo changes non-test files after the seed (b.ts, in both `setup` and `scriptB3`, whose repo is built by `setup`). Under US-003 those files are reported unread and the readiness reason turns the expected `outcome: "ready"` into a draft. US-003 owns adding `inspectedFiles` to each scripted branch verdict, listing b.ts (the one file the fixture repo changes after its seed), so the existing outcome, reasons and call-sequence assertions hold unchanged.

Otherwise none. `reviewUnread` and `branchReviewUnread` are optional and absent from every existing fixture, `readinessReasons` adds the reason only for a non-empty list, and existing `makeParseRetryStrategy` callers pass zero-argument prompt functions, which stay valid.

### Seams

- `WORKFLOW_QUALITY_CHECKLIST` and `WORKFLOW_ENUMERATION_INSTRUCTION` (US-001, new) are consumed by `buildWorkflowStoryReviewPrompt` and `buildWorkflowBranchReviewPrompt` in the same story; US-001's ACs call both builders and assert the constants appear in their output.
- `writeBranchReviewPackage` and `reviewRequiredFiles` (US-002, new) are invoked by `runBranchReview`, the entry point the feature env's `branchReview` step calls; US-002's ACs drive `runBranchReview` with stubbed `_workflowDeps.git`, `_workflowDeps.resolveTestPatterns` and `_workflowDeps.callOp` and assert the op input.
- `unreadFiles` (US-001, new) is invoked by `runBranchReview` (US-002) and, through `isCompleteBranchVerdict` (US-003, new), by `workflowBranchReviewOp.retry` (US-003); US-003's `callOp` AC drives the retry through `sendWithParseRetry` end to end.
- `buildBranchPackageReadingNote` (US-001, new) is invoked by `writeBranchReviewPackage` (US-002), whose AC asserts the written package includes it.
- `BranchReviewVerdict.unreadFiles` (US-002) is consumed by the feature machine's branch-review step (US-003); US-003's ACs drive `runFeatureMachine` from the `branch-review` step with a stubbed `env.steps.branchReview` and assert the persisted record.
- `describeUnread` (US-003, new) is invoked by `readinessReasons` and by the branch-review step's ledger note; `branchReviewUnread` reaches `readinessReasons` through `publish`, which US-003's ACs drive.

## Acceptance Criteria

### US-001

- [unit] `WORKFLOW_QUALITY_CHECKLIST`, imported from `@/prompts`, equals the checklist text in Design § Approach item 1 exactly (the heading line, the "Judge the changed code against each class." line and the eight class bullets, lines joined with a newline).
- [unit] `WORKFLOW_ENUMERATION_INSTRUCTION`, imported from `@/prompts`, equals "Before you give the quality verdict, walk every function or method the diff adds or changes and judge it against the checklist."
- [unit] `buildWorkflowStoryReviewPrompt({ briefPath: "b.md", reportPath: "r.md", packagePath: "p.diff", concerns: [] })` returns a string that includes `WORKFLOW_QUALITY_CHECKLIST`.
- [unit] The same story review prompt includes `WORKFLOW_ENUMERATION_INSTRUCTION`.
- [unit] The same story review prompt still includes "verbatim 1-3 line excerpt" (the `observed` rule is kept).
- [unit] `buildWorkflowBranchReviewPrompt` with `range: "seed0..HEAD"` returns a string that includes `WORKFLOW_QUALITY_CHECKLIST`.
- [unit] The same branch prompt includes `WORKFLOW_ENUMERATION_INSTRUCTION`.
- [unit] The same branch prompt includes "git diff seed0..HEAD -- <path>".
- [unit] The same branch prompt does not include "Do not re-review each story line by line".
- [unit] The same branch prompt does not include "full diff with context".
- [unit] The same branch prompt's reply shape includes `"inspectedFiles": ["path"]`.
- [unit] The same branch prompt's reply shape includes `"observed"`.
- [unit] The same branch prompt includes "Put the most severe findings first".
- [unit] The same branch prompt includes "List in inspectedFiles every file you read or diffed."
- [unit] The same branch prompt does not include "Files not shown in the diff".
- [unit] The same branch prompt still includes "Cross-story integration".
- [unit] The same branch prompt still includes "Storage against contracts".
- [unit] `runBranchReview` with `seed: "seed0"`, `_workflowDeps.git` stubbed to succeed and `_workflowDeps.callOp` scripted to capture its input, passes a `prompt` that includes "git diff seed0..HEAD -- <path>".

- [unit] `unreadFiles(["src/a.ts", "src/b.ts"], ["src/a.ts"])`, imported from `@/operations`, returns `["src/b.ts"]`.
- [unit] `unreadFiles(["src/a.ts"], ["./src/a.ts"])` returns `[]`.
- [unit] `unreadFiles(["src/a.ts"], ["/repo/src/a.ts"])` returns `[]`.
- [unit] `unreadFiles(["a.ts"], ["src/xa.ts"])` returns `["a.ts"]` (a match needs a `/` boundary).
- [unit] `buildBranchPackageReadingNote("seed0..HEAD")`, imported from `@/prompts`, returns a string that includes "git diff seed0..HEAD -- <path>".

### US-002

- [unit] `writeBranchReviewPackage(dir, "seed0", path)` with `_workflowDeps.git` stubbed so `diff --name-status -z` returns `M\0src/a.ts\0A\0src/b.ts\0` writes a file whose "## Changed files (2)" section lists "- M src/a.ts" and "- A src/b.ts".
- [unit] With `diff --name-status -z` returning `R087\0src/old.ts\0src/new.ts\0`, the written file lists "- R src/old.ts -> src/new.ts".
- [unit] The written file includes "## Commits (seed0..HEAD)" followed by the stubbed `log --oneline` output.
- [unit] `writeBranchReviewPackage` never invokes `_workflowDeps.git` with an argument starting `--unified=`.
- [unit] Every `_workflowDeps.git` diff call `writeBranchReviewPackage` makes includes each `ALWAYS_EXCLUDED` pathspec.
- [unit] With `diff --name-status -z` returning `C075\0src/base.ts\0src/copy.ts\0M\0src/a.ts\0`, the written file lists "- C src/base.ts -> src/copy.ts".
- [unit] With the same `C075` stub, `writeBranchReviewPackage` resolves to `["src/copy.ts", "src/a.ts"]`.
- [unit] With `diff --name-status -z` returning `M\0src/a.ts\0D\0src/c.ts\0R100\0src/old.ts\0src/new.ts\0`, `writeBranchReviewPackage` resolves to `["src/a.ts", "src/new.ts"]`.
- [unit] When any of its git calls exits non-zero, `writeBranchReviewPackage` rejects with a `NaxError` whose code is `WORKFLOW_REVIEW_PACKAGE_FAILED`.
- [unit] `reviewRequiredFiles(["apps/api/src/x.ts", "apps/api/src/x.spec.ts"], fc)` with `fc.packageDirs` `["apps/api"]` and `_workflowDeps.resolveTestPatterns` returning `regex: [/\.spec\.ts$/]` for package dir `"apps/api"` resolves to `["apps/api/src/x.ts"]`.
- [unit] For a path under no entry of `fc.packageDirs`, `reviewRequiredFiles` classifies it with the patterns `_workflowDeps.resolveTestPatterns` returns for `packageDir` undefined.
- [unit] When `fc.packageDirs` holds both `"apps"` and `"apps/api"`, a path under `apps/api/` is classified with the patterns resolved for `"apps/api"`.
- [unit] `reviewRequiredFiles(["README.md", "docs/guide.mdx", "bun.lock", "package-lock.json", "go.sum", "img/logo.png", "doc/spec.pdf", "src/a.ts"], fc)` with no test patterns resolves to `["src/a.ts"]`.
- [unit] `reviewRequiredFiles(["apps/api/bun.lock", "docs/README.MD", "img/Logo.PNG", "src/a.ts"], fc)` with no test patterns resolves to `["src/a.ts"]` (basename match, case-insensitive, at any depth).
- [unit] The file `writeBranchReviewPackage(dir, "seed0", path)` writes includes `buildBranchPackageReadingNote("seed0..HEAD")`.
- [unit] When `_workflowDeps.resolveTestPatterns` throws for package dir `"apps/api"`, `reviewRequiredFiles(["apps/api/src/x.spec.ts"], fc)` resolves to `["apps/api/src/x.spec.ts"]` and logs one warn entry with `storyId: "_run"`.
- [unit] `runBranchReview` with `seed: "seed0"`, `_workflowDeps.git` stubbed so `diff --name-status -z` returns `M\0src/a.ts\0M\0src/a.test.ts\0`, `_workflowDeps.resolveTestPatterns` returning `regex: [/\.test\.ts$/]`, and a scripted `_workflowDeps.callOp`, calls the op with an input whose `requiredFiles` equals `["src/a.ts"]`.
- [unit] With the same stubs, the op input's `range` equals `"seed0..HEAD"`.
- [unit] With the same stubs and the op returning a verdict whose `inspectedFiles` is `[]`, `runBranchReview` resolves to `{ ran: true, verdict }` where `verdict.unreadFiles` equals `["src/a.ts"]`.
- [unit] With the same stubs and the op returning a verdict whose `inspectedFiles` is `["src/a.ts"]`, the resolved verdict has no `unreadFiles` property.
- [unit] With the same stubs and the op returning a verdict object that has no `inspectedFiles` property, `runBranchReview` resolves (does not reject) with `verdict.unreadFiles` equal to `["src/a.ts"]`.
- [unit] `runBranchReview` with `_workflowDeps.git` stubbed so every call exits non-zero resolves to `{ ran: false, why }` where `why` starts with "review package failed", and never calls `_workflowDeps.callOp`.
- [unit] `runBranchReReview` still writes its package through an `_workflowDeps.git` call with the argument `--unified=10`.

### US-003

- [unit] `makeParseRetryStrategy` with `prompts.invalid` set to a function that records its argument, on a `shouldRetry` call at attempt 0 whose `ctx.lastOutput` is `"not json"`, returns `retry: true` with `nextPrompt` equal to that function's return value, and the function received `"not json"`.
- [unit] `buildWorkflowBranchCoverageRetry("seed0..HEAD", ["src/a.ts", "src/b.ts"])`, imported from `@/prompts`, returns a string that includes the lines "- src/a.ts" and "- src/b.ts".
- [unit] The same coverage retry prompt includes "git diff seed0..HEAD -- <path>".
- [unit] The same coverage retry prompt includes "Re-send the whole JSON object".
- [unit] The same coverage retry prompt includes "List in inspectedFiles every file you have read or diffed in this session, not only the new ones."
- [unit] `isCompleteBranchVerdict`, imported from `@/operations`, returns `true` for a verdict whose `inspectedFiles` is `["src/a.ts"]` with `requiredFiles` `["src/a.ts"]`.
- [unit] `isCompleteBranchVerdict` returns `false` for a verdict whose `inspectedFiles` is `[]` with `requiredFiles` `["src/a.ts"]`.
- [unit] `workflowBranchReviewOp.retry` for input `{ requiredFiles: ["src/a.ts"], range: "seed0..HEAD", minorIds: [] }`, on `shouldRetry` at attempt 0 with `ctx.lastOutput` a valid branch verdict JSON whose `inspectedFiles` is `[]`, returns `retry: true` and a `nextPrompt` that includes "- src/a.ts".
- [unit] For the same input, when `ctx.lastOutput` is a valid verdict whose `inspectedFiles` is `["src/a.ts"]`, `shouldRetry` returns `retry: false` with no `fallback`.
- [unit] For the same input, when `ctx.lastOutput` is `"not json"` at attempt 0, `nextPrompt` equals `buildWorkflowReviewJsonRetry()`.
- [unit] For the same input at attempt 1, when `ctx.lastOutput` is a valid verdict with `inspectedFiles` `[]` and one important finding, `shouldRetry` returns `retry: false` and a `fallback` equal to `parseBranchReviewReply(ctx.lastOutput, [])`, finding included.
- [unit] For the same input at attempt 1, when `ctx.lastOutput` is `"not json"`, `shouldRetry` returns `retry: false` with `fallback` `null`.
- [unit] For the same input at attempt 0, when `ctx.lastOutput` is a valid verdict with `inspectedFiles` `[]` followed by the text `{"spec": "pass"`, `nextPrompt` includes "- src/a.ts" (the coverage prompt, not the truncation prompt).
- [unit] `callOp(ctx, workflowBranchReviewOp, { prompt, timeoutMs, minorIds: [], requiredFiles: ["src/a.ts"], range: "seed0..HEAD" })`, with a test runtime whose agent session (scripted as in `test/unit/operations/call-op-retry.test.ts`) replies first with a valid verdict whose `inspectedFiles` is `[]` and then with a valid verdict whose `inspectedFiles` is `["src/a.ts"]`, sends two turns in one session, sends a second prompt that includes "- src/a.ts", and returns the second verdict.
- [unit] For input `{ requiredFiles: [], range: "seed0..HEAD", minorIds: [] }` at attempt 0, a valid verdict with `inspectedFiles` `[]` gives `retry: false`.
- [unit] `describeUnread(["a.ts", "b.ts"])` returns "branch review did not read 2 changed file(s): a.ts, b.ts".
- [unit] `describeUnread` of seven paths `p1.ts` to `p7.ts` returns "branch review did not read 7 changed file(s): p1.ts, p2.ts, p3.ts, p4.ts, p5.ts, +2 more".
- [unit] `readinessReasons` with otherwise-ready facts and `branchReviewUnread: ["a.ts"]` returns `["branch review did not read 1 changed file(s): a.ts"]`.
- [unit] `readinessReasons` with otherwise-ready facts and `branchReviewUnread: []` returns `[]`.
- [unit] `runFeatureMachine` started at the `branch-review` step, with `env.steps.branchReview` stubbed to return `{ ran: true, verdict }` where `verdict.unreadFiles` is `["src/b.ts"]`, persists a feature record whose `reviewUnread` equals `["src/b.ts"]`.
- [unit] The same run writes a ledger note whose text includes "branch review did not read 1 changed file(s): src/b.ts".
- [unit] When the stubbed verdict has no `unreadFiles`, the persisted record has no `reviewUnread` property.
- [unit] `publish` with a record whose `reviewUnread` is `["src/b.ts"]`, green final gates, no flagged rulings, a forge and CI passing, returns `outcome: "draft"` with `reasons` including "branch review did not read 1 changed file(s): src/b.ts", and never calls the advisor's approval.
