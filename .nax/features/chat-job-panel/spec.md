# SPEC: Chat job panel, turn end time and native chat compaction

Closes: #2942, #2943, #2944

## Summary

Make a long `nax plan` / `nax run` visible and cheaper to wait for in `nax chat`. Each job the chat starts or re-attaches gets a live, collapsible panel in the transcript: state, elapsed time, cost, story progress, the current story and stage, the advisor's decisions (flagged first) and the job log tail. Every turn's stats row ends with the clock time the turn ended, and a turn that ends without stats still leaves its end time. The native chat session compacts at an absolute token cap (`chat.compaction.compactAtTokens`, default 200000) as well as at its window percentage, and compacts at most once per running job when the chat has been idle near the prompt-cache TTL while that job runs (`chat.compaction.idleCompactAfterMinutes`, default 55). Part of tracking issue #2946.

This feature extends the `chat` config block (`ChatConfigSchema`) added by the `chat-workflow-flow` feature, so it runs after that feature is merged.

## Motivation

- #2942: a job launched from chat runs headless (`chat/jobs/job-runner.ts`, output to `<outputDir>/chat-jobs/<id>.log`). The chat shows nothing until the `[nax-jobs] ... ended` notice, often hours later. The advisor's rulings during the run (`advisor/decision-log.ts` log lines, `<featureDir>/decisions.jsonl`) are never surfaced, including flagged ones. The footer strip shows only `run <feature> 4/13 $3.18`.
- #2944: the turn-stats row is `48.2 tok/s · 1.3k out · 14s` (`tui/chat/turn-stats.ts`). It has no end time, so after a long run the user cannot tell how long the chat has been idle or whether the prompt cache has expired. Cancelled, timed-out, interrupted and errored turns leave no row.
- #2943: the native chat compacts only at `execution.compaction.compactAtPercent` (default 90) of the model window. On a 1M-token window that is about 900k tokens, so the first turn after a multi-hour job pays a full cache write on a very large context. Nothing reacts to idle time.

## Design

### Scope, approach and conventions

- New code goes in new files. `packages/nax/src/tui/chat/chat-status.ts` is at the 600-line source limit and must not grow; `ChatApp.tsx` gains only the hook calls.
- `setInterval` is banned; timers use `setTimeout` with `clearTimeout`, the documented exception for a timer cancelled mid-flight. Each such call site carries the one-line comment saying so.
- The panel and the idle compactor are display and host behaviour only: none of the panel's content is added to the agent's context.
- Compaction changes apply to the native chat session only. ACP chat agents own their context and are out of scope. A chat on an `acp:` model (`isChatAcpModel(host.current().model)`) never arms the idle compactor.
- Value imports across modules go through barrels (`check:alias-internals`): `decisionBody` is exported from `src/advisor/index.ts`; `readJobPanelView`, `buildJobPanelView` and the panel types from `src/chat/jobs/index.ts` and `src/chat/index.ts`; `createIdleCompactor`, `chatCompactAtTokens` and `idleCompactAfterMs` from `src/chat/index.ts`. The TUI imports them from `@/chat` and `@/advisor`.

### Integration

Read-only (verified):

- `packages/nax/src/chat/jobs/job-types.ts` — `ChatJob { id; kind; target; cwd; startedAt; endedAt?; state; logPath; sessionId; cost?; progress?; ... }`, `ChatJobState = "running" | "succeeded" | "failed" | "cancelled" | "lost"`, `isRunJobKind`.
- `packages/nax/src/chat/jobs/job-runner.ts` — `ChatJobs.list()`, `.running()`, `.onChange(listener)`, `.logTail(id, lines?) : Promise<string>`.
- `packages/nax/src/execution/status-file.ts` — `NaxStatusFile` with `progress { total; passed; ... }`, `cost { spent }`, `current { storyId; title; phase; ... } | null`.
- `packages/nax/src/advisor` (barrel) — `readDecisions(repoRoot, feature): Promise<AdviceDecision[]>`; `AdviceDecision { kind; storyId?; action; confidence: "high" | "medium" | "low"; needsHumanConfirm; decidedAt; ... }`. `decisionBody(decision)` in `advisor/decision-log.ts` renders `[<kind>] <storyId | "feature">: <ruling> (confidence <c>)`.
- `packages/nax/src/prd` — `loadPRD(path)`; each story has `id`, `title`, `status: StoryStatus`.
- `packages/nax/src/tui/chat/transcript-click.ts` — `CollapsibleEntry` union and `toggleTranscriptLine`.
- `packages/nax/src/tui/chat/layout-background.ts` / `layout-lines.ts` — `cardRows`, `cardIndent`, `resultPrefix`, `SHOW_HINT`, `HIDE_HINT`, `SpanStyle` (`color: "accent" | "muted" | "success" | "warning" | "danger"`).
- `packages/nax/src/chat/host-steer-compact.ts` — `ChatHost.compact(): Promise<CompactResult>`; `ChatApp.tsx` `compactTurn()` runs it with the working line, the notice rows and the turn slot.
- `packages/nax/src/config/schemas-chat.ts` — `ChatConfigSchema`, created by `chat-workflow-flow`.

The baselines below only locate the code; implement the target.

- `TranscriptEntry` in `packages/nax/src/tui/chat/transcript-model.ts`
  - Target: gains `| { kind: "job"; view: JobPanelView; open?: boolean }`.
- `CollapsibleEntry` and `toggleTranscriptLine` in `transcript-click.ts`
  - Baseline: kinds other than `attachment`, `background`, `listing`, `thinking`, `tool` and `skill` return the entries unchanged.
  - Target: `CollapsibleEntry` includes `"job"`, and a `job` entry toggles on its first row only, as a `background` entry does.
- `cachedLines` in `packages/nax/src/tui/chat/layout.ts`
  - Baseline: only the listed collapsible kinds use `entry.open ?? base.expanded`.
  - Target: `job` joins that list, so a panel's own `open` flag decides its expansion.
- `ChatAppProps` in `packages/nax/src/tui/chat/ChatApp.tsx`
  - Target: gains `readonly idleCompactAfterMs?: number` (absent means 0, off); `cli/chat.ts` `screenProps` sets it to `idleCompactAfterMs(config)`.
- `ChatGlyphs` in `packages/nax/src/tui/chat/theme.ts`
  - Target: gains `progressFull` (`"█"`, ASCII `"#"`) and `progressEmpty` (`"░"`, ASCII `"."`).
