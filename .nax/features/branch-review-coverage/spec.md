# SPEC: branch-review-coverage — the branch review reads every changed file, and settled coverage rulings count

Closes: #2858, #2859

## Summary

Large nax features (11-20 stories, 50+ changed source files) end with a draft PR because the one
whole-branch review session reads a handful of files and stops. This feature makes the review read
the whole branch, and makes `nax bot review` trust a settled coverage ruling through a structured
record instead of free text.

Workflow branch review (`nax run`, #2858):

1. **Slices.** When the required files exceed `workflow.review.sliceFiles` (default 15), the
   review runs as several fresh sessions, one after another, each owning one slice of the files.
   The verdicts merge into one `branch-review.json`, which records each slice's files.
2. **A prompt that states the obligation.** The prompt lists the files the session must review,
   says nax checks the list, and says passing repo gates is not a review of a file.
3. **A coverage retry budget of its own.** Coverage re-prompts no longer share the JSON-shape
   budget. Up to `workflow.review.coverageRetries` (default 3) are sent, and they stop as soon as a
   reply covers no more files than the one before. They log as coverage retries.
4. **Tool-observed reads.** A file the reviewer read or diffed through nax's own tools counts as
   read, even when the reviewer left it out of `inspectedFiles`.

`nax bot review` (#2859):

5. **Coverage rulings carry their files and commit.** The unread-files item a workflow PR is
   published with lists its files, and a `verified` ruling on it records the PR head it was made at.
6. **Credit.** The bot review counts a file as covered when a verified ruling lists it and the file
   has not changed since the ruling's commit. Covered files are neither re-prompted nor reported
   unread, and the prompt names them.
7. **Readiness gates on uncovered files only.** The bot review records the files it left
   uncovered at the head it reviewed, and `nax bot fix` will not mark the PR ready while that
   record names any.

The bot review gets the same coverage retry budget as the branch review (#2859 minor 1).

## Motivation

#2858, observed on a v0.91.8 canary run (11 stories, 58 required files, native
`anthropic/claude-sonnet-5-5[medium]`). The branch review took 22 s over 2 turns. Turn 1 read the
spec, listed the changed files, read 3 of them, and approved. The coverage re-prompt named the 55
unread files. Turn 2 diffed 11 more in one command and re-sent the verdict, with this in
`cannotVerify`: "I did not read the other changed files you listed ... nax's repo gates passed for
them." Then `maxAttempts: 2` was spent, 45 files stayed unread, and the PR stayed a draft.

Why the reviewer stopped (the prompt and tool audit from that run, `prompt-audit` and `tool-audit`
for session `wf-branch-review`):

- **The prompt never states the obligation.** "For each changed file run `git diff`" appears only
  under "How to read the diff", which reads as method, not as a requirement. The prompt never lists
  the required files, never gives their count, and never says nax checks the list or that an unread
  file keeps the PR a draft.
- **The prompt invites sampling.** It opens with "Every story was implemented and reviewed on its
  own already", its remit is cross-story integration, and "What nax already checked" says the repo
  gates passed. The reviewer cited exactly that for the files it skipped.
- **Volume per session.** 58 files is more than one session takes on. The retry turn did one
  33 KB diff over 11 files and stopped.
- **One retry.** The coverage retry shares `maxAttempts: 2` with the JSON-shape retry, so a
  reviewer that answers "I did not read them" faces no second ask. The log line said
  `JSON parse retry — invalid shape`, although the reply had parsed.
- **Not the cause:** the reviewer's `git diff` ran through nax's rtk Bash rewrite, but the
  compacted diff of the same files is 12,154 bytes against 12,298 raw, so nothing was hidden.

#2859: after that run, the agent finishing the PR read all 45 files at commit `ec1c569` and settled
the items `verified`. `nax bot review` at `ec1c569` read 1 file, approved because "the settled
rulings say the files were already read", spent its coverage re-prompt on ~60 files, diffed 4, and
posted ~60 false "Not read by the review" lines. The approval was right, but nax got there only
because the model chose to trust free text: no record says which files a ruling covered, or at
which commit. User ruling (2026-11-10): 11-20 story runs are the norm, and finish problems go to an
agent, never to a new human step.

## Design

### Approach

**Coverage retry strategy.** New `makeCoverageRetryStrategy` in
`packages/nax/src/agents/retry/coverage-retry.ts`, exported from `@/agents/retry`. It wraps an
inner `RetryStrategy` (the op's shape or triage retry) and owns the coverage decision:

```ts
export interface CoverageRetryOpts {
  /** The op's shape (and, for the bot, triage) retry. Its `validate` no longer checks coverage. */
  readonly inner: RetryStrategy;
  readonly parse: (output: string) => unknown;
  /** Required files the parsed verdict does not cover. */
  readonly missing: (parsed: unknown) => readonly string[];
  readonly maxCoverageRetries: number;
  readonly prompt: (missing: readonly string[], progress: { attempt: number; max: number }) => string;
  readonly exhaustedFallback: (lastOutput: string) => unknown;
  readonly reviewerKind: string;
  readonly _logger?: { warn(kind: string, msg: string, data: Record<string, unknown>): void };
}
export function makeCoverageRetryStrategy(opts: CoverageRetryOpts): RetryStrategy;
```

`shouldRetry(failure, attempt, ctx)` decides in this order:

1. Let `issued` be the coverage retries this strategy has returned so far (closure state). The
   strategy is resolved once per `callOp` call, so the coverage budget is per `callOp`, not per
   hop. The inner strategy is always called with `Math.max(0, attempt - issued)`, so coverage
   retries never spend the inner budget, and a hop re-run that resets `attempt` cannot push it
   below zero.
2. If `failure` is not a `ParseValidationError`, `ctx.lastOutput` is empty, or
   `ctx.lastTurnResult?.adapterFailure` is set, return the inner decision.
3. Parse `ctx.lastOutput` with `opts.parse`. A `null` result returns the inner decision.
4. Ask the inner strategy. If it retries, return that decision: shape and triage come first.
5. If the inner decision is `{ retry: false }` and carries a `fallback` key (its own budget is
   spent on an incomplete triage), return it: coverage never retries past an exhausted inner.
6. Compute `missing`. Empty: return the inner decision.
7. Non-empty, and `issued >= maxCoverageRetries`: stop with
   `{ retry: false, fallback: exhaustedFallback(lastOutput) }` and log
   `"Coverage retry stopped"` with `{ storyId, unread: missing.length, attempt: issued, reason: "budget" }`.
8. Non-empty, `issued > 0`, and `missing.length` is not lower than the count when the previous
   coverage retry was sent: stop the same way with `reason: "no progress"`.
9. Otherwise increment `issued`, remember `missing.length`, log `"Coverage retry"` with
   `{ storyId, unread: missing.length, attempt: issued, max }`, and return
   `{ retry: true, delayMs: 0, nextPrompt: prompt(missing, { attempt: issued, max }) }`.

`storyId` is `ctx.storyId` and is the first key of every log data object. `callOp`'s
`MAX_COMPLETE_RETRY_ATTEMPTS` still bounds the whole loop. `callOp`'s own generic
`Op retrying ... parse probe failed` debug line is unchanged.

**Branch op.** `workflowBranchReviewOp.retry` becomes `makeCoverageRetryStrategy` over a
`makeParseRetryStrategy` with `maxAttempts: 2`, whose `validate` is only `parsed !== null` and
whose `invalid` prompt is `buildWorkflowReviewJsonRetry()`. `missing` is `unreadFiles(input.requiredFiles,
verdict.inspectedFiles, input.repoRoot)`. `maxCoverageRetries` is `input.coverageRetries`, or
`WORKFLOW_REVIEW_DEFAULTS.coverageRetries` when absent. `prompt` is
`buildWorkflowBranchCoverageRetry(input.range, missing, false, progress)`.

**Bot ops.** `reviewRetry` in `bot-pr-review.ts` keeps its `makeParseRetryStrategy` with
`maxAttempts: 2` and `validate` = triage complete only (the `missingFiles` term moves out), and its `invalid` prompt
keeps the triage retry and drops the coverage branch. The wrapper adds coverage, with
`missing` = `missingFiles(verdict)`, `maxCoverageRetries` = `input.coverageRetries` (default as
above), and `prompt` = `buildWorkflowBranchCoverageRetry(coverage.range, missing, staticMode,
progress)`. With no `requiredFiles`, `missing` is always empty. The existing `coverageContext`
throw (`BOT_REVIEW_COVERAGE_INVALID` when `requiredFiles` is set without `repoRoot` or `range`)
is kept.

**Config.** `WorkflowConfigObjectSchema` gains:

```ts
review: z.object({
  sliceFiles: z.number().int().min(1).default(15),
  coverageRetries: z.number().int().min(0).default(3),
}).prefault({}),
```

`runtime-types-workflow.ts` `WorkflowConfig` gains `review?: { readonly sliceFiles: number;
readonly coverageRetries: number }` (optional, so hand-built test configs keep compiling).
`schemas-workflow.ts` exports `WORKFLOW_REVIEW_DEFAULTS`, the parsed defaults of the `review`
object, and consumers read `workflow.review ?? WORKFLOW_REVIEW_DEFAULTS`, imported from `@/config` (the
barrel `src/config/index.ts` lists it beside `WORKFLOW_DEFAULTS`). `FIELD_DESCRIPTIONS` in
`src/cli/config-descriptions.ts` gains non-empty rows for `workflow.review`,
`workflow.review.sliceFiles` and `workflow.review.coverageRetries`.

**Slice planning.** New `packages/nax/src/workflow/branch-review-slices.ts`:

```ts
export function planReviewSlices(required: readonly string[], sliceFiles: number): string[][];
```

Files are grouped by parent directory (the path up to its last `/`, or `""` at the root). Groups
are ordered by first appearance in `required`, and files keep their `required` order within a
group. Packing is greedy: a group joins the current slice when the total stays at or under
`sliceFiles`; otherwise the current slice closes and the group starts the next one. A group larger
than `sliceFiles` closes the current slice and is cut into consecutive slices of `sliceFiles`
files; its last, shorter slice stays open, so the next group joins it when the total stays at or
under `sliceFiles`. When `required.length <= sliceFiles` the result is `[required]`; an empty `required` gives
`[[]]`. `required` arrives in git's path order, so neighbouring directories, and therefore one
package's files, tend to share a slice.

**Verdict merge.** Same file:

```ts
export interface SliceResult {
  readonly files: readonly string[];
  readonly verdict: BranchReviewVerdict | null;
  readonly why?: string;
}
export function mergeSliceVerdicts(parts: readonly SliceResult[]): BranchReviewVerdict | null;
```

It returns `null` when every `verdict` is `null`. A verdict's `inspectedFiles` is read as
`inspectedFiles ?? []` everywhere, since a verdict can lack it. When exactly one part was given
and it ran, the result is that part's verdict object unchanged (no `slices`), so runtime-only
members such as an attached `adapterFailure` survive. Otherwise, over the slices that ran:

- `spec` is `"fail"` if any slice says `"fail"`;
- `quality` is `"changes"` if any slice says `"changes"`;
- `findings` are concatenated in slice order;
- `cannotVerify` is concatenated in slice order, exact duplicates dropped;
- `inspectedFiles` is the union, in first-appearance order;
- `minorTriage` takes the first ran slice's id order, and each id is `"fix-now"` if any ran slice
  says `"fix-now"`, else `"leave"`;
- `slices` is one `BranchReviewSlice` per part, in order:
  `{ files, inspectedFiles: verdict?.inspectedFiles ?? [], ran: verdict !== null, why? }`.

`BranchReviewVerdict` in `src/operations/workflow-types.ts` gains
`readonly slices?: readonly BranchReviewSlice[]`, and the file exports `BranchReviewSlice`.

**Tool-observed reads.** New `packages/nax/src/workflow/review-tool-reads.ts`:

```ts
export function toolReadPaths(calls: readonly ToolCallRecord[], repoRoot: string): string[];
export async function readSessionToolCalls(input: {
  readonly auditDir: string;
  readonly runId: string;
  readonly ledgerSessionName: string;
  readonly sinceMs: number;
}): Promise<ToolCallRecord[]>;
export const _reviewToolReadsDeps: { glob; readText; logger };
```

`toolReadPaths` keeps calls with `outcome === "ok"` whose `resultBytes` is at or below
`TOOL_READ_CREDIT_MAX_BYTES` (exported, `40_000`, the size nax-agent's `MODEL_MAX_BYTES` lets the
model see), and returns repo-relative paths, deduplicated, in first-appearance order. A larger
result reached the model cut short, so its call credits nothing.

- `Read`: `input.path`, only when the call has neither `offset` nor `limit` (a ranged read did
  not show the whole file).
- `Git`: `input.subcommand === "diff"` with `input.nameOnly !== true`: each `input.paths` entry.
- `Bash`: `input.command` is split into segments on `;`, `&&` and newlines, and each segment is
  cut at its first `|`. A segment `cd <dir>` (no `$`) sets the directory for the later segments. A
  segment whose words begin `git diff` or `rtk git diff`, that contains a standalone `--`, and that
  has none of `--name-only`, `--name-status` or `--stat`, contributes each word after `--` that
  does not start with `-` and contains none of `$ * ? [`, joined to the current directory.
- A word wrapped in single or double quotes is unquoted first, and a word whose quotes do not
  close is dropped.
- Each path is normalised the way `unreadFiles` normalises an entry: an absolute path inside
  `repoRoot` becomes relative, a leading `./` is dropped, and a path outside `repoRoot` is dropped.
  The private `normalize` in `src/operations/workflow-review-coverage.ts` is exported as
  `normalizeReviewPath(entry, repoRoot): string | undefined` and reused, not duplicated.

`readSessionToolCalls` scans `auditDir` (explicit `cwd`) for `<runId>-<digits>-<ledgerSessionName>.json`
with `<digits>` at or above `sinceMs`, parses each, and concatenates their `calls` arrays in file
name order. A missing directory gives `[]`. A file that does not parse, or has no `calls` array, is
skipped with a warn.

The branch review reads its calls from `toolAuditDir({ root: fc.projectDir, outputDir:
fc.outputDir }, fc.feature)` with `ledgerSessionName = buildLedgerSessionName({ featureName:
fc.feature, sessionRole: "wf-branch-review" })`. That is the same dir and name the dispatch writes
(`resolveDispatchAuditDir`, `coding-tool-support-resolve.ts`). The audit file is flushed when the
hop ends, so tool reads reduce the final unread list only; they do not feed the coverage retry
inside a session.

**`runBranchReview`, sliced.** In `src/workflow/branch-review.ts`:

1. Write the package and compute `requiredFiles` once, before any slice, with the same failure
   semantics `underReviewLimit` gives a package failure: a throw while `fc.runSignal` is aborted
   rethrows, any other throw returns `{ ran: false, why: "review package failed: <message>" }`.
   The rules and project-context appends stay in this step.
2. `slices = planReviewSlices(requiredFiles, review.sliceFiles)`.
3. For each slice in order, build the prompt with `requiredFiles: slice` and, when there is more
   than one slice, `slice: { index, count, otherFiles }`, where `otherFiles` is the number of
   required files outside this slice. Run it through `underReviewLimit(fc, noop, run)` so each
   slice has its own review timeout, and call `workflowBranchReviewOp` with
   `requiredFiles: slice` and `coverageRetries: review.coverageRetries`. A slice that does not run
   records its `why` and the next slice still runs. An abort rethrows and stops the loop.
4. After the last slice, read the session's tool calls since the first slice started
   (`_workflowDeps.now()` taken before slice 1), when `fc.runId` and `fc.outputDir` are present.
5. `merged = mergeSliceVerdicts(results)`. `null` returns `{ ran: false, why: <first slice's why> }`.
6. `unread = unreadFiles(requiredFiles, [...merged.inspectedFiles, ...toolReads], fc.projectDir)`.
7. Return `merged`, plus `unreadFiles` when non-empty. `slices` is kept only when there was more
   than one slice, so a one-slice verdict is unchanged in shape.

`BranchStepContext` declares optional `runId` and `outputDir`. `FeatureContext` already has both
as required fields and is passed to `runBranchReview` structurally, so nothing is set by hand;
`buildPrStepContext` leaves them absent. Each slice is its own fresh `wf-branch-review` session,
opened and closed before the next one starts.

**Prompt.** `BranchReviewPromptInput` gains `requiredFiles?: readonly string[]` and
`slice?: { index: number; count: number; otherFiles: number }`. With a non-empty `requiredFiles`,
`buildWorkflowBranchReviewPrompt` adds a section after "## How to read the diff":

```
## Files you must review (N)
- path/one.ts
- path/two.ts
nax compares your inspectedFiles with this list. A file on it that you do not read or diff is
reported unread, and an unread file keeps the PR a draft. Repo gates passing is not a review of a
file, and neither is a story review: read each one.
```

With `slice` set it adds a line to that section: `This is review slice <index> of <count>. Other
slices review the other <otherFiles> changed file(s); read any of them only to check a contract
with your files.` `buildBranchPackageReadingNote` (shared with the bot review package) replaces its
`No diff is inlined.` sentence with `This package holds no diff, only the commit list, the --stat
summary and the changed-file names.`, which closes #2859 minor 2.

`buildWorkflowBranchCoverageRetry(range, missing, staticMode = false, progress?)` gains the
optional `progress: { attempt: number; max: number }`. With it, the retry adds `This is coverage
retry <attempt> of <max>. Read all of them before you reply; a file you leave out stays unread and
keeps the PR a draft.`

**Coverage items carry their files.** `OpenItem` in `src/workflow/types.ts` gains
`readonly files?: readonly string[]`. In `open-items.ts`, the reason item whose text equals
`describeUnread(rec.reviewUnread)` gets `files: rec.reviewUnread`. `renderItemOpener` renders, when
`files` is non-empty, a `Files:` line and one `` - `<path>` `` line per file (through
`safeCode`, as `render-comments.ts` renders unread paths; `safeInline` would rewrite `@` and `#1`
and cap the length), after the suggestion and advisor lines and before the reply instruction. New
`parseItemFiles(body: string): string[]` in `item-threads.ts` reads them back from a raw or
forge-marked opener body. `itemKey` is unchanged (it hashes kind and issue only).

**Verified rulings record their head.** `renderRulingEcho` renders a `verified` ruling with a
valid `sha` as `Recorded: verified in <sha7> — <reason>`. `parseRulingEcho` accepts the
` in <sha>` part for `verified` (optional) as well as `fixed` (required), and rejects it for every
other disposition. In `src/bot/rulings.ts` `ruleItem`, a `verified` ruling without a `sha`, on an
item whose opener has a non-empty `parseItemFiles` list, is echoed and recorded with
`sha: input.info.headSha`. That covers thread replies, model-read rulings and caller rulings alike. A caller ruling is
exact, because `callerGate` already requires its `headSha` to equal the PR head. A thread reply
carries no head, so it is stamped with the head the bot sees when it records the reply; a push
between the reply and that recording is credited too (Out of Scope).

**Credit.** `BotSettledRuling` gains `readonly files?: readonly string[]`, present only when non-empty.
`readReviewRulings` sets it from `parseItemFiles(item.thread.comments[0]?.body ?? "")` when non-empty. New pure
`creditedFiles` in `packages/nax/src/bot/coverage-credit.ts`:

```ts
export async function creditedFiles(input: {
  readonly settled: readonly BotSettledRuling[];
  readonly required: readonly string[];
  readonly changedSince: (sha: string) => Promise<readonly string[] | null>;
}): Promise<string[]>;
```

A ruling credits files only when its `disposition` is `"verified"`, `files` is non-empty and `sha`
is set; `changedSince` is called only for such rulings, once per distinct sha. It credits each listed file that is in `required` and absent from `changedSince(sha)`. A
`null` from `changedSince` credits nothing for that ruling. The result is the union, in `required`
order.

In `runPrReview`, `changedSince` runs `git diff --name-only <sha>..HEAD` through
`_workflowDeps.git` in `ctx.projectDir`. A non-zero exit returns `null` and logs a warn with
`{ storyId: "_run", sha }`. Inside the package callback, after `requiredFiles` is computed,
`credited` is computed from `input.settled ?? []`. The op receives `requiredFiles` minus
`credited`. The prompt is built inside the `run` callback, after the package step, so it can carry
`coveredByRulings: credited`. The outcome's `unreadFiles` is computed against `requiredFiles`
minus `credited`, and stays absent when empty, as today. `PrReviewOutcome` gains no field.

`BotPrReviewPromptInput` gains `coveredByRulings?: readonly string[]`. When non-empty, the prompt
adds:

```
## Files covered by settled rulings
A collaborator verified these files at a commit they have not changed since. You do not need to
read them. Read every other changed file in the package.
- path/one.ts
```

**Coverage record and readiness.** New `packages/nax/src/bot/coverage-record.ts`:

```ts
export const COVERAGE_RECORD_KEY = "w-coverage";
export interface CoverageRecord { readonly headSha: string; readonly uncovered: readonly string[] }
export function renderCoverageRecord(record: CoverageRecord): string;
export function parseCoverageRecord(body: string): CoverageRecord | null;
```

The rendered body is `Review coverage at <sha40>: <n> required file(s) not read`, then one
`` - `<path>` `` line per uncovered file. `parseCoverageRecord` accepts a raw or forge-marked body
and returns `null` for anything else.

After a bot review that ran (not conversation-only, not static mode) on a PR with the nax
workflow marker, the post step posts the record wrapped in `withNaxBotMarker(body,
COVERAGE_RECORD_KEY)`, editing the bot's existing `w-coverage` comment when there is one, with
`uncovered` = the outcome's `unreadFiles ?? []` and `headSha` = the reviewed head.

`TOP_LEVEL_MARKER_KEYS` in `src/forge/marker-grammar.ts` gains `"w-coverage"`, so a GitLab
top-level note with replies is still read as the bot's own record (`src/forge/threads.ts`).

`workflowPrReadiness` gains an optional `coverage?: CoverageRecord` and `headSha?: string`. After
the confirmed-work check and before the CI check, it returns
`{ ready: false, reason: "bot review did not read <n> required file(s) at <sha7>: <first 5>[, +<k> more]; run nax bot review" }`
when `coverage.headSha === headSha` and `uncovered` is non-empty. A record for another head does
not hold. `workflowReadyHold` in `fix-report.ts` reads the bot's own `w-coverage` comment from the
`comments` that `readReadyRulings` returns, parses it, and passes it with `info.headSha` to both
`workflowPrReadiness` calls.

### Integration (extends existing code)

Read-only (verified, used as is):

- `unreadFiles(required, inspected, repoRoot): string[]` — `src/operations/workflow-review-coverage.ts`
- `reviewRequiredFiles(paths, fc, options?)` — `src/workflow/review-coverage.ts`
- `underReviewLimit(sc, writePackage, run)` — `src/workflow/story-review.ts`
- `makeParseRetryStrategy(opts)`, `RetryStrategy`, `ParseValidationError` — `src/agents/retry`
- `writeBranchReviewPackage(projectDir, from, path, options?)` — `src/workflow/git.ts`
- `describeUnread(files)` — `src/workflow/approval.ts`
- `toolAuditDir(anchor, featureId?)` — `src/config/paths/index.ts`
- `ToolCallRecord` — `@nathapp/nax-agent`
- `buildLedgerSessionName(opts)` — `@nathapp/nax-agent/internal`
- `withNaxBotMarker`, `ownComments`, `hasNaxWorkflowMarker` — `@/forge`

Changed. The baseline locates the code; it is never the interface to implement.

- `workflowBranchReviewOp.retry` — Baseline: one `makeParseRetryStrategy` whose `validate` also
  requires coverage, `maxAttempts: 2`. Target: `makeCoverageRetryStrategy` over a shape-only
  parse retry, as in Approach.
- `WorkflowBranchReviewInput` — Target: adds `readonly coverageRetries?: number`.
- `reviewRetry` (bot) / `BotPrReviewInput` — Baseline: `validate` = triage and coverage. Target:
  triage-only inner, coverage wrapper; input adds `readonly coverageRetries?: number`.
- `buildWorkflowBranchCoverageRetry` — Target:
  `(range: string, missing: readonly string[], staticMode = false, progress?: { attempt: number; max: number }) => string`.
- `BranchReviewPromptInput` — Target: adds `requiredFiles?` and `slice?` as in Approach.
- `runBranchReview(fc, input)` — Target: sliced, as in Approach; same signature and return type.
- `BranchReviewVerdict` — Target: adds `slices?: readonly BranchReviewSlice[]`.
- `BranchStepContext` — Target: adds `readonly runId?: string; readonly outputDir?: string`.
- `normalize` in `workflow-review-coverage.ts` — Target: exported as `normalizeReviewPath(entry: string, repoRoot: string): string | undefined`.
- `TOP_LEVEL_MARKER_KEYS` — Target: `["summary", "w-index", "w-evidence", "fix-summary", "w-coverage"]`.
- `OpenItem` — Target: adds `readonly files?: readonly string[]`.
- `renderRulingEcho` / `parseRulingEcho` — Target: `verified` may carry ` in <sha>`.
- `BotSettledRuling` — Target: adds `readonly files?: readonly string[]`.
- `BotPrReviewPromptInput` — Target: adds `readonly coveredByRulings?: readonly string[]`.
- `workflowPrReadiness(input)` — Target:
  `(input: { outcome?: RecordRulingsOutcome; ci: CiWaitResult; coverage?: CoverageRecord; headSha?: string }) => WorkflowPrReadiness`.

Patterns to mirror: `writeEvidence` in `src/bot/fix-report.ts` (find the own keyed comment, edit
it or post a new one) for the coverage record; `reviewRequiredFiles`' `_workflowDeps` injection
for git and file access.

The ruled exception in `.nax/rules/retry-strategy.md` (coverage inside the strategy, not in
`op.parse`) still holds after this change: coverage only decides whether to ask again, and an
incomplete verdict is kept. Its wording names `validate`, which no longer carries coverage; the
rule text update is a manual step (Out of Scope).

### Failure Handling

| Case | Behaviour |
|:---|:---|
| Package write or `reviewRequiredFiles` throws, run not aborted | `{ ran: false, why: "review package failed: <message>" }`; no slice runs |
| Package write throws while `fc.runSignal` is aborted | the error is rethrown |
| One slice times out, returns nothing parseable, or throws | that slice records its `why`, its files stay unread, the next slice runs |
| Every slice fails to run | `{ ran: false, why: <first slice's why> }` |
| The run is aborted during a slice | the error is rethrown and no later slice runs |
| The tool-audit dir does not exist | no tool-observed reads; the review result is unchanged otherwise |
| A tool-audit file does not parse or has no `calls` array | that file is skipped with a warn; other files still count |
| A tool call's result is larger than `TOOL_READ_CREDIT_MAX_BYTES`, or a `Read` is ranged | that call credits no file |
| A file path does not survive the opener round trip | it earns no credit; the bot review must read it |
| `fc.runId` or `fc.outputDir` absent | tool-observed reads are skipped |
| Coverage retries reach `coverageRetries` | stop, keep the last parsed verdict with its findings, warn `Coverage retry stopped` with `reason: "budget"` |
| A coverage retry covers no more files than the previous one | stop the same way with `reason: "no progress"` |
| `coverageRetries` is 0 | no coverage retry is sent; the parsed verdict is kept |
| `git diff --name-only <sha>..HEAD` fails for a ruling | that ruling credits nothing; warn with the sha |
| A verified ruling has no `sha` or its item lists no files | it credits nothing |
| Posting or editing the `w-coverage` comment fails | warn; the review outcome is unchanged |
| The `w-coverage` comment does not parse | readiness treats it as absent |
| A `w-coverage` comment from another author | ignored; only the bot's own comment is read |

## Out of Scope

- Slices run one after another; parallel slice sessions are out (user ruling 2026-11-11: parallel slices would miss cross-file context).
- Grouping slice files by the story whose commits changed them is out; slices group by parent directory in git's path order.
- Tool-observed reads do not feed the coverage retry inside a session, because the tool-audit file is written when the hop ends; they only reduce the final unread list.
- Tool-observed reads are not collected for ACP agents that use their own tools (nax has no tool-audit rows for them) or for `nax bot review`.
- From Bash commands, only `git diff ... -- <paths>` (optionally after `cd <dir>`) is credited; `cat`, `sed`, `head` and `git show` are not.
- Findings are not deduplicated across slices.
- `nax bot review` is not sliced.
- The bot review keeps test files in its required set while the branch review drops them; aligning the two is out (#2859 minor 3 stays as documented behaviour).
- A verified ruling recorded before this feature, which has no head sha, credits no files.
- The coverage readiness hold applies only to PRs with the nax workflow marker.
- A failed post of the `w-coverage` comment does not hold readiness; the review summary still lists the unread files.
- Updating the ruled-exception wording in `.nax/rules/retry-strategy.md` is a manual step after merge (`.nax/` is read-only to the run).
- The branch review's model and reasoning effort are not changed.
- A thread `verified` reply is stamped with the PR head at the time the bot records it, not the head at reply time (a forge reply carries no head); a push between the reply and the recording is credited as read. Caller rulings (`nax bot review --rulings`) are exact.
- `callOp`'s generic `Op retrying ... parse probe failed` debug line is not relabelled; the strategy's own `Coverage retry` warn is the coverage signal.

## Stories

### US-001 — the coverage retry strategy

Workdir: packages/nax. No dependencies.

New `src/agents/retry/coverage-retry.ts` with `makeCoverageRetryStrategy` and `CoverageRetryOpts`
as in Design § Approach, exported from `src/agents/retry/index.ts`. Tests in new
`test/unit/agents/retry/coverage-retry.test.ts`, with stub inner strategies and an injected
`_logger`.

### US-002 — review config and the branch op's coverage retries

Workdir: packages/nax. Depends on US-001.

`workflow.review.sliceFiles` / `coverageRetries` in `schemas-workflow.ts` and
`runtime-types-workflow.ts`, plus `WORKFLOW_REVIEW_DEFAULTS` exported from `@/config` and the
three `FIELD_DESCRIPTIONS` rows. `workflowBranchReviewOp.retry` uses `makeCoverageRetryStrategy`;
`WorkflowBranchReviewInput` gains `coverageRetries`. `buildWorkflowBranchCoverageRetry` gains
`progress`.

### US-003 — the bot review ops' coverage retries

Workdir: packages/nax. Depends on US-001, US-002.

`reviewRetry` in `src/operations/bot-pr-review.ts` as in Design § Approach; `BotPrReviewInput`
gains `coverageRetries`; `runPrReview` passes
`(ctx.workflow.review ?? WORKFLOW_REVIEW_DEFAULTS).coverageRetries`.

### US-004 — the branch review prompt states what must be read

Workdir: packages/nax. No dependencies.

`BranchReviewPromptInput.requiredFiles` and `slice`, the "Files you must review" section and the
new sentence in `buildBranchPackageReadingNote`, in
`src/prompts/builders/workflow-branch-builder.ts`. Tests in new
`test/unit/prompts/workflow-branch-builder-coverage.test.ts`.

### US-005 — tool-observed read paths

Workdir: packages/nax. No dependencies.

New `src/workflow/review-tool-reads.ts` with `toolReadPaths` and `TOOL_READ_CREDIT_MAX_BYTES`;
`normalizeReviewPath` exported from `src/operations/workflow-review-coverage.ts`. Tests in new
`test/unit/workflow/review-tool-reads.test.ts`.

### US-006 — the session tool-call loader

Workdir: packages/nax. Depends on US-005.

`readSessionToolCalls` and `_reviewToolReadsDeps` in `src/workflow/review-tool-reads.ts`. Tests in
new `test/unit/workflow/review-tool-reads-loader.test.ts`, in a temp directory.

### US-007 — slice planning and verdict merge

Workdir: packages/nax. No dependencies.

New `src/workflow/branch-review-slices.ts` with `planReviewSlices`, `mergeSliceVerdicts` and
`SliceResult`; `BranchReviewSlice` and `BranchReviewVerdict.slices` in
`src/operations/workflow-types.ts`. Tests in new `test/unit/workflow/branch-review-slices.test.ts`.

### US-008 — the sliced branch review

Workdir: packages/nax. Depends on US-002, US-004, US-007.

`runBranchReview` steps 1-3 and 5-7 of Design § Approach (package once, slices one after another,
merge, unread); `BranchStepContext` declares optional `runId` and `outputDir` (the feature context
already carries both). Tests in new `test/unit/workflow/branch-review-sliced.test.ts`, with
`_workflowDeps.callOp` and `_workflowDeps.git` stubbed.

### US-009 — tool-observed reads in the branch review

Workdir: packages/nax. Depends on US-005, US-006, US-008.

`runBranchReview` step 4: read the session's tool calls after the last slice and drop the files
they credit from `unreadFiles`. Tests in new `test/unit/workflow/branch-review-tool-reads.test.ts`,
with `_workflowDeps.callOp` and `_reviewToolReadsDeps` stubbed.

### US-010 — the unread-files item lists its files

Workdir: packages/nax. No dependencies.

`OpenItem.files`, the reason item in `open-items.ts`, the `Files:` block in `renderItemOpener`
(through `safeCode`), and `parseItemFiles`. Tests in new
`test/unit/workflow/item-threads-files.test.ts` and `test/unit/workflow/open-items-files.test.ts`.

### US-011 — verified rulings record the PR head

Workdir: packages/nax. Depends on US-010.

`renderRulingEcho` / `parseRulingEcho` accept `verified in <sha>`; `ruleItem` in
`src/bot/rulings.ts` stamps `input.info.headSha`. Tests in new
`test/unit/workflow/item-threads-verified-sha.test.ts` and `test/unit/bot/rulings-coverage-sha.test.ts`.

### US-012 — the bot review credits settled coverage rulings

Workdir: packages/nax. Depends on US-003, US-011.

`BotSettledRuling.files`, `readReviewRulings`, new `src/bot/coverage-credit.ts`, `runPrReview`
(credit and lazy prompt), and the "Files covered by settled rulings" prompt section. Tests in new
`test/unit/bot/coverage-credit.test.ts`, `test/integration/bot/review-step-credit.test.ts` and
`test/unit/prompts/bot-pr-review-builder-covered.test.ts`.

### US-013 — the bot review posts its coverage record

Workdir: packages/nax. Depends on US-012.

New `src/bot/coverage-record.ts`; `TOP_LEVEL_MARKER_KEYS` gains `"w-coverage"`; the bot review
post step posts or edits the record. Tests in new `test/unit/bot/coverage-record.test.ts` and
`test/integration/bot/review-run-coverage-record.test.ts`.

### US-014 — the coverage record holds readiness

Workdir: packages/nax. Depends on US-013.

`workflowPrReadiness` gains `coverage` and `headSha`; `workflowReadyHold` in `fix-report.ts` reads
the bot's own `w-coverage` comment. Tests in new `test/unit/bot/workflow-ready-coverage.test.ts` and
`test/integration/bot/fix-ready-coverage.test.ts`.

This is one capability across 14 stories (the user chose one feature over a split, 2026-11-11).

### Context Files

**US-001**
- `packages/nax/src/agents/retry/parse-retry.ts`
- `packages/nax/src/agents/retry/types.ts`
- `packages/nax/src/agents/retry/compose.ts`
- `packages/nax/src/agents/retry/index.ts`

**US-002**
- `packages/nax/src/operations/workflow-branch-review.ts`
- `packages/nax/src/config/schemas-workflow.ts`
- `packages/nax/src/config/index.ts`
- `packages/nax/src/cli/config-descriptions.ts`
- `packages/nax/src/agents/retry/coverage-retry.ts` — created by US-001, read here

**US-003**
- `packages/nax/src/operations/bot-pr-review.ts`
- `packages/nax/src/bot/review-step.ts`
- `packages/nax/src/agents/retry/coverage-retry.ts` — created by US-001, read here
- `packages/nax/test/unit/operations/bot-pr-review.test.ts`

**US-004**
- `packages/nax/src/prompts/builders/workflow-branch-builder.ts`
- `packages/nax/test/unit/prompts/workflow-branch-builder.test.ts`

**US-005**
- `packages/nax-agent/src/tools/tool-audit.ts`
- `packages/nax-agent/src/tools/truncate.ts`
- `packages/nax/src/operations/workflow-review-coverage.ts`

**US-006**
- `packages/nax/src/workflow/review-tool-reads.ts` — created by US-005, extended here
- `packages/nax-agent/src/tools/tool-audit.ts`
- `packages/nax/src/agents/coding-tool-support-resolve.ts`

**US-007**
- `packages/nax/src/operations/workflow-types.ts`
- `packages/nax/src/operations/workflow-replies.ts`

**US-008**
- `packages/nax/src/workflow/branch-review.ts`
- `packages/nax/src/workflow/branch-step-context.ts`
- `packages/nax/src/workflow/story-review.ts`
- `packages/nax/test/unit/workflow/branch-review.test.ts`
- `packages/nax/src/workflow/branch-review-slices.ts` — created by US-007, read here

**US-009**
- `packages/nax/src/workflow/branch-review.ts`
- `packages/nax/src/workflow/feature-context.ts`
- `packages/nax/src/config/paths/index.ts`
- `packages/nax/src/workflow/review-tool-reads.ts` — created by US-005, read here

**US-010**
- `packages/nax/src/workflow/open-items.ts`
- `packages/nax/src/workflow/item-threads.ts`
- `packages/nax/src/workflow/types.ts`
- `packages/nax/src/workflow/pr-body-safe.ts`
- `packages/nax/src/workflow/item-threads-post.ts`

**US-011**
- `packages/nax/src/workflow/item-threads.ts`
- `packages/nax/src/bot/rulings.ts`
- `packages/nax/test/unit/workflow/item-threads.test.ts`
- `packages/nax/test/unit/bot/rulings.test.ts`

**US-012**
- `packages/nax/src/bot/review-step.ts`
- `packages/nax/src/bot/review-rulings.ts`
- `packages/nax/src/prompts/builders/bot-pr-review-builder.ts`
- `packages/nax/test/integration/bot/review-step.test.ts`

**US-013**
- `packages/nax/src/bot/post.ts`
- `packages/nax/src/bot/review-run.ts`
- `packages/nax/src/forge/marker-grammar.ts`
- `packages/nax/src/bot/fix-report.ts`

**US-014**
- `packages/nax/src/bot/workflow-ready.ts`
- `packages/nax/src/bot/fix-report.ts`
- `packages/nax/test/unit/bot/workflow-ready.test.ts`
- `packages/nax/src/bot/coverage-record.ts` — created by US-013, read here

### Creates

**US-001**
- `packages/nax/src/agents/retry/coverage-retry.ts`
- `packages/nax/test/unit/agents/retry/coverage-retry.test.ts`

**US-002**
- `packages/nax/test/unit/operations/workflow-branch-review-coverage.test.ts`
- `packages/nax/test/unit/config/schemas-workflow-review.test.ts`

**US-003**
- `packages/nax/test/unit/operations/bot-pr-review-coverage.test.ts`

**US-004**
- `packages/nax/test/unit/prompts/workflow-branch-builder-coverage.test.ts`

**US-005**
- `packages/nax/src/workflow/review-tool-reads.ts`
- `packages/nax/test/unit/workflow/review-tool-reads.test.ts`

**US-006**
- `packages/nax/test/unit/workflow/review-tool-reads-loader.test.ts`

**US-007**
- `packages/nax/src/workflow/branch-review-slices.ts`
- `packages/nax/test/unit/workflow/branch-review-slices.test.ts`

**US-008**
- `packages/nax/test/unit/workflow/branch-review-sliced.test.ts`

**US-009**
- `packages/nax/test/unit/workflow/branch-review-tool-reads.test.ts`

**US-010**
- `packages/nax/test/unit/workflow/item-threads-files.test.ts`
- `packages/nax/test/unit/workflow/open-items-files.test.ts`

**US-011**
- `packages/nax/test/unit/workflow/item-threads-verified-sha.test.ts`
- `packages/nax/test/unit/bot/rulings-coverage-sha.test.ts`

**US-012**
- `packages/nax/src/bot/coverage-credit.ts`
- `packages/nax/test/unit/bot/coverage-credit.test.ts`
- `packages/nax/test/integration/bot/review-step-credit.test.ts`
- `packages/nax/test/unit/prompts/bot-pr-review-builder-covered.test.ts`

**US-013**
- `packages/nax/src/bot/coverage-record.ts`
- `packages/nax/test/unit/bot/coverage-record.test.ts`
- `packages/nax/test/integration/bot/review-run-coverage-record.test.ts`

**US-014**
- `packages/nax/test/unit/bot/workflow-ready-coverage.test.ts`
- `packages/nax/test/integration/bot/fix-ready-coverage.test.ts`

### Modifies

**US-002**
- `packages/nax/test/unit/config/workflow-config.test.ts` — the defaults test asserts `parsed.workflow` with `toEqual` against an object that has no `review` key. After this story the parsed defaults carry `review: { sliceFiles: 15, coverageRetries: 3 }`; add that member to the expected object. Every other member keeps its value.
- `packages/nax/test/unit/operations/workflow-branch-review.test.ts` — the test "the one retry spent, an incomplete verdict is kept with its findings (AC-11)" asserts that at attempt 1 a parseable incomplete verdict stops with the fallback. After this story coverage retries have their own budget (default 3), so at attempt 1 with files still missing and no coverage retry sent, the strategy retries with the coverage prompt. Replace it with: once a coverage retry covered no more files than the one before, the same reply stops with `fallback` equal to `parseBranchReviewReply(lastOutput, [])`, findings included. The unparseable-reply assertions (AC-12 and the JSON prompt) hold unchanged.

**US-003**
- `packages/nax/test/unit/operations/bot-pr-review.test.ts` — two assertions change, both because coverage now has its own budget. (1) At attempt 1 a triage-complete reply with an uncovered file (`partial`) was expected to stop with `fallback: op.parse(partial, value, ctx())`; with no coverage retry sent it now retries with the coverage prompt, so assert instead that after a coverage retry that covered no more files the same reply stops with that fallback. (2) The US-015 AC-1–5 test compares nextPrompt with buildWorkflowBranchCoverageRetry(value.range, ["src/a.ts"], op === botPrStaticReviewOp); compare with the same call plus the progress argument { attempt: 1, max: 3 }. The triage assertions at attempt 1 and the triage-before-coverage ordering hold unchanged.

**US-013**
- `packages/nax/test/unit/forge/threads-comments.test.ts` — the test "AC-1 exports the top-level marker keys" asserts `TOP_LEVEL_MARKER_KEYS` equals `["summary", "w-index", "w-evidence", "fix-summary"]`. After this story the list ends with `"w-coverage"`; the expected array gains that last entry.

Stories US-001, US-004 to US-012 and US-014 change no existing assertion: every new test goes in a new file, and every shape they change only gains optional members that are absent when empty. In US-008, a one-slice review returns the op's verdict object unchanged apart from `unreadFiles`, so `test/unit/workflow/branch-review.test.ts` keeps its `toEqual({ ran: true, verdict })` and its verdict-without-`inspectedFiles` case.

### Seams

- US-002 → US-001: `workflowBranchReviewOp.retry(input)` returns a strategy that, given a parseable reply missing a required file, returns the coverage prompt with `{ attempt: 1, max: input.coverageRetries }`; a US-002 AC drives it through `callOp` for two successive coverage retries.
- US-003 → US-001: the same for `botPrReviewOp` and `botPrStaticReviewOp`, and triage retries still come first.
- US-008 → US-007 / US-004 / US-002: `runBranchReview` with 20 required files and `sliceFiles: 15` calls the stubbed `callOp` twice, with each slice's files as `requiredFiles` and the prompt's slice line; a re-trigger AC with 10 files calls it once.
- US-009 → US-005 / US-006: with a stubbed tool-audit file listing a `Read` of an otherwise unread file, `runBranchReview` does not report that file unread.
- US-010 → item publication: `postItemThreads` posts an opener whose `Files:` block `parseItemFiles` reads back.
- US-011 → US-010: `ruleItem` stamps the head sha only for an item whose opener `parseItemFiles` reads a non-empty list.
- US-012 → US-011: `readReviewRulings` returns a settled ruling with `files` and `sha` for a verified echo on a file-carrying item, and `runPrReview` passes the credited files out of the op's `requiredFiles`.
- US-013 → US-012: `runBotReview` with a stubbed review outcome carrying `unreadFiles` posts a `w-coverage` comment that `parseCoverageRecord` reads back with that list.
- US-014 → US-013: `workflowReadyHold` with the bot's own `w-coverage` comment at the PR head returns the coverage reason.

## Acceptance Criteria

### US-001 — the coverage retry strategy

- [unit] `makeCoverageRetryStrategy` is importable from `@/agents/retry` and returns an object with a `shouldRetry` function.
- [unit] With a failure that is not a `ParseValidationError`, `shouldRetry` returns exactly the inner strategy's decision.
- [unit] With `ctx.lastOutput` empty, `shouldRetry` returns exactly the inner strategy's decision.
- [unit] With `ctx.lastTurnResult.adapterFailure` set, `shouldRetry` returns exactly the inner strategy's decision.
- [unit] When `parse` returns `null`, `shouldRetry` returns the inner strategy's decision.
- [unit] When the inner strategy returns `{ retry: true, delayMs: 0, nextPrompt: "triage" }` for a parseable reply with missing files, `shouldRetry` returns that decision, not a coverage retry.
- [unit] For a parseable reply with no missing files, `shouldRetry` returns the inner strategy's decision.
- [unit] For a parseable reply missing `["a.ts", "b.ts"]` with `maxCoverageRetries: 3`, the first call returns `{ retry: true, delayMs: 0, nextPrompt: prompt(["a.ts", "b.ts"], { attempt: 1, max: 3 }) }`.
- [unit] After one coverage retry, a second reply missing only `["b.ts"]` returns a retry whose prompt is `prompt(["b.ts"], { attempt: 2, max: 3 })`.
- [unit] After one coverage retry, a second reply still missing two files returns `{ retry: false, fallback: exhaustedFallback(lastOutput) }`.
- [unit] After three coverage retries, each covering one more file, a fourth reply still missing a file returns `{ retry: false, fallback: exhaustedFallback(lastOutput) }`.
- [unit] With `maxCoverageRetries: 0`, a parseable reply missing a file returns `{ retry: false, fallback: exhaustedFallback(lastOutput) }` on the first call.
- [unit] After two coverage retries, a call with `attempt` 2 and an unparseable reply passes `attempt` 0 to the inner strategy.
- [unit] A coverage retry logs one `warn` with message `"Coverage retry"` and data whose first key is `storyId`, with `unread` 2, `attempt` 1 and `max` 3.
- [unit] Stopping on the budget logs one `warn` with message `"Coverage retry stopped"` and `reason` `"budget"`.
- [unit] Stopping on no progress logs one `warn` with message `"Coverage retry stopped"` and `reason` `"no progress"`.
- [unit] A coverage retry never logs a message containing `"JSON parse retry"`.
- [unit] When the inner strategy returns `{ retry: false, fallback: F }` for a parseable reply that also misses a file, `shouldRetry` returns `{ retry: false, fallback: F }` and sends no coverage retry.
- [unit] After two coverage retries, a call with `attempt` 0 passes `attempt` 0 to the inner strategy.

### US-002 — review config and the branch op's coverage retries

- [unit] `NaxConfigSchema.parse({})` yields `workflow.review` equal to `{ sliceFiles: 15, coverageRetries: 3 }`.
- [unit] `WORKFLOW_REVIEW_DEFAULTS` equals `{ sliceFiles: 15, coverageRetries: 3 }`.
- [unit] `NaxConfigSchema.safeParse` with `workflow.review.sliceFiles: 0` fails.
- [unit] `NaxConfigSchema.safeParse` with `workflow.review.coverageRetries: -1` fails.
- [unit] `NaxConfigSchema.parse` with `workflow.review.coverageRetries: 0` keeps `0`.
- [unit] `workflowBranchReviewOp.retry(input)` with `requiredFiles: ["src/a.ts"]` and a parseable reply whose `inspectedFiles` is `[]`, at attempt 0, returns `nextPrompt` equal to `buildWorkflowBranchCoverageRetry(input.range, ["src/a.ts"], false, { attempt: 1, max: 3 })`.
- [unit] The same strategy at attempt 1, after that coverage retry, with a reply whose `inspectedFiles` is still `[]`, returns `{ retry: false, fallback: parseBranchReviewReply(lastOutput, input.minorIds) }`.
- [unit] With `coverageRetries: 1` in the input, the coverage prompt's progress is `{ attempt: 1, max: 1 }`.
- [unit] With an unparseable reply at attempt 0, the strategy returns `nextPrompt` equal to `buildWorkflowReviewJsonRetry()`.
- [unit] With an unparseable reply at attempt 1 and no coverage retry sent, the strategy returns `{ retry: false, fallback: null }`.
- [unit] With an empty `requiredFiles`, a parseable reply returns `{ retry: false }`.
- [unit] `buildWorkflowBranchCoverageRetry("s..HEAD", ["a.ts"], false, { attempt: 2, max: 3 })` includes `This is coverage retry 2 of 3.`
- [unit] `buildWorkflowBranchCoverageRetry("s..HEAD", ["a.ts"])` with no progress includes no line starting `This is coverage retry`.
- [unit] `FIELD_DESCRIPTIONS` has a non-empty string for each of `workflow.review`, `workflow.review.sliceFiles` and `workflow.review.coverageRetries`.
- [integration] Through `callOp` with a stub agent whose three replies inspect none, one, then both of two required files, `workflowBranchReviewOp` sends two coverage retries, the second prompt includes `This is coverage retry 2 of 3.`, and the op returns the third reply's verdict.

### US-003 — the bot review ops' coverage retries

- [unit] For `botPrReviewOp`, a triage-complete reply missing `src/a.ts` at attempt 0 returns `nextPrompt` equal to `buildWorkflowBranchCoverageRetry(range, ["src/a.ts"], false, { attempt: 1, max: 3 })`.
- [unit] For `botPrStaticReviewOp`, the same reply returns `nextPrompt` equal to `buildWorkflowBranchCoverageRetry(range, ["src/a.ts"], true, { attempt: 1, max: 3 })`.
- [unit] For `botPrReviewOp`, a reply missing a thread id and a required file returns the `buildBotTriageRetry` prompt, not the coverage prompt.
- [unit] For `botPrReviewOp` at attempt 1, after one coverage retry, a triage-complete reply still missing `src/a.ts` with `coverageRetries: 3` and no fewer missing files than before returns `{ retry: false, fallback: op.parse(lastOutput, input, ctx) }`.
- [unit] For `botPrReviewOp` at attempt 1 with no coverage retry sent, a reply still missing a thread id returns `{ retry: false }` with the parsed fallback, as before.
- [unit] For `botPrReviewOp` with no `requiredFiles`, a triage-complete reply returns `{ retry: false }`.
- [unit] For `botPrReviewOp` at attempt 1, a reply still missing a thread id and also missing `src/a.ts` returns `{ retry: false }` with the parsed fallback and no coverage prompt.
- [unit] `botPrReviewOp.retry` with `requiredFiles` set and no `range` throws a `NaxError` of code `BOT_REVIEW_COVERAGE_INVALID`.
- [integration] `runPrReview` with `ctx.workflow.review.coverageRetries` 1 calls the stubbed `callOp` with an input whose `coverageRetries` is 1.

### US-004 — the branch review prompt states what must be read

- [unit] `buildWorkflowBranchReviewPrompt` with `requiredFiles: ["src/a.ts", "src/b.ts"]` includes the heading `## Files you must review (2)`.
- [unit] The same prompt includes the lines `- src/a.ts` and `- src/b.ts`.
- [unit] The same prompt includes `nax compares your inspectedFiles with this list.`
- [unit] The same prompt includes `Repo gates passing is not a review of a file`.
- [unit] In the same prompt, `## Files you must review` comes after `## How to read the diff`.
- [unit] `buildWorkflowBranchReviewPrompt` with no `requiredFiles` includes no `## Files you must review` heading.
- [unit] `buildWorkflowBranchReviewPrompt` with `requiredFiles: []` includes no `## Files you must review` heading.
- [unit] With `slice: { index: 2, count: 3, otherFiles: 30 }`, the prompt includes `This is review slice 2 of 3.` and `the other 30 changed file(s)`.
- [unit] With `requiredFiles` and no `slice`, the prompt includes no line starting `This is review slice`.
- [unit] `buildBranchPackageReadingNote("s..HEAD")` starts its body with `This package holds no diff, only the commit list, the --stat summary and the changed-file names.`
- [unit] `buildBranchPackageReadingNote("s..HEAD")` still includes `git diff s..HEAD -- <path>`.

### US-005 — tool-observed read paths

- [unit] `toolReadPaths` for a `Read` call with `input.path` `"src/a.ts"` and outcome `"ok"` returns `["src/a.ts"]`.
- [unit] `toolReadPaths` for a `Read` call with outcome `"denied"` returns `[]`.
- [unit] `toolReadPaths` for a `Read` of `"/repo/src/a.ts"` with `repoRoot` `"/repo"` returns `["src/a.ts"]`.
- [unit] `toolReadPaths` for a `Read` of `"/other/x.ts"` with `repoRoot` `"/repo"` returns `[]`.
- [unit] `toolReadPaths` for a `Git` call `{ subcommand: "diff", refs: ["s..HEAD"], paths: ["src/a.ts", "src/b.ts"] }` returns `["src/a.ts", "src/b.ts"]`.
- [unit] `toolReadPaths` for a `Git` call `{ subcommand: "diff", nameOnly: true, paths: ["src/a.ts"] }` returns `[]`.
- [unit] `toolReadPaths` for a `Bash` command `git diff s..HEAD -- src/a.ts src/b.ts` returns `["src/a.ts", "src/b.ts"]`.
- [unit] `toolReadPaths` for a `Bash` command `cd apps/api; B=abc; rtk git diff $B..HEAD -- src/x.ts prisma/schema.prisma` returns `["apps/api/src/x.ts", "apps/api/prisma/schema.prisma"]`.
- [unit] `toolReadPaths` for a `Bash` command `git diff --name-only s..HEAD -- src/a.ts` returns `[]`.
- [unit] `toolReadPaths` for a `Bash` command `git diff s..HEAD -- src/a.ts | head -150` returns `["src/a.ts"]`.
- [unit] `toolReadPaths` for a `Bash` command `git diff s..HEAD -- 'src/*.ts' $F` returns `[]`.
- [unit] `toolReadPaths` for a `Bash` command `cat src/a.ts` returns `[]`.
- [unit] `toolReadPaths` for two calls that both read `src/a.ts` returns `["src/a.ts"]` once.
- [unit] `toolReadPaths` for a `Bash` command `git diff s..HEAD -- 'src/a.ts' "src/b.ts"` returns `["src/a.ts", "src/b.ts"]`.
- [unit] `normalizeReviewPath("./src/a.ts", "/repo")` returns `"src/a.ts"`, and `normalizeReviewPath("../x.ts", "/repo")` returns `undefined`.
- [unit] `toolReadPaths` for a `Git` diff call with `resultBytes` 40000 credits its paths, and the same call with `resultBytes` 40001 credits none.
- [unit] `toolReadPaths` for a `Bash` `git diff` call with `resultBytes` above `TOOL_READ_CREDIT_MAX_BYTES` returns `[]`.
- [unit] `toolReadPaths` for a `Read` of `src/a.ts` with `limit` 120 returns `[]`.

### US-006 — the session tool-call loader

- [unit] `readSessionToolCalls` over a temp dir holding `r1-2000-f-wf-branch-review.json` with two calls returns those two calls for `runId` `r1`, `ledgerSessionName` `f-wf-branch-review` and `sinceMs` 1000.
- [unit] `readSessionToolCalls` skips a file whose stamp is below `sinceMs`.
- [unit] `readSessionToolCalls` skips a file for another `runId` or another session name.
- [unit] `readSessionToolCalls` for a directory that does not exist returns `[]`.
- [unit] `readSessionToolCalls` skips a file holding `not json`, returns the calls of the other files, and logs one `warn`.
- [unit] `readSessionToolCalls` for two matching files returns the calls of the lower stamp first.

### US-007 — slice planning and verdict merge

- [unit] `planReviewSlices(["a/1", "a/2"], 15)` returns `[["a/1", "a/2"]]`.
- [unit] `planReviewSlices([], 15)` returns `[[]]`.
- [unit] `planReviewSlices` for 3 files in `a/` then 3 in `b/` with `sliceFiles` 4 returns `[["a/1", "a/2", "a/3"], ["b/1", "b/2", "b/3"]]`.
- [unit] `planReviewSlices` for 2 files in `a/` then 2 in `b/` with `sliceFiles` 4 returns one slice holding all four in order.
- [unit] `planReviewSlices` for 1 file in `a/` then 10 files in `b/` with `sliceFiles` 4 returns `[["a/1"], ["b/1".."b/4"], ["b/5".."b/8"], ["b/9", "b/10"]]`.
- [unit] `planReviewSlices` for root files `x.json` and `y.json` groups them together.
- [unit] `planReviewSlices` never returns a slice longer than `sliceFiles`, for 40 files across 7 directories and `sliceFiles` 6.
- [unit] `planReviewSlices` returns every input path exactly once across its slices, in input order.
- [unit] `mergeSliceVerdicts` of two slices whose verdicts are both `null` returns `null`.
- [unit] `mergeSliceVerdicts` returns `spec` `"fail"` when one ran slice says `"fail"` and the other `"pass"`.
- [unit] `mergeSliceVerdicts` returns `quality` `"changes"` when one ran slice says `"changes"`.
- [unit] `mergeSliceVerdicts` returns the findings of slice 1 followed by those of slice 2.
- [unit] `mergeSliceVerdicts` returns `cannotVerify` with an entry both slices list exactly once.
- [unit] `mergeSliceVerdicts` returns `inspectedFiles` as the union, a file both slices list appearing once.
- [unit] `mergeSliceVerdicts` returns `M1` as `"fix-now"` when one slice says `"fix-now"` and the other `"leave"`.
- [unit] `mergeSliceVerdicts` with slice 2's verdict `null` and `why` `"timeout"` returns `slices[1]` equal to `{ files: <slice 2 files>, inspectedFiles: [], ran: false, why: "timeout" }`.
- [unit] `mergeSliceVerdicts` with slice 2's verdict `null` takes `spec`, `quality` and findings from slice 1 only.
- [unit] `mergeSliceVerdicts` returns `slices[0].inspectedFiles` equal to slice 1's verdict `inspectedFiles`.
- [unit] `planReviewSlices` for 6 files in `a/` then 1 file in `b/` with `sliceFiles` 4 returns `[["a/1".."a/4"], ["a/5", "a/6", "b/1"]]`.
- [unit] `mergeSliceVerdicts` of one ran part returns that part's verdict object itself, with no `slices` field.
- [unit] `mergeSliceVerdicts` of two ran parts where one verdict has no `inspectedFiles` property returns the other part's `inspectedFiles`.

### US-008 — the sliced branch review

- [unit] `runBranchReview` with 10 required files and `sliceFiles` 15 calls the stubbed `callOp` once, with `requiredFiles` equal to all 10.
- [unit] In that one-slice case the prompt passed to `callOp` equals `buildWorkflowBranchReviewPrompt` with `requiredFiles` set to the 10 files and no `slice`.
- [unit] In that one-slice case the returned verdict has no `slices` field.
- [unit] `runBranchReview` with 20 required files in two directories of 10 and `sliceFiles` 15 calls `callOp` twice, the first with the first directory's files as `requiredFiles` and the second with the second's.
- [unit] In that two-slice case the second prompt includes `This is review slice 2 of 2.`
- [unit] In that two-slice case the first `callOp` resolves before the second starts.
- [unit] In that two-slice case each `callOp` input has `coverageRetries` equal to `fc.workflow.review.coverageRetries`.
- [unit] In that two-slice case the returned verdict's `slices` has two entries whose `files` are the two slices.
- [unit] When the stubbed package writer throws `boom` and the run is not aborted, `runBranchReview` returns `{ ran: false, why: "review package failed: boom" }` and `callOp` is not called.
- [unit] When the stubbed package writer throws while `fc.runSignal` is aborted, `runBranchReview` rejects with that error.
- [unit] When the first of two slices' `callOp` returns `null`, the second slice still runs and the result is `ran: true`.
- [unit] In that case the first slice's files are in `unreadFiles` and `slices[0].ran` is `false` with `why` `"unparseable reply"`.
- [unit] When both slices' `callOp` return `null`, `runBranchReview` returns `{ ran: false, why: "unparseable reply" }`.
- [unit] When `callOp` rejects for slice 1 while `fc.runSignal` is aborted, `runBranchReview` rejects and `callOp` is called once.
- [unit] When the first of two slices' `callOp` rejects with `boom` and the run is not aborted, the second slice still runs and `slices[0]` has `ran` `false` and `why` `"boom"`.
- [unit] When the first of two slices hits its review timeout, `slices[0].why` is `"timeout"` and the second slice still runs.
- [unit] When the stubbed op returns a verdict with no `inspectedFiles` property for a single slice, `runBranchReview` returns `ran: true` with every required file in `unreadFiles`.

### US-009 — tool-observed reads in the branch review

- [unit] When the stubbed tool-audit file for session `<feature>-wf-branch-review` records a `Read` of `src/b.ts`, which no slice listed in `inspectedFiles`, `src/b.ts` is not in the result's `unreadFiles`.
- [unit] A tool-audit `Read` of a file outside the required set adds nothing to the verdict's `inspectedFiles` or `unreadFiles`.
- [unit] With `fc.runId` absent, `readSessionToolCalls` is not called.
- [unit] With `fc.outputDir` absent, `readSessionToolCalls` is not called.
- [unit] When `readSessionToolCalls` returns `[]`, `unreadFiles` is the required files no slice listed.
- [unit] When the stubbed tool-audit file records a `Git` diff of `src/b.ts` with `resultBytes` above `TOOL_READ_CREDIT_MAX_BYTES`, `src/b.ts` stays in `unreadFiles`.

### US-010 — the unread-files item lists its files

- [unit] `buildOpenItems` for a record with `reviewUnread: ["a.ts", "b.ts"]` and the matching `describeUnread` text in `reasons` returns that reason item with `files: ["a.ts", "b.ts"]`.
- [unit] `buildOpenItems` returns other reason items with no `files` field.
- [unit] `renderItemOpener` for an item with `files: ["a.ts", "b.ts"]` includes the line `Files:` followed by `` - `a.ts` `` and `` - `b.ts` ``.
- [unit] In that opener, the `Files:` line comes before the reply instruction line.
- [unit] `renderItemOpener` for an item with no `files` is identical to its output before this feature.
- [unit] `parseItemFiles` of that opener returns `["a.ts", "b.ts"]`.
- [unit] `parseItemFiles` of the same opener wrapped with `withNaxBotMarker` returns `["a.ts", "b.ts"]`.
- [unit] `parseItemFiles` of an opener with no `Files:` block returns `[]`.
- [unit] `parseItemOpener` of an opener with files returns the same `id`, `kind` and `issue` as without them.
- [unit] `itemKey` of an item is the same with and without `files`.
- [unit] `postItemThreads` for a record with `reviewUnread: ["a.ts"]` and the matching reason posts an opener whose body `parseItemFiles` reads as `["a.ts"]`.
- [unit] `parseItemFiles` of an opener rendered with `files: ["app/@modal/page.tsx", "docs/#1.md"]` returns those two paths unchanged.

### US-011 — verified rulings record the PR head

- [unit] `renderRulingEcho` for `{ disposition: "verified", sha: "<40 hex>", reason: "read all" }` starts with `Recorded: verified in <first 7 hex> — read all`.
- [unit] `renderRulingEcho` for a `verified` ruling with no `sha` starts with `Recorded: verified — `.
- [unit] `parseRulingEcho` of a `wr-verified-<key>` echo `Recorded: verified in abc1234 — read all` returns a ruling with `disposition` `"verified"` and `sha` `"abc1234"`.
- [unit] `parseRulingEcho` of a `wr-verified-<key>` echo with no ` in <sha>` returns a ruling with no `sha`.
- [unit] `parseRulingEcho` of a `wr-waived-<key>` echo `Recorded: waived in abc1234 — x` returns `null`.
- [unit] `parseRulingEcho` of a `wr-fixed-<key>` echo with no ` in <sha>` returns `null`.
- [unit] `recordPrRulings` with a writer's `verified` reply on an item whose opener lists files, and `info.headSha` `H`, records a ruling with `sha` `H`.
- [unit] In that case the echo posted with `replyToThread` starts with `Recorded: verified in <H first 7>`.
- [unit] `recordPrRulings` with a writer's `verified` reply on an item whose opener lists no files records a ruling with no `sha`.
- [unit] `recordPrRulings` with a caller ruling `verified` on a file-carrying item records a ruling with `sha` equal to `info.headSha`.
- [unit] `recordPrRulings` with a writer's `waived: reason` reply on a file-carrying item records a ruling with no `sha`.

### US-012 — the bot review credits settled coverage rulings

- [unit] `creditedFiles` with a verified ruling listing `["a.ts", "b.ts"]` at sha `S`, `required` `["a.ts", "b.ts", "c.ts"]` and `changedSince(S)` returning `[]` returns `["a.ts", "b.ts"]`.
- [unit] `creditedFiles` with `changedSince(S)` returning `["b.ts"]` returns `["a.ts"]`.
- [unit] `creditedFiles` with `changedSince(S)` returning `null` returns `[]`.
- [unit] `creditedFiles` with a verified ruling with no `sha` returns `[]`.
- [unit] `creditedFiles` with a `waived` ruling listing files at a sha returns `[]`.
- [unit] `creditedFiles` drops a ruling's file that is not in `required`.
- [unit] `creditedFiles` with two rulings crediting `c.ts` and `a.ts` returns `["a.ts", "c.ts"]` in `required` order.
- [unit] `creditedFiles` calls `changedSince` once per distinct sha, and never for a ruling with no `sha` or no `files`.
- [unit] `readReviewRulings` for a settled verified item whose opener lists `["a.ts"]` and whose echo carries sha `abc1234` returns a `settled` entry with `files: ["a.ts"]` and `sha: "abc1234"`.
- [unit] `readReviewRulings` for a settled item whose opener lists no files returns a `settled` entry with no `files` field.
- [integration] `runPrReview` with `settled` holding a verified ruling for `["src/a.ts"]` at sha `S`, required files `["src/a.ts", "src/b.ts"]`, and `git diff --name-only S..HEAD` printing nothing, calls `callOp` with `requiredFiles: ["src/b.ts"]`.
- [integration] In that case the prompt passed to `callOp` includes `## Files covered by settled rulings` and `- src/a.ts`.
- [integration] In that case a verdict with `inspectedFiles: ["src/b.ts"]` gives an outcome with no `unreadFiles` field.
- [integration] When `git diff --name-only S..HEAD` prints `src/a.ts`, `callOp` receives `requiredFiles: ["src/a.ts", "src/b.ts"]`.
- [integration] When `git diff --name-only S..HEAD` exits 128, `callOp` receives both files and one `warn` is logged whose data has `sha` `S`.
- [integration] With no settled rulings, `callOp` receives the full required set and the prompt has no `## Files covered by settled rulings` heading.
- [unit] `buildBotPrReviewPrompt` with `coveredByRulings: ["a.ts"]` includes `You do not need to read them. Read every other changed file in the package.`
- [unit] `buildBotPrReviewPrompt` with `coveredByRulings: []` includes no `## Files covered by settled rulings` heading.

### US-013 — the bot review posts its coverage record

- [unit] `renderCoverageRecord({ headSha: H, uncovered: ["a.ts"] })` starts with `Review coverage at <H>: 1 required file(s) not read`.
- [unit] `parseCoverageRecord(renderCoverageRecord(r))` returns a record deep-equal to `r` for `uncovered` `["a.ts", "b.ts"]`.
- [unit] `parseCoverageRecord` of the record wrapped with `withNaxBotMarker(body, COVERAGE_RECORD_KEY)` returns the same record.
- [unit] `parseCoverageRecord(renderCoverageRecord({ headSha: H, uncovered: [] }))` returns `{ headSha: H, uncovered: [] }`.
- [unit] `parseCoverageRecord("hello")` returns `null`.
- [unit] `TOP_LEVEL_MARKER_KEYS` includes `"w-coverage"`.
- [integration] `runBotReview` on a workflow-marker PR whose stubbed review outcome has `unreadFiles: ["src/a.ts"]` posts one comment whose body `parseCoverageRecord` reads as `{ headSha: <reviewed head>, uncovered: ["src/a.ts"] }`.
- [integration] When the bot already has a `w-coverage` comment, `runBotReview` edits that comment and posts no new one.
- [integration] `runBotReview` on a PR without the workflow marker posts no `w-coverage` comment.
- [integration] A conversation-only `runBotReview` posts no `w-coverage` comment.
- [integration] When posting the `w-coverage` comment rejects, `runBotReview` still returns outcome `"posted"` and logs one `warn`.
- [integration] When editing the existing `w-coverage` comment rejects, `runBotReview` still returns outcome `"posted"` and logs one `warn`.
- [integration] For the same review outcome, the number of `Not read by the review` lines in the summary comment equals the `uncovered` count in the `w-coverage` record.

### US-014 — the coverage record holds readiness

- [unit] `workflowPrReadiness` with every item settled, CI green, `headSha` `H` and `coverage` `{ headSha: H, uncovered: ["a.ts", "b.ts"] }` returns `{ ready: false }` with a reason starting `bot review did not read 2 required file(s) at <H first 7>: a.ts, b.ts`.
- [unit] That reason ends with `run nax bot review`.
- [unit] With 7 uncovered files, the reason lists the first 5 and then `+2 more`.
- [unit] With `coverage.headSha` different from `headSha`, `workflowPrReadiness` returns `{ ready: true }` when every item is settled and CI is green.
- [unit] With `coverage.uncovered` empty, `workflowPrReadiness` returns `{ ready: true }` when every item is settled and CI is green.
- [unit] With an open item and uncovered files at the head, the reason names the open item, not the coverage.
- [unit] With uncovered files at the head and CI `failed`, the reason is the coverage reason.
- [integration] `workflowReadyHold` (through `readyStep` with `readyOnly`) on a draft workflow PR whose own `w-coverage` comment names `src/a.ts` at the PR head returns a `readyHeld` starting `bot review did not read 1 required file(s)`.
- [integration] The same draft PR whose own `w-coverage` comment body does not parse gets no coverage hold.
- [integration] `workflowReadyHold` ignores a `w-coverage` comment naming files at the PR head when its author is not the bot's login.
