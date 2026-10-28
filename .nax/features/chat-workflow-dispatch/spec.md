# SPEC: chat-workflow-dispatch — the chat session starts nax plan, run and bot jobs in the background

## Summary

`nax chat` gains a second workflow provider, `nax-jobs`. It lets the session start the billed nax
commands as background jobs, list them and cancel them:

- `nax-jobs__plan`, `nax-jobs__run`, `nax-jobs__bot_review`, `nax-jobs__bot_fix` start
  `nax plan`, `nax run`, `nax bot review` and `nax bot fix` as detached child processes of the
  same nax the user is chatting with;
- `nax-jobs__list` lists this repo's jobs, or shows one job with its log tail;
- `nax-jobs__cancel` stops a running job.

Every launch and every cancel shows an approval card first, in full mode as well as guarded mode.
The card cannot be remembered for the session, and a timeout is a deny.

Each job has a record on disk. Its outcome comes from the command's own records, never from the
exit code alone. When a job ends, the host queues one notice, and the screen starts a turn with it
when the session is idle. While a `run` or `plan` job holds the checkout, the session's Write,
Edit, Delete and GitCommit tools refuse. The footer shows the running jobs, and a `/jobs` command
lists every job without a model call. Closing the chat with a
job it started still running asks once whether to cancel it or keep it running.