- `turnStatsText` in `packages/nax/src/tui/chat/turn-stats.ts`
  - Baseline: `turnStatsText(input: { rate; outputTokens; elapsedMs }): string`.
  - Target: `turnStatsText(input: { rate; outputTokens; elapsedMs; endedAt?: string; now?: Date }): string`; with `endedAt` it appends `· <clock>`.
- `turnStatsEntry`
  - Baseline: `turnStatsEntry(events, end): TranscriptEntry | undefined`; undefined unless `completed` with output.
  - Target: `turnStatsEntry(events, end, now: Date = new Date()): TranscriptEntry`; always returns a row (see "Turn end time").
- `job-outcome.ts`
  - Target: exports `readJobStatus(job, repoRoot): Promise<NaxStatusFile | null>`, the existing pid-matched `matchingStatus` read.
- `ResolvedCompaction` in `packages/nax-agent/src/native/session/compaction.ts`
  - Baseline: `{ enabled; compactAtPercent; keepRecentPercent }`.
  - Target: gains `readonly compactAtTokens?: number`.
- `compactionThreshold(window, cfg)` / `keepBudget(window, cfg, aggressive)`
  - Target: see "Token cap composition".
- `compactionSettingsSchema` in `packages/nax-agent/src/native/session/compaction-settings.ts`
  - Target: gains `compactAtTokens: z.number().int().optional()` accepting 0 or a value of at least `MIN_COMPACT_AT_TOKENS` (10000), with the message `compactAtTokens must be 0 (off) or at least 10000`; `DEFAULT_COMPACTION` is unchanged. This is the shared schema, so `execution.compaction.compactAtTokens` becomes a valid setting for every native session that reads `execution.compaction` (story sessions, chat subagents, the `nax-agent` ACP server in `nax-agent-acp/src/server/main.ts`) with no default, meaning no cap. The chat session alone gets its cap from `chat.compaction` (below), which always replaces any `execution.compaction.compactAtTokens` for the chat.
- `ExecutionConfig.compaction` in `packages/nax/src/config/runtime-types.ts`
  - Baseline: `{ enabled: boolean; compactAtPercent: number; keepRecentPercent: number }`.
  - Target: adds `compactAtTokens?: number`.
- `NativeBackendOptions.compaction` in `packages/nax-agent/src/session/native-backend-options.ts`
  - Target: gains `readonly compactAtTokens?: number`.
- Chat session options in `packages/nax/src/chat/open-chat-session.ts`
  - Baseline: `const compaction = request.config.execution.compaction;` passed unchanged.
  - Target: `{ ...request.config.execution.compaction, compactAtTokens: chatCompactAtTokens(request.config) }`.
- `ChatConfigSchema` in `packages/nax/src/config/schemas-chat.ts` and `ChatConfig` in `runtime-types-chat.ts`
  - Target: gain `compaction?: { compactAtTokens: number; idleCompactAfterMinutes: number }`.

### New identifiers

```typescript
// packages/nax/src/chat/jobs/job-panel-view.ts
export const JOB_PANEL_LOG_LINES = 12;
export interface JobPanelStory { readonly id: string; readonly title: string; readonly status: StoryStatus; readonly current: boolean }
export interface JobPanelDecision { readonly line: string; readonly flagged: boolean }
export interface JobPanelView {
  readonly jobId: string;
  readonly kind: ChatJobKind;
  readonly target: string;
  readonly state: ChatJobState;
  readonly elapsedMs: number;
  readonly cost?: number;
  readonly progress?: { readonly passed: number; readonly total: number };
  readonly current?: { readonly storyId: string; readonly phase: string };
  readonly stories: readonly JobPanelStory[];
  /** Flagged first, then newest first. */
  readonly decisions: readonly JobPanelDecision[];
  readonly logTail: readonly string[];
}
export interface JobPanelSources {
  readonly job: ChatJob;
  readonly now: Date;
  readonly status: NaxStatusFile | null;
  readonly stories: readonly { readonly id: string; readonly title: string; readonly status: StoryStatus }[];
  readonly decisions: readonly AdviceDecision[];
  readonly logTail: string;
}
export function buildJobPanelView(sources: JobPanelSources): JobPanelView;
export const _jobPanelDeps: { readJobStatus; loadPRD; readDecisions; exists };
export function readJobPanelView(job: ChatJob, jobs: Pick<ChatJobs, "logTail">, now: Date): Promise<JobPanelView>;

// packages/nax/src/tui/chat/layout-job.ts
export const JOB_PROGRESS_CELLS = 16;
export const JOB_PANEL_DECISION_ROWS = 10;
export function formatElapsed(ms: number): string;
export function jobPanelLines(entry: Extract<TranscriptEntry, { kind: "job" }>, context: LayoutContext): readonly StyledLine[];

// packages/nax/src/tui/chat/job-panel-entries.ts
export function upsertJobPanel(entries: readonly TranscriptEntry[], view: JobPanelView): readonly TranscriptEntry[];
export function hasJobPanel(entries: readonly TranscriptEntry[], jobId: string): boolean;

// packages/nax/src/tui/chat/use-job-panels.ts
export const JOB_PANEL_REFRESH_MS = 2000;
export function useJobPanels(input: { readonly host: ChatHost; readonly setEntries: (update: (rows: readonly TranscriptEntry[]) => readonly TranscriptEntry[]) => void; readonly turnRunning: boolean }): void;

// packages/nax/src/tui/chat/turn-stats.ts
export function turnEndClock(endedAt: string, now: Date): string;

// packages/nax/src/config/schemas-chat.ts
export const DEFAULT_CHAT_COMPACT_AT_TOKENS = 200_000;
export const DEFAULT_IDLE_COMPACT_AFTER_MINUTES = 55;

// packages/nax/src/chat/chat-compaction.ts
export const IDLE_COMPACT_MIN_TOKENS = 20_000;
export function chatCompactAtTokens(config: NaxConfig): number;          // chat.compaction.compactAtTokens ?? DEFAULT_CHAT_COMPACT_AT_TOKENS
export function idleCompactAfterMs(config: NaxConfig): number;           // minutes ?? DEFAULT_IDLE_COMPACT_AFTER_MINUTES, times 60000
export interface IdleCompactState {
  readonly idle: boolean;
  readonly runningJobId?: string;
  readonly contextTokens?: number;
  readonly acp: boolean;
}
/** An armed timer's handle: the runtime's own, or a fake clock's number. */
export type TimerHandle = ReturnType<typeof setTimeout> | number;
export interface IdleCompactTimers {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}
export interface IdleCompactor { update(state: IdleCompactState): void; dispose(): void }
export function createIdleCompactor(options: {
  readonly delayMs: number;
  readonly onDue: (reason: string) => void;
  readonly timers?: IdleCompactTimers;
}): IdleCompactor;
// `timers` is this seam, not the global's own type: three libraries declare `setTimeout` (Bun
// `Timer`, @types/node `Timeout`, lib.dom `number`), so `typeof setTimeout` is one overload set
// that no fake implementation can satisfy, and the cast that would silence it is forbidden at
// baseline 0. `fakeTimers(clock)` in the test helpers adapts the fake clock to this shape.

// packages/nax-agent/src/native/session/compaction-settings.ts (exported from @nathapp/nax-agent/internal)
export const MIN_COMPACT_AT_TOKENS = 10_000;

// packages/nax/src/tui/chat/use-idle-compact.ts
export function useIdleCompact(input: { readonly host: ChatHost; readonly delayMs: number; readonly turnRunning: boolean; readonly contextTokens?: number; readonly compact: () => Promise<void>; readonly note: (text: string) => void }): void;
```

