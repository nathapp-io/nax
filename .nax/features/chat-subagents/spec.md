# SPEC: chat-subagents — Claude Code subagents in nax chat, as nested native sessions

## Summary

`nax chat` gains subagents. The F4 resource catalog already parses Claude Code agent
files (`<repo>/.claude/agents/*.md`, `~/.claude/agents/*.md`, every enabled plugin's
`agents/`, and nax plugin `resources.agents`) but delivers nothing from them. This feature
delivers them: a `static` tool provider `nax-agents` with one tool, `nax-agents__run`,
lets the chat model hand a task to a named agent. The host runs that task in a nested
native session in the same process: the same permission mode as the chat session, the
chat session's tools narrowed to the agent's `tools:` list, the agent's body as its
system prompt, and its own model resolved through a new `agent.modelAliases` config map
(`inherit` or no `model:` means the chat session's model; `haiku`, `sonnet` and `opus`
fall back to the configured `models.native` tiers). The nested session cannot start a
subagent of its own (depth 1). Its asks reach the person through the chat session's
existing ask controller, its rules are delivered like the chat session's, its spend lands
in the chat cost ledger and the session's `/cost`, and its final text is the tool result.
`/agents` lists the agents with their resolved model and tools. One nax-agent change is
needed: a session option `allowedTools` that narrows the tools a session declares.

## Motivation

The main nax roadmap (user ruling 2026-10-24) makes nax a full interactive coding agent.
Design doc `docs/superpowers/specs/2026-10-24-nax-interactive-tui-slice1-design.md` §4.5
and §5.1 row F5b define this feature; the user split F5 into F5a (`chat-mcp-servers`,
merged #2699) and F5b (this spec) on 2026-10-25. Claude Code users keep reviewers,
planners and researchers as agent files; today `/plugins` prints
`agents N (not delivered yet)` and the chat model has no way to use them. The design
rules that apply here: subagents are nested sessions in the same process, run under a
mode equal to or narrower than the parent's, get the parent's tools intersected with
the agent's list, take their own model through `agent.modelAliases` with `inherit`
meaning the parent's model, and have depth 1. Hooks stay listed but not executed. User
ruling 2026-10-25: keep the `haiku`/`sonnet`/`opus` to `models.native` tier step, with an
alias always winning.

## Design

### Approach

**1. nax-agent: `allowedTools` on `nativeBackend` (US-001).** `NativeBackendOptions`
gains `allowedTools?: readonly string[]`, validated by the options schema as an array of
non-empty strings. Absent means today's behaviour exactly. Present, it narrows what the
session declares, in this order:

1. The profile's built-in tools (`declaredToolsFor(profile, protectedPaths)`) are kept
   only when their name is in `allowedTools`, except the universal scratchpad tools
   (`UNIVERSAL_CODING_TOOLS`: `ScratchpadWrite`, `ScratchpadRead`, `ScratchpadList`),
   which are always kept. `buildSessionToolSupport` does this from its new
   `allowedTools` argument.
2. Provider tools are admitted through `resolveProviderTools`'s existing `admits`
   option, which `openNative` passes: a tool `<id>__<local>` is admitted when
   `allowedTools` contains that exact name or contains `<id>__*`.
3. Grants and ask rules are computed from the narrowed built-in list, so a tool that is
   not declared is never granted, and the ask rules for a declared tool are unchanged.

An `allowedTools` entry naming nothing available is ignored. The narrowing never adds a
tool. Embedder tools (`CreateAgentSessionOptions.tools`) are not filtered. The public API
dump lists type names only, so it does not change.

```ts
// packages/nax-agent/src/session/native-backend-options.ts
export interface NativeBackendOptions {
  // ...existing fields unchanged...
  /** Narrow the declared tools to these names (built-in names, `<provider>__<tool>`, or `<provider>__*`); scratchpad tools are always kept. */
  readonly allowedTools?: readonly string[];
}

// packages/nax-agent/src/session/session-tool-support.ts
export interface SessionToolSupportArgs {
  // ...existing fields unchanged...
  readonly allowedTools?: readonly string[];
}
```

**2. Catalog: agents carry their prompt and are indexed (US-002).** `AgentResource`
gains `prompt: string`: the agent file's body without frontmatter, read the way
`parseSkillFile` reads `SkillResource.body`. `ResourceCatalog` gains `agents` (every
loaded agent in package order, shadowed ones included) and `findAgent(name)`, built by
the same `indexResources` precedence as skills and commands (project > user > plugin; a
shadowed agent stays reachable as `<plugin>:<name>`; a shadow adds the existing warn
diagnostic `<kind> <name> from <pkg> is shadowed by <winner>; use <qualifiedName>` with
kind `agent`). `formatPluginsListing` stops printing `(not delivered yet)` after the
agents count; the hooks `(not executed)` wording stays. The `parseAgentFile` doc comment
stops saying the body is not retained.

**3. `agent.modelAliases` (US-003).** A new config map from a Claude Code model name to a
nax model id, default `{}`. Each value must be a nax model id the way `parseNativeModel`
reads one: a non-empty provider before the first `/`, a non-empty remainder after it,
no whitespace, an optional `[effort]` suffix (`openrouter/z-ai/glm-5.3-flash[high]` is
valid). Four places change: `AgentConfigSchema` (`schemas-infra.ts`), the explicit
`agent` default literal in `NaxConfigSchema` (`schemas.ts`, which Zod returns unparsed,
so it must carry `modelAliases: {}`), the hand-written `AgentConfig` interface
(`runtime-types-agent.ts`, `modelAliases?: Readonly<Record<string, string>>`), and the
config descriptions registry (`agent.modelAliases`).

**4. Model and tool resolution, pure (US-004).** `resolveSubagentModel` (new,
`src/chat/subagent-model.ts`) takes `{ requested?: string; parentModel: string; aliases:
Readonly<Record<string, string>>; tiers: NaxConfig["models"]["native"] }` and returns
`{ model: string; source: "inherit" | "alias" | "tier" | "model" | "fallback" }` as an
ordered pipeline; the first step that answers wins:

1. `requested` absent or `"inherit"` -> the parent's model, source `inherit`.
2. `aliases[requested]` defined -> that value, source `alias`.
3. `requested` is `haiku`, `sonnet` or `opus` and `tiers.fast`, `.balanced` or
   `.powerful` respectively is configured -> that tier's model (a string entry as is, an
   object entry as `provider/model`), source `tier`.
4. `requested` contains `/` -> `requested` itself, source `model`.
5. Otherwise -> the parent's model, source `fallback`.

`mapSubagentTools` (new, `src/chat/subagent-tools.ts`) turns an agent's Claude Code
`tools:` list into `allowedTools` for US-001, returning `{ allowedTools?: string[];
dropped: { name: string; reason: string }[] }`:

