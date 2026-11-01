# nax agent hooks (Claude-Code-style, nax-owned) — design

Date: 2026-11-01
Status: APPROVED 2026-11-01 (feature `agent-hooks`)

## 1. Intent

Let a user attach their own shell commands to the native agent's turn, the way
Claude Code hooks work: run a guard before a tool call, run a formatter or a
type check after an edit, add context to a prompt, keep the agent going when it
stops too early. These are **nax's own hooks**, configured in nax. nax does not
execute Claude Code's hooks (`~/.claude/settings.json`, plugin `hooks.json`).

Why now: the coding-agent roadmap (nax chat as a full coding agent) listed hooks
as a slice 1 non-goal. Today the only way to influence a tool call is to write
an in-process JavaScript plugin. A shell command in config is the bar Claude
Code users expect.

## 2. What already exists (build on it, do not rebuild)

- **Loop-event chain in the native agent** —
  `packages/nax-agent/src/native/session/loop-events/`. Events used here:
  - `before_tool` -> `allow` (optional input rewrite) / `nudge` / `block` /
    `terminate`.
  - `after_tool` -> patch `content` / `isError` (`denied` not patchable).
  - `before_turn` -> payload `{ prompt, history, sessionName, boundary }`,
    patch `{ seed, history }`. Fires once per turn after the transcript loads
    (`turn-loop.ts:142`).
  - `before_turn_end` -> patch `{ followUp }`, capped at
    `MAX_FOLLOW_UPS_PER_TURN = 3` (`turn-loop-round-trip.ts:62`); not offered
    when the turn ended by a stop.
- **Plugin-contributed handlers** — a plugin with `provides: ["loop-handlers"]`
  supplies `ILoopHandlerProvider.register(on)` (`plugins/extensions.ts`).
  `PluginRegistry.getLoopHandlers()` builds one frozen set. Both surfaces
  install it: `nax chat` (`cli/chat.ts:217`, merged in `chat-host.ts:217`) and
  `nax run` (`execution/lifecycle/run-setup-init.ts:185`). Subagents inherit the
  chat set (`chat/subagent-runs.ts`).
- **Handler safety** — `wrapExternalHandler()` (`loop-events/external-handler.ts`):
  10s deadline (`LOOP_HANDLER_TIMEOUT_MS`), never rethrows, a throwing/timed-out
  `before_tool` handler fails closed to `block`.
- **Native-only scope** — `buildLoopHandlerTurnOpts()`
  (`session/loop-handler-forwarding.ts`) delivers handlers only to the native
  agent. ACP brains (Claude Code, Codex, Cursor) run their own hooks.
- **Run lifecycle hooks** — `src/hooks/` (`hooks.json`, global
  `~/.nax/hooks.json` + project `.nax/hooks.json`, `skipGlobal`), events
  `on-start` ... `on-workflow-publish`. Fire-and-forget, run only, cannot block.
  Command execution: argv spawn (no shell), `validateHookCommand()` lint,
  5s default timeout, env-var context. Unchanged by this design.
- **Package-declared Claude hooks** — `resources/parse-hooks.ts` lists them;
  chat says "hooks declared by N package(s) are not executed by nax". Unchanged.

## 3. Goals

1. Shell-command hooks on five events, with Claude-Code-compatible names and a
   Claude-Code-like I/O contract so existing hook scripts port with little or
   no change.
2. Each hook chooses where it runs: `chat`, `run`, or both.
3. Delivered as handlers on the existing loop-event chain via a built-in
   plugin — no second interception mechanism.
4. `UserPromptSubmit` can **block** a prompt as well as add context (user
   ruling 2026-11-01).

## 4. Non-goals

- Executing Claude Code's own hooks or package-declared `hooks.json`.
- Hooks for ACP brains (they run their own).
- An `ask` decision (pause and ask the human) from a hook. Handlers have no UI
  channel today. (My call; can be a follow-up.)
- Changing the run lifecycle hooks (`on-*` events).
- Other loop events (`transform_context`, `before_request`, `after_response`,
  `before_compaction`) as shell hooks.

## 5. Anti-goals

- A hook defect that silently lets a guarded tool call through.
- A hook that hangs an unattended `nax run`.
- Hooks firing twice for one action, or firing for an ACP brain.

## 6. Design

### 6.1 Events and mapping

| Hook event | Loop event | Fires | Can do |
|---|---|---|---|
| `PreToolUse` | `before_tool` | before each tool call | allow, rewrite input, block (reason to agent), add a note to the result (nudge) |
| `PostToolUse` | `after_tool` | after each tool call | append feedback to the result the agent sees; mark it an error |
| `UserPromptSubmit` | `before_turn` | each turn's prompt, before the request | add context; **block** the prompt |
| `SessionStart` | `before_turn` | first turn of a session only | add context |
| `Stop` | `before_turn_end` | turn completed normally | push the agent to continue with a reason (existing follow-up cap applies) |

