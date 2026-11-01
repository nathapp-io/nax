# SPEC: nax agent hooks

## Summary

Users can attach their own shell commands to the native agent's turn, the way
Claude Code hooks work, configured in nax's `hooks.json` under a new `agent`
key. Five events: `PreToolUse` (allow, rewrite input, add a note, or block a
tool call), `PostToolUse` (feed back to the agent after a tool call),
`UserPromptSubmit` (add context to, or block, a turn's prompt), `SessionStart`
(add context on a session's first turn) and `Stop` (make the agent continue).
Each hook chooses where it runs: `nax chat`, `nax run`, or both. The hooks are
delivered as handlers on the native agent's existing loop-event chain, built
by a factory and appended at the chat and run sites the way rule delivery is.
nax does not execute Claude Code's own hooks.

Design: `docs/superpowers/specs/2026-11-01-nax-agent-hooks-design.md`.

## Motivation

The only way to influence a native-agent tool call today is an in-process
JavaScript plugin providing `loop-handlers`. The run lifecycle hooks in
`hooks.json` (`on-start`, `on-story-complete`, ...) are shell commands, but
they fire only in `nax run`, only on run lifecycle events, and cannot block or
change anything. A user who wants "run prettier after every edit", "never let
the agent `git push`" or "keep going until the tests pass" has to write a
plugin. Claude Code users expect a shell command in config.

## Design

### Approach

One factory per surface turns the `agent` section of `hooks.json` into a
`LoopHandlerSet`. It registers at most one handler per loop event; that handler
runs every applicable hook entry for the event in order. One handler per event
(not per entry) is required: `dispatchChain` in
`packages/nax-agent/src/native/session/loop-events/registry.ts` merges handler
patches by overwrite, so two handlers that each return a `before_turn` patch
would keep only the last one's.

| Hook event | Loop event | Runs when |
|---|---|---|
| `PreToolUse` | `before_tool` | before each tool call whose name the entry's `matcher` matches |
| `PostToolUse` | `after_tool` | after each tool call whose name the entry's `matcher` matches |
| `SessionStart` | `before_turn` | the turn's loaded `history` is empty |
| `UserPromptSubmit` | `before_turn` | every turn, after `SessionStart` hooks |
| `Stop` | `before_turn_end` | the turn ended `"completed"` and not by a stop |

**Deadline.** Each factory handler's `timeoutMs` is
`AGENT_HOOK_HANDLER_MARGIN_MS + Σ (entry.timeoutMs + AGENT_HOOK_KILL_GRACE_MS + AGENT_HOOK_DRAIN_MS)`
over the entries that handler may run on its surface (for `before_turn`: every
`SessionStart` and `UserPromptSubmit` entry, whether or not `SessionStart`
runs on a given turn). The constants live in `run-hook.ts`:
`AGENT_HOOK_KILL_GRACE_MS = 5000` (SIGTERM to SIGKILL), `AGENT_HOOK_DRAIN_MS =
2000` (stream drain bound), `AGENT_HOOK_HANDLER_MARGIN_MS = 1000`. With this
bound a hook always reports its own timeout or error before the wrapper's
deadline fires, so the per-event failure rules below, not the wrapper's
generic ones, decide the outcome.

**Combining several entries of one event** (one handler runs them all, in
config order):

- Context strings (`additionalContext`, and plain-text stdout where it counts
  as context) are joined with `"\n\n"` in entry order; empty strings are
  dropped.
- `PreToolUse`: an entry's `updatedInput` becomes the `tool_input` every later
  entry sees and the outcome's `input`; context strings become one `nudge`
  text; the first block stops the chain. An outcome with both an input and a
  nudge text is `{ kind: "nudge", text, input }`.
- `PostToolUse`: each entry's feedback (`"Hook feedback: " + reason` on a
  block) and context (`"Hook context: " + text`) is appended to the result
  content in entry order, each preceded by `"\n\n"`.
- `UserPromptSubmit`: the first block stops the remaining
  `UserPromptSubmit` entries and the handler returns only `block`.
- `Stop`: the first block stops the remaining `Stop` entries.
- A JSON-object stdout is never treated as plain text: a `SessionStart` entry
  answering `{}` adds no context.
- A JSON `decision: "block"` without a string `reason` uses the reason
  `blocked by hook '<command>'`.
- A `PreToolUse` `updatedInput` that is not a JSON object is ignored with one
  warning naming the command.

**Ordering at the wiring sites.** On both surfaces the order is plugin
handlers, then agent hooks, then rule delivery: chat appends the agent-hook
handlers to `pluginHandlers` and `ChatHost` appends rule delivery after them;
run passes `[...pluginHandlers, ...agentHooks]` into
`withRuleDeliveryHandlers`, which appends rule delivery last (the existing
"rules after plugins" rule). Rule delivery answers `before_tool` with a nudge
(read) or a block (write) and `dispatchBeforeTool` keeps only the last nudge,
so for a call where both answer a nudge, the rule text wins (see Out of
Scope).

**Bot is excluded.** `packages/nax/src/bot/run-setup.ts` also calls
`configureRunRules`, on a PR worktree that may come from a fork. Agent hooks
are therefore opt-in on `configureRunRules` (`agentHooks: "run"`), passed only
by `initializeAfterLock` (`packages/nax/src/execution/lifecycle/run-setup-init.ts`);
the bot call stays as it is and loads no agent hooks.

Hook commands run as child processes exactly like the lifecycle hooks: argv
spawn through `parseCommandToArgv` (no shell; a leading `~` is already
expanded from HOME), the same `validateHookCommand` lint, process cwd = the
session's `LoopHandlerContext.workdir`, else the repo root the config was
loaded for. The hook receives one JSON object on stdin and answers by exit
code plus optional JSON on stdout.

Two small `packages/nax-agent` additions make this possible:

1. `BeforeTurnPatch` gains `block` and `promptContext`. A `block` patch makes
   `runNativeTurn` throw before it appends anything to the transcript or makes
   a provider request; chat already renders a turn that throws as an error
   line `CODE: message` (`applyTurnEnd` in
   `packages/nax/src/tui/chat/transcript-model.ts`), and a run treats it as a
   failed turn. `promptContext` is prefixed to the prompt message: the
   existing `seed` patch cannot be used for context because it REPLACES the
   prompt message and drops its images (`beforeTurnSeed` in `turn-loop.ts`).
2. `LoopHandlerEntry` gains an optional `timeoutMs` that `wrapExternalHandler`
   uses instead of `LOOP_HANDLER_TIMEOUT_MS` (10 s). A formatter or type check
   after an edit routinely needs longer; plugin handlers that do not set it
   keep 10 s.

**Trust.** A project `.nax/hooks.json` is repository-controlled code. `nax
chat` refuses an untrusted project at its entry (`ensureProjectTrusted` in
`packages/nax/src/cli/chat.ts`), but `nax run` has no entry gate: each
repository-controlled execution site asserts trust itself, e.g. `fireHook`
calls `assertTrusted(workdir, "hooks")` before every project lifecycle hook
(`packages/nax/src/hooks/runner.ts`). Agent hooks follow the same per-site
rule: before spawning an entry with `origin: "project"`, `runAgentHook` calls
`assertTrusted(cwd, "agent-hooks")` (new `TrustSurface` member
`"agent-hooks"` in `packages/nax/src/trust/types.ts`); a refusal becomes a
hook error and nothing is spawned, so a project `PreToolUse` hook in an
untrusted project fails closed. Global entries are exempt, as in `fireHook`.

**Environment and output.** The hook process gets the same allowed environment
the lifecycle hooks get (`buildAllowedEnv`, as `executeHook` does). Hook
output is not size-capped (see Out of Scope).

**Constants by ruling.** The entry default `30000` ms and the three
`AGENT_HOOK_*` constants are constants by ruling, not `NaxConfig` keys, for
the same reason `LOOP_HANDLER_TIMEOUT_MS` is: they bound liveness rather than
being per-project policy; a user tunes a hook through its own `timeout`.

**Subagents.** Chat subagents inherit `ChatHost.loopHandlers`, so chat-scoped
agent hooks also run inside chat subagent turns.

**Complexity.** `runNativeTurn` is not in the nax-agent complexity baseline, so
the `block` check and the `promptContext` prefix live in helpers (for example
by extending `beforeTurnSeed`), not as new branches in `runNativeTurn`.

### File Format

`hooks.json` (global `~/.nax/hooks.json` via `globalConfigDir()`, project
`<repoRoot>/.nax/hooks.json`). The lifecycle `hooks` map is unchanged; the new
`agent` key holds arrays of entries per event:

```json
{
  "skipGlobal": false,
  "hooks": { "on-complete": { "command": "notify-send done" } },
  "agent": {
    "PreToolUse": [
      { "matcher": "Bash", "command": "~/.nax/hooks/block-git-push.sh", "scope": ["chat"] }
    ],
    "PostToolUse": [
      { "matcher": "Write|Edit", "command": "~/.nax/hooks/format.sh", "timeout": 30000 }
    ],
    "UserPromptSubmit": [{ "command": "~/.nax/hooks/prompt-guard.sh" }],
    "SessionStart": [{ "command": "~/.nax/hooks/session-context.sh", "scope": ["chat"] }],
    "Stop": [{ "command": "~/.nax/hooks/tests-green.sh", "scope": ["run"], "enabled": false }]
  }
}
```

Entry fields:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `command` | non-empty string | required | command line, argv-spawned |
| `matcher` | string | absent = every tool | `"*"` means every tool (checked before any compile); any other value is a regular expression that must match the WHOLE tool name: at load both the raw value and its wrapped form `^(?:matcher)$` must compile, else the entry is skipped. Read for `PreToolUse` and `PostToolUse` only |
| `scope` | non-empty array of `"chat"` / `"run"` | `["chat", "run"]` | surfaces the entry runs on |
| `timeout` | integer ms, 1..600000 | 30000 | per-hook deadline |
| `enabled` | boolean | true | `false` drops the entry at load |

`skipGlobal: true` in the project file skips the global file's `agent` section
exactly as it already skips its lifecycle `hooks`. Global entries run before
project entries.

stdin JSON (every event): `hook_event_name`, `session_id` (the context's
`sessionName`), `cwd`, `surface` (`"chat"` | `"run"`), and, when the context
has them, `role`, `feature`, `story_id`, `model`. Per event:

- `PreToolUse`: `tool_name`, `tool_input` (the input as rewritten by earlier
  hooks in the same chain).
- `PostToolUse`: `tool_name`, `tool_input`, `tool_response` =
  `{ "content": string, "is_error": boolean }` (`is_error` is `false` when the
  payload's `isError` is absent). `tool_input` is the input the agent-hooks
  `before_tool` handler recorded for that call: the call's input after this
  handler's own `updatedInput` rewrites (a later plugin's rewrite is not
  seen). The record is keyed by the context's `sessionName` plus the call id,
  is written only when at least one `PostToolUse` entry matches the tool name,
  and is deleted on every `after_tool` dispatch for that key, whether or not a
  hook runs. `tool_input` is omitted when the payload has no `callId` or
  nothing was recorded. (A blocked call never reaches `after_tool`; its record
  stays until the factory is dropped at the end of the chat or run.)
- `UserPromptSubmit`: `prompt`.
- `SessionStart`: no extra field.
- `Stop`: `stop_hook_active` (true when `followUpsSoFar > 0`, i.e. from the
  second `Stop` run of a turn on). The loop's existing cap
  (`MAX_FOLLOW_UPS_PER_TURN = 3`) still applies: a hook that always blocks
  makes the agent continue at most 3 times per turn.

Exit codes: `0` = success; `2` = block, reason = trimmed stderr; any other
code, a timeout, a spawn failure or a lint rejection = hook error.

Optional stdout JSON on exit 0 (a stdout that is not a JSON object is plain
text):

| Event | Fields read |
|---|---|
| `PreToolUse` | `decision` (`"block"`), `reason`, `updatedInput` (object), `additionalContext` |
| `PostToolUse` | `decision` (`"block"`), `reason`, `additionalContext` |
| `UserPromptSubmit` | `decision` (`"block"`), `reason`, `additionalContext` |
| `SessionStart` | `additionalContext` |
| `Stop` | `decision` (`"block"`), `reason` |

For `UserPromptSubmit` and `SessionStart` a plain-text stdout on exit 0 is
context.

### Integration

Read-only (verified 2026-11-01):

- `parseCommandToArgv(command: string): string[]` — `packages/nax/src/utils/command-argv.ts`.
- `validateHookCommand(command: string): void` (throws `NaxError` code `HOOK_DANGEROUS_PATTERN`, exported) and the spawn/kill pattern of `executeHook` (`Bun.spawn` with `detached: true`, SIGTERM then SIGKILL after a grace period, stream capture with a drain bound) — `packages/nax/src/hooks/runner.ts`. `killProcessGroup` is imported there from `@nathapp/nax-agent/internal`, and `run-hook.ts` imports it the same way; `captureStream`, `waitForDrain` and `HOOK_KILL_GRACE_MS` are module-private and `runner.ts` is out of scope, so `run-hook.ts` MIRRORS those with its own private helpers.
- `assertTrusted(path: string, surface: TrustSurface): Promise<void>` — `packages/nax/src/trust/registry.ts` (rejects with `NaxError` code `PROJECT_UNTRUSTED`); `TrustSurface` — `packages/nax/src/trust/types.ts` (gains `"agent-hooks"`).
- `loadHooksConfig(projectDir: string, globalDir?: string)` — `packages/nax/src/hooks/runner.ts`; the precedent for reading `<dir>/hooks.json` and `skipGlobal`. It casts the file without a schema; it is not changed.
- `globalConfigDir(): string` — `packages/nax/src/config/paths/index.ts` (honours the test override env var).
- `LoopHandlerContext` (`sessionName`, `role?`, `storyId?`, `feature?`, `workdir?`, `model?`, `provider?`), `ExternalHandlerOf<E>`, `LoopHandlerSet`, `BeforeToolPayload` (`call: ToolCall { id, name, input }`, `tools`), `BeforeToolOutcome`, `AfterToolPayload` (`content`, `isError?`, `toolName?`, `callId?`), `AfterToolPatch`, `BeforeTurnPayload` (`prompt`, `history`, `sessionName`, `boundary`), `BeforeTurnEndPayload` (`ended`, `stopped`, `followUpsSoFar`, ...), `BeforeTurnEndPatch` (`followUp?`) — `packages/nax-agent/src/native/session/loop-events/types.ts`, exported from `@nathapp/nax-agent`.
- `createRuleDeliveryHandlers` appended to plugin handlers — the precedent at both wiring sites: `packages/nax/src/chat/chat-host.ts` constructor and `withRuleDeliveryHandlers` in `packages/nax/src/execution/lifecycle/run-rules-setup.ts`.
- `ensureProjectTrusted` — called in `chatCommand` (`packages/nax/src/cli/chat.ts`) before `composeChat`.

Changed symbols — the baseline exists only to locate the code; it is never the
interface to implement:

- `BeforeTurnPatch` (`loop-events/types.ts`)
  - Baseline: `{ readonly seed?: readonly NativeTranscriptMessage[]; readonly history?: readonly NativeTranscriptMessage[] }`
  - Target: `{ readonly seed?: ...; readonly history?: ...; readonly block?: { readonly reason: string }; readonly promptContext?: string }`
- `PATCHABLE_FIELDS.before_turn` (`loop-events/registry.ts`)
  - Baseline: `["seed", "history"]`
  - Target: `["seed", "history", "block", "promptContext"]`
- `LoopHandlerEntry` (`loop-events/types.ts`)
  - Baseline: `{ readonly plugin: string; readonly event: LoopEvent; readonly handler: ExternalHandlerOf<LoopEvent> }`
  - Target: the same plus `readonly timeoutMs?: number`
- `runNativeTurn` (`native/session/turn-loop.ts`) — after the `before_turn` dispatch: a patch with `block` throws `NaxError` code `NATIVE_TURN_BLOCKED` (message = the reason, context `{ stage: "native-session", sessionName }`) before `messages.push(...)`; a patch with a non-empty `promptContext` prefixes `promptContext + "\n\n"` to the content of the first message `beforeTurnSeed` returns.
- `raceSettlement` in `wrapExternalHandler` (`loop-events/external-handler.ts`) — deadline = `entry.timeoutMs` when it is a finite positive number, else `_externalHandlerDeps.timeoutMs`.
- `chatResources` (`packages/nax/src/cli/chat.ts`)
  - Baseline: `pluginHandlers: registry.getLoopHandlers()`
  - Target: `pluginHandlers: [...registry.getLoopHandlers(), ...(await deps.loadAgentHookHandlers({ surface: "chat", repoRoot }))]`, with `loadAgentHookHandlers` added to `_chatCommandDeps`.
- `configureRunRules` (`packages/nax/src/execution/lifecycle/run-rules-setup.ts`)
  - Baseline: `configureRunRules(input: { config; workdir; pluginHandlers }): Promise<LoopHandlerSet>` returning `withRuleDeliveryHandlers(...)`
  - Target: input gains optional `agentHooks?: "run"`. When it is `"run"`, `hooks = await _runRulesSetupDeps.loadAgentHookHandlers({ surface: "run", repoRoot: input.workdir })` and `withRuleDeliveryHandlers` receives `hooks.length > 0 ? [...input.pluginHandlers, ...hooks] : input.pluginHandlers`, so rule delivery stays last. When `agentHooks` is absent the loader is not called. With no hooks the result is exactly today's (identity tests in `run-rules-setup.test.ts` and `run-rules-setup-delivery.test.ts` stay green). `loadAgentHookHandlers` is added to `_runRulesSetupDeps`.
- `initializeAfterLock` (`packages/nax/src/execution/lifecycle/run-setup-init.ts`)
  - Baseline: `configureRunRules({ config, workdir, pluginHandlers: pluginRegistry.getLoopHandlers() })`
  - Target: the same call plus `agentHooks: "run"`.

New module `packages/nax/src/hooks/agent/` (barrel `index.ts`, re-exported
from `packages/nax/src/hooks/index.ts`):

```ts
// types.ts
export const AGENT_HOOK_EVENTS = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "SessionStart", "Stop"] as const;
export type AgentHookEvent = (typeof AGENT_HOOK_EVENTS)[number];
export type AgentHookSurface = "chat" | "run";
export interface AgentHookEntry {
  readonly command: string;
  readonly matcher?: string;
  readonly scope: readonly AgentHookSurface[];
  readonly timeoutMs: number;
  readonly origin: "global" | "project";
}
export type AgentHooksConfig = { readonly [E in AgentHookEvent]: readonly AgentHookEntry[] };
export type AgentHookRun =
  | { readonly kind: "ok"; readonly stdout: string; readonly json?: Readonly<Record<string, unknown>> }
  | { readonly kind: "block"; readonly reason: string }
  | { readonly kind: "error"; readonly reason: string };

// config.ts
export function loadAgentHooksConfig(projectNaxDir: string, globalDir?: string): Promise<AgentHooksConfig>;

// run-hook.ts
export const AGENT_HOOK_KILL_GRACE_MS = 5000;
export const AGENT_HOOK_DRAIN_MS = 2000;
export const AGENT_HOOK_HANDLER_MARGIN_MS = 1000;
export const _runAgentHookDeps: {
  killGraceMs: number; // default AGENT_HOOK_KILL_GRACE_MS, read at call time
  drainMs: number; // default AGENT_HOOK_DRAIN_MS, read at call time
  assertTrusted: typeof assertTrusted;
};
export function runAgentHook(input: {
  readonly entry: AgentHookEntry;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly cwd: string;
}): Promise<AgentHookRun>;

// handlers.ts
export const AGENT_HOOKS_PLUGIN = "agent-hooks";
export const _agentHookHandlerDeps: { runAgentHook: typeof runAgentHook };
export function createAgentHookHandlers(input: {
  readonly config: AgentHooksConfig;
  readonly surface: AgentHookSurface;
  readonly repoRoot: string;
}): LoopHandlerSet;

// load.ts
export const _loadAgentHookDeps: { loadAgentHooksConfig: typeof loadAgentHooksConfig; globalDir: () => string };
export function loadAgentHookHandlers(input: {
  readonly surface: AgentHookSurface;
  readonly repoRoot: string;
}): Promise<LoopHandlerSet>;
```

`loadAgentHookHandlers` reads `<repoRoot>/.nax` and `globalConfigDir()`
through `_loadAgentHookDeps` and returns `createAgentHookHandlers(...)`. It
never rejects: an unexpected throw from loading yields an empty set and one
`agent-hooks` warning, so a broken `hooks.json` never stops chat or a run.

`loadAgentHooksConfig` reads each file with `Bun.file(...).text()` and
`JSON.parse` inside its own try/catch, not `loadJsonFile` (which would log a
second warning under the `hooks` stage).

Barrel: each story adds its new module's exports to
`packages/nax/src/hooks/agent/index.ts` (created by US-002), and
`packages/nax/src/hooks/index.ts` re-exports them; `cli/chat.ts` and
`run-rules-setup.ts` import from `@/hooks`, never from an internal file.

### Failure Handling

| Situation | Behaviour |
|---|---|
| `hooks.json` missing, or no `agent` key | no agent hooks from that file; no warning |
| `hooks.json` is not valid JSON, or its top-level value is not an object | that file contributes no agent hooks; one `agent-hooks` warning naming the path |
| `agent` is not an object | that file contributes no agent hooks; one warning naming the path |
| unknown event key under `agent` | key ignored; one warning naming the key and path |
| an entry fails validation (missing `command`, bad `scope`, `timeout` out of range, `matcher` not a valid regular expression) | entry skipped; one warning naming the event, index and origin; other entries still load |
| hook exits 2 | block: `PreToolUse` blocks the call, `PostToolUse` appends feedback, `UserPromptSubmit` blocks the prompt, `Stop` makes the agent continue, `SessionStart` ignores it with a warning |
| hook exits non-0/non-2, times out, fails to spawn, its command is rejected by `validateHookCommand`, or it is a project entry and `assertTrusted` refuses the project | hook error: `PreToolUse` blocks the call (fail closed); `UserPromptSubmit` blocks the prompt on `chat` and is let through with a warning on `run`; `PostToolUse`, `SessionStart`, `Stop` log a warning and change nothing |
| hook times out | its process group is killed (SIGTERM, then SIGKILL after the grace period) |
| loading the hooks config throws unexpectedly | `loadAgentHookHandlers` returns an empty set and logs one warning |
| the factory handler itself does not settle within its `timeoutMs` (unreachable while every hook honours its own deadline, see Deadline) | existing wrapper behaviour: `before_tool` fails closed to block, other events change nothing |

Every hook execution logs one `agent-hooks` debug line with the event,
command, outcome kind and duration in ms.

## Out of Scope

- Executing Claude Code's own hooks (`~/.claude/settings.json`, plugin `hooks.json`) or package-declared hooks listed by `packages/nax/src/resources/parse-hooks.ts`; the chat notice that they are not executed stays.
- Agent hooks for ACP brains (Claude Code, Codex, Cursor as the chat agent); they run their own hooks and loop handlers reach only the native agent.
- An `ask` decision that pauses and asks the human from a hook.
- Shell hooks on the other loop events (`transform_context`, `before_request`, `after_response`, `before_compaction`).
- Any change to the run lifecycle hooks (`on-*` events), `loadHooksConfig`, `executeHook` or `fireHook`.
- Concatenating `before_turn` `seed` or `promptContext` patches across several handlers; `dispatchChain` keeps overwrite semantics, so a later plugin handler returning `promptContext` replaces the agent hooks' value.
- Killing a running hook when the turn is aborted: `LoopHandlerContext` carries no abort signal by design, so a hook runs until it exits or reaches its own `timeout`.
- Agent hooks in `nax bot review` / `nax bot fix`: the bot's `configureRunRules` call does not pass `agentHooks`, so a PR worktree's `.nax/hooks.json` is never executed.
- Merging a hook's `PreToolUse` nudge with rule delivery's nudge for the same call; the later handler's nudge wins (rule delivery, on both surfaces).
- A size cap on hook stdout, stderr or context injected into the prompt or a tool result.
- Removing the `tool_input` record of a call that a later handler blocked; it lives until the chat or run ends.
- Reloading `hooks.json` during a chat or run; the config is read once when the surface starts.
- Pipeline-mode-specific wiring; `initializeAfterLock` is the shared run setup.
- A user guide page; documentation follows separately.

## Stories

**US-001: Blocking a turn, prompt context and per-handler deadlines in the native loop.** No dependencies. Workdir: `packages/nax-agent`. `BeforeTurnPatch` gains `block` and `promptContext`, both listed in `PATCHABLE_FIELDS.before_turn`; `runNativeTurn` throws `NATIVE_TURN_BLOCKED` on a `block` patch before writing the transcript or calling the provider, and prefixes a non-empty `promptContext` to the first seed message while keeping its images. `LoopHandlerEntry` gains an optional `timeoutMs` that `wrapExternalHandler` uses as the handler's deadline when it is a finite positive number.

**US-002: Loading the agent hooks config.** No dependencies. Workdir: `packages/nax`. Creates `packages/nax/src/hooks/agent/` with `types.ts` (`AGENT_HOOK_EVENTS`, `AgentHookEvent`, `AgentHookSurface`, `AgentHookEntry`, `AgentHooksConfig`, `AgentHookRun`), `config.ts` (`loadAgentHooksConfig` with a zod schema for one entry, reading each file with `Bun.file(...).text()` and `JSON.parse`, not `loadJsonFile`) and the `index.ts` barrel; `packages/nax/src/hooks/index.ts` re-exports the barrel.

**US-003: Running one agent hook.** Depends on US-002. Workdir: `packages/nax`. Creates `run-hook.ts` with `runAgentHook`, `_runAgentHookDeps` and the `AGENT_HOOK_KILL_GRACE_MS`, `AGENT_HOOK_DRAIN_MS` and `AGENT_HOOK_HANDLER_MARGIN_MS` constants: the trust check for project entries, argv spawn with the payload JSON on stdin and the allowed environment, cwd, deadline with process-group kill and SIGKILL escalation, a stream drain bound, exit-code mapping to `AgentHookRun`, stdout JSON parsing and one debug log line per run. It imports `killProcessGroup` from `@nathapp/nax-agent/internal`, mirrors the rest of `packages/nax/src/hooks/runner.ts`'s spawn pattern with private helpers, and does not edit `runner.ts`. Adds `"agent-hooks"` to `TrustSurface` in `packages/nax/src/trust/types.ts` and its exports to the `hooks/agent` barrel.

**US-004: Tool hooks.** Depends on US-001, US-003. Workdir: `packages/nax`. Creates `handlers.ts` with `AGENT_HOOKS_PLUGIN`, `_agentHookHandlerDeps` and `createAgentHookHandlers`, covering scope filtering, the one-handler-per-event rule with its `timeoutMs` formula, and the `PreToolUse` (`before_tool`) and `PostToolUse` (`after_tool`) handlers with the call-input record they share. Adds its exports to the `hooks/agent` barrel. Turn events are added by US-005.

**US-005: Prompt, session-start and stop hooks.** Depends on US-004. Workdir: `packages/nax`. `createAgentHookHandlers` adds the `before_turn` handler (`SessionStart` then `UserPromptSubmit`, producing `promptContext` or `block`) and the `before_turn_end` handler (`Stop`, producing `followUp`), each with its `timeoutMs` from the same formula.

**US-006: Hooks in chat.** Depends on US-005. Workdir: `packages/nax`. Creates `load.ts` with `loadAgentHookHandlers` and `_loadAgentHookDeps` and adds them to the `hooks/agent` barrel; `chatResources` in `packages/nax/src/cli/chat.ts` appends `loadAgentHookHandlers({ surface: "chat", repoRoot })` to `pluginHandlers` through a new `_chatCommandDeps.loadAgentHookHandlers`, imported from `@/hooks`.

**US-007: Hooks in run, never in bot.** Depends on US-006. Workdir: `packages/nax`. `configureRunRules` gains the optional `agentHooks: "run"` input and `_runRulesSetupDeps.loadAgentHookHandlers`; with it, the agent-hook set is appended to the plugin handlers BEFORE rule delivery is added, and an empty hook set or an absent `agentHooks` leaves the result exactly as today. `initializeAfterLock` passes `agentHooks: "run"`; the bot's call in `packages/nax/src/bot/run-setup.ts` is unchanged.

### Context Files

**US-001**
- `packages/nax-agent/src/native/session/loop-events/types.ts`
- `packages/nax-agent/src/native/session/loop-events/registry.ts`
- `packages/nax-agent/src/native/session/turn-loop.ts`
- `packages/nax-agent/src/native/session/loop-events/external-handler.ts`
- `packages/nax-agent/test/unit/native/session/turn-loop-transcript-identity.test.ts`

**US-002**
- `packages/nax/src/hooks/runner.ts`
- `packages/nax/src/hooks/types.ts`
- `packages/nax/src/hooks/index.ts`
- `packages/nax/src/config/schemas-infra.ts`
- `packages/nax/test/unit/hooks/runner-validation.test.ts`

**US-003**
- `packages/nax/src/hooks/runner.ts`
- `packages/nax/src/utils/command-argv.ts`
- `packages/nax/src/hooks/agent/types.ts` — created by US-002
- `packages/nax/src/hooks/agent/index.ts` — created by US-002, extended here
- `packages/nax/src/trust/types.ts`

**US-004**
- `packages/nax/src/hooks/agent/run-hook.ts` — created by US-003
- `packages/nax/src/hooks/agent/index.ts` — created by US-002, extended here
- `packages/nax-agent/src/native/session/loop-events/types.ts`
- `packages/nax-agent/src/native/session/loop-events/registry.ts`
- `packages/nax/src/context/rules/rule-delivery/index.ts`

**US-005**
- `packages/nax/src/hooks/agent/handlers.ts` — created by US-004, extended here
- `packages/nax/src/hooks/agent/run-hook.ts` — created by US-003
- `packages/nax/test/unit/hooks/agent/handlers.test.ts` — created by US-004
- `packages/nax-agent/src/native/session/loop-events/types.ts`

**US-006**
- `packages/nax/src/cli/chat.ts`
- `packages/nax/test/unit/cli/chat-resources.test.ts`
- `packages/nax/src/hooks/agent/index.ts` — created by US-002, extended here
- `packages/nax/src/hooks/agent/handlers.ts` — created by US-004, completed by US-005
- `packages/nax/src/hooks/index.ts`

**US-007**
- `packages/nax/src/execution/lifecycle/run-rules-setup.ts`
- `packages/nax/src/execution/lifecycle/run-setup-init.ts`
- `packages/nax/test/unit/execution/lifecycle/run-rules-setup.test.ts`
- `packages/nax/test/unit/execution/lifecycle/run-setup-init.test.ts`
- `packages/nax/src/hooks/agent/load.ts` — created by US-006

### Creates

**US-001**
- `packages/nax-agent/test/unit/native/session/loop-events/before-turn-block.test.ts`
- `packages/nax-agent/test/unit/native/session/loop-events/external-handler-timeout.test.ts`

**US-002**
- `packages/nax/src/hooks/agent/types.ts`
- `packages/nax/src/hooks/agent/config.ts`
- `packages/nax/src/hooks/agent/index.ts`
- `packages/nax/test/unit/hooks/agent/config.test.ts`

**US-003**
- `packages/nax/src/hooks/agent/run-hook.ts`
- `packages/nax/test/unit/hooks/agent/run-hook.test.ts`

**US-004**
- `packages/nax/src/hooks/agent/handlers.ts`
- `packages/nax/test/unit/hooks/agent/handlers.test.ts`

**US-005**
- `packages/nax/test/unit/hooks/agent/turn-handlers.test.ts`

**US-006**
- `packages/nax/src/hooks/agent/load.ts`
- `packages/nax/test/unit/hooks/agent/load.test.ts`

**US-007**
- `packages/nax/test/unit/execution/lifecycle/run-rules-setup-agent-hooks.test.ts`

### Modifies

None. No existing test pins a shape these stories change: the loop-event names are unchanged (`types.test.ts` lists events, not patch fields); `external-handler.test.ts` sets `_externalHandlerDeps.timeoutMs` on entries without `timeoutMs`, whose behaviour is unchanged; the identity assertions in `run-rules-setup.test.ts` (`toBe(PLUGIN_HANDLERS)`) and `run-rules-setup-delivery.test.ts` (`toBe(result.pluginRegistry.getLoopHandlers())`) call `configureRunRules` without `agentHooks`, which US-007 requires to return the same set by identity; `run-setup-init.test.ts` asserts entries after the plugin set are rule-delivery entries, which still holds because tests resolve `globalConfigDir()` to an isolated directory (`test/preload.ts`) and the fixture repo has no `hooks.json`, so the hook set is empty and the identity rule applies.

### Seams

- `BeforeTurnPatch.block` and `promptContext` (US-001) are produced by the agent-hooks `before_turn` handler (US-005); US-001's ACs drive `runNativeTurn` with a registered `before_turn` handler returning those fields, and US-005's ACs assert the handler returns them.
- `LoopHandlerEntry.timeoutMs` (US-001) is set by `createAgentHookHandlers` (US-004); US-004 AC asserts the value, US-001 ACs assert `wrapExternalHandler` honours it.
- `runAgentHook` (US-003) is called by every handler `createAgentHookHandlers` builds (US-004, US-005) through `_agentHookHandlerDeps.runAgentHook`; their ACs stub it and assert the captured `entry`, `payload` and `cwd`.
- `loadAgentHookHandlers` (US-006) is reached from `chatCommand` (through `chatResources`, US-006) and from `initializeAfterLock` (through `configureRunRules`, US-007); each story's seam AC stubs it and triggers that entry point.

## Acceptance Criteria

### US-001

1. [unit] `runNativeTurn` with a registered `before_turn` handler returning `{ block: { reason: "no secrets in prompts" } }` rejects with a `NaxError` whose `code` is `NATIVE_TURN_BLOCKED` and whose `message` is `no secrets in prompts`.
2. [unit] In that blocked `runNativeTurn`, the fake provider `complete` dependency is never called.
3. [unit] After that blocked `runNativeTurn` on a session seeded with one prior exchange, the session's transcript holds exactly the prior exchange's messages: the blocked prompt is not persisted.
4. [unit] `runNativeTurn` with prompt `fix it` and a `before_turn` handler returning `{ promptContext: "branch: main" }` sends the provider a final user message whose content is `branch: main\n\nfix it`.
5. [unit] `runNativeTurn` with prompt `look`, one image attachment in `opts.images` and a `before_turn` handler returning `{ promptContext: "ctx" }` sends a final user message with content `ctx\n\nlook` that still carries that image.
6. [unit] `runNativeTurn` with a `before_turn` handler returning `{ promptContext: "" }` sends the prompt message content unchanged.
7. [unit] `runNativeTurn` with a `before_turn` handler returning both `{ seed: [{ role: "user", content: "seeded" }], promptContext: "ctx" }` sends a user message whose content is `ctx\n\nseeded`.
8. [unit] `runNativeTurn` with a `before_turn` handler returning both `block` and `promptContext` rejects with `NATIVE_TURN_BLOCKED`: `block` wins.
9. [unit] A `before_turn` handler returning `{ seed: [...], history: [...], block: {...}, promptContext: "x" }` passes all four fields through `createLoopEventRegistry().dispatch("before_turn", ...)`.
10. [unit] `wrapExternalHandler` for an entry with `timeoutMs: 50` whose handler never settles answers a `before_tool` dispatch with a `block` outcome after the 50 ms deadline, while `_externalHandlerDeps.timeoutMs` is set to 10000.
11. [unit] `wrapExternalHandler` for an entry with `timeoutMs: 5000` whose `before_tool` handler settles `{ kind: "allow" }` after 100 ms answers `allow`, while `_externalHandlerDeps.timeoutMs` is set to 20: the entry's deadline replaces the default.
12. [unit] `wrapExternalHandler` for an entry with no `timeoutMs` whose handler never settles answers `block` once `_externalHandlerDeps.timeoutMs` (set to 30) elapses.
13. [unit] `wrapExternalHandler` for an entry with `timeoutMs: 0`, and for one with `timeoutMs: Infinity`, whose handler never settles answers `block` once `_externalHandlerDeps.timeoutMs` (set to 30) elapses: only a finite positive `timeoutMs` replaces the default.

### US-002

1. [unit] `AGENT_HOOK_EVENTS` imported from `@/hooks` equals `["PreToolUse", "PostToolUse", "UserPromptSubmit", "SessionStart", "Stop"]`.
2. [unit] `loadAgentHooksConfig(projectDir, globalDir)` with no `hooks.json` in either directory resolves to an object holding an empty array for each of the five events, and logs no warning.
3. [unit] A project `hooks.json` of `{ "hooks": {} }` (no `agent` key) yields empty arrays for all five events.
4. [unit] A project `hooks.json` with `agent.PreToolUse` = `[{ "command": "guard.sh" }]` yields one `PreToolUse` entry `{ command: "guard.sh", scope: ["chat", "run"], timeoutMs: 30000, origin: "project" }` with `matcher` absent.
5. [unit] An entry `{ "command": "a.sh", "matcher": "Bash", "scope": ["run"], "timeout": 1500 }` loads as `matcher: "Bash"`, `scope: ["run"]`, `timeoutMs: 1500`.
6. [unit] An entry with `"matcher": "*"` loads with `matcher: "*"`.
7. [unit] An entry with `"enabled": false` is not in the result.
8. [unit] With global `agent.Stop` = `[{ "command": "g.sh" }]` and project `agent.Stop` = `[{ "command": "p.sh" }]`, the `Stop` array is `g.sh` (origin `global`) then `p.sh` (origin `project`).
9. [unit] With a project file holding `"skipGlobal": true`, the global file's `agent` entries are absent from the result.
10. [unit] A `hooks.json` with only an `agent` key and no `hooks` key loads its agent entries.
11. [unit] An entry missing `command` is skipped, the other entries of that event still load, and one warning on the `agent-hooks` logger stage names the event, the entry's index and its origin.
12. [unit] An entry with `"timeout": 600001` is skipped with one warning; an entry with `"timeout": 600000` loads.
13. [unit] An entry with `"scope": []` is skipped with one warning; an entry with `"scope": ["chat", "bogus"]` is skipped with one warning.
14. [unit] An entry with `"matcher": "("` (not a valid regular expression in its wrapped form `^(?:()$`) is skipped with one warning.
15. [unit] An entry with `"matcher": "a)|(b"` (whose raw form does not compile) is skipped with one warning.
16. [unit] An `agent` key named `PreTool` (unknown event) is ignored with one warning naming `PreTool`, and the known events still load.
17. [unit] A project `hooks.json` whose content is not valid JSON contributes no agent hooks and logs exactly one warning in total, on the `agent-hooks` stage, naming its path, while the global file's agent entries still load.
18. [unit] A project `hooks.json` whose top-level value is `[]` contributes no agent hooks and logs one warning naming its path.
19. [unit] A project `hooks.json` whose `agent` value is an array contributes no agent hooks and logs one warning naming its path.

### US-003

1. [integration] `runAgentHook` with an entry whose command is a script that copies stdin to a file passes `JSON.stringify(payload)` on stdin: the file content parses to the given payload.
2. [integration] `runAgentHook` with a script that prints its working directory runs it in the given `cwd`: the result is `{ kind: "ok" }` with `stdout` whose real path equals the real path of that directory.
3. [integration] A script that exits 0 printing `  hello  ` returns `{ kind: "ok", stdout: "hello" }` with no `json`.
4. [integration] A script that exits 0 printing `{"decision":"block","reason":"r"}` returns `kind: "ok"` with `json` equal to `{ decision: "block", reason: "r" }`.
5. [integration] A script that exits 0 printing `[1,2]` returns `kind: "ok"` with no `json`: only a JSON object is parsed.
6. [integration] A script that exits 2 writing `not allowed` to stderr returns `{ kind: "block", reason: "not allowed" }`.
7. [integration] A script that exits 2 with empty stderr returns `kind: "block"` with a `reason` that names the entry's command.
8. [integration] A script that exits 1 writing `boom` to stderr returns `kind: "error"` with a `reason` naming the command, the exit code `1` and `boom`.
9. [integration] A script that sleeps 5 s, run with `timeoutMs: 100`, resolves in under 2 s to `kind: "error"` with a `reason` holding `timed out after 100ms`, and its process no longer exists afterwards.
10. [unit] `AGENT_HOOK_KILL_GRACE_MS`, `AGENT_HOOK_DRAIN_MS` and `AGENT_HOOK_HANDLER_MARGIN_MS` imported from `@/hooks` equal 5000, 2000 and 1000.
11. [unit] An entry whose command is `eval rm` returns `kind: "error"` naming the rejected pattern without spawning a process.
12. [integration] An entry whose command names an executable that does not exist returns `kind: "error"` and does not reject.
13. [unit] An entry whose command is only whitespace returns `kind: "error"` with reason `empty command`.
14. [integration] An entry whose command is `<script> 'a b' c` runs the script with exactly two arguments, `a b` and `c`: the command is split into argv without a shell.
15. [integration] A script that traps SIGTERM and keeps sleeping, run with `timeoutMs: 100` and `_runAgentHookDeps.killGraceMs` set to 200, resolves in under 2 s to `kind: "error"` holding `timed out after 100ms`, and its process no longer exists afterwards.
16. [integration] A script that prints `partial`, starts a background child that keeps stdout open for 10 s and exits 0, run with `_runAgentHookDeps.drainMs` set to 200, resolves in under 2 s to `{ kind: "ok", stdout: "partial" }`.
17. [unit] A project entry (`origin: "project"`) with `_runAgentHookDeps.assertTrusted` stubbed to reject with a `NaxError` of code `PROJECT_UNTRUSTED` returns `kind: "error"` whose `reason` mentions trust, and no process is spawned; the stub was called with the `cwd` and `"agent-hooks"`.
18. [unit] A global entry (`origin: "global"`) never calls `_runAgentHookDeps.assertTrusted`.
19. [integration] Each `runAgentHook` call logs one debug line on the `agent-hooks` logger stage whose data holds the payload's `hook_event_name`, the `command`, the result `kind` and a numeric `durationMs`.

### US-004

1. [unit] `createAgentHookHandlers` with every event empty returns an empty set.
2. [unit] With one `PreToolUse` entry scoped `["run"]` and surface `chat`, `createAgentHookHandlers` returns no `before_tool` entry.
3. [unit] With two `PreToolUse` entries scoped to both surfaces with `timeoutMs` 2000 and 3000 and surface `run`, `createAgentHookHandlers` returns exactly one `before_tool` entry whose `plugin` is `agent-hooks` and whose `timeoutMs` is 20000 (`1000 + (2000 + 5000 + 2000) + (3000 + 5000 + 2000)`).
4. [unit] With only one `PostToolUse` entry of `timeoutMs` 4000, the set holds one `after_tool` entry with `timeoutMs` 12000 and one `before_tool` entry (it records call inputs for `tool_input`) with `timeoutMs` 1000.
5. [unit] The `before_tool` handler, for an entry with `matcher: "Bash"`, calls the stubbed `_agentHookHandlerDeps.runAgentHook` for a call named `Bash` and not for a call named `BashOutput`: the match is anchored to the whole name.
6. [unit] An entry with `matcher: "Write|Edit"` runs for calls named `Write` and `Edit`; entries with `matcher` absent or `"*"` run for every call.
7. [unit] The `before_tool` handler calls `runAgentHook` with a payload holding `hook_event_name: "PreToolUse"`, `session_id` = the context's `sessionName`, `surface`, `cwd`, `tool_name` and `tool_input` = the call's input, plus `role`, `feature`, `story_id` and `model` from the context when present.
8. [unit] The `cwd` passed to `runAgentHook` is the context's `workdir` when present, else the factory's `repoRoot`.
9. [unit] A `PreToolUse` run of `{ kind: "block", reason: "no push" }` makes the handler return `{ kind: "block", content: "Blocked by hook: no push" }`, and a later `PreToolUse` entry is not run.
10. [unit] A `PreToolUse` run of `kind: "ok"` with `json` `{ decision: "block", reason: "r" }` returns `{ kind: "block", content: "Blocked by hook: r" }`.
11. [unit] A `PreToolUse` run of `{ kind: "error", reason: "exited 1" }` returns a `block` outcome with `isError: true` whose `content` names the entry's command and `exited 1`.
12. [unit] With two `PreToolUse` entries where the first answers `json` `{ updatedInput: { command: "ls -la" } }`, the second is called with `tool_input` `{ command: "ls -la" }` and the handler returns `{ kind: "allow", input: { command: "ls -la" } }`.
13. [unit] Two `PreToolUse` entries answering `json` `{ additionalContext: "careful" }` and `{ additionalContext: "really" }` make the handler return `{ kind: "nudge", text: "careful\n\nreally" }`.
14. [unit] One `PreToolUse` entry answering `json` `{ updatedInput: { a: 1 }, additionalContext: "note" }` makes the handler return `{ kind: "nudge", text: "note", input: { a: 1 } }`.
15. [unit] A call that no `PreToolUse` entry matches returns `{ kind: "allow" }` without calling `runAgentHook`.
16. [unit] With a `PreToolUse` entry rewriting the input of call `c1` (named `Write`) to `{ path: "b.ts" }` and a `PostToolUse` entry, the `after_tool` handler for `callId: "c1"` calls `runAgentHook` with `hook_event_name: "PostToolUse"`, `tool_name: "Write"`, `tool_input: { path: "b.ts" }` and `tool_response: { content, is_error: false }` when the payload's `isError` is absent.
17. [unit] A second `after_tool` dispatch for the same session and `callId: "c1"` calls `runAgentHook` with no `tool_input`: the record is deleted once read; an `after_tool` payload without `callId` also gets no `tool_input`.
18. [unit] Calls with the same `callId: "c1"` in two sessions (`sessionName` `s1` and `s2`) with inputs `{ path: "a.ts" }` and `{ path: "b.ts" }` each reach their own session's `PostToolUse` hook with their own `tool_input`.
19. [unit] With a `PostToolUse` entry `matcher: "Write"` only, a `before_tool` call named `Read` with id `c2` writes no record, and an `after_tool` dispatch for `toolName: "Read"`, `callId: "c2"` returns `undefined` without calling `runAgentHook`.
20. [unit] A `PostToolUse` run of `kind: "ok"` with `json` `{ decision: "block" }` (no `reason`) appends `"\n\nHook feedback: blocked by hook '<command>'"` to the content.
21. [unit] A `PreToolUse` run answering `json` `{ updatedInput: "rm -rf" }` (not an object) leaves the input unchanged, returns `{ kind: "allow" }` and logs one warning naming the command.
22. [unit] Two `PostToolUse` entries answering `{ kind: "block", reason: "lint failed" }` and `json` `{ additionalContext: "formatted" }` make the `after_tool` handler return `{ content: <original content> + "\n\nHook feedback: lint failed" + "\n\nHook context: formatted" }`.
23. [unit] A `PostToolUse` run of `kind: "error"` returns no patch (`undefined`) and logs one warning naming the command.
24. [unit] An `after_tool` payload whose `toolName` no `PostToolUse` entry matches returns `undefined` without calling `runAgentHook`.

### US-005

1. [unit] With one `SessionStart` entry of `timeoutMs` 1000 and one `UserPromptSubmit` entry of `timeoutMs` 2000 on surface `chat`, `createAgentHookHandlers` returns exactly one `before_turn` entry with `timeoutMs` 18000 (`1000 + (1000 + 7000) + (2000 + 7000)`).
2. [unit] With one `Stop` entry of `timeoutMs` 3000, `createAgentHookHandlers` returns one `before_turn_end` entry with `timeoutMs` 11000.
3. [unit] The `before_turn` handler for a payload with empty `history` runs the `SessionStart` entry with `hook_event_name: "SessionStart"`, then the `UserPromptSubmit` entry with `hook_event_name: "UserPromptSubmit"` and `prompt` = the payload's prompt, in that order.
4. [unit] The `before_turn` handler for a payload with non-empty `history` does not run the `SessionStart` entry.
5. [unit] A `SessionStart` run of `{ kind: "ok", stdout: "repo: nax" }` and a `UserPromptSubmit` run answering `json` `{ additionalContext: "be brief" }` make the handler return `{ promptContext: "repo: nax\n\nbe brief" }`.
6. [unit] A `UserPromptSubmit` run of `{ kind: "ok", stdout: "today is monday" }` (plain text) makes the handler return `{ promptContext: "today is monday" }`.
7. [unit] A `SessionStart` run of `kind: "ok"` with `json` `{}` and a `UserPromptSubmit` run of `{ kind: "ok", stdout: "" }` make the handler return `undefined`.
8. [unit] A `UserPromptSubmit` run of `{ kind: "block", reason: "contains a key" }` returns `{ block: { reason: "contains a key" } }` with no `promptContext`, and a later `UserPromptSubmit` entry is not run.
9. [unit] A `UserPromptSubmit` run of `kind: "ok"` with `json` `{ decision: "block", reason: "r" }` returns `{ block: { reason: "r" } }`.
10. [unit] On surface `chat`, a `UserPromptSubmit` run of `{ kind: "error", reason: "exited 3" }` returns a `block` whose `reason` names the entry's command and `exited 3`.
11. [unit] On surface `run`, a `UserPromptSubmit` run of `{ kind: "error", reason: "exited 3" }` returns no `block`, the next `UserPromptSubmit` entry still runs, and one warning names the command.
12. [unit] A `SessionStart` run of `kind: "block"` or `kind: "error"` adds no context and no `block`, and logs one warning.
13. [unit] The `before_turn_end` handler for `{ ended: "completed", stopped: false, followUpsSoFar: 0 }` runs the `Stop` entry with `hook_event_name: "Stop"` and `stop_hook_active: false`.
14. [unit] For `followUpsSoFar: 1` the `Stop` payload carries `stop_hook_active: true`.
15. [unit] A `Stop` run of `{ kind: "block", reason: "tests still fail" }` makes the handler return `{ followUp: "tests still fail" }`, and a later `Stop` entry is not run.
16. [unit] A `Stop` run of `kind: "ok"` with `json` `{ decision: "block", reason: "go on" }` returns `{ followUp: "go on" }`.
17. [unit] A `Stop` run of `{ kind: "ok", stdout: "" }` returns `undefined`.
18. [unit] A `Stop` run of `kind: "error"` returns `undefined` and logs one warning naming the command.
19. [unit] The `before_turn_end` handler runs no `Stop` entry for `ended: "aborted"`, for `ended: "errored"`, or for `ended: "completed"` with `stopped: true`.

### US-006

1. [unit] `loadAgentHookHandlers({ surface: "run", repoRoot })` calls the stubbed `_loadAgentHookDeps.loadAgentHooksConfig` with `join(repoRoot, ".nax")` and the stubbed `_loadAgentHookDeps.globalDir()` value.
2. [unit] `loadAgentHookHandlers` given a stubbed config with one `PreToolUse` entry scoped `["run"]` returns one `before_tool` entry for surface `run` and an empty set for surface `chat`.
3. [unit] `loadAgentHookHandlers` whose stubbed `loadAgentHooksConfig` rejects resolves to an empty set and logs one `agent-hooks` warning.
4. [integration] `loadAgentHookHandlers` imported from `@/hooks`, called with `surface: "run"` and a temp repo whose `.nax/hooks.json` holds one `Stop` entry and an empty global directory, returns one `before_turn_end` entry with plugin `agent-hooks`.
5. [integration] `chatCommand` with `_chatCommandDeps.loadAgentHookHandlers` stubbed to return one sentinel entry calls the stub once with `{ surface: "chat", repoRoot }`, and the stubbed `createChatHost` receives resources whose `pluginHandlers` end with that sentinel entry after the plugin registry's entries.
6. [integration] `chatCommand` with `loadAgentHookHandlers` stubbed to return an empty set creates the host with `pluginHandlers` equal to the plugin registry's entries.

### US-007

1. [unit] `configureRunRules` with workflow mode on, `context.rules.delivery` `"index"`, `agentHooks: "run"` and `_runRulesSetupDeps.loadAgentHookHandlers` stubbed to return one sentinel entry calls the stub once with `{ surface: "run", repoRoot: workdir }` and returns plugin handlers, then the sentinel entry, then the rule-delivery entries.
2. [unit] `configureRunRules` with `agentHooks: "run"`, workflow mode off (rule delivery skipped) and the stub returning one sentinel entry returns the plugin handlers followed by the sentinel entry.
3. [unit] `configureRunRules` with `agentHooks: "run"`, rule delivery skipped and the stub returning an empty set returns the plugin handler set itself (the same array by identity).
4. [unit] `configureRunRules` without `agentHooks` never calls `loadAgentHookHandlers` and returns the plugin handler set by identity when rule delivery is skipped.
5. [unit] `configureRunRules` with `agentHooks: "run"` and `context.rules.overrideDir` naming a missing directory rejects with `RULES_OVERRIDE_DIR_NOT_FOUND` without calling `loadAgentHookHandlers`.
6. [integration] `initializeAfterLock` with `_runRulesSetupDeps.loadAgentHookHandlers` stubbed to return one sentinel entry hands `runtime.sessionManager.configureLoopHandlers` a set holding that sentinel right after the plugin registry's entries and before the rule-delivery entries, and the stub was called with `{ surface: "run", repoRoot: workdir }`.