| Agent `tools:` entry | `allowedTools` entry |
|---|---|
| `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `Git`, `Delete`, `GitCommit` | the same name |
| `MultiEdit` | `Edit` |
| `Skill` | `nax-skills__*` |
| `mcp__<server>__<tool>` | `<server>__<tool>` |
| `mcp__<server>` | `<server>__*` |
| `Agent`, `Task` | dropped, reason `subagents cannot start subagents` |
| `<Name>(<pattern>)`, for example `Bash(git diff:*)` | the bare `<Name>` mapped by the rows above; the pattern is not enforced |
| anything else | dropped, reason `no nax equivalent` |

`tools:` absent -> no `allowedTools` key (the agent inherits every tool the parent
session offers, minus the agents provider). Entries are de-duplicated in first-seen
order. A list whose entries are all dropped yields `allowedTools: []` (scratchpad tools
only). Both functions are exported from `@/chat`.

**5. Prompt builders (US-005).** New `src/prompts/builders/agents-builder.ts`, exported
from `src/prompts/index.ts`:

- `buildAgentsInstructions(agents)`: a first line telling the model to call
  `nax-agents__run` with an agent name and a self-contained task, then one line
  `- <qualifiedName>: <description>` per agent. Descriptions are cleaned exactly like the
  skills index (whitespace runs collapsed to one space, control characters removed,
  truncated to 200 characters), and at most 150 agents are listed, then
  `- ... and <N> more`. The cleaning is shared by moving it into an exported helper
  `cleanIndexDescription(text)` in the skills builder, used by both.
- `buildSubagentInstructions({ agent, mode, rulesIndex })`: the permission paragraph for
  `mode`, the rules index section (`buildRulesIndexSection`, as chat uses it), then the
  agent's `prompt` last. The permission sentences move out of `buildChatInstructions`
  into an exported `chatPermissionParagraph(mode)` in `chat-builder.ts`, which both
  builders call; `buildChatInstructions`' output is unchanged.

**6. The agents provider (US-006).** `createAgentsProvider({ catalog, run })` (new,
`src/chat/agents-provider.ts`) returns a `static` `ToolProvider` with id `nax-agents`,
`stages: ["*"]`, and one tool `run` (the model sees `nax-agents__run`) whose input schema
is `{ agent: string, task: string }`, both required, `additionalProperties: false`. Its
`tools()` returns `[]` when the catalog has no agents. Its `instructions()` returns
`buildAgentsInstructions(catalog.agents)`, or `undefined` with no agents. `run` validates
its input (both strings, both non-empty after trimming), looks the agent up with `catalog.findAgent`, and calls the injected
`run(agent, task, signal)` with `ToolRunContext.signal`, returning its `ToolResult`. The
provider id is reserved: `createChatMcp` drops an MCP server whose id is `nax-agents`
with the same reserved-id diagnostic it gives `nax-skills` today (the single
`RESERVED_SERVER_ID` becomes a set of both ids).

**7. The nested session (US-007, US-008).** `runSubagent(input, deps =
_subagentSessionDeps)` (new, `src/chat/subagent-session.ts`) runs one task to
completion.

```ts
export interface RunSubagentInput {
  readonly agent: AgentResource;
  readonly task: string;
  readonly mode: ChatMode;               // the chat session's mode at call time
  readonly model: string;                // from resolveSubagentModel
  readonly allowedTools?: readonly string[]; // from mapSubagentTools
  readonly toolProviders: readonly ToolProvider[]; // the chat resources' providers, never the agents provider
  readonly loopHandlers: LoopHandlerSet; // the chat host's handler set
  readonly cwd: string;
  readonly repoRoot: string;
  readonly config: NaxConfig;
  readonly parentSessionId: string;
  readonly signal?: AbortSignal;
  readonly onEvent: (event: SessionEvent) => void;
  /** Called with the nested session once it is created, before its turn starts. */
  readonly onSession?: (session: AgentSession) => void;
}

