# SPEC: nax agents run, a headless agent command

## Summary

Add `nax agents run <agent>`, a command that runs one agent definition from the resource catalog on one
task, with no human attached, and prints the agent's final text. With `--json` it prints one structured
result instead. It runs the agent through the same `runSubagent` path a `nax chat` subagent uses, native or
ACP, in mode `guarded`; every ask the session raises is denied and listed in the result. A task that
begins with `/<skill> <args>` is expanded into that skill's invocation message with the same builder the chat
slash command uses (skills only; catalog commands are not expanded). The command exits 0 only when the turn completes, so a runner can gate on it. koda's runner
will use it for the fleet flow's spec-review and PRD-review steps.

This is part (b) of the design `docs/superpowers/specs/2026-11-04-nax-chat-acp-subagents-design.md`
(section 3, goal G4). Part (a), ACP subagents, shipped in #2792. Part (c), sending a flow to koda, waits for
koda's flow API.

## Motivation

koda's runner can launch `nax plan`, `nax run`, `nax bot review` and `nax bot fix`, but it cannot run "the
spec reviewer on this spec" as a job, and the koda flow needs exactly that. `nax agents` today only lists
coding agents (`agentsListCommand`, `packages/nax/src/cli/agents.ts`); there is no headless command that
runs an agent or a skill. `nax run` and `nax plan` exit 0 on failure, which is why a new command must not.

## Design

### CLI Behavior

```
nax agents run <agent> (--task <text> | --task-file <path>)
              [-d, --dir <path>] [--profile <names>] [--model <id>] [--json] [--timeout <seconds>]
```

- `<agent>` is looked up with `ResourceCatalog.findAgent`, so a short name (`spec-reviewer`) or a qualified
  name (`superpowers:code-reviewer`) both work.
- Exactly one of `--task` and `--task-file` is required. `--task-file` is read as UTF-8 text with
  `Bun.file(path).text()`; a relative path resolves against `--dir`.
- `--profile` is repeatable; each value may be comma-separated. The raw values are collected in order and
  passed to `loadConfig(naxDir ?? undefined, { profile: values })` only when at least one was given, and
  `loadConfig(naxDir ?? undefined)` otherwise, as `composeChat` does; `loadConfig` splits the comma lists
  itself.
- `--model <id>` takes the place of the agent file's `model:` value in model resolution.
- `--timeout <seconds>` is a positive whole number: the text must match `^[1-9][0-9]*$`. With no `--timeout`
  there is no command-level limit; the session's own default turn limit (`DEFAULT_TURN_TIMEOUT_SECONDS`,
  3600 s, in `packages/nax-agent/src/session/agent-session-options.ts`) still applies and ends the turn
  `timed_out`, which maps to status `timeout`. The same limit caps a `--timeout` above 3600: the turn ends at
  3600 s with status `timeout`. Raising the session limit is out of scope.
- `-d, --dir <path>` is the working directory. It is the **parent** `agents` command's existing option
  (`bin/nax.ts`, default `process.cwd()` at the CLI boundary): commander gives a parent's known option to
  the parent even when it follows the subcommand name, so `run` declares no `-d` of its own and reads the
  directory with `command.optsWithGlobals().dir`. `nax agents run x -d /d --task t` therefore runs in `/d`.
  The command resolves it to an absolute path with `resolve(dir)` before any use, so `cwd`, the trust root
  and relative `--task-file` paths are all absolute.
- The bare `nax agents` command keeps listing coding agents, unchanged. `run` is added as its subcommand.

**Check order.** The command checks, in this order, and stops at the first failure: the `--timeout` text;
trust; config; the catalog and the agent; the task (`resolveAgentsRunTask`); the model
(`resolveAgentsRunModel`). Trust comes before
anything that reads repository-controlled content, so an untrusted project never has its config or catalog
loaded.

**Output.** Without `--json`, a completed turn prints its final text to stdout followed by a newline; any
other outcome prints the result text to stderr. In plain mode each denied ask is also written to stderr,
after the result text, one line each, in arrival order: `[agents run] denied <tool>: <summary>` for an
approval and `[agents run] unanswered question: <text>` for a question. With `--json`, the command prints exactly one JSON object
and a newline to stdout for every outcome in which the agent ran or tried to start:

```json
{
  "agent": "superpowers:code-reviewer",
  "model": "acp:codex/gpt-6.1-terra",
  "status": "completed",
  "output": "VERDICT: ready\n...",
  "deniedAsks": [
    { "kind": "approval", "tool": "Bash", "summary": "rm -rf build" },
    { "kind": "question", "text": "Which file should I review?" }
  ],
  "costUsd": 0.42
}
```

- `agent` is the agent's `qualifiedName`; `model` is the resolved model string.
- `status` is one of `completed`, `failed`, `cancelled`, `timeout`.
- `output` is the text `runSubagent` returned: the final text on completion, the error text otherwise.
- `costUsd` is present only when the turn ended with a `turn_end` event whose `costSource` is not
  `unpriced`; an unpriced turn (an ACP agent that reported no cost) and a run that never reached a turn
  both omit it. It is never written as `0` to mean unknown.
- A usage or config error (exit 2) prints a one-line message to stderr and no JSON, in both modes.
- The command waits until stdout and stderr have accepted every write before it exits, so a long
  reviewer output piped to a file is never cut short.
- A completed turn with no text has the output `(the subagent returned no text)`, the placeholder
  `runSubagent` already returns; it is still status `completed`, exit 0.

**Writers.** `writeOut(text)` and `writeErr(text)` write `text` exactly as given, adding nothing, and return
a promise that resolves once the stream has accepted it. Every one-line error message is written as
`${message}\n`; `agentsRunOutput`'s strings already end in a newline and are written unchanged.

**Exit codes.**

| Code | When |
|---|---|
| 0 | status `completed` |
| 1 | status `failed`, `cancelled` or `timeout` |
| 2 | a usage or config error: bad options, untrusted project, config that fails to load, agent or skill not found, a model that cannot be resolved, a native session whose options cannot be built, or any other error thrown before a run result exists |

**Status mapping.** The run's status comes from these rules, in order:

1. The command's own `--timeout` timer fired: `timeout`, whatever the turn then reported (even `completed`)
   and even when a signal also arrived.
2. A SIGINT or SIGTERM arrived: `cancelled`, whatever the turn then reported (even `completed`), and also
   when `runSubagent` returned without any `turn_end` because the signal stopped it before the turn began.
   The signal handlers stay registered until the run resolves; a second signal aborts an already aborted
   controller and changes nothing.
3. A `turn_end` event arrived: `completed` -> `completed`, `cancelled` -> `cancelled`, `timed_out` ->
   `timeout`, `errored` -> `failed`, `interrupted` -> `failed`.
4. No `turn_end` arrived (the session refused to start, or session creation failed): `failed`.

### Asks with no human attached

The command runs the agent in mode `guarded` and attaches no interaction chain. It answers every ask
itself, the moment it arrives, through the nested session's `answer`:

- An `approval_requested` event that is answerable (its `answerable` is not `false`) is answered
  `{ decision: "deny" }` and recorded as `{ kind: "approval", tool, summary }`.
- A `question` event that is answerable is answered `{ text: AGENTS_RUN_NO_ANSWER }` and recorded as
  `{ kind: "question", text }`, where
  `AGENTS_RUN_NO_ANSWER = "No one is attached to answer. Continue without an answer, or stop and say what you need."`.
