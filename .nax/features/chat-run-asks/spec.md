# SPEC: chat-run-asks — a chat-launched run's own asks reach the chat session

## Summary

`nax chat` launches `nax run`, `nax bot review` and `nax bot fix` as detached jobs. Today the
child's own asks (triggers, tool approvals, the agent's clarifying questions, precheck and
paused-story prompts) never reach the chat: the run is `--headless`, so with the default `cli`
interaction plugin its chain is null and every ask is denied or falls to its default; bot jobs
build no chain at all. This feature gives every chat-launched run and bot job a file-backed
`chat` interaction plugin. Each ask becomes a card in the chat that launched it. When the job is
a step of an approved full chain, the chat agent answers it instead (with a reason shown in the
transcript), except red-tier triggers and the `pre-merge` / `human-review` gates, which always
go to the user. An ask nobody answers in chat within `interaction.defaults.chatAskFallbackMs`
(default 60 s) is also offered to the configured Telegram / webhook plugin; the first answer
wins, and at the ask's own timeout the existing fallback applies unchanged. Advisor heads-ups
show in the transcript as read-only notices.

Design: `docs/superpowers/specs/2026-10-29-nax-chat-run-asks-design.md` (approved 2026-10-29).

## Motivation

- Slice 2 left this gap on purpose (`2026-10-27-nax-chat-workflow-dispatch-slice2-design.md`
  4.6): the launch card warns "this run has no channel for its own asks; they will time out".
- `initInteractionChain` returns null for headless + `cli` (`src/interaction/init.ts`), so a
  chat-launched run's tool approvals are denied `unavailable` and its triggers never reach a
  person. Bot review / fix pass no `interactionChain` to `buildPrStepContext`.
- `InteractionChain.receive` cascades only on a thrown error and Telegram resolves timeouts
  instead of throwing, so "chat first, Telegram later" cannot be built by registering two
  plugins; the chat plugin owns the fallback order itself.

## Design

### Approach

One mechanism, two sides, joined by a directory of small JSON files per job.

**Child side (the launched `nax run` / `nax bot` process).** A hidden `--chat-asks <dir>` flag
(constant `CHAT_ASKS_FLAG`) names the job's ask directory. When it is present,
`initInteractionChain` builds a chain whose single plugin is `ChatAskPlugin` (name `"chat"`),
even in headless + `cli`. `ChatAskPlugin` wraps the plugin the project config names as its
fallback when that plugin is not `cli` (Telegram or webhook); with `cli` there is no fallback.
Every ask source already goes through the chain or its primary plugin, so nothing upstream
changes. A flag, not an environment variable: an env var would be inherited by any nested `nax`
the run's own agents start.

**Parent side (the `nax chat` process).** The job runner creates the ask directory and writes a
first heartbeat before it spawns a `run`, `bot_review` or `bot_fix` job, and appends
`--chat-asks <dir>` to the argv (never for `plan`). A new run-asks registry
(`src/chat/jobs/run-asks.ts`) polls the ask directories of running jobs, refreshes their
heartbeats, turns each new ask into a human card or an agent notice, writes answers, closes
cards whose ask was settled elsewhere and turns notices into transcript lines.

**Who answers (user rulings 2026-10-29).** `routeRunAsk` returns `"human"` when any of: the job
has no `chainId`; `chains.isActive(job.chainId)` is false (this also covers jobs re-attached
after a chat restart, since chain state is session-local); `request.metadata.safety === "red"`;
`request.metadata.trigger` is `"pre-merge"` or `"human-review"`; the agent has already been
handed `MAX_CONSECUTIVE_AGENT_ASKS` (3) asks since the last user turn. Otherwise `"agent"`. The
order does not matter: every condition yields `"human"` and only their absence yields `"agent"`.