### Job panel view

`buildJobPanelView(sources)` is pure:

- `elapsedMs` = (`job.endedAt` ?? `now`) minus `job.startedAt`, floored at 0.
- `cost` = `status.cost.spent` when `status` is present, else `job.cost`.
- `progress` = `status.progress` `{ passed, total }` when present, else `job.progress`.
- `current` = `{ storyId, phase }` from `status.current` while `job.state` is `running`; absent otherwise.
- `stories` = the PRD stories in PRD order, `current` true for the story whose id equals the view's `current.storyId` (so no story is current once the job has ended).
- `decisions` = decisions whose `decidedAt` parses and is at or after `job.startedAt` (an unparseable `decidedAt` is dropped), each `{ line: decisionBody(decision), flagged: decision.needsHumanConfirm }`, sorted flagged first, then by `decidedAt` newest first.
- `logTail` = the last `JOB_PANEL_LOG_LINES` non-empty lines of `logTail`.

`readJobPanelView(job, jobs, now)` gathers the sources: for `run` and `finish` jobs, `readJobStatus(job, job.cwd)`, the PRD at `<featureDir(job.cwd, job.target)>/prd.json` when it exists, and `readDecisions(job.cwd, job.target)`; for `plan` and bot jobs, `status` null, no stories and no decisions. It always reads `jobs.logTail(job.id, JOB_PANEL_LOG_LINES)`. A source that throws or is missing contributes its empty value (`null`, `[]`, `""`); the panel still renders.

### Panel layout

Collapsed (default), two rows for a `run`/`finish` job with progress, one row otherwise:

```
❯ nax run review-and-gate-guards  running  42m  $3.18
  ████████░░░░░░░░ 4/13 · US-005 review · 2 advisor decisions (1 flagged)
```

- Row 1: the theme's `pointer` glyph, `nax <kind> <target>` (bot kinds: `nax bot review #<target>` / `nax bot fix #<target>`), the state word, `formatElapsed(elapsedMs)`, and `$<cost to 2 decimals>` when `cost` is set, separated by two spaces. The state word is coloured: `running` accent, `succeeded` success, `failed` and `lost` danger, `cancelled` warning. Row 1 ends with the theme's show/hide hint.
- Row 2 is drawn when `progress` is set or there is at least one decision; without `progress` it starts at the decisions part. Row 2: `JOB_PROGRESS_CELLS` cells, `round(JOB_PROGRESS_CELLS * passed / total)` of them `progressFull` (accent) and the rest `progressEmpty` (muted), then `<passed>/<total>`; then ` · <storyId> <phase>` when `current` is set; then ` · <n> advisor decision` for one or ` · <n> advisor decisions` for more (without the leading ` · ` when nothing precedes it), with ` (<m> flagged)` in the warning colour when `m > 0`. A `total` of 0 draws all cells empty.
- `formatElapsed`: under 60 s `<s>s`; under 60 min `<m>m`; otherwise `<h>h <mm>m` with two-digit minutes.