- An event with `answerable: false` was already decided by the session's profile; it is not answered and
  not recorded.
- Every answerable ask is recorded whatever `answer` returns (`accepted`, `expired`, `cancelled` or
  `unknown`). If `answer` throws, the error is caught and the ask is still recorded; the run goes on. `runSubagent` calls `onSession` before the turn's first event, so an ask
  always has a session to answer it on.

The turn continues after a denial. Ask handling is not what keeps an unattended agent from writing; the
tool set and profile are:

- **ACP models:** the profile (next section). An agent with no `tools:` line, or one that declares only
  non-write tools, opens on the read-only `review` profile.
- **Native models:** a native subagent session always opens with profile `full` (`chatSessionSettings`,
  `packages/nax/src/chat/chat-mode.ts`), and `resolveTuiPermissions` defaults `askRules` to `[]`, so a write
  inside the workdir would raise no ask. So for a native model whose agent file has no `tools:` line, the
  command narrows the tools to `AGENTS_RUN_NATIVE_READ_TOOLS =
  ["Read", "Glob", "Grep", "Git", "nax-skills__*", "nax-workflow__*"]` (`Git` is the native read-only git
  tool). An agent file that declares `tools:` gets `mapSubagentTools(agent.tools).allowedTools`; if those
  include a write tool, the agent can write, and the configured `execution.permissions` ask and deny rules
  (whose asks are denied) are the only guard.

### ACP permission profile when unattended

`acpSubagentProfile` (`packages/nax/src/chat/acp/acp-subagent-profile.ts`) derives an ACP subagent's
profile from its agent file. In chat, an agent with no `tools:` line inherits the chat's own profile (`ask`
in guarded, `full` in full). Unattended, nobody can answer an ask, so an agent with no `tools:` line opens
read-only on `review` instead. An agent that declares a write tool still gets the chat's own profile, and
the operator override `agent.acpSubagents.profile` still wins over everything. The derivation order becomes:

1. `override` set: return it.
2. `tools` declared and naming a write tool: the chat's own profile for `mode`.
3. `tools` undefined and `unattended` not true: the chat's own profile for `mode`.
4. Otherwise: `review`.

So a read-only `review` subagent on `cursor`, which enforces no read-only itself, still refuses to start
through the existing `readOnlyRefusal` path; under `nax agents run` that refusal is status `failed`.

**Skills for an unattended ACP agent.** An ACP subagent is handed only the providers in
`ACP_SUBAGENT_PROVIDER_IDS` (`["nax-workflow", "nax-memory"]`, `acp-subagent-session.ts`). The skill message
`buildSkillInvocationMessage` builds tells the model to load the skill's references with `nax-skills__load`,
and an ACP agent's own Read may not reach `~/.claude` from its sandbox. So when `unattended` is true, the
ACP subagent is also handed the `nax-skills` provider (still filtered by the agent's `tools:` list as the
other providers are). Chat ACP subagents, where `unattended` is absent, are unchanged.

### What the session is given

`nax agents run` composes a smaller version of what `nax chat` composes in `chatResources`
(`packages/nax/src/cli/chat.ts`):

- **Catalog:** `loadResourceCatalog({ repoRoot, config, env, naxPluginPackages: [] })`.
- **Tool providers:** `createSkillsProvider(async () => catalog)` and `createWorkflowProvider({ repoRoot,
  outputDir, maxIterations })` with `outputDir = projectOutputDir(getProjectKey(config, repoRoot),
  config.outputDir)` and `maxIterations` set as `chatResources` sets it: `undefined` when
  `isWorkflowMode(config)` is true, otherwise `config.execution.maxIterations`. No memory provider, no MCP
  providers, no `nax-jobs` provider and no agents provider.
- **Loop handlers:** `createRuleDeliveryHandlers({ repoRoot, overrideDir, overrideMode })` from
  `@/context/rules/rule-delivery`, with the override fields from `config.context.rules`. No plugin handlers
  and no agent hooks.
- **Model** (`resolveAgentsRunModel`): `resolveSubagentModel({ requested, parentModel, aliases, tiers })` where `requested` is
  `--model` when given and otherwise the agent's `model`, `aliases` is `config.agent.modelAliases ?? {}` and
  `tiers` is `config.models.native`. `parentModel` is `models.native.balanced` written as a `provider/model`
  string (an entry is either that string or `{ provider, model }`), or the empty string when it is unset.
  The parent model is needed **lazily**: after resolution,
  1. `--model` given and source `fallback`: usage error `unknown model <id>; ...` (this wins even when
     `models.native.balanced` is unset);
  2. source `inherit` or `fallback` and `models.native.balanced` unset: usage error
     `configure models.native.balanced or pass --model`;
  3. otherwise the resolved model is used. An agent file `model:` that is not an alias, tier, `acp:` model or
     `provider/model` (for example `model: gpt`) resolves `fallback` and runs on the parent model, as it does
     in chat.
- **Tools:** for a native model (one that does not start with `acp:`) and an agent with no `tools:` line,
  `AGENTS_RUN_NATIVE_READ_TOOLS`; otherwise `mapSubagentTools(agent.tools).allowedTools` (undefined for an
  ACP agent with no `tools:` line, whose `review` profile then governs).
- **Other `runSubagent` fields:** `mode: "guarded"`, `unattended: true`, `cwd` and `repoRoot` as resolved,
  `parentSessionId: AGENTS_RUN_PARENT_SESSION_ID` (`"nax-agents-run"`), no `memoryIndex`.

The repo root is `dirname(findProjectDir(cwd))` when a `.nax` directory is found, and `cwd` otherwise, as in
`nax chat`.

### Skill expansion

A task whose trimmed text begins with `/` followed by a name of one or more characters from
`[A-Za-z0-9:_.-]`, then whitespace or the end of the text, is a skill invocation. The name is looked up with
`catalog.findSkill(name)`; the rest of the text after the name, trimmed, is the arguments. The task sent to
the agent is `buildSkillInvocationMessage({ skill, args })` from `@/prompts`, the call the chat slash
command makes in `catalogCommand` (`packages/nax/src/tui/chat/slash-commands.ts`). A name with no skill is a
usage error. Catalog commands (`findCommand`) are not expanded. A task that does not match the pattern is
sent unchanged.

### Integration

Read-only (used as they are):

- `resolveSubagentModel(options: ResolveSubagentModelOptions): ResolvedSubagentModel` in
  `packages/nax/src/chat/subagent-model.ts`, exported from `@/chat`; `source` is `"fallback"` when a
  requested model is not an alias, tier, `acp:` model or `provider/model`.
- `mapSubagentTools(tools: readonly string[] | undefined): MappedSubagentTools` in
  `packages/nax/src/chat/subagent-tools.ts`, exported from `@/chat`.
- `ResourceCatalog.findAgent(name)` / `findSkill(name)` in `packages/nax/src/resources/types.ts`;
  `loadResourceCatalog` and `createSkillsProvider` from `@/resources`.
- `buildSkillInvocationMessage({ skill, args }): string` from `@/prompts`.
- `createWorkflowProvider` from `@/chat`; `createRuleDeliveryHandlers` from `@/context/rules/rule-delivery`.
- `loadConfig`, `findProjectDir`, `getProjectKey`, `isWorkflowMode` from `@/config`; `projectOutputDir`
  from `@/runtime`.