**Transcript notes.** `takeNotes()` returns these exact lines (`<summary>` is the request's
`summary`, `<answer>` is the response `value` when present, else its `action`):
`[<jobId>] ask settled by <by>: <answer>` (settled by a fallback plugin or the agent elsewhere),
`[<jobId>] ask timed out: <summary>`, `[<jobId>] <summary>` (a notice file, for example an
advisor heads-up), `[<jobId>] agent answered <answer>: <reason>`,
`[<jobId>] could not deliver your answer for <askId>`. An ask settled by `chat-user` (the user's
own card), by `chat-agent` (the agent's own answer already produced its line) or by
`cancelled` produces no line.

**Ask ids.** The registry names an ask `<jobId>/<key>` (for example
`run-1a2b3c4d/0f3c9a1b2d4e5f60`), where `key` is `chatAskKey(request.id)`.

**Cards.** A human card for a `confirm` or `choose` ask is
`asks.requestHostChoice({ tool: "nax-run__ask", summary: "<jobId>: <request summary>", reason:
request.detail ?? request.summary, choices, fallback: "closed", signal })`. `choices` is
`[{ id: "approve", label: "Approve" }, { id: "reject", label: "Deny" }]` for `confirm` and
`request.options` mapped to `{ id: key, label }` for `choose`. An `input` ask uses
`asks.requestHostQuestion({ text: "<jobId>: <request summary>" plus "\n" + request.detail when
present, signal })`. The registry aborts `signal` when the ask settles elsewhere; a card that
resolves `"closed"` (aborted, or the controller's own timeout) or `null` writes no answer.

**Registry interface (declared whole in US-010; US-011 and US-013 fill members).**

```ts
export interface RunAskReply { readonly answer: string; readonly reason: string }
export type RunAskResult = { readonly ok: true } | { readonly ok: false; readonly message: string };
export interface ChatRunAsks {
  peekNotice(): string | undefined;          // US-010: always undefined; US-013: agent queue head
  takeNotice(): string | undefined;          // US-010: always undefined
  takeNotes(): readonly string[];            // US-010: always []; US-011: queued lines
  answer(askId: string, reply: RunAskReply): Promise<RunAskResult>; // US-010: not-waiting error
  noteUserTurn(): void;                      // US-010: no-op; US-013: resets the agent streak
  onChange(listener: () => void): () => void;
  dispose(): void;
}
export interface RunAsksOptions {
  readonly outputDir: string;
  readonly jobs: Pick<ChatJobs, "running" | "get" | "onChange">;
  readonly chains: Pick<ChatChains, "isActive">;
  readonly asks: Pick<ChatAskController, "requestHostChoice" | "requestHostQuestion">;
  readonly now: () => Date;
  readonly logger: Pick<Logger, "warn">;
}
export function createRunAsks(options: RunAsksOptions): ChatRunAsks;
export function routeRunAsk(input: {
  readonly job: Pick<ChatJob, "chainId">;
  readonly request: InteractionRequest;
  readonly chainActive: boolean;
  readonly agentStreak: number;
}): "human" | "agent";
```

The registry subscribes to `jobs.onChange`; a change that leaves at least one job running starts
the tick if it is not running. When a job leaves `running` (ended, cancelled, lost), the
registry aborts the signals of that job's open cards and writes no answer for them. An ask the
agent escalated still counts toward `MAX_CONSECUTIVE_AGENT_ASKS`. If writing an agent answer
fails, `answer` resolves `{ ok: false, message: "[chat] could not write the answer for <askId>" }`.

The registry tick runs through `_runAsksDeps.setTimeout` / `clearTimeout`; the handle is
`unref()`-ed when it has that method, so a chat host left open in a test does not keep the
process alive.

**Agent answers.** An agent-routed ask is queued as a notice (built by `buildRunAskNotice`) and
delivered as a turn when the chat is idle, ahead of job and task notices. The agent answers with
the no-card tool `nax-jobs__answer_ask` (`ask`, `answer`, `reason`) or answers `escalate`, which
turns the ask into a human card. An agent answer applies once: `allow-remember` is refused for
the agent. The answer shows as a transcript notice with the reason.

### File protocol (new, `src/interaction/chat-ask-files.ts`)

All files live in one directory per job: `<outputDir>/chat-jobs/<jobId>.asks/` (helper
`jobAsksDir(outputDir, jobId)` in `job-store.ts`). Every write is atomic (write a sibling temp
file, then rename). `key` = the first 16 hex characters of the SHA-256 of the request id
(`chatAskKey`), so any request id is a safe file name.

| File | Writer | Content |
|---|---|---|
| `heartbeat.json` | parent | `{ "schemaVersion": 1, "at": "<ISO time>" }` |
| `<key>.ask.json` | child | `{ "schemaVersion": 1, "key", "request": <InteractionRequest>, "askedAt" }` |
| `<key>.answer.json` | parent | `{ "schemaVersion": 1, "requestId", "action", "value"?, "respondedBy": "chat-user" \| "chat-agent", "reason"?, "respondedAt" }` |
| `<key>.settled.json` | child | `{ "schemaVersion": 1, "requestId", "by", "action", "value"?, "settledAt" }` |
| `<key>.notice.json` | child | `{ "schemaVersion": 1, "key", "request": <InteractionRequest>, "at" }` |

Example answer for a tool approval chosen by the user:

```json
{ "schemaVersion": 1, "requestId": "ask-US-002-7", "action": "choose", "value": "allow",
  "respondedBy": "chat-user", "respondedAt": "2026-10-29T10:15:02.000Z" }
```

`by` in a settled record is the winning response's `respondedBy` (`chat-user`, `chat-agent`, the
fallback plugin's value such as `telegram`), or `"timeout"`, or `"cancelled"`.

Answer encoding by request type (the same `InteractionResponse` vocabulary the chain already
uses): `confirm` → `action` `"approve"` or `"reject"`; `choose` (including tool approvals) →
`action` `"choose"`, `value` = the option key; `input` → `action` `"input"`, `value` = the text.

Constants: `CHAT_ASK_POLL_MS = 500` (child poll), `RUN_ASK_POLL_MS = 1_000` (parent tick, which
also rewrites heartbeats), `CHAT_ASK_STALE_MS = 15_000` (a heartbeat older than this, or none,
means the chat is closed), `MAX_CONSECUTIVE_AGENT_ASKS = 3`.

### ChatAskPlugin flow (child)

```ts
export interface ChatAskPluginOptions {
  readonly dir: string;
  readonly fallback?: InteractionPlugin;   // already initialised by initInteractionChain
  readonly fallbackDelayMs?: number;       // default 60_000
  readonly logger?: Pick<Logger, "warn">;  // default getSafeLogger(); the F3-F5 warnings go here
}
export class ChatAskPlugin implements InteractionPlugin {
  readonly name: "chat";
  readonly fallbackDelayMs: number;
  constructor(options: ChatAskPluginOptions);
}
```

`ChatAskPlugin` has no `init` of its own. `InteractionChain.init` looks configs up by plugin name
(`"chat"`), so `initInteractionChain` calls `fallback.init(config.interaction.config ?? {})`
itself before constructing the plugin, and registers the chat plugin without calling
`chain.init`.

`send(request)`:
- `notify` → write `<key>.notice.json`; when the chat is closed also `fallback.send(request)`.
- otherwise write `<key>.ask.json`; when the chat is closed and a fallback exists, start the
  fallback at once.

`receive(requestId, timeout)` until `askedAt + timeout`:
1. every `CHAT_ASK_POLL_MS` read `<key>.answer.json`; a valid answer resolves the ask;
2. when `fallbackDelayMs` has elapsed, or at any poll where the heartbeat is stale, and a
   fallback exists and has not started: `fallback.send(request)`, then
   `fallback.receive(requestId, remainingMs)`; a fallback response resolves the ask unless its
   `respondedBy` is `"timeout"`, `"destroyed"` or `"superseded"` (the fabricated `skip`
   responses Telegram and webhook emit), which count as no answer;
3. the first resolution wins; if the chat won, `fallback.cancel(requestId)` is called;
4. at the deadline the ask resolves `{ action: "skip", respondedBy: "timeout" }` (the value
   every caller already maps through its own fallback) and the fallback, if started, is
   cancelled;
5. every resolution writes `<key>.settled.json`.

### Integration (extends existing code)

The baselines below exist only to locate the code; they are never the interface to implement.

Read only:
- `InteractionRequest`, `InteractionResponse`, `InteractionPlugin`, `InteractionAction` —
  `src/interaction/types.ts`.
- `createTriggerRequest` sets `metadata: { trigger, safety }` — `src/interaction/triggers.ts`.
- `buildApprovalRequest` sets `type: "choose"`, `metadata: { approvalPrompt: true }`, option keys
  `allow`, `allow-remember`, `deny` — `src/interaction/ask-link-session.ts`.
- `InteractionChain.prompt` remaps a `choose` response to the option key —
  `src/interaction/chain.ts`.
- `ChatChains.isActive(chainId)` — `src/chat/jobs/chain-controller.ts`.
- `ChatJob` (`id`, `kind`, `chainId?`, `state`) and `JOB_ID_PATTERN` — `src/chat/jobs/job-types.ts`.
- `readJobRecords` reads only `*.json` names in `chat-jobs/` — `src/chat/jobs/job-store.ts`.
- `AskCard` renders a `question` pending entry with a text input that calls
  `controller.answerQuestion(requestId, text)` — `src/tui/chat/AskCard.tsx`.
- `config.interaction.defaults.chatAskFallbackMs` (default 60 000) —
  `src/config/schemas-infra.ts`.

Changed (baseline → target):
- `initInteractionChain` (`src/interaction/init.ts`).
  Baseline: `initInteractionChain(config, headless): Promise<InteractionChain | null>`.
  Target: `initInteractionChain(config, headless, options?: { readonly chatAsksDir?: string })`;
  plugin construction goes through a new `_interactionInitDeps.createInteractionPlugin`.
- `setupRun` (`src/execution/lifecycle/run-setup.ts`).
  Baseline: `RunSetupOptions` has no ask directory; calls `initInteractionChain(config, headless)`
  directly.
  Target: `RunSetupOptions.chatAsksDir?: string`; calls
  `_runSetupDeps.initInteractionChain(config, headless, chatAsksDir ? { chatAsksDir } : undefined)`.
  `RunOptions` (`src/execution/runner.ts`), `RunnerSetupOptions`
  (`src/execution/runner-setup.ts`) and the run CLI options (`bin/run-action.ts`,
  `bin/run-action-execute.ts`, `bin/nax.ts`) carry `chatAsksDir` the same way they carry
  `headless`. The option is declared as `new Option("--chat-asks <dir>").hideHelp()`; the run
  action validates it with `parseChatAsksFlag` beside `parseMaxIterationsFlag` and on failure
  prints the message and exits 1, as that flag does.
- `buildJobsInstructions` (`src/prompts/builders/workflow-builder.ts`).
  Baseline: `buildJobsInstructions(): string`, eight lines.
  Target: `buildJobsInstructions(options?: { readonly answerAsks?: boolean }): string`; with
  `answerAsks: true` a ninth, last line names `nax-jobs__answer_ask`; without it the output is
  unchanged.
- Bot deps. `_botReviewDeps` is defined in `src/bot/review-deps.ts` and re-exported by
  `review-run.ts`; `_botFixDeps` (`src/bot/fix-run.ts`) copies members of it by value at load.
  Target: `initInteractionChain` is a member of both `_botReviewDeps` and `_botFixDeps`, so a test
  stubs each one separately.
- Bot inputs (`src/bot/review-run.ts`, `src/bot/fix-run.ts`, `src/cli/bot.ts`).
  Baseline: `BotReviewInput` / `BotFixInput` have no ask directory; `buildPrStepContext` is called
  without `interactionChain`.
  Target: `chatAsksDir?: string` on both inputs; when set, the chain from
  `initInteractionChain(config, true, { chatAsksDir })` is passed as `interactionChain` and
  destroyed when the step ends.
- `DetachedJobs.launch` (`src/chat/jobs/job-runner.ts`).
  Baseline: spawns `request.argv` unchanged.
  Target: for `run`, `bot_review`, `bot_fix` calls a new `_jobRunnerDeps.createAsksDir(dir, now)`
  (creates the directory and writes the first heartbeat, in one try block) and spawns
  `[...request.argv, CHAT_ASKS_FLAG, dir]`; the record stores the spawned argv. The existing
  `_jobRunnerDeps.mkdir` keeps serving `jobsDir` only.
- `ChatAskController` (`src/chat/ask-controller.ts`).
  Target adds `requestHostQuestion(card: { text: string; signal?: AbortSignal }): Promise<string | null>`.
- `createHostJobs` (`src/chat/jobs/jobs-host.ts`) returns `runAsks: ChatRunAsks` too;
  `createJobsProvider` options gain `runAsks?: ChatRunAsks`; `ChatHost` gains
  `readonly runAsks?: ChatRunAsks`; `useJobs` options gain `note: (text: string) => void`.
- Launch warnings (`src/chat/jobs/jobs-launch.ts`, `src/chat/jobs/chain-tools.ts`).
  Baseline text: "warning: this run has no channel for its own asks; they will time out" and
  "warning: run steps have no channel for their own asks; they will time out".
  Target text: "asks you do not answer in chat fall to the run's timeout defaults" and
  "run steps' asks you do not answer in chat fall to their timeout defaults", still only when
  `interactionPlugin === "cli"`.

Size caps: `src/chat/chat-host.ts` is 597 lines and `src/tui/chat/ChatApp.tsx` 600 against the
600-line source cap. Keep the run-asks logic in `src/chat/jobs/` and `src/tui/chat/use-jobs.ts`;
the two capped files get only the field and the option wiring, offset by collapsing existing
lines (for example the multi-line `useJobs` destructuring in `ChatApp.tsx`, and in
`chat-host.ts` declaring `runAsks` beside `jobs` and assigning it in the existing `hostJobs`
block) so each stays at or under 600 lines.

### Failure Handling

| # | Situation | Behaviour |
|---|---|---|
| F1 | Child cannot write `<key>.ask.json` and has no fallback | `send` throws `NaxError` code `CHAT_ASK_WRITE_FAILED` (the existing callers already treat a thrown send as unavailable) |
| F2 | Child cannot write `<key>.ask.json` and has a fallback | the ask goes to the fallback at once; `receive` waits on the fallback only |
| F3 | `<key>.answer.json` is malformed JSON or has an unknown `action` | ignored with one warning; the child keeps waiting |
| F4 | `fallback.send` throws | warning; the child keeps waiting on the chat until the deadline |
| F5 | `fallback.receive` throws | warning; the child keeps waiting on the chat until the deadline |
| F6 | Heartbeat missing or older than `CHAT_ASK_STALE_MS` | treated as chat closed: the fallback starts at once |
| F7 | A `chat-agent` answer names `allow-remember`, or answers a human-only ask | child downgrades `allow-remember` to `allow`; child ignores an agent answer to a human-only ask and keeps waiting |
| F8 | Bot job: `initInteractionChain` throws for the ask directory | warning; the bot step runs without a chain (today's behaviour) |
| F9 | Job runner cannot create the ask directory or heartbeat | the job is spawned without `--chat-asks`; `job.note` says asks will not reach the chat |
| F10 | Registry tick hits a read error in an ask directory | warning; that directory is skipped this tick and retried next tick |
| F11 | Registry cannot write the user's answer file | transcript note "could not deliver your answer for <ask id>"; the child keeps waiting |
| F13 | A job leaves `running` while one of its cards is open | the card's signal is aborted; no answer is written |
| F12 | `--chat-asks` value is not an absolute path | `nax run` exits with "--chat-asks must be an absolute path"; `nax bot` prints it and exits 1 |

## Out of Scope

- koda and the ACP server: only the `nax chat` TUI host shows run-ask cards or delivers ask notices.
- Runs and bot jobs not launched from `nax chat`: without `--chat-asks` their interaction chain is built exactly as today.
- `nax plan` jobs: the job runner never adds `--chat-asks` to a plan argv.
- The in-run advisor answering tool approvals or triggers; the advisor is unchanged.
- Chain approval surviving a chat restart; re-attached jobs always get human cards.
- Recording `chat-user` / `chat-agent` in the approvals store `approvedBy` field or in approval-audit rows; the ask directory's answer and settled files are the record.
- The chat agent remembering an approval ("allow-remember"); only the user may choose it on a card.
- Changing `InteractionChain` cascade semantics or registering more than one plugin in a chain.
- Pruning or deleting ask directories after a job ends.
- Pipeline mode.
- US-006 only: an executable test of the `nax run` action exiting on a bad `--chat-asks`; `bin/run-action.ts` calls `process.exit` and is not unit-tested, as with `--max-iterations`. The parse is pinned through `parseChatAsksFlag`.
- US-005 only: a config with no `interaction` section; the schema always supplies one, and `initInteractionChain` keeps returning `null` for it.

## Stories

Fourteen stories, one capability (routing a launched job's asks into the chat). The count comes
from the 24-assertion cap, the five-file context cap and the child/parent split, not from
separable features; expect a draft PR more often at this size.

### US-001 — the chat ask file protocol

Workdir: packages/nax. No dependencies.

New `src/interaction/chat-ask-files.ts`: the record types, `chatAskKey`, the atomic writers and
readers for ask, answer, settled and notice files, the heartbeat helpers, the constants
`CHAT_ASKS_FLAG`, `CHAT_ASK_POLL_MS`, `RUN_ASK_POLL_MS`, `CHAT_ASK_STALE_MS`, and
`_chatAskFileDeps` for the file system. Exported from `src/interaction/index.ts`. Tests in a new
`test/unit/interaction/chat-ask-files.test.ts` against a temp directory.

### US-002 — `ChatAskPlugin`: the chat path

Workdir: packages/nax. Depends on US-001.

New `src/interaction/plugins/chat.ts`: `ChatAskPlugin` (`name`, `send`, `receive`, `cancel`,
`destroy`) without a fallback, and `_chatAskPluginDeps` timers and clock: writing asks and
notices, resolving from a chat answer, the timeout resolution and the settled record. Tests in a
new `test/unit/interaction/plugins/chat.test.ts` with fake timers.

### US-003 — `ChatAskPlugin`: guards and failures

Workdir: packages/nax. Depends on US-002.

Malformed answers (F3), the child-side agent guards (F7), `cancel`, an ask write failure with no
fallback (F1) and an unknown request id. Tests in a new
`test/unit/interaction/plugins/chat-guards.test.ts`.

### US-004 — `ChatAskPlugin`: the fallback

Workdir: packages/nax. Depends on US-003.

The `fallback` and `fallbackDelayMs` options: delayed and immediate (stale heartbeat) fallback
start, first answer wins, cancelling the loser, notify forwarding, F2, F4, F5, F6. Tests in a new
`test/unit/interaction/plugins/chat-fallback.test.ts` with a stub fallback plugin.

### US-005 — `initInteractionChain` with an ask directory, and `parseChatAsksFlag`

Workdir: packages/nax. Depends on US-004.

The `options.chatAsksDir` parameter and `_interactionInitDeps` in `src/interaction/init.ts`, and
`parseChatAsksFlag` in a new `src/cli/run-chat-asks.ts` (modelled on
`src/cli/run-max-iterations.ts`). Tests in new `test/unit/interaction/init-chat-asks.test.ts` and
`test/unit/cli/run-chat-asks.test.ts`.

### US-006 — `nax run --chat-asks`: threading to `setupRun`

Workdir: packages/nax. Depends on US-005.

The hidden option in `bin/nax.ts`, `RunCliOptions.chatAsks` and its validation in
`bin/run-action.ts`, the hand-off in `bin/run-action-execute.ts`, `RunOptions.chatAsksDir`
(`src/execution/runner.ts`), `RunnerSetupOptions.chatAsksDir`
(`src/execution/runner-setup.ts`), and `RunSetupOptions.chatAsksDir` with
`_runSetupDeps.initInteractionChain` (`src/execution/lifecycle/run-setup.ts`). The CLI → `run()`
hand-off is plain property passing like `headless` and is held by the type checker; the ACs pin
the `setupRun` and `runSetupPhase` end. Tests in a new
`test/unit/execution/lifecycle/run-setup-chat-asks.test.ts`.

### US-007 — `nax bot review` / `nax bot fix` `--chat-asks`

Workdir: packages/nax. Depends on US-005.

The hidden option on both bot commands, validation in `withBotInput` through
`parseChatAsksFlag`, `chatAsksDir` on `BotReviewInput` / `BotFixInput` (passed through
`runBotFixCycle` by its existing input spread), `initInteractionChain` added to `_botReviewDeps`
(`src/bot/review-deps.ts`) and to `_botFixDeps`, building and destroying the chain in
`reviewCheckout` and the fix step, and F8. Tests in a new `test/unit/bot/bot-chat-asks.test.ts`
and new cases in `test/unit/cli/bot-review.test.ts`.

### US-008 — the job runner creates the ask directory

Workdir: packages/nax. Depends on US-001.

`jobAsksDir` in `job-store.ts`; `_jobRunnerDeps.createAsksDir`; `DetachedJobs.launch` creates
the directory and first heartbeat and appends the flag for `run`, `bot_review`, `bot_fix`; F9.
Tests extend `test/unit/chat/jobs/job-runner.test.ts` and `test/unit/chat/jobs/job-store.test.ts`.

### US-009 — `requestHostQuestion` on the ask controller

Workdir: packages/nax. No dependencies.

A host-owned `question` pending entry answered through the existing `answerQuestion`, settled to
`null` on abort, timeout or `reset()`. Tests extend `test/unit/chat/ask-controller.test.ts`; the
three UI fakes listed under Modifies gain the method.

### US-010 — the run-asks registry: scanning, heartbeats and human cards

Workdir: packages/nax. Depends on US-002, US-008, US-009.

New `src/chat/jobs/run-asks.ts`: `createRunAsks`, the whole `ChatRunAsks` interface (members
filled later return their stated placeholders), `_runAsksDeps`, the poll tick (heartbeat refresh,
ask scan, settled scan), a human card for every new ask (the agent route arrives in US-013),
answer writing and closing a card whose ask settled elsewhere. Tests in a new
`test/unit/chat/jobs/run-asks.test.ts` and the cross-process seam in a new
`test/integration/chat/run-asks-round-trip.test.ts`.

### US-011 — the run-asks registry: transcript notes and dispose

Workdir: packages/nax. Depends on US-010.

`takeNotes()` and its line formats (settled elsewhere, timed out, notice files, F11), F10, F13,
and
`dispose()` removing heartbeats and stopping the tick. Tests in a new
`test/unit/chat/jobs/run-asks-notes.test.ts`.

### US-012 — `routeRunAsk`, the agent notice text and the instructions line

Workdir: packages/nax. No dependencies.

`routeRunAsk` and `MAX_CONSECUTIVE_AGENT_ASKS` in a new `src/chat/jobs/run-ask-route.ts`;
`buildRunAskNotice` in a new `src/prompts/builders/run-ask-builder.ts`, exported from
`src/prompts/index.ts`; the `answerAsks` option of `buildJobsInstructions`. All pure. Tests in
new `test/unit/chat/jobs/run-ask-route.test.ts` and
`test/unit/prompts/builders/run-ask-builder.test.ts`, and new cases in
`test/unit/prompts/builders/workflow-builder-chain.test.ts`.

### US-013 — the agent route in the registry

Workdir: packages/nax. Depends on US-011, US-012.

The registry calls `routeRunAsk` for each new ask with `chainActive` from
`chains.isActive(job.chainId)`: the agent notice queue (`peekNotice` / `takeNotice`), `answer`,
`escalate`, the agent streak and `noteUserTurn`. Tests in a new
`test/unit/chat/jobs/run-asks-agent.test.ts`.

### US-014 — the `nax-jobs__answer_ask` tool and chat wiring

Workdir: packages/nax. Depends on US-013.

The tool in `createJobsProvider` (only when `runAsks` is supplied, appended after
`chain_stop`), the provider's instructions calling `buildJobsInstructions({ answerAsks: true })`
when `runAsks` is supplied, `createHostJobs` composing the registry and disposing it in
`close()`, `ChatHost.runAsks`, `useJobs` delivering ask notices first and appending notes,
`noteUserTurn`, and the two launch-warning texts in `src/chat/jobs/jobs-launch.ts` and
`src/chat/jobs/chain-tools.ts` (not in Context Files because of the five-file cap; the Modifies
entries name their tests). Tests in a new
`test/unit/chat/jobs/answer-ask-tool.test.ts`, new cases in
`test/unit/chat/chat-host-jobs.test.ts`, a new `test/ui/chat/run-ask-notices.test.tsx`, and the
assertions listed under Modifies.

### Context Files

**US-001**
- `packages/nax/src/interaction/types.ts`
- `packages/nax/src/chat/jobs/job-store.ts`
- `packages/nax/src/interaction/index.ts`

**US-002**
- `packages/nax/src/interaction/types.ts`
- `packages/nax/src/interaction/chain.ts`
- `packages/nax/src/interaction/plugins/telegram.ts`
- `packages/nax/src/interaction/chat-ask-files.ts` — created by US-001, used here

**US-003**
- `packages/nax/src/interaction/plugins/chat.ts` — created by US-002, extended here
- `packages/nax/src/interaction/ask-link-session.ts`
- `packages/nax/src/interaction/triggers.ts`

**US-004**
- `packages/nax/src/interaction/plugins/chat.ts` — created by US-002, extended here
- `packages/nax/src/interaction/plugins/telegram.ts`
- `packages/nax/src/interaction/chat-ask-files.ts` — created by US-001, used here

**US-005**
- `packages/nax/src/interaction/init.ts`
- `packages/nax/src/cli/run-max-iterations.ts`
- `packages/nax/src/interaction/plugins/chat.ts` — created by US-002, used here

**US-006**
- `packages/nax/src/execution/lifecycle/run-setup.ts`
- `packages/nax/src/execution/runner.ts`
- `packages/nax/bin/run-action.ts`
- `packages/nax/bin/run-action-execute.ts`
- `packages/nax/bin/nax.ts`

**US-007**
- `packages/nax/src/cli/bot.ts`
- `packages/nax/src/bot/review-run.ts`
- `packages/nax/src/bot/fix-run.ts`
- `packages/nax/src/bot/review-deps.ts`
- `packages/nax/src/cli/run-chat-asks.ts` — created by US-005, used here

**US-008**
- `packages/nax/src/chat/jobs/job-runner.ts`
- `packages/nax/src/chat/jobs/job-store.ts`
- `packages/nax/src/chat/jobs/job-types.ts`
- `packages/nax/test/unit/chat/jobs/job-runner.test.ts`

**US-009**
- `packages/nax/src/chat/ask-controller.ts`
- `packages/nax/src/tui/chat/AskCard.tsx`
- `packages/nax/test/unit/chat/ask-controller.test.ts`

**US-010**
- `packages/nax/src/chat/jobs/job-runner.ts`
- `packages/nax/src/chat/jobs/chain-controller.ts`
- `packages/nax/src/chat/ask-controller.ts`
- `packages/nax/src/interaction/chat-ask-files.ts` — created by US-001, used here
- `packages/nax/src/interaction/plugins/chat.ts` — created by US-002, used by the seam test

**US-011**
- `packages/nax/src/chat/jobs/run-asks.ts` — created by US-010, extended here
- `packages/nax/src/interaction/chat-ask-files.ts` — created by US-001, used here

**US-012**
- `packages/nax/src/prompts/builders/workflow-builder.ts`
- `packages/nax/src/interaction/triggers.ts`
- `packages/nax/src/interaction/ask-link-session.ts`
- `packages/nax/src/chat/jobs/job-types.ts`
- `packages/nax/test/unit/prompts/builders/workflow-builder-chain.test.ts`

**US-013**
- `packages/nax/src/chat/jobs/run-asks.ts` — created by US-010, extended here
- `packages/nax/src/chat/jobs/run-ask-route.ts` — created by US-012, used here
- `packages/nax/src/prompts/builders/run-ask-builder.ts` — created by US-012, used here

**US-014**
- `packages/nax/src/chat/jobs/jobs-provider.ts`
- `packages/nax/src/chat/jobs/jobs-host.ts`
- `packages/nax/src/chat/chat-host.ts`
- `packages/nax/src/tui/chat/use-jobs.ts`
- `packages/nax/src/tui/chat/ChatApp.tsx`

### Creates

**US-001**
- `packages/nax/src/interaction/chat-ask-files.ts`
- `packages/nax/test/unit/interaction/chat-ask-files.test.ts`

**US-002**
- `packages/nax/src/interaction/plugins/chat.ts`
- `packages/nax/test/unit/interaction/plugins/chat.test.ts`

**US-003**
- `packages/nax/test/unit/interaction/plugins/chat-guards.test.ts`

**US-004**
- `packages/nax/test/unit/interaction/plugins/chat-fallback.test.ts`

**US-005**
- `packages/nax/src/cli/run-chat-asks.ts`
- `packages/nax/test/unit/interaction/init-chat-asks.test.ts`
- `packages/nax/test/unit/cli/run-chat-asks.test.ts`

**US-006**
- `packages/nax/test/unit/execution/lifecycle/run-setup-chat-asks.test.ts`

**US-007**
- `packages/nax/test/unit/bot/bot-chat-asks.test.ts`

**US-008**
- None.

**US-009**
- None.

**US-010**
- `packages/nax/src/chat/jobs/run-asks.ts`
- `packages/nax/test/unit/chat/jobs/run-asks.test.ts`
- `packages/nax/test/integration/chat/run-asks-round-trip.test.ts`

**US-011**
- `packages/nax/test/unit/chat/jobs/run-asks-notes.test.ts`

**US-012**
- `packages/nax/src/chat/jobs/run-ask-route.ts`
- `packages/nax/src/prompts/builders/run-ask-builder.ts`
- `packages/nax/test/unit/chat/jobs/run-ask-route.test.ts`
- `packages/nax/test/unit/prompts/builders/run-ask-builder.test.ts`

**US-013**
- `packages/nax/test/unit/chat/jobs/run-asks-agent.test.ts`

**US-014**
- `packages/nax/test/unit/chat/jobs/answer-ask-tool.test.ts`
- `packages/nax/test/ui/chat/run-ask-notices.test.tsx`

### Modifies

**US-008**
- `packages/nax/test/unit/chat/jobs/job-runner.test.ts` — the start test asserts `_jobRunnerDeps.spawn` was called with exactly `request.argv` for a `run` request; a `run` job is now spawned with `--chat-asks <jobAsksDir(outputDir, job.id)>` appended. Replace the expectation with `[...request.argv, "--chat-asks", jobAsksDir(outputDir, job.id)]`; the spawn options assertion is unchanged.
- `packages/nax/test/unit/chat/jobs/job-runner.test.ts` — the clone test asserts `jobs.get(first.id)?.argv` equals `request.argv`; the record now stores the spawned argv. Compare against the spawned argv (request argv plus the flag pair); the invariant that mutating a returned record does not change the stored one is unchanged.

**US-009**
- `packages/nax/test/ui/chat/ask-card.test.tsx` — the hand-written `ChatAskController` fake no longer satisfies the interface once `requestHostQuestion` is required. Add `requestHostQuestion: async () => null`; no assertion changes.
- `packages/nax/test/ui/chat/chat-app.test.tsx` — the host fixture's `asks` object no longer satisfies `ChatAskController` once `requestHostQuestion` is required. Add `requestHostQuestion: async () => null`; no assertion changes.
- `packages/nax/test/ui/chat/slash-commands.test.tsx` — the host fixture's `asks` object no longer satisfies `ChatAskController` once `requestHostQuestion` is required. Add `requestHostQuestion: async () => null`; no assertion changes.

**US-014**
- `packages/nax/test/unit/chat/chat-host-chain.test.ts` — AC-14 asserts the provider built by a real `createHostJobs` lists exactly `plan, run, bot_review, bot_fix, list, cancel, chain, chain_check, chain_stop`; `createHostJobs` now supplies `runAsks`, so `answer_ask` is appended after `chain_stop`. Append `"answer_ask"` to the expected list; the order of the other tools is unchanged.
- `packages/nax/test/unit/chat/chat-host-chain.test.ts` — AC-17 asserts the same nine-tool list on a real `ChatHost`; `answer_ask` is appended after `chain_stop` for the same reason. Append `"answer_ask"` to that expected list too.
- `packages/nax/test/unit/chat/jobs/jobs-launch.test.ts` — the cli-plugin test asserts the card reason contains "warning: this run has no channel for its own asks; they will time out". The text is now "asks you do not answer in chat fall to the run's timeout defaults"; assert that text instead. The telegram test asserting no "no channel" text stays, and also asserts the new text is absent.
- `packages/nax/test/unit/chat/jobs/jobs-launch-chain.test.ts` — asserts the launch result contains "warning: this run has no channel for its own asks; they will time out". Replace with "asks you do not answer in chat fall to the run's timeout defaults".
- `packages/nax/test/unit/chat/jobs/chain-tool-card.test.ts` — the AC-11 row expects "warning: run steps have no channel for their own asks; they will time out". Replace with "run steps' asks you do not answer in chat fall to their timeout defaults".

### Seams

- US-001 → US-002..US-004, US-008, US-010: the file protocol. Pinned end to end by the US-010
  round-trip integration AC (a real `ChatAskPlugin` and a real registry over one temp directory).
- US-001 → US-008 → US-006 / US-007: `CHAT_ASKS_FLAG`. The runner appends it (US-008 AC); the
  bot CLI parses it (US-007 ACs) and the run setup hands the directory to `initInteractionChain`
  (US-006 ACs).
- US-004 → US-005: `initInteractionChain` builds `ChatAskPlugin` with the configured fallback and
  `chatAskFallbackMs` (US-005 ACs on `_interactionInitDeps`).
- US-005 → US-006 / US-007: `initInteractionChain(..., { chatAsksDir })` is reached from
  `setupRun` / `runSetupPhase` (US-006 ACs) and from `runBotReview` / `runBotFix` (US-007 ACs).
- US-009 → US-010: `requestHostQuestion` is called for `input` asks (US-010 AC).
- US-012 → US-013: the registry calls `routeRunAsk` and `buildRunAskNotice` (US-013 ACs drive a
  new ask file through the tick and observe the route and the notice).
- US-010..US-013 → US-014: `ChatRunAsks` reaches the tool, the host and the TUI (US-014 ACs at
  `createHostJobs`, `createJobsProvider` and the rendered `ChatApp`).

## Acceptance Criteria

### US-001

1. [unit] `chatAskKey("trigger-pre-merge-1-abc")` returns a 16-character lowercase hex string.
2. [unit] `chatAskKey` returns the same key for the same request id on two calls.
3. [unit] `chatAskKey` returns different keys for `"ix-a"` and `"ix-b"`.
4. [unit] `writeChatAsk(dir, request, now)` resolves to `chatAskKey(request.id)`.
5. [unit] after `writeChatAsk(dir, request, now)`, the record `readChatAsks(dir)` returns has a `request` deep-equal to `request`.
6. [unit] that record's `askedAt` equals `now.toISOString()`.
7. [unit] `readChatAsks(dir)` returns the valid records when another `<key>.ask.json` file in `dir` holds malformed JSON.
8. [unit] after `writeChatAnswer(dir, key, answer)`, `readChatAnswer(dir, key)` returns an object deep-equal to `answer`.
9. [unit] `readChatAnswer(dir, key)` returns `undefined` when no answer file exists.
10. [unit] `readChatAnswer(dir, key)` returns `undefined` when the answer file holds malformed JSON.
11. [unit] `readChatAnswer(dir, key)` returns `undefined` when the answer file's `action` is not an `InteractionAction` value.
12. [unit] after `writeChatSettled(dir, key, settled)`, `readChatSettled(dir, key)` returns an object deep-equal to `settled`.
13. [unit] after `writeChatNotice(dir, request, now)`, the notice `takeChatNotices(dir)` returns has a `request` deep-equal to `request`.
14. [unit] a second `takeChatNotices(dir)` after the first returns an empty array.
15. [unit] when `_chatAskFileDeps.rename` throws, `writeChatAnswer` rejects.
16. [unit] after that rejected write, `readChatAnswer(dir, key)` returns `undefined`.
17. [unit] after `writeChatHeartbeat(dir, now)`, `chatHeartbeatFresh(dir, now.getTime() + CHAT_ASK_STALE_MS)` returns `true`.
18. [unit] after `writeChatHeartbeat(dir, now)`, `chatHeartbeatFresh(dir, now.getTime() + CHAT_ASK_STALE_MS + 1)` returns `false`.
19. [unit] `chatHeartbeatFresh(dir, Date.now())` returns `false` when `dir` has no `heartbeat.json`.
20. [unit] after `removeChatHeartbeat(dir)`, `chatHeartbeatFresh(dir, Date.now())` returns `false`.

### US-002

1. [unit] a `ChatAskPlugin` constructed with `{ dir }` has `name` equal to `"chat"`.
2. [unit] `send` of a `confirm` request writes an ask record that `readChatAsks(dir)` returns with the same `request.id`.
3. [unit] `send` of a `notify` request writes a notice that `takeChatNotices(dir)` returns.
4. [unit] `send` of a `notify` request leaves `readChatAsks(dir)` empty.
5. [unit] `receive(request.id, 60_000)` resolves with `action: "approve"` once `writeChatAnswer` writes `action: "approve"` for the request's key.
6. [unit] that response has `respondedBy: "chat-user"`.
7. [unit] after a `choose` request is answered with `action: "choose"`, `value: "skip"`, `receive` resolves with `value: "skip"`.
8. [unit] after `receive` resolves from a chat answer, `readChatSettled(dir, key)` returns `by: "chat-user"`.
9. [unit] with no answer, `receive(request.id, 2_000)` resolves with `action: "skip"` when the fake clock passes 2 000 ms.
10. [unit] that timeout response has `respondedBy: "timeout"`.
11. [unit] after a timeout, `readChatSettled(dir, key)` returns `by: "timeout"`.
12. [integration] an `InteractionChain` with only a `ChatAskPlugin` registered resolves `chain.prompt` of a `choose` request answered with `value: "allow"` to a response whose `action` is `"allow"`.

### US-003

1. [unit] an answer file holding malformed JSON does not resolve `receive`.
2. [unit] a valid answer written after a malformed one resolves `receive`.
3. [unit] a malformed answer file logs exactly one warning across several polls.
4. [unit] for a request with `metadata.approvalPrompt: true`, a `chat-agent` answer with `value: "allow-remember"` resolves `receive` with `value: "allow"`.
5. [unit] for a request with `metadata.safety: "red"`, a `chat-agent` answer does not resolve `receive`.
6. [unit] for that red-tier request, a later `chat-user` answer resolves `receive`.
7. [unit] for a request with `metadata.trigger: "pre-merge"`, a `chat-agent` answer does not resolve `receive`.
8. [unit] for a request with `metadata.trigger: "human-review"`, a `chat-agent` answer does not resolve `receive`.
9. [unit] `cancel(request.id)` while `receive` waits resolves it with `respondedBy: "timeout"`.
10. [unit] after `cancel(request.id)`, `readChatSettled(dir, key)` returns `by: "cancelled"`.
11. [unit] when `_chatAskFileDeps.write` throws and the plugin has no fallback, `send` rejects with a `NaxError` whose code is `CHAT_ASK_WRITE_FAILED`.
12. [unit] `receive` for a request id that was never sent rejects with a `NaxError` whose code is `CHAT_ASK_UNKNOWN`.

### US-004

1. [unit] with a fresh heartbeat and `fallbackDelayMs: 60_000`, the stub fallback's `send` is not called before the fake clock reaches 60 000 ms after `send`.
2. [unit] with a fresh heartbeat and no chat answer, the stub fallback's `send` is called once with the request when the clock reaches `fallbackDelayMs`.
3. [unit] the stub fallback's `receive` is called with the request id and `540_000` when the ask's timeout is 600 000 ms and `fallbackDelayMs` is 60 000 ms.
4. [unit] when the stub fallback's `receive` resolves `{ action: "approve", respondedBy: "telegram" }`, `receive` resolves with that response.
5. [unit] after the fallback wins, `readChatSettled(dir, key)` returns `by: "telegram"`.
6. [unit] when a chat answer arrives after the fallback started, `receive` resolves with the chat answer.
7. [unit] in that case the stub fallback's `cancel` is called with the request id.
8. [unit] when `dir` has no heartbeat at `send`, the stub fallback's `send` is called during that `send` call.
9. [unit] when the heartbeat goes stale while `receive` waits, the stub fallback's `send` is called at the next poll before `fallbackDelayMs` has elapsed.
10. [unit] when the stub fallback's `receive` resolves `respondedBy: "timeout"` before the ask's deadline, `receive` still resolves with a chat answer written afterwards.
11. [unit] when the stub fallback's `send` throws, `receive` still resolves with a chat answer written afterwards.
12. [unit] when the stub fallback's `receive` rejects, `receive` still resolves with a chat answer written afterwards.
13. [unit] when the ask's deadline passes after the fallback started, the stub fallback's `cancel` is called with the request id.
14. [unit] `send` of a `notify` request with no heartbeat calls the stub fallback's `send` with that request.
15. [unit] `send` of a `notify` request with a fresh heartbeat does not call the stub fallback's `send`.
16. [unit] when `_chatAskFileDeps.write` throws and a fallback exists, `send` calls the stub fallback's `send` with the request.
17. [unit] after an ask write failure with a fallback, `receive` resolves with the stub fallback's non-timeout response.
18. [unit] `destroy()` calls the stub fallback's `destroy`.
19. [unit] when the stub fallback's `receive` resolves `respondedBy: "superseded"`, `receive` still resolves with a chat answer written afterwards.

### US-005

1. [unit] `initInteractionChain(config, true, { chatAsksDir })` with `interaction.plugin: "cli"` resolves to a chain whose `getPrimary()` has `name` `"chat"`.
2. [unit] with `interaction.plugin: "cli"` and `chatAsksDir`, `_interactionInitDeps.createInteractionPlugin` is not called.
3. [unit] with `interaction.plugin: "telegram"` and `chatAsksDir`, `_interactionInitDeps.createInteractionPlugin` is called with `"telegram"`.
4. [unit] with `interaction.plugin: "telegram"` and `chatAsksDir`, the stub telegram plugin's `init` is called with `config.interaction.config`.
5. [unit] with `chatAsksDir`, the primary plugin's `fallbackDelayMs` equals `config.interaction.defaults.chatAskFallbackMs`.
6. [unit] without `options`, `initInteractionChain(config, true)` with `interaction.plugin: "cli"` still resolves to `null`.
7. [unit] `parseChatAsksFlag(undefined)` returns `{ ok: true, value: undefined }`.
8. [unit] `parseChatAsksFlag("/tmp/out/chat-jobs/run-1a2b3c4d.asks")` returns `{ ok: true, value: "/tmp/out/chat-jobs/run-1a2b3c4d.asks" }`.
9. [unit] `parseChatAsksFlag("relative/dir")` returns `{ ok: false, message: "--chat-asks must be an absolute path" }`.

### US-006

1. [integration] `setupRun` with `chatAsksDir: "/tmp/asks"` calls `_runSetupDeps.initInteractionChain` with `(config, headless, { chatAsksDir: "/tmp/asks" })` (drive the real `setupRun` as `run-setup-command-interceptor.test.ts` does).
2. [integration] `setupRun` without `chatAsksDir` calls `_runSetupDeps.initInteractionChain` with `(config, headless, undefined)`.
3. [integration] `runSetupPhase` given `chatAsksDir: "/tmp/asks"` reaches `_runSetupDeps.initInteractionChain` with `{ chatAsksDir: "/tmp/asks" }` as the third argument.
4. [integration] the chain `_runSetupDeps.initInteractionChain` returns is the `interactionChain` `setupRun` resolves with.

### US-007

1. [unit] `botReviewCommand({ pr: "12", dir, chatAsks: "relative" }, deps)` resolves `1`.
2. [unit] in that call `deps.logErr` receives "--chat-asks must be an absolute path".
3. [unit] `botReviewCommand({ pr: "12", dir, chatAsks: "/tmp/asks" }, deps)` calls `deps.runBotReview` with an input whose `chatAsksDir` is `"/tmp/asks"`.
4. [unit] `botFixCommand({ pr: "12", dir, chatAsks: "/tmp/asks" }, deps)` calls `deps.runBotFixCycle` with an input whose `chatAsksDir` is `"/tmp/asks"`.
5. [unit] `botReviewCommand` without `chatAsks` calls `deps.runBotReview` with an input that has no `chatAsksDir` key.
6. [unit] `runBotFixCycle` passes `chatAsksDir` unchanged to `runBotFix`.
7. [unit] `runBotFixCycle` passes `chatAsksDir` unchanged to the re-review `runBotReview`.
8. [integration] `runBotReview` with `chatAsksDir: "/tmp/asks"` calls `_botReviewDeps.initInteractionChain` with `(config, true, { chatAsksDir: "/tmp/asks" })`.
9. [integration] `runBotReview` with `chatAsksDir` calls `_botReviewDeps.buildPrStepContext` with `interactionChain` set to the chain `initInteractionChain` returned.
10. [integration] `runBotReview` without `chatAsksDir` calls `_botReviewDeps.buildPrStepContext` with an input that has no `interactionChain` key.
11. [integration] `runBotReview` with `chatAsksDir` calls the chain's `destroy` once after the review step ends.
12. [integration] `runBotFix` with `chatAsksDir: "/tmp/asks"` calls `_botFixDeps.initInteractionChain` with `(config, true, { chatAsksDir: "/tmp/asks" })`.
13. [integration] `runBotFix` with `chatAsksDir` calls `_botFixDeps.buildPrStepContext` with `interactionChain` set to the chain `_botFixDeps.initInteractionChain` returned.
14. [integration] `runBotFix` with `chatAsksDir` calls the chain's `destroy` once after the fix step ends.
15. [integration] when `_botReviewDeps.initInteractionChain` rejects, `runBotReview` calls `buildPrStepContext` with no `interactionChain` key.
16. [integration] in that case `runBotReview` logs one warning naming the ask directory.
17. [integration] when `_botFixDeps.initInteractionChain` rejects, `runBotFix` calls `_botFixDeps.buildPrStepContext` with no `interactionChain` key.
18. [unit] the `review` and `fix` subcommands registered by `registerBotCommand` each accept `--chat-asks <dir>`.
19. [unit] the `--help` output of `nax bot review` omits `--chat-asks`.

### US-008

1. [unit] `jobAsksDir("/out", "run-1a2b3c4d")` returns `"/out/chat-jobs/run-1a2b3c4d.asks"`.
2. [unit] starting a `run` job spawns `[...request.argv, "--chat-asks", jobAsksDir(outputDir, job.id)]`.
3. [unit] starting a `bot_review` job spawns its argv with `"--chat-asks"` and `jobAsksDir(outputDir, job.id)` appended.
4. [unit] starting a `bot_fix` job spawns its argv with `"--chat-asks"` and `jobAsksDir(outputDir, job.id)` appended.
5. [unit] starting a `plan` job spawns exactly `request.argv`.
6. [unit] starting a `plan` job does not call `_jobRunnerDeps.createAsksDir`.
7. [unit] for a `run` job, `_jobRunnerDeps.createAsksDir` is called with `jobAsksDir(outputDir, id)` before `_jobRunnerDeps.spawn`.
8. [unit] with the real `createAsksDir`, `chatHeartbeatFresh(jobAsksDir(outputDir, id), now)` is `true` when `_jobRunnerDeps.spawn` runs for a `run` job.
9. [unit] the returned `ChatJob.argv` of a `run` job equals the spawned argv.
10. [unit] `start` leaves the caller's `request.argv` array unchanged.
11. [unit] when `_jobRunnerDeps.createAsksDir` throws, the `run` job is spawned with exactly `request.argv`.
12. [unit] when `_jobRunnerDeps.createAsksDir` throws, the returned job's `note` contains "asks will not reach the chat".
13. [unit] `readJobRecords(outputDir)` returns the job records when a `run-1a2b3c4d.asks` directory sits beside them.

### US-009

1. [unit] `requestHostQuestion({ text: "Which base branch?" })` adds a pending entry with `type: "question"` and that `text`.
2. [unit] that entry's `requestId` starts with `"host-question-"`.
3. [unit] `answerQuestion(requestId, "main")` on that entry resolves the promise with `"main"`.
4. [unit] after `answerQuestion` on that entry, `pending()` no longer contains it.
5. [unit] aborting the card's `signal` resolves the promise with `null`.
6. [unit] after the abort, `pending()` no longer contains the entry.
7. [unit] a `signal` already aborted at the call resolves `null` and adds no pending entry.
8. [unit] when the fake clock passes `approvalTimeoutMs`, the promise resolves `null`.
9. [unit] `reset()` resolves a waiting host question with `null`.

### US-010

1. [unit] a tick with one running job writes a heartbeat so that `chatHeartbeatFresh(jobAsksDir(outputDir, job.id), now)` is `true`.
2. [unit] a tick writes no heartbeat for a job whose `state` is `"succeeded"`.
3. [unit] a new `confirm` ask calls `asks.requestHostChoice` with the choices `[{ id: "approve", label: "Approve" }, { id: "reject", label: "Deny" }]`.
4. [unit] a new `choose` ask calls `asks.requestHostChoice` with one choice per `request.options` entry, mapped `{ id: key, label }`.
5. [unit] the card passed to `requestHostChoice` has `tool: "nax-run__ask"`.
6. [unit] the card passed to `requestHostChoice` has `fallback: "closed"`.
7. [unit] for a request with `detail: "cost $4.10 of $5.00"`, the card's `reason` is `"cost $4.10 of $5.00"`.
8. [unit] the `summary` passed to `requestHostChoice` is `"<jobId>: <request summary>"`.
9. [unit] a new `input` ask calls `asks.requestHostQuestion` with a `text` that starts with `"<jobId>: <request summary>"`.
10. [unit] every answer the registry writes for a card the user answered has `respondedBy: "chat-user"`.
11. [unit] when `requestHostChoice` resolves `"approve"` for a `confirm` ask, the answer written for that key has `action: "approve"`.
12. [unit] when `requestHostChoice` resolves `"allow"` for a `choose` ask, the answer written matches the object `{ action: "choose", value: "allow" }`.
13. [unit] when `requestHostQuestion` resolves `"main"`, the answer written matches the object `{ action: "input", value: "main" }`.
14. [unit] when `requestHostChoice` resolves `"closed"`, no answer file is written.
15. [unit] when `requestHostQuestion` resolves `null`, no answer file is written.
16. [unit] when a settled record appears for an ask whose card is open, the `signal` passed to `requestHostChoice` is aborted.
17. [unit] the same ask file seen on two ticks calls `requestHostChoice` once.
18. [unit] an ask that already has a settled record at its first tick calls neither `requestHostChoice` nor `requestHostQuestion`.
19. [unit] a `jobs.onChange` that leaves one job running starts the tick through `_runAsksDeps.setTimeout`.
20. [unit] while one job is running, the next tick is scheduled through `_runAsksDeps.setTimeout` with `RUN_ASK_POLL_MS`.
21. [unit] before US-013 fills it, `peekNotice()` returns `undefined`.
22. [integration] with a real `ChatAskPlugin` and a real registry over one temp directory, a `confirm` ask sent by the plugin and approved through a stubbed `requestHostChoice` resolves the plugin's `receive` with `action: "approve"`.
23. [integration] in the same round trip, the plugin's response has `respondedBy: "chat-user"`.

### US-011

1. [unit] after a settled record with `by: "telegram"` and `action: "approve"` for job `run-1a2b3c4d`, `takeNotes()` returns `["[run-1a2b3c4d] ask settled by telegram: approve"]`.
2. [unit] after a settled record with `by: "timeout"` for a request whose `summary` is `"Cost limit exceeded"`, `takeNotes()` returns `["[run-1a2b3c4d] ask timed out: Cost limit exceeded"]`.
3. [unit] a settled record with `by: "chat-user"` adds no line to `takeNotes()`.
4. [unit] a settled record with `by: "chat-agent"` adds no line to `takeNotes()`.
5. [unit] a settled record with `by: "cancelled"` adds no line to `takeNotes()`.
6. [unit] a notice file whose request `summary` is `"advisor: ruling flagged for a human"` makes `takeNotes()` return `["[run-1a2b3c4d] advisor: ruling flagged for a human"]`.
7. [unit] a second `takeNotes()` call after the first returns an empty array.
8. [unit] when writing the user's answer throws for request id `"ix-1"`, `takeNotes()` returns one line equal to `"[run-1a2b3c4d] could not deliver your answer for run-1a2b3c4d/"` followed by `chatAskKey("ix-1")`.
9. [unit] `onChange` listeners are called when a new note is queued.
10. [unit] the same settled record seen on two ticks queues one line.
11. [unit] when reading one job's ask directory throws, the tick still raises a card for another job's new ask.
12. [unit] that read failure logs one warning through `options.logger.warn`.
13. [unit] `dispose()` removes the heartbeat of every running job's ask directory.
14. [unit] after `dispose()`, advancing the fake clock by `RUN_ASK_POLL_MS` writes no heartbeat.
15. [unit] when a job's `state` changes from `"running"` to `"cancelled"` while its card is open, the `signal` passed to `requestHostChoice` is aborted.
16. [unit] in that case no answer file is written for that ask.

### US-012

1. [unit] `routeRunAsk` returns `"human"` for a job with no `chainId`.
2. [unit] `routeRunAsk` returns `"human"` when `chainActive` is `false`.
3. [unit] `routeRunAsk` returns `"human"` for a request with `metadata.safety: "red"` under an active chain.
4. [unit] `routeRunAsk` returns `"human"` for a request with `metadata.trigger: "pre-merge"` under an active chain.
5. [unit] `routeRunAsk` returns `"human"` for a request with `metadata.trigger: "human-review"` under an active chain.
6. [unit] `routeRunAsk` returns `"human"` when `agentStreak` equals `MAX_CONSECUTIVE_AGENT_ASKS` (3).
7. [unit] `routeRunAsk` returns `"agent"` for a `cost-warning` trigger request under an active chain with `agentStreak` 0.
8. [unit] `routeRunAsk` returns `"agent"` for a request with `metadata.approvalPrompt: true` under an active chain with `agentStreak` 0.
9. [unit] `buildRunAskNotice` output starts with `[nax-jobs] run ask <askId>`.
10. [unit] `buildRunAskNotice` output includes the request's `summary`.
11. [unit] `buildRunAskNotice` for a `confirm` request lists exactly the answers `approve`, `reject`, `escalate`.
12. [unit] `buildRunAskNotice` for a tool approval lists exactly the answers `allow`, `deny`, `escalate`.
13. [unit] `buildRunAskNotice` for a `choose` request lists exactly that request's option keys plus `escalate`.
14. [unit] `buildRunAskNotice` for an `input` request says the answer is free text and lists `escalate`.
15. [unit] `buildRunAskNotice` names the tool `nax-jobs__answer_ask`.
16. [unit] `buildJobsInstructions({ answerAsks: true })` returns nine lines whose last line names `nax-jobs__answer_ask`.
17. [unit] `buildJobsInstructions()` returns the same eight lines it returns today.

### US-013

1. [unit] an agent-routed ask calls neither `requestHostChoice` nor `requestHostQuestion`.
2. [unit] an agent-routed ask makes `peekNotice()` return the `buildRunAskNotice` text for ask id `<jobId>/<key>`.
3. [unit] `takeNotice()` returns that text.
4. [unit] after `takeNotice()`, `peekNotice()` returns `undefined`.
5. [unit] `answer("<jobId>/<key>", { answer: "approve", reason: "within budget" })` writes an answer with `action: "approve"`.
6. [unit] the answer written by `answer` has `respondedBy: "chat-agent"`.
7. [unit] the answer written by `answer` has `reason: "within budget"`.
8. [unit] after that agent answer, `takeNotes()` returns `["[<jobId>] agent answered approve: within budget"]`.
9. [unit] `answer` with `"allow-remember"` for a tool approval returns `{ ok: false }` and writes no answer file.
10. [unit] `answer` with a value that is not one of a `choose` request's option keys returns `{ ok: false }`.
11. [unit] `answer` with `"use main"` for an `input` ask writes the pair `action: "input"`, `value: "use main"`.
12. [unit] `answer` with `"escalate"` calls `requestHostChoice` for that ask.
13. [unit] `answer` with `"escalate"` removes that ask's notice from the queue.
14. [unit] `answer` for an unknown ask id returns `{ ok: false, message: "[chat] ask <id> is not waiting for the agent" }`.
15. [unit] `answer` for an ask already settled returns that same `{ ok: false }` message.
16. [unit] with an active chain, the fourth ask in a row with no `noteUserTurn()` between raises a human card.
17. [unit] after `noteUserTurn()`, the next ask under an active chain is agent-routed again.
18. [unit] when an agent-routed ask is settled elsewhere before its notice is taken, `peekNotice()` returns `undefined`.
19. [unit] a red-tier trigger ask from a job in the active chain raises a human card.
20. [unit] an ask from a job whose `chainId` is not active per `chains.isActive` raises a human card.
21. [unit] an ask the agent escalated counts toward the streak: after two agent-answered asks and one escalated ask, the next ask raises a human card.
22. [unit] when writing an agent answer throws, `answer` resolves `{ ok: false, message: "[chat] could not write the answer for <askId>" }`.

### US-014

1. [unit] `createJobsProvider` with `runAsks` lists `"answer_ask"` as the last tool.
2. [unit] the `answer_ask` tool's input schema requires `ask`, `answer` and `reason`.
3. [unit] `createJobsProvider` without `runAsks` lists no `"answer_ask"` tool.
4. [unit] running `answer_ask` with `{ ask, answer, reason }` calls `runAsks.answer(ask, { answer, reason })`.
5. [unit] running `answer_ask` when `runAsks.answer` returns `{ ok: false, message }` returns a result with `isError: true` and that message.
6. [unit] the instructions of a provider created with `runAsks` include a line naming `nax-jobs__answer_ask`.
7. [integration] `createHostJobs` returns a `runAsks`, and its provider's tools include `"answer_ask"`.
8. [integration] after `createHostJobs(...).close()`, a running job's ask directory has no fresh heartbeat.
9. [integration] a `ChatHost` opened with jobs enabled exposes a defined `runAsks`.
10. [integration] in a rendered `ChatApp` with an idle chat and both a run-ask notice and a job notice queued, the first delivered turn text is the run-ask notice.
11. [integration] after the run-ask notice turn is delivered, `runAsks.takeNotice` has been called once.
12. [integration] a `takeNotes()` line from `runAsks` appears in the rendered transcript as a notice row.
13. [integration] submitting a user turn in the rendered `ChatApp` calls `runAsks.noteUserTurn`.
14. [unit] the `nax-jobs__run` launch card with `interactionPlugin: "cli"` has a reason containing "asks you do not answer in chat fall to the run's timeout defaults".
15. [unit] the `nax-jobs__chain` card with a run step and `interactionPlugin: "cli"` contains "run steps' asks you do not answer in chat fall to their timeout defaults".
