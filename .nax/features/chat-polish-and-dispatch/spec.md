# SPEC: nax chat polish and dispatch fixes

Closes: #2796, #2797

## Summary

Eight `nax chat` fixes reported together. `/compact` on a native brain keeps only the
last turn verbatim, so it compacts any chat longer than one turn. The terminal title's
busy marker animates while a turn runs. A reply that ends with a raw `<tool_call>` block
the server could not read as a call gets one automatic follow-up naming the declared
tools. `nax-agents__run` takes an optional `model` that overrides the agent's own, and
its description says what `provider/model` and `acp:<agent>` mean. The Agent card names
the model the subagent runs on. The footer shows the context in use against the model's
window, and the window lookup no longer fails for a model id that carries an effort
suffix. While the model streams a tool call's arguments the working line says
`Writing…` instead of `Thinking…`. The workflow and jobs tools take an optional `repo`,
a nax project inside the chat's folder, so a chat opened in a parent folder can drive
the flow of a nested repo without restarting.

## Motivation

From a 2026-11-05 tmux verification of `nax chat` (main `1deed76b5`) and the same day's
feedback batch:

- `/compact` printed `nothing to compact` after five turns on
  `opencode-go/deepseek-v4.1-flash[high]`. `compactHistory` calls
  `prepareCompaction(messages, keepBudget(contextWindow, compaction))`, and `keepBudget`
  keeps `keepRecentPercent` (default 30) of the window verbatim: about 300k tokens on a
  1M window (#2796).
- The title's busy marker is static (`✳ nax · repo` for the whole turn), so a
  background tab gives no sign the chat is still working (#2797).
- A local model wrote `ScrashpadWrite` (a misspelt `ScratchpadWrite`) inside a
  `<tool_call>` block. The Strata server returned the block as plain answer text, and
  the turn ended there with nothing run.
- Asked to "dispatch native openai-codex/gpt-6-luna", the chat agent went looking for
  the Codex ACP agent: `nax-agents__run` has no model parameter and its description
  never says that `openai-codex` is a native provider.
- A dispatched subagent's model is visible nowhere in the transcript.
- The footer's `N% ctx` span never appeared. `createContextWindowCache` splits the
  session model at the first `/` and passes the rest, effort suffix included, to
  `lookupContextWindow`: `("opencode-go", "deepseek-v4.1-flash[high]")` returns
  `undefined` while `("opencode-go", "deepseek-v4.1-flash")` returns `1000000`. The span
  also shows only a percentage, not the tokens in use.
- While the model streams a large `Write` call's arguments the working line stays on
  `Thinking…`: nax-ai yields `tool-call-partial` events, and `deltaOf` in
  `packages/nax-agent/src/native/stream-complete.ts` drops them.
- `nax chat` opened in a workspace folder (`projects/nax`) whose nax repo is nested
  (`repos/nax`) cannot plan, run or review there: every workflow and jobs tool is bound
  to the chat's own `repoRoot`, and restarting the chat in the nested repo loses the
  conversation.

## Design

### Integration

Symbols the feature only reads:

- `packages/nax-agent/src/native/session/compaction.ts` —
  `prepareCompaction(messages, keepTokens, options)`, `keepBudget(window, cfg)`,
  `estimateTokens(message)`, `COMPACTION_SUMMARY_PREFIX`, `TranscriptMessage` (roles
  `user`, `assistant`, `tool-result`; a `user` message's `content` is a string).
- `packages/nax-agent/src/native/session/turn-loop-round-trip.ts` —
  `MAX_FOLLOW_UPS_PER_TURN` (3) and the `before_turn_end` dispatch.
- `packages/nax-agent/src/native/session/loop-events/types.ts` —
  `BeforeTurnEndPayload { messages, roundTrips, ended, stopped, followUpsSoFar }`,
  `BeforeTurnEndPatch { followUp? }`.
- `packages/nax-ai/src/protocols/pi-client.ts` — yields
  `{ type: "tool-call-partial", id, name, rawInput }`, where `rawInput` is the call's
  accumulated argument text so far.
- `packages/nax/src/chat/subagent-model.ts` —
  `resolveSubagentModel({ requested?, parentModel, aliases, tiers })` returning
  `{ model, source }`, `source` one of `inherit | alias | tier | model | fallback`.
- `parseModelSpec` from `@nathapp/nax-agent` — `parseModelSpec(id).model` is the
  `provider/model` base without the effort suffix.
- `packages/nax/src/tui/chat/chat-status.ts` — `isSubagentEvent`.
- `packages/nax/src/chat/workflow/feature-state.ts` — `FeatureStateOptions`
  (`repoRoot` among them), `readFeatureState`, `readWorkflowStateList`.
- `packages/nax/src/chat/jobs/job-types.ts` — `ChatJob.cwd`, "the repo root the job
  runs in".

Symbols the feature changes. The baseline exists only to locate the code; the target is
the interface to implement.

- `packages/nax-agent/src/native/session/manual-compaction.ts` — `compactHistory`.
  - Baseline: plans with `keepBudget(resolution.contextWindow, resolution.compaction)`.
  - Target: plans with `Math.min(keepBudget(...), manualKeepTokens(messages, MANUAL_KEEP_TURNS))`.
    New exports `MANUAL_KEEP_TURNS = 1` and
    `manualKeepTokens(messages: readonly TranscriptMessage[], keepTurns: number): number`.
- `packages/nax-agent/src/native/session/loop-handlers.ts` — `BuiltinLoopHandlerDeps`.
  - Target: gains `readonly toolNames: () => readonly string[]` and
    `readonly unreadToolCall: { sent: boolean }`; `registerBuiltinLoopHandlers`
    registers a built-in `before_turn_end` handler before the plugin entries.
- `packages/nax-agent/src/native/session/turn-event-emitter.ts` — `StreamDelta`.
  - Baseline: `{ type: "text_delta" | "thinking_delta"; text: string }`.
  - Target: that member, or
    `{ type: "tool_input_delta"; callId: string; name: string; chars: number }`.
- `packages/nax-agent/src/session/turn-event.ts` — `TurnEvent` and
  `packages/nax-agent/src/session/agent-session-types.ts` — `SessionEventBody`.
  - Target: both unions gain
    `{ readonly type: "tool_input_delta"; readonly round: number; readonly callId: string; readonly name: string; readonly chars: number }`.
- `packages/nax-agent/src/session/session-event-channel.ts` — `DeltaEvent`, `canMergeInto`.
  - Target: `DeltaEvent` includes `tool_input_delta`; two `tool_input_delta` events
    merge when `round` and `callId` match, into one carrying the summed `chars`.
- `packages/nax-agent-acp/src/server/translate/events.ts` — `translate`.
  - Target: `case "tool_input_delta"` returns `[]`.
- `packages/nax/src/chat/context-window-cache.ts` — `catalogModel`.
  - Target: splits `parseModelSpec(model).model`, so the effort suffix never reaches
    the lookup; the cache stays keyed by the full model string.
- `packages/nax/src/tui/chat/chat-status.ts` — `contextSpan`, `reduceTurnStatus`.
  - Baseline: `contextSpan` renders `${percent}% ctx` and only with a known window.
  - Target: `contextSpan`, `contextPercent`, `percentColor`, and `formatTokens` with its
    constants (`TOKEN_UNIT`, `TOKEN_DECIMALS`, `TOKEN_SUFFIX`), move to a new module
    `packages/nax/src/tui/chat/context-span.ts` (`chat-status.ts` is at 591 of its
    600-line cap), which also exports `formatWindow(n: number): string` and defines its
    own ` · ` separator constant. `context-span.ts` takes only type imports from
    `chat-status.ts` (`TurnStatus`, `ChatHostState`), so no value-import cycle forms
    (`packages/nax/scripts/baselines/import-cycles-baseline.json` is at 0).
    `chat-status.ts` value-imports `contextSpan` and `formatTokens` from it and
    re-exports `formatTokens` and `formatWindow`, so existing importers are unchanged. The span renders
    `<tokens>/<window> ctx (<percent>%)`, or `<tokens> ctx` with no window.
    `reduceTurnStatus` handles `tool_input_delta`.
- `packages/nax/src/tui/chat/turn-stats.ts` — `decodeRate`.
  - Target: a `tool_input_delta` opens its round's window as a `text_delta` does.
- `packages/nax/src/tui/chat/terminal-title.ts` — new exports `TITLE_FRAME_MS = 400`,
  `titleFrames(glyphs: ChatGlyphs): readonly string[]` and
  `chatTitleFrame(project: string, frame: string): string`. `chatTitle` is unchanged.
- `packages/nax/src/tui/chat/index.ts` — `renderChat`, `_renderChatDeps`.
  - Target: `_renderChatDeps` gains `setTimeout` and `clearTimeout`; the busy
    callback runs the title animation described below.
- `packages/nax/src/chat/agents-provider.ts` — `AgentsProviderOptions.run`.
  - Baseline: `(agent, task, signal) => Promise<ToolResult>`.
  - Target: `(agent, task, signal, model?: string) => Promise<ToolResult>`; the tool's
    `inputSchema.properties` gains `model: { type: "string" }`.
- `packages/nax/src/chat/subagent-runs.ts` — `SubagentRuns`.
  - Baseline: `run(agent, task, signal?)`.
  - Target: `run(agent, task, signal?, model?)` and new
    `modelFor(agentName: string, override?: string): string | undefined`.
- `packages/nax/src/chat/agent-call-model.ts` (new) —
  `withAgentCallModel(onEvent: (event: SessionEvent) => void, modelFor: SubagentRuns["modelFor"]): (event: SessionEvent) => void`.
- `packages/nax/src/prompts/builders/agents-builder.ts` — `buildAgentsInstructions`.
  - Target: a model line follows the first line, before the agent list.
- `packages/nax/src/tui/chat/transcript-model.ts` — the `tool` `TranscriptEntry`.
  - Target: gains optional `model?: string`, copied from the `tool_call` event's
    `metadata.subagentModel` on a top-level call; the key is absent when the metadata
    carries no model, so existing entries keep their exact shape.
- `packages/nax/src/tui/chat/tool-card.ts` — `agentArg`.
  - Target: `<agent> [<model>]: <task>` when the entry carries a model.
- `packages/nax/src/chat/workflow/workflow-provider.ts` — the `state` tool.
  - Target: `inputSchema.properties` gains `repo: { type: "string" }`.
- `packages/nax/src/chat/jobs/jobs-provider.ts` — launch tool schemas;
  `packages/nax/src/chat/jobs/jobs-launch.ts` — `launchJob`;
  `packages/nax/src/chat/jobs/job-runner.ts` — `StartJobRequest`, `spawn`,
  `loadRecords`, `finalizeAttached`; `packages/nax/src/chat/jobs/job-write-guard.ts` —
  the running-job filter; `packages/nax/src/chat/jobs/chain-argv.ts` —
  `CHAIN_STEP_FIELDS`; `packages/nax/src/chat/jobs/chain-tools.ts` — `resolveSteps`.
  - Target: described under "Nested repos" below. `resolveJobOutcome(job, exit, repoRoot)`
    and `readRunProgress(job, repoRoot)` keep their signatures; the runner passes
    `job.cwd` as `repoRoot`.

### Manual compaction keeps the last turn (#2796)

A turn starts at a `user` message whose content does not start with
`COMPACTION_SUMMARY_PREFIX`. `manualKeepTokens(messages, keepTurns)` finds the start of
the `keepTurns`-th last turn and returns the sum of `estimateTokens` over that message
and every message after it. With fewer turn starts than `keepTurns` it returns the sum
over the whole array. `compactHistory` passes
`Math.min(keepBudget(window, compaction), manualKeepTokens(messages, MANUAL_KEEP_TURNS))`
to `prepareCompaction`, so a last turn larger than the automatic budget is still cut at
a valid point inside it, as the automatic path would. Everything else about the manual
path stays: no pin, `before_compaction` not dispatched, `compaction.enabled` ignored,
nothing written before the summary returns. Automatic compaction and `keepBudget` are
unchanged.

### Unread tool-call follow-up (item 9)

A built-in `before_turn_end` handler. It returns `{ followUp }` when all of these hold:
`ended` is `"completed"`, `stopped` is `false`, `unreadToolCall.sent` is `false`, and
the last message in `messages` is an `assistant` message whose text contains the literal
`<tool_call>`. Otherwise it returns `{}`. Before returning a follow-up it sets
`unreadToolCall.sent = true`, so a turn gets at most one. The follow-up text is:

```
Your reply contains a <tool_call> block that was not run: it did not read as a call of a declared tool. Call tools through the tool interface, using one of these exact names: <names>.
```

where `<names>` is `toolNames()` joined with `, `, or `(none)` when it is empty. A
follow-up the loop then drops at `MAX_FOLLOW_UPS_PER_TURN` still counts as sent. The handler reads `toolNames` and `unreadToolCall` through `state.current` at dispatch,
like the other built-ins, because `registerBuiltinLoopHandlers` repoints a reused
registry rather than installing a second handler. The turn loop creates
`{ sent: false }` once per turn, next to the spin flags, and passes
`toolNames: () => tools.map((tool) => tool.name)`, reading the same `tools` array the
round trips send. The handler is registered before the plugin entries, so a plugin's
own `followUp` (a later handler's patch overwrites an earlier one) wins. The follow-up
counts against `MAX_FOLLOW_UPS_PER_TURN` like any other.

### Tool-input streaming (item 14)

`deltaOf` maps a `tool-call-partial` event to
`{ type: "tool_input_delta", callId: id, name, chars }`, where `chars` is the growth of
`rawInput.length` since the previous partial with the same `id` in this stream (the
first partial's whole length). A partial whose length did not grow yields no delta. The
emitter stamps the round as it does for text deltas, so the event reaches the
`send()` iterator as a `SessionEvent` that the channel merges as described above. It
carries only the name and a character count, never the argument text. The ACP server
emits nothing for it. Adding the union member makes `translate` in
`packages/nax-agent-acp` (an exhaustive switch with no default) fail to typecheck until
US-004 adds its case: US-003's gates are scoped to `packages/nax-agent`, and US-004 is
the next story, depending only on US-003.

In the chat TUI, `reduceTurnStatus` puts the turn in the `writing` phase and adds
`chars` to `streamedChars`, so the working line reads `Writing…` and its `↓ ~N tokens`
estimate grows. `reduceTranscript` leaves the transcript unchanged. `decodeRate` treats
the event as a round's first output delta. Subagent events (`isSubagentEvent`) are
ignored by all three, as today.

### Context window (item 13)

The cache fix: `catalogModel("opencode-go/deepseek-v4.1-flash[high]")` yields
`{ provider: "opencode-go", name: "deepseek-v4.1-flash" }`.

The footer span, with `tokens = status.contextTokens` and `window = state.contextWindow`:

| tokens | window | text | colour |
|:--|:--|:--|:--|
| undefined | any | no span | — |
| known | undefined or `<= 0` | `${formatTokens(tokens)} ctx` | muted |
| known | `> 0` | `${formatTokens(tokens)}/${formatWindow(window)} ctx (${percent}%)` | by `percent`, as today |

`percent` is `Math.round(tokens / window * 100)`, as today. `formatWindow(n)`: from
999,500 up, `n / 1000000` rounded to at most two decimals with trailing zeros dropped,
then `M` (`999500` → `1M`, `1000000` → `1M`, `1050000` → `1.05M`); from 1,000 up, `Math.round(n / 1000)` then
`k` (`200000` → `200k`, `262144` → `262k`); below 1,000, the number itself.

### Animated title (#2797)

`titleFrames(glyphs)` returns `glyphs.spinner` when it has at least two frames, and
otherwise `[glyphs.busy]`. `chatTitleFrame(project, frame)` returns `${frame} ` followed
by the idle title (`nax · <project>` with control characters removed), i.e.
`✶ nax · repo`. In `renderChat`:

- `busy(true)` writes `chatTitle(project, true, glyphs)` at once, as today, then arms one
  `_renderChatDeps.setTimeout` of `TITLE_FRAME_MS`. Each tick writes
  `setTitleSequence(chatTitleFrame(project, frames[i % frames.length]))` for
  `i = 0, 1, 2, …` and re-arms the next timeout. A second `busy(true)` while a timeout is
  armed arms no second one.
- `busy(false)` clears the armed timeout with `_renderChatDeps.clearTimeout` and writes
  the idle title.
- `restore` clears the armed timeout before it writes `POP_TITLE`; a tick never writes or
  re-arms after `restore`, and a `busy(true)` after `restore` arms nothing.
- A re-armed `setTimeout`, not `setInterval`: `.nax/rules/forbidden-patterns-source.md`
  allows only a cancellable `setTimeout`, and the call site says so in a comment.
- Off a TTY nothing changes: no callback, no timer.

### Agent model override and card (items 10, 12)

The `nax-agents__run` tool description becomes:
`Run a named catalog agent on a self-contained task and return its final answer. Optional model overrides the agent's model: provider/model (for example openai-codex/gpt-6-luna) runs it on the nax native agent with that provider's model; acp:<agent> (for example acp:codex) runs it on an installed ACP agent. A provider name such as openai-codex is a native provider, not the Codex ACP agent.`

`buildAgentsInstructions` adds, as its second line:
`Pass model to run an agent on another model: provider/model for the nax native agent (openai-codex/gpt-6-luna is native), acp:<agent> for an installed ACP agent.`

The provider calls `options.run(agent, task, signal)` with three arguments when `model`
is absent, and `options.run(agent, task, signal, model)` when it is a non-empty string.
`SubagentRuns.run` resolves with `requested = model ?? agent.model`. An override that
resolves with `source: "fallback"` (not `inherit`, an alias, a tier name, a
`provider/model` or an `acp:` target) is refused before any session opens:
`[chat] unknown model <model>; pass provider/model (a nax native model such as openai-codex/gpt-6-luna), acp:<agent>, or a configured alias`.

`SubagentRuns.modelFor(agentName, override)` returns the model `run` would use, or
`undefined` for an unknown agent or a refused override. `ChatHost.send` hands
`runChatTurn` a listener that copies `modelFor(input.agent, input.model)` into
`metadata.subagentModel` of each top-level `tool_call` event named `nax-agents__run`
whose `input.agent` is a string, when `modelFor` returns a model, and passes every other
event through unchanged. The wrapper is `withAgentCallModel` in `packages/nax/src/chat/agent-call-model.ts`;
`chat-host.ts` only adds its import and swaps the listener it passes to `runChatTurn`,
at most three lines (it is at 596 of its 600-line cap).

### Nested repos (item 11)

`resolveTargetRepo(chatRoot: string, repo: unknown): Promise<{ readonly root: string } | { readonly error: string }>`,
in `packages/nax/src/chat/target-repo.ts`, applies these rules in order:

1. `repo` undefined → `{ root: chatRoot }`.
2. `repo` not a string, or blank → `[chat] repo must be a non-empty string`.
3. `path.resolve(chatRoot, repo)` does not exist → `[chat] repo <repo> does not exist`.
4. Its real path is neither the real path of `chatRoot` nor inside it →
   `[chat] repo <repo> is outside <chatRoot>`. "Inside" is `isWithinRoot(path, root)`,
   exported from the same module: both arguments are real paths, and `path` equals
   `root` or starts with `root` followed by the path separator, so `/w/chat-evil` is not
   inside `/w/chat`.
5. Its real path equals the real path of `chatRoot` → `{ root: chatRoot }`.
6. It has no `.nax` directory → `[chat] repo <repo> is not a nax project: no .nax directory`.
7. Otherwise `{ root: <its real path> }`.

Where `repo` is accepted, a returned error becomes the tool's error result and nothing
else happens (no approval card, no launch, no read).

`targetOutputDir(root: string): Promise<string>`, in the same module, returns the
project output directory of the nax project at `root`, computed the way `composeChat`
computes the chat's own: `projectOutputDir(getProjectKey(config, root), config.outputDir)`
with `config = await loadConfig(join(root, ".nax"))`, loaded through an injectable
`_targetRepoDeps.loadConfig`.

- `nax-workflow__state` gains `repo`. For a nested root, the feature read and the list
  read use it as `repoRoot` and `targetOutputDir(root)` as `outputDir`, so the workflow
  verdict and the last run log come from the nested project's own output tree. Without
  `repo` the options are unchanged.
- The `plan`, `run`, `bot_review` and `bot_fix` launch tools gain `repo`. `launchJob`
  resolves it first, then runs its whole existing flow with the resolved root in place
  of `options.repoRoot`: the feature-dir and spec checks, the busy check (a plan or run
  job busy only when its `cwd` is that root), the `nax.lock` read, the argv's `-d`, the
  approval card's `workdir` line, and the job start.
- `StartJobRequest` gains optional `readonly cwd?: string`, defaulting to the runner's
  `repoRoot`. The runner spawns the child in that directory and records it as `cwd`.
  Outcome and progress reads pass `job.cwd` as `repoRoot`. Attaching records on start,
  and `finalizeAttached`'s disk lookup, accept a record whose real `cwd` passes
  `isWithinRoot` against the real `repoRoot` (a record whose `cwd` no longer exists, so
  its real path cannot be read, is skipped); `finalizeAttached` matches the record by
  `id` and `cwd === job.cwd`.
- The chat write guard (`createJobWriteGuard`) blocks guarded writes while a plan or run
  job runs whose `cwd` is `repoRoot` or inside it, so a nested job still refuses `Write`,
  `Edit`, `Delete` and `GitCommit` in the chat.
- `CHAIN_STEP_FIELDS` gains `repo` for every kind. `resolveSteps` resolves each step's
  `repo` and builds that step's spec path and argv against the resolved root, so a
  later `launchJob` for the step builds the same argv and the chain admits it.
- `buildWorkflowInstructions` and `buildJobsInstructions` each add a line:
  `When the nax project is in a folder inside this chat's folder (for example repos/nax), pass repo with that folder's path; the chat stays where it is.`

### Failure Handling

| Situation | Behaviour |
|:--|:--|
| `/compact` on a single-turn history | `compacted: false`, no summarizer call, as today |
| summarizer rejects during `/compact` | rejection propagates, history unchanged, as today |
| reply contains `<tool_call>` after the turn already sent one follow-up | no second follow-up; the turn ends |
| reply contains `<tool_call>` on a stopped turn (spin, invalid-call budget, deadline) | no follow-up |
| `toolNames()` is empty | the follow-up names `(none)` |
| `tool-call-partial` whose `rawInput` did not grow | no delta |
| context window lookup throws | window unknown; span shows `<tokens> ctx` |
| `busy(true)` twice in a row | one timer |
| timer tick after `restore` | writes nothing |
| `nax-agents__run` `model` not a string, or blank | error `[chat] run model must be a non-empty string`, `run` not called |
| `nax-agents__run` `model` resolves as `fallback` | error `[chat] unknown model <model>; …`, no session opened |
| `repo` invalid (any rule 2-6 above) | that rule's error as the tool result, nothing launched or read |

## Out of Scope

- The manual compaction keep (`MANUAL_KEEP_TURNS`) is a constant, not a config field; `keepRecentPercent` and automatic compaction are unchanged.
- `/compact` takes no focus-instructions argument.
- Recovery from an undeclared tool name relies on the `<tool_call>` text in the reply; nax does not read Strata's `strata_rejected_tool_calls` response field or any other server-specific field.
- No fuzzy matching or rewriting of a misspelt tool name; the model is asked to call again.
- The unread tool-call follow-up applies to native brains only; ACP brains are not changed.
- The `Writing…` phase for tool-argument streaming applies to native brains only; ACP brains' tool-call updates are not changed.
- `tool_input_delta` events carry no argument text and are not recorded in transcripts, ledgers or ACP history.
- The title animation has no separate frame for a pending approval or question.
- `nax-agents__run` still requires a catalog agent; there is no agent-less generic subagent.
- The subagent model on the Agent card is not shown for replayed history or resumed sessions.
- A chat session cannot be moved to another directory (`/cd` or similar); nested repos are reached through the tools' `repo` argument.
- `repo` reaches only nax projects inside the chat's folder; a sibling or parent folder is refused.
- `nax-jobs__list`, `nax-jobs__cancel` and `nax-jobs__answer_ask` take no `repo`; they already list every job of the chat, and the list summary does not add the job's `cwd`.
- A chain's approval card keeps the chat's own `workdir` line; each step's nested root shows in its argv's `-d`.
- A reply that quotes the literal `<tool_call>` text on purpose also gets the one follow-up; nax does not try to tell a quoted block from an unread call.
- Chat jobs started for a nested repo are still recorded in the chat's own job store, not the nested project's.
- The context span is not shown before the first turn of a session, including a resumed one.

## Stories

**US-001: Manual compaction keeps the last turn.** No dependencies. Workdir: `packages/nax-agent`.
`manualKeepTokens`, `MANUAL_KEEP_TURNS`, and the keep `compactHistory` plans with (#2796).

**US-002: Unread tool-call follow-up.** No dependencies. Workdir: `packages/nax-agent`.
The built-in `before_turn_end` handler, its two new deps and the turn loop's wiring.

**US-003: Tool-input deltas in nax-agent.** No dependencies. Workdir: `packages/nax-agent`.
`deltaOf`'s `tool-call-partial` mapping, the `tool_input_delta` member of `StreamDelta`,
`TurnEvent` and `SessionEventBody`, and its merge in the session event channel.

**US-004: The ACP server ignores tool-input deltas.** Depends on US-003. Workdir: `packages/nax-agent-acp`.
The `tool_input_delta` case of `translate`.

**US-005: `Writing…` while tool arguments stream.** Depends on US-003. Workdir: `packages/nax`.
`reduceTurnStatus`, `reduceTranscript` and `decodeRate` on `tool_input_delta`.

**US-006: Context in use against the window.** No dependencies. Workdir: `packages/nax`.
The cache's effort-suffix fix, and the new `context-span.ts` module with `formatWindow`
and the footer span.

**US-007: Animated title busy marker.** No dependencies. Workdir: `packages/nax`.
`TITLE_FRAME_MS`, `titleFrames`, `chatTitleFrame` and the timer in `renderChat` (#2797).

**US-008: `nax-agents__run` model override.** No dependencies. Workdir: `packages/nax`.
The `model` property, its validation, `SubagentRuns.run`'s override, the description and
the instructions line.

**US-009: The Agent card names its model.** Depends on US-008. Workdir: `packages/nax`.
`SubagentRuns.modelFor`, the listener wrapper in `ChatHost.send`, the entry's `model` and
the card's argument.

**US-010: `repo` on the workflow state tool.** No dependencies. Workdir: `packages/nax`.
`resolveTargetRepo`, `isWithinRoot`, `targetOutputDir`, `nax-workflow__state`'s `repo`,
and the workflow instructions line.

**US-011: `repo` on the job launch tools.** Depends on US-010. Workdir: `packages/nax`.
The launch schemas, `launchJob`'s resolved root, `StartJobRequest.cwd`, the runner's use
of `job.cwd`, record attach, the write guard, and the jobs instructions line.

**US-012: `repo` on chain steps.** Depends on US-011. Workdir: `packages/nax`.
`CHAIN_STEP_FIELDS` and `resolveSteps`.

### Context Files

**US-001**
- `packages/nax-agent/src/native/session/manual-compaction.ts` — `compactHistory`, `applyManualCompaction`.
- `packages/nax-agent/src/native/session/compaction.ts` — `prepareCompaction`, `findCutPoint`, `keepBudget`, `estimateTokens`, `COMPACTION_SUMMARY_PREFIX`.
- `packages/nax-agent/test/integration/session/native-manual-compaction.test.ts` — the seeded-transcript harness to mirror.

**US-002**
- `packages/nax-agent/src/native/session/loop-handlers.ts` — `registerBuiltinLoopHandlers`, `BuiltinLoopHandlerDeps`.
- `packages/nax-agent/src/native/session/turn-loop.ts` — the `registerBuiltinLoopHandlers` call and the `tools` array.
- `packages/nax-agent/src/native/session/turn-loop-round-trip.ts` — the `before_turn_end` dispatch and `MAX_FOLLOW_UPS_PER_TURN`.
- `packages/nax-agent/src/native/session/loop-events/types.ts` — `BeforeTurnEndPayload`, `BeforeTurnEndPatch`.
- `packages/nax-agent/src/native/session/loop-events/registry.ts` — patch merge order.

**US-003**
- `packages/nax-agent/src/native/stream-complete.ts` — `deltaOf`, `tap`.
- `packages/nax-agent/src/native/session/turn-event-emitter.ts` — `StreamDelta`, `deltaSink`.
- `packages/nax-agent/src/session/turn-event.ts` — `TurnEvent`.
- `packages/nax-agent/src/session/agent-session-types.ts` — `SessionEventBody`.
- `packages/nax-agent/src/session/session-event-channel.ts` — `DeltaEvent`, `canMergeInto`, `enqueue`.

**US-004**
- `packages/nax-agent-acp/src/server/translate/events.ts` — `translate`.
- `packages/nax-agent-acp/test/unit/server/translate/events.test.ts` — the translate tests to mirror.

**US-005**
- `packages/nax/src/tui/chat/chat-status.ts` — `reduceTurnStatus`, `workingLine`, `isSubagentEvent`.
- `packages/nax/src/tui/chat/turn-stats.ts` — `decodeRate`.
- `packages/nax/src/tui/chat/transcript-model.ts` — `reduceTranscript`.

**US-006**
- `packages/nax/src/chat/context-window-cache.ts` — `catalogModel`, `createContextWindowCache`.
- `packages/nax/src/tui/chat/chat-status.ts` — `contextPercent`, `contextSpan`, `percentColor`, `formatTokens`.
- `packages/nax/test/unit/tui/chat/chat-status.test.ts` — the footer cases.

**US-007**
- `packages/nax/src/tui/chat/terminal-title.ts` — `chatTitle`, `setTitleSequence`.
- `packages/nax/src/tui/chat/index.ts` — `renderChat`, `showTitle`, `restore`, `_renderChatDeps`.
- `packages/nax/src/tui/chat/theme.ts` — `ChatGlyphs.spinner`, `ChatGlyphs.busy`.
- `packages/nax/test/ui/chat/index.test.tsx` — the AC-13 title tests.

**US-008**
- `packages/nax/src/chat/agents-provider.ts` — the `run` tool.
- `packages/nax/src/chat/subagent-runs.ts` — `run`, `runNested`.
- `packages/nax/src/chat/subagent-model.ts` — `resolveSubagentModel`.
- `packages/nax/src/prompts/builders/agents-builder.ts` — `buildAgentsInstructions`.
- `packages/nax/src/chat/chat-host.ts` — where `createAgentsProvider` receives `this.runs.run`.

**US-009**
- `packages/nax/src/chat/chat-host.ts` — `send`.
- `packages/nax/src/chat/subagent-runs.ts` — `runNested`'s model resolution; `modelFor` mirrors it.
- `packages/nax/src/tui/chat/transcript-model.ts` — `applyToolCall`.
- `packages/nax/src/tui/chat/tool-card.ts` — `agentArg`.

**US-010**
- `packages/nax/src/chat/workflow/workflow-provider.ts` — `readState`, the `state` tool.
- `packages/nax/src/chat/workflow/feature-state.ts` — `FeatureStateOptions`, `readFeatureState`, `readWorkflowStateList`.
- `packages/nax/src/prompts/builders/workflow-builder.ts` — `buildWorkflowInstructions`.

**US-011**
- `packages/nax/src/chat/jobs/jobs-launch.ts` — `launchJob`, `prepareTarget`, `busyJob`, `busyLock`, `launchReason`, `startApproved`.
- `packages/nax/src/chat/jobs/jobs-provider.ts` — launch schemas.
- `packages/nax/src/chat/jobs/job-runner.ts` — `StartJobRequest`, `spawn`, `loadRecords`, `finalizeAttached`.
- `packages/nax/src/chat/jobs/job-outcome.ts` — `resolveJobOutcome`, `readRunProgress`.
- `packages/nax/src/chat/target-repo.ts` — created by US-010, the resolver and `isWithinRoot` used here.

**US-012**
- `packages/nax/src/chat/jobs/chain-argv.ts` — `CHAIN_STEP_FIELDS`, `parseChainStepInput`, `buildChainStepArgv`.
- `packages/nax/src/chat/jobs/chain-tools.ts` — `parseStep`, `resolveSteps`.
- `packages/nax/src/chat/target-repo.ts` — created by US-010, the resolver used here.

### Creates

**US-006**
- `packages/nax/src/tui/chat/context-span.ts` — `formatTokens`, `formatWindow`, `contextSpan`, `contextPercent`, `percentColor`.

**US-007**
- `packages/nax/test/unit/tui/chat/terminal-title-frames.test.ts` — `titleFrames` and `chatTitleFrame`.

**US-009**
- `packages/nax/src/chat/agent-call-model.ts` — `withAgentCallModel`, the listener wrapper that adds `metadata.subagentModel`.

**US-010**
- `packages/nax/src/chat/target-repo.ts` — `resolveTargetRepo`, `isWithinRoot`, `targetOutputDir`.

### Modifies

**US-002**
- `packages/nax-agent/test/unit/native/session/loop-handlers-plugins.test.ts` — its `install` helper builds a literal `BuiltinLoopHandlerDeps`; it gains `toolNames: () => []` and `unreadToolCall: { sent: false }`, and assertions on the handlers registered for `before_turn_end` now also see one built-in entry ahead of the plugin entries.

**US-003**
- `packages/nax-agent/test/unit/native/stream-complete.test.ts` — the shared `script` holds a `tool-call-partial` (`id: "c1"`, `name: "Read"`, `rawInput: "{"`), so "taps only text and thinking deltas, in stream order" now also receives `{ type: "tool_input_delta", callId: "c1", name: "Read", chars: 1 }` at that position; the expected list gains it and the test is renamed to say it taps text, thinking and tool-input deltas.
- `packages/nax-agent/test/unit/session/session-event-channel.test.ts` — a test that asserts only `text_delta` and `thinking_delta` merge holds for those two; `tool_input_delta` events with the same `round` and `callId` now merge, summing `chars`.

**US-006**
- `packages/nax/test/unit/tui/chat/chat-status.test.ts` — `CONTEXT_CASES` expected texts change from the `18% ctx` form to the tokens/window form, for example 36.0k/200k ctx (18%), with the same colours; the `NO_CONTEXT_CASES` row "an unknown context window" now expects `m1 · 36.0k ctx · $0.42`, and the "a zero context window" row the same; "an unknown token count" still shows no span.
- `packages/nax/test/unit/chat/context-window-cache.test.ts` — the provider/model split cases keep their expectations; a model string with an effort suffix now primes the lookup without the suffix.
- `packages/nax/test/ui/chat/chat-app-layout.test.tsx` — the footer assertion expecting the bottom row to contain `18% ctx` now expects the tokens/window form computed from that test's own token count and window, ending in ctx (18%).
- `packages/nax/test/ui/chat/chat-compact.test.tsx` — `AFTER_PERCENT` (`12% ctx`) becomes the tokens/window form computed from that test's `tokensAfter` and window, ending in ctx (12%); the frame assertion that uses it is otherwise unchanged.

**US-007**
- `packages/nax/test/ui/chat/index.test.tsx` — the AC-13 busy-title tests stub `_renderChatDeps.setTimeout` and `_renderChatDeps.clearTimeout` so no real timer runs; their expected immediate write after `busy(true)` (`\u001b]0;✳ nax · repo\u0007`) is unchanged.

**US-009**
- `packages/nax/src/chat/chat-host.ts` — at 596 of its 600-line cap; the story adds at most three lines (the `withAgentCallModel` import and the swapped listener) and nothing else.

**US-010**
- `packages/nax/test/unit/chat/workflow/workflow-provider.test.ts` — the exact `inputSchema` assertion gains `repo: { type: "string" }` in `properties`.

**US-011**
- `packages/nax/test/unit/chat/jobs/jobs-launch.test.ts` — the exact launch `inputSchema` assertions gain `repo: { type: "string" }` in `properties` for `plan`, `run`, `bot_review` and `bot_fix`; `jobs.start` expectations gain `cwd` equal to the chat's `repoRoot` when no `repo` is passed.
- `packages/nax/test/unit/chat/jobs/job-runner-attach.test.ts` — the attach filter now also accepts a record whose real `cwd` lies inside the real `repoRoot`, so the "AC-6 ignores other repositories" fixture moves its cwd from the repoRoot/other subdirectory to a sibling directory of `repoRoot`; a record for an unrelated or sibling-prefix directory is still skipped.
- `packages/nax/test/unit/prompts/builders/workflow-builder-chain.test.ts` — `buildJobsInstructions()` gains the `repo` line immediately before the chain lines: the plain output's length becomes 9 instead of 8, the `answerAsks: true` output's 10 instead of 9 with the answer-ask line still last, and every `slice` and index that locates the chain lines or the answer-ask line moves by one.

**US-012**
- `packages/nax/test/unit/chat/jobs/chain-argv.test.ts` — "defines exactly the launch schema fields" pins `CHAIN_STEP_FIELDS` with an exact equality; every kind's list gains `repo`.

### Seams

- US-003 → US-004: `tool_input_delta` is a `SessionEventBody` member the ACP server's `translate` must handle.
- US-003 → US-005: `tool_input_delta` reaches the chat TUI through `ChatHost.send`'s listener.
- US-008 → US-009: `SubagentRuns.modelFor` resolves overrides exactly as `run` does.
- US-010 → US-011, US-012: `resolveTargetRepo` is called by `launchJob` and by `resolveSteps`.

## Acceptance Criteria

### US-001

1. [unit] `MANUAL_KEEP_TURNS` imported from `manual-compaction.ts` equals `1`.
2. [unit] `manualKeepTokens([u1, a1, u2, a2], 1)`, with `u*` user and `a*` assistant messages, equals `estimateTokens(u2) + estimateTokens(a2)`.
3. [unit] `manualKeepTokens([u1, a1, u2, a2], 2)` equals the sum of `estimateTokens` over all four messages.
4. [unit] `manualKeepTokens([u1, a1], 2)` equals the sum of `estimateTokens` over both messages.
5. [unit] `manualKeepTokens` does not count a user message whose content starts with `COMPACTION_SUMMARY_PREFIX` as a turn start: for `[summary, a0, u1, a1]` and `keepTurns` 1 it equals `estimateTokens(u1) + estimateTokens(a1)`.
6. [unit] `manualKeepTokens` counts tokens of `tool-result` messages after the last turn start: for `[u1, a1, u2, a2-with-call, tool-result, a3]` and `keepTurns` 1 it equals the sum over `u2`, `a2-with-call`, `tool-result` and `a3`.
7. [integration] On a native session with a 4,095-token window whose stored history holds three short turns (far below the window's 30% keep budget), `session.compact()` resolves `{ compacted: true }` with `tokensAfter` less than `tokensBefore`.
8. [integration] After that compaction, the next `send()` request's messages begin with the summary message and then contain the third turn's user message verbatim, and neither the first nor the second turn's user message.
9. [integration] On a native session whose stored history holds one turn (`[user, assistant]`), `session.compact()` resolves `{ compacted: false, costUsd: 0 }` and the summarizer stub records no call.
10. [integration] On a native session whose history holds an automatic summary at index 1 and no user message after it (`[user, summary, assistant]`), `session.compact()` resolves `{ compacted: false }` and the summarizer stub records no call.
11. [integration] On a native session whose last turn alone is larger than the window's keep budget, `session.compact()` resolves `{ compacted: true }` and the kept messages start at a user or assistant message inside that last turn.
12. [integration] A proactive automatic compaction on a session over the same three-turn history does not fire below `compactAtPercent`: a `send()` on it makes no summarizer call.

### US-002

1. [integration] With a scripted model whose first reply is the text `<tool_call>{"name":"ScrashpadWrite"}</tool_call>` and whose second reply is `done`, the turn sends a second request whose last message is a user message starting `Your reply contains a <tool_call> block that was not run`.
2. [integration] That follow-up message lists every tool name the turn's first request declared, joined with `, `.
3. [integration] With a scripted model that replies with a `<tool_call>` text block on every round, the turn sends exactly two requests and ends `completed`.
4. [integration] With a scripted model whose only reply is plain text without `<tool_call>`, the turn sends exactly one request.
5. [integration] A turn whose round 1 reply is a real tool call and whose round 2 reply is `<tool_call>` text sends exactly one follow-up request after round 2.
6. [integration] When a plugin `before_turn_end` handler returns `{ followUp: "plugin text" }` on a reply containing `<tool_call>`, the continuation request's last user message is `plugin text`.
7. [integration] A turn stopped by the invalid-call budget whose last assistant text contains `<tool_call>` sends no follow-up request.
8. [integration] A turn cancelled while its reply contains `<tool_call>` sends no follow-up request.
9. [integration] Two consecutive `send()` calls on one session, each whose first reply contains `<tool_call>`, each send one follow-up: the once-per-turn flag does not carry over.
10. [unit] The built-in `before_turn_end` handler returns `{}` and leaves `unreadToolCall.sent` `false` when the payload's last message is a `user` message.
11. [unit] With `toolNames` returning `[]`, the handler's follow-up ends `using one of these exact names: (none).`
12. [integration] Two `send()` calls on one session that reuse one caller-supplied loop-event registry each send one follow-up for a reply containing `<tool_call>`: the repointed registry reads the second turn's fresh `unreadToolCall`.

### US-003

1. [unit] `streamComplete` with a delta sink, over a stream yielding `tool-call-partial` events for id `c1` with `rawInput` lengths 5 then 12, calls the sink with `{ type: "tool_input_delta", callId: "c1", name, chars: 5 }` then `chars: 7`.
2. [unit] A `tool-call-partial` whose `rawInput` length equals the previous partial's for the same id produces no sink call.
3. [unit] Partials for two ids `c1` and `c2` interleaved are measured per id: `c2`'s first partial of length 4 yields `chars: 4` after `c1` reached 12.
4. [unit] A `tool_input_delta` sink call carries no `text` or `rawInput` field.
5. [integration] A native session `send()` whose scripted model streams one tool call's arguments in three partials yields `tool_input_delta` session events with that call's `callId`, `name` and the round of the request, before the `tool_call` event.
6. [integration] The `chars` of all `tool_input_delta` events for one call, summed, equal the length of that call's last `tool-call-partial` `rawInput`.
7. [unit] The session event channel, with the consumer lagging, merges two adjacent `tool_input_delta` events with the same `round` and `callId` into one whose `chars` is their sum.
8. [unit] The channel keeps two adjacent `tool_input_delta` events with different `callId` as two events.
9. [unit] The channel keeps a `tool_input_delta` followed by a `text_delta` as two events in order.
10. [unit] Pushing 10,000 `tool_input_delta` events for one call while the consumer lags does not fire `onStall`.

### US-004

1. [unit] `translate` on a `tool_input_delta` session event resolves `[]`.
2. [unit] `translate` on a `text_delta` after a `tool_input_delta` still resolves one `agent_message_chunk` update with the delta's text.

### US-005

1. [unit] `reduceTurnStatus` on a running `thinking` status and a `tool_input_delta` with `chars: 40` returns phase `writing` and `streamedChars` increased by 40.
2. [unit] `workingLine` for that status contains the verb `Writing…`.
3. [unit] `reduceTurnStatus` on a `tool_input_delta` whose `metadata.subagentTask` is set returns the status unchanged.
4. [unit] `reduceTurnStatus` on a `tool_call` after a `tool_input_delta` returns phase `tool` with the call's name, as today.
5. [unit] `reduceTranscript` on a `tool_input_delta` returns the same entries array.
6. [unit] `decodeRate` over round 1 events `turn_start` at 0 s, `tool_input_delta` at 1 s, `usage` with 100 `outputTokens` at 3 s returns `50`.
7. [unit] `decodeRate` over a round whose first delta is a `tool_input_delta` at 1.5 s and whose later `text_delta` is at 2 s, with `usage` of 100 `outputTokens` at 3.5 s, returns `50`: the window opens at the first delta.
8. [integration] In the chat screen, a `tool_input_delta` event emitted during a turn makes the working line read `Writing…`.

### US-006

1. [unit] Priming `createContextWindowCache` with `opencode-go/deepseek-v4.1-flash[high]` calls the lookup with `("opencode-go", "deepseek-v4.1-flash")`.
2. [unit] After that prime, `get("opencode-go/deepseek-v4.1-flash[high]")` returns the lookup's value.
3. [unit] Priming with `openai/gpt-x` still calls the lookup with `("openai", "gpt-x")`.
4. [unit] `formatWindow(1000000)` returns `1M`.
5. [unit] `formatWindow(1050000)` returns `1.05M`.
6. [unit] `formatWindow(200000)` returns `200k`.
7. [unit] `formatWindow(262144)` returns `262k`.
8. [unit] `formatWindow(800)` returns `800`.
9. [unit] `formatWindow(999600)` returns `1M`.
10. [unit] The footer's right side for `contextTokens` 36,000 and `contextWindow` 200,000 reads `m1 · 36.0k/200k ctx (18%) · $0.42`, with the span muted.
11. [unit] The footer span for `contextTokens` 150,000 of 200,000 reads `150.0k/200k ctx (75%)` and is coloured `warning`.
12. [unit] The footer span for `contextTokens` 190,000 of 200,000 reads `190.0k/200k ctx (95%)` and is coloured `danger`.
13. [unit] The footer for `contextTokens` 36,000 with no `contextWindow` reads `m1 · 36.0k ctx · $0.42`, with the span muted.
14. [unit] The footer for `contextTokens` 36,000 with `contextWindow` 0 reads `m1 · 36.0k ctx · $0.42`.
15. [unit] The footer with no `contextTokens` reads `m1 · $0.42`.
16. [integration] A chat host started on `opencode-go/deepseek-v4.1-flash[high]` with a catalog stub answering 1,000,000 for `("opencode-go", "deepseek-v4.1-flash")` reports `contextWindow` 1,000,000 in its state.
17. [unit] `formatTokens` and `formatWindow` imported from `chat-status.ts` are the same functions `context-span.ts` exports: `formatTokens(1234)` returns `1.2k` through either import.

### US-007

1. [unit] `TITLE_FRAME_MS` equals `400`.
2. [unit] `titleFrames` of the unicode glyph set returns its `spinner` frames.
3. [unit] `titleFrames` of a glyph set whose `spinner` has one frame returns `[glyphs.busy]`.
4. [unit] `titleFrames` of a glyph set whose `spinner` is empty returns `[glyphs.busy]`.
5. [unit] `chatTitleFrame("repo", "✶")` returns `✶ nax · repo`.
6. [unit] `chatTitleFrame` with a project name holding a BEL character returns the title without it.
7. [integration] On a TTY, after `busy(true)`, the last write is `setTitleSequence("✳ nax · repo")` and one 400 ms timeout is armed through `_renderChatDeps.setTimeout`.
8. [integration] Firing the armed timeout three times, each time firing the timeout it re-armed, writes `setTitleSequence(chatTitleFrame("repo", frames[0]))`, then `frames[1]`, then `frames[2]`, with `frames = titleFrames(glyphs)`, and arms a new 400 ms timeout after each write.
9. [integration] A second `busy(true)` while a timeout is armed arms no second timeout.
10. [integration] `busy(false)` clears the armed timeout through `_renderChatDeps.clearTimeout` and writes `setTitleSequence("nax · repo")`.
11. [integration] Firing the callback of a timeout cleared by `busy(false)` writes nothing and arms nothing.
12. [integration] Unmounting while busy clears the armed timeout before `POP_TITLE` is written, and a later tick writes nothing.
13. [integration] Off a TTY, `renderChat` arms no timeout.
14. [integration] A `busy(true)` after unmount arms no timeout and writes nothing.

### US-008

1. [unit] The `run` tool's `inputSchema.properties.model` is `{ type: "string" }` and `required` stays `["agent", "task"]`.
2. [unit] The `run` tool's description contains `openai-codex/gpt-6-luna` and `acp:<agent>`.
3. [unit] Calling the `run` tool with `{ agent: "reviewer", task: "check it", model: "openai-codex/gpt-6-luna" }` calls `options.run` with `(reviewer, "check it", signal, "openai-codex/gpt-6-luna")`.
4. [unit] Calling the `run` tool without `model` calls `options.run` with exactly three arguments.
5. [unit] Calling the `run` tool with `model: 7` returns an error result `[chat] run model must be a non-empty string` and does not call `options.run`.
6. [unit] Calling the `run` tool with `model: "  "` returns the same error and does not call `options.run`.
7. [unit] `SubagentRuns.run(agent, task, undefined, "openai-codex/gpt-6-luna")` on an agent whose frontmatter model is `haiku` passes `model: "openai-codex/gpt-6-luna"` to `runSubagent`.
8. [unit] `SubagentRuns.run(agent, task, undefined, "acp:codex")` passes `model: "acp:codex"` to `runSubagent`.
9. [unit] `SubagentRuns.run(agent, task, undefined, "sonnet")` with `models.native.balanced` set to `openai/gpt-x` passes `model: "openai/gpt-x"` to `runSubagent`.
10. [unit] `SubagentRuns.run(agent, task, undefined, "gpt-6-luna")` (no provider, not an alias or tier) resolves an error result starting `[chat] unknown model gpt-6-luna` and `runSubagent` is not called.
11. [unit] `SubagentRuns.run(agent, task)` without an override still resolves the agent's own frontmatter model.
12. [integration] In a chat host whose catalog holds agent `reviewer`, the `nax-agents__run` tool the host builds, called with `model: "openai-codex/gpt-6-luna"`, opens the nested session on `openai-codex/gpt-6-luna`.
13. [unit] The second line of `buildAgentsInstructions([agent])` names `provider/model`, `openai-codex/gpt-6-luna` and `acp:<agent>`, and the agent list still follows it.

### US-009

1. [unit] `SubagentRuns.modelFor("reviewer")` for an agent with no frontmatter model returns the parent session's model.
2. [unit] `SubagentRuns.modelFor("reviewer", "openai-codex/gpt-6-luna")` returns `openai-codex/gpt-6-luna`.
3. [unit] `SubagentRuns.modelFor("nobody")` for an agent not in the catalog returns `undefined`.
4. [unit] `SubagentRuns.modelFor("reviewer", "gpt-6-luna")` returns `undefined`.
5. [unit] `withAgentCallModel`, given a `tool_call` named `nax-agents__run` with input `{ agent: "reviewer", task: "t" }` and a `modelFor` returning `openai/gpt-x`, forwards the event with `metadata.subagentModel` `openai/gpt-x` and every other field unchanged.
6. [unit] `withAgentCallModel` forwards a `tool_call` named `nax-agents__run` unchanged when `modelFor` returns `undefined`.
7. [unit] `withAgentCallModel` forwards a `tool_call` named `Read` unchanged and does not call `modelFor`.
8. [unit] `withAgentCallModel` forwards a `tool_call` named `nax-agents__run` whose `input.agent` is not a string unchanged.
9. [integration] `ChatHost.send` on a session whose stub emits a `tool_call` named `nax-agents__run` with input `{ agent: "reviewer", task: "t" }` delivers that event to the caller's listener with `metadata.subagentModel` set to the model `modelFor` resolves.
10. [unit] `reduceTranscript` on a top-level `tool_call` with `metadata.subagentModel` `openai/gpt-x` produces a `tool` entry whose `model` is `openai/gpt-x`.
11. [unit] `reduceTranscript` on a top-level `tool_call` without `metadata.subagentModel` produces a `tool` entry with no `model` key.
12. [unit] `toolCardModel` of a `nax-agents__run` entry with input `{ agent: "explorer", task: "find x" }` and `model` `openai/gpt-x` has `arg` `explorer [openai/gpt-x]: find x`.
13. [unit] `toolCardModel` of the same entry without `model` has `arg` `explorer: find x`.

### US-010

1. [unit] `resolveTargetRepo(root, undefined)` resolves `{ root }` with the same string.
2. [unit] `resolveTargetRepo(root, "repos/nax")`, where `<root>/repos/nax/.nax` is a directory, resolves `{ root: <real path of root>/repos/nax }`.
3. [unit] `resolveTargetRepo(root, <absolute path of root>/repos/nax)` resolves the same root as the relative form.
4. [unit] `resolveTargetRepo(root, ".")` resolves `{ root }` with the chat root's own spelling.
5. [unit] `resolveTargetRepo(root, 5)` resolves `{ error: "[chat] repo must be a non-empty string" }`.
6. [unit] `resolveTargetRepo(root, "")` resolves the same error.
7. [unit] `resolveTargetRepo(root, "missing")` resolves `{ error: "[chat] repo missing does not exist" }`.
8. [unit] `resolveTargetRepo(root, "..")` resolves an error starting `[chat] repo .. is outside`.
9. [unit] `resolveTargetRepo(root, "link")`, where `<root>/link` is a symlink to a directory outside `root`, resolves an error starting `[chat] repo link is outside`.
10. [unit] `resolveTargetRepo(<tmp>/chat, "../chat-evil")`, with `<tmp>/chat` and `<tmp>/chat-evil/.nax` created as real directories in a temporary directory, resolves an error starting `[chat] repo ../chat-evil is outside`.
11. [unit] `resolveTargetRepo(root, <absolute path of a nax project outside root>)` resolves an error starting `[chat] repo` and containing `is outside`.
12. [unit] `isWithinRoot("/w/chat-evil", "/w/chat")` returns `false`, `isWithinRoot("/w/chat/repos/nax", "/w/chat")` returns `true`, and `isWithinRoot("/w/chat", "/w/chat")` returns `true`.
13. [unit] `targetOutputDir(root)`, with `_targetRepoDeps.loadConfig` returning `{ name: "nested", outputDir: undefined }`, returns `projectOutputDir("nested", undefined)`.
14. [integration] The `state` tool called with `{ feature: "f1", repo: "repos/nax" }` reads the workflow verdict from the nested project's output directory: a verdict file written under `targetOutputDir(<nested root>)` appears in the result.
15. [unit] `resolveTargetRepo(root, "plain")`, where `<root>/plain` has no `.nax` directory, resolves `{ error: "[chat] repo plain is not a nax project: no .nax directory" }`.
16. [unit] The `state` tool's `inputSchema.properties` equals `{ feature: { type: "string" }, repo: { type: "string" } }`.
17. [integration] The `state` tool called with `{ feature: "f1", repo: "repos/nax" }`, where only `<root>/repos/nax/.nax/features/f1` exists, returns that feature's state, not an `unknown feature` error.
18. [integration] The `state` tool called with `{ repo: "repos/nax" }` lists the nested project's features.
19. [integration] The `state` tool called with `{ feature: "f1", repo: "plain" }` returns the error result `[chat] repo plain is not a nax project: no .nax directory`.
20. [unit] `buildWorkflowInstructions()` contains `pass repo with that folder's path`.

### US-011

1. [unit] Each of the `plan`, `run`, `bot_review` and `bot_fix` launch tools has `repo: { type: "string" }` in `inputSchema.properties`, and `required` is unchanged.
2. [integration] The `run` launch tool called with `{ feature: "f1", repo: "repos/nax" }` shows an approval card whose `command` contains `-d <real path of root>/repos/nax` and whose `reason` starts `workdir <real path of root>/repos/nax`.
3. [integration] After approval, `jobs.start` receives `cwd` equal to the nested root and the same argv the card showed.
4. [integration] The `run` launch tool called without `repo` passes `cwd` equal to the chat's `repoRoot` to `jobs.start`, and its argv carries `-d <repoRoot>`.
5. [integration] The `plan` launch tool called with `{ feature: "f1", repo: "repos/nax" }` resolves the spec from `<nested root>/.nax/features/f1/spec.md`.
6. [integration] The `run` launch tool called with `{ feature: "f1", repo: "plain" }` returns the error `[chat] repo plain is not a nax project: no .nax directory` and shows no approval card.
7. [integration] With a running `run` job whose `cwd` is the chat's `repoRoot`, the `run` launch tool called with `repo: "repos/nax"` is not refused as busy.
8. [integration] With a running `run` job whose `cwd` is the nested root, the `run` launch tool called with the same `repo` is refused as busy.
9. [integration] The busy check for a nested `repo` reads `nax.lock` from the nested root.
10. [unit] `jobs.start` with `cwd` set to a nested directory spawns the child with that `cwd` and records `cwd` equal to it.
11. [unit] A finished nested `run` job's outcome is read from `<job.cwd>/.nax/features/<feature>/status.json`.
12. [unit] On attach, a stored record whose `cwd` lies inside the runner's `repoRoot` is loaded.
13. [unit] On attach, a stored record whose `cwd` is a sibling directory of `repoRoot` is skipped.
14. [unit] `buildJobsInstructions()` contains `pass repo with that folder's path`.
15. [unit] `jobs.start` without `cwd` spawns the child in the runner's `repoRoot` and records `cwd` equal to it.
16. [unit] On attach with a runner whose `repoRoot` is a symlink to the real chat root, a stored record whose `cwd` is a nested real path inside that real root is loaded.
17. [unit] The chat write guard blocks a `Write` call while a `run` job runs whose `cwd` lies inside `repoRoot`.
18. [unit] The chat write guard allows a `Write` call while the only running `run` job's `cwd` is a sibling-prefix directory of `repoRoot` (`/w/chat-evil` against `/w/chat`).
19. [unit] On attach, a stored record whose `cwd` directory no longer exists is skipped and attach still loads the other records.

### US-012

1. [unit] `parseChainStepInput("run", { feature: "f1", repo: "repos/nax" })` returns no error.
2. [integration] A chain proposed with one `run` step whose input carries `repo: "repos/nax"` stores a step argv containing `-d <real path of root>/repos/nax`.
3. [integration] After that chain is approved, the `run` launch tool called with `{ feature: "f1", repo: "repos/nax" }` is admitted by the chain without a card and starts with `cwd` equal to the nested root.
4. [integration] A chain step whose `repo` is `plain` (no `.nax`) makes the proposal fail with an error starting `[chat] step 1: repo plain is not a nax project`.
5. [integration] A chain `plan` step with `repo: "repos/nax"` resolves its spec path inside the nested root.