- `ensureProjectTrusted(root, { interactive })`, `normalizeTrustPath`, `resolveTrustRoot` from `@/trust`;
  `ensureProjectTrusted` throws `NaxError` code `PROJECT_UNTRUSTED` (context `root`, `hint`) for an
  untrusted root when `interactive` is false.
- `AgentSession.answer(requestId: string, reply: AnswerReply): AnswerStatus` and the `SessionEvent` union
  (`approval_requested`, `question`, `turn_end` with `status: TurnEndStatus`, `costUsd`, `costSource?:
  "computed" | "reported" | "unpriced"`) from `@nathapp/nax-agent`.

Changed by this feature. The baseline only locates the code; implement the target.

- `acpSubagentProfile` in `packages/nax/src/chat/acp/acp-subagent-profile.ts`.
  Baseline: `acpSubagentProfile(input: { tools: readonly string[] | undefined; mode: ChatMode; override?: AcpSubagentProfile }): AcpSubagentProfile`.
  Target: `acpSubagentProfile(input: { tools: readonly string[] | undefined; mode: ChatMode; override?: AcpSubagentProfile; unattended?: true }): AcpSubagentProfile`,
  with the derivation order in "ACP permission profile when unattended".
- `RunSubagentInput` in `packages/nax/src/chat/subagent-session.ts`.
  Target: gains `readonly unattended?: true`, which the private `subagentProfile` passes to
  `acpSubagentProfile`.
- `deliveredProviders` in `packages/nax/src/chat/acp/acp-subagent-session.ts`. Target: when
  `input.unattended` is true, a provider whose id is `nax-skills` is delivered as well as those in
  `ACP_SUBAGENT_PROVIDER_IDS`, under the same `tools:` filter. `runSubagent` and `RunSubagentInput`/`RunSubagentResult` become exports of the
  `@/chat` barrel (they are not today).
- The `agents` command in `packages/nax/bin/nax.ts`. Target: the `Command` returned by
  `program.command("agents")...` (which keeps its `-d, --dir` option and listing action) is passed to
  `registerAgentsRunCommand`, which adds the `run` subcommand.

New modules:

- `packages/nax/src/cli/agents-run-task.ts`: `resolveAgentsRunTask(input: { task?: string; taskFile?: string; cwd: string; catalog: Pick<ResourceCatalog, "findSkill"> }, deps?: { readText: (path: string) => Promise<string> }): Promise<string>`,
  returning the message to send, and throwing `NaxError` code `AGENTS_RUN_USAGE` for a usage error. The
  default `readText` is `(path) => Bun.file(path).text()`.
- `packages/nax/src/cli/agents-run-exec.ts`: `runAgentTask(input: AgentsRunTaskInput, deps?: typeof _agentsRunExecDeps): Promise<AgentsRunResult>`,
  with `_agentsRunExecDeps = { runSubagent, setTimeout, clearTimeout }` (a cancellable timer, so
  `setTimeout` is the permitted exception; the call site says so), the constants `AGENTS_RUN_NO_ANSWER` and
  `AGENTS_RUN_PARENT_SESSION_ID`, and these types:

```typescript
export type AgentsRunStatus = "completed" | "failed" | "cancelled" | "timeout";

export type DeniedAsk =
  | { readonly kind: "approval"; readonly tool: string; readonly summary: string }
  | { readonly kind: "question"; readonly text: string };

export interface AgentsRunResult {
  readonly agent: string; // qualifiedName
  readonly model: string;
  readonly status: AgentsRunStatus;
  readonly output: string;
  readonly deniedAsks: readonly DeniedAsk[];
  readonly costUsd?: number;
}

export interface AgentsRunTaskInput {
  readonly agent: AgentResource;
  readonly task: string; // already expanded
  readonly model: string; // already resolved
  readonly allowedTools?: readonly string[];
  readonly toolProviders: readonly ToolProvider[];
  readonly loopHandlers: LoopHandlerSet;
  readonly cwd: string;
  readonly repoRoot: string;
  readonly config: NaxConfig;
  readonly timeoutSeconds?: number;
  /** Aborted by the command on SIGINT or SIGTERM. */
  readonly signal?: AbortSignal;
}
```

- `packages/nax/src/cli/agents-run-output.ts`: `agentsRunOutput(result: AgentsRunResult, json: boolean): AgentsRunOutput`
  with `interface AgentsRunOutput { readonly stdout?: string; readonly stderr?: string; readonly exitCode: 0 | 1 }`.
  Pure: it decides what to print and the exit code; it writes nothing.
- `packages/nax/src/cli/agents-run-model.ts`: `resolveAgentsRunModel(input: { agent: AgentResource; config: NaxConfig; modelOverride?: string }): string`,
  the lazy model resolution in "What the session is given", throwing `NaxError` code `AGENTS_RUN_USAGE` for
  its two errors.
- `packages/nax/src/cli/agents-run-compose.ts`: `buildAgentsRunTaskInput(input: AgentsRunComposeInput, deps?: typeof _agentsRunComposeDeps): AgentsRunTaskInput`,
  with `_agentsRunComposeDeps = { resolveAgentsRunModel, createSkillsProvider, createWorkflowProvider, createRuleDeliveryHandlers }`,
  the constant `AGENTS_RUN_NATIVE_READ_TOOLS`, and

```typescript
export interface AgentsRunComposeInput {
  readonly agent: AgentResource;
  readonly task: string; // already expanded
  readonly catalog: ResourceCatalog;
  readonly config: NaxConfig;
  readonly cwd: string;
  readonly repoRoot: string;
  readonly modelOverride?: string; // --model
  readonly timeoutSeconds?: number;
  readonly signal?: AbortSignal;
}
```

  It takes the model from `resolveAgentsRunModel` (letting its errors propagate) and builds the tools, the
  providers and the loop handlers as "What the session is given" states.
- `packages/nax/src/cli/agents-run.ts`: `agentsRunCommand(agent: string, options: AgentsRunOptions, deps?: AgentsRunCommandDeps): Promise<void>`
  and `registerAgentsRunCommand(agents: Command, deps?: AgentsRunCommandDeps): Command`, with

```typescript
export interface AgentsRunOptions {
  readonly dir: string; // from the parent agents command, via optsWithGlobals
  readonly task?: string;
  readonly taskFile?: string;
  readonly profile?: readonly string[]; // raw repeated values; loadConfig splits commas
  readonly model?: string;
  readonly json?: boolean;
  readonly timeout?: string; // raw text, validated by the command
}
export type AgentsRunCommandDeps = typeof _agentsRunCommandDeps;
```

  `_agentsRunCommandDeps` holds `ensureTrusted`, `loadConfig`, `findProjectDir`, `loadResourceCatalog`,
  `resolveAgentsRunTask`, `buildAgentsRunTaskInput`, `runAgentTask`, `env`, `writeOut`, `writeErr`,
  `setExitCode`, `onSignal`, `exit`, following `_chatCommandDeps` in `packages/nax/src/cli/chat.ts`.
  `writeOut` and `writeErr` follow "Writers" above. The default `ensureTrusted(cwd)` calls
  `ensureProjectTrusted(await normalizeTrustPath(resolveTrustRoot(cwd)), { interactive: false })`. The
  registered action awaits `agentsRunCommand` and then calls `deps.exit()`, as `registerChatCommand` does.
  Both functions are exported from `packages/nax/src/cli/index.ts`.