Expanded adds, after the collapsed rows, three sections in this order, each under a muted heading row and indented with `cardIndent`: `stories` (one row per story: a status word — `passed` success, `failed`/`regression-failed` danger, `in-progress` accent, everything else muted — then `<id> <title>`, and `◂ <phase>` after the current story), `advisor decisions` (one row per decision line, at most `JOB_PANEL_DECISION_ROWS` (10) rows followed by `+<n> more` when there are more; a flagged row starts with the theme's `warning` glyph and is drawn in the warning colour), and `log` (the log tail rows, muted). A section with nothing to show is omitted. Rows wrap to the transcript width through `cardRows`. With colour off every row is the same text without colour.

### Live wiring

`useJobPanels({ host, setEntries, turnRunning })`:

- Does nothing when `host.jobs` is absent.
- Subscribes to `host.jobs.onChange`. On every change, and every `JOB_PANEL_REFRESH_MS` while at least one paneled job is `running`, it refreshes the paneled jobs.
- A job becomes paneled when it is `running` and is not yet paneled: a job started in this chat and a job re-attached when the chat opened both qualify. A job already ended when first seen is never paneled. The paneled set lives in the hook, so after `/clear` or a resume replaces the entries, the next refresh of a still-paneled job appends its panel again.
- The hook keeps two per-job sets: `paneled` (jobs it shows) and `appended` (jobs whose entry it has added since the entries were last replaced). While `turnRunning` is true a refresh of a job not in `appended` computes its view but does not call `setEntries` (a turn's reply is still streaming, and an entry appended after it would split the reply); refreshes of `appended` jobs replace their entry in place. On the `turnRunning` true-to-false edge the hook runs one refresh for every `paneled` job not in `appended`, including a job that ended during the turn, so its panel appears after the turn showing its final state.
- The decision is made against the current entries inside the `setEntries` updater with `hasJobPanel`, so after the entries are replaced (`/clear`, resume) a job with no entry is again a first append and follows the same `turnRunning` rule; `appended` only drives the true-to-false flush.
- A refresh calls `readJobPanelView` for the job and applies `setEntries((rows) => upsertJobPanel(rows, view))`.
- Refreshes are serialized per job: a refresh for a job does not start while an earlier one for that job is pending. A job that has ended gets exactly one more applied refresh, started after any pending one settles (and, for a job not yet appended, held until the turn ends), so its result is the last one applied and the panel freezes on the final state. The job is not refreshed after that.
- On unmount it unsubscribes and clears its timer.

`upsertJobPanel(entries, view)` replaces the `job` entry whose `view.jobId` matches, keeping its `open` flag and its position; with no match it appends `{ kind: "job", view }`. It returns a new array and never mutates its input. `hasJobPanel(entries, jobId)` says whether a `job` entry for that id exists; inside the `setEntries` updater the hook uses it to decide, per the rule above, between replacing and holding back an append while a turn runs.

`ChatApp.tsx` calls `useJobPanels({ host, setEntries, turnRunning })` once. The `[nax-jobs]` notice to the agent, the background notice entry and the footer job strip are unchanged.

### Turn end time

`turnEndClock(endedAt, now)` renders the local time of `endedAt` as `HH:MM` (24-hour, two digits each) when it falls on the same local calendar day as `now`, and as `<Mon> <D> HH:MM` (`Nov 14 23:05`, English three-letter month) otherwise. An `endedAt` that does not parse renders as the empty string.

`turnStatsText` with `endedAt` appends ` · <turnEndClock(endedAt, now)>` (nothing when the clock is empty); without `endedAt` its output is unchanged.

`turnStatsEntry(events, end, now)`:

1. `completed` with output tokens: today's row plus ` · <clock>`, e.g. `48.2 tok/s · 1.3k out · 14s · 14:32`.
2. `completed` with no output tokens: `0 out · <s>s · <clock>`.
3. `cancelled`, `timed_out`, `interrupted`, `errored`: `<status word> · <clock>`, where the words are `cancelled`, `timed out`, `interrupted`, `errored`. When the clock is empty (an unparseable `end.at`) the row is the status word alone. This row is drawn in addition to the existing `Interrupted by user` or error row, so every turn ends with its time.

The clock comes from `end.at`. Times are local, so tests build `end.at` from local date parts.

### Token cap composition

`compactionThreshold(window, cfg)` and `keepBudget(window, cfg, aggressive)` apply, in this order:

1. `percentThreshold = min(floor(window * compactAtPercent / 100), window - headroom)` (today's rule).
2. When `cfg.compactAtTokens` is set and greater than 0, `threshold = min(percentThreshold, compactAtTokens)`; otherwise `threshold = percentThreshold`.
3. `keepBudget`: when step 2 lowered the threshold (the cap is below `percentThreshold`), `budget = floor(compactAtTokens * keepRecentPercent / compactAtPercent)`; otherwise today's `floor(window * keepRecentPercent / 100)`.
4. `aggressive` halves the step-3 budget, as today.

Because the schema requires `keepRecentPercent <= compactAtPercent - 20`, the step-3 budget is always below the threshold it pairs with, so a compaction can never leave history above its own trigger.

`chatCompactAtTokens(config)` is `config.chat?.compaction?.compactAtTokens ?? DEFAULT_CHAT_COMPACT_AT_TOKENS`; 0 turns the cap off. Only the native chat session (`open-chat-session.ts`) takes it; story sessions and chat subagents keep `execution.compaction` as configured.

### Idle compact

`createIdleCompactor({ delayMs, onDue })` keeps one timer:

- `update(state)` qualifies when `state.idle`, `state.runningJobId` is set, `state.acp` is false, `state.contextTokens` is at least `IDLE_COMPACT_MIN_TOKENS`, `delayMs` is greater than 0, and the compactor has not yet fired for `state.runningJobId`.
- A qualifying `update` arms the timer when none is armed; while one is armed for the same job, further qualifying updates leave it running (the timer is never restarted by a re-render). The timer's origin is therefore the first qualifying update: the later of the turn ending and the job starting.
- A qualifying `update` whose `runningJobId` differs from the job the armed timer was set for clears that timer and arms a new one for the new job, with its origin at that update.
- A non-qualifying `update` clears an armed timer.
- When the timer fires it calls `onDue("<minutes>m idle while job <jobId> runs")`, where minutes is `round(delayMs / 60000)`, and records `jobId` as fired. It fires at most once per job id for the compactor's lifetime, whatever the compaction's outcome, so a failed compaction is not retried.
- `dispose()` clears the timer.

`useIdleCompact({ host, delayMs, turnRunning, contextTokens, compact, note })` creates one compactor and calls `update` on every render with `idle = !turnRunning`, `runningJobId` = the id of the first job in `host.jobs?.running()`, the footer's `contextTokens`, and `acp = isChatAcpModel(host.current().model)`. `onDue(reason)` calls the latest `note` and `compact` passed to the hook (held in refs updated each render, since the timer fires after renders): `note(`idle compact: ${reason}`)`, then `compact()`. `ChatApp.tsx` passes `delayMs` from its `idleCompactAfterMs` prop, `turnRunning` from its existing `turnRunning`, and binds `compact` to its existing `compactTurn`, so the working line, notices and turn slot behave as for `/compact`.

### `chat.compaction` config

```json
{ "chat": { "compaction": { "compactAtTokens": 200000, "idleCompactAfterMinutes": 55 } } }
```

`compactAtTokens` follows the shared rule, 0 or an integer of at least `MIN_COMPACT_AT_TOKENS` (10000), with the same message `compactAtTokens must be 0 (off) or at least 10000` (default `DEFAULT_CHAT_COMPACT_AT_TOKENS`); `MIN_COMPACT_AT_TOKENS` is exported from `@nathapp/nax-agent/internal` and the chat schema imports it there; `idleCompactAfterMinutes` is an integer from 0 to 1440 (default `DEFAULT_IDLE_COMPACT_AFTER_MINUTES`); 0 turns each off. With no `chat.compaction` block both defaults apply.

### Failure handling

| Case | Behaviour |
|:--|:--|
| `status.json`, `prd.json` or `decisions.jsonl` missing or unreadable | That source is empty; the panel renders from the rest |
| `logTail` throws | `logTail` is empty |
| A job ends between refreshes | One final refresh freezes the panel |
| Idle compaction fails | `compactTurn` already appends the error row; the compactor has recorded the job id and does not fire again for it |
| `compactAtTokens` 0 | Percent rule only (today's behaviour) |

## Out of Scope

- A pending-ask section in the job panel; run asks keep reaching the chat as today's notices and cards.
- Any change to the footer job strip or a footer idle-time readout; `chat-status.ts` stays as it is.
- Turn end times for a resumed session's replayed history.
- A reason on the automatic token-cap compaction's transcript row; only the idle compaction names its reason.
- Keep-warm pings to hold the prompt cache.
- Compaction for ACP chat agents, chat subagents, and `nax run` story sessions (they keep `execution.compaction`).
- Idle compaction when no job is running.
- Making `JOB_PANEL_LOG_LINES`, `JOB_PANEL_REFRESH_MS` or `IDLE_COMPACT_MIN_TOKENS` configurable.
- Adding the panel content to the agent's context.
- A turn-end row for a send that rejects before any `turn_end` event.
- A row cap for the `stories` section (a PRD's story count is already bounded by the planner).

## Stories

### US-001 — Job panel view model

Workdir: packages/nax

No dependencies.

Add `job-panel-view.ts` with `buildJobPanelView` and `readJobPanelView`, export `readJobStatus` from `job-outcome.ts`, export `decisionBody` from `src/advisor/index.ts`, and export the panel view API from `src/chat/jobs/index.ts` and `src/chat/index.ts`.

### US-002 — Job panel transcript entry and layout

Workdir: packages/nax

Depends on US-001.

Add the `job` transcript entry kind, `layout-job.ts` (`jobPanelLines`, `formatElapsed`), the `layout.ts` dispatch case, and the two progress glyphs.

### US-003 — Live job panels in the chat

Workdir: packages/nax

Depends on US-001, US-002.

Add `upsertJobPanel` and `useJobPanels`, add `job` to `cachedLines`' own-expansion list and to `CollapsibleEntry` with a first-row toggle branch in `toggleTranscriptLine`, and call the hook from `ChatApp.tsx` with its `turnRunning`.

### US-004 — Turn end time on the stats row

Workdir: packages/nax

No dependencies.

Add `turnEndClock`, the `endedAt`/`now` inputs of `turnStatsText`, and the always-returned row of `turnStatsEntry` (its `now` parameter defaults to `new Date()`). `ChatApp.tsx` appends the row for every turn end.

### US-005 — Absolute token cap for native compaction

Workdir: packages/nax-agent

No dependencies.

Add `compactAtTokens` to `ResolvedCompaction`, `compactionSettingsSchema` (with `MIN_COMPACT_AT_TOKENS`, exported from `@nathapp/nax-agent/internal`) and `NativeBackendOptions.compaction`, and apply the token-cap composition in `compactionThreshold` and `keepBudget`.

### US-006 — `chat.compaction` config and the chat session cap

Workdir: packages/nax

Depends on US-005.

Add `compaction` to `ChatConfigSchema` and `ChatConfig`, add `chat-compaction.ts` with `chatCompactAtTokens` and `idleCompactAfterMs` (exported from `src/chat/index.ts`), export `DEFAULT_CHAT_COMPACT_AT_TOKENS` and `DEFAULT_IDLE_COMPACT_AFTER_MINUTES` from `src/config/index.ts`, add `compactAtTokens?` to `ExecutionConfig.compaction`, and pass the cap into the native chat session in `open-chat-session.ts`.

### US-007 — Idle compact while a job runs

Workdir: packages/nax

Depends on US-006.

Add `createIdleCompactor` to `chat-compaction.ts` (exported from `src/chat/index.ts`), add `use-idle-compact.ts`, add the `idleCompactAfterMs` prop to `ChatAppProps` set by `cli/chat.ts` from config, and call the hook from `ChatApp.tsx` bound to `compactTurn`.

### Context Files

**US-001**
- `packages/nax/src/chat/jobs/job-outcome.ts` — `matchingStatus`, `readRunProgress`
- `packages/nax/src/chat/jobs/job-types.ts` — `ChatJob`
- `packages/nax/src/execution/status-file.ts` — `NaxStatusFile`
- `packages/nax/src/advisor/decision-log.ts` — `decisionBody`
- `packages/nax/src/advisor/ledger.ts` — `readDecisions`

**US-002**
- `packages/nax/src/tui/chat/transcript-model.ts` — `TranscriptEntry`
- `packages/nax/src/tui/chat/layout.ts` — entry dispatch and caching
- `packages/nax/src/tui/chat/layout-background.ts` — collapsible card pattern
- `packages/nax/src/tui/chat/layout-lines.ts` — `cardRows`, hints
- `packages/nax/src/tui/chat/theme.ts` — `ChatGlyphs`

**US-003**
- `packages/nax/src/tui/chat/use-jobs.ts` — job subscription pattern
- `packages/nax/src/tui/chat/ChatApp.tsx` — `entries` / `setEntries`
- `packages/nax/src/chat/jobs/job-panel-view.ts` — created by US-001, consumed here
- `packages/nax/src/tui/chat/layout-job.ts` — created by US-002, rendered here
- `packages/nax/src/tui/chat/transcript-click.ts` — `toggleTranscriptLine`

**US-004**
- `packages/nax/src/tui/chat/turn-stats.ts` — the row builder
- `packages/nax/test/unit/tui/chat/turn-stats.test.ts` — existing tests
- `packages/nax/src/tui/chat/ChatApp.tsx` — the `turnStatsEntry` call site

**US-005**
- `packages/nax-agent/src/native/session/compaction.ts` — `compactionThreshold`, `keepBudget`
- `packages/nax-agent/src/native/session/compaction-settings.ts` — schema
- `packages/nax-agent/src/session/native-backend-options.ts` — facade options
- `packages/nax-agent/src/session/native-backend.ts` — `resolveCompaction` call

**US-006**
- `packages/nax/src/config/schemas-chat.ts` — `ChatConfigSchema` (from `chat-workflow-flow`)
- `packages/nax/src/config/runtime-types-chat.ts` — `ChatConfig` (from `chat-workflow-flow`)
- `packages/nax/src/chat/open-chat-session.ts` — native session options
- `packages/nax/test/unit/chat/open-chat-session.test.ts` — existing option tests

**US-007**
- `packages/nax/src/tui/chat/ChatApp.tsx` — `compactTurn`, `busy`, status `contextTokens`
- `packages/nax/src/chat/acp/index.ts` — `isChatAcpModel`
- `packages/nax/src/chat/chat-compaction.ts` — created by US-006, extended here

### Creates

**US-001**
- `packages/nax/src/chat/jobs/job-panel-view.ts` — view model and source reader

**US-002**
- `packages/nax/src/tui/chat/layout-job.ts` — panel rows

**US-003**
- `packages/nax/src/tui/chat/job-panel-entries.ts` — `upsertJobPanel`
- `packages/nax/src/tui/chat/use-job-panels.ts` — live wiring hook

**US-006**
- `packages/nax/src/chat/chat-compaction.ts` — cap and delay resolvers

**US-007**
- `packages/nax/src/tui/chat/use-idle-compact.ts` — idle compact hook

### Modifies

**US-001**

None. `readJobStatus` is a new export over the existing private read; `readRunProgress` keeps its behaviour.

**US-002**

None. A new union member and two new glyph fields; no existing test builds a full `ChatGlyphs` literal or enumerates `TranscriptEntry` kinds.

**US-003**

None. The hook is additive.

**US-004**
- `packages/nax/test/ui/chat/turn-stats.test.tsx` — "AC-9 appends one muted turn-stats row after the reply" (`:228-240`), "leaves the rate out when no round measured a window" (`:242-250`) and "measures only its own events, not the turn before it" (`:290-300`) assert stats rows equal to the clockless text; "AC-10 leaves no stats row for a cancelled turn" (`:254-263`), "AC-11 leaves no stats row for an errored turn" (`:265-274`) and "AC-12 leaves no stats row for a completed turn with no output tokens" (`:276-286`) assert no row. Under US-004 every turn end leaves a row ending in its clock. Replace them with the new invariants: completed rows end ` · <clock>`, a cancelled turn's row is `cancelled · <clock>`, an errored turn's is `errored · <clock>`, a zero-output turn's is `0 out · <s>s · <clock>`; build event times and the clock from local date parts. "AC-13 replays its history without any stats row" is unchanged.
- `packages/nax/test/unit/tui/chat/turn-stats.test.ts` — "builds the row a completed turn with output earns" (`:177-182`) and "counts the elapsed time as none when the turn's own start does not parse" (`:195-200`) assert the exact text without a clock, "is undefined for a turn that did not complete, whatever it streamed" (`:184-189`) and "is undefined for a completed turn with no output tokens" (`:191-193`) assert no row. Under US-004 every turn earns a row ending in its end clock. Replace them with the new invariants: the completed row ends ` · <clock>`, a non-completed turn's row is `<status word> · <clock>`, and a zero-output completed turn's row is `0 out · <s>s · <clock>`; build `end.at` and `now` from local date parts.

**US-005**

None. `compactAtTokens` is optional with no default, so `DEFAULT_COMPACTION`, `resolveCompaction(undefined)` and every existing threshold and budget assertion are unchanged.

**US-006**

None. The existing compaction assertion in `open-chat-session.test.ts` (`:150-154`) uses `objectContaining`, so an added `compactAtTokens` does not break it.

**US-007**

None. The hook is additive.

### Seams

- US-003 consumes `readJobPanelView` (US-001) and `jobPanelLines` via the `job` entry (US-002). Its seam ACs enter at the `ChatJobs.onChange` listener the hook subscribes and observe `setEntries`.
- US-006 consumes `compactAtTokens` (US-005) through `nativeBackend({ compaction })`; its seam AC enters at `openChatSession` and observes the stubbed `nativeBackend`.
- US-007 consumes `chatCompactAtTokens`'s sibling `idleCompactAfterMs` (US-006) and `createIdleCompactor`; its seam AC enters at the compactor's `update` and observes `onDue`.

## Acceptance Criteria

### US-001

- [unit] `buildJobPanelView` for a running job started at 10:00:00 with `now` 10:42:00 returns `elapsedMs` 2520000.
- [unit] `buildJobPanelView` for an ended job uses `job.endedAt`, not `now`, for `elapsedMs`.
- [unit] `buildJobPanelView` with `status.cost.spent` 3.18 returns `cost` 3.18 even when `job.cost` differs.
- [unit] `buildJobPanelView` with `status` null returns `cost` equal to `job.cost`.
- [unit] `buildJobPanelView` with `status.progress` `{ passed: 4, total: 13 }` returns `progress` `{ passed: 4, total: 13 }`.
- [unit] `buildJobPanelView` for a running job with `status.current` `{ storyId: "US-005", phase: "review" }` returns `current` `{ storyId: "US-005", phase: "review" }`.
- [unit] `buildJobPanelView` for a job whose `state` is `succeeded` returns no `current`.
- [unit] `buildJobPanelView` for a running job returns `stories` in PRD order with `current` true only for the story whose id is the view's `current.storyId`.
- [unit] `buildJobPanelView` drops decisions whose `decidedAt` is before `job.startedAt`.
- [unit] `buildJobPanelView` returns each decision's `line` equal to `decisionBody(decision)`.
- [unit] `buildJobPanelView` orders a flagged (`needsHumanConfirm` true) decision before an unflagged one decided later.
- [unit] `buildJobPanelView` orders two unflagged decisions newest `decidedAt` first.
- [unit] `buildJobPanelView` with a log tail of 20 non-empty lines returns the last `JOB_PANEL_LOG_LINES` (12).
- [unit] `buildJobPanelView` drops empty lines from the log tail.
- [unit] `readJobPanelView` for a `run` job reads `readDecisions(job.cwd, job.target)` through `_jobPanelDeps`.
- [unit] `readJobPanelView` for a `plan` job returns empty `stories` and `decisions` and does not call `_jobPanelDeps.readDecisions`.
- [unit] `readJobPanelView` returns empty `decisions` when `_jobPanelDeps.readDecisions` rejects.
- [unit] `readJobPanelView` returns empty `stories` when `_jobPanelDeps.exists` reports no `prd.json`.
- [unit] `readJobPanelView` returns an empty `logTail` when `jobs.logTail` rejects.
- [unit] `readJobStatus` returns null for a job whose status file names a different pid.

### US-002

- [unit] `formatElapsed(42_000)` returns `42s`.
- [unit] `formatElapsed(2_520_000)` returns `42m`.
- [unit] `formatElapsed(3_900_000)` returns `1h 05m`.
- [unit] `jobPanelLines` for a collapsed running `run` view of `review-and-gate-guards` with `elapsedMs` 2520000 and `cost` 3.18 returns a first row whose text is `<pointer> nax run review-and-gate-guards  running  42m  $3.18 <show hint>` with the Unicode theme's pointer glyph and `SHOW_HINT`.
- [unit] `jobPanelLines` draws the state word `running` in the `accent` colour.
- [unit] `jobPanelLines` draws the state word `failed` in the `danger` colour.
- [unit] `jobPanelLines` for a `bot_review` view with target `2936` renders `nax bot review #2936` on the first row.
- [unit] `jobPanelLines` for progress `{ passed: 4, total: 13 }` renders a second row starting with 5 `progressFull` glyphs then 11 `progressEmpty` glyphs then ` 4/13`.
- [unit] `jobPanelLines` for progress `{ passed: 0, total: 0 }` renders 16 `progressEmpty` glyphs.
- [unit] `jobPanelLines` second row contains `· US-005 review` when `current` is `{ storyId: "US-005", phase: "review" }`.
- [unit] `jobPanelLines` second row contains `· 2 advisor decisions (1 flagged)` for two decisions with one flagged.
- [unit] `jobPanelLines` draws ` (1 flagged)` in the `warning` colour.
- [unit] `jobPanelLines` for a view with one decision and no `progress` renders a second row `1 advisor decision`.
- [unit] `jobPanelLines` for a collapsed view returns no `stories`, `advisor decisions` or `log` heading row.
- [unit] `jobPanelLines` for an expanded view returns the `stories`, `advisor decisions` and `log` headings in that order.
- [unit] `jobPanelLines` for an expanded view with no decisions omits the `advisor decisions` heading.
- [unit] `jobPanelLines` for an expanded view marks the current story's row with `◂ <phase>`.
- [unit] `jobPanelLines` for an expanded view starts a flagged decision row with the theme's `warning` glyph.
- [unit] `jobPanelLines` for an expanded view with 12 decisions renders 10 decision rows followed by `+2 more`.
- [unit] `jobPanelLines` with the colour-off theme returns rows with no colour styles.
- [unit] The resolved ASCII theme has `progressFull` `#` and `progressEmpty` `.`.
- [unit] The resolved Unicode theme has `progressFull` `█` and `progressEmpty` `░`.

### US-003

- [unit] `upsertJobPanel` with no `job` entry for `run-1` appends `{ kind: "job", view }`.
- [unit] `upsertJobPanel` with an existing `job` entry for `run-1` replaces it at the same index.
- [unit] `upsertJobPanel` keeps the replaced entry's `open` flag.
- [unit] `upsertJobPanel` leaves its input array unchanged.
- [unit] `toggleTranscriptLine` on the first row of a `job` entry flips its `open` flag.
- [unit] `toggleTranscriptLine` on the second row of a `job` entry returns the entries unchanged.
- [unit] `layoutTranscript` with `expanded` false for a `job` entry with `open: true` includes the `stories` heading row.
- [integration] When `host.jobs.onChange` fires for a newly running job `run-1` with `turnRunning` false, `useJobPanels` calls `setEntries` with an update that appends a `job` entry whose `view.jobId` is `run-1`.
- [integration] When `host.jobs.onChange` fires for a newly running job with `turnRunning` true, `useJobPanels` leaves the entries without a `job` entry for it while `turnRunning` stays true, across refresh ticks.
- [integration] When `turnRunning` changes from true to false, `useJobPanels` appends the panel of a job that became running during the turn.
- [integration] A job that starts and ends while `turnRunning` is true gets a panel showing its ended state once `turnRunning` becomes false.
- [unit] `hasJobPanel` returns true for an entries list holding a `job` entry for `run-1` and false for `run-2`.
- [integration] When the hook mounts with a job already `running` (re-attached), it adds a panel for that job.
- [integration] When the hook mounts with only an already-ended job, it adds no panel.
- [integration] With `host.jobs` absent, the hook never calls `setEntries`.
- [integration] While a paneled job is running, the hook refreshes it again after `JOB_PANEL_REFRESH_MS` with no `onChange` event.
- [integration] After a paneled job's state becomes `succeeded`, the hook refreshes it once and does not refresh it on the next `JOB_PANEL_REFRESH_MS` tick.
- [integration] When a refresh started while the job was running resolves after the job ended, the panel's last applied view has the ended state.
- [integration] After the entries are replaced with a list that has no panel, the next refresh of a still-running paneled job appends its panel again.
- [integration] On unmount, the hook removes its `onChange` listener.
- [integration] On unmount, the hook clears its refresh timer, so no refresh runs after it.
- [integration] `ChatApp` rendered with a fake host whose `jobs` holds a running `run` job for `review-and-gate-guards` shows a frame row containing `nax run review-and-gate-guards  running`.

### US-004

- [unit] `turnEndClock` for an `endedAt` of 14:32 local time on the same local day as `now` returns `14:32`.
- [unit] `turnEndClock` for an `endedAt` of 09:05 local time returns `09:05`.
- [unit] `turnEndClock` for an `endedAt` of 23:05 on 14 November local time with `now` on 15 November returns `Nov 14 23:05`.
- [unit] `turnEndClock` for an unparseable `endedAt` returns the empty string.
- [unit] `turnStatsText` without `endedAt` returns `48.2 tok/s · 1.3k out · 14s` for rate 48.2, 1300 output tokens and 14400 ms.
- [unit] `turnStatsText` with `endedAt` at 14:32 local time on `now`'s day returns `48.2 tok/s · 1.3k out · 14s · 14:32`.
- [unit] `turnStatsEntry` for a `completed` turn with 1300 output tokens ending 14:32 local time returns text `48.2 tok/s · 1.3k out · 14s · 14:32`.
- [unit] `turnStatsEntry` for a `completed` turn with 0 output tokens ending 14:32 returns text starting `0 out · ` and ending ` · 14:32`.
- [unit] `turnStatsEntry` for a `cancelled` turn ending 14:32 returns text `cancelled · 14:32`.
- [unit] `turnStatsEntry` for a `timed_out` turn ending 14:32 returns text `timed out · 14:32`.
- [unit] `turnStatsEntry` for an `interrupted` turn ending 14:32 returns text `interrupted · 14:32`.
- [unit] `turnStatsEntry` for an `errored` turn ending 14:32 returns text `errored · 14:32`.
- [unit] `turnStatsEntry` returns an entry whose `kind` is `turn-stats` for every turn-end status.
- [unit] `turnStatsEntry` for a `cancelled` turn whose `end.at` does not parse returns text `cancelled`.
- [integration] `ChatApp` with a fake host whose turn ends `cancelled` shows a frame row `cancelled · <clock>`.

### US-005

- [unit] `compactionThreshold(1_000_000, { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 })` returns 900000.
- [unit] `compactionThreshold(1_000_000, { enabled: true, compactAtPercent: 90, keepRecentPercent: 30, compactAtTokens: 200_000 })` returns 200000.
- [unit] `compactionThreshold(128_000, { enabled: true, compactAtPercent: 90, keepRecentPercent: 30, compactAtTokens: 200_000 })` returns the percent threshold 115200.
- [unit] `compactionThreshold` with `compactAtTokens` 0 returns the percent threshold.
- [unit] `keepBudget(1_000_000, { enabled: true, compactAtPercent: 90, keepRecentPercent: 30, compactAtTokens: 200_000 })` returns 66666.
- [unit] `keepBudget(128_000, { enabled: true, compactAtPercent: 90, keepRecentPercent: 30, compactAtTokens: 200_000 })` returns 38400.
- [unit] `keepBudget(1_000_000, { ..., compactAtTokens: 200_000 }, true)` returns 33333.
- [unit] `shouldCompact(250_000, 1_000_000, { enabled: true, compactAtPercent: 90, keepRecentPercent: 30, compactAtTokens: 200_000 })` returns true.
- [unit] `shouldCompact(250_000, 1_000_000, { enabled: false, compactAtPercent: 90, keepRecentPercent: 30, compactAtTokens: 200_000 })` returns false.
- [unit] `resolveCompaction({ compactAtTokens: 200_000 })` returns `compactAtTokens` 200000 with the default percentages.
- [unit] `resolveCompaction(undefined)` returns an object with no `compactAtTokens`.
- [unit] `compactionSettingsSchema.safeParse({ compactAtTokens: -1 })` fails.
- [unit] `compactionSettingsSchema.safeParse({ compactAtTokens: 5000 })` fails with the message `compactAtTokens must be 0 (off) or at least 10000`.
- [unit] `compactionSettingsSchema.safeParse({ compactAtTokens: 0 })` succeeds.
- [integration] A native session created through `nativeBackend({ compaction: { compactAtTokens: 200_000 } })` on a 1M-token-window model compacts its history before a send once the estimated context exceeds 200000 tokens.

### US-006

- [unit] `NaxConfigSchema.parse({ chat: { compaction: {} } })` resolves `chat.compaction.compactAtTokens` to 200000.
- [unit] `NaxConfigSchema.parse({ chat: { compaction: {} } })` resolves `chat.compaction.idleCompactAfterMinutes` to 55.
- [unit] `NaxConfigSchema.safeParse` fails at path `chat.compaction.idleCompactAfterMinutes` for 1441.
- [unit] `NaxConfigSchema.safeParse` fails at path `chat.compaction.compactAtTokens` for -5.
- [unit] `NaxConfigSchema.safeParse` fails at path `chat.compaction.compactAtTokens` for 5000 with the message `compactAtTokens must be 0 (off) or at least 10000`.
- [unit] `NaxConfigSchema.parse({ execution: { compaction: { compactAtTokens: 150_000 } } })` keeps `execution.compaction.compactAtTokens` 150000.
- [unit] `chatCompactAtTokens` returns 200000 for a config with no `chat` block.
- [unit] `chatCompactAtTokens` returns 100000 for `chat.compaction.compactAtTokens` 100000.
- [unit] `chatCompactAtTokens` returns 0 for `chat.compaction.compactAtTokens` 0.
- [unit] `idleCompactAfterMs` returns 3300000 for a config with no `chat` block.
- [unit] `idleCompactAfterMs` returns 0 for `chat.compaction.idleCompactAfterMinutes` 0.
- [integration] `openChatSession` with a config whose `execution.compaction` is the default and whose `chat.compaction.compactAtTokens` is 100000 calls the stubbed `nativeBackend` with `compaction` `{ enabled: true, compactAtPercent: 90, keepRecentPercent: 30, compactAtTokens: 100000 }`.
- [integration] `openChatSession` with no `chat` block calls the stubbed `nativeBackend` with `compaction.compactAtTokens` 200000.
- [integration] `runSubagent` with a config whose `chat.compaction.compactAtTokens` is 100000 calls `_subagentSessionDeps.nativeBackend` with a `compaction` that has no `compactAtTokens`.

### US-007

- [unit] A compactor with `delayMs` 3300000 and state `{ idle: true, runningJobId: "run-1", contextTokens: 50_000, acp: false }` calls `onDue("55m idle while job run-1 runs")` after fake time advances 3300000 ms.
- [unit] A compactor receiving the same qualifying state again at 3000000 ms still fires at 3300000 ms (a requalifying update does not restart the timer).
- [unit] A compactor that fired for `run-1` never calls `onDue` again for `run-1`, across later idle periods.
- [unit] A compactor that fired for `run-1` calls `onDue` for `run-2` after a qualifying idle period with `runningJobId` `run-2`.
- [unit] A compactor armed for `run-1` that receives a qualifying state for `run-2` at 1000000 ms calls `onDue` for `run-2` at 4300000 ms and never for `run-1`.
- [unit] A compactor with state `{ idle: true, contextTokens: 50_000, acp: false }` and no `runningJobId` never calls `onDue`.
- [unit] A compactor with `acp` true never calls `onDue`.
- [unit] A compactor with `contextTokens` 19999 never calls `onDue`.
- [unit] A compactor with `contextTokens` undefined never calls `onDue`.
- [unit] A compactor with `delayMs` 0 never calls `onDue`.
- [unit] A compactor whose state changes to `idle` false before `delayMs` elapses never calls `onDue` for that period.
- [unit] `dispose()` on an armed compactor prevents `onDue` when fake time passes `delayMs`.
- [integration] `useIdleCompact` with a host on a native model, `turnRunning` false, a running job and `contextTokens` 50000 calls `note` with `idle compact: 55m idle while job <id> runs` and then calls `compact` once after `delayMs` 3300000.
- [integration] `useIdleCompact` with a host whose `current().model` is `acp:codex` does not call `compact` after `delayMs`.
- [integration] `ChatApp` rendered with `idleCompactAfterMs` 3300000, a fake host on a native model with a running job, and a finished turn whose context is 50000 tokens, shows an `idle compact:` notice and calls `host.compact` once after fake time advances 3300000 ms.
- [integration] The chat command with a loaded config whose `chat.compaction.idleCompactAfterMinutes` is 30 calls the injected `deps.renderChat` with props whose `idleCompactAfterMs` is 1800000.