`UserPromptSubmit` blocking needs one new capability: a `block` field on the
`BeforeTurnPatch` (e.g. `{ block: { reason } }`). When set, the turn makes no
provider request, writes nothing to the transcript beyond what the builder
decides is needed for a consistent session, and returns a blocked outcome
carrying the reason:
- chat: the prompt is not sent; the reason is shown to the user as a notice.
- run: the turn fails with the reason, handled like any other failed turn.

Adding context needs a second new `BeforeTurnPatch` field, `promptContext`
(string): the existing `seed` patch REPLACES the prompt message and would drop
image attachments (`beforeTurnSeed` in `turn-loop.ts`), so the loop instead
prefixes `promptContext` plus a blank line to the content of the first seed
message, keeping its images. (Found during spec grounding.)

`SessionStart` = `before_turn` on a session whose loaded history is empty. In
chat a resumed session with history does not fire it. (My call.)

### 6.2 Config

Location: the existing hooks files — global `~/.nax/hooks.json` and project
`.nax/hooks.json`, honouring `skipGlobal`. New top-level key `agent` so the
lifecycle `hooks` map is untouched (my call; a builder may pick a different key
name but must not overload the `hooks` map, whose values have a different
shape). Global and project agent hooks both run (global first), matching how
lifecycle hooks keep both.

```json
{
  "hooks": { "on-complete": { "command": "notify-send done" } },
  "agent": {
    "PreToolUse": [
      { "matcher": "Bash", "command": "~/.nax/hooks/block-git-push.sh", "scope": ["chat"] }
    ],
    "PostToolUse": [
      { "matcher": "Write|Edit", "command": "~/.nax/hooks/format-and-typecheck.sh", "timeout": 30000 }
    ],
    "UserPromptSubmit": [{ "command": "~/.nax/hooks/prompt-guard.sh" }],
    "SessionStart": [{ "command": "~/.nax/hooks/session-context.sh", "scope": ["chat"] }],
    "Stop": [{ "command": "~/.nax/hooks/tests-green.sh", "scope": ["run"] }]
  }
}
```

Entry fields:
- `command` (required) — executed like lifecycle hooks: argv spawn via
  `parseCommandToArgv()` (no shell; it already expands a leading `~` from
  HOME), same `validateHookCommand()` lint. Process cwd = the session workdir
  (`LoopHandlerContext.workdir`), falling back to the repo root the config was
  loaded for.
- `matcher` (tool events only) — regex (anchored, full match) on the tool
  name exactly as the model called it, i.e. the `ToolCall.name` the loop
  dispatches: built-ins (`Read`, `Write`, `Edit`, `Bash`, ...), MCP tools under
  their namespaced nax name, provider/workflow tools under theirs. Absent or
  `*` = all tools. The user guide lists the built-in names; anything else is
  "whatever the loop reports". (My call.)