### Failure Handling

| Condition | Behaviour |
|---|---|
| neither or both of `--task` and `--task-file` | exit 2, `pass exactly one of --task or --task-file` |
| `--task-file` cannot be read | exit 2, `cannot read task file <path>: <reason>` |
| task text empty after trimming | exit 2, `the task is empty` |
| `--timeout` not a positive integer | exit 2, `--timeout must be a positive whole number of seconds` |
| `/<name>` with no such skill | exit 2, `skill <name> not found` |
| project not trusted | exit 2, `Project not trusted: <root>` then the error's hint line (or `run: nax trust add <root>`) |
| trust check fails for another reason (for example `TRUST_STORE_UNREADABLE`) | exit 2, the error message |
| config fails to load | exit 2, the error message |
| agent not found | exit 2, `agent <name> not found; see nax agents` |
| `--model` that resolves with source `fallback` | exit 2, `unknown model <id>; pass provider/model, acp:<agent>, or a configured alias` |
| the model resolution needs the parent model and `models.native.balanced` is unset | exit 2, `configure models.native.balanced or pass --model` |
| `runSubagent` throws (native options cannot be built) | exit 2, the error message |
| read-only profile on an agent with no read-only enforcement | status `failed`, exit 1, `output` is the refusal text |
| the turn fails, is cancelled or times out | exit 1, status as mapped |
| an ask during the run | denied (or answered with `AGENTS_RUN_NO_ANSWER`), listed in `deniedAsks`; the turn continues |
| `answer` throws on an ask | the ask is still recorded, the run goes on |
| the ACP agent reports no cost | `costUsd` omitted |
| any other error thrown before a run result exists (for example from `loadResourceCatalog`) | exit 2, the error message |

## Out of Scope

- `nax agents run` loads no nax plugins and no agent hooks, attaches no memory host or memory tools, connects no catalog MCP servers and offers no `nax-jobs` launch tools; nax-plugin-provided agents and skills are therefore not found by it.
- Catalog commands (`findCommand` templates, including their `` !`cmd` `` shell lines) are not expanded in `--task`; only skills are.
- No chat tool or chat card launches `nax agents run`; the chat brain never starts it.
- The command does not interpret the agent's output or extract a verdict; a caller asks for one in the task text and parses it.
- Section 4 of the design (`nax-flow__send`, koda credentials, sending a flow to koda) is a later feature.
- No interaction chain (Telegram, webhook) is attached, so no ask is ever forwarded to a person.
- No resume: every run opens a fresh memory-only session and closes it after one turn.
- Translating an agent file's `tools:` list into ACP tool restrictions beyond read-only versus not is unchanged from part (a).
- Changing the `nax agents` listing output.
- Enforcing read-only for a native agent whose `tools:` line declares a write tool: such an agent can write, and the configured `execution.permissions` rules are its only guard.
- Raising the session's 3600 s turn limit; a `--timeout` above it is capped by it.
- Updating `docs/guides/cli-reference.md` for `nax agents run`; it is a docs follow-up after merge.
- Delivering `nax-skills` to chat ACP subagents; only unattended runs get it.
- Checking that `--dir` exists before the trust check; a missing directory fails at the trust check or config load as an exit-2 error.

## Stories

All nine stories build one capability, the `nax agents run` command; they are split only to keep each story
under the 24-assertion gate.

### US-001: Unattended ACP profile, skills delivery and a public runSubagent

No dependencies. Workdir: `packages/nax`

Add `unattended?: true` to `acpSubagentProfile`'s input and to `RunSubagentInput`, apply the derivation order
in Design, pass the flag through `subagentProfile`, deliver `nax-skills` to an unattended ACP subagent, and
export `runSubagent`, `RunSubagentInput` and `RunSubagentResult` from the `@/chat` barrel. ACs 3 to 7 are
regression pins over the unchanged branches; the others fail first.

### US-002: Task input and skill expansion

No dependencies. Workdir: `packages/nax`

Create `packages/nax/src/cli/agents-run-task.ts` with `resolveAgentsRunTask`: one of `--task` / `--task-file`,
file reading through an injected reader, the empty-task check, and `/<skill> <args>` expansion with
`buildSkillInvocationMessage`. Usage errors throw `NaxError` code `AGENTS_RUN_USAGE`.

### US-003: Run one agent task: the call, its status and its cost

Depends on US-001. Workdir: `packages/nax`

Create `packages/nax/src/cli/agents-run-exec.ts` with `runAgentTask`, `_agentsRunExecDeps`,
`AGENTS_RUN_PARENT_SESSION_ID` and the result types: call `runSubagent` in mode `guarded` with
`unattended: true`, map a `turn_end` (or its absence) to the run status, and report cost only when priced.

### US-004: Unattended asks, the timeout and cancellation

Depends on US-003. Workdir: `packages/nax`

Extend `runAgentTask` in `packages/nax/src/cli/agents-run-exec.ts`: add `AGENTS_RUN_NO_ANSWER`, answer every
answerable ask on the nested session and record it, arm the `--timeout` timer, link the input signal, and
apply status rules 1 and 2 of the status mapping. Its tests go in their own file,
`agents-run-exec-asks.test.ts`, split by concern from `agents-run-exec.test.ts` because the two story sets
together would pass the 650-line test-file target.

### US-005: Output and exit code for a run result

Depends on US-003. Workdir: `packages/nax`

Create `packages/nax/src/cli/agents-run-output.ts` with `agentsRunOutput`: plain versus `--json` output, the
denied-ask lines in plain mode, which stream each goes to, and the exit code for each status.

### US-006: Resolve the run's model

No dependencies. Workdir: `packages/nax`

Create `packages/nax/src/cli/agents-run-model.ts` with `resolveAgentsRunModel`: lazy parent-model resolution
over `resolveSubagentModel`, and its two usage errors.

### US-007: Compose the run input

Depends on US-003, US-006. Workdir: `packages/nax`

Create `packages/nax/src/cli/agents-run-compose.ts` with `buildAgentsRunTaskInput`, `_agentsRunComposeDeps`
and `AGENTS_RUN_NATIVE_READ_TOOLS`: the model from `resolveAgentsRunModel`, the tool set for native and ACP
agents, the two tool providers, and the rule-delivery loop handlers.

### US-008: The command's checks and errors

Depends on US-002, US-007. Workdir: `packages/nax`

Create `packages/nax/src/cli/agents-run.ts` with `agentsRunCommand` and `_agentsRunCommandDeps`, tested by
calling `agentsRunCommand` directly with an `AgentsRunOptions` object: `--dir` resolution, the check order,
`--timeout` validation, non-interactive trust, the `loadConfig` and `loadResourceCatalog` calls, agent
lookup, and exit code 2 with the exact stderr line for every usage and config error.

### US-009: Run, output, signals and registration

Depends on US-004, US-005, US-008. Workdir: `packages/nax`

Complete `agentsRunCommand` in `packages/nax/src/cli/agents-run.ts` (created by US-008) and add
`registerAgentsRunCommand`: the `buildAgentsRunTaskInput` and `runAgentTask` calls, writing
`agentsRunOutput`'s result, the signal handlers, waiting for the writes before `exit`, the `run` subcommand
reading `--dir` from the parent `agents` command, the barrel exports, and the registration in
`packages/nax/bin/nax.ts`. Its last AC spawns `bun bin/nax.ts agents run --help`; that is the story-required
smoke exception to the no-full-CLI-spawn rule, as `test/unit/cli/chat.test.ts` AC-18 is for `nax chat`, and
help opens no session.

