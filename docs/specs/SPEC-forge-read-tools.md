# SPEC: Forge read tools for repair agents (and CI logs that arrive)

Closes: #2657

## Summary

A repair agent working on a published PR can only see the CI failure nax pastes into its brief, and today
that paste is often empty or useless. This spec does two things. It fixes how nax reads CI logs (#2657):
the log of a finished job is read even while other jobs of the same run are still going, the excerpt
leads with GitHub Actions' own error annotations, the GitHub CI wait no longer stops at the first failed
check while other checks are still running, and a repair whose every failed log is unreadable is skipped
instead of run blind. And it gives repair agents a read-only forge tool set, the `nax-forge` provider:
`pr`, `checks`, `log` (search, page or tail one job's whole log), `threads` and `comments` (writer-authored
only). The provider is bound to one PR by nax, never by the agent, and is attached to the workflow CI repair
session and to the `nax bot fix` fix and repair sessions. It reaches native sessions and ACP Claude sessions
through the existing static tool-provider path.

## Motivation

On a real run (nax 0.91.3, 2026-10-22) the workflow published a draft PR and waited for CI:

1. `CI checks: 7/11 passed, 3 pending, failing: test` ended the wait as `failed` while `e2e` was still running.
2. nax read the failed job's log with `gh run view --job <id> --log-failed`, which refuses while any job of
   the same Actions run is in progress. The CI repair brief carried only
   `(log unavailable: run <id> is still in progress; logs will be available when it is complete)`.
3. The repair agent spent 38 minutes reconstructing CI locally, asked for the log through `RequestCapability`
   (refused, as designed), and ended with an empty commit to re-trigger CI.
4. The real failures were a test timeout in an untouched package (a flake: green on the re-run) and an `e2e`
   regression the agent never saw, because the wait had stopped before `e2e` finished.

Probed live on gh 2.102.0 against a run in progress:

- `gh run view --job <completed-job> --log-failed` exits 1 with "run ... is still in progress".
- `gh api repos/<repo>/actions/jobs/<id>/logs` returns the job's full log mid-run, but only with
  `--allow-escape-sequences`; without it gh exits 1 ("the response contains terminal escape sequences").
- Every line of that log starts with an ISO timestamp, for example
  `2026-10-22T13:21:21.2513942Z ##[error]command (...) exited (1)`.

Even a readable log did not help: in the failed `test` job's 24 155-line log the failing test sits at line
2 845, followed by about 19 000 lines of other packages' output that a monorepo task runner prints after the
failure. The 200-line tail excerpt shows none of it. The only failure signal near the end is GitHub Actions'
own `##[error]` annotation, which names the failing package's command. An agent needs to search the log,
not read its tail; that is what the `log` tool does.

Agents get forge reads, not forge writes: creating PRs, posting comments and marking ready stay with nax,
which already does them at fixed points; an agent write would bypass the writer gate that decides which PR
text becomes fix work.

## Design

### Approach

- **Log read (#2657 defect 1).** A new `readJobLog(ref, checkId, deps, cwd)` in `src/forge/job-log.ts`
  reads one job's whole log: GitHub through `gh api --allow-escape-sequences --hostname <host>
  repos/<repo>/actions/jobs/<id>/logs` (retried once without the flag when gh reports it as an unknown
  flag), GitLab through `glab api --hostname <host> projects/<p>/jobs/<id>/trace`. The text comes back with
  ANSI CSI colour codes and a leading byte-order mark removed and every secret redacted over the whole log.
  `stripAnsi` moves from `src/forge/ci-failures.ts` into `src/forge/job-log.ts`, which exports it;
  `ci-failures.ts` imports it from there. Both forges' CI repair excerpts (`readFailedChecks`) read through
  `readJobLog`, which replaces `excerptOf` and `logUnavailableExcerpt` in `ci-failures.ts`. `FailedCheck`
  gains `logUnavailable?: true`, set when the log could not be read. The excerpt source changes from the
  failed steps only (`--log-failed`) to the whole job log.
- **Annotation excerpt (part of defect 1).** For a GitHub Actions job whose log has lines containing
  `##[error]` (anywhere in the line: the API prefixes each line with a timestamp), the excerpt is an
  annotation block followed by a tail block:

  ```
  GitHub Actions error annotations:
  <up to CI_ANNOTATION_LINES lines containing ##[error], in log order>

  Log tail:
  <the end of ciExcerpt(log)>
  ```

  The annotation block, header line included, is at most `CI_ANNOTATION_CHARS` characters; lines that would
  pass that bound are dropped from the end of the block, and a single first line longer than the bound is cut
  to it. The tail block gets the remaining budget: it is `ciExcerpt(log)` cut from its start so the whole
  excerpt is at most `CI_EXCERPT_CHARS` characters. A log with no `##[error]` line, and every GitLab trace,
  keeps the excerpt `ciExcerpt(log)`.
- **CI wait (defect 2).** In `waitForChecks` for GitHub, a poll with a failed bucket and at least one
  bucket that is neither failed nor passed is a *failing* poll: not terminal, and not passed through the
  mergeability read (a failed check keeps its meaning, as today). The rules, in order:
  1. A later readable poll decides as today: all passed is `green`, a failed bucket with none pending is
     `failed`, a conflict is `conflicting`. A re-run that turns everything green ends `green`.
  2. Error polls count toward the existing unreadable-poll run (`CI_ERROR_POLL_LIMIT`). When the run
     reaches the limit, the wait ends `failed` if a failing poll was observed for this head since the wait
     started, and `unavailable` otherwise (today's behaviour).
  3. At the deadline, when the latest readable poll was failing, the wait ends `failed` with a detail naming
     the failing checks and saying how many checks were `still pending`; this wins over the errored-poll
     `unavailable` rule, because a failed check was observed for this head.
  GitLab is unchanged: its pipeline status turns `failed` only when the pipeline is done. `readChecksOnce`
  (one read, used by the bot) is unchanged. Every `waitForChecks` caller inherits the change: the workflow
  publish (`src/workflow/finalize.ts`), `nax workflow promote` (`src/cli/workflow-promote.ts`) and the bot
  fix report (`src/bot/fix-report.ts`).
- **No evidence, no repair (defect 3).** When every failed check of the repair read has `logUnavailable`,
  the CI repair decision returns no repair and the ledger says why. The draft PR stays as published.
  `src/workflow/feature-steps.ts` is 582 lines against the 600-line limit; the change there stays within it.
- **Check listing.** A new `listHeadChecks(ref, headSha, deps, cwd)` in `src/forge/checks-read.ts` lists
  every check of a head commit, running ones included, with a normalized status (table below). It reads one
  page of at most 100 check runs (GitHub) or 100 jobs (GitLab). It reuses `readCiListing` and `asRecord`,
  which `src/forge/ci-failures.ts` exports for use inside the forge module (not from the barrel), so a failed
  or unparseable GitLab listing fails exactly like the GitHub one.
- **The provider.** A new module `src/forge-tools/` builds a static `ToolProvider` with id `nax-forge`,
  `kind: "static"` and `stages: ["*"]`. Its tools are `pr`, `checks`, `log`, `threads` and `comments`,
  advertised as `nax-forge__<name>` (and served to ACP Claude as `mcp__nax__nax-forge__<name>`). The PR comes
  from a `resolveRef` the caller supplies; no tool input names a repo, PR, head or URL. Every tool is
  read-only and never throws: a failure is an `isError` result. Every forge call the module makes, PR
  resolution from a URL included, goes through the exported `_forgeToolsDeps` object, the module's test seam.
- **Untrusted text and the output budget.** Everything a tool returns that came from the forge (PR fields,
  check names, log lines, comment bodies) is rendered inside one `markdownFence` block per tool result; the
  lines nax writes itself (headers, counts, footers) stay outside it. Every tool builds its result with
  `fitToolResult`, which fits whole entries (a log line, a check line, a comment) to the run context's
  `maxBytes` instead of cutting the finished string: it keeps the header, as many whole entries as fit from the
  kept side (`"end"` for the `log` tail view, `"start"` for every other view), always closes the fence, keeps
  the footer, and adds a `[truncated: <k> entries not shown]` line after the footer when it dropped any. A
  single entry that does not fit alone is cut on a code-point boundary.
- **Writer-only PR text.** `threads` and `comments` show only comments whose author has write access, and
  count the rest as withheld, the same rule the bot applies to fix items. The check is `writerCheck` over
  `_forgeToolsDeps.hasWriteAccess`, called with `{ login: comment.author, id: comment.authorId }` (GitLab
  needs the id), cached per login for the life of one provider instance, and fail closed. `writerCheck` moves
  from `src/bot/writers.ts` to `src/forge/access.ts` so the new module can use it without an import cycle;
  `src/bot/writers.ts` re-exports it, so bot callers are unchanged.
- **Dispatch plumbing.** `CallContext` gains `toolProviders`, call-scoped providers that
  `buildRunDispatchOptions` appends after the runtime's `toolProviders`; from there the existing provider
  path delivers them to native sessions (`extraTools` and grants) and to ACP Claude (`acpDelivery`).
  `runBranchFix` takes an optional `toolProviders` and passes it on the call context.
- **Bindings.** The workflow CI repair binds the published PR URL; the bot fix and bot repair bind the bot's
  `PrRef`. Every other session gets no provider. The workflow binding uses `_featureDeps.forge`, the same
  `ForgeDeps` the workflow's thread posting uses.

### Integration

Read-only symbols (verified on main `ecdaf0b0d`):

- `ToolProvider`, `ProviderTool`, `ToolResult`, `ToolRunContext` from `@nathapp/nax-agent`
  (`packages/nax-agent/src/tools/provider-types.ts`, `registry.ts`). `ToolProvider { id; kind: "static" |
  "discovered"; stages; tools(workdir): Promise<readonly ProviderTool[]>; instructions?(workdir) }`.
- `resolveProviderTools(providers, stage, workdir, options?)` from `@nathapp/nax-agent`; names each tool
  `<providerId>__<localName>`.
- `resolveCodingToolSupport(options)` (`src/agents/coding-tool-support-resolve.ts`); resolves providers only
  when the permission profile's `providerScope` is not `"none"` (`unrestricted` = `"all"`, `safe` = `"none"`,
  `scoped` = `"rules"`, see `resolvePermissions` in `src/config/permissions.ts`).
- `finalizeAcpSurface` / `toEmbedderTools` (`src/agents/acp/provider-embedder.ts`): ACP delivery to agents
  with a pre-approval channel (Claude only), calling `tool.run` with `resolvedPaths: []`, no policy check.
- `PrRef`, `PrInfo`, `PrThread`, `PrComment` (`kind` `"thread" | "comment" | "review"`, `author`,
  `authorId?`, `createdAt`), `ForgeDeps` and `readPrInfo(ref, deps, cwd)`, `resolvePrRef(number, deps,
  cwd)`, `prNumberFromUrl(url)`, `listReviewThreads(ref, deps, cwd)`, `listPrComments(ref, deps, cwd)`
  (top-level comments and, on GitHub, review bodies), `hasWriteAccess(ref, who, deps, cwd)`, `ciExcerpt(log)`,
  `CI_EXCERPT_CHARS` (8 000), `CI_EXCERPT_LINES` (200), `encodeProjectPath` from `@/forge`.
- `redactSecrets` from `@/logger`; `markdownFence(text)` from `src/utils/markdown-fence.ts`;
  `errorMessage` from `@nathapp/nax-agent/internal`.
- `_featureDeps.forge` (`src/workflow/feature-deps.ts`), the workflow's `ForgeDeps`.
- `BotFixEnv` (`src/bot/fix-steps.ts`) with `ref: PrRef`, `forge: ForgeDeps`, `repoRoot: string`, `ctx:
  PrStepContext`.
- `WorkflowFeatureRecord.url` (`src/workflow/types.ts`), set by the publish step.

Symbols this feature changes. The baseline exists only to locate the code; it is never the interface to
implement.

- `readExcerpt` (`src/forge/ci-failures.ts`, file-local). Baseline: runs `["gh", "run", "view", "--job",
  <id>, "--log-failed", "-R", <host>/<repo>]`. Target: reads through `readJobLog` and builds the excerpt with
  the annotation block.
- `readGitlabExcerpt` (`src/forge/ci-failures.ts`, file-local). Target: reads through `readJobLog`.
- `excerptOf`, `logUnavailableExcerpt` (`src/forge/ci-failures.ts`, file-local). Baseline: build the
  excerpt from a `ForgeRunResult`, using the first stderr line as the reason. Target: removed; `readJobLog`'s
  `reason` (first non-empty stderr line) replaces them.
- `stripAnsi` (`src/forge/ci-failures.ts`, file-local). Target: defined and exported in
  `src/forge/job-log.ts`.
- `readCiListing`, `asRecord` (`src/forge/ci-failures.ts`, file-local). Target: exported from
  `ci-failures.ts` for `checks-read.ts`; not exported from the barrel.
- `FailedCheck` (`src/forge/ci-failures.ts`). Target: `{ name; url?; excerpt; logUnavailable?: true }`.
- `classifyGh` / `waitForChecks` (`src/workflow/ci-wait.ts`). Baseline: any failed bucket is a terminal
  `failed` poll. Target: the failing-poll rules above.
- `readCiFailuresForRepair` (`src/workflow/feature-steps.ts`, file-local). Target: returns `undefined` with a
  ledger note when every check has `logUnavailable`.
- `writerCheck`, `WriterCheck`. Baseline: defined in `src/bot/writers.ts`. Target: defined in
  `src/forge/access.ts`, exported from `@/forge`; `src/bot/writers.ts` re-exports both.
- `CallContext` (`src/operations/types.ts`). Target: gains `readonly toolProviders?: readonly
  import("@nathapp/nax-agent").ToolProvider[]` (input-side).
- `runtimeDispatchFields` / `buildRunDispatchOptions` (`src/operations/call-run-options.ts`). Baseline:
  `providers` = `runtime.toolProviders` when non-empty. Target: `providers` = `runtime.toolProviders` then
  `ctx.toolProviders`, omitted when both are empty.
- `runBranchFix(fc, input)` (`src/workflow/branch-fix.ts`). Target: `input` gains `toolProviders?: readonly
  ToolProvider[]`; `runFixSession` calls `callOp` with `{ ...fc.callCtx, toolProviders }` when that list is
  non-empty and with `fc.callCtx` itself otherwise.
- `FeatureSteps.branchFix` (`src/workflow/feature-machine.ts`). Baseline: `branchFix(findings)`. Target:
  `branchFix(findings, opts?: { readonly prUrl?: string })`.
- `buildFeatureEnv` (`src/workflow/feature-env.ts`). Target: its `branchFix` passes `toolProviders:
  [forgeReadProviderForUrl(opts.prUrl, _featureDeps.forge, fc.projectDir)]` to `runBranchFix` when
  `opts.prUrl` is set.
- `ciRepairStep` (`src/workflow/feature-steps.ts`). Target: calls `env.steps.branchFix(findings, { prUrl:
  rec.url })` when `rec.url` is set.
- `fixStep` (`src/bot/fix-steps.ts`) and `repairStep` (`src/bot/repair-step.ts`). Target: both pass
  `toolProviders: [createForgeReadProvider({ resolveRef: async () => env.ref, deps: env.forge, cwd:
  env.repoRoot })]` to `runBranchFix`.

### New modules

`src/forge/job-log.ts`:

```ts
export type JobLogRead = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };
export async function readJobLog(ref: PrRef, checkId: string, deps: ForgeDeps, cwd: string): Promise<JobLogRead>;
export function stripAnsi(text: string): string;
export const CI_ANNOTATION_LINES = 20;
export const CI_ANNOTATION_CHARS = 2_000;
```

`reason` is the first non-empty line of the failed call's stderr, ANSI-stripped, redacted and cut to
`CI_EXCERPT_CHARS` characters; `"unknown"` when stderr has no non-empty line.

`src/forge/checks-read.ts`:

```ts
export type ForgeCheckStatus = "queued" | "in_progress" | "completed";
export interface ForgeCheck {
  readonly id: string;
  readonly name: string;
  readonly status: ForgeCheckStatus;
  /** Present only when status is "completed". */
  readonly conclusion?: string;
  readonly url?: string;
  /** True for a GitHub Actions job or a GitLab job: readJobLog can read it. */
  readonly hasJobLog: boolean;
}
export async function listHeadChecks(ref: PrRef, headSha: string, deps: ForgeDeps, cwd: string): Promise<readonly ForgeCheck[]>;
```

| Forge status | `ForgeCheck.status` | `conclusion` |
|---|---|---|
| GitHub `completed` | `completed` | the run's `conclusion`, or `"unknown"` when null |
| GitHub `in_progress` | `in_progress` | absent |
| GitHub `queued`, `waiting`, `requested`, `pending`, or any other value | `queued` | absent |
| GitLab `running` | `in_progress` | absent |
| GitLab `success`, `failed`, `canceled`, `skipped` | `completed` | the job's status |
| GitLab `created`, `pending`, `preparing`, `waiting_for_resource`, `scheduled`, `manual`, or any other value | `queued` | absent |

A check run or job without a numeric id is not listed. All of the above are exported from
`src/forge/index.ts`.

`src/forge-tools/` (barrel `index.ts`):

```ts
export const FORGE_READ_PROVIDER_ID = "nax-forge";
export interface ForgeReadBinding {
  readonly resolveRef: () => Promise<PrRef>;
  readonly deps: ForgeDeps;
  readonly cwd: string;
}
export function createForgeReadProvider(binding: ForgeReadBinding): ToolProvider;
export function forgeReadProviderForUrl(url: string, deps: ForgeDeps, cwd: string): ToolProvider;
/** The test seam: every forge call the tools make goes through these fields. */
export const _forgeToolsDeps: {
  resolvePrRef: typeof resolvePrRef;
  readPrInfo: typeof readPrInfo;
  listHeadChecks: typeof listHeadChecks;
  readJobLog: typeof readJobLog;
  listReviewThreads: typeof listReviewThreads;
  listPrComments: typeof listPrComments;
  hasWriteAccess: typeof hasWriteAccess;
};
export interface ToolResultParts {
  readonly header: readonly string[];
  readonly entries: readonly string[];
  readonly footer: readonly string[];
}
export function fitToolResult(parts: ToolResultParts, maxBytes: number, keep: "start" | "end"): string;
export const FORGE_LOG_DEFAULT_LINES = 200;
export const FORGE_LOG_MAX_LINES = 500;
export const FORGE_LOG_MAX_MATCHES = 50;
export const FORGE_LOG_LINE_CHARS = 1_000;
export const FORGE_COMMENT_CHARS = 2_000;
export const FORGE_MAX_THREADS = 50;
export const FORGE_MAX_COMMENTS = 50;
```

`fitToolResult` renders the header lines, then the entries joined by newlines inside one `markdownFence`
block, then the footer lines. `src/prompts/builders/forge-read-builder.ts` exports
`buildForgeReadInstructions(): string`, exported from `src/prompts/index.ts`; the provider's `instructions()`
returns it.

### Tool contracts

Every tool takes the bound PR from `resolveRef`, which the provider calls at most once per successful
resolution (a rejected resolution is retried on the next call). Every input is validated before mode selection
and before any forge call.

| Tool | Input | Output |
|---|---|---|
| `pr` | none | number, state, draft flag, base ref, head ref, head sha, URL and title |
| `checks` | none | one line per check of the PR's current head: id, name, status, the conclusion when completed, and the URL when present |
| `log` | `check` (string of digits, or an integer, required), `search` (non-empty string), `from` (integer >= 1), `lines` (integer 1..500, default 200) | a header naming the check, its status and a `showing lines <x>-<y> of <n>` line; then the numbered log lines |
| `threads` | `includeResolved` (boolean, default false) | per review thread: location, resolved/outdated flags, writer comments (author + body) |
| `comments` | none | top-level PR comments and review bodies by writers: the `FORGE_MAX_COMMENTS` with the latest `createdAt`, oldest first (author + body) |

`log` modes compose in this order: `search` present selects search mode (case-insensitive literal substring,
no regex; `from` and `lines` are ignored); otherwise `from` present selects page mode (`lines` lines from
`from`); otherwise tail mode (the last `lines` lines). The log's lines are its text split on newline, with one
empty final element after a trailing newline not counted. Search mode returns at most `FORGE_LOG_MAX_MATCHES`
matching lines plus a `<shown> of <total> matches` line. Every emitted log line is prefixed with its 1-based
line number and cut to `FORGE_LOG_LINE_CHARS` characters. The `check` must be the id of a check in
`listHeadChecks` for the PR's current head sha. A completed check's log text is read once per provider and
reused; a check that is not completed is read on every call. The tail view fits to `maxBytes` with
`keep: "end"`; the page and search views with `keep: "start"`.

`threads` and `comments` footers come after the fence, in this order: the not-shown line (`<k> more
thread(s) not shown`, or `<k> earlier comment(s) not shown`) when any were not shown, then `withheld <n>
comment(s) from authors without write access` when `n` is above zero. The withheld count covers every
non-writer comment the tool read (for `threads`, across every thread that passed the resolved filter, shown
or not), because the writer filter runs before the display cap.

### Failure Handling

| Failure | Behaviour |
|---|---|
| `gh api` exits non-zero with stderr naming `--allow-escape-sequences` as an unknown flag | `readJobLog` runs the same argv once without the flag and uses that result |
| Job log read fails for any other reason (including a subprocess timeout) | `readJobLog` returns `{ ok: false, reason }`; the excerpt is `(log unavailable: <reason>)` and `FailedCheck.logUnavailable` is `true` |
| Every failed check of a CI repair read has `logUnavailable` | no CI repair round; ledger note `CI repair skipped: no failed check's log could be read (<names>)` |
| GitHub CI wait sees a failed check while others are pending | keeps polling under the failing-poll rules; `failed` at the deadline or at the error-poll limit once a failing poll was observed |
| `resolveRef` rejects, or the bound URL carries no PR number | the tool returns `isError` naming the reason; no other forge call |
| A forge read inside a tool throws | the tool returns `isError` with the first non-empty line of the error's message, redacted |
| `log` names a check that is not a check of the PR's head | `isError` naming the id and pointing to `nax-forge__checks`; no log read |
| `log` names a check with no job log (a non-Actions GitHub check) | `isError` saying the check has no job log |
| `log` or `threads` input invalid (wrong type, out of range, empty `search`, missing `check`) | `isError` naming the field; no forge call |
| `hasWriteAccess` throws for a login | that login's comments are withheld (fail closed); one `forge-tools` warning per login |
| The session's permission profile has `providerScope` `"none"` (`safe`) | the provider is not resolved; the session has no forge tools |

## Out of Scope

- Forge writes are not tools: creating or editing PRs, posting or editing comments, replying to or resolving threads, and marking a PR ready stay with nax's own workflow and bot steps.
- ACP agents with no pre-approval channel (codex, opencode, gemini, cursor, pi) get no forge tools; they rely on the CI excerpt in their brief.
- Permission profiles are unchanged: `safe` gets no forge tools, and `scoped` gets them only when the stage's rules carry an `Mcp(nax-forge)` allow rule; no default rule is added.
- Bot review sessions, workflow implementer, story review, branch review and branch fix sessions outside the CI repair round are not bound to the provider.
- The `pr` tool does not return the PR description body.
- The `log` tool does not read the output text of non-Actions GitHub checks; that text stays in the CI repair excerpt.
- Log search is a literal substring match; regular expressions are not supported.
- Logs or checks of any head, PR or repository other than the bound PR's current head are not readable.
- Check listings read one page: at most 100 GitHub check runs or 100 GitLab jobs of the head's pipeline.
- Job log reads use the forge module's default subprocess timeout; no separate log-read timeout is added.
- The GitLab CI wait is unchanged; a GitLab pipeline reports `failed` only once it has finished.
- `readChecksOnce`, the bot's one-shot CI read, is unchanged.
- A configured MCP server whose id is `nax-forge` is not detected as a collision.
- Excerpt anchoring on language- or tool-specific failure markers (for example a test runner's fail lines) is not done; only GitHub Actions `##[error]` annotations lead the excerpt.
- A skipped CI repair is not retried later in the same run.
- User documentation of the forge tools is a manual follow-up after merge.

## Stories

Twelve stories in `packages/nax`, kept as one feature by the user's ruling (2026-10-22): the CI-log fixes
and the read tools ship together because the tools' first consumer is the CI repair round those fixes feed,
and the `log` tool reads through `readJobLog`. US-003 keeps the wait change and the repair skip together:
both decide what the CI repair round gets, and each is small.

### US-001: Job logs are read through the jobs API
No dependencies. Workdir: packages/nax.

Adds `readJobLog` and `stripAnsi`'s new home, switches both forges' CI repair excerpts to it, and adds
`FailedCheck.logUnavailable`.

### US-002: The GitHub Actions excerpt leads with error annotations
Depends on US-001. Workdir: packages/nax.

Builds the annotation block and the tail block for GitHub Actions jobs.

### US-003: The GitHub CI wait settles, and a repair needs a readable log
Depends on US-001. Workdir: packages/nax.

`waitForChecks` follows the failing-poll rules for GitHub; the CI repair decision skips a round whose every
failed log is unreadable.

### US-004: Head check listing
No dependencies. Workdir: packages/nax.

Adds `listHeadChecks` for both forges, reusing the exported `readCiListing` and `asRecord`.

### US-005: The nax-forge provider core
Depends on US-001, US-004. Workdir: packages/nax.

Adds `src/forge-tools/` with the provider, its binding, `_forgeToolsDeps`, `fitToolResult`, the PR
resolution rules and the instructions builder.

### US-006: The pr and checks tools
Depends on US-005. Workdir: packages/nax.

Adds the `pr` and `checks` tools.

### US-007: The log tool reads a check of the PR's head
Depends on US-001, US-005. Workdir: packages/nax.

Adds the `log` tool's input validation, its check validation against the head's checks, the log read, the
per-provider log cache, and the tail view.

### US-008: The log tool's page and search views
Depends on US-007. Workdir: packages/nax.

Adds the page (`from`) and search (`search`) views, their composition order, line numbering, line cut and
fencing.

### US-009: Writer-only threads tool, with writerCheck in the forge module
Depends on US-005. Workdir: packages/nax.

Moves `writerCheck` into `src/forge/access.ts` with a re-export from `src/bot/writers.ts` (a relocation with
no behaviour change for the bot) and adds the `threads` tool on top of it.

### US-010: Writer-only comments tool
Depends on US-009. Workdir: packages/nax.

Adds the `comments` tool.

### US-011: Call-scoped tool providers reach the session
Depends on US-005. Workdir: packages/nax.

Adds `CallContext.toolProviders`, its merge in `buildRunDispatchOptions`, and `runBranchFix`'s
`toolProviders`, and proves the provider reaches native and ACP Claude tool support.

### US-012: Repair sessions are bound to their PR
Depends on US-003, US-006, US-008, US-010, US-011. Workdir: packages/nax.

Binds the workflow CI repair to the published PR URL and the bot fix and repair to the bot's `PrRef`.

### Context Files

**US-001**
- `packages/nax/src/forge/ci-failures.ts` — `readExcerpt`, `readGitlabExcerpt`, `excerptOf`, `logUnavailableExcerpt`, `stripAnsi`, `FailedCheck`
- `packages/nax/src/forge/deps.ts` — `defaultRun`, the subprocess contract and its timeout stderr line
- `packages/nax/src/forge/index.ts` — the forge barrel
- `packages/nax/test/unit/forge/ci-failures.test.ts` — `githubFixture` and the GitHub excerpt cases
- `packages/nax/test/unit/forge/ci-failures-gitlab.test.ts` — the GitLab excerpt fixtures and `ghJobLog`

**US-002**
- `packages/nax/src/forge/ci-failures.ts` — `readExcerpt`, `ciExcerpt`
- `packages/nax/src/forge/job-log.ts` — created by US-001, holds the annotation constants
- `packages/nax/test/unit/forge/ci-failures.test.ts` — `githubFixture`

**US-003**
- `packages/nax/src/workflow/ci-wait.ts` — `classifyGh`, `githubWaiting`, `terminalPoll`, `errorRun`, `checkHistory`, `waitForChecks`
- `packages/nax/src/workflow/feature-steps.ts` — `readCiFailuresForRepair`, `ciRepairDecision`
- `packages/nax/test/unit/workflow/ci-wait.test.ts` — the scripted `gh pr checks` polls and `OPTS`
- `packages/nax/test/unit/workflow/feature-steps-ci-repair-decision.test.ts` — the decision harness
- `packages/nax/src/forge/ci-failures.ts` — `FailedCheck.logUnavailable`, added by US-001

**US-004**
- `packages/nax/src/forge/ci-failures.ts` — `readCiListing`, `asRecord`, the check-runs and pipelines reads to mirror
- `packages/nax/src/forge/pr-read.ts` — `encodeProjectPath`
- `packages/nax/test/unit/forge/ci-failures-gitlab.test.ts` — the pipelines and jobs reply shapes

**US-005**
- `packages/nax-agent/src/tools/provider-types.ts` — `ToolProvider`, `ProviderTool`
- `packages/nax-agent/src/tools/registry.ts` — `ToolResult`, `ToolRunContext`
- `packages/nax/src/forge/pr-read.ts` — `readPrInfo`, `resolvePrRef`
- `packages/nax/src/forge/ci-failures.ts` — `prNumberFromUrl`
- `packages/nax/src/utils/markdown-fence.ts` — `markdownFence`

**US-006**
- `packages/nax/src/forge-tools/provider.ts` — created by US-005, extended here
- `packages/nax/src/forge/checks-read.ts` — created by US-004, called by the `checks` tool
- `packages/nax/src/forge/pr-types.ts` — `PrInfo`

**US-007**
- `packages/nax/src/forge/job-log.ts` — created by US-001, called by the `log` tool
- `packages/nax/src/forge/checks-read.ts` — created by US-004, the `log` tool's check validation
- `packages/nax/src/forge-tools/provider.ts` — created by US-005, extended here

**US-008**
- `packages/nax/src/forge-tools/log-tool.ts` — created by US-007, extended here
- `packages/nax/src/utils/markdown-fence.ts` — `markdownFence`

**US-009**
- `packages/nax/src/forge/threads.ts` — `listReviewThreads`
- `packages/nax/src/forge/access.ts` — `hasWriteAccess`
- `packages/nax/src/bot/writers.ts` — `writerCheck`, `WriterCheck`, `readWriters`
- `packages/nax/src/bot/index.ts` — the bot barrel's `writerCheck` export
- `packages/nax/src/forge-tools/provider.ts` — created by US-005, extended here

**US-010**
- `packages/nax/src/forge/threads.ts` — `listPrComments`
- `packages/nax/src/forge/pr-types.ts` — `PrComment`
- `packages/nax/src/forge-tools/thread-tools.ts` — created by US-009, the shared writer filter and comment rendering

**US-011**
- `packages/nax/src/operations/types.ts` — `CallContext`
- `packages/nax/src/operations/call-run-options.ts` — `runtimeDispatchFields`, `buildRunDispatchOptions`
- `packages/nax/src/workflow/branch-fix.ts` — `runBranchFix`, `runFixSession`
- `packages/nax/src/agents/coding-tool-support-resolve.ts` — `resolveCodingToolSupport`, `resolveProviderContribution`
- `packages/nax/src/agents/tool-surface.ts` — `attachAcpDelivery`, `resolveProviderSurface`

**US-012**
- `packages/nax/src/workflow/feature-steps.ts` — `ciRepairStep`, `branchFixStep`
- `packages/nax/src/workflow/feature-machine.ts` — `FeatureSteps.branchFix`
- `packages/nax/src/workflow/feature-env.ts` — `buildFeatureEnv`'s `branchFix`
- `packages/nax/src/bot/fix-steps.ts` — `fixStep`, `BotFixEnv`, `_fixStepsDeps`
- `packages/nax/src/bot/repair-step.ts` — `repairStep`

### Creates

**US-001**
- `packages/nax/src/forge/job-log.ts`

**US-004**
- `packages/nax/src/forge/checks-read.ts`

**US-005**
- `packages/nax/src/forge-tools/index.ts`
- `packages/nax/src/forge-tools/provider.ts`
- `packages/nax/src/forge-tools/fit-result.ts`
- `packages/nax/src/prompts/builders/forge-read-builder.ts`

**US-006**
- `packages/nax/src/forge-tools/pr-tools.ts`

**US-007**
- `packages/nax/src/forge-tools/log-tool.ts`

**US-008**
- `packages/nax/src/forge-tools/log-view.ts`

**US-009**
- `packages/nax/src/forge-tools/thread-tools.ts`

**US-010**
- `packages/nax/src/forge-tools/comment-tools.ts`

### Modifies

**US-001**
- `packages/nax/test/unit/forge/ci-failures.test.ts` — the GitHub Actions log read expects the second forge call to be the gh run view argv for job 991 with the log-failed flag and repo github.com/o/r; it becomes the gh api argv with the allow-escape-sequences flag, hostname github.com and endpoint repos/o/r/actions/jobs/991/logs. Its githubFixture helper answers every gh api call with the check-runs listing and reads the job id after a job flag; it becomes: a gh api call whose endpoint ends with the actions jobs logs path for a job id answers from the logs map for that id, every other gh api call answers with the listing. The invariant that a failed Actions check's excerpt is built from that job's own log (AC-15 and its neighbours) is unchanged.
- `packages/nax/test/unit/forge/ci-failures-gitlab.test.ts` — its ghJobLog helper, the key that scripts the GitHub job-log reply for jobs 991 and 992, joins the gh run view argv with the log-failed flag and repo github.com/o/r; it becomes the gh api argv with the allow-escape-sequences flag, hostname github.com and endpoint repos/o/r/actions/jobs/<id>/logs, joined the same way. The scripted replies and every expected excerpt are unchanged.

**US-012**
- `packages/nax/test/integration/bot/fix-check-steps.test.ts` — "AC-1 forwards both agreed items through toFixFindings" and "AC-2 resolves fix model with override" expect `runBranchFix` to be called with exactly `{ findings, model, prompt }`; each expected input gains `toolProviders: [expect.objectContaining({ id: "nax-forge" })]`. Findings, model and prompt are unchanged.
- `packages/nax/test/integration/bot/repair-step.test.ts` — "AC-8/9/10 builds repair prompt with every tail and increments round" expects `runBranchFix` to be called with exactly `{ findings: [], model: undefined, prompt }`; the expected input gains `toolProviders: [expect.objectContaining({ id: "nax-forge" })]`. Findings, model and prompt are unchanged.

### Seams

- US-001 → US-002, US-003, US-007: `readJobLog` (US-001) is what the annotation excerpt (US-002) reads through
  and what the `log` tool (US-007) calls; `FailedCheck.logUnavailable` (US-001) is what the CI repair decision
  (US-003) reads.
- US-004 → US-006, US-007: `listHeadChecks` is what the `checks` tool lists and `log` validates against.
- US-005 → US-006, US-007, US-009, US-010, US-011: `createForgeReadProvider`, `_forgeToolsDeps` and
  `fitToolResult` are what every tool builds on, and the provider US-011 proves reaches tool support.
- US-009 → US-010: `writerCheck` (in `@/forge`) and the comment rendering in `thread-tools.ts` are what the
  `comments` tool reuses.
- US-011 → US-012: `CallContext.toolProviders` and `runBranchFix`'s `toolProviders` are what the bindings
  fill. US-012's seam ACs enter at `ciRepairStep`, at `buildFeatureEnv(...).steps.branchFix`, at `fixStep`
  and at `repairStep`.

## Acceptance Criteria

### US-001

- [unit] `readJobLog` for a GitHub `PrRef` (host `github.com`, repo `o/r`) and check id `"991"` calls `deps.run` with `["gh", "api", "--allow-escape-sequences", "--hostname", "github.com", "repos/o/r/actions/jobs/991/logs"]`.
- [unit] When that call exits 0 with stdout starting with a byte-order mark, the `text` that `readJobLog` returns does not start with the byte-order mark.
- [unit] When that call exits 0 with stdout holding the ANSI colour code `ESC[31m`, the returned `text` holds no `ESC[31m` sequence.
- [unit] When the log holds `postgres://user:synthetic_password_123@db` on its last line, the returned `text` holds `[REDACTED]` in place of `synthetic_password_123`.
- [unit] When the first call exits 1 with stderr `unknown flag: --allow-escape-sequences`, `readJobLog` makes a second call with the same argv minus `--allow-escape-sequences` and returns that call's stdout as `text`.
- [unit] When the first call exits 1 with stderr `boom\nmore`, `readJobLog` returns `{ ok: false, reason: "boom" }` without a second call.
- [unit] When the call exits 124 with stderr `\n[forge] command killed after 30000ms timeout`, the `reason` `readJobLog` returns is `[forge] command killed after 30000ms timeout`.
- [unit] When the call exits 1 with empty stderr, `readJobLog` returns `{ ok: false, reason: "unknown" }`.
- [unit] `readJobLog` for a GitLab `PrRef` (host `gitlab.com`, repo `g/p`) and check id `"55"` calls `deps.run` with `["glab", "api", "--hostname", "gitlab.com", "projects/g%2Fp/jobs/55/trace"]`.
- [unit] `stripAnsi` is importable from `@/forge` and returns `red` for the input `ESC[31mredESC[0m`.
- [unit] `readFailedChecks` for a GitHub PR whose failed check run 991 belongs to the `github-actions` app reads that check's log with the `repos/o/r/actions/jobs/991/logs` argv and never with a `gh run view` argv.
- [unit] A failed GitHub Actions check whose log read exits 1 with stderr `boom` has excerpt `(log unavailable: boom)` and `logUnavailable` `true`.
- [unit] A failed GitHub Actions check whose log is readable has no `logUnavailable` field.
- [unit] A failed GitLab job whose trace read exits 1 with stderr `boom` has excerpt `(log unavailable: boom)` and `logUnavailable` `true`.

### US-002

- [unit] For a GitHub Actions log of 3 000 lines whose line 1 500 is `2026-10-22T13:21:21.2513942Z ##[error]command (apps/runner) bun run test exited (1)`, the failed check's excerpt starts with the line `GitHub Actions error annotations:` followed by that timestamped line.
- [unit] For the same log, the excerpt holds a `Log tail:` line after the annotation block, followed later by the log's last non-empty line.
- [unit] For a GitHub Actions log with no line containing `##[error]`, the failed check's excerpt equals `ciExcerpt(log)`.
- [unit] For a log with 30 lines containing `##[error]`, the annotation block holds the first 20 (`CI_ANNOTATION_LINES`) in log order and not the 21st.
- [unit] For a log whose 20 annotation lines are 300 characters each, the annotation block, header line included, is at most `CI_ANNOTATION_CHARS` characters and ends with a whole annotation line.
- [unit] For a log whose only annotation line is 5 000 characters, the annotation block is at most `CI_ANNOTATION_CHARS` characters.
- [unit] For a log with annotations and 20 000 characters of tail text, the whole excerpt is at most `CI_EXCERPT_CHARS` characters.
- [unit] For that same log, which ends with a newline, the excerpt's last non-empty line is the log's last non-empty line.
- [unit] A failed GitLab job whose trace holds a line containing `##[error]` has an excerpt equal to `ciExcerpt(trace)`.

### US-003

- [unit] `waitForChecks("github", ...)` scripted with a first poll of buckets `fail` and `pending` and a second poll of `fail` and `pass` returns outcome `failed`.
- [unit] In that scripted wait, `gh pr checks` runs twice.
- [unit] A failing poll (buckets `fail` and `pending`) on a PR whose mergeability read would report a conflict makes no mergeability (`gh pr view`) call.
- [unit] `waitForChecks("github", ...)` scripted with a first poll of `fail` and `pending` and a second poll of `pass` and `pass` returns outcome `green`.
- [unit] `waitForChecks("github", ...)` scripted so every poll reports buckets `fail` and `pending` until the deadline returns outcome `failed` with a detail that holds `still pending`.
- [unit] `waitForChecks("github", ...)` scripted with one failing poll followed by `CI_ERROR_POLL_LIMIT` polls whose `gh pr checks` call exits 4 returns outcome `failed`.
- [unit] `waitForChecks("github", ...)` scripted with `CI_ERROR_POLL_LIMIT` polls whose `gh pr checks` call exits 4 and no failing poll returns outcome `unavailable`.
- [unit] `waitForChecks("github", ...)` scripted with one poll of buckets `pass` and `fail` returns outcome `failed` after a single `gh pr checks` call.
- [unit] While a failing poll waits on pending checks, `waitForChecks` logs the progress line `CI checks: 0/2 passed, 1 pending, failing: test` for buckets `fail` (named `test`) and `pending`.
- [unit] `readChecksOnce("github", ...)` with buckets `fail` and `pending` returns outcome `failed`.
- [unit] `ciRepairDecision` for a draft PR whose CI failed, with the reader returning checks `e2e` and `lint` that both have `logUnavailable` `true`, returns `undefined`.
- [unit] In that case the ledger holds the note `CI repair skipped: no failed check's log could be read (e2e, lint)`.
- [unit] `ciRepairDecision` with the reader returning one check with `logUnavailable` `true` and one readable check returns two repair findings, one per check.

### US-004

- [unit] `listHeadChecks` for a GitHub `PrRef` and head `abc123` calls `deps.run` with `["gh", "api", "--hostname", "github.com", "repos/o/r/commits/abc123/check-runs?per_page=100&filter=latest"]`.
- [unit] A completed GitHub check run `{ id: 7, name: "test", status: "completed", conclusion: "failure", html_url: "u", app: { slug: "github-actions" } }` is listed as `{ id: "7", name: "test", status: "completed", conclusion: "failure", url: "u", hasJobLog: true }`.
- [unit] A GitHub check run with `status` `in_progress` and `conclusion` null is listed with status `in_progress` and no `conclusion` field.
- [unit] A GitHub check run with `status` `waiting` is listed with status `queued`.
- [unit] A GitHub check run with an unrecognised `status` `stalled` is listed with status `queued`.
- [unit] A GitHub check run with `status` `completed` and `conclusion` null is listed with conclusion `unknown`.
- [unit] A GitHub check run from an app other than `github-actions` is listed with `hasJobLog` `false`.
- [unit] A GitHub check run with no numeric `id` is not listed.
- [unit] When the check-runs call exits 1, `listHeadChecks` rejects with a `NaxError` whose code is `FORGE_CI_READ_FAILED`.
- [unit] `listHeadChecks` for a GitLab `PrRef` whose merge request pipelines reply holds pipeline 9 for head `abc123` reads `projects/g%2Fp/pipelines/9/jobs?per_page=100` with no `scope` filter.
- [unit] In that GitLab listing, a `running` job is listed with status `in_progress` and `hasJobLog` `true`.
- [unit] In that GitLab listing, a `waiting_for_resource` job is listed with status `queued`.
- [unit] In that GitLab listing, a `canceled` job is listed with status `completed` and conclusion `canceled`.
- [unit] `listHeadChecks` for a GitLab merge request with no pipeline for the head returns an empty list.
- [unit] When the GitLab jobs call exits 1, `listHeadChecks` rejects with a `NaxError` whose code is `FORGE_CI_READ_FAILED`.

### US-005

- [unit] `createForgeReadProvider(binding)` returns a provider whose `id` is `FORGE_READ_PROVIDER_ID` (`"nax-forge"`).
- [unit] That provider's `kind` is `"static"` and its `stages` is `["*"]`.
- [unit] The provider's `instructions(root)` resolves to `buildForgeReadInstructions()`, and that string names `nax-forge__checks`, `nax-forge__log`, `nax-forge__threads` and `nax-forge__comments`.
- [unit] Two tool calls on one provider call `resolveRef` once.
- [unit] When `resolveRef` rejects with `boom`, a tool call returns `isError` with content holding `boom`.
- [unit] After `resolveRef` rejected once, the next tool call calls `resolveRef` again.
- [unit] A tool of `forgeReadProviderForUrl("https://github.com/o/r/pull/7", deps, "/repo")` calls `_forgeToolsDeps.resolvePrRef` with `7`, that `deps` and `"/repo"`.
- [unit] A tool of `forgeReadProviderForUrl("https://example.com/no-number", deps, cwd)` returns `isError` naming that URL and never calls `_forgeToolsDeps.resolvePrRef`.
- [unit] `fitToolResult` for parts that fit `maxBytes` returns the header lines, a `markdownFence` block of the entries, and the footer lines, in that order.
- [unit] `fitToolResult` for ten 100-byte entries with `maxBytes` 600 and `keep` `"start"` returns a result of at most 600 UTF-8 bytes that holds the first entry, not the tenth, and ends with a `[truncated: <k> entries not shown]` line.
- [unit] `fitToolResult` for the same parts with `keep` `"end"` returns a result that holds the tenth entry and not the first.
- [unit] A `fitToolResult` result that dropped entries still holds the closing fence and every footer line.
- [unit] `fitToolResult` for a single entry of 1 000 three-byte characters with `maxBytes` 600 returns at most 600 UTF-8 bytes and holds no broken multi-byte character.

### US-006

- [unit] `resolveProviderTools([createForgeReadProvider(binding)], "run", root)` advertises tools that include `nax-forge__pr` and `nax-forge__checks`.
- [unit] The `pr` tool calls `_forgeToolsDeps.readPrInfo` with the `PrRef` that `resolveRef` returned.
- [unit] The `pr` tool, with `_forgeToolsDeps.readPrInfo` stubbed with a PR whose head sha is `abc123`, returns a result without `isError` whose content holds `abc123`.
- [unit] The `pr` tool's content holds the PR title inside a `markdownFence` block, so a title holding a triple-backtick run stays inside the fence.
- [integration] The `checks` tool calls `_forgeToolsDeps.listHeadChecks` with the bound `PrRef` and the head sha that `_forgeToolsDeps.readPrInfo` returned.
- [unit] The `checks` tool's content shows, for each returned check, its id, name and status inside a `markdownFence` block.
- [unit] The `checks` tool's line for a completed check with conclusion `failure` holds `failure`.
- [unit] The `checks` tool's line for a check with `url` `https://ci/7` holds `https://ci/7`.
- [unit] When `_forgeToolsDeps.listHeadChecks` throws an error whose message is `\nboom\nmore`, the `checks` tool resolves to `isError` with content `boom` instead of rejecting.
- [unit] When `_forgeToolsDeps.listHeadChecks` throws an error whose message holds `ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`, the `checks` tool's `isError` content does not hold that token.

### US-007

- [unit] `resolveProviderTools([createForgeReadProvider(binding)], "run", root)` advertises tools that include `nax-forge__log`.
- [unit] The `log` tool with `check` `"99"` when the head's checks are ids `7` and `8` returns `isError` naming `99` and `nax-forge__checks`.
- [unit] That rejected `log` call never calls `_forgeToolsDeps.readJobLog`.
- [unit] The `log` tool with the id of a check whose `hasJobLog` is `false` returns `isError` saying that check has no job log.
- [integration] The `log` tool with a valid check id calls `_forgeToolsDeps.readJobLog` with the bound `PrRef` and that check id.
- [unit] The `log` tool given `check` as the integer `7` reads the log of check `"7"`.
- [unit] The `log` tool on a 1 000-line log with neither `search` nor `from` returns lines 801 to 1000, each prefixed with its 1-based line number.
- [unit] That tail result holds the line `showing lines 801-1000 of 1000` outside the fence.
- [unit] The `log` tool on a log of 3 lines that ends with a newline reports `of 3` in its showing line.
- [unit] A tail result that does not fit `maxBytes` keeps the log's last line and drops lines from the start.
- [unit] The `log` tool with `lines` 501 returns `isError` naming `lines`.
- [unit] The `log` tool with no `check` returns `isError` naming `check`.
- [unit] A `log` call rejected for invalid input makes no `deps.run` call.
- [unit] The `log` tool for a check whose status is `in_progress` returns content holding `job still running: this log is partial`.
- [unit] When `_forgeToolsDeps.readJobLog` returns `{ ok: false, reason: "gone" }`, the `log` tool returns `isError` holding `gone`.
- [unit] Two `log` calls for the same completed check call `_forgeToolsDeps.readJobLog` once.
- [unit] Two `log` calls for the same `in_progress` check call `_forgeToolsDeps.readJobLog` twice.

### US-008

- [unit] The `log` tool with `from` 10 and `lines` 5 returns lines 10 to 14.
- [unit] The `log` tool with `from` 50 on a 10-line log returns no numbered lines and the line `showing lines 0-0 of 10`.
- [unit] The `log` tool with `search` `(FAIL)` returns the line `(fail) x` with its line number, matching case-insensitively and treating the parentheses literally.
- [unit] The `log` tool with a `search` that matches 70 lines returns the first 50 matches and the line `50 of 70 matches`.
- [unit] The `log` tool given both `search` and `from` returns search-mode output.
- [unit] The `log` tool given `search` and `lines` 3, on a log with 10 matches, returns 10 matches.
- [unit] The `log` tool with `from` 2.5 returns `isError` naming `from`, also when `search` is given.
- [unit] The `log` tool with an empty `search` returns `isError` naming `search`.
- [unit] The `log` tool cuts a 5 000-character log line to `FORGE_LOG_LINE_CHARS` characters.
- [unit] The `log` tool's numbered lines sit inside a `markdownFence` block, so a log line holding a triple-backtick run stays inside the fence.
- [unit] A page result that does not fit `maxBytes` keeps the page's first line and drops lines from the end.

### US-009

- [unit] `writerCheck` is importable from `@/forge`, and two calls for the same login call the injected `hasWriteAccess` stub once.
- [unit] `writerCheck` from `@/forge`, given a `hasWriteAccess` stub that throws for login `x`, resolves `false` for `x` and calls the warn sink once with `x`.
- [unit] The `writerCheck` exported from `@/bot` is the same function as the one exported from `@/forge`.
- [unit] `resolveProviderTools([createForgeReadProvider(binding)], "run", root)` advertises tools that include `nax-forge__threads`.
- [integration] The `threads` tool calls `_forgeToolsDeps.listReviewThreads` with the bound `PrRef`.
- [unit] The `threads` tool with no input lists only threads whose `resolved` is `false`.
- [unit] The `threads` tool with `includeResolved` `true` also lists resolved threads, each marked resolved.
- [unit] The `threads` tool shows a writer's comment with its author and body and omits a non-writer's comment.
- [unit] With one non-writer comment, the `threads` tool's footer holds `withheld 1 comment(s) from authors without write access`.
- [unit] With no non-writer comment, the `threads` tool's result holds no `withheld` line.
- [unit] Across threads holding three comments by the same login, the `threads` tool calls `_forgeToolsDeps.hasWriteAccess` once for that login.
- [unit] For a GitLab `PrRef`, the `threads` tool calls `_forgeToolsDeps.hasWriteAccess` with `{ login, id }` taken from the comment's `author` and `authorId`.
- [unit] When `_forgeToolsDeps.hasWriteAccess` throws for login `x`, the `threads` tool withholds `x`'s comments and logs one `forge-tools` warning naming `x`.
- [unit] A thread comment body longer than `FORGE_COMMENT_CHARS` characters is cut to `FORGE_COMMENT_CHARS` characters.
- [unit] The `threads` tool's comment bodies sit inside a `markdownFence` block, so a body holding a triple-backtick run stays inside the fence.
- [unit] With 60 unresolved threads, one non-writer comment in thread 55, the `threads` tool lists the first 50 (`FORGE_MAX_THREADS`) and its footer holds `10 more thread(s) not shown` followed by `withheld 1 comment(s) from authors without write access`.
- [unit] A thread whose every comment is withheld is listed with its location and `(no comments from writers)`.
- [unit] The `threads` tool with `includeResolved` set to a string returns `isError` naming `includeResolved`.

### US-010

- [unit] `resolveProviderTools([createForgeReadProvider(binding)], "run", root)` advertises tools that include `nax-forge__comments`.
- [integration] The `comments` tool calls `_forgeToolsDeps.listPrComments` with the bound `PrRef`.
- [unit] The `comments` tool shows a writer's comment and a writer's review body (`kind` `"review"`) with their authors.
- [unit] The `comments` tool omits a non-writer's comment and its footer holds `withheld 1 comment(s) from authors without write access`.
- [unit] With 70 writer comments the `comments` tool shows the 50 (`FORGE_MAX_COMMENTS`) with the latest `createdAt`, oldest first.
- [unit] In that case its footer holds `20 earlier comment(s) not shown`.
- [unit] A comment body longer than `FORGE_COMMENT_CHARS` characters is cut to `FORGE_COMMENT_CHARS` characters in the `comments` result.
- [unit] The `comments` tool's bodies sit inside a `markdownFence` block, so a body holding a triple-backtick run stays inside the fence.
- [unit] When `_forgeToolsDeps.hasWriteAccess` throws for login `x`, the `comments` tool withholds `x`'s comments.
- [unit] When `_forgeToolsDeps.listPrComments` throws, the `comments` tool resolves to `isError` instead of rejecting.

### US-011

- [unit] `buildRunDispatchOptions` with runtime `toolProviders` `[A]` and a call context whose `toolProviders` is `[B]` returns `providers` `[A, B]` in that order.
- [unit] `buildRunDispatchOptions` with runtime `toolProviders` `[]` and call-context `toolProviders` `[B]` returns `providers` `[B]`.
- [unit] `buildRunDispatchOptions` with both lists empty or absent returns options with no `providers` field.
- [unit] `runBranchFix` with `toolProviders` `[P]` calls `_workflowDeps.callOp` with a call context whose `toolProviders` is `[P]` and whose other fields equal `fc.callCtx`'s.
- [unit] `runBranchFix` with no `toolProviders` calls `_workflowDeps.callOp` with `fc.callCtx` itself (same object).
- [integration] `resolveCodingToolSupport` for a run-kind dispatch whose `providers` hold a `nax-forge` provider, under permission profile `unrestricted`, returns support whose advertised tools include `nax-forge__pr`.
- [integration] For the same dispatch, the support's `acpDelivery.tools` include a tool named `nax-forge__pr`.
- [integration] `resolveCodingToolSupport` for the same dispatch under permission profile `safe` advertises no tool whose name starts with `nax-forge__`.

### US-012

- [unit] `ciRepairStep` on a record with `url` `https://github.com/o/r/pull/7` and one CI finding calls `env.steps.branchFix` with that finding and `{ prUrl: "https://github.com/o/r/pull/7" }`.
- [unit] `branchFixStep` calls `env.steps.branchFix` with its findings and no second argument.
- [integration] `buildFeatureEnv(...).steps.branchFix(findings, { prUrl: "https://github.com/o/r/pull/7" })`, with `_workflowDeps.callOp` scripted, calls `callOp` with a call context whose `toolProviders` holds exactly one provider with id `nax-forge`.
- [integration] Calling that provider's `pr` tool calls `_forgeToolsDeps.resolvePrRef` with `7`, the `_featureDeps.forge` instance and `fc.projectDir`.
- [integration] `buildFeatureEnv(...).steps.branchFix(findings)` with no options calls `callOp` with a call context that has no `toolProviders`.
- [integration] `fixStep` with agreed items calls `_fixStepsDeps.runBranchFix` with `toolProviders` holding one provider with id `nax-forge`.
- [integration] The `pr` tool of the provider `fixStep` attaches calls `_forgeToolsDeps.readPrInfo` with `env.ref` and `env.forge`.
- [integration] `repairStep` on a red-gate round calls `_fixStepsDeps.runBranchFix` with `toolProviders` holding one provider with id `nax-forge`.
