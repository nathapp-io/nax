# SPEC: chat-workflow-chain — the user approves a full run once, and the chat session drives its steps

## Summary

`nax chat` gains full-run approval, called a **chain**. The agent proposes an ordered list of
billed steps, for example `nax plan` → `nax run` → `nax bot review` → `nax bot fix`, through one
new tool, `nax-jobs__chain`. That tool shows one approval card listing every step's exact command,
the condition each step must meet before it starts, and an optional cost cap. The user's yes on
that card is the explicit approval of the full run.

While the chain is active, the agent still calls each step's existing launch tool
(`nax-jobs__plan`, `nax-jobs__run`, `nax-jobs__bot_review`, `nax-jobs__bot_fix`). The host skips
that step's card only when all of these hold:

- the call is the next listed step, with exactly the approved command;
- the previous step's job ended `succeeded`, read from its job record;
- the step's in-session check, if the card named one, was recorded as passed with the new
  `nax-jobs__chain_check` tool;
- the chat session is still the one that approved the chain.

Any mismatch stops the chain, and that call shows the normal per-step card. A step that ends in any
state but `succeeded`, a failed check, the cost cap being reached between steps,
`nax-jobs__chain_stop`, or closing the chat also stops the chain. A stopped chain never restarts.

This is feature 3 of 3 of slice 2 (design
`docs/superpowers/specs/2026-10-27-nax-chat-workflow-dispatch-slice2-design.md`, section 4.7).
Feature 1, `chat-workflow-state`, shipped `nax-workflow__state` (#2722). Feature 2,
`chat-workflow-dispatch`, shipped the `nax-jobs` provider, its approval card and background jobs
(#2723).

## Motivation

The main nax roadmap is one `nax chat` session that takes the user from a brainstorm to an open PR
(user, 2026-10-24). After feature 2, the session can start each billed step, but every step needs
its own card. A plan → run → review → fix loop therefore needs the user at the keyboard four
times, often an hour apart.

The user ruled on 2026-10-27 (design Q1): by default the agent proposes each billed step and waits
for its card. **It may carry on through the steps without asking again only when the human has
explicitly approved the full run.** The standing rule still holds: no billed launch without the
user's explicit yes. That yes is now either the step's own card or the chain card that lists the
step. A plain chat message such as "go ahead" is not an approval. Only the card is.

The PR a run publishes does not exist when the user approves the chain. By user ruling
(2026-10-28), the agent is the orchestrator and handles it: a bot step may leave its PR open on
the card, and the agent supplies the PR number when it calls that step. The host checks every
other argument exactly. Also by user ruling (2026-10-28), the cost cap is checked between steps,
from the cost the chain's finished jobs recorded.

## Design

### Approach

- Everything new lives in the existing module `packages/nax/src/chat/jobs/`, next to the feature
  2 code it extends. Five new files: `chain-types.ts` (types and constants), `chain-store.ts`
  (atomic record writes), `chain-argv.ts` (step input and argv), `chain-controller.ts` (the
  chain's state machine), and `chain-tools.ts` (the three new provider tools and the card text).
- **One chain at a time, per chat host, in memory.** `createChainController` holds at most one
  current chain. It is `active` until it becomes `completed` or `stopped`, and a stopped or
  completed chain never becomes active again. The chain record is also written to
  `<outputDir>/chat-chains/<id>.json`, for audit and so every job it starts can link to it. Records
  are never read back into an active chain: a new chat, a `--resume` or a crash starts with no
  chain.
- **Approval is the card only.** A chain becomes active only inside `nax-jobs__chain`, after
  `approve(card)` (the feature 2 `requestHostApproval` port) resolves `"allow"`. A deny, a timeout
  or an abort activates nothing. The card is never remembered, as in feature 2.
- **Fail closed on the record.** `activate` writes the record before the chain becomes active. If
  that write fails, no chain is active and the tool returns an error. `activate` marks itself in
  flight synchronously, before its first `await`, so a second `activate` while one is in flight or
  a chain is active rejects `CHAT_CHAIN_ACTIVE`; two chain cards approved in parallel therefore
  activate at most one chain. Later record writes (a step
  started, a check, a stop) are best effort: a failure logs a warning, and the in-memory state
  stays authoritative for this session.
- **The agent drives; the host admits.** No new process or timer starts steps. The agent wakes on
  the feature 2 job notice, runs any in-session check itself (for example the PRD fidelity check,
  `spec-review --prd`), records it, and calls the next launch tool. Inside `launchJob`
  (`jobs-launch.ts`), after the input is parsed, the target is prepared and the early busy checks
  pass, the launch asks `chains.admit(...)`. A call refused by the early busy checks (a running
  plan or run job, or a live `nax.lock`) returns the feature 2 error and never reaches `admit`, so
  the chain is unchanged. The launch skips `approve` only on an `auto` admission, with two
  exceptions handled in `launchJob`:
  - an `auto` run step whose pending stories exceed its iteration limit is not started. The
    private `Prepared` type gains `overLimit?: { readonly pending: number; readonly limit: number }`,
    which `prepareRun` sets when `pending > limit` (next to its existing warning string), and
    `launchJob` reads that field, never the string: `launchJob` calls
    `chains.stop("step <N>: <pending> stories pending but max iterations is <limit> (nax#2706)")`
    and continues as a `card` admission whose note is `chain <id> stopped: <that reason>`;
  - the auto result's content is `{"job":"<job id>","state":"running","log":"<log path>"}`, a
    newline, `started as step <N> of chain <id>; no card (approved by the chain card)`, then each
    other prepared detail (for example the no-ask-channel warning) on its own line, then
    `A [nax-jobs] notice arrives when it ends.`
  On the auto path, `startApproved` re-checks `chains.isActive(chainId)` synchronously right before
  `jobs.start`, after its own awaits. If the chain stopped in between (a `chain_stop`, a close),
  nothing starts and the result is the error `[chat] chain <id> stopped before step <N> started; nothing started`.
  When the late busy re-check or the spawn fails after an `auto` admission, `launchJob` calls
  `chains.startFailed(chainId, N, <the error content without its [chat] prefix>)`.
- **Admission order** (`admit`, synchronous, so two calls in the same tick cannot both be
  admitted). When there is no active chain, the result is `card` with no note. Otherwise the checks
  run in this order, and the first that fails stops the chain with that reason and returns `card`
  with the note `chain <id> stopped: <reason>`:
  1. the job-end rules of § Job-end transitions are applied first, so a step that already ended
     badly stops the chain even before its change event arrives;
  2. the current `sessionId()` equals the chain's `sessionId`: else reason `chat session changed`.
     `active()`, `recordCheck` and `summary()` apply this same check first, so after `/clear`,
     `/new` or `/resume` the old chain reads as stopped everywhere (and a new chain may be
     proposed) without waiting for a launch call;
  3. a next step exists and its `kind` and argv equal the call's
     (`resolveStepArgv(step.argv, step.prIndex, pr)` compared token by token): else reason
     `off-card step`;
  3b. for a step proposed without a PR, when an earlier PR-less bot step of this chain already
     fixed the chain's `pr`, the call's `pr` equals it: else reason
     `PR <pr> differs from PR <chain pr> the chain already uses`;
  4. for step N > 1, the job of step N-1 is in state `succeeded`: else reason
     `step <N-1> has not succeeded`;
  5. if step N has `checkBefore`, a check is recorded for it with `passed: true`: else reason
     `check "<checkBefore>" not recorded`.
  When check 1 completes the chain (its last step already succeeded), `admit` returns `card` with no
  note; when check 1 stops it, the note carries that stop reason. On success the step is reserved at once (the next admit sees step N+1 as next). For a step
  proposed without a PR, the call's `pr` becomes the chain's `pr` if none was set. The result is
  `{ kind: "auto", chainId, step: N, approvedAt: chain.approvedAt }`.
- **Cost cap** (user, 2026-10-28). `spent` is the sum of `cost` over the jobs the chain started, read
  through `jobs.get`. A job with no `cost` counts as 0: only `run` jobs record cost (feature 2), so
  plan and bot costs are not counted, and the card says so. The cap is checked when a step's job
  ends, in § Job-end transitions. It never interrupts a running step. A `run` step's own
  `--max-cost`, which the card shows, is the limit inside one step.
- **The PR of a bot step** (user, 2026-10-28). A chain's bot step may omit `pr`. Its stored argv then
  holds `CHAIN_PR_PLACEHOLDER` (`"<pr>"`) where the PR number goes, and the card says the agent
  chooses the PR when the step starts. On the call, the host substitutes the call's `pr` at the
  step's `prIndex` only (never anywhere else) and compares every token. A bot step that names `pr`
  on the card must be called with that PR. The first PR-less bot step to start fixes the chain's
  PR, and every later PR-less bot step of that chain must use the same PR (Claude, within the
  ruling: the agent picks the PR once per chain).
- **Job records link the chain.** `ChatJob` gains optional `chainId` and `chainStep`, and
  `StartJobRequest` gains the same optional fields. The runner already spreads the request into the
  record, so an auto-admitted job's record carries both. A launch outside a chain omits both keys
  rather than passing `undefined`. Its `approvedAt` is the chain's
  `approvedAt`, the moment the user approved the full run.
- **Notices.** The feature 2 job notice gains a third line for a chain job, telling the agent to
  read the chain's state with `nax-jobs__list`. The provider's instruction text gains three lines.
  Both are prompts, so they come from `src/prompts/builders/workflow-builder.ts`.
- **Close.** `createHostJobs().confirmClose` stops the active chain with reason `the chat closed`
  before anything else, whether or not jobs are still running. A kept job keeps running in the
  background, and the chain does not start its next step (design 4.3).
- **Errors.** New `NaxError` codes, all with `stage: "chat"`: `CHAT_CHAIN_INVALID_ID`,
  `CHAT_CHAIN_WRITE_FAILED`, `CHAT_CHAIN_ACTIVE`. `check:nax-error` has a zero baseline.
- **Sizes.** `jobs-provider.ts` (114 lines) gains only the registration of the three tools, and the
  tools live in `chain-tools.ts`. `jobs-launch.ts` (206 lines) gains the admission branch.
  `chat-host.ts` (566 lines, held under the 600-line limit) does not change.

### Integration (extends existing code)

Read only (verified on `main` `3b3262022`):

- `ChatJobs` (`src/chat/jobs/job-runner.ts:27-52`): `get(id): ChatJob | undefined`,
  `onChange(listener: () => void): () => void`, `start(request: StartJobRequest): Promise<ChatJob>`.
  `start` builds the record as `{ ...request, argv, schemaVersion: 1, id, logPath, cwd, pid, startedAt, state: "running" }`
  (`job-runner.ts:145-155`), so any field added to `StartJobRequest` reaches the record. `emit()`
  calls listeners synchronously (`job-runner.ts:102`), and `finalize` calls it after a terminal
  record is set (`job-runner.ts:211`).
- `ChatJobState = "running" | "succeeded" | "failed" | "cancelled" | "lost"` (`job-types.ts:2`).
- `JobLaunchInput`, `parseJobInput(kind, raw)` and `buildJobArgv(input, { naxEntry, repoRoot })`
  (`src/chat/jobs/job-argv.ts:7-29,131-189`). A bot argv puts the PR at index
  `naxEntry.length + 2` (`[...naxEntry, "bot", "review"|"fix", String(pr), "-d", repoRoot, ...]`).
- `HostApprovalCard = { tool, summary, command?, reason, signal? }` and
  `requestHostApproval(card): Promise<"allow" | "deny">` (`src/chat/ask-controller.ts:8-14,40`).
- `writeJobRecord` / `readJobRecords` (`src/chat/jobs/job-store.ts`), whose `isJobRecord` guard
  keeps fields it does not check. `JOB_ID_PATTERN` (`job-types.ts:31`).
- `NaxError(message, code, context)` from `@/errors`; `getLogger()` from `@/logger`;
  `errorMessage` from `@nathapp/nax-agent/internal`.
- `ProviderTool`, `ToolResult`, `ToolProvider` from `@nathapp/nax-agent`.

Changed. The baseline only locates the code. The target is the interface to implement.

- `ChatJob` (`src/chat/jobs/job-types.ts`).
  - Baseline: no chain fields.
  - Target: adds `readonly chainId?: string` and `readonly chainStep?: number` (1-based).
- `StartJobRequest` (`src/chat/jobs/job-runner.ts:20-26`).
  - Baseline: `{ kind, target, argv, sessionId, approvedAt }`.
  - Target: adds `readonly chainId?: string; readonly chainStep?: number`.
- `JobsProviderOptions` (`src/chat/jobs/jobs-provider.ts:10-19`).
  - Baseline: `{ repoRoot, naxEntry, maxIterations, interactionPlugin, jobs, approve, sessionId, now }`.
  - Target: adds `readonly chains?: ChatChains`. When it is absent, the provider and the launch
    path behave exactly as in feature 2.
- `createJobsProvider(options)` (`jobs-provider.ts:92-114`).
  - Baseline: tools `plan, run, bot_review, bot_fix, list, cancel`; `list` with no `job` returns
    `{ jobs, omitted }`.
  - Target: when `options.chains` is set, tools `plan, run, bot_review, bot_fix, list, cancel, chain, chain_check, chain_stop`,
    and `list` with no `job` returns `{ jobs, omitted, chain }`, where `chain` is
    `options.chains.summary()`.
- `launchJob(request, options)` (`src/chat/jobs/jobs-launch.ts:167-201`) and its private
  `startApproved(input, argv, options)` (`:51-81`). The early busy checks are at `:177-180`, before
  any approval, and `test/unit/chat/jobs/jobs-launch-busy.test.ts` pins that order; the late
  re-check inside `startApproved` is at `:56-63`. `preparePlan` (`:86-111`) and `prepareTarget`
  are private.
- New export from `jobs-launch.ts`:
  `resolvePlanSpec(feature: string, spec: string | undefined, options: Pick<JobsProviderOptions, "repoRoot">): Promise<{ readonly spec: string; readonly prdExists: boolean } | { readonly error: string }>`.
  It holds the spec-candidate lookup and the `prd.json` existence check that `preparePlan` does
  today, through `_jobsLaunchDeps.exists`, with the same error text; `preparePlan` calls it and
  keeps its `warning: prd.json exists and will be replaced` detail. The chain tool calls it for plan
  steps only, and never calls `prepareRun` at chain time (a plan → run chain has no `prd.json`
  yet).
  - Baseline: parse → prepare → busy check → `approve` → `startApproved`.
  - Target: parse → prepare → early busy check → `options.chains?.admit({ kind, argv, pr })` → on
    `auto`, the exceptions of § Approach, then `startApproved` with the chain fields and no
    `approve`; on `card`, `approve` as before, with the admission's `note` (when present) as the
    last line of the card's `reason`.
- `JobNoticeInput` and `buildJobNotice(input)` (`src/prompts/builders/workflow-builder.ts:16-34`).
  - Baseline: two lines.
  - Target: `JobNoticeInput` adds `readonly chainId?: string; readonly chainStep?: number`. With
    `chainId` set, the notice has a third line (§ Notice and instruction text); without it, the
    output is unchanged.
- `buildJobsInstructions()` (`workflow-builder.ts:36-45`).
  - Baseline: five lines.
  - Target: the same five lines, then three chain lines (§ Notice and instruction text).
- `createHostJobs(options)` (`src/chat/jobs/jobs-host.ts:20-54`).
  - Baseline: returns `{ jobs, provider, guard, confirmClose }`.
  - Target: also builds `chains = createChainController({ outputDir, cwd: repoRoot, jobs, sessionId, now })`, passes
    it to `createJobsProvider`, returns `{ jobs, chains, provider, guard, confirmClose }`, and
    `confirmClose` first calls `chains.stop("the chat closed")`.

### Data shapes

```ts
// src/chat/jobs/chain-types.ts
export const CHAIN_ID_PATTERN = /^chain-[0-9a-f]{8}$/;
export const CHAIN_MAX_STEPS = 6;
export const CHAIN_CHECK_MAX_LENGTH = 200;
export const CHAIN_PR_PLACEHOLDER = "<pr>";

export type ChainState = "active" | "completed" | "stopped";

export interface ChainCheck {
  readonly passed: boolean;
  readonly note: string;
  readonly at: string;
}

export interface ChainStep {
  readonly kind: ChatJobKind;
  /** Exact argv; a bot step proposed without a PR holds CHAIN_PR_PLACEHOLDER where the PR goes. */
  readonly argv: readonly string[];
  /** Index of CHAIN_PR_PLACEHOLDER in argv; set only for a bot step proposed without a PR. */
  readonly prIndex?: number;
  /** Feature name, the PR as a decimal string, or "" when the agent chooses the PR. */
  readonly target: string;
  /** An in-session check the agent must record as passed before this step starts. */
  readonly checkBefore?: string;
  readonly check?: ChainCheck;
  /** Set once the step's job started. */
  readonly jobId?: string;
}

export interface ChatChain {
  readonly schemaVersion: 1;
  readonly id: string;
  /** The chat session that approved it. */
  readonly sessionId: string;
  readonly cwd: string;
  readonly steps: readonly ChainStep[];
  readonly costCap?: number;
  /** The PR fixed by the first PR-less bot step that started. */
  readonly pr?: number;
  readonly approvedAt: string;
  readonly state: ChainState;
  readonly stopReason?: string;
  readonly endedAt?: string;
}
```

```ts
// src/chat/jobs/chain-argv.ts
/** Like JobLaunchInput, except a bot step may omit pr. */
export type ChainStepInput =
  | Exclude<JobLaunchInput, { kind: "bot_review" | "bot_fix" }>
  | (Omit<Extract<JobLaunchInput, { kind: "bot_review" }>, "pr"> & { readonly pr?: number })
  | (Omit<Extract<JobLaunchInput, { kind: "bot_fix" }>, "pr"> & { readonly pr?: number });

export function parseChainStepInput(kind: ChatJobKind, raw: Record<string, unknown>): ChainStepInput | { readonly error: string };
export function buildChainStepArgv(input: ChainStepInput & { readonly spec?: string },
  ctx: { readonly naxEntry: readonly string[]; readonly repoRoot: string }): readonly string[];
/** Replaces the token at prIndex with String(pr); returns argv unchanged when prIndex or pr is undefined. */
export function resolveStepArgv(argv: readonly string[], prIndex: number | undefined, pr?: number): readonly string[];
export const CHAIN_STEP_FIELDS: Readonly<Record<ChatJobKind, readonly string[]>>;
```

- `CHAIN_STEP_FIELDS` lists the input keys each kind accepts, the same keys as the feature 2 launch
  tool schemas: plan `feature, spec, profiles`; run `feature, profiles, maxIterations, maxCost`;
  bot_review `pr, profiles, model, decisions`; bot_fix `pr, profiles, model, trust, noRereview`.
- `parseChainStepInput` first rejects any key of `raw` not in `CHAIN_STEP_FIELDS[kind]` with
  `[chat] unknown field <key>`, so nothing the card does not show can reach argv. It then
  delegates to `parseJobInput`. For a bot kind with `raw.pr === undefined`, it parses with the rest
  of `raw` and returns the input without `pr`. A bot `pr` that is present but invalid gives the
  same error as `parseJobInput`.
- `buildChainStepArgv` returns `buildJobArgv(input, ctx)` when the input has every field. For a bot
  step without `pr`, it returns the argv `buildJobArgv` gives for `pr: 1`, with the token at
  index `ctx.naxEntry.length + 2` replaced by `CHAIN_PR_PLACEHOLDER`; the caller stores that
  index as the step's `prIndex`.

```ts
// src/chat/jobs/chain-store.ts
export const CHAT_CHAINS_DIR = "chat-chains";
export const _chainStoreDeps = { randomHex, randomUUID, file: Bun.file, write: Bun.write, mkdir, rename, unlink };
export function chainsDir(outputDir: string): string;              // <outputDir>/chat-chains
export function newChainId(): string;                               // chain-<8 hex>
export function writeChainRecord(outputDir: string, chain: ChatChain): Promise<void>; // temp file + rename
export function readChainRecord(outputDir: string, id: string): Promise<ChatChain | null>;
```

`writeChainRecord` and `readChainRecord` mirror `writeJobRecord` / `readRecord` in `job-store.ts`:
an id that fails `CHAIN_ID_PATTERN` is rejected before any write; a failed write removes the temp
file and throws `CHAT_CHAIN_WRITE_FAILED`; a missing or non-JSON file reads as `null`.

```ts
// src/chat/jobs/chain-controller.ts
export interface ChainLaunch {
  readonly kind: ChatJobKind;
  readonly argv: readonly string[];
  readonly pr?: number;
}
export type ChainAdmission =
  | { readonly kind: "card"; readonly note?: string }
  | { readonly kind: "auto"; readonly chainId: string; readonly step: number; readonly approvedAt: string };

export interface ChainSummary {
  readonly id: string;
  readonly state: ChainState;
  /** 1-based index of the next step to start; absent when none is left or the chain is not active. */
  readonly next?: number;
  readonly steps: readonly {
    readonly step: number;
    readonly kind: ChatJobKind;
    readonly argv: readonly string[];
    readonly checkBefore?: string;
    readonly check?: ChainCheck;
    readonly job?: string;
    readonly jobState?: ChatJobState;
  }[];
  readonly costCap?: number;
  readonly spent: number;
  readonly stopReason?: string;
}

export interface ChatChains {
  active(): ChatChain | undefined;
  /** Writes the record, then makes the chain active. Rejects CHAT_CHAIN_ACTIVE or CHAT_CHAIN_WRITE_FAILED. */
  activate(proposal: { readonly steps: readonly ChainStep[]; readonly costCap?: number }): Promise<ChatChain>;
  admit(launch: ChainLaunch): ChainAdmission;
  /** True while chainId is the current chain and it is active. */
  isActive(chainId: string): boolean;
  started(chainId: string, step: number, jobId: string): void;
  startFailed(chainId: string, step: number, message: string): void;
  recordCheck(step: number, passed: boolean, note: string): { readonly ok: true } | { readonly ok: false; readonly message: string };
  stop(reason: string): ChatChain | undefined;
  /** The current chain (active, completed or stopped), or null before the first activation. */
  summary(): ChainSummary | null;
  dispose(): void;
}

export interface ChainControllerOptions {
  readonly outputDir: string;
  readonly cwd: string;
  readonly jobs: Pick<ChatJobs, "get" | "onChange">;
  readonly sessionId: () => string;
  readonly now: () => Date;
}
export function createChainController(options: ChainControllerOptions): ChatChains;
```

- `activate` records `sessionId: options.sessionId()`, `cwd: options.cwd`,
  `approvedAt: options.now().toISOString()` and `state: "active"`.
- `stop(reason)` on an active chain sets `state: "stopped"`, `stopReason: reason` and `endedAt`,
  writes the record and returns the chain; with no active chain it returns `undefined` and writes
  nothing.
- `started(chainId, step, jobId)` sets `steps[step-1].jobId` and writes the record, also when the
  current chain stopped in the meantime (the job did start, and the record keeps it for audit). It
  is a no-op when `chainId` is not the current chain. `jobs.start` emits its change before
  `started` runs, so a job that ends within that window is caught by check 1 of the next `admit`.
- `startFailed(chainId, step, message)` stops the chain with reason
  `step <step> could not start: <message>`.
- `recordCheck(step, passed, note)` checks, in order: an active chain exists (else
  `no active chain`); `step` is the next step (else `step <step> is not the next step`); that step
  has `checkBefore` (else `step <step> has no check to record`). It then stores
  `{ passed, note, at }` on the step and writes the record. With `passed: false`, it also stops the
  chain with reason `check "<checkBefore>" did not pass: <note>`.

### Job-end transitions

The controller subscribes to `jobs.onChange` at creation, and `admit` applies the same rules first.
For the active chain, take the last step that has a `jobId`, and that job's state from `jobs.get`:

- state `running`, or the job unknown: nothing changes;
- `failed`, `cancelled` or `lost`: stop, reason `step <N> ended <state>`;
- `succeeded` and it is the last step: state `completed`, `endedAt` set, record written;
- `succeeded`, more steps remain, `costCap` set and `spent >= costCap`: stop, reason
  `cost cap $<cap, 2 decimals> reached: spent $<spent, 2 decimals>`;
- `succeeded` otherwise: nothing changes.

A chain that is no longer active is never changed again, so a repeated change event writes nothing.
`dispose()` removes the listener.

### The chain tools

`createChainTools({ ...JobsProviderOptions, chains })` in `chain-tools.ts` returns three
`ProviderTool`s. `createJobsProvider` appends them after `cancel` when `options.chains` is set.

**`chain`.** Input schema: `{ steps: array of { kind: string, input: object, checkBefore?: string }, costCap?: number }`,
`required: ["steps"]`, `additionalProperties: false`. Validation, in this order, with no card on
any error:

1. `chains.active()` is defined: `[chat] chain <id> is already active; stop it with nax-jobs__chain_stop first`;
2. `steps` is not an array of 1 to `CHAIN_MAX_STEPS` items: `[chat] a chain needs 1 to 6 steps`;
3. `costCap` is present and not a positive finite number: `[chat] costCap must be a positive number`;
4. per step N, in order: a step that is not an object, or whose `input` is missing or is not a
   plain object (null and arrays included), gives `[chat] step N: input must be an object`; a
   `kind` that is not one of the four launch kinds (a non-string included) gives
   `[chat] step N: unknown kind <kind>`; a `parseChainStepInput` error (an unknown input field
   included) gives `[chat] step N: <error without its [chat] prefix>`; a
   `checkBefore` that is not a string of 1 to `CHAIN_CHECK_MAX_LENGTH` characters gives
   `[chat] step N: checkBefore must be 1 to 200 characters`;
5. per plan step N, `resolvePlanSpec` resolves the spec (the feature 2 candidate order); its
   error gives `[chat] step N: <error without its [chat] prefix>`, for example
   `[chat] step N: no spec for <feature>; looked for <paths>`. Run and bot steps get no target
   check at chain time; their launch call runs the full feature 2 preparation.

Then one card through `approve`:

- `tool`: `nax-jobs__chain`;
- `summary`: `full run of <N> steps: <step labels joined by " → ">`, where a label is
  `nax plan <f>`, `nax run <f>`, `nax bot review #<pr>`, `nax bot fix #<pr>`, or
  `nax bot review (PR chosen by the agent)` / `nax bot fix (PR chosen by the agent)` without a PR;
- `command`: each step's argv joined by spaces, one step per line;
- `reason`, one line each: `workdir <repoRoot>[ on branch <branch>]`; `nax <naxEntry joined>`; then
  per step `<N>. <label> — starts after: <condition>`, where the condition is `you approve this card`
  for step 1 and `step <N-1> succeeded` otherwise, with ` and check "<checkBefore>" passed`
  appended when the step has one; for a bot step without a PR, the line ends
  ` — the agent picks the PR when the step starts`; then the cost line,
  `cost cap $<cap, 2 decimals>, checked between steps; plan and bot job costs are not counted` or
  `no cost cap`; then one warning line per plan step whose feature already has a `prd.json`,
  `warning: step <N> replaces the existing prd.json for <feature>`; then, when the chain has a run
  step and the interaction plugin is `cli`,
  `warning: run steps have no channel for their own asks; they will time out`; then the fixed line
  `Steps run in this order, each once. A failed step or check, a different step, the cost cap, a cancel or closing the chat stops the chain.`;
- `signal`: the tool call's `ctx.signal`.

On `"deny"`: error `[chat] the user declined the chain; propose steps one at a time`. On
`"allow"`: `chains.activate({ steps, costCap })`. If that rejects with `CHAT_CHAIN_ACTIVE` (another
chain card was approved while this one was open): `[chat] another chain became active while this card was open; this one is not active`.
If it rejects for any other reason: `[chat] could not save the chain: <message>; it is not active`. Otherwise the result content is
`{"chain":"<id>","state":"active","next":1}`, then a newline and
`Call step 1 now with exactly the approved arguments.`

**`chain_check`.** Input `{ step: integer, passed: boolean, note: string }`, all required. Calls
`chains.recordCheck`. `{ ok: false, message }` gives error `[chat] <message>`. `{ ok: true }` gives
`check recorded for step <step>`, plus `; the chain stopped` when `passed` was `false`.

**`chain_stop`.** Input `{}`. No card: stopping a chain only removes autonomy and never cancels a
job. With an active chain: `chains.stop("stopped by the agent")`, result
`chain <id> stopped; running jobs keep running`. Without one: error `[chat] no active chain`.

### Notice and instruction text

`buildJobNotice` third line for a job with `chainId` and `chainStep`:

`This job is step <chainStep> of chain <chainId>; call nax-jobs__list to see whether the chain continues, and if it does, call the next step's launch tool with exactly the approved arguments (no card is shown for it).`

`buildJobsInstructions` keeps its five lines, then adds:

1. `` `nax-jobs__chain` proposes a full run: an ordered list of billed steps on one approval card. Only the user's yes on that card approves it; a chat message such as "go ahead" does not. ``
2. `` While a chain is active, call each step's launch tool with exactly the approved arguments, one step at a time, after the previous step succeeded; a different call stops the chain and shows a normal card. ``
3. `` Before a step that names a check, run that check yourself and record its verdict with `nax-jobs__chain_check`; stop the chain with `nax-jobs__chain_stop` when the user asks. ``

### Failure Handling

| Condition | Behaviour |
|---|---|
| `nax-jobs__chain` while a chain is active | error `[chat] chain <id> is already active; stop it with nax-jobs__chain_stop first`; no card |
| `steps` empty, not an array, or longer than 6 | error `[chat] a chain needs 1 to 6 steps`; no card |
| a step kind outside plan/run/bot_review/bot_fix | error `[chat] step N: unknown kind <kind>`; no card |
| a step input that fails parsing | error `[chat] step N: <parse error>`; no card |
| a `checkBefore` empty or over 200 characters | error `[chat] step N: checkBefore must be 1 to 200 characters`; no card |
| `costCap` not a positive finite number | error `[chat] costCap must be a positive number`; no card |
| a plan step whose spec is not found | error `[chat] step N: no spec for <feature>; looked for <paths>`; no card |
| the user denies the chain card, or it times out or aborts | error `[chat] the user declined the chain; propose steps one at a time`; no chain |
| the chain record cannot be written on activation | error `[chat] could not save the chain: <message>; it is not active`; no chain |
| a later chain record write fails | a warning is logged; the in-memory chain state stands |
| a launch call while a chain is active that is not the next step's exact command | the chain stops (`off-card step`); the call shows the normal card, whose reason ends `chain <id> stopped: off-card step` |
| a launch call for step N whose step N-1 job has not succeeded | the chain stops (`step <N-1> has not succeeded`); normal card |
| a launch call for a step whose check is not recorded as passed | the chain stops (`check "<label>" not recorded`); normal card |
| a launch call from a different chat session than the one that approved the chain | the chain stops (`chat session changed`); normal card |
| a launch call refused by the early busy checks (a running plan or run job, or a live `nax.lock`) | the feature 2 busy error; `admit` is not called and the chain is unchanged |
| an auto-admitted step that fails the late busy re-check or the spawn | the same error result as feature 2; the chain stops (`step N could not start: <message>`) |
| an auto-admitted run step whose pending stories exceed its iteration limit | the chain stops (`step N: <pending> stories pending but max iterations is <limit> (nax#2706)`); the call shows the normal card with that warning |
| the chain stops between an `auto` admission and `jobs.start` | nothing starts; error `[chat] chain <id> stopped before step N started; nothing started` |
| a PR-less bot step called with a PR other than the one the chain already uses | the chain stops (`PR <pr> differs from PR <chain pr> the chain already uses`); normal card |
| a step that is not an object, or whose `input` is not a plain object | error `[chat] step N: input must be an object`; no card |
| a step input with a key the kind does not accept | error `[chat] step N: unknown field <key>`; no card |
| another chain became active while the chain card was open | error `[chat] another chain became active while this card was open; this one is not active` |
| a launch call whose target preparation fails (for example no `prd.json`) | the feature 2 error result; `admit` is not called and the chain is unchanged |
| a chain step's job ends `failed`, `cancelled` or `lost` | the chain stops (`step N ended <state>`) |
| the cost cap is reached when a step ends and steps remain | the chain stops (`cost cap $X reached: spent $Y`) |
| `chain_check` with no active chain, a step that is not next, or a step without a check | error `[chat] no active chain` / `[chat] step N is not the next step` / `[chat] step N has no check to record` |
| `chain_check` with `passed: false` | the chain stops (`check "<label>" did not pass: <note>`) |
| `chain_stop` with no active chain | error `[chat] no active chain` |
| the chat closes with an active chain | the chain stops (`the chat closed`); kept jobs keep running |

## Out of Scope

- Any merge, release, `nax workflow promote` or ruling-post step in a chain; a chain only holds `nax plan`, `nax run`, `nax bot review` and `nax bot fix` steps, and it ends at a PR that is ready or draft.
- Restarting, resuming or editing a chain once it has stopped or completed; a new chain needs a new card.
- Reading chain records back into an active chain after a restart, a `--resume` or a crash; a chain never outlives the chat host that approved it, and a record left `active` on disk by a crash is inert.
- Checking the cost cap while a step runs, or killing a running step when the cap is passed; the cap is checked only when a step ends, and a run step's own `--max-cost` bounds spend inside that step.
- Counting the cost of plan and bot jobs toward the cap; only `run` jobs record cost.
- Verifying that a bot step's PR is the one the run published; the agent chooses the PR (user ruling 2026-10-28), the host checks that every other argument matches the card, and later PR-less bot steps of the same chain must reuse the first one's PR.
- Making the chain line of a job notice depend on the chain still being current; a notice for a re-attached chain job in a later chat still names its chain, and `nax-jobs__list` then shows that chat's own chain or `null`.
- Persisting a record-write failure for `started` or `recordCheck` beyond a logged warning; like `stop`, those writes are best effort after activation.
- A time limit on an active chain; it ends only on the conditions listed in Design.
- Recording a check verdict for anything but the next step, or the host running the check itself; the agent runs in-session checks such as the PRD fidelity check and records their verdict.
- Stopping the chain when a launch call fails target preparation (for example a missing `prd.json`); the chain stays active and the next call is admitted or refused under the same rules.
- A chain view, footer marker or `/jobs` line in the TUI; the chain shows through its card, the tool results, the job notices and `nax-jobs__list`.
- Cancelling the running job when the chain stops or is stopped; `nax-jobs__cancel` (with its own card) cancels a job.
- Recording which channel (terminal or Telegram) answered the chain card; the record keeps `approvedAt` only.
- Giving subagent sessions the chain tools; like every `nax-jobs` tool, they reach the parent chat only.
- Registering the chain tools in the ACP server (koda); only `nax chat` gets them.
- Routing a running `nax run`'s own asks into the chat; the run keeps its own interaction chain.
- Fixing nax#2706; the run card keeps its feature 2 warning.
- Any change to `nax run`, `nax plan`, `nax bot`, `@nathapp/nax-agent` or `chat-host.ts`.
- Editing files under `.nax/` (rules, context) or the slice 2 design document.
- Cross-session memory; it is its own slice, not yet designed (user ruling 2026-10-27).

## Stories

Nine stories, one capability (full-run approval). The controller is split three ways, the
`nax-jobs__chain` tool two ways and the prompt text into its own story, only to keep each story
under the 24-criterion gate.

### US-001 — chain types, step argv and the chain record store

Workdir: packages/nax. No dependencies.

New `src/chat/jobs/chain-types.ts`, `src/chat/jobs/chain-argv.ts` and
`src/chat/jobs/chain-store.ts`, as in Design § Data shapes. `ChatJob` in
`src/chat/jobs/job-types.ts` gains the optional `chainId` and `chainStep`. Tests go in new
`test/unit/chat/jobs/chain-argv.test.ts` and `test/unit/chat/jobs/chain-store.test.ts`, the store
tests in a temp directory.

### US-002 — the chain controller: activation and admission

Workdir: packages/nax. Depends on US-001.

New `src/chat/jobs/chain-controller.ts` with `createChainController`, `ChatChains`,
`ChainAdmission`, `ChainLaunch` and `ChainControllerOptions`: `activate` (with its in-flight
guard), `active`, `admit` (admission checks 3, 4 and 5 of Design § Approach, plus the
reservation), `started` and `startFailed`. `recordCheck`, `stop`, `isActive`, `summary` and
`dispose` may be minimal in this story; US-003 and US-004 finish them. Tests go in a new
`test/unit/chat/jobs/chain-controller.test.ts`, using a temp output dir and a stub `jobs` whose
`get` returns fixture job records.

### US-003 — the chain controller: checks, stop, session and PR consistency

Workdir: packages/nax. Depends on US-002.

Extends `chain-controller.ts` with `recordCheck`, `stop` and `isActive` as in Design § Data shapes,
admission check 2 (the session) and check 3b (the chain's PR), and best-effort record writes after
activation (a failed write logs a warning through `getLogger()` and keeps the in-memory state).
Tests go in a new `test/unit/chat/jobs/chain-checks.test.ts`.

### US-004 — the chain controller: job-end transitions, cost cap and summary

Workdir: packages/nax. Depends on US-003.

Extends `chain-controller.ts` with Design § Job-end transitions (the `jobs.onChange` subscription
and the same rules applied first in `admit`, admission check 1), the cost cap, `summary()` and
`dispose()`. Tests go in a new `test/unit/chat/jobs/chain-transitions.test.ts`, with a stub `jobs`
that captures the `onChange` listener.

### US-005 — chain lines in the job notice and the jobs instructions

Workdir: packages/nax. No dependencies.

`JobNoticeInput` and `buildJobNotice`, and `buildJobsInstructions`, in
`src/prompts/builders/workflow-builder.ts`, change as in Design § Notice and instruction text. Tests
go in a new `test/unit/prompts/builders/workflow-builder-chain.test.ts`.

### US-006 — the launch path admits chain steps

Workdir: packages/nax. Depends on US-002, US-005.

`launchJob` and `startApproved` in `src/chat/jobs/jobs-launch.ts` call `options.chains?.admit`
after the early busy check and handle `auto` as in Design § Approach: start without `approve`,
pass `chainId`, `chainStep` and the chain's `approvedAt` to `jobs.start`, call `chains.started`,
re-check `chains.isActive` right before `jobs.start`, call `chains.startFailed` when the late
re-check or the spawn fails, stop the chain for the nax#2706 case (through the new
`Prepared.overLimit`), and build the auto result of Design § Approach. It also adds the exported
`resolvePlanSpec` and makes `preparePlan` use it. On `card` with a note, the note is the last line of the card's `reason`.
`StartJobRequest` (in `job-runner.ts`) gains the optional chain fields, and `JobsProviderOptions`
gains the optional `chains`. Tests go in a new `test/unit/chat/jobs/jobs-launch-chain.test.ts`,
through the real `nax-jobs__run` / `nax-jobs__bot_review` tools from `createJobsProvider`, with a
stub `chains` and the `_jobsLaunchDeps` stubs `jobs-launch-busy.test.ts` uses.

### US-007 — the chain tool: registration and input validation

Workdir: packages/nax. Depends on US-006.

New `src/chat/jobs/chain-tools.ts` with `createChainTools`, registered by `createJobsProvider` when
`options.chains` is set (the three tools of Design § The chain tools). This story builds the
`chain` tool's input schema and validation steps 1 to 5. `chain_check` and `chain_stop` may be
minimal here; US-009 finishes them. Tests go in a new `test/unit/chat/jobs/chain-tool-input.test.ts`,
through `createJobsProvider` with a real `createChainController` over a temp output dir and a
fixture repo whose `.nax/features/f1/spec.md` and `prd.json` exist.

### US-008 — the chain tool: the card, approval and activation

Workdir: packages/nax. Depends on US-007.

Extends `chain-tools.ts` with the `chain` tool's card (`summary`, `command`, `reason` with its
warning lines), the deny and allow results, and activation with its two rejection messages, as in
Design § The chain tools. Tests go in a new `test/unit/chat/jobs/chain-tool-card.test.ts`, with the
US-007 fixture and a stub `approve`.

### US-009 — chain_check, chain_stop, the listing, and the chat host

Workdir: packages/nax. Depends on US-004, US-008.

Finishes `chain_check` and `chain_stop` in `chain-tools.ts`, adds the `chain` field to the `list`
result in `jobs-provider.ts`, and wires the controller into `createHostJobs`
(`src/chat/jobs/jobs-host.ts`): build it with `cwd: repoRoot`, pass it to the provider, return it,
and stop the active chain first in `confirmClose`. The `src/chat/jobs/index.ts` barrel exports
`createChainController` and the chain types. Tool tests go in a new
`test/unit/chat/jobs/chain-tools.test.ts`. Host tests go in a new
`test/unit/chat/chat-host-chain.test.ts`, built from `createChatHost` the way
`test/unit/chat/chat-host-jobs.test.ts` builds its fixture.

### Context Files

**US-001**
- `packages/nax/src/chat/jobs/job-types.ts`
- `packages/nax/src/chat/jobs/job-store.ts`
- `packages/nax/src/chat/jobs/job-argv.ts`
- `packages/nax/src/chat/jobs/jobs-provider.ts`
- `packages/nax/test/unit/chat/jobs/job-store.test.ts`

**US-002**
- `packages/nax/src/chat/jobs/chain-types.ts` — created by US-001, read here
- `packages/nax/src/chat/jobs/chain-store.ts` — created by US-001, read here
- `packages/nax/src/chat/jobs/chain-argv.ts` — created by US-001, read here
- `packages/nax/src/chat/jobs/job-runner.ts`
- `packages/nax/src/chat/jobs/job-types.ts`

**US-003**
- `packages/nax/src/chat/jobs/chain-controller.ts` — created by US-002, extended here
- `packages/nax/src/chat/jobs/chain-store.ts` — created by US-001, read here

**US-004**
- `packages/nax/src/chat/jobs/chain-controller.ts` — created by US-002, extended here
- `packages/nax/src/chat/jobs/job-runner.ts`
- `packages/nax/src/chat/jobs/job-outcome.ts`

**US-005**
- `packages/nax/src/prompts/builders/workflow-builder.ts`
- `packages/nax/test/unit/prompts/builders/workflow-builder.test.ts`

**US-006**
- `packages/nax/src/chat/jobs/jobs-launch.ts`
- `packages/nax/src/chat/jobs/job-runner.ts`
- `packages/nax/src/chat/jobs/jobs-provider.ts`
- `packages/nax/test/unit/chat/jobs/jobs-launch-busy.test.ts`
- `packages/nax/src/chat/jobs/chain-controller.ts` — created by US-002, read here

**US-007**
- `packages/nax/src/chat/jobs/chain-controller.ts` — created by US-002, read here
- `packages/nax/src/chat/jobs/chain-argv.ts` — created by US-001, read here
- `packages/nax/src/chat/jobs/jobs-launch.ts`
- `packages/nax/src/chat/jobs/jobs-provider.ts`
- `packages/nax/test/unit/chat/jobs/jobs-provider.test.ts`

**US-008**
- `packages/nax/src/chat/jobs/chain-tools.ts` — created by US-007, extended here
- `packages/nax/src/chat/jobs/jobs-launch.ts`
- `packages/nax/src/chat/ask-controller.ts`

**US-009**
- `packages/nax/src/chat/jobs/chain-tools.ts` — created by US-007, extended here
- `packages/nax/src/chat/jobs/jobs-host.ts`
- `packages/nax/src/chat/jobs/jobs-provider.ts`
- `packages/nax/src/chat/chat-host.ts`
- `packages/nax/test/unit/chat/chat-host-jobs.test.ts`

### Creates

**US-001**
- `packages/nax/src/chat/jobs/chain-types.ts`
- `packages/nax/src/chat/jobs/chain-argv.ts`
- `packages/nax/src/chat/jobs/chain-store.ts`
- `packages/nax/test/unit/chat/jobs/chain-argv.test.ts`
- `packages/nax/test/unit/chat/jobs/chain-store.test.ts`

**US-002**
- `packages/nax/src/chat/jobs/chain-controller.ts`
- `packages/nax/test/unit/chat/jobs/chain-controller.test.ts`

**US-003**
- `packages/nax/test/unit/chat/jobs/chain-checks.test.ts`

**US-004**
- `packages/nax/test/unit/chat/jobs/chain-transitions.test.ts`

**US-005**
- `packages/nax/test/unit/prompts/builders/workflow-builder-chain.test.ts`

**US-006**
- `packages/nax/test/unit/chat/jobs/jobs-launch-chain.test.ts`

**US-007**
- `packages/nax/src/chat/jobs/chain-tools.ts`
- `packages/nax/test/unit/chat/jobs/chain-tool-input.test.ts`

**US-008**
- `packages/nax/test/unit/chat/jobs/chain-tool-card.test.ts`

**US-009**
- `packages/nax/test/unit/chat/jobs/chain-tools.test.ts`
- `packages/nax/test/unit/chat/chat-host-chain.test.ts`

### Modifies

None. No story needs to change an existing assertion, and every new test goes in a new file. The job record, the start request and the provider options only gain optional members, and no existing test passes `chains`, so the existing launch, busy, provider and runner assertions hold, and the early busy checks keep their place before any approval or admission. The job notice adds a third line only for a chain job, and the five existing jobs instruction lines are kept verbatim. The jobs provider fixture passes no `chains`, so its six-tool list, its closed list and cancel schemas, and its listing assertions hold. The host only gains a returned member, the `nax-jobs` provider keeps its id and place, and the close prompt still asks once when owned jobs run, so the existing host and close tests hold.

### Seams

- US-002 → US-001: `activate` writes through `writeChainRecord`; a US-002 AC reads the record back with `readChainRecord`.
- US-004 → `ChatJobs.onChange`: a US-004 AC fires the captured listener after a stub job turns `failed` and asserts the chain stopped; a re-trigger AC fires it again and asserts no second record write.
- US-006 → US-002: the real `nax-jobs__run` tool calls `chains.admit` with the built argv and calls `chains.started` with the started job's id; a stub `chains` captures both calls.
- US-006 → US-005: the runner's notice for a job started with `chainId` comes from `buildJobNotice`; covered by the US-005 builder ACs and the US-006 runner AC that the record carries the chain fields.
- US-009 → US-002 / US-006 / US-008: a chain approved through the real `nax-jobs__chain` tool lets the real `nax-jobs__run` tool start step 1 with no second `approve` call (a real `createChainController`, a stub `jobs.start`); a re-trigger AC repeats the run call and asserts a second `approve` call.
- US-009 → US-007: from `createChatHost` with a `naxEntry`, the `nax-jobs` provider the session receives has the `chain`, `chain_check` and `chain_stop` tools, and a chain card raised in full mode stays in `host.asks.pending()` until resolved.

## Acceptance Criteria

### US-001 — chain types, step argv and the chain record store

- [unit] `chainsDir("/o")` returns `/o/chat-chains`.
- [unit] With `_chainStoreDeps.randomHex` returning `1a2b3c4d`, `newChainId()` returns `chain-1a2b3c4d`.
- [unit] `CHAIN_ID_PATTERN` rejects `chain-../../x`.
- [unit] `writeChainRecord(dir, chain)` followed by `readChainRecord(dir, chain.id)` returns a record deep-equal to `chain`.
- [unit] `writeChainRecord` for an existing id replaces the record, and `readChainRecord` returns the new `state` `stopped`.
- [unit] After `writeChainRecord(dir, chain)`, the `chat-chains/` directory holds exactly one entry, `<id>.json`.
- [unit] `writeChainRecord` for a chain whose id is `../x` rejects with a `NaxError` of code `CHAT_CHAIN_INVALID_ID`.
- [unit] `writeChainRecord` when `_chainStoreDeps.write` rejects throws a `NaxError` of code `CHAT_CHAIN_WRITE_FAILED`.
- [unit] `readChainRecord(dir, "chain-1a2b3c4d")` with no such file returns `null`.
- [unit] `readChainRecord(dir, "chain-1a2b3c4d")` for a file holding `not json` returns `null`.
- [unit] A job record with `chainId` `chain-1a2b3c4d` and `chainStep` 2, written with `writeJobRecord` and read with `readJobRecords`, keeps both fields.
- [unit] `parseChainStepInput("bot_review", { profiles: ["p"] })` returns `{ kind: "bot_review", profiles: ["p"] }` with no `pr` key.
- [unit] `parseChainStepInput("bot_fix", { pr: 0 })` returns `{ error: "[chat] pr must be a positive integer" }`.
- [unit] `parseChainStepInput("run", { feature: "f1", maxIterations: 40 })` returns the same value as `parseJobInput("run", { feature: "f1", maxIterations: 40 })`.
- [unit] `parseChainStepInput("run", { feature: "f1", bogus: 1 })` returns `{ error: "[chat] unknown field bogus" }`.
- [unit] `parseChainStepInput("bot_review", { decisions: "d.json", trust: true })` returns `{ error: "[chat] unknown field trust" }`.
- [unit] `buildChainStepArgv` for a bot_review with no `pr`, entry `["bun", "/n.ts"]` and repoRoot `/r` returns `["bun", "/n.ts", "bot", "review", "<pr>", "-d", "/r"]`.
- [unit] `buildChainStepArgv` for a bot_fix of PR 12 with `trust: true` returns the same argv as `buildJobArgv` for that input.
- [unit] `resolveStepArgv(["bun", "/n.ts", "bot", "review", "<pr>", "-d", "/r"], 4, 12)` returns `["bun", "/n.ts", "bot", "review", "12", "-d", "/r"]`.
- [unit] `resolveStepArgv(["bun", "/n.ts", "bot", "review", "<pr>", "-d", "/r", "--decisions", "<pr>"], 4, 12)` returns an argv whose last token is still `<pr>`.
- [unit] `resolveStepArgv(argv, undefined, 12)` returns an argv equal to the input.

### US-002 — the chain controller: activation and admission

- [unit] `activate({ steps })` resolves a chain whose `state` is `active`.
- [unit] `activate({ steps })` with `sessionId()` returning `chat-1` resolves a chain whose `sessionId` is `chat-1`.
- [unit] `activate({ steps })` with `now()` returning `2026-10-28T00:00:00Z` resolves a chain whose `approvedAt` is `2026-10-28T00:00:00.000Z`.
- [unit] After `activate`, `readChainRecord(outputDir, chain.id)` returns a record whose `state` is `active`.
- [unit] `activate` when `_chainStoreDeps.write` rejects rejects with code `CHAT_CHAIN_WRITE_FAILED`, and `active()` then returns `undefined`.
- [unit] `activate` while a chain is active rejects with a `NaxError` of code `CHAT_CHAIN_ACTIVE`.
- [unit] Two `activate` calls started in the same tick, before either resolves, give one fulfilled chain and one rejection with code `CHAT_CHAIN_ACTIVE`.
- [unit] `admit` with no active chain returns `{ kind: "card" }` with no `note`.
- [unit] For an active chain whose step 1 is a run with argv `A`, `admit({ kind: "run", argv: A })` returns `{ kind: "auto", chainId: <id>, step: 1, approvedAt: <chain approvedAt> }`.
- [unit] For the same chain, `admit({ kind: "run", argv: A with "-m", "40" appended })` returns `{ kind: "card", note: "chain <id> stopped: off-card step" }`.
- [unit] After that off-card admit, `active()` returns `undefined`.
- [unit] For an active chain whose step 1 is a run, `admit({ kind: "plan", argv: <step 1 argv> })` returns `card` with the note `chain <id> stopped: off-card step`.
- [unit] For a bot_review step whose argv holds `<pr>` at its `prIndex`, `admit({ kind: "bot_review", argv: <that argv with "12" at prIndex>, pr: 12 })` returns `auto`.
- [unit] For a bot_review step whose argv names PR 12, `admit` with `pr: 13` and the argv for PR 13 returns `card` with the note `chain <id> stopped: off-card step`.
- [unit] Calling `admit` twice in a row with step 1's exact argv returns `auto` and then `card` with the note `chain <id> stopped: off-card step`.
- [unit] For a two-step chain after `started(<id>, 1, "run-1a2b3c4d")`, with `jobs.get("run-1a2b3c4d")` in state `running`, `admit` with step 2's argv returns `card` with the note `chain <id> stopped: step 1 has not succeeded`.
- [unit] For a two-step chain after `started(<id>, 1, "run-1a2b3c4d")`, with that job in state `succeeded`, `admit` with step 2's argv returns `auto` with `step` 2.
- [unit] For a two-step chain whose step 1 was admitted but never `started`, `admit` with step 2's argv returns `card` with the note `chain <id> stopped: step 1 has not succeeded`.
- [unit] For a step 2 with `checkBefore` `PRD fidelity READY` and no recorded check, after step 1 succeeded, `admit` with step 2's argv returns `card` with the note `chain <id> stopped: check "PRD fidelity READY" not recorded`.
- [unit] `started(<id>, 1, "run-1a2b3c4d")` makes `readChainRecord` return the chain with `steps[0].jobId` `run-1a2b3c4d`.
- [unit] `startFailed(<id>, 1, "checkout busy")` makes `active()` return `undefined`, and the chain record's `stopReason` is `step 1 could not start: checkout busy`.

### US-003 — the chain controller: checks, stop, session and PR consistency

- [unit] After `recordCheck(2, true, "READY")` returns `{ ok: true }` on a step 2 with `checkBefore`, and step 1's job succeeded, `admit` with step 2's argv returns `auto`.
- [unit] After `recordCheck(2, true, "READY")`, `readChainRecord` returns step 2 with `check` `{ passed: true, note: "READY", at: <now> }`.
- [unit] `recordCheck(2, false, "2 blockers")` on a step 2 with `checkBefore` `PRD fidelity READY` returns `{ ok: true }`, and the chain record's `stopReason` is then `check "PRD fidelity READY" did not pass: 2 blockers`.
- [unit] `recordCheck(2, true, "x")` on a step 2 with no `checkBefore` returns `{ ok: false, message: "step 2 has no check to record" }`.
- [unit] `recordCheck(3, true, "x")` while step 2 is next returns `{ ok: false, message: "step 3 is not the next step" }`.
- [unit] `recordCheck(1, true, "x")` with no active chain returns `{ ok: false, message: "no active chain" }`.
- [unit] `stop("user asked")` on an active chain returns the chain with `state` `stopped`, `stopReason` `user asked`, and `endedAt` equal to `now()`.
- [unit] After `stop("user asked")`, `readChainRecord` returns `state` `stopped`.
- [unit] `stop("x")` with no active chain returns `undefined`.
- [unit] `isActive(<id>)` returns `true` for the active chain and `false` after `stop("x")`.
- [unit] `isActive("chain-ffffffff")` for an id that is not the current chain returns `false`.
- [unit] `started("chain-ffffffff", 1, "run-1a2b3c4d")` for a chain id that is not the current chain leaves the current chain's `steps[0].jobId` unset.
- [unit] For a chain approved while `sessionId()` returned `chat-1`, `active()` called while `sessionId()` returns `chat-2` returns `undefined`, and the chain record's `stopReason` is `chat session changed`.
- [unit] `started(<id>, 1, "run-1a2b3c4d")` after `stop("x")` on that chain still makes `readChainRecord` return `steps[0].jobId` `run-1a2b3c4d`.
- [unit] For a chain approved while `sessionId()` returned `chat-1`, `admit` with step 1's exact argv while `sessionId()` returns `chat-2` returns `card` with the note `chain <id> stopped: chat session changed`.
- [unit] For a chain of two PR-less bot steps (review, then fix), after step 1 is admitted with `pr` 12 and its job succeeded, `admit` for step 2 with `pr` 12 returns `auto`.
- [unit] For the same chain, after step 1 is admitted with `pr` 12 and its job succeeded, `admit` for step 2 with `pr` 13 returns `card` with the note `chain <id> stopped: PR 13 differs from PR 12 the chain already uses`.
- [unit] When `_chainStoreDeps.write` rejects during `stop("x")` on an active chain, `stop` still returns the chain with `state` `stopped`, and `active()` returns `undefined`.
- [unit] When `_chainStoreDeps.write` rejects during `stop("x")`, a warning is logged through the logger `getLogger()` returns.
- [unit] When `_chainStoreDeps.write` rejects during `recordCheck(2, true, "READY")`, the call still returns `{ ok: true }`, and a later `admit` for step 2 (step 1 succeeded) returns `auto`.

### US-004 — the chain controller: job-end transitions, cost cap and summary

- [unit] When the stub job of step 1 turns `failed` and the captured `onChange` listener fires, the chain record's `state` is `stopped` with `stopReason` `step 1 ended failed`.
- [unit] When the step 1 job turns `cancelled` and the listener fires, `stopReason` is `step 1 ended cancelled`.
- [unit] When the step 1 job turns `lost` and the listener fires, `stopReason` is `step 1 ended lost`.
- [unit] When the job of the last step turns `succeeded` and the listener fires, the chain record's `state` is `completed` with `endedAt` equal to `now()`.
- [unit] After the last step's job succeeded and the listener fired, `active()` returns `undefined`.
- [unit] When the step 1 job of a three-step chain with no `costCap` turns `succeeded` and the listener fires, `active()` still returns the chain.
- [unit] For a chain with `costCap` 10 whose step 1 job recorded `cost` 6 and step 2 job recorded `cost` 5, when step 2 turns `succeeded` with step 3 left and the listener fires, `stopReason` is `cost cap $10.00 reached: spent $11.00`.
- [unit] For a chain with `costCap` 10 whose step 1 job recorded `cost` 4, when step 1 turns `succeeded` and the listener fires, `active()` still returns the chain.
- [unit] A step job with no `cost` adds 0 to `summary().spent`.
- [unit] For a chain with `costCap` 10 whose step 1 job recorded `cost` 10, when step 1 turns `succeeded` with steps left and the listener fires, `stopReason` is `cost cap $10.00 reached: spent $10.00`.
- [unit] With the last step's job `succeeded` and the listener never fired, `admit` with any argv returns `{ kind: "card" }` with no `note`, and the chain record's `state` is `completed`.
- [unit] After the chain stopped on a `failed` step, firing the listener again leaves the number of `_chainStoreDeps.write` calls unchanged.
- [unit] Firing the listener while the step 1 job is still `running` leaves `active()` returning the chain.
- [unit] With the step 1 job `failed` and the listener never fired, `admit` with step 2's argv returns `card` with the note `chain <id> stopped: step 1 ended failed`.
- [unit] `summary()` before any `activate` returns `null`.
- [unit] For a two-step chain with step 1 started as job `run-1a2b3c4d` in state `running` and `costCap` 25, `summary()` returns `{ id, state: "active", next: 2, steps: [{ step: 1, kind: "run", argv, job: "run-1a2b3c4d", jobState: "running" }, { step: 2, kind: "bot_review", argv }], costCap: 25, spent: 0 }`.
- [unit] After `stop("x")`, `summary()` returns that chain with `state` `stopped` and `stopReason` `x`.
- [unit] After `stop("x")`, `summary()` has no `next` key.
- [unit] After `dispose()`, turning the step 1 job `failed` and firing the captured listener leaves `summary().state` `active`.

### US-005 — chain lines in the job notice and the jobs instructions

- [unit] `buildJobNotice` for a job with `chainId` `chain-1a2b3c4d` and `chainStep` 2 returns three lines.
- [unit] The third line of that notice is `This job is step 2 of chain chain-1a2b3c4d; call nax-jobs__list to see whether the chain continues, and if it does, call the next step's launch tool with exactly the approved arguments (no card is shown for it).`
- [unit] `buildJobNotice` for a job with no `chainId` returns two lines.
- [unit] `buildJobsInstructions()` contains the line ``` `nax-jobs__chain` proposes a full run: an ordered list of billed steps on one approval card. Only the user's yes on that card approves it; a chat message such as "go ahead" does not. ```
- [unit] `buildJobsInstructions()` contains the line `While a chain is active, call each step's launch tool with exactly the approved arguments, one step at a time, after the previous step succeeded; a different call stops the chain and shows a normal card.`
- [unit] `buildJobsInstructions()` contains the line ``Before a step that names a check, run that check yourself and record its verdict with `nax-jobs__chain_check`; stop the chain with `nax-jobs__chain_stop` when the user asks.``
- [unit] The fifth line of `buildJobsInstructions()` is still `Start one step at a time: after a job ends, report the outcome to the user and propose the single next step.`
- [unit] `buildJobsInstructions()` returns eight lines.

### US-006 — the launch path admits chain steps

- [unit] With `options.chains` unset, a `nax-jobs__run` call for `f1` calls `approve` once and `jobs.start` once.
- [unit] With a stub `chains.admit` returning `{ kind: "auto", chainId: "chain-1a2b3c4d", step: 2, approvedAt: "2026-10-01T00:00:00Z" }` and `chains.isActive` returning `true`, a `nax-jobs__run` call for `f1` never calls `approve`.
- [unit] In that auto case, `jobs.start` is called once with `chainId` `chain-1a2b3c4d`, `chainStep` 2 and `approvedAt` `2026-10-01T00:00:00Z`.
- [unit] In that auto case, `chains.started` is called with `("chain-1a2b3c4d", 2, <the id jobs.start returned>)`.
- [unit] In that auto case, the tool result content contains `started as step 2 of chain chain-1a2b3c4d; no card (approved by the chain card)`.
- [unit] In that auto case with the interaction plugin `cli`, the tool result content contains `warning: this run has no channel for its own asks; they will time out`.
- [unit] A `nax-jobs__run` call for `f1` with `maxIterations` 40 calls `chains.admit` with `kind` `run` and `argv` equal to `buildJobArgv` for that input.
- [unit] A `nax-jobs__bot_review` call for PR 12 calls `chains.admit` with `kind` `bot_review` and `pr` 12.
- [unit] With `chains.admit` returning `{ kind: "card", note: "chain chain-1a2b3c4d stopped: off-card step" }`, the last line of the card `reason` passed to `approve` is `chain chain-1a2b3c4d stopped: off-card step`.
- [unit] With `chains.admit` returning `{ kind: "card" }` with no note, the card `reason` equals the reason the same call builds with `chains` unset.
- [unit] With `_jobsLaunchDeps.lockHolder` returning a live pid 777 from its first call, a `nax-jobs__run` call returns `[chat] this checkout is held by nax pid 777; wait for it or stop it first` and never calls `chains.admit`.
- [unit] In the auto case for a `nax-jobs__run` call, with `_jobsLaunchDeps.lockHolder` returning `null` on its first call and 777 on its second, `jobs.start` is not called, and `chains.startFailed` is called with `("chain-1a2b3c4d", 2, "this checkout is held by nax pid 777; wait for it or stop it first")`.
- [unit] In the auto case with `jobs.start` rejecting `spawn failed`, `chains.startFailed` is called with step 2 and a message starting `could not start nax run:`.
- [unit] In the auto case with `chains.isActive("chain-1a2b3c4d")` returning `false`, `jobs.start` is not called, and the result is the error `[chat] chain chain-1a2b3c4d stopped before step 2 started; nothing started`.
- [unit] In the auto case for a run of `f1` whose `prd.json` has 25 pending stories and no `maxIterations` (limit 20), with `approve` resolving `deny`, `jobs.start` is not called, and `chains.stop` is called with `step 2: 25 stories pending but max iterations is 20 (nax#2706)`.
- [unit] In that nax#2706 case, `approve` is called once, and the last line of its card `reason` is `chain chain-1a2b3c4d stopped: step 2: 25 stories pending but max iterations is 20 (nax#2706)`.
- [unit] A `nax-jobs__run` call for a feature with no `prd.json` returns `[chat] no prd.json for <feature>; run nax plan first` and never calls `chains.admit`.
- [unit] `resolvePlanSpec("f1", undefined, { repoRoot })` for a repo with `.nax/features/f1/spec.md` and a `prd.json` returns `{ spec: ".nax/features/f1/spec.md", prdExists: true }`.
- [unit] `resolvePlanSpec("f9", undefined, { repoRoot })` for a feature with no spec returns an `error` starting `[chat] no spec for f9; looked for`.
- [unit] The job runner's `start` with a request carrying `chainId` `chain-1a2b3c4d` and `chainStep` 2 writes a record whose `chainId` is `chain-1a2b3c4d` and whose `chainStep` is 2.
- [unit] With `options.chains` unset, the request a `nax-jobs__run` call passes to `jobs.start` has no `chainId` key and no `chainStep` key.

### US-007 — the chain tool: registration and input validation

- [unit] With `chains` set, `createJobsProvider(options).tools()` returns local names `["plan", "run", "bot_review", "bot_fix", "list", "cancel", "chain", "chain_check", "chain_stop"]`.
- [unit] The `chain` tool's input schema has `required` `["steps"]` and `additionalProperties` `false`.
- [unit] A `nax-jobs__chain` call with `steps: []` returns the error `[chat] a chain needs 1 to 6 steps`.
- [unit] A `nax-jobs__chain` call with seven valid run steps returns the error `[chat] a chain needs 1 to 6 steps`.
- [unit] A `nax-jobs__chain` call with six valid run steps and a 200-character `checkBefore` on step 2 reaches `approve`.
- [unit] A `nax-jobs__chain` call whose `steps` is the string `"plan"` returns the error `[chat] a chain needs 1 to 6 steps`.
- [unit] A step that is the string `"run"` returns the error `[chat] step 1: input must be an object`.
- [unit] A step `{ kind: "run" }` with no `input` returns the error `[chat] step 1: input must be an object`.
- [unit] A step whose `input` is an array returns the error `[chat] step 1: input must be an object`.
- [unit] A step with `kind` `merge` returns the error `[chat] step 1: unknown kind merge`.
- [unit] A step with `kind` 7 returns the error `[chat] step 1: unknown kind 7`.
- [unit] A run step with input `{ feature: "f1", bogus: 1 }` returns the error `[chat] step 1: unknown field bogus`.
- [unit] A run step with `feature` `../x` returns an error whose content equals `[chat] step 1: ` followed by the message `parseJobInput("run", { feature: "../x" })` returns, with that message's leading `[chat] ` removed.
- [unit] A plan step for feature `f9`, which has no spec, returns an error starting `[chat] step 1: no spec for f9; looked for`.
- [unit] `costCap` -1 returns the error `[chat] costCap must be a positive number`.
- [unit] `costCap` `"10"` (a string) returns the error `[chat] costCap must be a positive number`.
- [unit] A step 2 with `checkBefore` `""` returns the error `[chat] step 2: checkBefore must be 1 to 200 characters`.
- [unit] A step 2 with a 201-character `checkBefore` returns the error `[chat] step 2: checkBefore must be 1 to 200 characters`.
- [unit] A `nax-jobs__chain` call while a chain is active returns the error `[chat] chain <id> is already active; stop it with nax-jobs__chain_stop first`.
- [unit] When a chain is active and the step list is also empty, the error is the already-active error.
- [unit] For each invalid call above, the stub `approve` is never called.

### US-008 — the chain tool: the card, approval and activation

- [unit] A `nax-jobs__chain` call with steps plan `f1` and run `f1` with `maxIterations` 40 calls `approve` once with `tool` `nax-jobs__chain`.
- [unit] For that call, the card `command` equals the plan step's argv joined by spaces, a newline, and the run step's argv joined by spaces.
- [unit] For that call, the card `summary` is `full run of 2 steps: nax plan f1 → nax run f1`.
- [unit] For that call, the card `reason` contains the line `1. nax plan f1 — starts after: you approve this card`.
- [unit] For that call, the card `reason` contains the line `2. nax run f1 — starts after: step 1 succeeded`.
- [unit] For a step 2 with `checkBefore` `PRD fidelity READY`, the card `reason` contains `2. nax run f1 — starts after: step 1 succeeded and check "PRD fidelity READY" passed`.
- [unit] With `costCap` 25, the card `reason` contains `cost cap $25.00, checked between steps; plan and bot job costs are not counted`.
- [unit] Without `costCap`, the card `reason` contains `no cost cap`.
- [unit] The card `reason` contains `Steps run in this order, each once. A failed step or check, a different step, the cost cap, a cancel or closing the chat stops the chain.`
- [unit] With `f1` already holding a `prd.json`, the card `reason` for the plan-then-run chain contains `warning: step 1 replaces the existing prd.json for f1`.
- [unit] With the interaction plugin `cli` and a run step in the chain, the card `reason` contains `warning: run steps have no channel for their own asks; they will time out`.
- [unit] For a single bot_review step without `pr`, the card `command` contains `<pr>`.
- [unit] For a single bot_review step without `pr`, the card `summary` is `full run of 1 steps: nax bot review (PR chosen by the agent)`.
- [unit] For a single bot_review step without `pr`, its `reason` step line ends `— the agent picks the PR when the step starts`.
- [unit] The card passed to `approve` carries the tool call's `ctx.signal`.
- [unit] When `approve` resolves `allow`, `chains.active()` returns a chain whose two steps carry the argv shown on the card.
- [unit] When `approve` resolves `allow`, the result content starts with `{"chain":"<id>","state":"active","next":1}` and contains `Call step 1 now with exactly the approved arguments.`
- [unit] When `approve` resolves `deny`, the result is an error with content `[chat] the user declined the chain; propose steps one at a time`, and `chains.active()` returns `undefined`.
- [unit] When `approve` resolves `allow` and `_chainStoreDeps.write` rejects `disk full`, the result is an error starting `[chat] could not save the chain:` and ending `; it is not active`, and `chains.active()` returns `undefined`.
- [unit] When two `nax-jobs__chain` calls both reach their cards and both are approved, the second result is the error `[chat] another chain became active while this card was open; this one is not active`.

### US-009 — chain_check, chain_stop, the listing, and the chat host

- [unit] `nax-jobs__chain_check` with `{ step: 2, passed: true, note: "READY" }` for a next step 2 that has a check returns `check recorded for step 2`.
- [unit] `nax-jobs__chain_check` with `{ step: 2, passed: false, note: "2 blockers" }` returns `check recorded for step 2; the chain stopped`.
- [unit] `nax-jobs__chain_check` with no active chain returns the error `[chat] no active chain`.
- [unit] `nax-jobs__chain_check` for step 3 while step 2 is next returns the error `[chat] step 3 is not the next step`.
- [unit] The `chain_check` input schema requires `step`, `passed` and `note`, with `additionalProperties` `false`.
- [unit] `nax-jobs__chain_stop` with an active chain returns `chain <id> stopped; running jobs keep running`, and `chains.active()` then returns `undefined`.
- [unit] `nax-jobs__chain_stop` never calls `approve`.
- [unit] `nax-jobs__chain_stop` with no active chain returns the error `[chat] no active chain`.
- [unit] `nax-jobs__list` with no `job` and `chains` set returns JSON whose `chain` is `null` before any chain.
- [unit] After a chain is activated, `nax-jobs__list` with no `job` returns JSON whose `chain` deep-equals `chains.summary()`.
- [integration] After a chain of one step, run `f1`, is approved through `nax-jobs__chain` (stub `approve` resolving `allow`), a `nax-jobs__run` call for `f1` calls the stub `jobs.start` once with `chainStep` 1, and `approve` has been called once in total.
- [integration] After that auto-started step, a second `nax-jobs__run` call for `f1` calls `approve` again, so `approve` has been called twice in total.
- [unit] `createHostJobs(...)` returns a `chains` member whose `active()` is `undefined` and whose `summary()` is `null`.
- [unit] The `provider` returned by `createHostJobs(...)` has tools named `chain`, `chain_check` and `chain_stop`.
- [unit] With an active chain and no owned running jobs, `confirmClose()` resolves without calling `requestHostApproval`, and `chains.summary().stopReason` is `the chat closed`.
- [unit] With an active chain and one owned running job, `confirmClose()` stops the chain with `stopReason` `the chat closed` and calls `requestHostApproval` once.
- [integration] From `createChatHost` with a `naxEntry` and resources, the `nax-jobs` provider passed to the session's `open` request has tools named `chain`, `chain_check` and `chain_stop`.
- [integration] In a full-mode host from `createChatHost`, a `nax-jobs__chain` call for one run step of `f1` leaves one ask in `host.asks.pending()` whose `tool` is `nax-jobs__chain` until it is resolved.