### Context Files

**US-001**
- `packages/nax/src/chat/acp/acp-subagent-profile.ts` - `acpSubagentProfile` and its derivation order
- `packages/nax/src/chat/subagent-session.ts` - `RunSubagentInput`, `subagentProfile`, `runSubagent`
- `packages/nax/src/chat/acp/acp-subagent-session.ts` - `ACP_SUBAGENT_PROVIDER_IDS`, `deliveredProviders`
- `packages/nax/src/chat/index.ts` - the `@/chat` barrel
- `packages/nax/test/unit/chat/subagent-session-acp.test.ts` - existing ACP runSubagent stubs to mirror

**US-002**
- `packages/nax/src/tui/chat/slash-commands.ts` - `catalogCommand`, the chat's skill expansion
- `packages/nax/src/prompts/builders/skills-builder/index.ts` - `buildSkillInvocationMessage`
- `packages/nax/src/resources/types.ts` - `ResourceCatalog`, `SkillResource`
- `packages/nax/src/errors.ts` - `NaxError`

**US-003**
- `packages/nax/src/chat/subagent-session.ts` - `runSubagent`, `RunSubagentInput`, `onSession`, `onEvent`, `cancelledResult`
- `packages/nax/src/chat/subagent-runs.ts` - how chat reads `turn_end`
- `packages/nax-agent/src/session/agent-session-types.ts` - `SessionEvent`, `TurnEndStatus`, `CostSource`

**US-004**
- `packages/nax/src/cli/agents-run-exec.ts` - `runAgentTask` (created by US-003)
- `packages/nax/src/chat/subagent-runs.ts` - how chat routes asks
- `packages/nax-agent/src/session/agent-session-types.ts` - `AnswerReply`, `AnswerStatus`, the ask events
- `packages/nax/test/helpers/fake-clock.ts` - `makeFakeClock` for the timeout tests

**US-005**
- `packages/nax/src/cli/agents-run-exec.ts` - `AgentsRunResult`, `AgentsRunStatus`, `DeniedAsk` (created by US-003)

**US-006**
- `packages/nax/src/chat/subagent-model.ts` - `resolveSubagentModel`
- `packages/nax/src/cli/chat.ts` - `launchModel`, how chat reads `models.native.balanced`
- `packages/nax/src/resources/types.ts` - `AgentResource`

**US-007**
- `packages/nax/src/cli/chat.ts` - `chatResources`, the composition this mirrors
- `packages/nax/src/chat/subagent-tools.ts` - `mapSubagentTools`
- `packages/nax/src/context/rules/rule-delivery/index.ts` - `createRuleDeliveryHandlers`
- `packages/nax/src/cli/agents-run-exec.ts` - `AgentsRunTaskInput` (created by US-003)
- `packages/nax/src/cli/agents-run-model.ts` - `resolveAgentsRunModel` (created by US-006)

**US-008**
- `packages/nax/src/cli/chat.ts` - `_chatCommandDeps`, `composeChat`, trust handling
- `packages/nax/test/helpers/trust.ts` - `useUntrustedRegistry`, for the default trust check test
- `packages/nax/src/cli/agents-run-task.ts` - `resolveAgentsRunTask` (created by US-002)
- `packages/nax/src/cli/agents-run-compose.ts` - `buildAgentsRunTaskInput` (created by US-007)

**US-009**
- `packages/nax/src/cli/agents-run.ts` - `agentsRunCommand`, `_agentsRunCommandDeps` (created by US-008)
- `packages/nax/src/cli/agents-run-output.ts` - `agentsRunOutput` (created by US-005)
- `packages/nax/bin/nax.ts` - the `agents` command
- `packages/nax/src/cli/index.ts` - the `src/cli` barrel
- `packages/nax/test/unit/cli/chat.test.ts` - AC-18, the bin help spawn precedent

### Creates

**US-002**
- `packages/nax/src/cli/agents-run-task.ts`
- `packages/nax/test/unit/cli/agents-run-task.test.ts`

**US-003**
- `packages/nax/src/cli/agents-run-exec.ts`
- `packages/nax/test/unit/cli/agents-run-exec.test.ts`

**US-004**
- `packages/nax/test/unit/cli/agents-run-exec-asks.test.ts`

**US-005**
- `packages/nax/src/cli/agents-run-output.ts`
- `packages/nax/test/unit/cli/agents-run-output.test.ts`

**US-006**
- `packages/nax/src/cli/agents-run-model.ts`
- `packages/nax/test/unit/cli/agents-run-model.test.ts`

**US-007**
- `packages/nax/src/cli/agents-run-compose.ts`
- `packages/nax/test/unit/cli/agents-run-compose.test.ts`

**US-008**
- `packages/nax/src/cli/agents-run.ts`
- `packages/nax/test/unit/cli/agents-run.test.ts`

**US-009**
- `packages/nax/test/unit/cli/agents-run-register.test.ts`

### Modifies

**US-001**
- `packages/nax/src/chat/acp/acp-subagent-profile.ts` - add the optional `unattended` input and the derivation step that returns `review` for an unattended agent with no `tools:` line.
- `packages/nax/src/chat/subagent-session.ts` - add `unattended?: true` to `RunSubagentInput` and pass it from `subagentProfile` to `acpSubagentProfile`.
- `packages/nax/src/chat/acp/acp-subagent-session.ts` - deliver the `nax-skills` provider as well when `input.unattended` is true.
- `packages/nax/src/chat/index.ts` - export `runSubagent`, `RunSubagentInput` and `RunSubagentResult` from the barrel.
- `packages/nax/test/unit/chat/acp/acp-subagent-profile.test.ts` - add the `unattended` cases beside the existing derivation cases; existing cases keep passing unchanged, since `unattended` is optional and absent in them.
- `packages/nax/test/unit/chat/acp/acp-subagent-session.test.ts` - add the two `nax-skills` delivery cases; existing cases keep passing unchanged, since none sets `unattended`.
- `packages/nax/test/unit/chat/subagent-session-acp.test.ts` - add the two `unattended: true` runSubagent cases; existing cases keep passing unchanged.

**US-009**
- `packages/nax/src/cli/index.ts` - export `agentsRunCommand` and `registerAgentsRunCommand` from the barrel.
- `packages/nax/bin/nax.ts` - pass the `agents` command to `registerAgentsRunCommand`; the `agents` options and listing action stay unchanged.

### Seams

- US-003 consumes `runSubagent` with `unattended: true` (US-001): US-003's tests stub `_agentsRunExecDeps.runSubagent`, enter through `runAgentTask`, and assert the input it receives.
- US-007 consumes `resolveAgentsRunModel` (US-006): its tests stub `_agentsRunComposeDeps.resolveAgentsRunModel` and the provider and handler factories, enter through `buildAgentsRunTaskInput`, and assert the arguments each receives.
- US-008 consumes `resolveAgentsRunTask` (US-002) and `buildAgentsRunTaskInput` (US-007): its tests call `agentsRunCommand` with stubbed deps and assert the arguments they receive and what is written to stderr.
- US-009 consumes `runAgentTask` (US-003, US-004) and `agentsRunOutput` (US-005): its tests enter through a commander program whose `agents` command (with `-d, --dir`) was passed to `registerAgentsRunCommand`, parse an argv, and assert what reaches `runAgentTask` and what is written; the last AC spawns `bin/nax.ts` to prove the production registration.

