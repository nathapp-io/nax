# SPEC: Chat subagent dispatch on a bare model, model source on the Agent card, Writing for pending ACP tool calls, and "did you mean" for unread tool calls

Closes: #2806, #2807, #2808, #2809

## Summary

Four chat fixes. `nax-agents__run` accepts a `model` with no `agent` and runs the task on a built-in
`general` agent (#2806). The Agent card names where the subagent's model came from, next to the model
(#2807). An ACP tool call that is still pending switches the chat status from Thinking to Writing (#2808).
The native loop's follow-up for an unread `<tool_call>` block names each undeclared tool it found and
suggests the nearest declared one (#2809).

## Motivation

#2806. `createAgentsProvider` (`packages/nax/src/chat/agents-provider.ts`) requires `agent` and resolves
it with `catalog.findAgent`; `model` only overrides that agent's model. Asked to "dispatch native
openai-codex/gpt-6-luna", the chat agent had to guess a carrier agent: it called `agent: "explore"`
(refused as unknown) and then `agent: "Explore"`.

#2807. `withAgentCallModel` (`packages/nax/src/chat/agent-call-model.ts`) stamps only
`metadata.subagentModel`. The `source` that `resolveSubagentModel` returns (`inherit`, `alias`, `tier`,
`model`, `fallback`) is discarded, so the card cannot tell an override from the agent file's own model,
an alias, a tier mapping or a fallback to the parent model.

#2808. `createToolEvents` (`packages/nax-agent-acp/src/client/tool-events.ts`) emits nothing for a call
whose status is `pending`; `tool_call` goes out only on the first started update. `reduceTurnStatus`
(`packages/nax/src/tui/chat/chat-status.ts`) switches to Writing on `tool_input_delta`, which the ACP
client never produces, so the status reads Thinking while an ACP agent prepares a tool call.

#2809. `unreadToolCallFollowUp` (`packages/nax-agent/src/native/session/loop-handlers.ts`) lists every
declared tool name but does not say which name in the block was wrong. A model that wrote
`ScrashpadWrite` for `ScratchpadWrite` is not told so.

## Design

### Part 1 — the built-in `general` agent (#2806)

A new module `packages/nax/src/chat/builtin-agent.ts` exports:

```typescript
export const GENERAL_AGENT_NAME = "general";
export const GENERAL_AGENT_DESCRIPTION = "Runs a self-contained task on the model you pass";
/** The agent a nax-agents__run call with a model and no agent runs on. */
export function generalAgent(): AgentResource;
```

`generalAgent()` returns `{ kind: "agent", name: GENERAL_AGENT_NAME, qualifiedName: GENERAL_AGENT_NAME,
description: GENERAL_AGENT_DESCRIPTION, prompt: buildGeneralAgentPrompt(), path: "", origin: { kind:
"nax-builtin" } }` with no `model` and no `tools` keys. With no `tools`, `mapSubagentTools` returns no
`allowedTools`, so a native run admits every parent tool and an ACP run gets the chat profile (the
existing rules for an agent without `tools:`). `GENERAL_AGENT_NAME` and `generalAgent` are exported from
the `@/chat` barrel.

`ResourceOrigin` (`packages/nax/src/resources/types.ts`) gains `{ readonly kind: "nax-builtin" }`.
`originLabel` (`packages/nax/src/resources/listing.ts`) becomes an exported function (not added to the
`@/resources` barrel) and returns `"built-in"` for it. The general agent is never added to a
`ResourceCatalog`: `/agents`, the agents index and `findAgent` do not see it.

`buildGeneralAgentPrompt()` is a new function in `packages/nax/src/prompts/builders/agents-builder.ts`,
exported from `@/prompts`, returning exactly:

```text
You are a general-purpose subagent. Complete the task you are given with the tools you have, then reply with a concise final answer: the agent that called you reads only your last message.
```

### Part 2 — the provider runs a bare model on the general agent (#2806)

The provider's `run` checks, in this order, and stops at the first that applies:

1. `task` is not a non-empty string (after trim), or `agent` is present and is not a non-empty string:
   failure `[chat] run requires agent: string and task: string` (unchanged text).
2. `model` is present and is not a non-empty string: failure `[chat] run model must be a non-empty
   string` (unchanged text).
3. `agent` is absent and `model` is absent: failure `[chat] run requires agent, or model to run the
   built-in general agent`.
4. `agent` is absent and `model` is present: `options.run(generalAgent(), task, ctx.signal, model)`.
5. `agent` is present: the existing lookup (`unknown agent ...` when `findAgent` misses), then
   `options.run(agent, task, ctx.signal[, model])` as today.

The input schema's `required` becomes `["task"]`; `properties` and `additionalProperties: false` are
unchanged. The tool is still advertised only when the catalog has at least one agent (unchanged gate).

The tool description becomes:

```text
Run a named catalog agent on a self-contained task and return its final answer. Optional model overrides the agent's model: provider/model (for example openai-codex/gpt-6-luna) runs it on the nax native agent with that provider's model; acp:<agent> (for example acp:codex) runs it on an installed ACP agent. A provider name such as openai-codex is a native provider, not the Codex ACP agent. To run a task on a model with no catalog agent, omit agent and pass model: the task runs on the built-in general agent with your tools.
```

`buildAgentsInstructions` gains a third fixed line after the existing two, before the agent entries:
`To run a task on a model when no agent fits, omit agent and pass model; the task runs on the built-in general agent.`

A model on the general agent that resolves to `fallback` is refused by the existing check in
`runNested` (`[chat] unknown model <m>; pass provider/model ...`), unchanged.

### Part 3 — the model's source reaches the tool_call (#2807)

`packages/nax/src/chat/subagent-model.ts` gains:

```typescript
export type SubagentModelLabel = "inherited" | "alias" | "tier" | "agent file" | "override" | "fallback to parent";
export function subagentModelLabel(source: SubagentModelSource, overridden: boolean): SubagentModelLabel;
```

`subagentModelLabel` maps, in this order: `overridden && source === "model"` -> `"override"`; then
`inherit` -> `"inherited"`, `alias` -> `"alias"`, `tier` -> `"tier"`, `model` -> `"agent file"`,
`fallback` -> `"fallback to parent"`. An override that resolves through an alias or a tier keeps
`"alias"` / `"tier"`, because that is where the model id came from, and an override of `inherit` keeps
`"inherited"`.

`SubagentRuns.modelFor` changes shape (see Integration); `overridden` is `override !== undefined`. An
absent `agentName` resolves against `generalAgent()` with no catalog lookup.

`withAgentCallModel` reads the `nax-agents__run` input as: `agent` present and a string -> that name;
`agent` absent and `model` a string -> no name (the general agent); anything else -> forward the event
unchanged without calling `modelFor` (as today for a non-string agent). When `modelFor` returns a value,
the event is forwarded with `metadata: { ...event.metadata, subagentModel: model, subagentModelSource:
label }`.

### Part 4 — the Agent card shows the source (#2807)

`reduceTranscript` (`packages/nax/src/tui/chat/transcript-model.ts`) copies
`metadata.subagentModelSource` (a string) onto the top-level tool entry as `modelSource`, beside the
existing `model`; an event without it gets no `modelSource` key.

`agentArg` (`packages/nax/src/tui/chat/tool-card.ts`) renders, for a call with a string `task`:
- the agent name: the input's string `agent`, or `GENERAL_AGENT_NAME` (imported from the
  `@/chat` barrel) when `agent` is absent;
- then ` [<model> · <modelSource>]` when both are set, ` [<model>]` when only the model is set, nothing
  when there is no model;
- then `: <task>`.
A call whose `agent` is present but not a string, or with no string `task`, has no arg (unchanged).
`card` passes the entry's `modelSource` to `agentArg` alongside `model`.

### Part 5 — a pending ACP tool call reads as Writing (#2808)

`createToolEvents` gains a pending signal. `CallState` gets `pendingChars?: number`. `inputChars(state)`
is the length of `JSON.stringify(inputOf(state.rawInput, secrets))` (the same scrubbed, capped input
`tool_call` carries; `inputOf` already returns a truncation placeholder for input it cannot serialize).
In `onUpdate`, after `merge`, for a call that is neither announced nor in `running`:

- an update whose `status` is `"pending"` on a call with no `pendingChars` yet (the first pending
  sighting) emits `{ type: "tool_input_delta", round: 0, callId, name: nameOf(state), chars: 0 }` and
  records `pendingChars = inputChars(state)`.
- any later update (with status `"pending"` or no status) on a call that has `pendingChars` computes
  `chars = inputChars(state) - pendingChars`; when `chars > 0` it emits the same event with that
  `chars` and records `pendingChars = inputChars(state)`; otherwise it emits nothing.

Once a call is announced or started, no further `tool_input_delta` is emitted for it. A call first seen
with no status, or first seen started, emits no `tool_input_delta`.

No change in `packages/nax`: `reduceTurnStatus` already maps `tool_input_delta` to Writing and
`tool_call` to the tool phase, and the ACP session forwards `tool_input_delta` unchanged.

### Part 6 — "did you mean" in the unread tool-call follow-up (#2809)

A new module `packages/nax-agent/src/native/session/unread-tool-call.ts` exports:

```typescript
export const MAX_SUGGEST_DISTANCE = 2;
/** Tool names written in the <tool_call> blocks of an assistant reply, first-seen order, no duplicates. */
export function writtenToolNames(content: string): string[];
/** The declared name nearest to `written`, case-insensitive, within MAX_SUGGEST_DISTANCE; first in declared order on a tie. */
export function nearestToolName(written: string, declared: readonly string[]): string | undefined;
export function buildUnreadToolCallFollowUp(content: string, declared: readonly string[]): string;
```

A tool name is a string matching `^[A-Za-z_][A-Za-z0-9_.-]{0,63}$` (`TOOL_NAME_PATTERN`).
`writtenToolNames` scans each `<tool_call>` marker to the next `</tool_call>` (or the end of the text).
Within a block, the name is the first `"name"` JSON string value (`"name"` followed by optional spaces,
`:`, optional spaces and a double-quoted string), kept only when it matches `TOOL_NAME_PATTERN`. When the
block has no `"name"` value, the name is the run of name characters that starts at the first
non-whitespace character after the marker, kept only when that character is a letter or `_` and the run
matches `TOOL_NAME_PATTERN`. A block yielding neither contributes no name.

`nearestToolName` compares lowercase forms with Levenshtein distance; it returns the declared name (in
its declared casing) with the smallest distance when that distance is at most `MAX_SUGGEST_DISTANCE`,
and undefined otherwise or when `declared` is empty.

`buildUnreadToolCallFollowUp` returns the existing text, then, for each written name that is not exactly
a declared name, appends one space and `` `<written>` is not a declared tool; did you mean `<nearest>`? ``
or, with no near match, `` `<written>` is not a declared tool. ``. The existing text is:
`Your reply contains a <tool_call> block that was not run: it did not read as a call of a declared tool. Call tools through the tool interface, using one of these exact names: <names or (none)>.`

`unreadToolCallFollowUp` in `loop-handlers.ts` keeps its guards and its once-per-turn `sent` flag, and
returns `{ followUp: buildUnreadToolCallFollowUp(last.content, toolNames()) }`.

This is a nax-agent string, not a nax prompt builder: the nax prompt-builder rule covers
`packages/nax/src`, and the follow-up already lives in nax-agent.

### Integration

Read only (verified at main `3299167ba`):
- `resolveSubagentModel(options): ResolvedSubagentModel` and `SubagentModelSource` —
  `packages/nax/src/chat/subagent-model.ts`
- `mapSubagentTools(tools?: readonly string[]): MappedSubagentTools` — `packages/nax/src/chat/subagent-tools.ts`
- `reduceTurnStatus(status, event)` — `packages/nax/src/tui/chat/chat-status.ts` (`tool_input_delta` -> WRITING)
- `inputOf(raw, secrets)`, `nameOf(state)` — `packages/nax-agent-acp/src/client/tool-events.ts`
- `TurnEvent` `tool_input_delta` `{ round, callId, name, chars }` — `packages/nax-agent/src/session/turn-event.ts`

Changed. The baseline locates the code only; implement the target.

- `createAgentsProvider` tool `inputSchema.required`
  Baseline: `["agent", "task"]`
  Target: `["task"]`
- `originLabel` — `packages/nax/src/resources/listing.ts`
  Baseline: module-private `function originLabel(origin: ResourceOrigin): string`
  Target: `export function originLabel(origin: ResourceOrigin): string`, with a `nax-builtin` case
- `SubagentRuns.modelFor` — `packages/nax/src/chat/subagent-runs.ts`
  Baseline: `modelFor(agentName: string, override?: string): string | undefined`
  Target: `modelFor(agentName: string | undefined, override?: string): { model: string; label: SubagentModelLabel } | undefined`
  (undefined for an unknown name or a refused override, as today; an undefined name means the general agent)
- `withAgentCallModel(onEvent, modelFor)` — the `modelFor` parameter takes the target type above.
- `ResourceOrigin` — gains `{ readonly kind: "nax-builtin" }`.
- `TranscriptEntry` tool entry — gains `modelSource?: string` beside `model?: string`.
- `CallState` (tool-events) — gains `pendingChars?: number`.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| `nax-agents__run` with neither `agent` nor `model` | error result `[chat] run requires agent, or model to run the built-in general agent`; run not called |
| general-agent run whose model resolves to fallback | error result starting `[chat] unknown model <m>`; no nested session opens |
| `withAgentCallModel` input with no `agent` and no string `model` | event forwarded unchanged, `modelFor` not called |
| unread block whose name is not a valid tool name | no suggestion sentence for that block; the existing text only |

## Out of Scope

- Offering `nax-agents__run` when the catalog has no agents; the tool stays gated on at least one catalog agent.
- A bare-model run from `nax agents run`; that command still requires an `<agent>` argument.
- Showing the subagent's model on its nested child rows; they sit under the Agent card that names it.
- Emitting `tool_input_delta` for an ACP call first seen with no status, or for permission-request announcements.
- Switching the status to Writing for ACP `agent_thought_chunk` content.
- Raising the once-per-turn cap on the unread tool-call follow-up.
- Rewriting or running a misspelled text tool call automatically; the model must call the tool itself.
- US-006 only: reading the tool name from a top-level JSON key; the first `"name"` string value in the block is taken even when it is nested inside the arguments.
- Persisting `modelSource` for sessions recorded before this change; their cards keep `[model]`.

## Stories

### US-001: The built-in general agent

No dependencies. Workdir: `packages/nax`

Adds `builtin-agent.ts` (`GENERAL_AGENT_NAME`, `GENERAL_AGENT_DESCRIPTION`, `generalAgent`),
`buildGeneralAgentPrompt()`, the `nax-builtin` origin, and the exported `originLabel` with its
`built-in` case (Design Part 1).

### US-002: The provider runs a bare model on the general agent

Depends on US-001. Workdir: `packages/nax`

The provider's check order, `required: ["task"]`, the new description and the instructions line
(Design Part 2).

### US-003: The model's source reaches the tool_call

Depends on US-001. Workdir: `packages/nax`

`subagentModelLabel` and `SubagentModelLabel`, the target `modelFor` shape (with the general agent for
an absent name), and `withAgentCallModel` stamping `subagentModelSource` and handling an absent agent
(Design Part 3).

### US-004: The Agent card shows the source

Depends on US-001, US-003. Workdir: `packages/nax`

`modelSource` on the transcript entry, and the card's `[model · source]` and `general` rendering
(Design Part 4).

### US-005: A pending ACP tool call emits tool_input_delta

No dependencies. Workdir: `packages/nax-agent-acp`

`pendingChars` on `CallState` and the pending signal in `createToolEvents.onUpdate` (Design Part 5).

### US-006: The unread tool-call follow-up names the wrong tool and suggests one

No dependencies. Workdir: `packages/nax-agent`

`unread-tool-call.ts` and routing `unreadToolCallFollowUp` through it (Design Part 6).

### Context Files

**US-001**
- `packages/nax/src/resources/types.ts` - `AgentResource`, `ResourceOrigin`
- `packages/nax/src/resources/listing.ts` - `originLabel`
- `packages/nax/src/prompts/builders/agents-builder.ts` - where `buildGeneralAgentPrompt` goes
- `packages/nax/src/chat/index.ts` - the `@/chat` barrel

**US-002**
- `packages/nax/src/chat/agents-provider.ts` - provider, schema, check order
- `packages/nax/src/prompts/builders/agents-builder.ts` - `buildAgentsInstructions`
- `packages/nax/test/unit/chat/agents-provider.test.ts` - provider fixture, `INVALID_INPUT`, `runTool`
- `packages/nax/test/helpers/chat-subagents.ts` - host harness, scripted `tool.run` input
- `packages/nax/src/chat/builtin-agent.ts` - created by US-001, `generalAgent`

**US-003**
- `packages/nax/src/chat/subagent-model.ts` - `resolveSubagentModel`, `SubagentModelSource`
- `packages/nax/src/chat/subagent-runs.ts` - `modelFor`, `resolveFor`, `runNested`
- `packages/nax/src/chat/agent-call-model.ts` - `withAgentCallModel`
- `packages/nax/test/unit/chat/subagent-runs.test.ts` - `runsDeps` fixture, `modelFor` tests
- `packages/nax/src/chat/builtin-agent.ts` - created by US-001, `generalAgent`

**US-004**
- `packages/nax/src/tui/chat/tool-card.ts` - `agentArg`, `card`
- `packages/nax/src/tui/chat/transcript-model.ts` - `applyToolCall`
- `packages/nax/test/unit/tui/chat/tool-card.test.ts` - `card` fixture
- `packages/nax/src/chat/builtin-agent.ts` - created by US-001, `GENERAL_AGENT_NAME` (exported from `@/chat`)

**US-005**
- `packages/nax-agent-acp/src/client/tool-events.ts` - `createToolEvents`, `CallState`, `inputOf`
- `packages/nax-agent-acp/test/unit/client/tool-events.test.ts` - `setup` fixture
- `packages/nax-agent-acp/test/unit/client/backend-events.test.ts` - end-to-end event order fixture

**US-006**
- `packages/nax-agent/src/native/session/loop-handlers.ts` - `unreadToolCallFollowUp`
- `packages/nax-agent/test/unit/native/session/unread-tool-call.test.ts` - handler fixture, `payload`
- `packages/nax-agent/test/integration/session/native-unread-tool-call.test.ts` - end-to-end follow-up

### Creates

**US-001**
- `packages/nax/src/chat/builtin-agent.ts`
- `packages/nax/test/unit/chat/builtin-agent.test.ts`

**US-006**
- `packages/nax-agent/src/native/session/unread-tool-call.ts`
- `packages/nax-agent/test/unit/native/session/unread-tool-call-text.test.ts`

### Modifies

**US-002**
- `packages/nax/test/unit/chat/agents-provider.test.ts` - test "AC-6 inputSchema.required is [agent, task]" pins `["agent", "task"]`; it becomes `["task"]`, because `agent` is optional when `model` is given.
- `packages/nax/test/unit/chat/agents-provider.test.ts` - test "AC-1 schema has model: string and required stays [agent, task]" pins `required` to `["agent", "task"]`; it becomes `["task"]` (the `model: string` property assertion stays), because `agent` is optional when `model` is given.
- `packages/nax/test/unit/chat/agents-provider.test.ts` - the `test.each` "AC-13 %s does not call the injected run" asserts `{ isError: true, content: INVALID_INPUT }` for every row; its "missing agent" row (no agent, no model) now expects content `[chat] run requires agent, or model to run the built-in general agent`, because a missing agent with no model is its own check (Design Part 2, step 3). Every other row and the not-called assertion stay.
- `packages/nax/test/unit/prompts/builders/agents-builder.test.ts` - test "AC-13 second line names provider/model, the native example and acp:<agent>; list follows" asserts the first agent entry is `out[2]`; the new fixed third line moves the entry to `out[3]`, and `out[2]` becomes the general-agent line, because `buildAgentsInstructions` gains that line before the entries.
- `packages/nax/test/helpers/chat-subagents.ts` - the scripted run hard-codes `tool.run({ agent: runAgentName, task })`; it gains an optional `runInput` setup option that, when set, is passed to `tool.run` in place of that object, so a test can script a run with no agent and a model. Existing callers that omit it get the old input.

**US-003**
- `packages/nax/test/unit/chat/subagent-runs.test.ts` - the `SubagentRuns.modelFor` tests "AC-1 an agent without a model resolves to the parent session's model" and "AC-2 an explicit provider/model override is returned" pin a string with `toBe`; they assert `{ model, label }` objects instead (`label` "inherited" and "override"), because `modelFor` now returns the model with its label. The undefined cases stay.
- `packages/nax/test/unit/chat/agent-call-model.test.ts` - its `modelFor` mocks return a string, and the "adds metadata.subagentModel" test pins the forwarded metadata to the `keep` field plus `subagentModel` only; the mocks return `{ model, label }` and the pinned metadata gains `subagentModelSource`, because `modelFor` now returns the model with its label.
- `packages/nax/test/unit/chat/host-subagents.test.ts` - test "AC-9 send delivers the run tool_call with metadata.subagentModel" pins metadata `{ subagentModel: CHAT_MODEL }`; it becomes `{ subagentModel: CHAT_MODEL, subagentModelSource: "inherited" }`, because the host now stamps the label beside the model.

**US-004**
None. `card` and `reduceTranscript` tests assert with `toMatchObject` or on `arg` for calls that carry no `modelSource`, so their expectations hold.

**US-005**
- `packages/nax-agent-acp/test/unit/client/tool-events.test.ts` - tests "a pending call with streaming input emits nothing until it is used", "in_progress announces; failed answers with isError", "announce() (a permission request) emits tool_call once; a later in_progress does not repeat it", "the first real title is kept over later ones", "no tool_progress before the call is announced" and the `MAX_TRACKED_CALLS` test pin exact event lists or `events[0]` for calls that start `pending`; each now accepts the leading `tool_input_delta` events this story emits for pending updates and keeps its `tool_call` / `tool_result` / name / ordering assertions over the remaining events (the "emits nothing" test is renamed to say no `tool_call` goes out until the call is used).
- `packages/nax-agent-acp/test/unit/client/backend-events.test.ts` - test "a tool call, its result, a thought, text and the turn's usage" pins the event type list `turn_start, tool_call, ...`; one or more `tool_input_delta` events for `toolu_1` now come between `turn_start` and `tool_call`, the rest of the order unchanged.

**US-006**
- `packages/nax-agent/test/unit/native/session/unread-tool-call.test.ts` - its `BLOCK` fixture is a JSON tool_call block whose name is `ScrashpadWrite`, an undeclared tool. Test "follows up once, naming the tools, and marks sent" pins the follow-up with `toBe`; the expected text gains `` `ScrashpadWrite` is not a declared tool.`` after one space (no declared name is within distance 2). Test "AC-11: with no tools the follow-up ends with (none)" asserts `toEndWith("using one of these exact names: (none).")`; it now asserts the text contains that phrase and ends with `` `ScrashpadWrite` is not a declared tool.``. The guard and once-per-turn tests stay as they are.
- `packages/nax-agent/test/integration/session/native-unread-tool-call.test.ts` - test "AC-1, AC-2" asserts the follow-up `toEndWith` the declared-names sentence; its block names `ScrashpadWrite`, so the follow-up now ends with that name's suggestion sentence. The assertion becomes: contains `using one of these exact names: <declared>.` and ends with the sentence `buildUnreadToolCallFollowUp` appends for `ScrashpadWrite` against the declared names.

### Seams

- US-001 -> US-002: `generalAgent` is passed by the provider to `options.run` for a bare-model call; US-002 AC-4 asserts the injected run receives it, and AC-10 triggers it through the chat host.
- US-001 -> US-003: `generalAgent` resolves an absent name in `modelFor`; US-003 AC-6 pins it.
- US-001 -> US-004: `GENERAL_AGENT_NAME` is the card's name for an agentless call; US-004 AC-3 pins it.
- US-003 -> US-004: `metadata.subagentModelSource` stamped by `withAgentCallModel` is read by `reduceTranscript`; US-003 AC-11 asserts the host stamps it and US-004 AC-1 asserts the transcript reads it.
- US-006 internal: `buildUnreadToolCallFollowUp` is consumed by `unreadToolCallFollowUp`; US-006 AC-13 triggers the `before_turn_end` dispatch and asserts the suggestion reaches `followUp`.

## Acceptance Criteria

### US-001

1. [unit] `generalAgent()` from `@/chat` returns an `AgentResource` whose `name` and `qualifiedName` both equal `GENERAL_AGENT_NAME`, and `GENERAL_AGENT_NAME` is `"general"`.
2. [unit] `generalAgent()` returns `origin` `{ kind: "nax-builtin" }`, `path` `""` and `description` equal to `GENERAL_AGENT_DESCRIPTION`.
3. [unit] `generalAgent()` returns an object with no `model` key and no `tools` key.
4. [unit] `generalAgent().prompt` equals `buildGeneralAgentPrompt()` from `@/prompts`.
5. [unit] `buildGeneralAgentPrompt()` returns exactly the text in Design Part 1.
6. [unit] `originLabel({ kind: "nax-builtin" })`, imported from `packages/nax/src/resources/listing.ts`, returns `"built-in"`.
7. [unit] `originLabel({ kind: "claude-user" })` still returns `"user"`, and `originLabel({ kind: "nax-plugin", plugin: "kit" })` still returns `"nax-plugin kit"`.

### US-002

1. [unit] The `nax-agents` provider's `run` tool has `inputSchema.required` equal to `["task"]`.
2. [unit] The tool's `description` equals the text in Design Part 2.
3. [unit] `buildAgentsInstructions` with one entry returns `To run a task on a model when no agent fits, omit agent and pass model; the task runs on the built-in general agent.` as its third line, with the entry's line fourth.
4. [unit] Running the tool with `{ task: "t", model: "openai-codex/gpt-6-luna" }` calls the injected `run` once with an `AgentResource` whose `name` is `"general"` and whose `origin.kind` is `"nax-builtin"`, then the task `"t"`, the context signal and the model `"openai-codex/gpt-6-luna"`.
5. [unit] Running the tool with `{ task: "t" }` (no agent, no model) returns `{ isError: true, content: "[chat] run requires agent, or model to run the built-in general agent" }` and does not call the injected `run`.
6. [unit] Running the tool with `{ task: "t", model: "  " }` (no agent) returns `{ isError: true, content: "[chat] run model must be a non-empty string" }` and does not call the injected `run`.
7. [unit] Running the tool with `{ agent: 1, task: "t", model: "p/x" }` returns `{ isError: true, content: "[chat] run requires agent: string and task: string" }` and does not call the injected `run`.
8. [unit] Running the tool with `{ model: "p/x" }` (no task) returns `{ isError: true, content: "[chat] run requires agent: string and task: string" }` and does not call the injected `run`.
9. [unit] Running the tool with `{ agent: "nobody", task: "t", model: "p/x" }` returns an error whose content starts `unknown agent nobody; available:` and does not call the injected `run`.
10. [integration] On a chat host whose catalog has one agent, a scripted chat turn running the tool with input `{ task: "look", model: "openai/gpt-x" }` opens one nested native session whose model is `openai/gpt-x` and whose system instructions end with `buildGeneralAgentPrompt()`.
11. [unit] The provider still advertises no tools for a catalog with no agents.

### US-003

1. [unit] `subagentModelLabel("model", true)` returns `"override"`.
2. [unit] `subagentModelLabel("inherit", false)` returns `"inherited"` and `subagentModelLabel("model", false)` returns `"agent file"`.
3. [unit] `subagentModelLabel("alias", false)` returns `"alias"` and `subagentModelLabel("tier", false)` returns `"tier"`.
4. [unit] `subagentModelLabel("fallback", false)` returns `"fallback to parent"`.
5. [unit] `subagentModelLabel("alias", true)` returns `"alias"`, `subagentModelLabel("tier", true)` returns `"tier"`, and `subagentModelLabel("inherit", true)` returns `"inherited"`.
6. [unit] `modelFor(undefined, "openai/gpt-x")` returns `{ model: "openai/gpt-x", label: "override" }`.
7. [unit] `modelFor("reviewer")` for a catalog agent with no `model:` returns `{ model: <parent model>, label: "inherited" }`, and `modelFor("reviewer", "openai/gpt-x")` returns `{ model: "openai/gpt-x", label: "override" }`.
8. [unit] `run(generalAgent(), "t", undefined, "bogus")` on `createSubagentRuns` returns an error result whose content starts `[chat] unknown model bogus` and never calls the injected `runSubagent`.
9. [unit] `withAgentCallModel` given a `nax-agents__run` tool_call with input `{ agent: "reviewer", task: "t" }` and metadata `{ keep: "me" }`, with `modelFor` returning `{ model: "openai/gpt-x", label: "agent file" }`, forwards the event with metadata `{ keep: "me", subagentModel: "openai/gpt-x", subagentModelSource: "agent file" }`.
10. [unit] `withAgentCallModel` given input `{ task: "t", model: "p/x" }` (no agent) calls `modelFor` with `(undefined, "p/x")`; given input `{ task: "t" }` (no agent, no model) it forwards the event unchanged and does not call `modelFor`.
11. [integration] On a chat host whose catalog has an agent `reviewer` with no `model:`, a chat turn emitting a `nax-agents__run` call `{ agent: "reviewer", task: "t" }` delivers that tool_call to the send's `onEvent` with metadata `subagentModel` equal to the chat model and `subagentModelSource` equal to `"inherited"`.

### US-004

1. [unit] `reduceTranscript` given a top-level `nax-agents__run` tool_call with metadata `{ subagentModel: "openai/gpt-x", subagentModelSource: "override" }` yields a tool entry with `model` `"openai/gpt-x"` and `modelSource` `"override"`.
2. [unit] `reduceTranscript` given a top-level call with only `subagentModel` metadata yields an entry with no `modelSource` key.
3. [unit] The tool card for `nax-agents__run` with input `{ task: "find x" }`, `model` `"p/x"` and `modelSource` `"override"` has `arg` equal to `general [p/x · override]: find x`.
4. [unit] The tool card for input `{ agent: "explorer", task: "find x" }` with `model` `"openai/gpt-x"` and `modelSource` `"agent file"` has `arg` equal to `explorer [openai/gpt-x · agent file]: find x`.
5. [unit] The tool card for input `{ agent: "explorer", task: "find x" }` with `model` `"openai/gpt-x"` and no `modelSource` has `arg` equal to `explorer [openai/gpt-x]: find x`.
6. [unit] The tool card for input `{ agent: 3, task: "find x" }` has no `arg`.
7. [unit] The tool card for input `{ task: "find x" }` with no model has `arg` equal to `general: find x`.

### US-005

1. [unit] `createToolEvents` given `{ toolCallId: "c1", name: "Write", status: "pending", rawInput: {} }` emits exactly `{ type: "tool_input_delta", round: 0, callId: "c1", name: "Write", chars: 0 }`.
2. [unit] After that, `{ toolCallId: "c1", rawInput: { path: "a.ts" } }` (no status) emits one `tool_input_delta` for `c1` whose `chars` is the serialized length of `{"path":"a.ts"}` minus the serialized length of `{}`.
3. [unit] After that, a repeat of `{ toolCallId: "c1", rawInput: { path: "a.ts" } }` emits nothing.
4. [unit] After that, a repeat of `{ toolCallId: "c1", status: "pending", rawInput: { path: "a.ts" } }` emits nothing.
5. [unit] After that, `{ toolCallId: "c1", status: "in_progress" }` emits the `tool_call` for `c1`, and a later `{ toolCallId: "c1", status: "pending", rawInput: { path: "much-longer.ts" } }` emits no `tool_input_delta`.
6. [unit] `{ toolCallId: "c2", name: "Read" }` with no status, on a call never seen pending, emits nothing.
7. [unit] `{ toolCallId: "c3", name: "Read", status: "completed" }` on a call never seen pending emits `tool_call` then `tool_result` and no `tool_input_delta`.
8. [unit] With a secret passed to `createToolEvents`, a pending call whose later `rawInput` holds that secret emits `tool_input_delta` events whose `chars` are computed from `inputOf` of the input, and no emitted event contains the secret.
9. [unit] After `announce({ toolCallId: "c4", title: "Edit a.ts" })` for a call first seen pending, a further update for `c4` with a longer `rawInput` emits no `tool_input_delta`.
10. [integration] An ACP session driven by the fake agent with a `tool_call` update (status `pending`, `rawInput: {}`), a `tool_call_update` with `rawInput: { file_path: "/w/a.ts" }`, then a `completed` update, delivers at least one `tool_input_delta` for that call id after `turn_start` and before its `tool_call`.

### US-006

1. [unit] `writtenToolNames` of `<tool_call>{"name": "ScrashpadWrite", "arguments": {}}</tool_call>` returns `["ScrashpadWrite"]`.
2. [unit] `writtenToolNames` of `<tool_call>\nScrashpadWrite\n<arg_key>path</arg_key></tool_call>` returns `["ScrashpadWrite"]`.
3. [unit] `writtenToolNames` of `<tool_call>{"arguments": {"path": "a"}}</tool_call>` (no `"name"` key, first non-whitespace character `{`) returns `[]`.
4. [unit] `writtenToolNames` of two blocks both naming `Raed` returns `["Raed"]`, and of blocks naming `B` then `A` returns `["B", "A"]`.
5. [unit] `writtenToolNames` of `<tool_call></tool_call>` returns `[]`, and of an unterminated `<tool_call>{"name":"Grep"` returns `["Grep"]`.
6. [unit] `writtenToolNames` of a block whose `"name"` value is `bad name!` or is 65 characters long returns `[]`.
7. [unit] `nearestToolName("ScrashpadWrite", ["Read", "ScratchpadWrite"])` returns `"ScratchpadWrite"`.
8. [unit] `nearestToolName("read", ["Read", "Write"])` returns `"Read"`.
9. [unit] `nearestToolName("Deploy", ["Read", "Write"])` returns undefined, and `nearestToolName("Read", [])` returns undefined.
10. [unit] `nearestToolName("Raad", ["Read", "Road"])` returns `"Read"`.
11. [unit] `buildUnreadToolCallFollowUp` of a block naming `ScrashpadWrite` with declared `["Read", "ScratchpadWrite"]` returns the existing text naming `Read, ScratchpadWrite`, one space, then `` `ScrashpadWrite` is not a declared tool; did you mean `ScratchpadWrite`?``.
12. [unit] `buildUnreadToolCallFollowUp` of a block naming `Deploy` with declared `["Read"]` ends with `` `Deploy` is not a declared tool.``, and of a block naming `Read` with declared `["Read"]` returns exactly the existing text.
13. [integration] With built-in loop handlers installed and declared tools `["Read", "ScratchpadWrite"]`, dispatching `before_turn_end` for a completed turn whose last assistant message is a block naming `ScrashpadWrite` returns a `followUp` ending with ``did you mean `ScratchpadWrite`?``, and a second dispatch in the same turn returns `{}`.