export const _subagentSessionDeps = {
  createAgentSession,
  nativeBackend,
  createMemoryTranscriptStore,
  resolveRuleSet,
};
```

Session options (US-007): `createAgentSession` with `profile` from
`chatSessionSettings(mode)`; `nativeBackend({ model, bashApproval (from the same
settings), allowUnsandboxed: true, allowUnsandboxedCommands: true, carryHistoryAcrossModels:
true, loopHandlers, loopHandlerRole: "subagent", toolProviders, allowedTools (only when
given), catalogOverrides and compaction exactly as open-chat-session.ts passes them from
config })`; `workdir: cwd`; `transcriptStore: createMemoryTranscriptStore()` (not
persisted, not listed, not resumable); `metadata: { parentSessionId, subagent:
agent.qualifiedName }`; `approvalTimeoutMs: config.execution.approvalTimeout`;
`instructions: buildSubagentInstructions({ agent, mode, rulesIndex })` where the rules
index comes from `resolveRuleSet` called the way `open-chat-session.ts` calls it. US-007 implements a minimal skeleton around these options: create the session, send the task, consume events to `turn_end`, close, and return `{ content: output }`; its tests use a stub session whose turn ends immediately.

Turn and result (US-008): rule delivery acts for the nested session (`"subagent"` joins `RULE_READ_ROLES` and `RULE_WRITE_ROLES` in `src/context/rules/rule-delivery/index.ts`); it sends `task` as the only message, passes every event to
`onEvent` in order, and on `turn_end` returns: status `completed` -> `{ content: output }`,
or `(the subagent returned no text)` when `output` is empty; any other status ->
`{ isError: true, content: "subagent <qualifiedName> <status>: <error.message, or the status when there is no error>" }`.
`signal` aborting calls the nested session's `cancel()`; a signal already aborted at the
start returns `{ isError: true, content: "subagent <qualifiedName> cancelled: cancelled" }`
without creating a session. The session is closed in every outcome. A throw from
`createAgentSession` or `send` returns `{ isError: true, content: "[chat] subagent <qualifiedName> failed: <message>" }`.

**8. Nested runs in the host (US-009, US-010).** A new `src/chat/subagent-runs.ts` keeps
host-side state for running nested sessions so `chat-host.ts` stays small:

```ts
export interface SubagentRuns {
  /** Run one agent task for the chat session; wires asks, usage, cost and tool events. */
  run(agent: AgentResource, task: string, signal?: AbortSignal): Promise<ToolResult>;
  /** The nested session that issued this request id, if one is still running. */
  sessionFor(requestId: string): AgentSession | undefined;
  /** Spend of nested turns since the last call; resets to 0. */
  takeCost(): number;
  cancelAll(): void;
  closeAll(): Promise<void>;
}
export function createSubagentRuns(deps: SubagentRunsDeps): SubagentRuns;
```

`SubagentRunsDeps` gives it `current()` (the chat session's id, mode and model; called only inside `run`, never at construction, because it throws before a session is open), the
catalog, `config`, `cwd`, `repoRoot`, the base `toolProviders`, the host's loop handlers,
the ask controller, `ledger()` (a getter: the host creates its ledger lazily when the first session opens), and `turnListener()` (the running send's `onEvent`
or `undefined`). `run` resolves the model and tools (US-004), calls `runSubagent`, and
routes the nested events:

- `approval_requested` and `question`: record `requestId -> nested session`, then hand the
  ask controller a copy whose `reason` (approval) or `text` (question) is prefixed
  `[agent <qualifiedName>] `. `approval_resolved` removes the record, and the nested
  session closing removes all of its records. Full mode's auto-allow and the per-session
  allow memory apply unchanged, because the controller does both.
- `usage`: `ledger.record({ ...event, sessionId: <chat session id> }, previousAt, model,
  "subagent")`, where `previousAt` is the nested turn's `turn_start.at` or the previous
  usage's `at`.
- `turn_end`: its `costUsd` is added to the amount `takeCost()` returns.
- `tool_call` and `tool_result`: passed to `turnListener()` when one is set.
- Other nested events are not forwarded.

Host changes (US-009): `NativeChatHost` creates one `SubagentRuns` and, when
`resources.catalog.agents` is non-empty, passes `[...resources.toolProviders,
createAgentsProvider({ catalog, run: runs.run })]` at all three open sites (start, resume,
reopen for a mode or model switch); with no agents it passes `resources.toolProviders`
itself, the same array as today. The ask controller's `answer` closure answers on
`runs.sessionFor(requestId)` when that is defined, otherwise on the chat session.

Ledger and cost (US-010): `ChatLedger.record` gains an optional fourth argument `role:
"tui" | "subagent"` (default `tui`) written as the row's `sessionRole`.
`RunChatTurnOptions` gains `extraCostUsd?: () => number`, read once after `turn_end`;
`writeTurnMeta` adds it to `ended.costUsd`. `host.send` sets the turn listener for the
send's duration and passes `extraCostUsd: () => runs.takeCost()`; in a `finally` it clears the listener and calls `runs.takeCost()` once more, so nested spend from a send that threw is dropped rather than added to the next send. `cancel()` also calls `runs.cancelAll()`; `close()` awaits `runs.closeAll()` before the chat session closes.

**9. `/agents` (US-011).** `ChatAgentRow` (in `src/chat/chat-agents-listing.ts`, exported
from `@/chat`) is `{ name, description, model, modelSource, tools: readonly string[] |
"all", dropped }`. `ChatHost.agents?(): readonly ChatAgentRow[]` returns one row per
catalog agent in catalog order, resolved against the chat session's current model.
`formatAgentsListing(rows)` prints one line per agent
`<name>  <model> (<modelSource>)  tools <comma list, "all", or "none">  <description>`
(description cleaned by `cleanIndexDescription`), then an indented line
`  dropped: <name> (<reason>)` per dropped tool; with no rows it prints `(no agents)`.
`/agents` is a built-in slash command between `/mcp` and `/quit`.

### Integration (extends existing code)

Read only (verified on `main` `cc83a90c8`):

- `packages/nax-agent/src/tools/provider-advertise.ts`: `resolveProviderTools(providers,
  stage, workdir, options?: { admits?: (providerId, localName) => boolean })`.
- `packages/nax-agent/src/session/native-backend.ts`: `openNative` calls
  `resolveProviderTools(raw.toolProviders, SESSION_STAGE, ctx.workdir)` and
  `buildSessionToolSupport({ profile, ... })`.
- `packages/nax-agent/src/tools/runtime-calltool.ts` / `session-interaction.ts`: provider
  tools receive `ToolRunContext.signal` from the turn.
- `packages/nax-agent/src/session/agent-session-types.ts`: `CreateAgentSessionOptions`,
  `SessionEvent`, `AgentSession` (`send`, `answer`, `cancel`, `close`).
- `packages/nax-agent` export `createMemoryTranscriptStore`.
- `packages/nax/src/resources/skills-provider.ts`: `createSkillsProvider`, the static
  provider pattern this feature mirrors.
- `packages/nax/src/chat/chat-mode.ts`: `chatSessionSettings(mode)`.
- `packages/nax/src/chat/open-chat-session.ts`: `sessionOptions` (the options the nested
  session mirrors).

Changed (the baseline exists only to locate the code; the target is the interface to
implement):

- `parseAgentFile` — Baseline: no `prompt`. Target: returns `prompt`.
- `ResourceCatalog` — Baseline: `packages, skills, commands, diagnostics, findSkill,
  findCommand`. Target: adds `agents` and `findAgent(name)`.
- `AgentConfigSchema`, the `agent` default literal in `NaxConfigSchema`, `AgentConfig` —
  Target: `modelAliases`.
- `buildSkillsInstructions` — Target: unchanged output, uses `cleanIndexDescription`.
- `buildChatInstructions` — Target: unchanged output, uses `chatPermissionParagraph`.
- `createChatMcp` — Target: reserves `nax-skills` and `nax-agents`.
- `RULE_READ_ROLES`, `RULE_WRITE_ROLES` — Target: also `subagent`.
- `ChatLedger.record` — Baseline: `record(event, previousAt, model?)`. Target:
  `record(event, previousAt, model?, role?: "tui" | "subagent")`.
- `RunChatTurnOptions` — Target: adds `extraCostUsd?: () => number`.
- `ChatHost` — Target: adds `agents?(): readonly ChatAgentRow[]`.

### Failure Handling

| Situation | Behaviour |
|---|---|
| `nax-agents__run` input missing `agent` or `task`, either not a string, or either empty after trimming whitespace | Tool result `isError: true`, content `[chat] run requires agent: string and task: string`; no session is created. |
| Unknown agent name | Tool result `isError: true`, content `unknown agent <name>; available: <up to 20 qualified names, comma-separated>`. |
| `createAgentSession` or `send` throws | Tool result `isError: true`, content `[chat] subagent <name> failed: <message>`; nothing is left open. |
| The nested turn ends `cancelled`, `timed_out`, `interrupted` or `errored` | Tool result `isError: true`, content `subagent <name> <status>: <error.message or status>`. |
| The tool signal is already aborted when `runSubagent` starts | Tool result `isError: true`, content `subagent <name> cancelled: cancelled`; no session is created. |
| The chat turn is cancelled while a subagent runs | The nested session is cancelled (via the tool signal and via `host.cancel()`), then closed. |
| An agent's `model:` is unknown | Falls back to the chat model, source `fallback`, shown by `/agents`; never an error. |
| An agent's `tools:` names a tool with no nax equivalent | Dropped; listed by `/agents` with its reason; never an error. |
| An MCP server's id is `nax-agents` | `createChatMcp` drops it with diagnostic `[resources] mcp server id nax-agents is reserved`. |
| `agent.modelAliases` value is not a nax model id | Config validation fails with an issue whose path includes `modelAliases`. |

## Out of Scope

- Subagents in `nax run` are not supported; the agents provider attaches to `nax chat` only.
- Subagent depth is 1: a nested session never receives the `nax-agents` provider, and an agent's `Agent` or `Task` tool entry is dropped.
- Nested sessions are not persisted: they use an in-memory transcript store, are not listed by `/sessions`, and cannot be resumed; a resumed chat session does not restore a subagent that was running when the process died.
- Claude Code agent frontmatter other than `name`, `description`, `model` and `tools` (for example `color`, `permissionMode`, `hooks`, `skills`) is ignored; a subagent always runs in the chat session's current mode.
- Narrowing a subagent's mode below the chat session's (for example a read-only profile for an agent whose tools are all read-only) is not done; the tool narrowing is the only narrowing.
- A Claude Code tool pattern such as `Bash(git diff:*)` is not enforced; the entry grants the whole tool and the existing guarded asks still apply to every call.
- Embedder tools (`CreateAgentSessionOptions.tools`) are not filtered by `allowedTools`.
- Claude Code plugin MCP tool names of the form `mcp__plugin_<plugin>_<server>__<tool>` are not translated to nax's `<plugin>-<server>` server ids; such an entry maps to `plugin_<plugin>_<server>__<tool>` and matches nothing.
- The transcript shows a subagent's tool calls and results only; its streamed text and thinking are not shown, and its final text appears as the `nax-agents__run` tool result.
- Background (non-blocking) subagents are not supported; a `nax-agents__run` call returns when the nested turn ends.
- A per-agent model or tool override inside chat is not added; the agent file and `agent.modelAliases` are the switches.
- Agents are not hot-reloaded; a changed agent file takes effect at the next `nax chat` start.
- Hooks stay parsed and listed as not executed.
- Updating `.nax/mono/packages/nax/context.md` and `.nax/mono/packages/nax-agent/context.md` for subagents and `allowedTools`, then running `nax generate`, is a manual step after merge; `.nax/` is read-only to the run.
- The design doc §5.1 status line for F5b is updated by hand with this spec, not by a story.
- No release and no version bump.

## Stories

Paths below are repo-relative. Eleven stories, one capability: Claude Code subagents run
inside `nax chat`. The count grew from seven to eleven when spec-review pass 1 counted
assertions against the 24-AC cap and split four stories. US-001 is the nax-agent seam;
US-002 to US-005 are the catalog, config, pure resolution and prompts; US-006 to US-010
build the provider, the nested session and the host wiring; US-011 is `/agents`.

### US-001 — nax-agent: `allowedTools` narrows a session's declared tools

Workdir: packages/nax-agent. No dependencies.

- Add `allowedTools` to `NativeBackendOptions` and its schema; pass it to `buildSessionToolSupport` (built-ins) and to `resolveProviderTools` as `admits` (provider tools) (Design §Approach 1).

### US-002 — Catalog: agent prompts and agent lookup; `/plugins` wording

Workdir: packages/nax. No dependencies.

- Add `prompt` to `AgentResource` and `parseAgentFile`; add `agents` and `findAgent` to `ResourceCatalog` in `buildResourceCatalog`; drop `(not delivered yet)` after the agents count in `formatPluginsListing` (Design §Approach 2).

### US-003 — Config: `agent.modelAliases`

Workdir: packages/nax. No dependencies.

- Add `modelAliases` to `AgentConfigSchema`, the `agent` default literal in `NaxConfigSchema`, the `AgentConfig` interface and the config descriptions registry (Design §Approach 3).

### US-004 — Subagent model and tool resolution

Workdir: packages/nax. Depends on US-003.

- Create `resolveSubagentModel` and `mapSubagentTools`, exported from the chat barrel (Design §Approach 4).

### US-005 — Prompt builders for agents and subagents

Workdir: packages/nax. Depends on US-002.

- Extract `cleanIndexDescription` and `chatPermissionParagraph`; create `buildAgentsInstructions` and `buildSubagentInstructions` (Design §Approach 5).

### US-006 — The `nax-agents` provider

Workdir: packages/nax. Depends on US-002, US-005.

- Create `createAgentsProvider`; reserve the `nax-agents` id in `createChatMcp` (Design §Approach 6).

### US-007 — Nested session: options

Workdir: packages/nax. Depends on US-001, US-005.

- Create `runSubagent` with `_subagentSessionDeps`, the session options and a minimal create/send/close skeleton (Design §Approach 7, session options).

### US-008 — Nested session: turn, result, failures and rule delivery

Workdir: packages/nax. Depends on US-007.

- Complete `runSubagent`'s turn handling, result mapping, cancellation and close; add `subagent` to the rule-delivery roles (Design §Approach 7, turn and result).

### US-009 — Chat host: agents provider and nested asks

Workdir: packages/nax. Depends on US-004, US-006, US-008.

- Create `createSubagentRuns` with ask routing; compose the agents provider in `NativeChatHost` at all three open sites; route answers (Design §Approach 8, host changes).

### US-010 — Chat host: subagent spend and tool events

Workdir: packages/nax. Depends on US-009.

- Add `role` to `ChatLedger.record` and `extraCostUsd` to `runChatTurn`; record nested usage, add nested spend to the session cost, forward nested tool events; cancel and close nested sessions from the host (Design §Approach 8, ledger and cost).

### US-011 — `/agents`

Workdir: packages/nax. Depends on US-009.

- Add `ChatHost.agents()` to the native host, create `ChatAgentRow` and `formatAgentsListing`, and add the `/agents` built-in slash command (Design §Approach 9).

### Context Files

**US-001**
- `packages/nax-agent/src/session/native-backend-options.ts`
- `packages/nax-agent/src/session/native-backend.ts`
- `packages/nax-agent/src/session/session-tool-support.ts`
- `packages/nax-agent/src/tools/provider-advertise.ts`

**US-002**
- `packages/nax/src/resources/types.ts`
- `packages/nax/src/resources/parse-agent.ts`
- `packages/nax/src/resources/parse-skill.ts`
- `packages/nax/src/resources/catalog.ts`
- `packages/nax/src/resources/listing.ts`

**US-003**
- `packages/nax/src/config/schemas-infra.ts`
- `packages/nax/src/config/schemas.ts`
- `packages/nax/src/config/runtime-types-agent.ts`
- `packages/nax/src/cli/config-descriptions.ts`
- `packages/nax-agent/src/native/models.ts`

**US-004**
- `packages/nax/src/config/schemas-model.ts`
- `packages/nax/src/chat/index.ts`
- `packages/nax/src/resources/types.ts`

**US-005**
- `packages/nax/src/prompts/builders/skills-builder/index.ts`
- `packages/nax/src/prompts/builders/chat-builder.ts`
- `packages/nax/src/prompts/builders/rules-index-builder.ts`
- `packages/nax/src/prompts/index.ts`

**US-006**
- `packages/nax/src/resources/skills-provider.ts`
- `packages/nax/src/chat/chat-mcp.ts`
- `packages/nax/src/prompts/builders/agents-builder.ts` — created by US-005, read here

**US-007**
- `packages/nax/src/chat/open-chat-session.ts`
- `packages/nax/src/chat/chat-mode.ts`
- `packages/nax/src/prompts/builders/agents-builder.ts` — created by US-005, read here
- `packages/nax-agent/src/session/agent-session-types.ts`

**US-008**
- `packages/nax/src/chat/subagent-session.ts` — created by US-007, completed here
- `packages/nax/src/context/rules/rule-delivery/index.ts`
- `packages/nax-agent/src/session/agent-session-types.ts`

**US-009**
- `packages/nax/src/chat/chat-host.ts`
- `packages/nax/src/chat/ask-controller.ts`
- `packages/nax/src/chat/agents-provider.ts` — created by US-006, integrated here
- `packages/nax/src/chat/subagent-session.ts` — created by US-007, integrated here
- `packages/nax/src/chat/subagent-model.ts` — created by US-004, integrated here

**US-010**
- `packages/nax/src/chat/chat-ledger.ts`
- `packages/nax/src/chat/turn-runner.ts`
- `packages/nax/src/chat/chat-host.ts`
- `packages/nax/src/chat/subagent-runs.ts` — created by US-009, completed here

**US-011**
- `packages/nax/src/chat/chat-host.ts`
- `packages/nax/src/chat/chat-mcp-listing.ts`
- `packages/nax/src/tui/chat/slash-commands.ts`
- `packages/nax/src/chat/subagent-model.ts` — created by US-004, read here
- `packages/nax/src/chat/subagent-tools.ts` — created by US-004, read here

### Creates

**US-001**
None. Changes to existing files only.

**US-002**
None. Changes to existing files only.

**US-003**
None. Changes to existing files only.

**US-004**
- `packages/nax/src/chat/subagent-model.ts`
- `packages/nax/src/chat/subagent-tools.ts`

**US-005**
- `packages/nax/src/prompts/builders/agents-builder.ts`

**US-006**
- `packages/nax/src/chat/agents-provider.ts`

**US-007**
- `packages/nax/src/chat/subagent-session.ts`

**US-008**
None. Completes a file created by US-007.

**US-009**
- `packages/nax/src/chat/subagent-runs.ts`

**US-010**
None. Changes to existing files and a file created by US-009.

**US-011**
- `packages/nax/src/chat/chat-agents-listing.ts`

### Modifies

**US-001**
None. The option is additive and absent by default; no existing test constructs a backend with `allowedTools`.

**US-002**
- `packages/nax/test/unit/resources/parse-agent.test.ts` — the two cases that compare the whole parsed resource with toEqual ("AC-1 returns required metadata and optional model" and "qualifies plugin agents without retaining executable body") gain `prompt` equal to the fixture's body text in each expected resource; the second case is renamed "qualifies plugin agents and retains the prompt body" because the body is now retained; every name, description, model and tools expectation is unchanged.
- `packages/nax/test/unit/resources/listing.test.ts` — the fixture package's two agent literals (the `["a", "b"].map(...)` objects with kind "agent") gain `prompt: ""` because `AgentResource.prompt` is required and the package test typecheck would fail without it; the expected /plugins text for package sp@m changes "agents 2 (not delivered yet)" to "agents 2"; the skills, commands, mcp and hooks wording is unchanged.

**US-003**
None. A new optional config key with a default; no existing test compares the whole parsed `agent` block.

**US-004**
None. New files only.

**US-005**
None. The two extracted helpers keep `buildSkillsInstructions` and `buildChatInstructions` output byte-identical, so their existing tests stay green unchanged.

**US-006**
None. New file; the reserved-id change adds a case and changes no existing `createChatMcp` expectation.

**US-007**
None. New file only.

**US-008**
None. Completes a new file; `test/unit/context/rules/rule-delivery.test.ts` checks the role lists with `toContain("tui")`, which stays true.

**US-009**
None. With no catalog agents the host passes `resources.toolProviders` itself, so `chat-host-resources.test.ts`'s `toBe(f.resources.toolProviders)` assertion stays true; the ask controller's options are unchanged.

**US-010**
None. `record`'s new argument and `extraCostUsd` are optional; existing ledger and turn-runner calls are unchanged.

**US-011**
- `packages/nax/test/ui/chat/slash-commands.test.tsx` — the file's COMMANDS list (used by "AC-16 help lists every command" as one contiguous run, and by "AC-19 blocks /%s during turn") gains "agents" between "mcp" and "quit"; AC-19 then also covers /agents, which is blocked during a turn like every other built-in.

### Seams

Host-level seam ACs (US-009, US-010) use one harness: `createChatHost` with no `open`
override, a fixture catalog built by `buildResourceCatalog`, and
`_openChatSessionDeps.createAgentSession` stubbed to return a scripted chat session.
`_openChatSessionDeps.nativeBackend` is stubbed to capture its options. The scripted
session's `send` finds the provider with id `nax-agents` in the captured `toolProviders`,
calls its `tools(cwd)`, then calls the `run` tool with `{ agent, task }` and a context
carrying the turn's `AbortSignal`, then ends its turn. The nested session is driven
through `_subagentSessionDeps` stubs.

- US-001 -> US-007: `NativeBackendOptions.allowedTools`; US-007 asserts, through `runSubagent` with `_subagentSessionDeps.nativeBackend` stubbed to capture its options, that the captured `allowedTools` equal the input's `allowedTools`.
- US-002 -> US-006: `ResourceCatalog.findAgent` and `AgentResource.prompt`; US-006 asserts, through the provider's `run` tool over a catalog built by `buildResourceCatalog`, that the injected runner receives the agent whose `prompt` is the fixture body.
- US-003 -> US-009: `agent.modelAliases`; US-009 asserts, through the host harness with `agent.modelAliases: { sonnet: "anthropic/claude-sonnet-5-5" }` and agent `reviewer` (`model: sonnet`), that the nested backend gets that model.
- US-004 -> US-009: `resolveSubagentModel` and `mapSubagentTools`; covered by the US-003 -> US-009 seam and a sibling AC on `allowedTools`.
- US-005 -> US-006, US-007: `buildAgentsInstructions`, `buildSubagentInstructions`; US-006 asserts the provider's instructions contain the agent line, and US-007 asserts the nested `instructions` end with the agent's prompt.
- US-006 -> US-009: `createAgentsProvider`; US-009 asserts through the host harness that `start` passes `toolProviders` ending with a provider whose id is `nax-agents`.
- US-008 -> US-009: `runSubagent`; covered by the host harness, which enters at `host.send`.
- US-009 -> US-010: `SubagentRuns`; US-010 asserts through the host harness that nested usage reaches the ledger and nested spend reaches `host.current().meta.costUsd`.
- US-009 -> US-011: `ChatHost.agents()` on the native host; US-011 asserts, through `runSlashCommand` for `/agents` on a host built by `createChatHost` with a fixture catalog agent, that `show` receives a line starting with that agent's qualified name.

## Acceptance Criteria

### US-001 — nax-agent: `allowedTools` narrows a session's declared tools

- [unit] `nativeBackend({ model, allowedTools: ["Read"] })` returns a backend without throwing.
- [unit] `nativeBackend({ model, allowedTools: [""] })` throws `AgentSessionError` with code `AGENT_SESSION_INVALID_OPTIONS`.
- [unit] `nativeBackend({ model, allowedTools: "Read" })` throws `AgentSessionError` with code `AGENT_SESSION_INVALID_OPTIONS`.
- [unit] Opening a native backend with profile `full` and no `allowedTools` declares `Read`, `Glob`, `Grep`, `Git`, `Write`, `Edit`, `Delete`, `Bash` and the scratchpad trio, as before this change.
- [unit] Opening with profile `full` and `allowedTools: ["Read", "Grep"]` declares exactly the scratchpad trio plus `Read` and `Grep`.
- [unit] Opening with profile `full` and `allowedTools: []` declares exactly the scratchpad trio.
- [unit] Opening with profile `read` and `allowedTools: ["Read", "Bash"]` declares no `Bash` tool.
- [unit] Opening with profile `full` and `allowedTools: ["Read", "NoSuchTool"]` declares exactly the scratchpad trio plus `Read`.
- [unit] Opening with profile `full`, a static provider `acme` with tools `get` and `put`, and `allowedTools: ["acme__get"]` declares `acme__get`.
- [unit] In that session, `acme__put` is not declared.
- [unit] Opening with profile `full`, the provider `acme`, and `allowedTools: ["acme__*"]` declares both `acme__get` and `acme__put`.
- [unit] Opening with profile `full`, the provider `acme`, and `allowedTools: ["Read"]` declares no tool whose name starts with `acme__`.
- [unit] Opening with profile `full`, the provider `acme`, and no `allowedTools` declares both `acme__get` and `acme__put`.
- [unit] `buildSessionToolSupport` with profile `full` and `allowedTools: ["Read"]` returns `grants` with no entry whose `tool` is `Write`.
- [unit] Opening with profile `ask` and `allowedTools: ["Edit"]`, a `coding-tool` interaction for `Edit` emits an `approval_requested` event whose `tool` is `Edit`.
- [unit] Opening with profile `ask`, `bashApproval: "gated"` and `allowedTools: ["Bash"]`, a `coding-tool` interaction for `Bash` emits an `approval_requested` event whose `tool` is `Bash`.
- [unit] Opening with profile `full` and `allowedTools: ["Read"]`, a `coding-tool` interaction for `Write` returns an error result.
- [unit] In that session, the Write tool's `run` is not invoked by that interaction.

### US-002 — Catalog: agent prompts and agent lookup; `/plugins` wording

- [unit] `parseAgentFile(path, "---\nname: a\ndescription: d\n---\nReview the diff.\n", origin)` returns a resource whose `prompt` equals what `parseSkillFile` returns as `body` for a skill file with the same body text.
- [unit] `parseAgentFile` for a file with frontmatter and an empty body returns a resource whose `prompt` is the empty string.
- [unit] `buildResourceCatalog([pkg])` for a package with agents `a` and `b` returns `agents` with both resources in package order.
- [unit] `buildResourceCatalog` over a project package with agent `a` and a plugin package `p@m` with agent `a` returns `findAgent("a")` equal to the project agent.
- [unit] In that catalog, `findAgent("p:a")` returns the plugin agent.
- [unit] In that catalog, `diagnostics` contains a warn whose message is `agent a from p@m is shadowed by claude-project; use p:a`.
- [unit] In that catalog, `agents` has length 2.
- [unit] `buildResourceCatalog([])` returns `agents` equal to `[]`.
- [unit] `buildResourceCatalog([])` returns `findAgent("x")` equal to `undefined`.
- [unit] `formatPluginsListing` for a package with 2 agents prints `agents 2,` on that package line.
- [unit] `formatPluginsListing` for a package with 2 agents prints no `(not delivered yet)` text.
- [unit] `formatPluginsListing` for a package with 1 hooks entry still prints `hooks 1 (not executed)`.
- [integration] `loadResourceCatalog` over a fixture repo whose `.claude/agents/reviewer.md` has name `reviewer` and body `Check tests.` returns `findAgent("reviewer")?.prompt` starting with `Check tests.`.

### US-003 — Config: `agent.modelAliases`

- [unit] `NaxConfigSchema.parse({})` yields `agent.modelAliases` equal to `{}`.
- [unit] `NaxConfigSchema.parse({ agent: { protocol: "native" } })` yields `agent.modelAliases` equal to `{}`.
- [unit] `NaxConfigSchema.safeParse({ agent: { modelAliases: { sonnet: "anthropic/claude-sonnet-5-5" } } })` succeeds with that map.
- [unit] `NaxConfigSchema.safeParse({ agent: { modelAliases: { glm: "openrouter/z-ai/glm-5.3-flash[high]" } } })` succeeds.
- [unit] `NaxConfigSchema.safeParse({ agent: { modelAliases: { sonnet: "claude-sonnet" } } })` fails with an issue whose path includes `modelAliases`.
- [unit] `NaxConfigSchema.safeParse({ agent: { modelAliases: { sonnet: "a/" } } })` fails.
- [unit] `NaxConfigSchema.safeParse({ agent: { modelAliases: { sonnet: "/m" } } })` fails.
- [unit] `NaxConfigSchema.safeParse({ agent: { modelAliases: { sonnet: "a b/c" } } })` fails.
- [unit] The config descriptions registry has an entry for `agent.modelAliases`.

### US-004 — Subagent model and tool resolution

- [unit] `resolveSubagentModel({ requested: undefined, parentModel: "p/m", aliases: {}, tiers: {} })` returns `{ model: "p/m", source: "inherit" }`.
- [unit] `resolveSubagentModel` with `requested: "inherit"` and `parentModel: "p/m"` returns `{ model: "p/m", source: "inherit" }`.
- [unit] `resolveSubagentModel` with `requested: "sonnet"` and `aliases: { sonnet: "a/s" }` returns `{ model: "a/s", source: "alias" }`.
- [unit] `resolveSubagentModel` with `requested: "sonnet"`, `aliases: { sonnet: "a/s" }` and `tiers: { balanced: "b/t" }` returns `{ model: "a/s", source: "alias" }`.
- [unit] `resolveSubagentModel` with `requested: "haiku"`, `aliases: {}` and `tiers: { fast: "f/m" }` returns `{ model: "f/m", source: "tier" }`.
- [unit] `resolveSubagentModel` with `requested: "opus"` and `tiers: { powerful: { provider: "x", model: "y" } }` returns `{ model: "x/y", source: "tier" }`.
- [unit] `resolveSubagentModel` with `requested: "opus"`, `tiers: {}` and `parentModel: "p/m"` returns `{ model: "p/m", source: "fallback" }`.
- [unit] `resolveSubagentModel` with `requested: "openai/gpt-x"` and `aliases: {}` returns `{ model: "openai/gpt-x", source: "model" }`.
- [unit] `resolveSubagentModel` with `requested: "claude-opus-4"`, `aliases: {}`, `tiers: {}` and `parentModel: "p/m"` returns `{ model: "p/m", source: "fallback" }`.
- [unit] `mapSubagentTools(undefined)` returns `{ dropped: [] }` with no `allowedTools` key.
- [unit] `mapSubagentTools(["Read", "Grep", "Bash"])` returns `{ allowedTools: ["Read", "Grep", "Bash"], dropped: [] }`.
- [unit] `mapSubagentTools(["MultiEdit", "Edit"])` returns `allowedTools` `["Edit"]`.
- [unit] `mapSubagentTools(["Skill"])` returns `allowedTools` `["nax-skills__*"]`.
- [unit] `mapSubagentTools(["mcp__docs__search", "mcp__db"])` returns `allowedTools` `["docs__search", "db__*"]`.
- [unit] `mapSubagentTools(["Bash(git diff:*)"])` returns `allowedTools` `["Bash"]`.
- [unit] `mapSubagentTools(["Agent", "Task"])` returns `{ allowedTools: [], dropped: [{ name: "Agent", reason: "subagents cannot start subagents" }, { name: "Task", reason: "subagents cannot start subagents" }] }`.
- [unit] `mapSubagentTools(["Read", "WebFetch"])` returns `{ allowedTools: ["Read"], dropped: [{ name: "WebFetch", reason: "no nax equivalent" }] }`.
- [unit] `resolveSubagentModel` is importable from `@/chat`.
- [unit] `mapSubagentTools` is importable from `@/chat`.

### US-005 — Prompt builders for agents and subagents

- [unit] `cleanIndexDescription("a\n\n  b\u0007c")` returns `a bc`.
- [unit] `cleanIndexDescription` of a 300-character single-line text returns its first 200 characters.
- [unit] `buildSkillsInstructions` over a fixture skill whose description has a newline and a control character returns the same text as before this change.
- [unit] `buildChatInstructions({ mode: "guarded", rulesIndex: [] })` returns the same text as before this change.
- [unit] `buildChatInstructions({ mode: "full", rulesIndex: [] })` returns the same text as before this change.
- [unit] `buildAgentsInstructions([{ qualifiedName: "reviewer", description: "Reviews diffs" }])` has a first line naming `nax-agents__run`.
- [unit] That output contains the line `- reviewer: Reviews diffs`.
- [unit] `buildAgentsInstructions` for an agent whose description is `Line one\nLine two` contains the line `- reviewer: Line one Line two`.
- [unit] `buildAgentsInstructions` over 151 agents lists 150 agent lines.
- [unit] That output ends with the line `- ... and 1 more`.
- [unit] `buildSubagentInstructions({ agent, mode: "guarded", rulesIndex: [] })` returns text ending with the agent's `prompt`.
- [unit] `buildSubagentInstructions` with `mode: "guarded"` contains `chatPermissionParagraph("guarded")`.
- [unit] `buildSubagentInstructions` with `mode: "full"` contains `chatPermissionParagraph("full")`.
- [unit] `buildSubagentInstructions` with one rules index entry contains that entry's rules index line.
- [unit] `buildAgentsInstructions` and `buildSubagentInstructions` are importable from `@/prompts`.

### US-006 — The `nax-agents` provider

- [unit] `createAgentsProvider({ catalog, run })` returns a provider whose `id` is `nax-agents`.
- [unit] That provider's `kind` is `static`.
- [unit] That provider's `stages` is `["*"]`.
- [unit] For a catalog with no agents, the provider's `tools("/w")` resolves to `[]`.
- [unit] For a catalog with agent `reviewer`, the provider's `tools("/w")` resolves to one tool whose `localName` is `run`.
- [unit] That tool's `inputSchema.required` is `["agent", "task"]`.
- [unit] That tool's `inputSchema.additionalProperties` is `false`.
- [unit] The provider's `instructions("/w")` for a catalog with agent `reviewer` (description `Reviews diffs`) resolves to text containing `- reviewer: Reviews diffs`.
- [unit] The provider's `instructions("/w")` for a catalog with no agents resolves to `undefined`.
- [unit] Running the tool with `{ agent: "reviewer", task: "check it" }` and a context whose `signal` is `s` calls the injected `run` once with the `reviewer` resource, `"check it"` and `s`.
- [unit] Running the tool returns the injected `run`'s result unchanged.
- [unit] Running the tool with `{ agent: "reviewer" }` returns `isError: true` with content `[chat] run requires agent: string and task: string`.
- [unit] In that call, the injected `run` is not called.
- [unit] Running the tool with `{ agent: 1, task: "t" }` returns `isError: true` with content `[chat] run requires agent: string and task: string`.
- [unit] Running the tool with `{ agent: "reviewer", task: "  " }` returns `isError: true` with content `[chat] run requires agent: string and task: string`.
- [unit] Running the tool with `{ agent: "nobody", task: "t" }` over a catalog with agent `reviewer` returns `isError: true` with content `unknown agent nobody; available: reviewer`.
- [unit] Running the tool with `{ agent: "nobody", task: "t" }` over a catalog with 25 agents returns content listing exactly 20 qualified names after `available: `.
- [unit] Running the tool with `{ agent: "p:reviewer", task: "t" }` over a catalog where `p:reviewer` is a shadowed plugin agent calls the injected `run` with the plugin agent.
- [integration] Through `createAgentsProvider` over a catalog built by `buildResourceCatalog` from a package whose agent `reviewer` has prompt `Check tests.`, running the tool calls the injected `run` with an agent whose `prompt` is `Check tests.`.
- [unit] `createChatMcp` over a config whose `mcp.servers` has an enabled server `nax-agents` attaches no server `nax-agents`.
- [unit] In that call, `createChatMcp` returns a diagnostic whose message is `[resources] mcp server id nax-agents is reserved`.
- [unit] `createChatMcp` still returns a diagnostic `[resources] mcp server id nax-skills is reserved` for an enabled server `nax-skills`.

### US-007 — Nested session: options

- [unit] `runSubagent` with `mode: "guarded"` calls `_subagentSessionDeps.createAgentSession` with `profile` `ask`.
- [unit] `runSubagent` with `mode: "full"` calls `createAgentSession` with `profile` `full`.
- [unit] `runSubagent` with `mode: "guarded"` calls `_subagentSessionDeps.nativeBackend` with `bashApproval` `gated`.
- [unit] `runSubagent` with `mode: "full"` calls `nativeBackend` with `bashApproval` `raw`.
- [unit] `runSubagent` calls `nativeBackend` with `allowUnsandboxed` `true` and `allowUnsandboxedCommands` `true`.
- [unit] `runSubagent` calls `nativeBackend` with `loopHandlerRole` `subagent`.
- [unit] `runSubagent` calls `nativeBackend` with `loopHandlers` identical to the input's `loopHandlers`.
- [unit] `runSubagent` with `model: "a/s"` calls `nativeBackend` with `model` `a/s`.
- [unit] `runSubagent` with `allowedTools: ["Read"]` calls `nativeBackend` with `allowedTools` `["Read"]`.
- [unit] `runSubagent` with no `allowedTools` calls `nativeBackend` with options that have no `allowedTools` key.
- [unit] `runSubagent` with `toolProviders` `[skills, docs]` calls `nativeBackend` with `toolProviders` equal to `[skills, docs]`.
- [unit] `runSubagent` with `config.agent.native.catalogOverrides` holding one override calls `nativeBackend` with that `catalogOverrides` array.
- [unit] `runSubagent` with `config.execution.compaction` set calls `nativeBackend` with that `compaction` object.
- [unit] `runSubagent` calls `createAgentSession` with a `transcriptStore` returned by `_subagentSessionDeps.createMemoryTranscriptStore`.
- [unit] `runSubagent` with `cwd: "/repo"` calls `createAgentSession` with `workdir` `/repo`.
- [unit] `runSubagent` with `parentSessionId: "chat-1"` and agent `reviewer` calls `createAgentSession` with `metadata` `{ parentSessionId: "chat-1", subagent: "reviewer" }`.
- [unit] `runSubagent` with `config.execution.approvalTimeout` 120000 calls `createAgentSession` with `approvalTimeoutMs` 120000.
- [unit] `runSubagent` calls `createAgentSession` with `instructions` ending in the agent's `prompt`.
- [unit] `runSubagent` with `_subagentSessionDeps.resolveRuleSet` returning one rule calls `createAgentSession` with `instructions` containing that rule's index line.
- [unit] `runSubagent` calls `_subagentSessionDeps.resolveRuleSet` with `repoRoot` equal to the input's `repoRoot`.

### US-008 — Nested session: turn, result, failures and rule delivery

- [unit] `runSubagent` sends the task text as the nested session's only message.
- [unit] `runSubagent` calls the input's `onSession` with the nested session before the turn starts.
- [unit] `runSubagent` passes every nested event, in order, to its `onEvent` callback.
- [unit] When the nested turn ends `completed` with `output` `done`, `runSubagent` returns `{ content: "done" }`.
- [unit] When the nested turn ends `completed` with empty `output`, `runSubagent` returns content `(the subagent returned no text)`.
- [unit] When the nested turn ends `errored` with error message `boom`, `runSubagent` returns `isError: true` with content `subagent reviewer errored: boom`.
- [unit] When the nested turn ends `cancelled` with no error, `runSubagent` returns `isError: true` with content `subagent reviewer cancelled: cancelled`.
- [unit] When the nested turn ends `timed_out` with no error, `runSubagent` returns `isError: true` with content `subagent reviewer timed_out: timed_out`.
- [unit] Aborting the `signal` while the nested turn runs calls the nested session's `cancel`.
- [unit] With a `signal` already aborted, `runSubagent` returns `isError: true` with content `subagent reviewer cancelled: cancelled`.
- [unit] With a `signal` already aborted, `runSubagent` does not call `createAgentSession`.
- [unit] `runSubagent` calls the nested session's `close` once after a completed turn.
- [unit] `RULE_READ_ROLES` contains `subagent`.
- [unit] `RULE_WRITE_ROLES` contains `subagent`.
- [unit] The rule-delivery handlers, given a handler context with role `subagent`, act on a Write the same way they act for role `tui`.
- [unit] `runSubagent` calls the nested session's `close` once after an errored turn.
- [unit] When the nested session's `send` throws `Error("x")`, `runSubagent` returns `isError: true` with content `[chat] subagent reviewer failed: x`.
- [unit] When the nested session's `send` throws, `runSubagent` calls `close` once.
- [unit] When `createAgentSession` throws `Error("bad model")`, `runSubagent` returns `isError: true` with content `[chat] subagent reviewer failed: bad model`.

### US-009 — Chat host: agents provider and nested asks

- [integration] Through the host harness with a catalog holding agent `reviewer`, `start({ mode: "guarded", model })` passes `toolProviders` whose last provider has id `nax-agents`.
- [integration] Through the host harness with a catalog holding no agents, `start` passes `toolProviders` identical to `resources.toolProviders`.
- [integration] Through the host harness with agent `reviewer`, `resume({ id })` passes `toolProviders` whose last provider has id `nax-agents`.
- [integration] Through the host harness with agent `reviewer`, `switchTo({ mode: "full" })` reopens with `toolProviders` whose last provider has id `nax-agents`.
- [integration] Through `host.send` on a guarded host harness whose scripted session runs agent `reviewer` (`model: sonnet`) with `agent.modelAliases: { sonnet: "anthropic/claude-sonnet-5-5" }`, the nested backend gets `model` `anthropic/claude-sonnet-5-5`.
- [integration] In a send that runs agent `reviewer` with `tools: Read, WebFetch`, the nested backend gets `allowedTools` `["Read"]`.
- [integration] In a send that runs agent `reviewer`, the nested backend's `toolProviders` contain no provider whose id is `nax-agents`.
- [integration] In a send that runs agent `reviewer` on a guarded host, the nested session is created with `profile` `ask`.
- [integration] After `host.switchTo({ mode: "full" })`, a send that runs agent `reviewer` creates the nested session with `profile` `full`.
- [integration] In the host harness, aborting the `AbortSignal` the scripted session put on the tool's run context calls the nested session's `cancel`.
- [unit] Through `createSubagentRuns`, when a nested session emits `approval_requested` with `requestId` `n1` and `reason` `edit file`, the ask controller's `pending()` contains an ask with `requestId` `n1` and `reason` `[agent reviewer] edit file`.
- [unit] After that ask, `sessionFor("n1")` returns the nested session.
- [unit] Through the native host, resolving that ask with `host.asks.resolve("n1", "allow_once")` calls the nested session's `answer("n1", { decision: "allow" })`.
- [unit] In that resolve, the chat session's `answer` is not called.
- [unit] Through the native host, resolving a chat-session ask `p1` while a nested session runs calls the chat session's `answer("p1", { decision: "allow" })`.
- [unit] Through `createSubagentRuns`, a nested `question` with `requestId` `q1` and text `which file?` appears in `pending()` with `text` `[agent reviewer] which file?`.
- [unit] Through the native host, `host.asks.answerQuestion("q1", "a.ts")` calls the nested session's `answer("q1", { text: "a.ts" })`.
- [unit] Through the native host in full mode (the ask controller's `answer` closure is the host's `sessionFor` routing), a nested `approval_requested` with `requestId` `n2` is answered on the nested session with `{ decision: "allow" }`.
- [unit] Through the native host in full mode, that ask does not appear in `host.asks.pending()`.
- [unit] After the nested session emits `approval_resolved` for `n1`, `sessionFor("n1")` returns `undefined`.
- [unit] After the nested session closes, `sessionFor` returns `undefined` for every request id it issued.

### US-010 — Chat host: subagent spend and tool events

- [unit] `createChatLedger(...).record(event, previousAt, model, "subagent")` writes a cost row whose `sessionRole` is `subagent`.
- [unit] `createChatLedger(...).record(event, previousAt, model)` writes a cost row whose `sessionRole` is `tui`.
- [unit] Through `createSubagentRuns`, a nested `usage` event is recorded by the ledger with an event whose `sessionId` is the chat session's id.
- [unit] In that record, the model argument is the agent's resolved model.
- [unit] In that record, the role argument is `subagent`.
- [unit] In that record, the `previousAt` argument is the nested `turn_start` event's `at`.
- [unit] Through `createSubagentRuns`, after a nested `turn_end` with `costUsd` 0.4, `takeCost()` returns 0.4.
- [unit] A second `takeCost()` call right after returns 0.
- [unit] `runChatTurn` with `extraCostUsd: () => 0.25` and a chat `turn_end` with `costUsd` 1 writes session metadata whose `costUsd` grows by 1.25.
- [unit] `runChatTurn` with no `extraCostUsd` and a chat `turn_end` with `costUsd` 1 writes session metadata whose `costUsd` grows by 1.
- [integration] Through the host harness, after a send in which the nested turn ends with `costUsd` 0.4 and the chat turn ends with `costUsd` 1, `host.current().meta.costUsd` grew by 1.4.
- [integration] Through the host harness, a nested `tool_call` event is passed to that send's `onEvent`.
- [integration] Through the host harness, a nested `tool_result` event is passed to that send's `onEvent`.
- [integration] Through the host harness, a nested `text_delta` event is not passed to that send's `onEvent`.
- [integration] Through the host harness, when the scripted chat session's `send` throws after a nested turn ended with `costUsd` 0.4, the next send whose chat turn ends with `costUsd` 1 grows `host.current().meta.costUsd` by 1, not 1.4.
- [integration] Through the host harness, `host.cancel()` while a nested session runs calls that nested session's `cancel`.
- [integration] Through the host harness, `host.close()` while a nested session runs resolves only after that nested session's `close` has resolved.

### US-011 — `/agents`

- [unit] `formatAgentsListing([])` returns `(no agents)`.
- [unit] `formatAgentsListing` for a row `{ name: "reviewer", description: "Reviews diffs", model: "a/s", modelSource: "alias", tools: ["Read"], dropped: [] }` returns `reviewer  a/s (alias)  tools Read  Reviews diffs`.
- [unit] `formatAgentsListing` for a row whose `tools` is `"all"` prints `tools all`.
- [unit] `formatAgentsListing` for a row whose `tools` is `[]` prints `tools none`.
- [unit] `formatAgentsListing` for a row with `dropped: [{ name: "WebFetch", reason: "no nax equivalent" }]` prints a following line `  dropped: WebFetch (no nax equivalent)`.
- [unit] `formatAgentsListing` for a row whose description is `a\nb` prints `a b` on the agent's line.
- [unit] The native host's `agents()` with no catalog agents returns `[]`.
- [unit] The native host's `agents()` for agent `reviewer` with `model: sonnet` and `agent.modelAliases: { sonnet: "a/s" }` returns a row with `model` `a/s`.
- [unit] That row's `modelSource` is `alias`.
- [unit] The native host's `agents()` for an agent with no `model` returns a row whose `model` is the chat session's current model and `modelSource` is `inherit`.
- [unit] The native host's `agents()` for an agent with no `tools` returns a row whose `tools` is `all`.
- [unit] The native host's `agents()` for agent `p:reviewer` shadowed by a project `reviewer` returns rows named `reviewer` and `p:reviewer` in catalog order.
- [integration] `runSlashCommand` for `/agents` on a native host built by `createChatHost` with a fixture catalog agent `reviewer` calls `show` with text whose first line starts with `reviewer`.
- [unit] `runSlashCommand` for `/agents` on a host without `agents` calls `show` with `(no agents)`.
- [unit] `/help` output lists `/agents` between `/mcp` and `/quit`.
- [unit] `/agents` is blocked while a turn runs, like every other built-in slash command.
- [unit] `ChatAgentRow` and `formatAgentsListing` are importable from `@/chat`.