## Acceptance Criteria

### US-001

1. [unit] `acpSubagentProfile({ tools: undefined, mode: "guarded", unattended: true })` returns `"review"`.
2. [unit] `acpSubagentProfile({ tools: undefined, mode: "full", unattended: true })` returns `"review"`.
3. [unit] `acpSubagentProfile({ tools: ["Read", "Write"], mode: "guarded", unattended: true })` returns `"ask"`.
4. [unit] `acpSubagentProfile({ tools: ["Read", "Edit"], mode: "full", unattended: true })` returns `"full"`.
5. [unit] `acpSubagentProfile({ tools: ["Read", "Grep"], mode: "guarded", unattended: true })` returns `"review"`.
6. [unit] `acpSubagentProfile({ tools: undefined, mode: "guarded", override: "full", unattended: true })` returns `"full"`.
7. [unit] `acpSubagentProfile({ tools: undefined, mode: "guarded" })` with no `unattended` field returns `"ask"`.
8. [unit] `runSubagent` with model `acp:claude`, an agent whose `tools` is undefined, mode `guarded` and `unattended: true`, with `_subagentSessionDeps.createAgentSession` stubbed, passes options whose `profile` is `"review"` to `createAgentSession`.
9. [unit] `runSubagent` with model `acp:cursor`, an agent whose `tools` is undefined and `unattended: true` returns `isError: true` with content starting `[chat] subagent <qualifiedName> could not start read-only:`, and `_subagentSessionDeps.createAgentSession` is never called.
10. [unit] `runSubagent` imported from `@/chat`, called with a signal that is already aborted, returns `isError: true` with content `subagent <qualifiedName> cancelled: cancelled`.
11. [unit] `acpSubagentSessionOptions` for an input with `unattended: true`, no `allowedTools`, and tool providers with ids `nax-skills`, `nax-workflow` and `nax-jobs` passes the `nax-skills` and `nax-workflow` providers, and not `nax-jobs`, to the stubbed `_acpSubagentDeps.chatAcpTools`.
12. [unit] `acpSubagentSessionOptions` for the same input without `unattended` passes only the `nax-workflow` provider to `chatAcpTools`.

### US-002

1. [unit] `resolveAgentsRunTask({ task: "review the spec", cwd, catalog })` resolves to `"review the spec"`.
2. [unit] `resolveAgentsRunTask` with neither `task` nor `taskFile` rejects with a `NaxError` whose code is `AGENTS_RUN_USAGE` and whose message is `pass exactly one of --task or --task-file`.
3. [unit] `resolveAgentsRunTask` with both `task` and `taskFile` rejects with a `NaxError` whose code is `AGENTS_RUN_USAGE` and whose message is `pass exactly one of --task or --task-file`.
4. [unit] `resolveAgentsRunTask({ taskFile: "task.md", cwd: "/repo", catalog }, { readText })` calls `readText` with `/repo/task.md` and resolves to the text `readText` returns.
5. [unit] `resolveAgentsRunTask({ taskFile: "/abs/task.md", cwd: "/repo", catalog }, { readText })` calls `readText` with `/abs/task.md`.
6. [unit] when `readText` rejects with an error whose message is `ENOENT`, `resolveAgentsRunTask` rejects with a `NaxError` whose code is `AGENTS_RUN_USAGE` and whose message is `cannot read task file task.md: ENOENT`.
7. [unit] with the default reader, `resolveAgentsRunTask({ taskFile: "task.md", cwd: <temp dir>, catalog })` resolves to the text of a `task.md` written in that temp directory.
8. [unit] `resolveAgentsRunTask({ task: "   ", cwd, catalog })` rejects with a `NaxError` whose code is `AGENTS_RUN_USAGE` and whose message is `the task is empty`.
9. [unit] with a catalog whose `findSkill("spec-review")` returns a skill, `resolveAgentsRunTask({ task: "/spec-review .nax/features/x/spec.md", cwd, catalog })` resolves to exactly `buildSkillInvocationMessage({ skill, args: ".nax/features/x/spec.md" })`.
10. [unit] with a catalog whose `findSkill("nax-spec-kit:spec-review")` returns a skill, a task `/nax-spec-kit:spec-review` with no arguments resolves to `buildSkillInvocationMessage({ skill, args: "" })`.
11. [unit] a task `  /spec-review   a.md  ` calls `findSkill` with `spec-review` and resolves to the message built with `args` `"a.md"`.
12. [unit] with a catalog whose `findSkill` returns undefined, a task `/nope a.md` rejects with a `NaxError` whose code is `AGENTS_RUN_USAGE` and whose message is `skill nope not found`.
13. [unit] a task `review /spec-review a.md` (the slash is not first) resolves to the text unchanged and `findSkill` is never called.
14. [unit] a task `/` alone resolves to `/` unchanged and `findSkill` is never called.

### US-003

1. [unit] `runAgentTask` calls `_agentsRunExecDeps.runSubagent` exactly once.
2. [unit] the input that call receives, with its `onEvent`, `onSession` and `signal` functions and objects removed, deep-equals `{ agent, task, model, allowedTools, toolProviders, loopHandlers, cwd, repoRoot, config, mode: "guarded", unattended: true, parentSessionId: "nax-agents-run" }` built from the `runAgentTask` input.
3. [unit] `AGENTS_RUN_PARENT_SESSION_ID` equals `"nax-agents-run"`.
4. [unit] when the stubbed `runSubagent` emits a `turn_end` with status `completed`, `costUsd` `0.42` and `costSource` `"computed"` and returns `{ content: "done" }`, `runAgentTask` resolves to a result deep-equal to `{ agent: <qualifiedName>, model: <input model>, status: "completed", output: "done", deniedAsks: [], costUsd: 0.42 }`.
5. [unit] a `turn_end` with status `cancelled` resolves with `status` `"cancelled"`.
6. [unit] a `turn_end` with status `timed_out` resolves with `status` `"timeout"`.
7. [unit] a `turn_end` with status `errored` resolves with `status` `"failed"`.
8. [unit] a `turn_end` with status `interrupted` resolves with `status` `"failed"`.
9. [unit] when a `turn_end` with status `errored` arrives and `runSubagent` returns content `subagent a errored: boom`, the result's `output` is `subagent a errored: boom`.
10. [unit] when `runSubagent` returns `{ isError: true, content: "[chat] subagent a could not start read-only: x" }` without emitting a `turn_end`, `runAgentTask` resolves to a result whose `status` is `"failed"`, whose `output` is that content, and which has no `costUsd` field.
11. [unit] a `turn_end` with `costSource` `"unpriced"` and `costUsd` `0` yields a result with no `costUsd` field.
12. [unit] a `turn_end` with `costSource` `"reported"` and `costUsd` `1.5` yields `costUsd` `1.5`.
13. [unit] a `turn_end` with no `costSource` field and `costUsd` `0.2` yields `costUsd` `0.2`.
14. [unit] when `runSubagent` rejects with a `NaxError`, `runAgentTask` rejects with that same error.

### US-004