This is feature 2 of 3 of slice 2 (design
`docs/superpowers/specs/2026-10-27-nax-chat-workflow-dispatch-slice2-design.md`, sections 4.1 and
4.3 to 4.6, 4.8). Feature 1, `chat-workflow-state`, shipped the read-only `nax-workflow__state`
tool (#2722). Feature 3, `chat-workflow-chain`, adds full-run (chain) approval.

## Motivation

The main nax roadmap is one `nax chat` session that takes the user from a brainstorm to an open PR
(user, 2026-10-24). Today the session can read where a feature stands (feature 1), but every
billed step still means leaving the chat: the user runs `nax plan`, `nax run` and `nax bot fix` by
hand in another terminal and carries the state back. That stitching is the pain the roadmap exists
to remove.

The standing rule is that a billed launch needs the user's explicit yes at the launch moment
(user). The user ruled on 2026-10-27 that full and guarded mode are only the Bash and coding-tool
permission posture, so billed launches ask in both (Q3). Closing the chat with a running job asks
whether to cancel it or keep it running in the background (Q4). Autonomy beyond one step per card
is feature 3, by ruling Q1.

## Design

### Approach

- New module `packages/nax/src/chat/jobs/`. It holds the job types and store, the argv builder,
  the outcome resolver, the job runner, the `nax-jobs` provider and the write guard. It reaches
  `src/execution/status-file-read.ts` by relative leaf path (`../../execution/status-file-read`),
  never through `@/execution`, as feature 1 does.
- **Out of process.** Each launch spawns the nax CLI as a child with `Bun.spawn`, never in process:
  `nax run` has no in-process API, a run takes process locks and installs signal handlers, and a
  crashing run must not take the chat down.
- **Same nax.** The child argv starts with the chat process's own entry, `naxEntry`:
  `[process.execPath, process.argv[1]]`, resolved once at the CLI boundary in `src/cli/chat.ts`.
  This is `bun <repo>/packages/nax/bin/nax.ts` for a local build and `bun .../dist/nax.js` for the
  global install. The child never resolves `nax` from `PATH`, which closes the version trap. When
  `process.argv[1]` is undefined, no `naxEntry` is passed, and the host registers no `nax-jobs`
  provider.
- **Detached and headless.** The child is spawned with `detached: true` and `stdin: "ignore"`. Its
  stdout and stderr share ONE file descriptor: the runner creates `chat-jobs/` (recursive), opens the
  job's log once with `node:fs` `openSync(path, "a")`, passes that same numeric fd as both `stdout`
  and `stderr`, and closes it in the parent after the spawn returns. Two `Bun.file()` targets would
  open the file twice with separate offsets and overwrite each other (verified on Bun 1.4.4).
  `openSync` / `closeSync` are not on the forbidden list (only `readFileSync` / `writeFileSync` are).
  The runner calls `unref()` on the child, so a kept job outlives the chat. Only `nax run` takes `--headless`. `nax plan` and `nax bot` do not accept
  the flag and are already headless without a TTY.
- **Job records** live in the project output dir: `<outputDir>/chat-jobs/<id>.json`, with the log
  at `<outputDir>/chat-jobs/<id>.log`. `outputDir` is the value `chat-host.ts` already computes
  (`projectOutputDir(getProjectKey(config, repoRoot), config.outputDir)`), so jobs are per project
  and a later chat in the same repo finds them.
- **Outcome from records.** A run's outcome comes from `.nax/features/<f>/status.json` when its
  `run.pid` is the job's pid. A plan's outcome is a `prd.json` written after the job started. Bot
  jobs leave no record a reader can match, so their outcome is the exit code, and `lost` when the
  exit code was never observed.
- **Launch approval.** A `static` provider tool gets no framework ask, and
  `ChatAskController.handle()` auto-allows every session approval in full mode
  (`src/chat/ask-controller.ts:53`). So the controller gains a separate host entry point,
  `requestHostApproval(card)`. It adds a synthesized `approval_requested` event to `pending()`, so
  the existing card (`src/tui/chat/ask-card.ts`) and the Telegram fallback (`ask-fallback.ts`) show
  it unchanged. It is never auto-allowed, never remembered, and resolves `deny` on timeout, on the
  tool call's abort signal, or on `reset()`.
- **Two writers.** The write guard is a `before_tool` loop handler (`LoopHandlerSet`, plugin name
  `nax-jobs`). It returns `{ kind: "block" }` for `Write`, `Edit`, `Delete` and `GitCommit` while a
  `run` or `plan` job for this repo is running. No `@nathapp/nax-agent` change is needed. The host
  appends it to its frozen loop handler set, so chat sessions and subagent sessions both get it. The
  `Git` tool is read-only (`GIT_READ_VERBS`) and Bash is not blocked (design 4.5).
- **Composition.** The host builds the runner, the provider and the guard itself, the way it builds
  `createAgentsProvider`, because the provider needs the host's ask controller and session id. The
  composition and the close prompt live in a new `src/chat/jobs/jobs-host.ts`
  (`createHostJobs`), so `chat-host.ts` (538 lines, held to the 600-line source limit) gains only
  the call sites. They
  exist only when the host has both `resources` and a `naxEntry`. The provider sits after the
  resources' own providers and before `nax-agents`. Subagent sessions do not receive it: they get
  `resources.toolProviders` only, so a subagent cannot launch billed work.
- **Errors.** Every error the module throws is a `NaxError` with `stage: "chat"` and a code
  (`CHAT_JOB_SPAWN_FAILED`, `CHAT_JOB_NOT_RUNNING`, `CHAT_JOB_UNVERIFIED`); `check:nax-error` has a
  zero baseline.
- **Timing constants.** `JOB_POLL_MS`, `CANCEL_GRACE_MS` and `DEFAULT_HOST_APPROVAL_TIMEOUT_MS` are
  named constants, not config. The host passes the real approval timeout from
  `config.execution.approvalTimeout`; the other two are UI cadences, deliberately not tunable.
- **Notices.** The model-facing notice text and the provider's instruction section are prompts, so
  they come from builders in `src/prompts/builders/workflow-builder.ts`, exported from `@/prompts`.

### Integration (extends existing code)

Read only (verified on `main` `d8e876ab0`):

- `readStatusFile(featureDir: string): Promise<NaxStatusFile | null>` in
  `src/execution/status-file-read.ts`. `NaxStatusFile.run` has `pid: number` and
  `status: "running" | "completed" | "failed" | "stalled" | "crashed" | "precheck-failed" | "cost-limit" | "aborted"`;
  `cost.spent: number`; `progress.passed` / `progress.total: number`
  (`src/execution/status-file.ts:126-166`).
- `featureDir(root, id)` from `@/config`; `validateFeatureName(name)` from
  `src/utils/feature-name.ts`. Both throw on an invalid name.
- `loadPRD(path)` and `countStories(prd)` (`total`, `passed`, `failed`, `pending`) from `@/prd`.
- `gitWithTimeout(args, workdir, timeoutMs?)` from `src/utils/git.ts`, returning
  `{ stdout, stderr, exitCode, timedOut? }`.
- `isProcessAlive(pid)` and `errorMessage(err)` from `@nathapp/nax-agent/internal`.
- The checkout lock is `<workdir>/nax.lock`, JSON with a numeric `pid`
  (`src/execution/lock.ts:313`). `nax run -d <repoRoot>` takes it in `repoRoot`.
- `ToolProvider`, `ProviderTool`, `ToolResult` from `@nathapp/nax-agent`. `ProviderTool.run(input, ctx)`
  receives `ctx.signal?: AbortSignal` (`ProviderTool` at `packages/nax-agent/src/tools/provider-types.ts:20-33`,
  `signal` on `ToolRunContext` at `packages/nax-agent/src/tools/registry.ts:94`).
- Loop handlers: `LoopHandlerSet = readonly LoopHandlerEntry[]`, entry
  `{ plugin, event, handler }`, with `before_tool` payload `{ call: { id, name, input }, tools }`
  and outcome `{ kind: "allow" } | { kind: "block"; content: string; isError?: boolean } | ...`
  (`packages/nax-agent/src/native/session/loop-events/types.ts:30-57,250-260`).
- The synthesized card event has the existing `approval_requested` shape:
  `{ type, requestId, tool, summary, command?, reason, expiresAt }`
  (`packages/nax-agent/src/session/agent-session-types.ts:107-120`).
- CLI options: `nax run` takes `-f`, `-d`, `--headless`, `--profile` (repeatable), `-m`,
  `--max-cost` (`bin/nax.ts:215-262`); `nax plan` takes `-f`, `--from`, `-d`, `--profile`
  (`bin/nax.ts:676-690`); `nax bot review|fix <pr>` take `-d`, `--profile`, `--model`, review adds
  `--decisions`, fix adds `--trust` and `--no-rereview` (`src/cli/bot.ts:167-200`).
- `config.execution.approvalTimeout` (ms, default 600000). `config.interaction` is optional on the
  type, so the plugin is read as `config.interaction?.plugin ?? "cli"`.
- `useChatKeys` `close()` (`src/tui/chat/useChatKeys.ts:104`) is the only path from `/quit` and
  ctrl+c to `host.close()`. `keys.canControl()` (`useChatKeys.ts:80`) is the guard every control
  path shares. `ChatApp` has `ask` (`ChatApp.tsx:263`), `turnRunning` (`:265`), `picker`
  (`:262`) and `sendTurn` (`:455`).

Changed (the baseline only locates the code; implement the target):

- `src/chat/ask-controller.ts` `ChatAskController` / `ChatAskControllerOptions`.
  - Baseline: `handle`, `pending`, `resolve`, `canRemember`, `answerQuestion`, `setMode`, `reset`,
    `onChange`; options `{ mode, answer }`.
  - Target: adds `requestHostApproval(card: HostApprovalCard): Promise<"allow" | "deny">`; options
    gain `approvalTimeoutMs?: number` (default `DEFAULT_HOST_APPROVAL_TIMEOUT_MS = 600_000`) and
    `now?: () => Date`. New `_askControllerDeps = { setTimeout, clearTimeout }` holds the expiry
    timer (the documented `setTimeout` exception: the handle is cancelled when the ask resolves).
    `HostApprovalCard` is exported from the same file:
    `{ readonly tool: string; readonly summary: string; readonly command?: string; readonly reason: string; readonly signal?: AbortSignal }`.
- `src/chat/chat-host.ts` `ChatHost` / `ChatHostDeps`.
  - Baseline: no jobs surface; deps have no entry.
  - Target: `ChatHostDeps` gains `readonly naxEntry?: readonly string[]`. `ChatHost` gains
    `readonly jobs?: ChatJobs` and `confirmJobsBeforeClose?(): Promise<void>`. The ask controller is
    created with `approvalTimeoutMs: config.execution.approvalTimeout` and `now: deps.now`.
- `src/chat/chat-mcp.ts` `RESERVED_SERVER_IDS`.
  - Baseline: `new Set(["nax-skills", "nax-agents", "nax-workflow"])`.
  - Target: `new Set(["nax-skills", "nax-agents", "nax-workflow", "nax-jobs"])`.
- `src/cli/chat.ts` `_chatCommandDeps` / `composeChat`.
  - Baseline: no entry dep; `createChatHost({ models, config, cwd, repoRoot, resources, storage, chain, now, logger })`.
  - Target: `_chatCommandDeps.naxEntry: () => readonly string[] | undefined`, default
    `process.argv[1] === undefined ? undefined : [process.execPath, process.argv[1]]`;
    `composeChat` passes `naxEntry` to `createChatHost` when it is defined.
- `src/tui/chat/chat-status.ts` `footerModel`.
  - Baseline: input `{ state, status, hint, copiedChars?, glyphs? }`.
  - Target: input gains `jobs?: readonly FooterJob[]`; when it holds at least one job, the right
    line starts with one span whose text is `formatJobStrip(jobs)`, followed by the existing spans.
- `src/tui/chat/useChatKeys.ts` `close()`.
  - Baseline: sets `closing` and `locked` synchronously, then awaits `host.close()` inside a `try`.
  - Target: when `host.confirmJobsBeforeClose` is defined, `close()` first sets a `confirming` ref
    and awaits it, leaving `closing` and `locked` untouched until it settles, because the ask card
    is only answerable while `!keys.locked` (`ChatApp.tsx:603`). A second ctrl+c or `/quit` while
    `confirming` is set returns at once and raises no second card. After it resolves, `confirming`
    is cleared and the existing closing sequence runs. When the method is absent, `close()` runs exactly as today, with no extra
    await, so the existing synchronous teardown path is unchanged. If the call rejects, the error is
    shown through `onError`, `confirming` is cleared and the chat stays open.

### Data shapes

```ts
// src/chat/jobs/job-types.ts
export type ChatJobKind = "plan" | "run" | "bot_review" | "bot_fix";
export type ChatJobState = "running" | "succeeded" | "failed" | "cancelled" | "lost";

export interface ChatJob {
  readonly schemaVersion: 1;
  /** `<kind>-<8 lowercase hex>`, e.g. `run-1a2b3c4d`. */
  readonly id: string;
  readonly kind: ChatJobKind;
  /** Feature name for plan/run; the PR number as a decimal string for bot jobs. */
  readonly target: string;
  readonly argv: readonly string[];
  /** The repo root the job runs in. */
  readonly cwd: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly state: ChatJobState;
  readonly logPath: string;
  /** The chat session that started it. */
  readonly sessionId: string;
  /** When the user said yes on the launch card. */
  readonly approvedAt: string;
  readonly cancelRequested?: true;
  readonly exitCode?: number;
  readonly cost?: number;
  readonly progress?: { readonly passed: number; readonly total: number };
  readonly note?: string;
}

export const JOB_ID_PATTERN = /^(plan|run|bot_review|bot_fix)-[0-9a-f]{8}$/;
```

```ts
// src/chat/jobs/job-store.ts
export const CHAT_JOBS_DIR = "chat-jobs";
export function jobsDir(outputDir: string): string;            // join(outputDir, "chat-jobs")
export function jobLogPath(outputDir: string, id: string): string; // join(jobsDir, `${id}.log`)
export function newJobId(kind: ChatJobKind): string;           // via _jobStoreDeps.randomHex
export function writeJobRecord(outputDir: string, job: ChatJob): Promise<void>;
export function readJobRecords(outputDir: string): Promise<ChatJob[]>; // newest first by startedAt
```

```ts
// src/chat/jobs/job-argv.ts
export type JobLaunchInput =
  | { readonly kind: "plan"; readonly feature: string; readonly spec?: string; readonly profiles: readonly string[] }
  | { readonly kind: "run"; readonly feature: string; readonly profiles: readonly string[];
      readonly maxIterations?: number; readonly maxCost?: number }
  | { readonly kind: "bot_review"; readonly pr: number; readonly profiles: readonly string[];
      readonly model?: string; readonly decisions?: string }
  | { readonly kind: "bot_fix"; readonly pr: number; readonly profiles: readonly string[];
      readonly model?: string; readonly trust?: boolean; readonly noRereview?: boolean };

/** Checks `feature` with `validateFeatureName` only; `featureDir` needs a repo root and is called by jobs-launch. */
export function parseJobInput(kind: ChatJobKind, raw: Record<string, unknown>): JobLaunchInput | { readonly error: string };
/** `spec` must be resolved (repo-relative) before a plan argv is built. */
export function buildJobArgv(input: JobLaunchInput & { readonly spec?: string },
                             ctx: { readonly naxEntry: readonly string[]; readonly repoRoot: string }): readonly string[];
```

Argv, exactly, with `E` = `...naxEntry`, `R` = `repoRoot` and `P` = one `"--profile", <p>` pair
per profile in order:

- plan: `[E, "plan", "-f", feature, "--from", spec, "-d", R, P]`
- run: `[E, "run", "-f", feature, "-d", R, "--headless", P]`, then `"-m", String(maxIterations)`
  when set, then `"--max-cost", String(maxCost)` when set
- bot_review: `[E, "bot", "review", String(pr), "-d", R, P]`, then `"--model", model` when set, then
  `"--decisions", decisions` when set
- bot_fix: `[E, "bot", "fix", String(pr), "-d", R, P]`, then `"--model", model` when set, then
  `"--trust"` when `trust` is true, then `"--no-rereview"` when `noRereview` is true

```ts
// src/chat/jobs/job-outcome.ts
export interface JobOutcome {
  readonly state: Exclude<ChatJobState, "running">;
  readonly cost?: number;
  readonly progress?: { readonly passed: number; readonly total: number };
  readonly note?: string;
}
export function resolveJobOutcome(job: ChatJob, exit: { readonly exitCode?: number }, repoRoot: string): Promise<JobOutcome>;
export function readRunProgress(job: ChatJob, repoRoot: string):
  Promise<{ readonly cost: number; readonly progress: { readonly passed: number; readonly total: number } } | null>;
```

Outcome rules, applied in this order:

1. `job.cancelRequested` → `cancelled`. For a run whose status record matches (rule 2), `cost` and
   `progress` are kept.
2. run: `status = readStatusFile(featureDir(repoRoot, job.target))`. When `status.run.pid === job.pid`:
   `completed` → `succeeded`; `aborted` → `cancelled`; any other status → `failed` with note
   `run status <status>`. `cost = status.cost.spent`, `progress = { passed, total }` from
   `status.progress`. When `completed` and `exit.exitCode` is defined and non-zero, the state stays
   `succeeded` with note `exit code <n> disagrees with the run record`. With no status, or a status
   whose pid differs → `failed` with note `no run record for pid <pid>`, followed by
   `; exit code <n>` when the exit code is known.
3. plan: `<featureDir>/prd.json` exists and its modification time is at or after
   `Date.parse(job.startedAt)` → `succeeded`; otherwise `failed` with note `plan wrote no prd.json`.
4. bot_review / bot_fix: exit code `0` → `succeeded`; a non-zero exit code → `failed` with note
   `exit code <n>`; no exit code → `lost` with note `outcome unknown: exit code not observed`.

`readRunProgress` returns `{ cost, progress }` from the same status file when its `run.pid` is the
job's pid, else `null`.

```ts
// src/chat/jobs/job-runner.ts
export const JOB_POLL_MS = 2_000;
export const CANCEL_GRACE_MS = 10_000;
export const JOB_LOG_TAIL_LINES = 40;

export interface JobRunnerOptions {
  readonly repoRoot: string;
  readonly outputDir: string;
  readonly now: () => Date;
}
export interface StartJobRequest {
  readonly kind: ChatJobKind;
  readonly target: string;
  readonly argv: readonly string[];
  readonly sessionId: string;
  readonly approvedAt: string;
}
export interface ChatJobs {
  start(request: StartJobRequest): Promise<ChatJob>;
  /** Every job of this repo the runner knows, newest first. */
  list(): readonly ChatJob[];
  get(id: string): ChatJob | undefined;
  /** Jobs in state `running`, newest first. */
  running(): readonly ChatJob[];
  /** Running jobs this runner spawned (not re-attached ones). */
  owned(): readonly ChatJob[];
  /**
   * Persists `cancelRequested: true` to the record, sends SIGINT, then SIGTERM after
   * CANCEL_GRACE_MS if the pid is still alive. No ask. Rejects `CHAT_JOB_UNVERIFIED` for a
   * re-attached job it cannot tie to its pid (see below).
   */
  cancel(id: string): Promise<ChatJob>;
  /** The check `cancel` runs, without signalling: running, and owned or a verified re-attached run. */
  canCancel(id: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
  /** Loads this repo's records once; idempotent. */
  attach(): Promise<void>;
  logTail(id: string, lines?: number): Promise<string>;
  /** The oldest queued notice, left in the queue. */
  peekNotice(): string | undefined;
  /** Returns and removes the oldest queued notice. */
  takeNotice(): string | undefined;
  onChange(listener: () => void): () => void;
  /** Stops polling and timers; never kills a child. */
  dispose(): void;
}
export function createJobRunner(options: JobRunnerOptions): ChatJobs;
export const _jobRunnerDeps: { spawn; kill; isProcessAlive; setTimeout; clearTimeout; openLog; closeLog };
```

- `start` creates `chat-jobs/` (recursive), opens the log fd, spawns, closes the fd in the parent,
  registers the job in memory synchronously right after the spawn returns (so `running()` holds it
  before any further await), then writes the record (state `running`) and emits a change. A spawn that throws rejects with
  `NaxError` `CHAT_JOB_SPAWN_FAILED`, message `could not start nax <kind>: <message>`, and writes no
  record. When the owned child exits, the runner resolves the outcome with the observed exit code,
  writes the record with `endedAt`, queues a notice and emits a change. The owner always writes:
  it holds the real exit code.
- Polling uses a chained cancellable `setTimeout` of `JOB_POLL_MS` (the documented exception in the
  forbidden-patterns table), armed only while a job is running. Each tick: a re-attached running
  job whose pid is dead is finalized (see re-attached finalization below), and queues a notice when
  this runner wrote its terminal state; a running `run` job's `cost` and `progress`
  are refreshed from `readRunProgress`, and a change is emitted when either changed. Refreshed
  values are kept in memory and written with the final record.
- `attach` reads `readJobRecords(outputDir)` and keeps the records whose `cwd` equals `repoRoot`. A
  `running` record whose pid is alive is tracked by polling. A `running` record whose pid is dead
  is finalized and written, and queues NO notice: stale jobs found at startup are visible in
  `list()` and `/jobs`, and must not start a stack of model turns.
- Re-attached finalization: before writing a terminal state for a job it did not spawn, the runner
  re-reads that job's record. If the record is already terminal (its owner wrote it), the runner
  adopts it unchanged, writes nothing and queues no notice. Otherwise it resolves the outcome with
  no exit code and writes it.
- Re-attached identity: `isProcessAlive` cannot tell a recycled pid from the job. A re-attached job
  is cancellable only when it is a `run` job whose `status.json` `run.pid` equals the job's pid.
  Any other re-attached job rejects `cancel` with `CHAT_JOB_UNVERIFIED`, message
  `job <id> was started by another chat and its pid cannot be verified; stop it from that chat or by hand`.
- Notices are FIFO.

```ts
// src/prompts/builders/workflow-builder.ts (additions)
export interface JobNoticeInput {
  readonly id: string; readonly kind: string; readonly target: string; readonly state: string;
  readonly cost?: number; readonly note?: string; readonly logPath: string;
}
export function buildJobNotice(input: JobNoticeInput): string;
export function buildJobsInstructions(): string;
```

`buildJobNotice` returns
`[nax-jobs] job <id> (<kind> <target>) ended: <state>`, then ` cost $<cost.toFixed(2)>` when `cost`
is set, then ` (<note>)` when `note` is set, then ` log <logPath>`, then a newline and one line
telling the agent to call `nax-workflow__state`, report the outcome to the user and propose the
single next step.

`buildJobsInstructions` content (exact wording is the builder's):

1. names `nax-jobs__plan`, `nax-jobs__run`, `nax-jobs__bot_review` and `nax-jobs__bot_fix`, and
   says each is billed and shows the user an approval card;
2. says a denial is final for that call, and the agent must not retry with changed arguments to get
   round it;
3. says jobs run in the background and a `[nax-jobs]` notice arrives when one ends;
4. says Write, Edit, Delete and GitCommit are refused in this checkout while a run or plan job runs;
5. says to start one step at a time: after a job ends, report and propose the next step.

### The `nax-jobs` provider

```ts
// src/chat/jobs/jobs-provider.ts
export interface JobsProviderOptions {
  readonly repoRoot: string;
  readonly naxEntry: readonly string[];
  /** Resolved config.execution.maxIterations. */
  readonly maxIterations: number;
  /** Resolved `config.interaction?.plugin ?? "cli"`. */
  readonly interactionPlugin: string;
  readonly jobs: ChatJobs;
  readonly approve: (card: HostApprovalCard) => Promise<"allow" | "deny">;
  readonly sessionId: () => string;
  readonly now: () => Date;
}
export function createJobsProvider(options: JobsProviderOptions): ToolProvider; // id "nax-jobs", kind "static", stages ["*"]
```

The launch logic lives in `src/chat/jobs/jobs-launch.ts`, with
`_jobsLaunchDeps = { git, lockHolder, exists, loadPRD }`. `lockHolder(repoRoot)` reads
`<repoRoot>/nax.lock` and returns its `pid` when that pid is alive, else `null` (a missing or
unparseable file is `null`).

Tool input schemas (`additionalProperties: false` on each):

| Tool | Properties | Required |
|---|---|---|
| `plan` | `feature: string`, `spec: string`, `profiles: string[]` | `feature` |
| `run` | `feature: string`, `profiles: string[]`, `maxIterations: integer`, `maxCost: number` | `feature` |
| `bot_review` | `pr: integer`, `profiles: string[]`, `model: string`, `decisions: string` | `pr` |
| `bot_fix` | `pr: integer`, `profiles: string[]`, `model: string`, `trust: boolean`, `noRereview: boolean` | `pr` |
| `list` | `job: string` | none |
| `cancel` | `job: string` | `job` |

The four launch tools' descriptions include `Billed` and `asks the user`.

A launch, in this order:

1. `parseJobInput` (validation table in Failure Handling). For plan and run, `featureDir(repoRoot, f)`
   is then called; when it throws, its message is the error result.
2. Target checks. plan: when `spec` is absent, it resolves to `.nax/features/<f>/spec.md` if that
   file exists, else `.nax/specs/<f>.md` if that exists; the resolved file must exist. run:
   `<featureDir>/prd.json` must exist and load. bot_review: `decisions`, when given, must exist.
3. Busy checks (plan and run only): a running `plan` or `run` job in `jobs.running()`, then the
   checkout lock holder. They run here, before the card, and again in step 6 after `allow`, because
   the card can stay open for up to `approvalTimeoutMs` and two launches can race in one model
   batch.
4. The card: `approve({ tool: "nax-jobs__<kind>", summary, command, reason, signal: ctx.signal })`.
   - `summary`: `nax plan <f>`, `nax run <f>`, `nax bot review #<pr>`, `nax bot fix #<pr>`.
   - `command`: the argv joined with single spaces.
   - `reason`: lines joined with `\n`, in this order:
     - `workdir <repoRoot>`, plus ` on branch <b>` when `git symbolic-ref --short HEAD` exits 0;
     - `nax <naxEntry joined with spaces>`;
     - `profiles <p1, p2>`, or `profiles (none)`;
     - run only: `stories <pending> pending of <total>; max iterations <m>`, where `m` is
       `maxIterations` from the input or else the provider's resolved value;
     - run only, when `pending > m`:
       `warning: <pending> stories pending but max iterations is <m>; pass maxIterations (nax#2706)`;
     - run only, when `interactionPlugin` is `"cli"`:
       `warning: this run has no channel for its own asks; they will time out`;
     - plan only, when `<featureDir>/prd.json` exists: `warning: prd.json exists and will be replaced`.
5. `deny` → an error result: `[chat] the user declined <summary>; do not retry with different arguments unless the user asks`.
6. `allow` → re-run the busy checks (plan and run); a hit returns the same busy error and nothing
   starts. The in-memory job check runs after the `lockHolder` read, immediately before
   `jobs.start` with no await between them, so two launches allowed together cannot both pass. Then `jobs.start({ kind, target, argv, sessionId: sessionId(), approvedAt: now().toISOString() })`.
   A `start` rejection becomes the error result `[chat] could not start nax <kind>: <message>`
   (the runner's message with its own `could not start nax <kind>: ` prefix removed when present).
   The result content is one line of JSON `{ "job": <id>, "state": "running", "log": <logPath> }`,
   followed by a newline and `A [nax-jobs] notice arrives when it ends.`

`list` with no `job` returns JSON `{ "jobs": [...], "omitted": <n> }`, at most `JOBS_LIST_LIMIT = 20`
newest first. Each entry has `id`, `kind`, `target`, `state`, `startedAt`, and `endedAt`, `progress`,
`cost`, `note` when present. `list` with `job` returns that record's fields plus `logTail`, the last
`JOB_LOG_TAIL_LINES` lines of its log.

`cancel` first calls `jobs.canCancel(id)`; on `{ ok: false }` it returns `[chat] <message>` as an
error result with no card (this covers a job that is not running and an unverified re-attached
job). Otherwise it asks with
`tool: "nax-jobs__cancel"`, summary `cancel nax <kind> <target> (<id>)`, reason
`Cancelling stops the job; paid work it has done is not refunded.` On `allow` it calls
`jobs.cancel(id)` and returns `cancel requested for job <id>; SIGINT sent`. On `deny` it returns the
error `[chat] the user declined to cancel job <id>`.

`instructions()` returns `buildJobsInstructions()`.

### Write guard

```ts
// src/chat/jobs/job-write-guard.ts
export const GUARDED_WRITE_TOOLS: readonly string[] = ["Write", "Edit", "Delete", "GitCommit"];
export function createJobWriteGuard(jobs: Pick<ChatJobs, "running">, repoRoot: string): LoopHandlerSet;
```

One entry: plugin `nax-jobs`, event `before_tool`. For a call whose `name` is in
`GUARDED_WRITE_TOOLS`, while `jobs.running()` holds a `plan` or `run` job whose `cwd` equals
`repoRoot`, the handler returns
`{ kind: "block", isError: true, content: "[nax-jobs] <name> refused: nax <kind> job <id> is running in this checkout; wait for it to end or cancel it" }`,
naming the newest such job. Otherwise it returns `{ kind: "allow" }`.

### Host and screen

- `createHostJobs(...)` in `src/chat/jobs/jobs-host.ts` returns `{ jobs, provider, guard, confirmClose }`.
  `createChatHost` with both `resources` and `naxEntry` calls it and so builds the runner
  (`createJobRunner({ repoRoot, outputDir, now })`), the provider (with
  `approve: (card) => this.asks.requestHostApproval(card)`,
  `sessionId: () => this.current().sessionId`,
  `maxIterations: config.execution.maxIterations` and
  `interactionPlugin: config.interaction?.plugin ?? "cli"`) and the guard. `toolProviders` becomes
  `[...resources.toolProviders, nax-jobs, nax-agents?]`. The loop handler set becomes
  `[...pluginHandlers, ...ruleDeliveryHandlers, ...guard]`, still frozen. `host.jobs` is the runner.
  Without either input, none of this exists and `host.jobs` is undefined.
- `start()` and `resume()` await `jobs.attach()` after the session opens.
- `confirmJobsBeforeClose()`: with no `owned()` jobs it resolves without asking. Otherwise it asks
  with `tool: "nax-jobs__close"`, summary `<n> nax job(s) still running: <ids comma-separated>`,
  reason `Yes cancels them. No keeps them running in the background; a later nax chat in this repo picks them up.`
  `allow` calls `jobs.cancel` for each owned job; a cancel that rejects is logged through the host
  logger's `warn` and the rest are still cancelled. `deny`, including a timeout, keeps them.
  `host.confirmJobsBeforeClose` is `confirmClose` from `createHostJobs`, and is undefined when the
  jobs pieces do not exist.
- `close()` calls `jobs.dispose()` and never cancels a job. The SIGTERM and SIGHUP shutdown path in
  `runShell` calls `host.close()` directly, so it keeps running jobs without asking.
- `formatJobStrip(jobs: readonly FooterJob[]): string`, with
  `FooterJob = { kind, target, progress?, cost? }`, in `chat-status.ts`. One part per job:
  `run <f>` plus ` <passed>/<total>` when `progress` is set, plus ` $<cost.toFixed(2)>` when `cost`
  is set; `plan <f>`; `bot_review #<pr>`; `bot_fix #<pr>`. A feature name longer than 16 characters
  is cut to its first 15 characters plus `…`, so the strip fits the one-row footer. It shows at most
  two parts joined with ` · `, then ` +<n>` for the rest.
- New hook `useJobs(host, { idle, deliver })` in `src/tui/chat/use-jobs.ts`. It returns
  `host.jobs?.running() ?? []` and re-renders on `host.jobs.onChange`. Whenever `idle` is true and
  `peekNotice()` returns a notice, it calls `deliver(notice)`, which returns `Promise<boolean>`; only
  on `true` does it call `takeNotice()`. A notice is therefore never lost to a turn that did not
  start. `deliver` is read through a ref, so the latest `sendTurn` closure is used. At most one
  delivery is in flight at a time.
- `ChatApp` passes `idle = !turnRunning && ask === undefined && picker.model === undefined && keys.canControl()`,
  `deliver` = a function that returns `false` when `sending.current` is already true and otherwise
  awaits `sendTurn(text)` and returns `true`, and the running jobs to `footerModel` as `jobs`.
- `/jobs` is a new built-in slash command, placed after `agents` and before `quit` in `COMMANDS`,
  with description `List nax jobs`. It shows `formatJobsListing(host.jobs?.list() ?? [])`, or
  `jobs are not available in this session` when `host.jobs` is undefined. It makes no model call.
  `formatJobsListing(jobs: readonly ChatJob[]): string` lives in `src/chat/jobs/jobs-listing.ts`
  and is exported from `@/chat`, like `formatAgentsListing`. One line per job, newest first, at most
  20, then `+<n> more` when there are more: `<id>  <state>  <kind> <target>`, then
  `  <passed>/<total>` when `progress` is set, then `  $<cost.toFixed(2)>` when `cost` is set, then
  `  <startedAt>`. Bot targets show as `#<pr>`. No jobs gives `(no jobs)`.

### Failure Handling

| Input / condition | Behaviour |
|:---|:---|
| `feature` missing or not a string | error `[chat] feature must be a string` |
| `feature` fails `validateFeatureName` (in `parseJobInput`) or `featureDir` (in jobs-launch) | error, content is the thrown message |
| `profiles` not an array of strings | error `[chat] profiles must be an array of strings` |
| a profile not matching `^[A-Za-z0-9][A-Za-z0-9._-]*$` | error `[chat] profile <p> is not a valid profile name` |
| `maxIterations` not an integer from 1 to 1000 | error `[chat] maxIterations must be an integer from 1 to 1000` |
| `maxCost` not a finite number above 0 | error `[chat] maxCost must be a positive number` |
| `pr` not a positive integer | error `[chat] pr must be a positive integer` |
| `model` not matching `^[A-Za-z0-9][A-Za-z0-9._:/-]*$` | error `[chat] model <m> is not a valid model id` |
| `spec` or `decisions` absolute, starting with `-`, or with a `..` segment | error `[chat] <field> must be a repo-relative path` |
| `trust` or `noRereview` present and not a boolean | error `[chat] <field> must be a boolean` |
| plan spec not found | error `[chat] no spec for <f>; looked for <path(s)>` |
| run with no `prd.json` | error `[chat] no prd.json for <f>; run nax plan first` |
| run whose `prd.json` does not load | error `[chat] prd.json for <f> is unreadable: <message>` |
| bot_review `decisions` file missing | error `[chat] decisions file <path> not found` |
| a plan or run job already running in this repo | error `[chat] nax <kind> job <id> is already running in this checkout`; no card |
| `nax.lock` held by a live pid | error `[chat] this checkout is held by nax pid <pid>; wait for it or stop it first`; no card |
| user denies the launch card | error `[chat] the user declined <summary>; do not retry with different arguments unless the user asks`; nothing spawns |
| launch card expires (`approvalTimeoutMs`) | resolves `deny`, same result as a denial |
| the tool call's `ctx.signal` aborts while the card is open | resolves `deny`; the card leaves `pending()` |
| `Bun.spawn` throws | the runner rejects `CHAT_JOB_SPAWN_FAILED` and writes no record; the tool returns error `[chat] could not start nax <kind>: <message>` |
| `jobs.start` rejects for another reason (for example the record write fails) | error `[chat] could not start nax <kind>: <message>` |
| a plan or run job, or a live `nax.lock` holder, appears while the launch card is open | after `allow`, the same busy error as before the card; nothing starts |
| `nax.lock` missing, unparseable, or naming a dead pid | `lockHolder` returns `null`; no busy error |
| `cancel` of a re-attached job that is not a `run` with a matching `status.json` pid | error `[chat] job <id> was started by another chat and its pid cannot be verified; stop it from that chat or by hand`; no card |
| a re-attached job's record is already terminal when the runner would finalize it | adopted unchanged; nothing written; no notice |
| `attach` finds a `running` record whose pid is dead | finalized and written; no notice |
| a notice is peeked but the turn cannot start (a turn is already sending) | `deliver` returns `false`; the notice stays queued for the next idle moment |
| `host.confirmJobsBeforeClose` rejects | the error is shown; the chat stays open |
| `/jobs` in a session with no `host.jobs` | shows `jobs are not available in this session` |
| `list` / `cancel` with a `job` not matching `JOB_ID_PATTERN` | error `[chat] invalid job id <id>` |
| `list` / `cancel` with an unknown job id | error `[chat] unknown job <id>` |
| `cancel` of a job not running | error `[chat] job <id> is not running (state <state>)`; no card (`canCancel` gives the message `job <id> is not running (state <state>)`) |
| user denies the cancel card | error `[chat] the user declined to cancel job <id>` |
| a job record file that is not JSON or fails the shape guard | skipped by `readJobRecords` |
| `<outputDir>/chat-jobs/` missing | `readJobRecords` returns `[]` |
| a job's log file missing when tailed | `logTail` returns `""` |
| `jobs.cancel` on a pid that is already dead | SIGINT failure is ignored; the next poll or exit finalizes the job |
| a host ask still open when the session is replaced (`reset()`) | resolves `deny` |

## Out of Scope

- Full-run (chain) approval and the agent starting a second billed step without a new card; this is feature `chat-workflow-chain`.
- Routing a running `nax run`'s own asks (story-level approvals) into the chat card; the run keeps its own interaction chain, and the card only warns when that chain is `cli`.
- A job picker or a log-tail view in the TUI; `/jobs` prints a plain listing, and the model reads a job's log through `nax-jobs__list`.
- Refusing a second bot review or bot fix on a PR that already has one running, or a run of a PRD whose stories have all passed; only plan and run are checked for a busy checkout.
- Detecting a recycled pid for a re-attached job's liveness; such a job stays `running` in the list until that pid exits, and only cancel is guarded (by the `run` status-file check).
- Notices for stale jobs finalized at startup (`attach`); they show in `/jobs` and `nax-jobs__list` only.
- Running `/jobs` while a turn is in flight; like every other built-in it is refused with the busy notice, and the footer strip shows running jobs meanwhile.
- A compare-and-set write of a job record across two chats; when both finalize the same job in the same moment, the last write wins (the owner writes the real exit code at exit, and the other chat adopts a terminal record it finds).
- A job card in the transcript (design 4.8); the launch tool's result and the end notice are the transcript record.
- Recording which channel (terminal or Telegram) answered a launch card; the record keeps `approvedAt` only.
- Reading `naxCommit` from a run log into the job record or the card; the card shows the nax entry path.
- Cost for plan and bot jobs; only `run` jobs report cost, from `status.json`.
- Adding job cost to the chat session's `costUsd`; the two ledgers stay separate.
- Registering the `nax-jobs` provider in the ACP server (koda); only `nax chat` gets it.
- Giving subagent sessions the `nax-jobs` tools; subagents cannot launch billed work.
- Blocking Bash, or any tool other than Write, Edit, Delete and GitCommit, while a job holds the checkout.
- `--in-place` for `nax bot fix`, and the `nax run` flags `--dry-run`, `--parallel`, `--schedule`, `--compare`, `--plan`, `--fresh` and `--no-resume`; the tools do not offer them.
- Tools for merge, release or `nax workflow promote`; those stay with the user.
- Sending SIGTERM after the cancel grace period when the chat has already exited; the SIGINT is sent, and the grace timer dies with the chat.
- Reporting jobs inside `nax-workflow__state` output; feature 1's state tool is unchanged.
- Fixing nax#2706; the run card only warns about it.
- Any change to `nax run`, `nax plan` or `nax bot` themselves, or to `@nathapp/nax-agent`.
- Editing files under `.nax/` (rules, context) or the slice 2 design document.
- Cross-session memory of rulings or preferences; this is its own slice, not yet designed (user ruling 2026-10-27).

## Stories

### US-001 — job types and the job record store

Workdir: packages/nax. No dependencies.

New `src/chat/jobs/job-types.ts` with `ChatJobKind`, `ChatJobState`, `ChatJob` and
`JOB_ID_PATTERN`, and new `src/chat/jobs/job-store.ts` with `CHAT_JOBS_DIR`, `jobsDir`,
`jobLogPath`, `newJobId`, `writeJobRecord` and `readJobRecords`, as in Design § Data shapes.
`writeJobRecord` writes `<id>.json` through a temp file and a rename, so a reader never sees half a
record. `readJobRecords` keeps only records with `schemaVersion` 1, a string `id` matching
`JOB_ID_PATTERN`, a known `kind` and `state`, a numeric `pid`, and string `cwd`, `startedAt`,
`logPath` and `sessionId`. `_jobStoreDeps.randomHex` (default: 8 hex characters from
`crypto.randomUUID()`) makes `newJobId` testable. Tests go in a new
`test/unit/chat/jobs/job-store.test.ts`, using a temp directory.

### US-002 — launch input parsing and argv

Workdir: packages/nax. Depends on US-001.

New `src/chat/jobs/job-argv.ts` with `JobLaunchInput`, `parseJobInput` and `buildJobArgv`, as in
Design § Data shapes, with the validation rows of Design § Failure Handling that concern input
fields. Pure: no file reads. Tests go in a new `test/unit/chat/jobs/job-argv.test.ts`.

### US-003 — job outcome from the command's records

Workdir: packages/nax. Depends on US-001.

New `src/chat/jobs/job-outcome.ts` with `JobOutcome`, `resolveJobOutcome` and `readRunProgress`,
following the outcome rules in Design § Data shapes. `_jobOutcomeDeps = { readStatusFile, stat }`.
`readStatusFile` is imported by relative leaf path. Tests go in a new
`test/unit/chat/jobs/job-outcome.test.ts`, with temp-dir `status.json` and `prd.json` fixtures.

### US-004 — job notice and jobs instruction builders

Workdir: packages/nax. No dependencies.

`src/prompts/builders/workflow-builder.ts` gains `JobNoticeInput`, `buildJobNotice` and
`buildJobsInstructions`, re-exported from `src/prompts/index.ts`. The builders take plain values and
import nothing from `src/chat/`. Tests go in the existing
`test/unit/prompts/builders/workflow-builder.test.ts`.

### US-005 — the job runner: start, exit and notices

Workdir: packages/nax. Depends on US-001, US-003, US-004.

New `src/chat/jobs/job-runner.ts` with `JobRunnerOptions`, `StartJobRequest`, `ChatJobs`,
`createJobRunner`, the three constants and `_jobRunnerDeps`, behaving as described under Design §
Data shapes for `start`, owned-child exit, `list`, `get`, `running`, `owned`, `peekNotice`,
`takeNotice` and `onChange`. Spawn options: `cwd: repoRoot`, `detached: true`,
`stdin: "ignore"`, and one append fd for `jobLogPath(outputDir, id)` passed as both `stdout` and
`stderr` (opened through `_jobRunnerDeps.openLog`, closed through `_jobRunnerDeps.closeLog` after the
spawn); `chat-jobs/` is created first. The runner calls `unref()` on the child.
Notices are built with `buildJobNotice`. In this story `attach()` resolves without reading the store,
`logTail` returns `""`, polling is not armed, `dispose()` does nothing, and `cancel` / `canCancel`
reject with `CHAT_JOB_NOT_RUNNING`; US-006 and US-007 fill them in. Tests go in a new `test/unit/chat/jobs/job-runner.test.ts`, with a stubbed
spawn whose `exited` promise the test resolves, stubbed `kill` and `isProcessAlive`, and fake timers
from `makeFakeClock()`.

### US-006 — the job runner: attach, polling, log tail and dispose

Workdir: packages/nax. Depends on US-005.

`createJobRunner` gains `attach()` (re-attaching this repo's records, with no notices), the
`JOB_POLL_MS` poll (liveness of re-attached jobs, `run` progress and cost), re-attached finalization
(adopting an already-terminal record), `logTail` and `dispose()` (stopping the poll), as described
under Design § Data shapes. Tests go in a new `test/unit/chat/jobs/job-runner-attach.test.ts`, with
the same stubs and fake clock.

### US-007 — the job runner: cancel

Workdir: packages/nax. Depends on US-006.

`createJobRunner` gains `canCancel(id)` and `cancel(id)`, as described under Design § Data shapes:
`cancel` runs the same check as `canCancel`, persists `cancelRequested: true` to the record, sends
SIGINT, and arms the `CANCEL_GRACE_MS` timer that sends SIGTERM when the pid is still alive; a
re-attached job passes only as a `run` whose `status.json` `run.pid` matches. `dispose()` also
clears the grace timers. Tests go in a new `test/unit/chat/jobs/job-runner-cancel.test.ts`, with the
same stubs and fake clock.

### US-008 — host approval asks on the chat ask controller

Workdir: packages/nax. No dependencies.

`src/chat/ask-controller.ts` gains `HostApprovalCard`, `DEFAULT_HOST_APPROVAL_TIMEOUT_MS`, the
`approvalTimeoutMs` and `now` options, and `requestHostApproval`. Host requests use request ids
starting `host-`. They join `pending()` as `approval_requested` events with
`expiresAt = now + approvalTimeoutMs`. `handle()` never answers them, in either mode.
`canRemember()` is false for them. `resolve()` routes them to the waiting promise and never to
`options.answer`: `allow_once` and `allow_session` give `"allow"`, `deny` gives `"deny"`, and none
adds to approval memory. A timer (`_askControllerDeps.setTimeout` / `clearTimeout`) resolves
`"deny"` at expiry. An abort of `card.signal` resolves `"deny"`. `reset()` resolves every open host
request `"deny"`. Each resolution removes the event from `pending()` and notifies listeners. Tests go
in the existing `test/unit/chat/ask-controller.test.ts`, plus a fallback test in the existing
`test/unit/chat/ask-fallback.test.ts`.

### US-009 — the `nax-jobs` provider: launch tools

Workdir: packages/nax. Depends on US-002, US-005, US-008.

New `src/chat/jobs/jobs-launch.ts` (input parse, target checks, card, start; `_jobsLaunchDeps`) and
new `src/chat/jobs/jobs-provider.ts` with `JobsProviderOptions` and `createJobsProvider`, exposing
the `plan`, `run`, `bot_review` and `bot_fix` tools as in Design § The `nax-jobs` provider, launch
steps 1, 2, 4, 5 and the `jobs.start` call of step 6. A `loadPRD` rejection is left to propagate in
this story; US-010 maps it to the unreadable-`prd.json` error. The busy checks (step 3 and the re-check in
step 6) and the `start`-rejection mapping are US-010. In this story the provider has exactly these
four tools and no `instructions`; US-011 adds the rest. Tests go in a new
`test/unit/chat/jobs/jobs-launch.test.ts`, with a temp-dir fixture repo, a stub `approve`, and a
stub `ChatJobs` whose `start` records its request.

### US-010 — launch busy checks, lock holder and start failures

Workdir: packages/nax. Depends on US-009.

`jobs-launch.ts` gains the busy checks before the card and again after `allow` (plan and run), the
real `lockHolder` (reads `<repoRoot>/nax.lock`; `null` for missing, unparseable or dead-pid), the
`featureDir` throw and unreadable-`prd.json` error results, and the mapping of a `jobs.start`
rejection to `[chat] could not start nax <kind>: <message>`, as in Design § The `nax-jobs` provider
and § Failure Handling. Tests go in a new `test/unit/chat/jobs/jobs-launch-busy.test.ts`.

### US-011 — the `nax-jobs` provider: list, cancel and instructions

Workdir: packages/nax. Depends on US-007, US-010.

`createJobsProvider` gains the `list` and `cancel` tools and `instructions()` returning
`buildJobsInstructions()`, as in Design § The `nax-jobs` provider. `JOBS_LIST_LIMIT` is exported
from `jobs-provider.ts`. Tests go in a new `test/unit/chat/jobs/jobs-provider.test.ts`.

### US-012 — the write guard and the jobs listing

Workdir: packages/nax. Depends on US-005.

New `src/chat/jobs/job-write-guard.ts` with `GUARDED_WRITE_TOOLS` and `createJobWriteGuard`, as in
Design § Write guard, and new `src/chat/jobs/jobs-listing.ts` with `formatJobsListing`, as in Design
§ Host and screen (`/jobs`). Tests go in a new `test/unit/chat/jobs/job-write-guard.test.ts`, with a
stub `running()`, and a new `test/unit/chat/jobs/jobs-listing.test.ts`.

### US-013 — wire jobs into the chat host and `nax chat`

Workdir: packages/nax. Depends on US-007, US-011, US-012.

`src/chat/jobs/index.ts` barrels the module. `src/chat/index.ts` exports the `ChatJob`, `ChatJobs`
and `HostApprovalCard` types and the `formatJobsListing` function. New `src/chat/jobs/jobs-host.ts`
with `createHostJobs` (runner, provider, guard and `confirmClose`). `ChatHostDeps.naxEntry`,
`ChatHost.jobs`, `ChatHost.confirmJobsBeforeClose`, the call to `createHostJobs`, `attach` on start
and resume, `dispose` on close, and the ask controller's `approvalTimeoutMs` / `now` are added in
`src/chat/chat-host.ts`, as in Design § Host and screen; `chat-host.ts` stays under 600 lines. `nax-jobs` joins
`RESERVED_SERVER_IDS`. `src/cli/chat.ts` gains the `naxEntry` dep and passes it on. Host tests go in
a new `test/unit/chat/chat-host-jobs.test.ts`. The CLI test goes in the existing
`test/unit/cli/chat-resources.test.ts`, and the reserved-id test in the existing
`test/unit/chat/chat-mcp.test.ts`.

### US-014 — footer job strip and end notices

Workdir: packages/nax. Depends on US-013.

`formatJobStrip`, `FooterJob` and the `footerModel` `jobs` input in `src/tui/chat/chat-status.ts`;
the new hook `src/tui/chat/use-jobs.ts`; and the `ChatApp` wiring of the strip and notice delivery,
as in Design § Host and screen. Strip tests go in the existing
`test/unit/tui/chat/chat-status.test.ts`. Screen tests go in a new `test/ui/chat/chat-jobs.test.tsx`,
using a fake `ChatHost` whose `jobs` is a stub `ChatJobs`.

### US-015 — the /jobs command and the close prompt

Workdir: packages/nax. Depends on US-014.

The `/jobs` built-in in `src/tui/chat/slash-commands.ts`, and the `confirmJobsBeforeClose` call in
`useChatKeys.close()`, as in Design § Host and screen and § Changed (`useChatKeys.ts`). Slash command
tests go in the existing `test/ui/chat/slash-commands.test.tsx`. Close tests go in a new
`test/ui/chat/chat-jobs-close.test.tsx`.

### Context Files

**US-001**
- `packages/nax/src/chat/workflow/feature-state.ts`
- `packages/nax/src/runtime/paths.ts`

**US-002**
- `packages/nax/src/chat/jobs/job-types.ts` — created by US-001, read here
- `packages/nax/src/utils/feature-name.ts`
- `packages/nax/src/config/paths/index.ts`
- `packages/nax/src/cli/bot.ts`

**US-003**
- `packages/nax/src/chat/jobs/job-types.ts` — created by US-001, read here
- `packages/nax/src/execution/status-file-read.ts`
- `packages/nax/src/execution/status-file.ts`
- `packages/nax/src/config/paths/index.ts`

**US-004**
- `packages/nax/src/prompts/builders/workflow-builder.ts`
- `packages/nax/src/prompts/index.ts`
- `packages/nax/test/unit/prompts/builders/workflow-builder.test.ts`

**US-005**
- `packages/nax/src/chat/jobs/job-store.ts` — created by US-001, read here
- `packages/nax/src/chat/jobs/job-outcome.ts` — created by US-003, read here
- `packages/nax/src/chat/ask-fallback.ts`
- `packages/nax/test/helpers/fake-clock.ts`

**US-006**
- `packages/nax/src/chat/jobs/job-runner.ts` — created by US-005, extended here
- `packages/nax/src/chat/jobs/job-store.ts` — created by US-001, read here
- `packages/nax/src/chat/jobs/job-outcome.ts` — created by US-003, read here

**US-007**
- `packages/nax/src/chat/jobs/job-runner.ts` — created by US-005, extended here
- `packages/nax/src/execution/status-file-read.ts`

**US-008**
- `packages/nax/src/chat/ask-controller.ts`
- `packages/nax/src/chat/ask-fallback.ts`
- `packages/nax/src/tui/chat/ask-card.ts`
- `packages/nax/test/unit/chat/ask-controller.test.ts`

**US-009**
- `packages/nax/src/chat/jobs/job-argv.ts` — created by US-002, read here
- `packages/nax/src/chat/jobs/job-runner.ts` — created by US-005, read here
- `packages/nax/src/chat/ask-controller.ts`
- `packages/nax/src/chat/workflow/workflow-provider.ts`
- `packages/nax/src/prd/index.ts`

**US-010**
- `packages/nax/src/chat/jobs/jobs-launch.ts` — created by US-009, extended here
- `packages/nax/src/execution/lock.ts`
- `packages/nax/src/utils/git.ts`

**US-011**
- `packages/nax/src/chat/jobs/jobs-provider.ts` — created by US-009, extended here
- `packages/nax/src/chat/jobs/job-runner.ts` — created by US-005, read here

**US-012**
- `packages/nax/src/chat/jobs/job-runner.ts` — created by US-005, read here
- `packages/nax/src/chat/chat-agents-listing.ts`
- `packages/nax/src/context/rules/rule-delivery/index.ts`
- `packages/nax-agent/src/native/session/loop-events/types.ts`

**US-013**
- `packages/nax/src/chat/chat-host.ts`
- `packages/nax/src/cli/chat.ts`
- `packages/nax/src/chat/chat-mcp.ts`
- `packages/nax/test/unit/chat/chat-host-resources.test.ts`
- `packages/nax/test/unit/cli/chat-resources.test.ts`

**US-014**
- `packages/nax/src/tui/chat/ChatApp.tsx`
- `packages/nax/src/tui/chat/chat-status.ts`
- `packages/nax/test/ui/chat/chat-app.test.tsx`

**US-015**
- `packages/nax/src/tui/chat/useChatKeys.ts`
- `packages/nax/src/tui/chat/slash-commands.ts`
- `packages/nax/src/tui/chat/AskCard.tsx`
- `packages/nax/test/ui/chat/chat-app-keys.test.tsx`

### Creates

**US-001**
- `packages/nax/src/chat/jobs/job-types.ts`
- `packages/nax/src/chat/jobs/job-store.ts`
- `packages/nax/test/unit/chat/jobs/job-store.test.ts`

**US-002**
- `packages/nax/src/chat/jobs/job-argv.ts`
- `packages/nax/test/unit/chat/jobs/job-argv.test.ts`

**US-003**
- `packages/nax/src/chat/jobs/job-outcome.ts`
- `packages/nax/test/unit/chat/jobs/job-outcome.test.ts`

**US-005**
- `packages/nax/src/chat/jobs/job-runner.ts`
- `packages/nax/test/unit/chat/jobs/job-runner.test.ts`

**US-006**
- `packages/nax/test/unit/chat/jobs/job-runner-attach.test.ts`

**US-007**
- `packages/nax/test/unit/chat/jobs/job-runner-cancel.test.ts`

**US-009**
- `packages/nax/src/chat/jobs/jobs-launch.ts`
- `packages/nax/src/chat/jobs/jobs-provider.ts`
- `packages/nax/test/unit/chat/jobs/jobs-launch.test.ts`

**US-010**
- `packages/nax/test/unit/chat/jobs/jobs-launch-busy.test.ts`

**US-011**
- `packages/nax/test/unit/chat/jobs/jobs-provider.test.ts`

**US-012**
- `packages/nax/src/chat/jobs/job-write-guard.ts`
- `packages/nax/test/unit/chat/jobs/job-write-guard.test.ts`
- `packages/nax/src/chat/jobs/jobs-listing.ts`
- `packages/nax/test/unit/chat/jobs/jobs-listing.test.ts`

**US-013**
- `packages/nax/src/chat/jobs/index.ts`
- `packages/nax/src/chat/jobs/jobs-host.ts`
- `packages/nax/test/unit/chat/chat-host-jobs.test.ts`

**US-014**
- `packages/nax/src/tui/chat/use-jobs.ts`
- `packages/nax/test/ui/chat/chat-jobs.test.tsx`

**US-015**
- `packages/nax/test/ui/chat/chat-jobs-close.test.tsx`

### Modifies

**US-001**
None. The story only adds new files.

**US-002**
None. The story only adds new files.

**US-003**
None. The story only adds new files.

**US-004**
None. `workflow-builder.ts` and the `@/prompts` barrel only gain exports, and the existing builder tests assert on `buildWorkflowInstructions` text, which is unchanged.

**US-005**
None. The story only adds new files.

**US-006**
None. The story extends a file US-005 created and adds a new test file.

**US-007**
None. The story extends a file US-005 created and adds a new test file.

**US-008**
- `packages/nax/test/ui/chat/chat-app.test.tsx` — the fake host's `asks` is an object literal `{ pending, canRemember, resolve, setMode, reset, handle, answerQuestion, onChange }` typed through `const host: ChatHost`; `ChatAskController` gains the required `requestHostApproval`, so the literal no longer typechecks (TS2741). Add an inert `requestHostApproval: async () => "deny"` member; no assertion changes.
- `packages/nax/test/ui/chat/slash-commands.test.tsx` — the fake host's `asks` is the same object literal `{ pending, canRemember, resolve, setMode, reset, handle, answerQuestion, onChange }` typed through `const host: ChatHost`; it no longer typechecks once `requestHostApproval` is required. Add an inert `requestHostApproval: async () => "deny"` member; no assertion changes.
- `packages/nax/test/ui/chat/ask-card.test.tsx` — `fakeController` builds a `const controller: ChatAskController = { handle, pending, resolve, canRemember, answerQuestion, setMode, reset, onChange }` object literal; the interface gains the required `requestHostApproval`, so the literal no longer typechecks. Add an inert `requestHostApproval: async () => "deny"` member; every card assertion in the file stays as it is (the card's calls are unchanged).

**US-009**
None. The story only adds new files.

**US-010**
None. The story extends a file US-009 created and adds a new test file.

**US-011**
None. The story extends a file US-009 created and adds a new test file.

**US-012**
None. The story only adds new files.

**US-013**
None. The host builds the jobs pieces only when `naxEntry` is supplied, and no existing host fixture supplies it, so `host-subagents.test.ts` (nax-agents last, resources' own providers passed through) and `chat-host-resources.test.ts` (loop handler events equal plugin plus rule-delivery handlers) keep passing; `ChatHost` and `ChatHostDeps` only gain optional members, so the test fakes still typecheck.

**US-014**
None. `footerModel`'s `jobs` input is optional, so existing footer tests keep their output.

**US-015**
- `packages/nax/test/ui/chat/slash-commands.test.tsx` — test "US-011 AC-15 US-024 AC-15 help lists /agents between /mcp and /quit" expects the help frame to contain the three rows mcp, agents, quit back to back (List MCP servers, List agents, Quit nax chat). The new jobs built-in now sits between agents and quit, so the expected text gains the row "/jobs  List nax jobs" between the agents row and the quit row (built-ins listed in COMMANDS order, quit last, is the invariant kept).

### Seams

- US-005 → US-003: the runner finalizes an owned job through `resolveJobOutcome` with the observed exit code. A US-005 AC drives a stubbed child exit over a real `status.json` fixture and asserts the record's state.
- US-005 → US-004: notices come from `buildJobNotice`; a US-005 AC asserts the notice starts with the builder's `[nax-jobs] job <id>` prefix.
- US-006 → US-003: re-attached jobs whose pid is dead are finalized through `resolveJobOutcome` with no exit code.
- US-010 → US-009: the busy re-check runs inside the same launch path, proven by an `approve` stub that starts a competing job before resolving `allow`.
- US-009 → US-002 / US-005 / US-008: a launch tool, run end to end over a fixture repo, calls `approve` with the built argv and calls `jobs.start` only on `allow`.
- US-013 → US-009 / US-011 / US-012: the wiring is proven from `createChatHost` with a capturing `open` (the provider ids and the frozen loop handler set the session receives) and from `chatCommand` (the `naxEntry` reaching `createChatHost`).
- US-013 → US-008: a launch card raised by a full-mode host stays in `host.asks.pending()` until resolved.
- US-014 / US-015 → US-013: the screen reads `host.jobs` and calls `host.confirmJobsBeforeClose` from the real `ChatApp` and `useChatKeys`.
- US-015 → US-012: `/jobs` prints `formatJobsListing(host.jobs.list())`, proven by typing `/jobs` into the real screen.

## Acceptance Criteria

### US-001 — job types and the job record store

- [unit] `jobsDir("/o")` returns `/o/chat-jobs`.
- [unit] `jobLogPath("/o", "run-1a2b3c4d")` returns `/o/chat-jobs/run-1a2b3c4d.log`.
- [unit] With `_jobStoreDeps.randomHex` returning `1a2b3c4d`, `newJobId("run")` returns `run-1a2b3c4d`.
- [unit] `JOB_ID_PATTERN` accepts `bot_fix-0f0f0f0f`.
- [unit] `JOB_ID_PATTERN` rejects `run-../../x`.
- [unit] `writeJobRecord(dir, job)` followed by `readJobRecords(dir)` returns one record deep-equal to `job`.
- [unit] `writeJobRecord` for an existing id replaces the record, and `readJobRecords` returns the new `state`.
- [unit] `readJobRecords(dir)` for records started at `2026-10-01T00:00:00Z` and `2026-10-02T00:00:00Z` returns the `2026-10-02` record first.
- [unit] `readJobRecords(dir)` skips a `chat-jobs/x.json` holding `not json` and still returns the valid records.
- [unit] `readJobRecords(dir)` skips a record whose `state` is `paused`.
- [unit] `readJobRecords(dir)` skips a record whose `id` is `../escape`.
- [unit] `readJobRecords(dir)` for an output dir with no `chat-jobs/` directory returns `[]`.
- [unit] After `writeJobRecord(dir, job)`, `chat-jobs/` holds no file other than `<id>.json` (the temp file was renamed into place).

### US-002 — launch input parsing and argv

- [unit] `buildJobArgv` for a plan of `f1` with spec `.nax/features/f1/spec.md`, profiles `["a", "b"]`, entry `["bun", "/n.ts"]` and repoRoot `/r` returns `["bun", "/n.ts", "plan", "-f", "f1", "--from", ".nax/features/f1/spec.md", "-d", "/r", "--profile", "a", "--profile", "b"]`.
- [unit] `buildJobArgv` for a run of `f1` with no profiles and no limits returns `["bun", "/n.ts", "run", "-f", "f1", "-d", "/r", "--headless"]`.
- [unit] `buildJobArgv` for a run of `f1` with `maxIterations` 40 and `maxCost` 12.5 ends with `"-m", "40", "--max-cost", "12.5"`.
- [unit] `buildJobArgv` for a bot_review of PR 12 with model `opus` and decisions `d.json` returns `["bun", "/n.ts", "bot", "review", "12", "-d", "/r", "--model", "opus", "--decisions", "d.json"]`.
- [unit] `buildJobArgv` for a bot_fix of PR 12 with `trust` true and `noRereview` true ends with `"--trust", "--no-rereview"`.
- [unit] `buildJobArgv` for a bot_fix of PR 12 with `trust` false includes no `--trust`.
- [unit] `parseJobInput("run", { feature: "f1" })` returns `{ kind: "run", feature: "f1", profiles: [] }`.
- [unit] `parseJobInput("run", {})` returns `{ error: "[chat] feature must be a string" }`.
- [unit] `parseJobInput("run", { feature: "../x" })` returns an `error`.
- [unit] `parseJobInput("run", { feature: "f1", profiles: "a" })` returns `{ error: "[chat] profiles must be an array of strings" }`.
- [unit] `parseJobInput("run", { feature: "f1", profiles: ["--evil"] })` returns `{ error: "[chat] profile --evil is not a valid profile name" }`.
- [unit] `parseJobInput("run", { feature: "f1", maxIterations: 0 })` returns `{ error: "[chat] maxIterations must be an integer from 1 to 1000" }`.
- [unit] `parseJobInput("run", { feature: "f1", maxIterations: 2.5 })` returns that same error.
- [unit] `parseJobInput("run", { feature: "f1", maxCost: -1 })` returns `{ error: "[chat] maxCost must be a positive number" }`.
- [unit] `parseJobInput("bot_fix", { pr: "12" })` returns a bot_fix input with `pr` 12.
- [unit] `parseJobInput("bot_fix", { pr: 0 })` returns `{ error: "[chat] pr must be a positive integer" }`.
- [unit] `parseJobInput("bot_review", { pr: 1, model: "-x" })` returns `{ error: "[chat] model -x is not a valid model id" }`.
- [unit] `parseJobInput("bot_review", { pr: 1, decisions: "../d.json" })` returns `{ error: "[chat] decisions must be a repo-relative path" }`.
- [unit] `parseJobInput("plan", { feature: "f1", spec: "/etc/passwd" })` returns `{ error: "[chat] spec must be a repo-relative path" }`.
- [unit] `parseJobInput("bot_fix", { pr: 1, trust: "yes" })` returns `{ error: "[chat] trust must be a boolean" }`.
- [unit] `parseJobInput("plan", { feature: "f1" })` returns a plan input with no `spec`.

### US-003 — job outcome from the command's records

- [unit] For a run job with pid 4242 and a `status.json` whose `run.pid` is 4242 and `run.status` is `completed`, `resolveJobOutcome(job, { exitCode: 0 }, repoRoot)` returns state `succeeded`.
- [unit] In that case it returns `cost` equal to the status file's `cost.spent`.
- [unit] In that case it returns `progress` deep-equal to the status file's `{ passed, total }`.
- [unit] For that matching status file with `run.status` `completed` and exit code 1, it returns an outcome whose `state` and `note` deep-equal `{ state: "succeeded", note: "exit code 1 disagrees with the run record" }`.
- [unit] For a matching status file with `run.status` `failed`, it returns an outcome whose `state` and `note` deep-equal `{ state: "failed", note: "run status failed" }`.
- [unit] For a matching status file with `run.status` `aborted`, it returns state `cancelled`.
- [unit] For a matching status file with `run.status` `running` (the process ended without a final write), it returns an outcome whose `state` and `note` deep-equal `{ state: "failed", note: "run status running" }`.
- [unit] For a status file whose `run.pid` is 1 (a different run), with exit code 0, it returns an outcome whose `state` and `note` deep-equal `{ state: "failed", note: "no run record for pid 4242; exit code 0" }`.
- [unit] With no status file and no exit code, it returns an outcome whose `state` and `note` deep-equal `{ state: "failed", note: "no run record for pid 4242" }`.
- [unit] For a run job with `cancelRequested` and a matching `completed` status file, it returns state `cancelled`.
- [unit] For a plan job started at T and a `prd.json` modified after T, it returns state `succeeded`.
- [unit] For a plan job started at T and a `prd.json` last modified before T, it returns an outcome whose `state` and `note` deep-equal `{ state: "failed", note: "plan wrote no prd.json" }`.
- [unit] For a plan job with no `prd.json`, it returns an outcome whose `state` and `note` deep-equal `{ state: "failed", note: "plan wrote no prd.json" }`.
- [unit] For a bot_fix job with exit code 0, it returns state `succeeded`.
- [unit] For a bot_review job with exit code 2, it returns an outcome whose `state` and `note` deep-equal `{ state: "failed", note: "exit code 2" }`.
- [unit] For a bot_review job with no exit code, it returns an outcome whose `state` and `note` deep-equal `{ state: "lost", note: "outcome unknown: exit code not observed" }`.
- [unit] `readRunProgress(job, repoRoot)` for a matching status file with progress 3 of 7 and `cost.spent` 1.2 returns `{ cost: 1.2, progress: { passed: 3, total: 7 } }`.
- [unit] `readRunProgress(job, repoRoot)` for a status file whose pid differs returns `null`.

### US-004 — job notice and jobs instruction builders

- [unit] `buildJobNotice({ id: "run-1a2b3c4d", kind: "run", target: "f1", state: "succeeded", cost: 1.234, logPath: "/o/l.log" })` returns text whose first line is `[nax-jobs] job run-1a2b3c4d (run f1) ended: succeeded cost $1.23 log /o/l.log`.
- [unit] `buildJobNotice` with `note: "exit code 2"` and no cost returns a first line containing ` (exit code 2) log `.
- [unit] `buildJobNotice` returns text whose second line includes `nax-workflow__state`.
- [unit] `buildJobsInstructions()` returns text that includes `nax-jobs__plan`, `nax-jobs__run`, `nax-jobs__bot_review` and `nax-jobs__bot_fix`.
- [unit] `buildJobsInstructions()` returns text that includes `approval card`.
- [unit] `buildJobsInstructions()` returns text that includes `[nax-jobs]`.
- [unit] `buildJobsInstructions()` returns text that includes `GitCommit`.
- [unit] `buildJobsInstructions()` returns text that includes `do not retry` (case-insensitive).
- [unit] `buildJobNotice` and `buildJobsInstructions` imported from `@/prompts` return the same text as the exports of `src/prompts/builders/workflow-builder.ts`.

### US-005 — the job runner: start, exit and notices

- [unit] `start(request)` calls `_jobRunnerDeps.spawn` with `request.argv` as its first argument.
- [unit] The spawn options `start` passes match `{ cwd: repoRoot, detached: true, stdin: "ignore" }`.
- [unit] After `start` resolves, `readJobRecords(outputDir)` returns one record whose `state`, `pid` and `sessionId` deep-equal `{ state: "running", pid: <the spawned pid>, sessionId: <the request's> }`.
- [unit] `start` calls `unref()` on the spawned child.
- [unit] The spawn options' `stdout` and `stderr` are the same numeric fd that `_jobRunnerDeps.openLog` returned for `jobLogPath(outputDir, id)`.
- [unit] `_jobRunnerDeps.closeLog` is called with that fd after the spawn returns.
- [unit] `start` on an output dir with no `chat-jobs/` directory creates it before opening the log.
- [unit] With `_jobRunnerDeps.spawn` throwing `boom`, `start` rejects with a message containing `could not start nax run: boom`.
- [unit] In that case `readJobRecords(outputDir)` returns `[]`.
- [integration] For a started run job whose stubbed child exits with code 0 over a fixture `status.json` with the job's pid and status `completed`, the record in `readJobRecords(outputDir)` has state `succeeded`.
- [integration] In that case the record has an `endedAt`.
- [unit] In that case `takeNotice()` returns text starting `[nax-jobs] job <id> (run f1) ended: succeeded`.
- [unit] `peekNotice()` called before that `takeNotice()` returns the same text.
- [unit] A second `takeNotice()` after that returns `undefined`.
- [unit] An `onChange` listener is called once when a job starts.
- [unit] That listener is called once more when the job ends.
- [unit] `owned()` holds a job between its start and its exit.
- [unit] After the job's exit, `running()` no longer holds it.

### US-006 — the job runner: attach, polling, log tail and dispose

- [unit] `attach()` over a `running` bot_review record for this repo whose pid `isProcessAlive` reports dead writes it back with state `lost`.
- [unit] In that case `takeNotice()` returns `undefined` (no notice at attach).
- [integration] `attach()` over a `running` run record whose pid is dead and whose fixture `status.json` has that pid and status `completed` writes it back with state `succeeded`.
- [unit] `attach()` over a `running` record whose pid is alive keeps it in `running()`.
- [unit] In that case `owned()` does not hold it.
- [unit] `attach()` ignores a record whose `cwd` is another repo: `list()` does not hold it.
- [unit] `attach()` loads a finished record for this repo into `list()` unchanged.
- [unit] Calling `attach()` twice reads the store once.
- [unit] With a re-attached running job, advancing the fake clock by `JOB_POLL_MS` after `isProcessAlive` turns false finalizes the job.
- [unit] In that case `takeNotice()` returns a notice that starts `[nax-jobs] job <that id>`.
- [unit] When that job's record on disk is already `succeeded` (written by its owner) at the poll that finds the pid dead, the runner keeps state `succeeded`, writes nothing and queues no notice.
- [unit] With a running run job and a fixture `status.json` whose progress becomes 2 of 5, advancing the fake clock by `JOB_POLL_MS` makes `get(id).progress` deep-equal `{ passed: 2, total: 5 }`.
- [unit] In that case an `onChange` listener is called.
- [unit] With no running job, the fake clock has no poll timer armed.
- [unit] `logTail(id, 2)` for a log holding lines `a`, `b`, `c` returns `b\nc`.
- [unit] `logTail(id)` for a log of 50 lines returns the last 40.
- [unit] `logTail(id)` for a job whose log file is missing returns `""`.
- [unit] `dispose()` with a running owned job leaves no timer armed on the fake clock.
- [unit] `dispose()` with a running owned job never calls `kill`.

### US-007 — the job runner: cancel

- [unit] `canCancel(id)` for a running owned job resolves `{ ok: true }`.
- [unit] `cancel(id)` for a running owned job calls `_jobRunnerDeps.kill` with the job's pid and `SIGINT`.
- [unit] Before that `kill`, the job's record in `readJobRecords(outputDir)` has `cancelRequested: true`.
- [unit] After `cancel(id)`, advancing the fake clock by `CANCEL_GRACE_MS` with `isProcessAlive` returning true calls `kill` with the pid and `SIGTERM`.
- [unit] After `cancel(id)`, advancing the fake clock by `CANCEL_GRACE_MS` with `isProcessAlive` returning false sends no `SIGTERM`.
- [unit] After `cancel(id)` and the child's exit, the job's state is `cancelled`.
- [unit] `canCancel(id)` for a job in state `succeeded` resolves `{ ok: false }` with a `message` containing `is not running`.
- [unit] `cancel(id)` for a job in state `succeeded` rejects with code `CHAT_JOB_NOT_RUNNING`.
- [unit] `cancel(id)` whose `kill` throws (the pid is already dead) resolves without throwing.
- [unit] `canCancel(id)` for a re-attached bot_review job resolves `{ ok: false, message: "job <id> was started by another chat and its pid cannot be verified; stop it from that chat or by hand" }`.
- [unit] `cancel(id)` for that job rejects with code `CHAT_JOB_UNVERIFIED`.
- [unit] In that case `kill` is not called.
- [integration] `canCancel(id)` for a re-attached run job whose fixture `status.json` `run.pid` equals the job's pid resolves `{ ok: true }`.
- [integration] `cancel(id)` for that job calls `kill` with `SIGINT`.
- [unit] `dispose()` after `cancel(id)` leaves no grace timer armed on the fake clock.

### US-008 — host approval asks on the chat ask controller

- [unit] `requestHostApproval({ tool: "nax-jobs__run", summary: "nax run f1", command: "c", reason: "r" })` adds one `approval_requested` event to `pending()` whose `requestId` starts with `host-`.
- [unit] That event has `tool`, `summary`, `command` and `reason` equal to the card's.
- [unit] That event's `expiresAt` equals `now + approvalTimeoutMs` as an ISO string.
- [unit] On a controller created with mode `full`, `requestHostApproval` leaves its event in `pending()` and `options.answer` is never called.
- [unit] `resolve(<host request id>, "allow_once")` resolves the promise `"allow"`.
- [unit] `resolve(<host request id>, "deny")` resolves the promise `"deny"`.
- [unit] `resolve(<host request id>, "allow_once")` never calls `options.answer`.
- [unit] After a host request resolves, its event is no longer in `pending()`, and an `onChange` listener was called.
- [unit] `canRemember(<host event>)` returns `false`.
- [unit] Resolving a host request `allow_session`, then raising an identical card, leaves the second event in `pending()` (nothing was remembered).
- [unit] Advancing the fake clock by `approvalTimeoutMs` resolves an open host request `"deny"`.
- [unit] Aborting the card's `signal` resolves the request `"deny"`.
- [unit] After that abort, the request's event is no longer in `pending()`.
- [unit] `reset()` resolves every open host request `"deny"`.
- [unit] A controller created without `approvalTimeoutMs` gives `expiresAt` equal to `now + 600000`.
- [integration] `createAskFallback` with a chain whose `prompt` answers `approve` resolves a host request `"allow"` after the fallback delay.

### US-009 — the `nax-jobs` provider: launch tools

- [unit] Its `tools(repoRoot)` resolves to tools whose `localName`s are exactly `plan`, `run`, `bot_review` and `bot_fix`.
- [unit] Each of the four tools' `description` includes `asks the user`.
- [integration] Running `run` with `{ feature: "f1" }` on a fixture repo whose `f1` has a 3-story `prd.json` calls `approve` exactly once.
- [integration] In that case the card's `tool` and `summary` deep-equal `{ tool: "nax-jobs__run", summary: "nax run f1" }`.
- [integration] In that case the card's `command` equals the run argv joined with single spaces.
- [integration] In that case, with `approve` resolving `"allow"`, `jobs.start` receives a request whose `kind`, `target` and `argv` deep-equal `{ kind: "run", target: "f1", argv: <the run argv> }`.
- [integration] In that case the result content's first line parses as JSON whose `job` and `state` deep-equal `{ job: <the started id>, state: "running" }`.
- [integration] With `approve` resolving `"deny"`, `jobs.start` is never called.
- [integration] In that case the result deep-equals `{ isError: true, content: "[chat] the user declined nax run f1; do not retry with different arguments unless the user asks" }`.
- [integration] For a run, the card's `reason` includes `stories 3 pending of 3; max iterations 20` when the provider's `maxIterations` is 20.
- [integration] For a run with `maxIterations: 2` in the input over 3 pending stories, the card's `reason` includes `warning: 3 stories pending but max iterations is 2; pass maxIterations (nax#2706)`.
- [integration] For a run with `interactionPlugin` `cli`, the card's `reason` includes `warning: this run has no channel for its own asks; they will time out`.
- [integration] For a run with `interactionPlugin` `telegram`, the card's `reason` has no line containing `no channel`.
- [integration] With `_jobsLaunchDeps.git` answering `symbolic-ref --short HEAD` with `feat/f1\n`, the card's `reason` starts with `workdir <repoRoot> on branch feat/f1`.
- [integration] With `_jobsLaunchDeps.git` exiting 1 for `symbolic-ref`, the card's `reason` first line is exactly `workdir <repoRoot>`.
- [integration] With `naxEntry` `["bun", "/n.ts"]` and no profiles, the card's `reason` lines include `nax bun /n.ts` immediately followed by `profiles (none)`.
- [integration] Running `plan` with `{ feature: "f1" }` on a fixture whose only spec is `.nax/specs/f1.md` builds an argv containing `"--from", ".nax/specs/f1.md"`.
- [integration] Running `plan` with `{ feature: "f1" }` and no spec file returns a result whose content starts `[chat] no spec for f1`.
- [integration] Running `plan` for a feature that already has a `prd.json` puts `warning: prd.json exists and will be replaced` in the card's `reason`.
- [integration] Running `run` with `{ feature: "f2" }` where `f2` has no `prd.json` returns a result deep-equal to `{ isError: true, content: "[chat] no prd.json for f2; run nax plan first" }`.
- [integration] Running `bot_fix` with `{ pr: 12, trust: true }` calls `approve` with a card whose `summary` is `nax bot fix #12`.
- [integration] Running `bot_review` with `{ pr: 12, decisions: "d.json" }` where `d.json` does not exist returns a result deep-equal to `{ isError: true, content: "[chat] decisions file d.json not found" }`.
- [unit] Running `run` with `{ feature: "f1", profiles: ["--x"] }` returns a result deep-equal to `{ isError: true, content: "[chat] profile --x is not a valid profile name" }`.
- [integration] The `signal` the tool run receives in its context is the `signal` passed to `approve`.

### US-010 — launch busy checks, lock holder and start failures

- [integration] Running `run` while `jobs.running()` holds plan job `plan-00000001` for this repo returns a result deep-equal to `{ isError: true, content: "[chat] nax plan job plan-00000001 is already running in this checkout" }`.
- [integration] In that case `approve` is never called.
- [integration] Running `plan` while `_jobsLaunchDeps.lockHolder` returns 777 returns a result deep-equal to `{ isError: true, content: "[chat] this checkout is held by nax pid 777; wait for it or stop it first" }`.
- [integration] Running `run` with an `approve` stub that, before resolving `"allow"`, makes `jobs.running()` hold run job `run-00000002` for this repo returns the busy error naming `run-00000002`.
- [integration] In that case `jobs.start` is never called.
- [integration] Running `run` with an `approve` stub that makes `lockHolder` return 888 before resolving `"allow"` returns the `held by nax pid 888` error, and `jobs.start` is never called.
- [integration] Running `bot_fix` while `jobs.running()` holds a run job for this repo still calls `approve` (bot jobs are not busy-checked).
- [unit] The real `lockHolder(repoRoot)` for a `nax.lock` holding `{"pid": <a live pid>}` returns that pid.
- [unit] The real `lockHolder(repoRoot)` for a `nax.lock` naming a pid that `isProcessAlive` reports dead returns `null`.
- [unit] The real `lockHolder(repoRoot)` for a `nax.lock` holding `not json` returns `null`.
- [unit] The real `lockHolder(repoRoot)` with no `nax.lock` returns `null`.
- [integration] Running `run` with `{ feature: "f1" }` where `f1`'s `prd.json` holds `{` returns a result whose content starts `[chat] prd.json for f1 is unreadable:`.
- [integration] Running `run` with `{ feature: "f1" }` where `jobs.start` rejects with `could not start nax run: spawn ENOENT` returns a result deep-equal to `{ isError: true, content: "[chat] could not start nax run: spawn ENOENT" }`.
- [integration] Running `run` where `jobs.start` rejects with `disk full` returns a result deep-equal to `{ isError: true, content: "[chat] could not start nax run: disk full" }`.
- [integration] Running `plan` with a feature name that passes `validateFeatureName` but that `featureDir` rejects returns an error result whose content is `featureDir`'s message.

### US-011 — the `nax-jobs` provider: list, cancel and instructions

- [unit] `createJobsProvider(options)` returns a provider with `id` `nax-jobs`.
- [unit] It has `kind` `static` and `stages` deep-equal to `["*"]`.
- [unit] Its `tools(repoRoot)` resolves to six tools whose `localName`s are `plan`, `run`, `bot_review`, `bot_fix`, `list` and `cancel`.
- [unit] The `run` tool's `inputSchema` has `required` deep-equal to `["feature"]`.
- [unit] Each of the `plan`, `run`, `bot_review` and `bot_fix` tools' `description` includes `Billed`.
- [unit] Running `list` with `{}` over a stub with 25 jobs returns JSON whose `jobs` has length 20.
- [unit] In that case the JSON's `omitted` is 5.
- [unit] In that case the first entry's `id` is the newest job's.
- [unit] Each `list` entry for a job with no `endedAt` has no `endedAt` key.
- [unit] Running `list` with `{ job: "run-1a2b3c4d" }` returns JSON whose `logTail` equals the stub `logTail` result for that id.
- [unit] Running `list` with `{ job: "x/../y" }` returns a result deep-equal to `{ isError: true, content: "[chat] invalid job id x/../y" }`.
- [unit] Running `list` with `{ job: "run-ffffffff" }` for an unknown id returns a result deep-equal to `{ isError: true, content: "[chat] unknown job run-ffffffff" }`.
- [unit] Running `cancel` with `{ job: "run-1a2b3c4d" }` for a running job calls `approve` with a card whose `tool` is `nax-jobs__cancel` and `summary` is `cancel nax run f1 (run-1a2b3c4d)`.
- [unit] In that case, with `approve` resolving `"allow"`, `jobs.cancel` is called with `run-1a2b3c4d`.
- [unit] In that case the result content is `cancel requested for job run-1a2b3c4d; SIGINT sent`.
- [unit] With `approve` resolving `"deny"`, `jobs.cancel` is never called and the result content is `[chat] the user declined to cancel job run-1a2b3c4d`.
- [unit] Running `cancel` for a job in state `failed` returns a result deep-equal to `{ isError: true, content: "[chat] job run-1a2b3c4d is not running (state failed)" }`, with no card.
- [unit] Running `cancel` for a re-attached bot_fix job returns the `was started by another chat and its pid cannot be verified` error, with no card.
- [unit] Running `cancel` with `{ job: "run-ffffffff" }` for an unknown id returns a result deep-equal to `{ isError: true, content: "[chat] unknown job run-ffffffff" }`.
- [unit] Running `cancel` with `{ job: "nope" }` returns a result deep-equal to `{ isError: true, content: "[chat] invalid job id nope" }`.
- [unit] The provider's `instructions(repoRoot)` resolves to the string `buildJobsInstructions()` returns.

### US-012 — the write guard and the jobs listing

- [unit] `createJobWriteGuard(jobs, "/r")` returns one entry with `plugin` `nax-jobs` and `event` `before_tool`.
- [unit] With `running()` holding run job `run-1a2b3c4d` whose `cwd` is `/r`, the handler for a `Write` call returns `{ kind: "block", isError: true, content: "[nax-jobs] Write refused: nax run job run-1a2b3c4d is running in this checkout; wait for it to end or cancel it" }`.
- [unit] In that state the handler returns `kind` `block` for an `Edit` call.
- [unit] In that state the handler returns `kind` `block` for a `Delete` call.
- [unit] In that state the handler returns `kind` `block` for a `GitCommit` call.
- [unit] In that state the handler returns `{ kind: "allow" }` for a `Read` call.
- [unit] In that state the handler returns `{ kind: "allow" }` for a `Bash` call.
- [unit] With `running()` holding only a bot_fix job for `/r`, the handler returns `{ kind: "allow" }` for a `Write` call.
- [unit] With `running()` holding a run job whose `cwd` is `/other`, the handler returns `{ kind: "allow" }` for a `Write` call.
- [unit] With `running()` empty, the handler returns `{ kind: "allow" }` for a `Write` call.
- [unit] With a plan job and a newer run job running for `/r`, the block content names the run job.
- [unit] `formatJobsListing([])` returns `(no jobs)`.
- [unit] `formatJobsListing` for a running run job `run-1a2b3c4d` on `f1` with progress 3 of 7, cost 1.2 and `startedAt` `2026-10-27T10:00:00Z` returns `run-1a2b3c4d  running  run f1  3/7  $1.20  2026-10-27T10:00:00Z`.
- [unit] `formatJobsListing` for a failed bot_fix job on PR 12 returns a line containing `bot_fix #12`.
- [unit] `formatJobsListing` for 23 jobs returns 20 job lines followed by `+3 more`.

### US-013 — wire jobs into the chat host and `nax chat`

- [integration] `createChatHost` with resources (catalog with one agent) and `naxEntry` `["bun", "/n.ts"]`, after `start`, opens the session with `toolProviders` whose ids, sliced to the last two, deep-equal `["nax-jobs", "nax-agents"]`.
- [integration] `createChatHost` with resources and no `naxEntry`, after `start`, opens with `toolProviders` that contain no `nax-jobs` provider.
- [integration] In that case `host.jobs` is `undefined`.
- [integration] With `naxEntry`, the loop handler set passed to `open` is frozen.
- [integration] With `naxEntry`, the last entry of that loop handler set has `plugin` `nax-jobs` and `event` `before_tool`.
- [integration] With `naxEntry`, while `host.jobs` holds a running run job for the host's `repoRoot` (stubbed spawn), calling that last handler with a `Write` call returns `kind` `block`.
- [integration] With `naxEntry`, a fixture `chat-jobs/` record for this repo in state `running` whose pid is dead is finalized during `host.start`, so `host.jobs.list()[0].state` is not `running`.
- [integration] The same attach happens on `host.resume`.
- [integration] With `naxEntry` and a host started in mode `full`, running the `nax-jobs` provider's `run` tool on a fixture feature leaves one event with `tool` `nax-jobs__run` in `host.asks.pending()` until it is resolved.
- [integration] Resolving that event `deny` through `host.asks.resolve` makes the tool return the declined error.
- [integration] With `config.execution.approvalTimeout` 30000 and `now` fixed at T, that event's `expiresAt` is T plus 30 seconds.
- [integration] `host.confirmJobsBeforeClose()` with no owned running job resolves without adding anything to `host.asks.pending()`.
- [integration] With one owned running job, `host.confirmJobsBeforeClose()` adds an event with `tool` `nax-jobs__close` to `host.asks.pending()`.
- [integration] Resolving that event `allow_once` calls `cancel` for the owned job.
- [integration] With two owned jobs whose first `cancel` rejects, resolving that event `allow_once` still calls `cancel` for the second, and logs one `warn`.
- [integration] Resolving that event `deny` resolves `confirmJobsBeforeClose` without calling `cancel`.
- [integration] `host.close()` with a running owned job never calls `cancel`.
- [integration] `host.close()` calls the runner's `dispose`.
- [integration] `chatCommand({ dir }, deps)` with `deps.naxEntry` returning `["bun", "/n.ts"]` hands `createChatHost` deps whose `naxEntry` deep-equals `["bun", "/n.ts"]`.
- [integration] `chatCommand({ dir }, deps)` with `deps.naxEntry` returning `undefined` hands `createChatHost` deps with no `naxEntry`.
- [unit] `createChatMcp` for MCP servers `{ "nax-jobs": <stdio server> }` returns `providers` whose ids do not include `nax-jobs`.
- [unit] In that case `state.diagnostics` has an entry whose `message` is `[resources] mcp server id nax-jobs is reserved`.
- [integration] The `nax-jobs` provider the host hands to `open` has `instructions` resolving to text that includes `nax-jobs__run`.

### US-014 — footer job strip and end notices

- [unit] `formatJobStrip([{ kind: "run", target: "f1", progress: { passed: 3, total: 7 }, cost: 1.2 }])` returns `run f1 3/7 $1.20`.
- [unit] `formatJobStrip([{ kind: "plan", target: "f1" }])` returns `plan f1`.
- [unit] `formatJobStrip([{ kind: "bot_fix", target: "12" }])` returns `bot_fix #12`.
- [unit] `formatJobStrip` for four jobs returns the first two parts joined with ` · `, followed by ` +2`.
- [unit] `formatJobStrip([{ kind: "plan", target: "a-very-long-feature-name" }])` returns `plan a-very-long-fea…`.
- [unit] `footerModel` with `jobs` holding one plan job for `f1` returns a `right` line whose first span text is `plan f1`.
- [unit] `footerModel` with `jobs` empty returns a `right` line equal to the one it returns with no `jobs` input.
- [integration] Rendering `ChatApp` with a fake host whose `jobs.running()` returns one run job for `f1` shows a footer containing `run f1`.
- [integration] When the fake host's `jobs` emits a change while idle and `peekNotice()` returns `[nax-jobs] job run-1 (run f1) ended: succeeded`, the screen calls `host.send` once with that text.
- [integration] In that case `takeNotice()` is called once, after `host.send` was called.
- [integration] When the change arrives while a turn is running, `host.send` is not called for the notice until that turn ends, and then it is called once.
- [integration] When the change arrives while an ask card is shown, `host.send` is not called for the notice until the card is resolved.
- [integration] When the change arrives while a mode switch is in flight (`keys.canControl()` false), `host.send` is not called for the notice and `takeNotice()` is not called.
- [integration] With two queued notices, the screen sends them in queue order, one turn each.
- [integration] When the change arrives while idle but a turn is already sending (`deliver` returns `false`), `takeNotice()` is not called and the notice is sent at the next idle moment.

### US-015 — the /jobs command and the close prompt

- [integration] Typing `/jobs` with a fake host whose `jobs.list()` holds one job shows the `formatJobsListing` line for it, and `host.send` is not called.
- [integration] Typing `/jobs` with a fake host that has no `jobs` shows `jobs are not available in this session`.
- [integration] `/help` lists `/jobs  List nax jobs` between `/agents` and `/quit`.
- [integration] Typing `/quit` calls `host.confirmJobsBeforeClose` before `host.close`.
- [integration] Pressing ctrl+c on an idle screen calls `host.confirmJobsBeforeClose` before `host.close`.
- [integration] With `confirmJobsBeforeClose` pending, a second ctrl+c calls `confirmJobsBeforeClose` no second time.
- [integration] With `confirmJobsBeforeClose` rejecting `boom`, the screen shows `boom` and `host.close` is not called.
- [integration] With a fake host whose `confirmJobsBeforeClose` raises a real `asks.requestHostApproval` card (`createChatAskController`), typing `/quit` shows the card, answering it with `1` (yes) through the real `AskCard` resolves it, and `host.close` is then called.
- [integration] In that flow, while the card is shown, `host.close` has not been called.
- [integration] A fake host with no `confirmJobsBeforeClose` still closes on `/quit`.
