<!-- spec-writing: completed-through-phase-5 -->
# SPEC: background-agents-and-forge-kind — explicit forge kind, `~/.agents/skills`, turn-end reasons, background subagents in `nax chat`

Closes: #2957, #2959, #2930

## Summary

Three independent fixes in one feature, bundled at the user's request (2026-11-16).

1. **Explicit forge kind (#2957).** `NAX_FORGE_KIND=github|gitlab`, read once at CLI start, and a config key `forge.kind` name the forge for a repo whose `origin` host names neither GitHub nor GitLab. The env var wins over the config key, and either one wins over detection. An invalid env value stops the CLI with a message naming the accepted values; an invalid config value fails config validation. `detectForge` and the auto-PR post-run action both honour it. With neither set, detection is unchanged.
2. **User skills from `~/.agents/skills` (#2959).** The chat resource catalog loads one-level skills from `~/.agents/skills/<name>/SKILL.md` as a new `agents-user` package, placed after the repo package and `nax-user` and before the Claude Code user and plugin packages. It loads with `resources.claudeCode: false` too.
3. **Long subagents survive the parent turn (#2930).** `nax-agents__run` gains `runInBackground`, like the `Bash` tool: the call returns at once with a task id (`agent-<8 hex>`), the subagent keeps running after the parent turn ends, it is listed, read and stopped through the existing `nax-tasks__list` / `nax-tasks__output` / `nax-tasks__stop` tools, it counts in the footer as `N agent(s)`, and a `[nax-tasks]` notice delivers its end to the chat. A foreground run is unchanged. In addition, an abandoned tool call names why its turn ended for the native adapter's whole-turn deadline and active-call cancel (idle watchdog or soft cancel) and for the ACP client's own turn-end, tool-host and agent-exit aborts: nax aborts them with a `TurnEndAbort` reason (named `AbortError`, so the abort contract holds) and the abandoned text names it. The Esc cause of #2930 was fixed in #2958; this feature closes the issue.

## Motivation

- #2957: `detectForge` (`packages/nax/src/forge/detect.ts`) classifies `origin` by host name, then falls back to a CLI probe that decides only when exactly one of `gh` / `glab` is installed. A self-hosted GitLab on a neutral host (`git.corp.example`) resolves to `null` on any machine with both CLIs, which is exactly a shared job runner serving GitHub and GitLab repos. Bot review, bot fix, workflow publish and promote then cannot run. The auto-PR post-run action (`plugins/builtin/auto-pr/index.ts`) uses only `forgeFromRemoteUrl` and never probes, so it skips the same repo.
- #2959: chat skills come only from Claude Code locations (`.claude/skills/`, `~/.claude/skills/`, enabled Claude Code plugins). Skills a user installed under `~/.agents/skills/` (13 on the reporting machine) never reach the chat catalog.
- #2930: a `code-reviewer` subagent run through `nax-agents__run` was lost when its parent turn ended (`Tool "nax-agents__run" was abandoned: the turn ended.`); the rerun took 561 s. Every subagent run is tied to its parent send: `ChatHost` awaits `runs.settle()` in the send's `finally`, and `settle()` cancels every run in flight, and `cancel()` (Esc) calls `runs.cancelAll()`. #2947 made the abandoned text name the turn controller's `NaxError` reason, but the native adapter's own whole-turn deadline and active-call cancel abort with no reason, and the ACP client's `abandoned(name)` names none, so those turn ends still read only `the turn ended.`.

## Design

### Approach

**US-001 — explicit forge kind.** A new module `packages/nax/src/forge/kind.ts`:

```ts
// packages/nax/src/forge/kind.ts
import type { ForgeKind } from "./types";

export const FORGE_KIND_ENV = "NAX_FORGE_KIND";

/** Process-local, `_deps` style; tests set it and reset it to undefined in afterEach. */
export const _forgeKind: { current: ForgeKind | undefined } = { current: undefined };

export const _forgeKindDeps: {
  /** `forge.kind` from the config resolved for `repoRoot`; the default loads it with `loadConfig(repoRoot)`. */
  configuredKind(repoRoot: string): Promise<ForgeKind | undefined>;
};

/** Read `NAX_FORGE_KIND`, store it in `_forgeKind.current`, and return it. Throws NaxError FORGE_KIND_INVALID. */
export function captureForgeKind(env: Record<string, string | undefined>): ForgeKind | undefined;

/** `_forgeKind.current`, else `forge.kind` of the config for `repoRoot`, else undefined. */
export async function resolveExplicitForgeKind(repoRoot: string): Promise<ForgeKind | undefined>;
```

`captureForgeKind` trims the value. Unset or whitespace-only is absent: it sets `_forgeKind.current` to `undefined` and returns `undefined`. `github` and `gitlab` (exact, lower case) are accepted. Any other value throws `NaxError` code `FORGE_KIND_INVALID`, stage `forge`, message:

```
[forge] Invalid NAX_FORGE_KIND "<value>": expected github or gitlab
```

and leaves `_forgeKind.current` `undefined`. `bin/nax.ts` calls `captureForgeKind(process.env)` inside the existing `try` that calls `captureForgeIdentity(process.env)`, so a refused value prints the message and exits 1 before any command runs.

The default `_forgeKindDeps.configuredKind` loads `loadConfig(repoRoot)` through a dynamic `import("@/config")` (the forge module does not import config statically) and returns `config.forge?.kind`. A `loadConfig` rejection yields `undefined`: the command that needs a forge already loaded its config, so a failure here leaves detection to decide.

Config key: a new top-level `forge` block.

```ts
// packages/nax/src/config/schemas-forge.ts
export const ForgeConfigSchema = z.object({
  kind: z.enum(["github", "gitlab"]).optional(),
});
// schemas.ts: forge: ForgeConfigSchema.optional()   (no .prefault / .default: `forge` stays absent from DEFAULT_CONFIG)
// packages/nax/src/config/runtime-types-forge.ts
export interface ForgeConfig { kind?: "github" | "gitlab" }
// runtime-types.ts NaxConfig: forge?: import("./runtime-types-forge").ForgeConfig;
```

`ForgeDeps` gains an optional `explicitKind?(repoRoot: string): Promise<ForgeKind | undefined>`; optional so a fake written before this feature keeps today's detection. `defaultForgeDeps.explicitKind` is `resolveExplicitForgeKind`. Every production forge call site takes `defaultForgeDeps` (`cli/workflow-forge.ts`, `workflow/ci-failures.ts`, `workflow/feature-deps.ts`, `bot/review-deps.ts`, `bot/pr-head-wait.ts`), so all of them gain the override through `detectForge`.

`detectForge(deps, repoRoot)` asks `deps.explicitKind?.(repoRoot)` first and returns the answer when it is defined, without reading `origin` or probing a CLI. Otherwise it behaves exactly as today.

The auto-PR action gets one new dep, `_autoPrDeps.capturedForgeKind: () => ForgeKind | undefined`, default reading `_forgeKind.current`. It already holds the run's resolved config, but `PostRunContext.config` is typed `unknown` (`plugins/extensions.ts`), so a new helper reads the key the way `getAutoPrConfig` reads `autoPr`: `configuredForgeKind(context: PostRunContext): ForgeKind | undefined` casts `context.config` to `Record<string, unknown>`, reads `forge.kind`, and returns it only when it is `"github"` or `"gitlab"` (anything else is `undefined`). One resolver, `autoPrForge(context, remoteUrl) = _autoPrDeps.capturedForgeKind() ?? configuredForgeKind(context) ?? _autoPrDeps.detectForge(remoteUrl)`, serves both `shouldRun` and `execute`, without loading config again; the remote URL is still read first, because `execute` pushes to `origin`. `captureForgeKind`, `resolveExplicitForgeKind`, `_forgeKind` and `FORGE_KIND_ENV` are exported from the `forge/index.ts` barrel (`bin/nax.ts` imports from it).

`resolveExplicitForgeKind` reads the config `loadConfig(repoRoot)` resolves: global then project layers and the `NAX_PROFILE` profile chain, but no `--profile` given on the command line of the command calling it; `forge.kind` set only through a CLI `--profile` is not seen by `detectForge` (it is seen by auto-PR, which reads the run's config).

**US-002 — `~/.agents/skills`.** A path helper next to `naxAgentsDir`:

```ts
// packages/nax/src/resources/claude-paths.ts
/** The user-level skills directory other coding agents read: `<home>/.agents/skills`. */
export function agentsSkillsDir(): string; // join(_claudePathsDeps.homedir(), ".agents", "skills")
```

`ResourceOrigin` gains `{ readonly kind: "agents-user" }`, and `originLabel` returns `"agents-user"` for it. `loadResourceCatalog` builds an `agents-user` package beside `naxUserPackage`: `scanSkillsDir(agentsSkillsDir(), { kind: "agents-user" })`, id `"agents-user"`, `root` = that directory, skills only (no commands, agents, MCP servers or hooks). An absent directory yields no package and no diagnostic, as `naxUserPackage` does. The package loads whatever `config.resources.claudeCode` says. Package order: `claude-project`, `nax-user`, `agents-user`, then `claude-user` and Claude plugins, then nax plugin packages; with no repo package, `nax-user` then `agents-user` come first. `withNaxUser` (`catalog.ts`) takes the list of user packages to insert (`nax-user`, `agents-user`, each optional) instead of one, so the insertion point rule is unchanged. `loadResourceCatalog` is shared, so every catalog consumer sees `agents-user` skills by design: `nax chat`, `nax agents run`, the `nax run` skills provider (`runtime/index.ts`) and `nax mcp`. `buildResourceCatalog` keeps first-wins name resolution, so a repo skill wins a name clash with an `agents-user` skill, which wins over a `~/.claude/skills` or plugin skill.

Because `agentsSkillsDir()` reads the real home directory, catalog tests that call `loadResourceCatalog` set `_claudePathsDeps.homedir` to a temporary directory (see `### Modifies`).

**US-003 — native turn-end reasons.** In `NativeSessionAdapter.sendTurn` (`packages/nax-agent/src/native/session-adapter.ts`), the two reasonless aborts get a reason that keeps the `AbortError` contract. `turn-loop-round-trip.ts` rethrows `signal.reason` verbatim, and `session/manager.ts` and `watchdog-turn-classification.ts` key on `err.name === "AbortError"` (neither on the message nor on the reason's identity). A bare `abort()` already yields a `DOMException` named `AbortError` with the runtime's own message (`The operation was aborted.` under Bun), so the reason nax gives must be recognisable as nax's own, not by its name. A new class tags it:

```ts
// packages/nax-agent/src/session/turn-end-abort.ts
/** An abort reason nax gave on purpose: named AbortError (the abort contract), carrying why the turn ended. */
export class TurnEndAbort extends Error {
  override readonly name = "AbortError";
}
```

- the whole-turn deadline timer (armed with `deadline.remainingMs()`) calls `deadlineController.abort(new TurnEndAbort("native turn deadline of <timeoutSeconds>s reached"))`;
- the active-call cancel registered through `hooks.onActiveCall` calls `turnController.abort(new TurnEndAbort("turn cancelled by its active-call cancel (idle watchdog or soft cancel)"))`.

`abandonedToolMessage(name, signal)` (`session/session-interaction.ts`) gains a branch:

| `signal.reason` | Result |
|:---|:---|
| a `NaxError` | `Tool "<name>" was abandoned: the turn ended (<code>: <message>).` (unchanged) |
| a `TurnEndAbort` | `Tool "<name>" was abandoned: the turn ended (<message>).` |
| anything else, including the `DOMException` of a bare `abort()` | `Tool "<name>" was abandoned: the turn ended.` (unchanged) |

Existing tests that abort with no argument and assert the bare text (`session-interaction-abandoned.test.ts`, `session-interaction-cancel-grace.test.ts`, `native-backend-providers.test.ts`) stay green unchanged. The per-round-trip timer (`controller.abort()` for one complete or summarize call) keeps no reason.

**US-004 — ACP abandoned reason.** In `packages/nax-agent-acp/src/client/tool-calls.ts`, `abandoned(name)` becomes `abandoned(name, signal)`, with the same rule as US-003. The ACP package keeps its own copies, because neither `abandonedToolMessage` nor `TurnEndAbort` is exported from `@nathapp/nax-agent`'s public entry: a new `packages/nax-agent-acp/src/client/turn-end-abort.ts` exports `class TurnEndAbort extends Error { override readonly name = "AbortError" }` and `abandonedText(name: string, signal: AbortSignal): string` (`NaxError` reason gives `(<code>: <message>)`, a `TurnEndAbort` reason gives `(<message>)`, anything else the bare text). Both callers pass the signal they raced (`ctx.signal` in `invoke`, `signal` in `run`). The reasonless sources get `TurnEndAbort` reasons:

- `client/tool-host.ts`: `gone.abort(new TurnEndAbort("the agent closed the tool request"))` when the HTTP response closes, and `state.stopped.abort(new TurnEndAbort("the tool host stopped"))` in `stop()`;
- `client/inbound.ts`: the binding's `scope.abort()` on detach becomes `scope.abort(new TurnEndAbort("the ACP prompt turn ended"))`;
- `client/backend.ts`: `gone.abort()` when the agent process exits becomes `gone.abort(new TurnEndAbort("the agent process exited"))`.

A caller's own cancel or timeout signal keeps whatever reason it carried; a `NaxError` reason is named as today. Existing ACP tests that abort with no argument and assert the bare text (`tool-calls.test.ts`, `backend-tools.test.ts`) stay green unchanged.

**US-005 — background agent tasks in the registry.** `packages/nax/src/chat/background/task-types.ts`:

```ts
export interface BackgroundTask {
  // existing fields unchanged
  /** Absent for a shell command; "agent" for a background subagent run. */
  readonly kind?: "agent";
}

export const TASK_ID_PATTERN = /^(bash|agent)-[0-9a-f]{8}$/;

export type BackgroundAgentOutcome = "succeeded" | "failed" | "stopped";
export interface BackgroundAgentEnd {
  readonly outcome: BackgroundAgentOutcome;
  /** The subagent's final answer, or the error text of a failed run. */
  readonly text: string;
}
export interface BackgroundAgentHandle {
  /** The qualified agent name the run resolved to (`general` for the built-in agent). */
  readonly agent: string;
  readonly task: string;
  /** Always resolves. */
  readonly ended: Promise<BackgroundAgentEnd>;
  stop(): void;
}
export interface BackgroundAgentSink {
  readonly id: string;
  /** Append one line to the task log while the task runs. */
  appendLine(line: string): void;
}

export interface ChatBackgroundTasks extends BackgroundCommandPort {
  // existing members unchanged
  adoptAgent(handle: BackgroundAgentHandle): BackgroundAgentSink;
}
```

`adoptAgent` allocates `agent-<8 hex>`: the registry's private `newId()` takes the prefix (`"bash"` for `adopt`, `"agent"` for `adoptAgent`) with the same attempt limit and `TASK_ID_PATTERN` check, records `{ id, kind: "agent", command: "<agent>: <task first line, at most 80 characters>", origin: "agent", state: "running", startedAt, logPath: <outputDir>/chat-tasks/<id>.log }`, writes the line `[nax] agent <agent>: <task first line>` to the log, and follows `handle.ended`. On end it appends `text`, then `[nax] agent ended: <outcome>`, and sets `state` to `outcome` (a task already `stopped` stays `stopped`) with no `exitCode`. `succeeded` and `failed` join the unnoticed set exactly as a shell's do. `stop(id)` on a running agent task calls `handle.stop()` and marks it `stopped`, as for a shell; `stopAll()` covers agent tasks.

`buildBackgroundTaskNotice` writes an agent task's line as:

```
[nax-tasks] background agent <id> (<command>) ended: <state>, log <logPath>
```

and a shell task's line unchanged; the final follow-up line is unchanged.

`summarizeBackgroundNotice` (`prompts/builders/notice-summary.ts`) recognises both lines: `TASK_LINE` becomes `^\[nax-tasks\] background (command|agent) \S+ \(.*?\) ended: (\S+?),`, and the summary noun follows the kinds counted: only shell lines keep today's `N background command(s) ended`, only agent lines give `N background agent(s) ended`, and a mix gives `N background tasks ended`; the per-state counts follow as today.

`ChatBackgroundTasks` gains a required `adoptAgent`. UI test fakes that build `ChatBackgroundTasks` literals (`test/ui/chat/jobs-opener.test.tsx`, `jobs-picker.test.tsx`, `jobs-picker-stop.test.tsx`, `footer-shells.test.tsx`) are not type-checked (the package tsconfig excludes `test/`) and none of their paths calls `adoptAgent`, so they need no change. `buildBackgroundTasksInstructions` gains one line: `` Use `nax-agents__run` with `runInBackground` for a long subagent task (a review, a broad investigation): it keeps running after your turn ends, it is listed and stopped like a background command, and a [nax-tasks] notice arrives when it ends. ``

Footer (`packages/nax/src/tui/chat/chat-status.ts`): `FooterTask` gains `readonly kind?: "agent"`. `formatJobStrip` replaces the single count part with up to two parts, shells first: `N shell(s)` counting tasks without `kind`, and `N agent(s)` counting `kind: "agent"` tasks; a part with a zero count is omitted. `useJobs` already passes `tasks.running()` records, which now carry `kind`.

**US-006 — `runInBackground` on `nax-agents__run`.**

```ts
// packages/nax/src/chat/agents-provider.ts
export interface AgentsProviderOptions {
  readonly catalog: ResourceCatalog;
  readonly run: (agent: AgentResource, task: string, signal: AbortSignal | undefined, model?: string) => Promise<ToolResult>;
  /** Starts a background run; absent when the chat has no background task registry. */
  readonly runInBackground?: (agent: AgentResource, task: string, model?: string) => Promise<ToolResult>;
}
```

The `run` tool's `inputSchema.properties` gains `runInBackground: { type: "boolean" }`; `required` stays `["task"]` and `additionalProperties` stays `false`. `RUN_DESCRIPTION` gains the sentence `` Set "runInBackground": true to return at once with a task id; the agent keeps running after your turn ends and a notice arrives when it ends. `` placed after the general-agent sentence and before `${EXPLORE_SENTENCE}`, so the description still ends with the explore sentence. Input rules, in order after today's checks: a present `runInBackground` that is not a boolean returns the error result `[chat] run runInBackground must be a boolean`; `runInBackground: true` with no `options.runInBackground` returns `[chat] runInBackground is not available in this chat`; `runInBackground: true` otherwise calls `options.runInBackground(agent, task)`, or `options.runInBackground(agent, task, model)` when `model` is given (the resolved agent: the built-in general agent for a missing agent, as today), and never calls `options.run`. `runInBackground: false` or absent calls `options.run` exactly as today, with the same arguments.

```ts
// packages/nax/src/chat/subagent-runs.ts
export interface SubagentRunsDeps {
  // existing fields unchanged
  /** The chat's background task registry, read per call; undefined when the chat has none. */
  readonly backgroundTasks?: () => ChatBackgroundTasks | undefined;
}
export interface SubagentRuns {
  // existing members unchanged
  /** Start `agent` in the background; resolves at once with the started text or an error result. */
  runInBackground(agent: AgentResource, task: string, model?: string): Promise<ToolResult>;
}
```

`runInBackground` resolves the model as `run` does; a refused override returns the same unknown-model error result. With `deps.backgroundTasks?.()` undefined it returns `{ isError: true, content: "[chat] runInBackground is not available in this chat" }`. Otherwise it creates its own `AbortController` linked to no parent signal, starts the nested run with `runNested`'s session wiring (asks routed through `routeAsk`, usage recorded on `deps.ledger()`, spend added to `spentUsd`), adopts it with `adoptAgent({ agent: agent.qualifiedName, task, ended, stop })`, and returns `{ isError: false, content: "started in the background as <id>" }`. A background run is kept in its own set, never in `inFlight`, so `cancelAll()` and `settle()` (turn end, Esc) do not reach it. Its tool events are not forwarded to a turn listener; each `tool_call` event appends `[tool] <toolName>` to its log through the sink. `stop()` aborts its controller before the session opens and calls `session.cancel()` after. `ended` resolves `{ outcome: "succeeded", text: <result content> }` for a non-error result, `{ outcome: "failed", text }` for an error result or a thrown error (its message), and `{ outcome: "stopped", text }` when stopped. `closeAll()` also closes background sessions (they are in `active`).

An approval request or question from a background run goes to `deps.asks.handle` exactly as a foreground run's does; the chat's ask controller shows it whether or not a turn is running, and an unanswered approval ends at the configured approval timeout as today. Stopping the task or closing the chat releases its pending asks through `release(session)` (denied, `decidedBy: "cancelled"`).

`ChatHost` passes `backgroundTasks: () => this.tasks` to `createSubagentRuns` and `runInBackground: this.runs.runInBackground` to `createAgentsProvider` when `this.tasks` is defined.

### Integration (extends existing code)

Read only (verified on `main` `9985f81c1`):

- `captureForgeIdentity(env)` — `packages/nax/src/forge/identity.ts`; called at `packages/nax/bin/nax.ts:135` inside a `try` that prints the message and `process.exit(1)`.
- `forgeFromRemoteUrl(remoteUrl: string): ForgeKind | null` — `forge/detect.ts`.
- `loadConfig(startDir?: string, cliOverrides?): Promise<NaxConfig>` — `config/loader.ts:247`.
- `naxAgentsDir(env)`, `_claudePathsDeps` — `resources/claude-paths.ts`; `naxUserPackage`, `withNaxUser`, `loadResourceCatalog` — `resources/catalog.ts`; `scanSkillsDir(dir, origin)` — `resources/scan-dirs.ts`.
- `raceAbort`, `raceCancelGrace`, `callTool` — `nax-agent/src/session/session-interaction.ts`.
- `routeAsk`, `routeActivity`, `release`, `runNested`, `inFlight` — `nax/src/chat/subagent-runs.ts`.
- `createHostTasks` — `chat/background/host-tasks.ts`; `nax-tasks` provider — `chat/background/tasks-provider.ts` (validates ids with `TASK_ID_PATTERN`).
- `useJobs` — `tui/chat/use-jobs.ts` (passes `tasks.running()` to the footer and delivers `tasks.peekNotice()` when idle).

Changed symbols. The baseline exists only to locate the code; implement the target.

- `detectForge` — `forge/detect.ts`. Baseline: reads `origin`, classifies by host, else CLI probe. Target: `deps.explicitKind?.(repoRoot)` first; a defined answer is returned without reading `origin`.
- `ForgeDeps` — `forge/types.ts`. Target adds `explicitKind?(repoRoot: string): Promise<ForgeKind | undefined>`.
- `defaultForgeDeps` — `forge/deps.ts`. Target adds `explicitKind: resolveExplicitForgeKind`.
- `_autoPrDeps` — `plugins/builtin/auto-pr/index.ts`. Target adds `capturedForgeKind` and the helper `configuredForgeKind(context)`; `shouldRun` / `execute` share `autoPrForge(context, remoteUrl)`, which prefers the captured kind, then `configuredForgeKind(context)`, over `detectForge(remoteUrl)`.
- `NaxConfigSchema` / `NaxConfig` — target adds optional `forge`.
- `ResourceOrigin` — `resources/types.ts`. Target adds `{ kind: "agents-user" }`; `originLabel` (`resources/listing.ts`) returns `"agents-user"`.
- `loadResourceCatalog` — target inserts the `agents-user` package after `nax-user`.
- `NativeSessionAdapter.sendTurn` — the two `abort()` calls gain `TurnEndAbort` reasons.
- `abandonedToolMessage` — gains the `TurnEndAbort` branch.
- `abandoned` in `nax-agent-acp/src/client/tool-calls.ts` — Baseline `abandoned(name)`; Target `abandoned(name, signal)`.
- `BackgroundTask`, `TASK_ID_PATTERN`, `ChatBackgroundTasks` — `chat/background/task-types.ts`, as above.
- `buildBackgroundTaskNotice`, `buildBackgroundTasksInstructions` — `prompts/builders/background-builder.ts`.
- `FooterTask`, `formatJobStrip` — `tui/chat/chat-status.ts`.
- `AgentsProviderOptions`, `createAgentsProvider`, `RUN_DESCRIPTION` — `chat/agents-provider.ts`.
- `SubagentRunsDeps`, `SubagentRuns`, `createSubagentRuns` — `chat/subagent-runs.ts`.
- `ChatHost` constructor wiring — `chat/chat-host.ts` (`createSubagentRuns` at about line 197, `createAgentsProvider` at about line 215).

### Failure Handling

| Case | Behaviour |
|:---|:---|
| `NAX_FORGE_KIND` set to a value other than `github` / `gitlab` | `captureForgeKind` throws `FORGE_KIND_INVALID` naming the value and the accepted values; the CLI exits 1 |
| `forge.kind` in config set to another value | config validation fails like any invalid key |
| `loadConfig` rejects inside `resolveExplicitForgeKind` | no explicit kind; detection decides |
| `~/.agents/skills` absent | no `agents-user` package, no diagnostic |
| a malformed `SKILL.md` under `~/.agents/skills` | the skill is skipped; its diagnostic carries origin `agents-user` |
| `runInBackground` not a boolean | error result `[chat] run runInBackground must be a boolean` |
| `runInBackground: true` with no task registry | error result `[chat] runInBackground is not available in this chat` |
| a background subagent throws | task ends `failed`, the error message is in its log, a notice is delivered |
| a background subagent is stopped | task ends `stopped`, no notice (as for a stopped shell) |
| a background subagent asks while no turn runs | the ask goes to the chat's ask controller; an unanswered approval ends at the approval timeout |

## Out of Scope

- `NAX_FORGE_KIND` does not change forge identity, tokens or which CLI login is used; it only names the forge kind.
- A per-remote or per-host forge map (several forges in one config) is not added; `forge.kind` names one forge for the whole project config.
- A repo-level `.agents/skills/` directory is not loaded; only the user-level `~/.agents/skills/`.
- Skills under `~/.agents/skills` are not given an env-var override for their location.
- A background subagent's spend is added to the chat's nested spend and is reported on the next turn's cost row, not on the turn that started it.
- A background subagent's tool calls are not shown in the transcript; they are written to its task log.
- A subagent cannot itself start background subagents or background shell commands (nested sessions get no background registry, as today).
- A foreground `nax-agents__run` keeps today's lifecycle: it is cancelled when its parent turn ends or is stopped.
- Background subagents do not survive closing the chat; close stops them with the other background tasks.
- The idle watchdog's and turn deadline's thresholds are not changed; only their abort reasons.
- No cap on the number of concurrent background subagents is added; each one is listed in the footer and can be stopped.
- The `nax-tasks__list` / `output` / `stop` tool descriptions and the close-confirm wording ("background command(s)") are not reworded for agents.
- The native adapter's per-round-trip timer (one complete or summarize call) keeps aborting with no reason.
- `forge.kind` set only through a command-line `--profile` is not seen by `detectForge`; it reads the config `loadConfig(repoRoot)` resolves.
- `forge.kind` is not pinned as a root-only key; a per-package config may set it like any other key.

## Stories

### US-001 — explicit forge kind from `NAX_FORGE_KIND` and `forge.kind`

Workdir: packages/nax. No dependencies.

`captureForgeKind`, `resolveExplicitForgeKind`, the `forge` config block, `ForgeDeps.explicitKind`, `detectForge` preferring it, the CLI-start capture, and the auto-PR action preferring the captured kind and the run's `forge.kind`.

### US-002 — user skills from `~/.agents/skills`

Workdir: packages/nax. No dependencies.

`agentsSkillsDir`, the `agents-user` origin and label, and the `agents-user` package in `loadResourceCatalog`.

### US-003 — native turn ends name their reason

Workdir: packages/nax-agent. No dependencies.

`TurnEndAbort`, reasons on the native adapter's deadline and active-call cancel, and the `TurnEndAbort` branch of `abandonedToolMessage`.

### US-004 — ACP abandoned tool results name their reason

Workdir: packages/nax-agent-acp. No dependencies.

The ACP copies of `TurnEndAbort` and the abandoned text, `abandoned(name, signal)`, and reasons on the tool host's, inbound binding's and backend's aborts.

### US-005 — background agent tasks in the chat task registry, notices and footer

Workdir: packages/nax. No dependencies.

`adoptAgent`, the `agent-` ids, agent task logs and end states, the agent notice line and its transcript summary, the instructions line, and the `N agent(s)` footer part.

### US-006 — `nax-agents__run` accepts `runInBackground`

Workdir: packages/nax. No dependencies.

The `runInBackground` input on the `run` tool, the new description sentence, and the `AgentsProviderOptions.runInBackground` callback.

### US-007 — background subagent runs and their chat wiring

Workdir: packages/nax. Depends on US-005, US-006.

`SubagentRuns.runInBackground`, its exclusion from `cancelAll` / `settle`, its log, end states and asks, and the `ChatHost` wiring that hands it to the provider.

### Context Files

**US-001**
- `packages/nax/src/forge/detect.ts` — `detectForge`, `forgeFromRemoteUrl`
- `packages/nax/src/forge/identity.ts` — `captureForgeIdentity` (capture pattern to mirror)
- `packages/nax/src/forge/deps.ts` — `defaultForgeDeps`
- `packages/nax/src/plugins/builtin/auto-pr/index.ts` — `_autoPrDeps`, `shouldRun`, `execute`
- `packages/nax/bin/nax.ts` — CLI-start capture block

**US-002**
- `packages/nax/src/resources/catalog.ts` — `naxUserPackage`, `withNaxUser`, `loadResourceCatalog`
- `packages/nax/src/resources/claude-paths.ts` — `naxAgentsDir`, `_claudePathsDeps`
- `packages/nax/src/resources/listing.ts` — `originLabel`
- `packages/nax/test/unit/resources/nax-user-agents.test.ts` — fixture pattern for user-level packages

**US-003**
- `packages/nax-agent/src/native/session-adapter.ts` — `sendTurn` deadline and active-call cancel
- `packages/nax-agent/src/session/session-interaction.ts` — `abandonedToolMessage`
- `packages/nax-agent/src/native/session/turn-loop-round-trip.ts` — the `AbortError` contract comment

**US-004**
- `packages/nax-agent-acp/src/client/tool-calls.ts` — `abandoned`, `invoke`, `run`
- `packages/nax-agent-acp/src/client/tool-host.ts` — `gone`, `state.stopped`
- `packages/nax-agent-acp/src/client/inbound.ts` — `attach` scope
- `packages/nax-agent-acp/src/client/backend.ts` — `gone` on agent process exit

**US-005**
- `packages/nax/src/chat/background/task-registry.ts` — `BackgroundTasks`, `adopt`, `finalize`, `stop`
- `packages/nax/src/chat/background/task-types.ts` — `BackgroundTask`, `TASK_ID_PATTERN`, `ChatBackgroundTasks`
- `packages/nax/src/prompts/builders/background-builder.ts` — notice and instructions
- `packages/nax/src/prompts/builders/notice-summary.ts` — `summarizeBackgroundNotice`, `TASK_LINE`
- `packages/nax/src/tui/chat/chat-status.ts` — `FooterTask`, `formatJobStrip`

**US-006**
- `packages/nax/src/chat/agents-provider.ts` — `createAgentsProvider`, `targetOf`, `RUN_DESCRIPTION`
- `packages/nax/test/unit/chat/agents-provider.test.ts` — the frozen description copy

**US-007**
- `packages/nax/src/chat/subagent-runs.ts` — `run`, `runNested`, `cancelAll`, `settle`, `closeAll`, `release`
- `packages/nax/src/chat/chat-host.ts` — runs and provider wiring
- `packages/nax/src/chat/background/task-types.ts` — `adoptAgent` — created by US-005, consumed here
- `packages/nax/src/chat/agents-provider.ts` — `AgentsProviderOptions.runInBackground` — created by US-006, wired here

### Creates

**US-001**
- `packages/nax/src/forge/kind.ts` — `captureForgeKind`, `resolveExplicitForgeKind`, `_forgeKind`, `_forgeKindDeps`
- `packages/nax/src/config/schemas-forge.ts` — `ForgeConfigSchema`
- `packages/nax/src/config/runtime-types-forge.ts` — `ForgeConfig`
- `packages/nax/test/unit/forge/kind.test.ts` — capture and resolution tests
- `packages/nax/test/unit/forge/detect-explicit.test.ts` — `detectForge` with an explicit kind
- `packages/nax/test/unit/plugins/builtin/auto-pr-explicit-forge.test.ts` — auto-PR with an explicit kind

**US-002**
- `packages/nax/test/unit/resources/agents-user-skills.test.ts` — `~/.agents/skills` discovery tests

**US-003**
- `packages/nax-agent/src/session/turn-end-abort.ts` — `TurnEndAbort`
- `packages/nax-agent/test/unit/native/session-adapter-abort-reasons.test.ts` — deadline and active-call reasons

**US-004**
- `packages/nax-agent-acp/src/client/turn-end-abort.ts` — `TurnEndAbort`, `abandonedText`
- `packages/nax-agent-acp/test/unit/client/tool-calls-abandoned.test.ts` — abandoned reason tests

**US-005**
- `packages/nax/test/unit/chat/background/task-registry-agents.test.ts` — agent task tests
- `packages/nax/test/unit/tui/chat/chat-status-agents.test.ts` — footer agent part tests
- `packages/nax/test/unit/prompts/builders/notice-summary-agents.test.ts` — agent notice summary tests

**US-006**
- `packages/nax/test/unit/chat/agents-provider-background.test.ts` — provider input tests

**US-007**
- `packages/nax/test/unit/chat/subagent-runs-background.test.ts` — background run tests
- `packages/nax/test/unit/chat/chat-host-background-agents.test.ts` — host wiring tests

### Modifies

**US-002**
- `packages/nax/test/unit/resources/nax-user-agents.test.ts` — `load()` reads the real home directory for the user skills directory, so the test "packages order nax-user after claude-project and before claude-user" would list an `agents-user` package on a machine that has one; the file sets `_claudePathsDeps.homedir` to its temporary directory in `beforeEach` and restores it in `afterEach`, and that expected order stays `["claude-project", "nax-user", "claude-user", "p@m"]`.
- `packages/nax/test/unit/resources/catalog.test.ts` — any `loadResourceCatalog` call would pick up a real user skills directory (its package-list assertions are closed-world); the file sets `_claudePathsDeps.homedir` to a temporary directory in `beforeEach` and restores it in `afterEach`, with every existing expectation unchanged.
- `packages/nax/test/unit/resources/claude-sources.test.ts` — any `loadResourceCatalog` call would pick up a real user skills directory; the file sets `_claudePathsDeps.homedir` to a temporary directory in `beforeEach` and restores it in `afterEach`, with every existing expectation unchanged.
- `packages/nax/test/unit/cli/mcp-lock.test.ts` — its `loadResourceCatalog` calls would read a real user skills directory; the file sets `_claudePathsDeps.homedir` to a temporary directory in `beforeEach` and restores it in `afterEach`, with every existing expectation unchanged.
- `packages/nax/test/unit/cli/chat-resources.test.ts` — its `loadResourceCatalog` calls would read a real user skills directory; the file sets `_claudePathsDeps.homedir` to a temporary directory in `beforeEach` and restores it in `afterEach`, with every existing expectation unchanged.

**US-006**
- `packages/nax/test/unit/chat/agents-provider.test.ts` — the `RUN_DESCRIPTION` constant is a frozen copy of the description asserted with `toBe` ("AC-2 the description is the frozen text naming the general-agent fallback" and the later exact-text tests); the constant gains the sentence `Set "runInBackground": true to return at once with a task id; the agent keeps running after your turn ends and a notice arrives when it ends.` between the general-agent sentence and the explore sentence, and the `endsWith(EXPLORE_SENTENCE)` and `required: ["task"]` assertions stay.

### Seams

- US-001 creates `resolveExplicitForgeKind` (wired as `defaultForgeDeps.explicitKind`); US-001 AC-15 enters at `detectForge` with `defaultForgeDeps` and a real project config on disk, and AC-14 with `_forgeKind.current`.
- US-001 creates `captureForgeKind`; US-001 AC-20 pins its call at start-up by spawning `bin/nax.ts` with an invalid value.
- US-005 creates `adoptAgent`; US-007 AC-1 stubs a registry and asserts `adoptAgent` is called with the agent's qualified name and task.
- US-006 creates `AgentsProviderOptions.runInBackground`; US-007 AC-20 enters at the `nax-agents__run` tool of a provider the `ChatHost` built and asserts a background task was adopted.

## Acceptance Criteria

### US-001

1. [unit] `captureForgeKind({ NAX_FORGE_KIND: "gitlab" })` returns `"gitlab"` and leaves `_forgeKind.current` equal to `"gitlab"`.
2. [unit] `captureForgeKind({ NAX_FORGE_KIND: " github " })` returns `"github"`.
3. [unit] `captureForgeKind({})` returns `undefined` and leaves `_forgeKind.current` `undefined`, also when `_forgeKind.current` was `"github"` before the call.
4. [unit] `captureForgeKind({ NAX_FORGE_KIND: "bitbucket" })` throws a `NaxError` with code `FORGE_KIND_INVALID` and message `[forge] Invalid NAX_FORGE_KIND "bitbucket": expected github or gitlab`.
5. [unit] `captureForgeKind({ NAX_FORGE_KIND: "GitLab" })` throws a `NaxError` with code `FORGE_KIND_INVALID` (values are case-sensitive).
6. [unit] after a throwing `captureForgeKind`, `_forgeKind.current` is `undefined`.
7. [unit] `resolveExplicitForgeKind("/repo")` with `_forgeKind.current` `"github"` and `_forgeKindDeps.configuredKind` returning `"gitlab"` returns `"github"` (env wins).
8. [unit] `resolveExplicitForgeKind("/repo")` with `_forgeKind.current` `undefined` and `_forgeKindDeps.configuredKind` returning `"gitlab"` returns `"gitlab"`, and `configuredKind` was called with `"/repo"`.
9. [unit] `resolveExplicitForgeKind("/repo")` with no env kind and `_forgeKindDeps.configuredKind` rejecting returns `undefined`.
10. [unit] `NaxConfigSchema.safeParse` of a config with `forge: { kind: "gitlab" }` succeeds and the parsed `forge.kind` is `"gitlab"`.
11. [unit] `NaxConfigSchema.safeParse` of a config with `forge: { kind: "bitbucket" }` fails, and the issue path is `["forge", "kind"]`.
12. [unit] `detectForge(deps, "/repo")` with `deps.explicitKind` resolving `"gitlab"` returns `"gitlab"` and never calls `deps.run` (no `git remote get-url`, no `gh` / `glab` probe).
13. [unit] `detectForge(deps, "/repo")` with `deps.explicitKind` resolving `undefined`, origin `https://git.corp.example/group/app.git` and both `gh --version` and `glab --version` exiting 0 returns `null` (today's result).
14. [unit] `detectForge` with `defaultForgeDeps` spread with a fake `run` (origin `https://git.corp.example/group/app.git`, both `gh` and `glab` probes exit 0) returns `"gitlab"` when `_forgeKind.current` is `"gitlab"`.
15. [integration] `detectForge` with `defaultForgeDeps` spread with the same fake `run`, `_forgeKind.current` `undefined`, `NAX_GLOBAL_CONFIG_DIR` pointing at an empty temporary directory, and a temporary repo whose `.nax/config.json` is `{ "forge": { "kind": "gitlab" } }`, returns `"gitlab"` for that repo with no stubbed `_forgeKindDeps`.
16. [unit] the auto-PR action's `shouldRun`, with `_autoPrDeps.capturedForgeKind` returning `"gitlab"`, `_autoPrDeps.getRemoteUrl` answering `https://git.corp.example/group/app.git`, a publishable branch, one completed story and `_autoPrDeps.hasOpenPr` resolving false, returns `true` and calls `hasOpenPr` with forge `"gitlab"`.
17. [unit] the auto-PR action's `shouldRun`, with `_autoPrDeps.capturedForgeKind` returning `undefined`, the context's config holding `forge: { kind: "gitlab" }` and a remote URL on a neutral host, calls `hasOpenPr` with forge `"gitlab"`.
18. [unit] the auto-PR action's `execute` with `_autoPrDeps.capturedForgeKind` returning `"gitlab"` and a remote URL on a neutral host calls `_autoPrDeps.openDraft` with forge `"gitlab"` and does not return the message `Remote host is not GitHub or GitLab`.
19. [unit] the auto-PR action's `shouldRun` with `_autoPrDeps.capturedForgeKind` returning `undefined`, no `forge` in the context's config and a remote URL on a neutral host returns `false` (today's result).
20. [cli] running `bin/nax.ts --version` with `NAX_FORGE_KIND=bitbucket` in its environment exits 1 and its stderr contains `expected github or gitlab`.
21. [cli] running `bin/nax.ts --version` with `NAX_FORGE_KIND=gitlab` exits 0.
22. [unit] `configuredForgeKind` of a context whose config is `{ forge: { kind: "bitbucket" } }` returns `undefined`, and of a context with no config returns `undefined`.

### US-002

1. [unit] `agentsSkillsDir()` with `_claudePathsDeps.homedir` returning `/home/u` returns `/home/u/.agents/skills`.
2. [unit] `originLabel({ kind: "agents-user" })` returns `"agents-user"`.
3. [unit] `loadResourceCatalog` with `_claudePathsDeps.homedir` pointing at a temporary home holding `.agents/skills/foo/SKILL.md` returns a catalog whose `findSkill("foo")` has origin kind `"agents-user"`.
4. [unit] `loadResourceCatalog` with that home and `config.resources.claudeCode` `false` still finds skill `foo`.
5. [unit] with no `.agents/skills` directory in the temporary home, the catalog's package ids do not contain `"agents-user"`.
6. [unit] with no `.agents/skills` directory, the catalog's diagnostics hold no entry whose path is under the temporary home's `.agents` directory.
7. [unit] with a repo skill at `<repoRoot>/.claude/skills/foo/SKILL.md` and an `agents-user` skill `foo`, `findSkill("foo")` has origin kind `"claude-project"`.
8. [unit] with an `agents-user` skill `foo` and a Claude user skill at `<CLAUDE_CONFIG_DIR>/skills/foo/SKILL.md`, `findSkill("foo")` has origin kind `"agents-user"`.
9. [unit] with a repo package, a `nax-user` agent, an `agents-user` skill, a Claude user settings file and one enabled Claude plugin `p@m`, the catalog's package ids are `["claude-project", "nax-user", "agents-user", "claude-user", "p@m"]`.
10. [unit] with no repo package, a `nax-user` agent and an `agents-user` skill, the catalog's first two package ids are `["nax-user", "agents-user"]`.
11. [unit] a `SKILL.md` under the `agents-user` directory with malformed frontmatter yields no skill and a diagnostic with severity `error`, its path, and origin `{ kind: "agents-user" }`.
12. [unit] a nested `.agents/skills/a/b/SKILL.md` is not loaded as a skill (one level only).

### US-003

1. [unit] `new TurnEndAbort("x")` has `name` `"AbortError"`, `message` `"x"`, and is an instance of `Error`.
2. [unit] `abandonedToolMessage("acme__put", signal)` for a signal aborted with `new TurnEndAbort("native turn deadline of 600s reached")` returns `Tool "acme__put" was abandoned: the turn ended (native turn deadline of 600s reached).`
3. [unit] `abandonedToolMessage("acme__put", signal)` for a signal aborted with no argument returns `Tool "acme__put" was abandoned: the turn ended.`
4. [unit] `abandonedToolMessage("acme__put", signal)` for a signal aborted with `new DOMException("some text", "AbortError")` returns `Tool "acme__put" was abandoned: the turn ended.`
5. [unit] `abandonedToolMessage("acme__put", signal)` for a signal aborted with `new NaxError("cancelled", "AGENT_SESSION_CANCELLED")` returns `Tool "acme__put" was abandoned: the turn ended (AGENT_SESSION_CANCELLED: cancelled).`
6. [unit] a native `sendTurn` with `timeoutSeconds` 600 whose whole-turn deadline timer fires (a fake `_adapterDeps.setTimeout` that captures callbacks; the test invokes the first captured callback, the deadline timer, and no other) while a coding tool is in flight answers that tool with `Tool "<name>" was abandoned: the turn ended (native turn deadline of 600s reached).`
7. [unit] a native `sendTurn` whose active-call cancel (the function passed to `hooks.onActiveCall`) is invoked while a coding tool is in flight answers that tool with a result ending `(turn cancelled by its active-call cancel (idle watchdog or soft cancel)).`
8. [unit] after the deadline fires (the stubbed model call hangs until its signal aborts), the error `sendTurn` rejects with has `name` `"AbortError"`.
9. [unit] after the active-call cancel (the stubbed model call hangs until its signal aborts), the error `sendTurn` rejects with has `name` `"AbortError"`.

### US-004

1. [unit] `abandonedText("acme__put", signal)` for a signal aborted with `new TurnEndAbort("the ACP prompt turn ended")` returns `Tool "acme__put" was abandoned: the turn ended (the ACP prompt turn ended).`
2. [unit] `abandonedText("acme__put", signal)` for a signal aborted with no argument returns `Tool "acme__put" was abandoned: the turn ended.`
3. [unit] `abandonedText("acme__put", signal)` for a signal aborted with `new NaxError("cancelled", "AGENT_SESSION_CANCELLED")` returns `Tool "acme__put" was abandoned: the turn ended (AGENT_SESSION_CANCELLED: cancelled).`
4. [unit] a tool call through the ACP client's tool-call runner whose signal is aborted with `new TurnEndAbort("the tool host stopped")` while the tool runs returns an error result with text `Tool "<name>" was abandoned: the turn ended (the tool host stopped).`
5. [unit] a tool call whose signal is already aborted with `new TurnEndAbort("the tool host stopped")` before it starts returns an error result with that same text.
6. [unit] detaching an inbound binding (calling the function `createInboundRouter(...).attach(...)` returned) while one of its tool calls runs answers that call with text ending `(the ACP prompt turn ended).`
7. [integration] stopping the tool host while a tool call it accepted is running answers that call with text ending `(the tool host stopped).`
8. [integration] closing the HTTP response of a tool-host request while its tool call runs answers that call with text ending `(the agent closed the tool request).`
9. [unit] when the ACP agent process exits while a tool call bound to its session runs, the call is answered with text ending `(the agent process exited).`

### US-005

1. [unit] `adoptAgent({ agent: "code-reviewer", task: "Review the spec\nat a.md", ended, stop })` returns a sink whose `id` matches `^agent-[0-9a-f]{8}$`.
2. [unit] after that adoption, `list()` holds one record with `kind: "agent"`, `state: "running"`, `origin: "agent"` and `command: "code-reviewer: Review the spec"`.
3. [unit] a task whose first line is 120 characters long is recorded with a `command` whose task part is its first 80 characters.
4. [unit] when `ended` resolves `{ outcome: "succeeded", text: "No findings." }`, the record's `state` becomes `"succeeded"`, it has no `exitCode`, and `output(id)` contains `No findings.` and `[nax] agent ended: succeeded`.
5. [unit] when `ended` resolves `{ outcome: "failed", text: "boom" }`, the record's `state` becomes `"failed"` and `peekNotice()` returns text containing `[nax-tasks] background agent <id> (code-reviewer: Review the spec) ended: failed, log <logPath>`.
6. [unit] `stop(id)` on a running agent task calls the handle's `stop` once and the record's `state` is `"stopped"`.
7. [unit] a stopped agent task whose `ended` later resolves `{ outcome: "succeeded", text: "late" }` stays `"stopped"` and `peekNotice()` returns `undefined`.
8. [unit] `stopAll()` with one running shell and one running agent task calls both handles' `stop` and resolves after both `ended` promises settle.
9. [unit] `sink.appendLine("[tool] Read")` on a running agent task makes `output(id)` contain `[tool] Read`.
10. [unit] `sink.appendLine` after the task ended adds nothing to `output(id)`.
11. [unit] `running()` with one running shell and one running agent task returns both records, the agent one with `kind: "agent"`.
12. [unit] the `nax-tasks` provider's `stop` tool with input `{ task: "<agent id>" }` stops the agent task (its handle's `stop` is called).
13. [unit] the `nax-tasks` provider's `output` tool with input `{ task: "<agent id>" }` of a known agent task returns its log text.
14. [unit] `buildBackgroundTaskNotice` with one ended shell task and one ended agent task returns the shell line unchanged (`[nax-tasks] background command <id> (<command>) ended: <state>, exit code <n>, log <path>`), then the agent line, then the follow-up line.
15. [unit] `buildBackgroundTasksInstructions()` returns text containing `nax-agents__run`, `runInBackground` and `keeps running after your turn ends`.
16. [unit] `summarizeBackgroundNotice` of a notice holding one agent line with state `succeeded` returns `1 background agent ended · 1 succeeded`.
17. [unit] `summarizeBackgroundNotice` of a notice whose first line is an agent line and second line a shell line, both `failed`, returns `2 background tasks ended · 2 failed`.
18. [unit] `summarizeBackgroundNotice` of a notice whose first line is a shell line `succeeded` and second an agent line `failed` returns `2 background tasks ended · 1 succeeded · 1 failed`.
19. [unit] `summarizeBackgroundNotice` of a notice holding only shell lines returns today's text (one `succeeded` shell: `1 background command ended · 1 succeeded`).
20. [unit] `formatJobStrip([], [{ command: "bun test" }, { command: "a: b", kind: "agent" }])` returns `1 shell`, the strip's separator, then `1 agent`.
21. [unit] `formatJobStrip([], [{ command: "a: b", kind: "agent" }, { command: "c: d", kind: "agent" }])` returns `2 agents`.
22. [unit] `formatJobStrip([], [{ command: "bun test" }, { command: "ls" }])` returns `2 shells` (today's result).

### US-006

1. [unit] the `nax-agents__run` tool's `inputSchema.properties.runInBackground` is `{ type: "boolean" }`, `required` is `["task"]` and `additionalProperties` is `false`.
2. [unit] the `nax-agents__run` tool's description contains `Set "runInBackground": true to return at once with a task id` and still ends with the explore sentence.
3. [unit] calling the tool with `{ agent: "reviewer", task: "check it", runInBackground: true }` calls `options.runInBackground` once with exactly the arguments `[<reviewer agent resource>, "check it"]` and never calls `options.run`.
4. [unit] calling the tool with `{ task: "check it", runInBackground: true, model: "openai-codex/gpt-6-luna" }` calls `options.runInBackground` with exactly `[<built-in general agent>, "check it", "openai-codex/gpt-6-luna"]`.
5. [unit] the result `options.runInBackground` resolves is returned by the tool unchanged.
6. [unit] calling the tool with `{ agent: "reviewer", task: "check it", runInBackground: false }` calls `options.run` with exactly `[<reviewer agent resource>, "check it", <context signal>]`.
7. [unit] calling the tool with `runInBackground: "yes"` returns the error result `[chat] run runInBackground must be a boolean` and calls neither callback.
8. [unit] calling the tool with `runInBackground: true` on a provider built without `options.runInBackground` returns the error result `[chat] runInBackground is not available in this chat`.
9. [unit] calling the tool with `{ agent: "nope", task: "check it", runInBackground: true }` for an unknown agent returns today's unknown-agent error result and calls neither callback.

### US-007

1. [unit] `SubagentRuns.runInBackground(agent, "check it")` with `deps.backgroundTasks` returning a stub registry whose `adoptAgent` returns sink id `agent-0123abcd` resolves `{ isError: false, content: "started in the background as agent-0123abcd" }`, and `adoptAgent` was called with `agent: agent.qualifiedName` and `task: "check it"`.
2. [unit] `SubagentRuns.runInBackground` resolves while `_subagentRunsDeps.runSubagent` is stubbed never to resolve.
3. [unit] `SubagentRuns.runInBackground` with `deps.backgroundTasks` returning `undefined` resolves `{ isError: true, content: "[chat] runInBackground is not available in this chat" }` and never calls `runSubagent`.
4. [unit] `SubagentRuns.runInBackground` with a model override that resolves to the fallback source returns the unknown-model error result and never calls `adoptAgent`.
5. [unit] with a background run in flight, `settle()` resolves without cancelling it: the `signal` passed to `runSubagent` is not aborted.
6. [unit] with a background run whose nested session opened, `settle()` does not call that session's `cancel`.
7. [unit] with a background run in flight, `cancelAll()` does not abort the `signal` passed to `runSubagent`.
8. [unit] calling the adopted handle's `stop()` after the nested session opened calls that session's `cancel` once.
9. [unit] after the adopted handle's `stop()`, `ended` resolves with `outcome: "stopped"`.
10. [unit] calling the adopted handle's `stop()` before the nested session opened aborts the `signal` passed to `runSubagent`.
11. [unit] when the stubbed `runSubagent` resolves `{ isError: false, content: "No findings." }`, the adopted handle's `ended` resolves `{ outcome: "succeeded", text: "No findings." }`.
12. [unit] when the stubbed `runSubagent` resolves an error result with content `bad input`, `ended` resolves `{ outcome: "failed", text: "bad input" }`.
13. [unit] when the stubbed `runSubagent` rejects with `new Error("boom")`, `ended` resolves `{ outcome: "failed", text: "boom" }`.
14. [unit] a `tool_call` event for tool `Read` emitted by the background run appends `[tool] Read` through the sink's `appendLine`.
15. [unit] a `tool_call` event emitted by the background run does not call the `deps.turnListener` listener.
16. [unit] a `usage` event emitted by the background run is recorded on `deps.ledger()` with source `"subagent"`.
17. [unit] an `approval_requested` event emitted by the background run's session reaches `deps.asks.handle`, and `sessionFor(<its requestId>)` returns that session.
18. [unit] stopping a background run with a pending approval request sends `deps.asks.handle` an `approval_resolved` event for that request with `decision: "deny"` and `decidedBy: "cancelled"`.
19. [unit] `closeAll()` with a background run whose session is open calls that session's `close`.
20. [integration] a `ChatHost` built with a background task registry exposes a `nax-agents__run` tool whose call with `{ task: "check it", runInBackground: true }`, with `_subagentRunsDeps.runSubagent` stubbed never to resolve, returns content starting `started in the background as agent-`, and the host's `tasks.running()` then holds one record with `kind: "agent"`.
21. [integration] in that `ChatHost`, after the send that made the call has ended, the `signal` the stubbed `runSubagent` received is not aborted.