1. [unit] when the stubbed `runSubagent` calls `onSession` with a fake session and then emits an answerable `approval_requested` with `requestId` `r1`, `tool` `Bash` and `summary` `rm -rf build`, the fake session's `answer` is called once with `("r1", { decision: "deny" })`.
2. [unit] that run resolves with `deniedAsks` deep-equal to `[{ kind: "approval", tool: "Bash", summary: "rm -rf build" }]`.
3. [unit] an answerable `question` with `requestId` `q1` and `text` `Which file?` makes the fake session's `answer` be called with `("q1", { text: AGENTS_RUN_NO_ANSWER })`.
4. [unit] that run's `deniedAsks` deep-equals `[{ kind: "question", text: "Which file?" }]`.
5. [unit] `AGENTS_RUN_NO_ANSWER` equals `No one is attached to answer. Continue without an answer, or stop and say what you need.`
6. [unit] an `approval_requested` with `answerable: false` is not answered and does not appear in `deniedAsks`.
7. [unit] two answerable asks in one run appear in `deniedAsks` in the order they arrived.
8. [unit] when the fake session's `answer` returns `"expired"`, the ask still appears in `deniedAsks`.
9. [unit] when the fake session's `answer` throws, `runAgentTask` still resolves and the ask still appears in `deniedAsks`.
10. [unit] with `timeoutSeconds` `30` and `_agentsRunExecDeps.setTimeout` and `clearTimeout` driven by `makeFakeClock`, advancing the clock by 30000 ms aborts the `signal` passed to `runSubagent`.
11. [unit] after that timeout fires, a following `turn_end` with status `cancelled` resolves with `status` `"timeout"`.
12. [unit] after that timeout fires, a following `turn_end` with status `completed` still resolves with `status` `"timeout"`.
13. [unit] after that timeout fires, when `runSubagent` returns `{ isError: true, content: "subagent a cancelled: cancelled" }` with no `turn_end`, the run resolves with `status` `"timeout"`.
14. [unit] with `timeoutSeconds` `30`, a run that completes before the clock advances leaves no timer armed: the fake clock's `pending()` is 0 after `runAgentTask` resolves.
15. [unit] with no `timeoutSeconds`, `_agentsRunExecDeps.setTimeout` is never called.
16. [unit] aborting the input `signal` while the run is in flight aborts the `signal` passed to `runSubagent`.
17. [unit] after the input `signal` is aborted, a following `turn_end` with status `cancelled` resolves with `status` `"cancelled"`.
18. [unit] after the input `signal` is aborted, a following `turn_end` with status `completed` still resolves with `status` `"cancelled"`.
19. [unit] with an input `signal` that is already aborted, when `runSubagent` returns `{ isError: true, content: "subagent a cancelled: cancelled" }` with no `turn_end`, the run resolves with `status` `"cancelled"`.
20. [unit] when the timeout fires and then the input `signal` is aborted before the turn ends, the run resolves with `status` `"timeout"`.

### US-005

1. [unit] `agentsRunOutput(result, false)` for a result with status `completed`, output `VERDICT: ready` and no denied asks returns a value deep-equal to `{ stdout: "VERDICT: ready\n", exitCode: 0 }`.
2. [unit] `agentsRunOutput(result, false)` for a result with status `failed`, output `boom` and no denied asks returns a value deep-equal to `{ stderr: "boom\n", exitCode: 1 }`.
3. [unit] `agentsRunOutput(result, false)` for status `cancelled` and output `c` returns a value deep-equal to `{ stderr: "c\n", exitCode: 1 }`.
4. [unit] `agentsRunOutput(result, false)` for status `timeout` and output `t` returns a value deep-equal to `{ stderr: "t\n", exitCode: 1 }`.
5. [unit] `agentsRunOutput(result, false)` for a completed result whose `deniedAsks` is `[{ kind: "approval", tool: "Bash", summary: "rm x" }, { kind: "question", text: "Which?" }]` returns `stderr` equal to `[agents run] denied Bash: rm x\n[agents run] unanswered question: Which?\n`.
6. [unit] `agentsRunOutput(result, false)` for a failed result with output `boom` and one denied approval `Bash` / `rm x` returns `stderr` equal to `boom\n[agents run] denied Bash: rm x\n`.
7. [unit] `agentsRunOutput(result, true)` for a completed result returns `exitCode` 0, no `stderr`, and a `stdout` that is one line ending in a newline whose JSON parse deep-equals the result object.
8. [unit] `agentsRunOutput(result, true)` for a result with status `failed` returns `exitCode` 1, no `stderr`, and a `stdout` whose JSON parse has `status` `failed`.
9. [unit] `agentsRunOutput(result, true)` for a result with no `costUsd` returns JSON with no `costUsd` key.
10. [unit] `agentsRunOutput(result, true)` for a result whose output contains a newline and a double quote returns a `stdout` with exactly one newline, at the end, whose JSON parse restores the output exactly.

### US-006

1. [unit] for an agent with `model: haiku` and a config whose `models.native.fast` is `openai/gpt-fast`, `resolveAgentsRunModel` returns `openai/gpt-fast`.
2. [unit] for an agent with `model: haiku`, `models.native.fast` set and `models.native.balanced` unset, `resolveAgentsRunModel` returns the fast model and does not throw.
3. [unit] `modelOverride` `acp:codex/x` returns `acp:codex/x` even when the agent declares `model: haiku` and `models.native.balanced` is unset.
4. [unit] for an agent with `model: reviewer` and `agent.modelAliases` `{ reviewer: "acp:codex/x" }`, it returns `acp:codex/x`.
5. [unit] for an agent with no `model` and `models.native.balanced` set to the string `openai/gpt-bal`, it returns `openai/gpt-bal`.
6. [unit] for an agent with no `model` and `models.native.balanced` set to `{ provider: "openai", model: "gpt-bal" }`, it returns `openai/gpt-bal`.
7. [unit] for an agent with `model: gpt` (not an alias, tier, `acp:` model or `provider/model`) and `models.native.balanced` `openai/gpt-bal`, it returns `openai/gpt-bal`.
8. [unit] `modelOverride` `nonsense` throws a `NaxError` with code `AGENTS_RUN_USAGE` and message `unknown model nonsense; pass provider/model, acp:<agent>, or a configured alias`.
9. [unit] `modelOverride` `nonsense` with `models.native.balanced` unset throws the message `unknown model nonsense; pass provider/model, acp:<agent>, or a configured alias`.
10. [unit] an agent with no `model`, no `modelOverride` and `models.native.balanced` unset throws a `NaxError` with code `AGENTS_RUN_USAGE` and message `configure models.native.balanced or pass --model`.

### US-007