- `scope` — `["chat"]`, `["run"]`, or both; default both.
- `timeout` — ms; default 30000, max 600000. Formatters and type checks after
  an edit routinely exceed the 10s loop-handler deadline, so hook handlers get
  their own bound: `LoopHandlerEntry` gains an optional per-entry `timeoutMs`
  that `wrapExternalHandler()` uses instead of `LOOP_HANDLER_TIMEOUT_MS` when
  set (plugin handlers keep 10s). One handler is registered per EVENT (it runs
  that event's matching entries in order), because `dispatchChain` merges
  patches by overwrite: two `before_turn` handlers that each return `seed`
  would keep only the last one's. That handler's `timeoutMs` is the sum of its
  entries' timeouts plus a 1000 ms margin, so each hook still gets its full
  own bound. The hook process is killed at
  its deadline; the turn's abort also kills it. (My call.)
- `enabled` — default true.

Loading: a NEW loader (sibling of `loadHooksConfig`) reads the same two files
and honours `skipGlobal` from the project file exactly as `loadHooksConfig`
does; a file with only `agent` (no `hooks`) is valid for both loaders. The
`agent` section is validated with zod at load; an invalid entry is skipped with
a warning naming it, never a crash. Config is read ONCE when the surface starts
(chat start / run setup) for that surface's repo root; editing `hooks.json`
takes effect on the next chat or run. (My call.)

Trust: project `.nax/hooks.json` agent hooks come from a checked-in file.
`nax chat` refuses an untrusted project at its entry, but `nax run` gates per
execution site (`fireHook` asserts `assertTrusted(workdir, "hooks")` before
each project lifecycle hook). Agent hooks do the same: a project entry asserts
trust (new surface `"agent-hooks"`) before it spawns, and a refusal is a hook
error (so `PreToolUse` fails closed). Global entries are exempt. `nax bot`
never loads agent hooks (PR worktrees may come from forks). (Corrected by
spec-review pass 2.)

### 6.3 I/O contract

stdin: one JSON object:
- common: `hook_event_name`, `session_id` (sessionName), `cwd`, `surface`
  (`chat` | `run`), `role`, `feature`, `story_id` (when known), `model`.
- `PreToolUse`: `tool_name`, `tool_input`.
- `PostToolUse`: `tool_name`, `tool_input`, `tool_response` (content, isError).
- `UserPromptSubmit`: `prompt`.
- `SessionStart`: (common only).
- `Stop`: `stop_hook_active` (true when this turn already had a follow-up).

Exit codes:
- `0` — success; stdout parsed as JSON if it is JSON, else plain stdout is
  context (for `UserPromptSubmit` / `SessionStart`) or ignored (others).
- `2` — block; stderr is the reason. `PreToolUse` -> block, reason to agent.
  `PostToolUse` -> reason appended to the result as feedback. `UserPromptSubmit`
  -> prompt blocked, reason to user. `Stop` -> continue with reason as the
  follow-up.
- other — hook error (see 6.5).

Optional stdout JSON (Claude-Code-like field names):
- `PreToolUse`: `{ "decision": "allow"|"block", "reason"?, "updatedInput"? }`
- `PostToolUse`: `{ "decision": "block"?, "reason"?, "additionalContext"? }`
- `UserPromptSubmit` / `SessionStart`: `{ "decision": "block"?, "reason"?, "additionalContext"? }`
  (`block` honoured for `UserPromptSubmit` only)
- `Stop`: `{ "decision": "block", "reason" }` = continue with reason.

Multiple hooks on one event run in config order (global then project). For
`PreToolUse` the first block wins and later hooks do not run; input rewrites
chain. Context strings concatenate.

`tool_input` given to `PostToolUse` (and to later `PreToolUse` hooks) is the
input the tool actually ran with, i.e. after any rewrite. (My call.)

Ordering on `before_turn`: `SessionStart` hooks run before `UserPromptSubmit`
hooks. If `UserPromptSubmit` blocks the first turn, the session still has empty
history, so `SessionStart` fires again on the next turn. (My call.)

### 6.4 Delivery

A handler factory, not a registry plugin, following the rule-delivery
precedent (`createRuleDeliveryHandlers` is appended to the plugin set at both
sites): the factory is built per surface (`surface: "chat" | "run"`) from the
loaded config and returns a `LoopHandlerSet` whose entries carry plugin name
`agent-hooks`. Chat appends it to `pluginHandlers` in `cli/chat.ts`
`chatResources`; run appends it in `configureRunRules`
(`execution/lifecycle/run-rules-setup.ts`). No `LoopHandlerContext` change is
needed. (Verified during spec grounding; replaces the earlier "built-in
plugin" wording.)

Subagents spawned from chat use the chat set (they already inherit it).

### 6.5 Failure behaviour

- `PreToolUse` hook crashes, exits non-0/2, or times out -> the call is
  **blocked** with a reason naming the hook. Same rule as plugin guards.
- `UserPromptSubmit` same -> in **chat** the prompt is **blocked** with a
  reason naming the hook (a human is there to see it); in **run** the prompt
  is **let through** with a warning naming the hook, so a broken script cannot
  fail stories in an unattended run. (My call, user did not object.)
- A deliberate `UserPromptSubmit` block (exit 2 or `decision: block`) in run =
  a normal failed story attempt; the existing retry/escalation path handles it.
- `PostToolUse`, `SessionStart`, `Stop` -> warning logged, no effect.
- Every hook execution logs one line (event, command, exit, ms) through the
  normal logger so a run's log shows what fired.

### 6.6 Visibility

- Chat: a blocked prompt shows a notice with the reason. A blocked tool call
  already renders as a refused call in the transcript. (My call: no extra UI.)
- The chat "hooks declared by N package(s) are not executed" notice stays and
  refers only to package-declared Claude hooks.

## 7. Constraints

- `packages/nax-agent` must not import the nax plugin system; nax-agent
  changes are limited to: the `before_turn` `block` and `promptContext` fields, the per-entry
  `timeoutMs` on `LoopHandlerEntry`, and `surface` on `LoopHandlerContext` if
  the builder picks that route.
- Pipeline mode is frozen: no pipeline-only changes. Run delivery uses the
  existing shared `getLoopHandlers()` path.
- File-size and test rules in `.nax/rules/` apply.

## 8. Left to the builder

- Story split and order.
- Exact `before_turn` block plumbing and how the blocked outcome surfaces
  through `SessionManager` / chat host.
- Whether hook handlers reuse `executeHook()` internals or a sibling runner
  (stdin JSON + exit-code parsing are new).
- Config key name if `agent` is a poor fit.
- Docs: a user guide page for agent hooks with the contract and examples.

## 9. Calls made without the user (check these)

1. Config lives in `hooks.json` under a new `agent` key.
2. No `ask` decision in v1.
3. `UserPromptSubmit` fails closed (blocks) on hook error.
4. `SessionStart` fires only on a session with empty history.
5. Default scope is both surfaces; default timeout 30000 ms with a per-entry
   deadline added to `LoopHandlerEntry` (one small nax-agent change beyond the
   `before_turn` block).
6. Project entries assert trust per hook (surface `agent-hooks`); bot never loads agent hooks.
7. Matcher = the tool name the loop dispatches; PostToolUse sees the rewritten input.
8. Config read once per chat/run start.
9. `UserPromptSubmit` hook error: blocks in chat, fails open with a warning in run.