1. [unit] `AGENTS_RUN_NATIVE_READ_TOOLS` equals `["Read", "Glob", "Grep", "Git", "nax-skills__*", "nax-workflow__*"]`.
2. [unit] `buildAgentsRunTaskInput` calls the stubbed `resolveAgentsRunModel` with `{ agent, config, modelOverride }` from its input and returns `model` equal to what it returned.
3. [unit] when the stubbed `resolveAgentsRunModel` throws a `NaxError`, `buildAgentsRunTaskInput` throws that same error.
4. [unit] for a native model (the stub returns `openai/gpt-bal`) and an agent whose `tools` is undefined, the returned `allowedTools` deep-equals `AGENTS_RUN_NATIVE_READ_TOOLS`.
5. [unit] for an `acp:` model (the stub returns `acp:codex/x`) and an agent whose `tools` is undefined, the returned input has no `allowedTools` field.
6. [unit] for an agent with `tools: ["Read", "Skill"]`, the returned `allowedTools` deep-equals `mapSubagentTools(["Read", "Skill"]).allowedTools`.
7. [unit] the returned `toolProviders` are, in order, the provider the stubbed `createSkillsProvider` returned and the provider the stubbed `createWorkflowProvider` returned.
8. [unit] the loader passed to `createSkillsProvider` resolves to the input `catalog`.
9. [unit] for a config where `isWorkflowMode(config)` is false and `execution.maxIterations` is 7, `createWorkflowProvider` receives an argument deep-equal to `{ repoRoot, outputDir: projectOutputDir(getProjectKey(config, repoRoot), config.outputDir), maxIterations: 7 }`.
10. [unit] for a config where `isWorkflowMode(config)` is true, `createWorkflowProvider` receives `maxIterations` `undefined`.
11. [unit] the stubbed `createRuleDeliveryHandlers` receives an argument deep-equal to `{ repoRoot, overrideDir: config.context.rules.overrideDir, overrideMode: config.context.rules.overrideMode }`.
12. [unit] the returned `loopHandlers` is the set the stubbed `createRuleDeliveryHandlers` returned.
13. [unit] the returned input's `agent`, `task`, `cwd`, `repoRoot`, `config`, `timeoutSeconds` and `signal` are the input's values, compared as one deep-equal object.

### US-008

1. [unit] `agentsRunCommand("a", { dir: "sub", task: "t" }, deps)` calls the stubbed `ensureTrusted` with the absolute path `resolve("sub")`.
2. [unit] that call passes `cwd` equal to `resolve("sub")` to the stubbed `buildAgentsRunTaskInput`.
3. [unit] `repoRoot` passed to `buildAgentsRunTaskInput` is the parent of the directory the stubbed `findProjectDir` returns, and is the resolved `dir` when `findProjectDir` returns null.
4. [unit] for each `timeout` value in the table `0`, `-3`, `1.5`, `abc`, `45abc`, `1e2`, the command calls `writeErr` with `--timeout must be a positive whole number of seconds\n`, sets exit code 2, and never calls `ensureTrusted`.
5. [unit] `timeout` `"45"` makes `buildAgentsRunTaskInput` receive `timeoutSeconds` `45`.
6. [unit] when `ensureTrusted` throws a `NaxError` with code `PROJECT_UNTRUSTED` and context `{ root: "/r", hint: "run: nax trust add /r" }`, `writeErr` is called with `Project not trusted: /r\n` and then `run: nax trust add /r\n`, and the exit code is 2.
7. [unit] in that untrusted case, neither `loadConfig` nor `loadResourceCatalog` is called.
8. [unit] when `ensureTrusted` throws a `NaxError` with code `TRUST_STORE_UNREADABLE` and message `trust store unreadable`, `writeErr` is called with `trust store unreadable\n` and the exit code is 2.
9. [unit] after `useUntrustedRegistry()`, the default `_agentsRunCommandDeps.ensureTrusted` on a temp directory rejects with a `NaxError` code `PROJECT_UNTRUSTED` and never calls `_trustGateDeps.prompt`.
10. [unit] with `profile: ["a,b", "c"]` and `findProjectDir` returning `/repo/.nax`, `loadConfig` is called with `("/repo/.nax", { profile: ["a,b", "c"] })`.
11. [unit] with no `profile` and `findProjectDir` returning null, `loadConfig` is called with exactly one argument, `undefined`.
12. [unit] `loadResourceCatalog` receives an argument deep-equal to `{ repoRoot, config, env: deps.env, naxPluginPackages: [] }`.
13. [unit] when `loadConfig` rejects with an error whose message is `bad config`, `writeErr` is called with `bad config\n` and the exit code is 2.
14. [unit] when `loadResourceCatalog` rejects with an error whose message is `catalog broke`, `writeErr` is called with `catalog broke\n` and the exit code is 2.
15. [unit] when the catalog's `findAgent` returns undefined for `ghost`, `writeErr` is called with `agent ghost not found; see nax agents\n`, the exit code is 2, and `resolveAgentsRunTask` is never called.
16. [unit] with `json: true` and an unknown agent `ghost`, `writeOut` is never called.
17. [unit] when `resolveAgentsRunTask` rejects with a `NaxError` code `AGENTS_RUN_USAGE` and message `skill nope not found`, `writeErr` is called with `skill nope not found\n`, the exit code is 2, and `buildAgentsRunTaskInput` is never called.
18. [unit] when `buildAgentsRunTaskInput` throws a `NaxError` code `AGENTS_RUN_USAGE` with message `configure models.native.balanced or pass --model`, `writeErr` is called with that message and a newline, and the exit code is 2.

### US-009

1. [unit] when `agentsRunCommand` runs with stubbed deps, the stubbed `runAgentTask` is called once with the input the stubbed `buildAgentsRunTaskInput` returned, with its `signal` replaced by the command's own abort signal.
2. [unit] when `runAgentTask` rejects with an error whose message is `cannot build options`, `writeErr` is called with `cannot build options\n` and the exit code is 2.
3. [unit] for a completed plain result, `writeOut` is called with `agentsRunOutput(result, false).stdout`, `writeErr` is not called, and the exit code is 0.
4. [unit] for a `json: true` result with status `timeout`, `writeOut` is called with `agentsRunOutput(result, true).stdout` and the exit code is 1.
5. [unit] for a failed plain result with one denied ask, `writeErr` is called with `agentsRunOutput(result, false).stderr` and the exit code is 1.
6. [unit] invoking the handler the command registered through `onSignal` for `SIGINT` aborts the `signal` that `runAgentTask` received.
7. [unit] invoking the handler the command registered through `onSignal` for `SIGTERM` aborts that same `signal`.
8. [unit] after the run resolves, every unsubscribe that `onSignal` returned has been called.
9. [unit] parsing argv `agents run spec-reviewer --task "review it"` on a commander program whose `agents` command (with `-d, --dir` defaulting to a fixed path) was passed to `registerAgentsRunCommand` with stubbed deps calls the stubbed `runAgentTask` once.
10. [unit] parsing `agents run spec-reviewer --task t -d /d` on that program calls `ensureTrusted` with `/d`.
11. [unit] parsing `agents run spec-reviewer --task t` with no `-d` calls `ensureTrusted` with the `agents` command's default directory.
12. [unit] parsing argv `agents` alone runs the `agents` command's own action and never calls `runAgentTask`.
13. [unit] parsing `agents run spec-reviewer --task t --json --timeout 9 --model m --profile p` delivers `json` true, `timeout` `"9"`, `model` `"m"` and `profile` `["p"]` to the command: `buildAgentsRunTaskInput` receives `timeoutSeconds` 9 and `modelOverride` `m`, and `loadConfig` receives `{ profile: ["p"] }`.
14. [unit] after a parsed run resolves, `exit` is called once, and only after the promises that `writeOut` and `writeErr` returned have resolved.
15. [unit] `agentsRunCommand` and `registerAgentsRunCommand` imported from the `src/cli` barrel are functions.
16. [integration] running `bun bin/nax.ts agents run --help` from `packages/nax` exits 0 with empty stderr, and its stdout contains `--task-file <path>`.
