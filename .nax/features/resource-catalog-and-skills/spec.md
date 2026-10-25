# SPEC: resource-catalog-and-skills — one catalog for Claude Code and nax plugin resources, skills as a tool provider, and chat wiring

## Summary

nax gains one resource catalog. It reads what Claude Code reads (the repo's `.claude/`,
the user's Claude config directory, and every Claude Code plugin enabled in either
`settings.json`), plus what nax plugins now declare through a new data-only `resources`
extension, and turns all of it into one list of skills, commands, subagent definitions,
MCP server entries and hooks, with precedence repo over user over plugin. This feature
delivers two of those kinds. Skills reach the model through a `static` tool provider
`nax-skills` (tool `nax-skills__load`, an index of names and descriptions as provider
instructions), so the same provider serves `nax chat` and, when
`resources.skillsInRun` is set (default off), `nax run`. Commands and skills become chat
slash commands; a command's `` !`cmd` `` lines run through the session's Bash tool under
the session's mode and approvals before the message is sent, using a new
`AgentSession.runCommand`. `nax chat` asks once whether the project is trusted, exactly
as `nax run` does, then loads nax plugins (their loop handlers join the chat session)
and the catalog. `/skills` and `/plugins` list what loaded, from where, and what was
skipped and why; subagents and MCP entries are listed as delivered in a later release,
hooks as not executed.

This is feature F4 of the nax interactive coding agent, slice 1
(`docs/superpowers/specs/2026-10-24-nax-interactive-tui-slice1-design.md` §4.4, §4.5,
§5.1 row F4), as re-architected by the user's rulings of 2026-10-25 recorded in Design.
It builds on F1 (#2691), F2 (#2692) and F3 `nax-chat-shell` (#2695). It changes
`packages/nax-agent` and `packages/nax`.

## Motivation

- **Existing skills must work on day one.** The slice-1 acceptance test is brainstorming
  and spec-reviewing inside the nax TUI with the superpowers and nax-spec-kit skills the
  user already has installed as Claude Code plugins. Nothing in the repo reads a
  `SKILL.md` today.
- **Native agents in `nax run` cannot meet a skill mandate.** A native implementer told
  by `AGENTS.md` to "follow skill X" has no way to load it (its Read is limited to the
  workdir, and the skill lives under the user's Claude config directory), and loops
  into no-work fix rounds. A skills provider that works in `nax run` removes the cause,
  behind an opt-in.
- **One path, not two.** The original slice-1 design (§4.4, §4.5) built skills, MCP and
  subagents as chat-only embedder tools and kept nax's plugin system apart. The
  codebase already has the pieces: `ToolProvider` (namespacing, per-stage attachment,
  provider instructions #2517, tool audit) used by `nax run`; the MCP pool and lock; the
  trust store; and the `loopHandlers` plugin extension modelled on pi extensions
  (#2288). The chat session path is the only one that cannot take a provider. The user
  ruled (2026-10-25) a shared catalog over those seams instead.
- **Plugins should be able to ship skills.** A nax plugin today can contribute code
  (reviewers, reporters, loop handlers) but no instructions. A declarative `resources`
  extension lets one nax plugin ship skills and commands the same way a Claude Code
  plugin does, with no new code-execution surface.

## Design

### Approach

**User rulings (2026-10-25) this design implements.** (1) The architecture: sources ->
catalog -> delivery through existing seams, replacing the design doc's "kept apart".
(2) pi's Agent Skills directories (`.agents/skills`, `~/.agents/skills`) are NOT read.
(3) The skills provider in `nax run` is off by default and configurable. (4) `nax chat`
uses the existing all-or-nothing trust gate, like Claude Code: trust is settled before
anything loads, so the catalog has no trust filter. (5) One feature. (6) The catalog
parses every kind now (skills, commands, agents, MCP entries, hooks) and delivers only
skills and commands. (7) A command's `` !`cmd` `` lines run through the session's Bash
tool with the session's approvals. (8) Config lives in a top-level `resources` block.

```
 SOURCES                                  CATALOG (packages/nax/src/resources/)   DELIVERY (existing seams)
 claude-project  <repo>/.claude/...         ResourcePackage[]  ->  ResourceCatalog   nax-skills provider (ToolProvider)
 claude-user     <claudeDir>/...            precedence project > user > plugin       -> nativeBackend({ toolProviders }) in chat
 claude-plugin   enabledPlugins ->          collisions -> qualified names            -> runtime.toolProviders in nax run (opt-in)
                 installed_plugins.json     diagnostics, never fatal                 slash commands in the chat shell
 nax-plugin      NaxPlugin.resources                                                 /skills, /plugins listings
```

**1. nax-agent: `toolProviders` on `nativeBackend` (US-001).** `NativeBackendOptions`
gains `toolProviders?: readonly ToolProvider[]`. `openNative` resolves them with the
existing `resolveProviderTools(providers, SESSION_STAGE, ctx.workdir)` (skipped for
profile `none`) and passes the result to `buildSessionToolSupport` as a new optional
`providerTools` argument. `buildSessionToolSupport` then, mirroring what nax's
`unionDeclaredTools` does for `nax run` (that helper lives in `packages/nax` and cannot
be imported here, so the session path does the same union locally):

- unions the provider tool names into `declared` before computing grants, so
  `buildCodingToolSupport`'s `runtime.advertised(declared)` advertises them;
- passes `extraTools: providerTools.tools`, `providerIdByTool` and
  `providerInstructions: renderProviderInstructions(providerTools.instructions ?? [])`
  (when defined) to `buildCodingToolSupport`;
- returns `grants` = the profile grants plus `providerTools.grants`.

`openNative` uses `support.tools` as the coding tools exactly as today (no second
append) and passes `support.providerInstructions` to `adapter.openSession` as its
existing `providerInstructions` option (`OpenSessionOpts.providerInstructions`), which
the native session folds into the system prompt. Rules:

- Only `kind: "static"` providers are accepted in this feature; a `discovered` provider
  is refused at option validation with `AGENT_SESSION_INVALID_OPTIONS` and path
  `backend.toolProviders` (MCP delivery to sessions is F5).
- Every profile but `none` attaches each provider whose `stages` contain `"*"` or
  `"session"`.
- A provider whose `tools()` throws is skipped (the existing `failures` list); the
  session still opens.
- An embedder tool and a provider tool may not share a name; the open refuses with
  `AGENT_SESSION_TOOL_NAME_RESERVED`.

**2. nax-agent: `AgentSession.runCommand` (US-002).** A user-initiated shell command
that runs through the session's own Bash tool, the way Claude Code runs a command
file's `` !`cmd` `` lines. Target:

```ts
// packages/nax-agent/src/session/agent-session-types.ts
export interface CommandRunResult {
  /** The Bash tool's result text as the model would see it (capped by the tool runtime). */
  readonly content: string;
  readonly isError: boolean;
}

export interface AgentSession {
  // ...existing members unchanged...
  /**
   * Run one shell command through the session's Bash tool, outside any model
   * turn. Optional on the interface so hand-written AgentSession fakes stay
   * valid; the facade from createAgentSession always provides it.
   */
  runCommand?(command: string, onEvent: (event: SessionEvent) => void): Promise<CommandRunResult>;
}

// packages/nax-agent/src/session/session-backend.ts
export interface OpenedBackend {
  // ...existing members unchanged...
  /** Absent on a backend that cannot run a host-side command (ACP). */
  runCommand?(request: { command: string; callId: string; signal: AbortSignal }): Promise<CommandRunResult>;
}
```

**Native half** (in `openNative`), over the interaction handler the turn uses:

```ts
runCommand: async ({ command, callId, signal }) => {
  try {
    const response = await interactionHandler.onInteraction({
      kind: "coding-tool", name: "Bash", input: { command }, toolCallId: callId, signal,
    });
    if (response === null) return { content: "Bash is not available in this session", isError: true };
    return { content: response.answer, isError: response.denied !== undefined };
  } catch (error) {
    return { content: errorMessage(error), isError: true };
  }
},
```

So the command takes exactly the path a model's Bash call takes (policy, the mode's
`bashApproval`, the ask resolver, the sandbox launcher, the per-command `unsandboxed`
rules); a denial and a tool error (`AGENT_SESSION_TOOL_ERROR`) both come back as
`isError: true`. The content is the tool runtime's result, capped at its
`DEFAULT_TOOL_MAX_BYTES` (40,000).

**Facade half** (new file `packages/nax-agent/src/session/agent-session-command.ts`).
`send()`'s `claimTurn` cannot be reused: it always runs a model turn (`turn_start`,
`markTurn`, `adapter.sendTurn`). A separate claim path:

1. Refuses with `AGENT_SESSION_CLOSED` when the session is closing or closed,
   `AGENT_SESSION_BUSY` when `active` is set, and `AGENT_SESSION_CAPABILITY_UNSUPPORTED`
   when the opened backend has no `runCommand`.
2. Sets `active` to a claim with its own `AbortController` (so `cancel()` aborts it and
   `close()` awaits its `settled` promise); `active`'s type widens from `ClaimedTurn` to
   `Pick<ClaimedTurn, "turnId" | "settled" | "cancel">`, since a command has no
   `iterable` and sets the ask slot
   `slot.turn = { turnId, signal, emit }`, where `turnId` is a fresh id and `emit` wraps
   each body in the event envelope (`sessionId`, `turnId`, `at`, `metadata`) and calls
   `onEvent`; this is what lets `createSessionAskPort` raise `approval_requested` during
   the command.
3. Applies the session's turn deadline to the abort signal.
4. Emits `tool_call` (name `Bash`, input `{ command }`, `callId`), awaits
   `backend.runCommand`, emits `tool_result`, then clears `slot.turn` and `active` in a
   `finally`. Both events are built with the same redaction and preview-cap helpers
   `src/session/turn-event.ts` applies to a model's tool calls, so a command carrying a
   secret is redacted in events exactly as a model call would be.
5. Never emits `turn_start`, `usage` or `turn_end`, never calls the model, and writes
   nothing to the transcript; the output reaches the model only through the message the
   caller sends next.

A cancel or deadline while the command runs resolves `{ isError: true }` (the abort
makes the Bash tool return its abandoned result); it does not reject.

**3. Config (US-003).** New file `packages/nax/src/config/schemas-resources.ts`:

```ts
export const ResourcesConfigSchema = z.object({
  /** Read Claude Code skills, commands, agents, .mcp.json, hooks and enabled plugins. */
  claudeCode: z.boolean().default(true),
  /** Attach the skills provider to nax run stages as well as nax chat. */
  skillsInRun: z.boolean().default(false),
});
```

registered in `NaxConfigSchema` as `resources: ResourcesConfigSchema.default(() =>
ResourcesConfigSchema.parse({}))`, layered global -> project like every block. The
hand-written `NaxConfig` interface (`src/config/runtime-types.ts`) gains
`resources?: ResourcesConfig` (optional, like `mcp`), and every reader uses
`config.resources?.claudeCode ?? true` / `config.resources?.skillsInRun ?? false`, so a
sparse test config without the block behaves as the defaults.

**4. Paths (US-003).** `claudeConfigDir(env)` in `packages/nax/src/resources/claude-paths.ts`
returns `env.CLAUDE_CONFIG_DIR` when set (Claude Code's own override) and otherwise
`join(_claudePathsDeps.homedir(), ".claude")`. Every Claude Code path below is under
that directory or under the repo root; tests point `CLAUDE_CONFIG_DIR` at a fixture.

**5. Frontmatter (US-003).** `readResourceFrontmatter(text)` in
`packages/nax/src/resources/frontmatter.ts` returns `{ data: Record<string, unknown>;
body: string } | { error: string }`. The block is the text between a leading `---` line
and the next `---` line; no leading `---` means empty data and the whole text as body.
It parses the block with `Bun.YAML.parse` (the `.nax/rules` parser `parseFrontmatter`
is rules-specific and rejects unknown keys, so it is not reused). When that throws, it
falls back to a line reader: each line `key: value` whose key matches
`^[A-Za-z][A-Za-z0-9_-]*$` sets `data[key]` to the trimmed rest of the line (one
surrounding pair of matching quotes removed; `true`/`false` become booleans), and other
lines are ignored. Claude Code accepts frontmatter like `description: Use when X.
Triggers: "a", "b"` that strict YAML rejects (23 of 310 installed `SKILL.md` files on
2026-10-25, all copies of `nax-finish`); the fallback keeps them loading. A block with
no closing `---` is `{ error }`. An empty block, or YAML that parses to `null`, is
empty data; YAML that parses to a non-object (a list or a scalar) is `{ error }`.

**6. Resource model, parsers and scanners (US-003, US-004, US-005).**
`packages/nax/src/resources/types.ts`:

```ts
export type ResourceOrigin =
  | { readonly kind: "claude-project" }
  | { readonly kind: "claude-user" }
  | { readonly kind: "claude-plugin"; readonly plugin: string; readonly marketplace: string }
  | { readonly kind: "nax-plugin"; readonly plugin: string };

export interface SkillResource {
  readonly kind: "skill";
  readonly name: string;            // frontmatter name, else the directory name
  readonly qualifiedName: string;   // "<plugin>:<name>" for plugin origins, else name
  readonly description: string;
  readonly body: string;            // SKILL.md without its frontmatter
  readonly baseDir: string;         // absolute directory holding SKILL.md
  readonly path: string;            // absolute SKILL.md path
  readonly modelInvocable: boolean; // false when disable-model-invocation: true
  readonly origin: ResourceOrigin;
}
export interface CommandResource {
  readonly kind: "command";
  readonly name: string;            // file name without .md
  readonly qualifiedName: string;
  readonly description?: string;
  readonly argumentHint?: string;
  readonly template: string;        // body without frontmatter
  readonly path: string;
  readonly origin: ResourceOrigin;
}
export interface AgentResource {    // parsed and listed only (delivered in F5)
  readonly kind: "agent";
  readonly name: string; readonly qualifiedName: string; readonly description: string;
  readonly model?: string; readonly tools?: readonly string[];
  readonly path: string; readonly origin: ResourceOrigin;
}
export interface McpServerResource { // parsed and listed only (delivered in F5)
  readonly kind: "mcp";
  readonly name: string; readonly transport: "stdio" | "http" | "sse";
  readonly path: string; readonly origin: ResourceOrigin;
}
export interface HookResource {      // parsed and listed only, never executed
  readonly kind: "hooks";
  readonly events: readonly string[]; readonly path: string; readonly origin: ResourceOrigin;
}
export interface ResourceDiagnostic {
  readonly severity: "warn" | "error";
  readonly path: string;
  readonly message: string;
  readonly origin: ResourceOrigin;
}
export interface ResourcePackage {
  readonly id: string;              // "claude-project" | "claude-user" | "<name>@<marketplace>" | "nax:<name>"
  readonly origin: ResourceOrigin;
  readonly root: string;
  readonly skills: readonly SkillResource[];
  readonly commands: readonly CommandResource[];
  readonly agents: readonly AgentResource[];
  readonly mcpServers: readonly McpServerResource[];
  readonly hooks: readonly HookResource[];
  readonly diagnostics: readonly ResourceDiagnostic[];
}
```

Each parser returns `{ resource } | { diagnostic }` and never throws:

- `parseSkillFile(path, text, origin)`: `name` = frontmatter `name` or the parent
  directory name, matching `SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`;
  `description` required (non-empty string); `disable-model-invocation: true` sets
  `modelInvocable: false`; other keys (`allowed-tools`, `license`, `model`) ignored.
- `parseCommandFile(path, text, origin)`: `name` = file name without `.md`, same regex;
  `description` and `argument-hint` optional strings.
- `parseAgentFile(path, text, origin)`: `name` and `description` required; `model`
  optional string; `tools` a comma-separated string or a string list.
- `parseMcpJson(path, text, origin)`: the `mcpServers` object; one resource per entry;
  `transport` is the entry's `type` when it is `http` or `sse`, else `stdio` when it has
  a string `command`; any other entry is a `warn` diagnostic and skipped. Text that is
  not JSON is one `error` diagnostic.
- `parseHooksJson(path, text, origin)` (a plugin's `hooks/hooks.json`) and
  `hooksFromSettings(path, settings, origin)` (a `settings.json` `hooks` key): one
  `HookResource` listing the event names (the object's keys); no `hooks` key -> none.

Scanners in `scan-dirs.ts`: `scanSkillsDir(dir, origin)` reads `<dir>/*/SKILL.md` (one
level; hidden directories skipped); `scanCommandsDir(dir, origin)` and
`scanAgentsDir(dir, origin)` read `<dir>/*.md` (top level only). A missing directory
yields nothing; an unreadable file yields an `error` diagnostic and the scan continues.
Entries are read in name order (sorted), so the cap and every shadowing winner are
deterministic. Each scan caps at `MAX_RESOURCE_FILES_PER_DIR = 500` and adds one `warn` diagnostic
when it truncates. File reads and directory listing go through `_resourceFsDeps` so
tests can make one read fail.

**7. Claude Code sources (US-006).** `discoverClaudeCodePackages({ repoRoot, claudeDir })`
returns packages in this order:

1. `claude-project` (root `repoRoot`): `.claude/skills`, `.claude/commands`,
   `.claude/agents`, `<repoRoot>/.mcp.json`, `hooks` of `.claude/settings.json`.
2. `claude-user` (root `claudeDir`): `skills`, `commands`, `agents`, `hooks` of
   `<claudeDir>/settings.json`. (User-level MCP servers live in `~/.claude.json`; F5.)
3. One `claude-plugin` package per enabled plugin. The enabled set is the
   `enabledPlugins` object of `<claudeDir>/settings.json` overlaid by the one in
   `<repoRoot>/.claude/settings.json` (a project `false` disables a user `true`); keys
   with value `true` survive, in user-then-project insertion order. Each key
   `<name>@<marketplace>` is looked up in `<claudeDir>/plugins/installed_plugins.json`
   (`version: 2`, `plugins[key]` an array of install records). The record used is the
   first with `scope: "user"`, else the first with `scope: "project"` whose
   `projectPath` equals `repoRoot`. Its `installPath` is the package root. The plugin
   name is `.claude-plugin/plugin.json`'s `name` when that file exists and parses, else
   `<name>` from the key. The package reads `skills/`, `commands/`, `agents/`,
   `.mcp.json` and `hooks/hooks.json` under the root.

Real layout observed 2026-10-25: `installed_plugins.json` `version: 2`, every record
`scope: "user"`; superpowers 7.0.0 has `.claude-plugin/plugin.json` and `skills/`;
commit-commands has no `.claude-plugin/` at all, only `commands/`.

**8. The catalog (US-007).** `buildResourceCatalog(packages)` merges in package order;
`loadResourceCatalog({ repoRoot, config, env, naxPluginPackages })` calls
`discoverClaudeCodePackages({ repoRoot, claudeDir: claudeConfigDir(env) })` only when
`config.resources?.claudeCode ?? true`, appends the nax plugin packages after the Claude
Code plugin packages, and builds the catalog.

```ts
export interface ResourceCatalog {
  readonly packages: readonly ResourcePackage[];
  readonly skills: readonly SkillResource[];      // every loaded skill, package order
  readonly commands: readonly CommandResource[];
  readonly diagnostics: readonly ResourceDiagnostic[]; // package diagnostics + collisions
  findSkill(name: string): SkillResource | undefined;   // short or qualified name
  findCommand(name: string): CommandResource | undefined;
}
```

Precedence for a short name: the first package in order wins (project, user, Claude
Code plugins in enabled order, nax plugins). A later skill with the same short name
stays reachable by its qualified name `<plugin>:<name>` and adds a `warn` diagnostic
`skill <name> from <id> is shadowed by <winner id>; use <qualifiedName>`. Commands
follow the same rule.

**9. nax plugin `resources` extension (US-008).** `PluginType` and `VALID_PLUGIN_TYPES`
(`src/plugins/validator.ts`) gain `"resources"`; `PluginExtensions.resources?:
IResourceProvider`:

```ts
export interface IResourceProvider {
  /** Directories relative to the plugin module's directory. */
  readonly skills?: string;
  readonly commands?: string;
  readonly agents?: string;
}
```

`validatePlugin` checks each present field is a non-empty relative path with no `..`
segment. `PluginRegistry.getResourceDirs()` returns, for each plugin providing
`"resources"` whose source type is `global`, `project` or `config`,
`{ plugin, skills?, commands?, agents? }` resolved to absolute paths against
`dirname(getSource(plugin).path)`. `global` and `project` sources already record the
absolute plugin file path; the loader changes the `config` source to record its
`resolvedModule` (absolute for a `./` or `../` module, resolved against the project
root, and unchanged for an npm package name) instead of the raw `entry.module`. A
source path that is not absolute (an npm package) or a `builtin` source is skipped with
a `warn` log naming the plugin. `naxPluginPackages(dirs)` in
`packages/nax/src/resources/nax-plugin-packages.ts` scans them into one package per
plugin, origin `nax-plugin`, id `nax:<plugin>`.

**10. Prompt builders (US-009).** New `packages/nax/src/prompts/builders/skills-builder.ts`,
exported from `src/prompts/index.ts` (the prompt-builder rule: every model-facing text
assembly lives under `src/prompts/builders/`):

- `buildSkillsInstructions(entries: readonly { qualifiedName: string; description: string }[])`:
  one paragraph telling the model to call `nax-skills__load` with a skill name before
  acting on a task a skill matches and to load a skill's `references` files with
  `file`; then one line per entry `- <qualifiedName>: <description>`, where the
  description has control characters removed, every whitespace run collapsed to one
  space, and is cut to 200 characters; at most `MAX_SKILLS_INDEX_ENTRIES = 150` lines,
  then `- ... and <n> more`.
- `buildSkillInvocationMessage({ skill, args })`: a `<skill name="<qualifiedName>"
  location="<path>">` block holding the line `References are relative to <baseDir>;
  load them with nax-skills__load and file.` and the body, closed by `</skill>`, then
  the args after a blank line when non-empty.
- `buildCommandMessage(template, rest)`: `$ARGUMENTS` -> the trimmed rest; `$1`..`$9` ->
  the whitespace-split args (missing -> empty); when the template has none of those
  placeholders and the rest is non-empty, `\n\nARGUMENTS: <rest>` is appended.

**11. The skills provider (US-010).** `createSkillsProvider(load: () => Promise<ResourceCatalog>)`
in `packages/nax/src/resources/skills-provider.ts`, mirroring
`packages/nax/src/forge-tools/provider.ts`:

- `id: "nax-skills"` (the `nax-` prefix, like `nax-forge`, keeps it clear of an MCP
  server the user names `skills`), `kind: "static"`, `stages: ["*"]`; `load` is called
  once and memoised.
- One tool, `localName: "load"` (advertised `nax-skills__load`). Input
  `{ name: string; file?: string }`.
- Without `file`: returns `Base directory for this skill: <baseDir>`, a blank line, then
  the body.
- With `file`: returns the text of `join(baseDir, file)` when `file` is relative, has
  no NUL byte, resolves (through `realpath`) inside the skill's real `baseDir`, names a
  regular file, and is at most `MAX_SKILL_FILE_BYTES = 262_144` bytes. This is how the
  model reads a skill's `references/*.md`, which its Read tool cannot reach outside the
  workdir.
- A skill with `modelInvocable: false` refuses the body fetch (no `file`) but serves
  `file` reads, so a skill the user invoked by slash command can still read its
  references.
- Errors (all `isError: true`, no throw): unknown name ->
  `unknown skill <name>; available: <up to 20 qualified names>`; a body fetch for a
  skill with `modelInvocable: false` -> `skill <name> can only be invoked by the user`; an absolute
  `file`, a NUL byte, or a path resolving outside -> `file <file> is outside skill
  <name>`; missing -> `skill <name> has no file <file>`; a directory -> `file <file> is
  not a regular file`; too large -> `file <file> exceeds 262144 bytes`.
- `tools()` returns `[]` when the catalog has no skill at all, so the provider
  advertises nothing; `instructions()` returns `buildSkillsInstructions` over the
  model-invocable skills, or `undefined` when there are none.

**12. `nax run` opt-in (US-011).** In `createRuntime` (`packages/nax/src/runtime/index.ts`),
when `config.resources?.skillsInRun ?? false` is true, `toolProviders` gains
`createSkillsProvider(() => loadResourceCatalog({ repoRoot: workdir, config, env:
process.env, naxPluginPackages: [] }))` after the MCP providers. `createRuntime` stays
synchronous because the catalog loads lazily; the call goes through a new
`_runtimeResourceDeps = { loadResourceCatalog }` in `runtime/index.ts` so tests can
observe it. Run stages receive it through
`buildRunDispatchOptions(ctx, params)` (`src/operations/call-run-options.ts`, whose
private `runtimeDispatchFields` puts `runtime.toolProviders` first in the returned
`providers`) and attach it under the existing
`providerScope` rules (`unrestricted` attaches all; `scoped` only what the stage's
`Mcp(nax-skills:load)` rule admits; `safe` none). nax plugin resource packages are not
added in `nax run` in this feature.

**13. Chat composition (US-012).** `chatCommand` (`packages/nax/src/cli/chat.ts`):

1. After the existing TTY and mode checks, and before the `try` around `composeChat`,
   awaits `_chatCommandDeps.ensureTrusted(cwd)`, whose default is
   `ensureProjectTrusted(await normalizeTrustPath(resolveTrustRoot(cwd)), { interactive: true })`
   (the same steps `runTrustGate` takes, without its `process.exit`). A rejection with
   `NaxError` `PROJECT_UNTRUSTED` writes `Project not trusted: <root>` and the error's
   `context.hint` line to stderr and sets exit code 2; `TRUST_STORE_UNREADABLE` writes
   its message and sets exit code 2; any other rejection writes its message and sets
   exit code 1; nothing else runs in any of these cases.
2. `composeChat` then awaits `_chatCommandDeps.loadPlugins(join(globalConfigDir(),
   "plugins"), join(repoRoot, ".nax", "plugins"), config.plugins ?? [], repoRoot,
   config.disabledPlugins)`; a rejection writes `nax plugins unavailable: <message>` and
   continues with no plugins. Then `_chatCommandDeps.loadResourceCatalog({ repoRoot,
   config, env: process.env, naxPluginPackages: naxPluginPackages(registry.getResourceDirs()) })`.
3. `createChatHost` gets a new optional `resources` dependency (`ChatResources`):
   `{ catalog, toolProviders: [createSkillsProvider(async () => catalog)],
   pluginHandlers: registry.getLoopHandlers(), naxPlugins: [{ name, provides }] per
   loaded plugin, teardown: () => registry.teardownAll() }`.
4. `NativeChatHost` passes `toolProviders` through `openChatSession` (new optional
   request field) to `nativeBackend({ toolProviders })`, and opens every session with
   `loopHandlers` = the plugin handlers followed by the rule-delivery handlers (the
   order `configureRunRules` uses), one frozen array built once in the constructor.
   `host.close()` calls `teardown` once, after the session handle is released. The host
   exposes `catalog` and `naxPlugins` (both optional, undefined without `resources`).

**14. Slash commands (US-013).** `runSlashCommand` resolves, in order: the built-in
commands; then `host.catalog?.findCommand(name)`; then `host.catalog?.findSkill(name)`;
else `unknown command /<name>`. Plugin resources answer to `/<plugin>:<name>` and, when
not shadowed, `/<name>`. A skill returns `buildSkillInvocationMessage({ skill, args:
rest })` as a `send` outcome (also for `modelInvocable: false` skills: the user
invoked it); a command returns a `command` outcome that `ChatApp` turns into
`buildCommandMessage(template, rest)` (after shell expansion, US-014). `/help` lists the
built-ins, then each catalog command and skill as `/<name> - <description>`.

**15. Command shell lines (US-014).** `ChatHost` gains optional `runCommand(command,
onEvent)` over `session.runCommand`; it routes `approval_requested`,
`approval_resolved` and `question` events to `asks.handle` through a helper
`routeAskEvent` extracted from `runChatTurn` (`src/chat/turn-runner.ts`), which
`runChatTurn` then also uses. `runCommandShellLines(text, run)` in
`packages/nax/src/resources/command-shell.ts` finds each `` !`<cmd>` `` occurrence
(`COMMAND_SHELL_RE = /!`([^`\n]+)`/g`) in one pass, runs them in order with `run`, and
builds the output by concatenating the literal segments and each result's `content`
(no string-pattern replacement, so `$&` in output stays literal, and output is never
re-scanned for shell lines). It returns `{ text } | { failed: { command, reason } }`,
stopping at the first result with `isError: true` (reason = its first content line) or
the first rejection (reason = the error message).

Shell lines are expanded ONLY for catalog commands, and only in the command's
template before argument substitution: a skill body, a `/feature` spec, or anything the
user typed as arguments is never scanned, so text that merely shows `` !`cmd` `` never
runs it. To make that decidable, `runSlashCommand` (US-013) returns a `SlashOutcome`:
`{ kind: "send"; message }` for skills and `/feature`, `{ kind: "command"; name;
template; rest }` for catalog commands, or `undefined` for local commands. In `ChatApp`,
`sendTurn` gains an optional `prepare: () => Promise<{ message } | { notice }>` that
runs inside the existing `sending` window (after the `if (sending.current) return`
guard sets `sending`, before `host.send`, with the one `finally` / `finishTurn`). For a
command outcome, `prepare` runs `runCommandShellLines(template, (cmd) =>
host.runCommand(cmd, onEvent))` and then `buildCommandMessage(expanded, rest)`. Because
it runs outside `keys.runControl` and inside `sending`, the ask prompt is active and
Ctrl-C calls `host.cancel()` (which cancels the session's pending `runCommand`). On failure nothing is sent and the
transcript shows `command /<name> not sent: !\`<cmd>\` failed: <reason>`. A host with no
`runCommand` fails the expansion with reason `this session cannot run commands`. In
`full` mode no ask is raised (the mode's `raw` approval).

**16. Listings (US-015).** In `packages/nax/src/resources/listing.ts`:
`formatSkillsListing(catalog)` prints one line per catalog skill,
`<qualifiedName>  <origin label>  <path>`, the label being `project`, `user`,
`plugin <name>` or `nax-plugin <name>`, then each diagnostic whose path is a `SKILL.md`.
`formatPluginsListing(catalog, naxPlugins)` prints `Claude Code plugins` (each
`claude-plugin` package id with `skills N, commands N, agents N (not delivered yet), mcp
N (not delivered yet), hooks N (not executed)`, then its diagnostics, or `(none)`) and
`nax plugins` (each loaded nax plugin name and its `provides` joined by `, `, or
`(none)`). `/skills` and `/plugins` are built-ins that show them. The host's new
`resourceNotice()` returns `hooks declared by <n> package(s) are not executed by nax`
on its first call when any package declares hooks, and `undefined` on every later call;
`ChatApp` reads it once at mount and appends it, so it does not repeat on resume.

### Integration (extends existing code)

Read and called, unchanged:

- `resolveProviderTools(providers, stage, workdir, options?)` -> `ResolvedProviderTools`
  (`tools`, `grants`, `providerIdByTool`, `instructions?`, `failures`) —
  `packages/nax-agent/src/tools/provider-advertise.ts`, exported from the package entry.
- `renderProviderInstructions(entries)` — package entry of `@nathapp/nax-agent`.
- `ToolProvider` / `ProviderTool` — `packages/nax-agent/src/tools/provider-types.ts`.
- `buildCodingToolSupport(args)` accepts `declared`, `extraTools`, `providerIdByTool`,
  `providerInstructions` and `grants`, advertises `runtime.advertised(declared)`, and
  returns `providerInstructions` — `packages/nax-agent/src/coding-tools/coding-tool-support.ts`.
- `unionDeclaredTools(declared, providerResult)` —
  `packages/nax/src/agents/coding-tool-support-resolve.ts:317`, the `nax run` precedent
  US-001 mirrors inside nax-agent.
- `OpenSessionOpts.providerInstructions` — `packages/nax-agent/src/session/session-types.ts:209`.
- `InteractionHandler.onInteraction(request)` -> `AdapterInteractionResponse | null`
  (`answer`, `denied?`) — `packages/nax-agent/src/session/interaction-handler.ts`.
- `createSessionAskPort` raises asks only while `slot.turn` is set —
  `packages/nax-agent/src/session/session-ask-port.ts`.
- `SESSION_STAGE = "session"` — `packages/nax-agent/src/session/session-tool-support.ts:24`.
- `ensureProjectTrusted(root, { interactive })`, `resolveTrustRoot(workdir)`,
  `normalizeTrustPath(path)` — `packages/nax/src/trust`; the plugin loader already calls
  `assertTrusted(root, "plugins")` before importing a project plugin
  (`packages/nax/src/plugins/loader.ts:248`).
- `loadPlugins(globalDir, projectDir, configPlugins, projectRoot?, disabledPlugins?, ...)`
  -> `PluginRegistry` with `getLoopHandlers()`, `getSource(name)`, `teardownAll()`.
- `createForgeReadProvider` — `packages/nax/src/forge-tools/provider.ts`, the static
  provider pattern copied here.
- `buildRunDispatchOptions(ctx: CallContext, params: RunDispatchOptionsParams)` —
  `packages/nax/src/operations/call-run-options.ts:65`; its returned `providers` start
  with `runtime.toolProviders`.
- `globalConfigDir()` — `@/config`.

Changed. The baseline locates the code; the target is the interface to implement.

- `NativeBackendOptions` — Baseline: no provider field. Target: adds
  `readonly toolProviders?: readonly ToolProvider[]` (validated: each entry has a string
  `id`, `kind: "static"`, a `stages` string array and a `tools` function).
- `SessionToolSupportArgs` / `buildSessionToolSupport` — Baseline: tools from the
  profile only. Target: optional `providerTools?: ResolvedProviderTools`, unioned into
  `declared` and forwarded (Approach 1); returned grants include provider grants.
- `AgentSession` — Baseline: `send`, `answer`, `cancel`, `close`. Target: adds optional
  `runCommand?(command, onEvent): Promise<CommandRunResult>` (Approach 2).
- `OpenedBackend` — Target: adds optional `runCommand(request)`.
- `NaxConfig` (`src/config/runtime-types.ts`) / `NaxConfigSchema` — Target: adds
  optional `resources` (Approach 3).
- `PluginType` / `VALID_PLUGIN_TYPES` / `PluginExtensions` / `validatePlugin` /
  `PluginRegistry` — Target: adds `"resources"`, `PluginExtensions.resources`, the
  validator case and `getResourceDirs()`.
- `OpenChatSessionRequest` — Target: adds `readonly toolProviders?: readonly ToolProvider[]`.
- `ChatHostDeps` — Target: adds `readonly resources?: ChatResources`; absent -> today's
  behaviour (no providers, rule handlers only).
- `ChatHost` — Target: adds optional `catalog?`, `naxPlugins?`, `runCommand?` and
  `resourceNotice?()`.
- `runChatTurn` — Target: uses the extracted `routeAskEvent`; behaviour unchanged.
- `_chatCommandDeps` — Target: adds `ensureTrusted`, `loadPlugins`, `loadResourceCatalog`.
- `createRuntime` — Target: appends the skills provider when `resources.skillsInRun`.

### Failure Handling

| Situation | Behaviour |
|---|---|
| A `discovered` provider passed to `nativeBackend` | `AgentSessionError` `AGENT_SESSION_INVALID_OPTIONS`, path `backend.toolProviders`. |
| A provider's `tools()` throws at open | The provider is skipped; the session opens with the others. |
| A provider tool name equals an embedder tool name | Open refuses with `AGENT_SESSION_TOOL_NAME_RESERVED`. |
| `runCommand` while a turn runs, or `send` while a command runs | `AgentSessionError` `AGENT_SESSION_BUSY`. |
| `runCommand` on a backend without `runCommand` | `AgentSessionError` `AGENT_SESSION_CAPABILITY_UNSUPPORTED`. |
| `runCommand` on a closed session | `AgentSessionError` `AGENT_SESSION_CLOSED`. |
| `runCommand` whose approval is denied, or whose tool errors | Resolves `{ isError: true }`; no throw. |
| `runCommand` cancelled or past its deadline | Resolves `{ isError: true }`. |
| Frontmatter that strict YAML rejects | Line-reader fallback; the resource loads when its required keys are found. |
| A skill with no description or a bad name, or frontmatter with no closing `---` | `error` diagnostic naming the path; the resource is skipped. |
| A resource directory missing | Nothing loaded from it; no diagnostic. |
| A resource file unreadable | `error` diagnostic; other files still load. |
| More than 500 files in one scanned directory | First 500 load; one `warn` diagnostic. |
| `installed_plugins.json` missing | No Claude Code plugin packages; one `warn` diagnostic when any plugin is enabled. |
| `installed_plugins.json` unparseable, or `version` other than 2 | No Claude Code plugin packages; one `error` diagnostic. |
| An enabled plugin with no usable install record | `warn` diagnostic `plugin <key> is enabled but not installed`; skipped. |
| An install path that no longer exists | `warn` diagnostic; skipped. |
| A `settings.json` that does not parse | `error` diagnostic; no enabled plugins and no hooks from that file. |
| Two packages share a short skill or command name | Earlier package wins the short name; `warn` shadowing diagnostic; loser reachable by qualified name. |
| A nax plugin `resources` path absolute, empty or containing `..` | `validatePlugin` refuses the plugin (existing loader behaviour for an invalid plugin). |
| `nax-skills__load` unknown name / user-only skill / file outside, absolute or with NUL / missing / a directory / too large | `isError: true` result with the Approach 11 message. |
| Chat in an untrusted project, prompt declined | stderr `Project not trusted: <root>` plus the hint, exit 2, nothing loaded. |
| Trust store unreadable | stderr with the error message, exit 2. |
| `loadPlugins` rejects in chat | stderr `nax plugins unavailable: <message>`; chat starts with no plugin handlers and no nax plugin resources. |
| A command's `` !`cmd` `` fails, is denied, or the host cannot run commands | Nothing sent; transcript notice `command /<name> not sent: ...`. |

## Out of Scope

- Subagents (`agents/*.md`), the `Agent` tool, `/agents` and `agent.modelAliases` are delivered in F5; this feature only parses and lists them.
- MCP servers from `.mcp.json` and plugins are delivered in F5 through the existing MCP pool; this feature only parses and lists them, and `nativeBackend` refuses `discovered` providers until then.
- User-level MCP servers in `~/.claude.json` are not read.
- Claude Code hooks are parsed and listed, never executed.
- pi's Agent Skills directories (`.agents/skills` and `~/.agents/skills`) and pi packages are not read (user ruling 2026-10-25).
- Claude Code plugin manifests that declare custom component paths (`commands`, `agents`, `skills`, `hooks`, `mcpServers` fields in `plugin.json`) are not honoured; only the default directories are read.
- Command files in subdirectories of `commands/` and `@file` references inside command templates are not supported; `@file` is sent literally.
- `.claude/settings.local.json` and managed (enterprise) settings are not read.
- Marketplace operations (install, update, enable) are not provided; nax reads what Claude Code installed.
- The skills provider in `nax run` does not include nax plugin resources; only `nax chat` loads nax plugins into the catalog.
- A skill's `allowed-tools` and `model` frontmatter are ignored; a skill runs with the session's tools and model.
- The `resources` block is not added to the root-only key pins and has no per-package (`.nax/mono/<pkg>/config.json`) semantics; the catalog is built once per repository from the merged config.
- A `restricted` chat mode for untrusted projects is not added; an untrusted chat exits.
- `runCommand` output is not written to the transcript and costs nothing; there is no `usage` event for it.
- US-002 only: the turn-deadline and tool-error (`AGENT_SESSION_TOOL_ERROR`) paths of `runCommand` reuse the existing deadline and the existing `onInteraction` error mapping and get no dedicated AC; the cancel, deny and allow paths are pinned.
- Command output inserted by shell expansion is still subject to `$ARGUMENTS` / `$1`..`$9` substitution in `buildCommandMessage`; a command whose output contains those tokens is not protected.
- The ACP backend does not implement `runCommand`; a command with shell lines cannot run over ACP.
- The design doc `docs/superpowers/specs/2026-10-24-nax-interactive-tui-slice1-design.md` §4.4/§4.5 update to this architecture is committed by hand with the spec, not by a story.
- Updating `.nax/mono/packages/nax/context.md` and `.nax/mono/packages/nax-agent/context.md` to describe `src/resources/`, `runCommand` and `toolProviders`, then running `nax generate`, is a manual step after merge; `.nax/` is read-only to the run.
- No release and no version bump.

## Stories

Paths below are repo-relative. Fifteen stories, one capability: nax loads Claude Code
and nax plugin resources and delivers skills and commands (the user ruled one feature on
2026-10-25; the count grew from 13 to 15 by spec-review AC-cap splits). US-001 and
US-002 are the nax-agent seams; US-003 to US-010 build the catalog, the builders and the
skills provider; US-011 is the `nax run` opt-in; US-012 to US-015 wire chat.

### US-001 — nax-agent: tool providers on the native session

Workdir: packages/nax-agent. No dependencies.

- Add `toolProviders` to `NativeBackendOptions` and its schema; resolve them in `openNative`; extend `buildSessionToolSupport` with `providerTools` (union into `declared`, forward tools, map, instructions and grants); pass `support.providerInstructions` to `adapter.openSession` (Design §Approach 1).

### US-002 — nax-agent: `AgentSession.runCommand`

Workdir: packages/nax-agent. No dependencies.

- Add `CommandRunResult`, the optional `AgentSession.runCommand` and `OpenedBackend.runCommand`; create `src/session/agent-session-command.ts` with the claim path; implement the native half in `openNative` (Design §Approach 2). Export `CommandRunResult` from `src/index.ts`; regenerate the API snapshot.

### US-003 — Resources config, paths, types and the frontmatter reader

Workdir: packages/nax. No dependencies.

- Create `src/config/schemas-resources.ts`, register `resources` in `NaxConfigSchema` and `NaxConfig`; create `src/resources/` with `types.ts`, `claude-paths.ts`, `frontmatter.ts` and the barrel `index.ts` (Design §Approach 3, 4, 5, 6 types).

### US-004 — The skill and command parsers and their scanners

Workdir: packages/nax. Depends on US-003.

- Create `src/resources/parse-skill.ts`, `parse-command.ts` and `scan-dirs.ts` with `scanSkillsDir` and `scanCommandsDir` (Design §Approach 6).

### US-005 — The agent, MCP and hooks parsers

Workdir: packages/nax. Depends on US-004.

- Create `src/resources/parse-agent.ts`, `parse-mcp.ts`, `parse-hooks.ts`, and add `scanAgentsDir` to `scan-dirs.ts` (Design §Approach 6).

### US-006 — Claude Code sources

Workdir: packages/nax. Depends on US-005.

- Create `src/resources/claude-sources.ts` with `discoverClaudeCodePackages` (Design §Approach 7).

### US-007 — The resource catalog

Workdir: packages/nax. Depends on US-006.

- Create `src/resources/catalog.ts` with `buildResourceCatalog` and `loadResourceCatalog` (Design §Approach 8).

### US-008 — The nax plugin `resources` extension

Workdir: packages/nax. Depends on US-007.

- Add `"resources"` to `PluginType` and `VALID_PLUGIN_TYPES`, `IResourceProvider` to `src/plugins/extensions.ts`, the `validatePlugin` case, `PluginRegistry.getResourceDirs()`, the `config` source's `resolvedModule` path in `src/plugins/loader.ts`, and `src/resources/nax-plugin-packages.ts`, exported from `src/resources/index.ts` (Design §Approach 9).

### US-009 — The skills and command prompt builders

Workdir: packages/nax. Depends on US-003.

- Create `src/prompts/builders/skills-builder.ts` with `buildSkillsInstructions`, `buildSkillInvocationMessage` and `buildCommandMessage`, exported from `src/prompts/index.ts` (Design §Approach 10).

### US-010 — The skills provider

Workdir: packages/nax. Depends on US-007, US-009.

- Create `src/resources/skills-provider.ts` with `createSkillsProvider`, exported from `src/resources/index.ts` (Design §Approach 11).

### US-011 — The skills provider in `nax run`, behind `resources.skillsInRun`

Workdir: packages/nax. Depends on US-010.

- In `createRuntime`, append the skills provider to `toolProviders` when `resources.skillsInRun` is true (Design §Approach 12).

### US-012 — Chat: trust gate, plugins, catalog and providers

Workdir: packages/nax. Depends on US-001, US-008, US-010.

- `chatCommand` checks trust before composing; `composeChat` loads plugins and the catalog and passes `resources` to `createChatHost` (`ChatResources` exported from `src/chat/index.ts`); `openChatSession` forwards `toolProviders`; the host opens sessions with plugin handlers before rule handlers and tears plugins down on close (Design §Approach 13).

### US-013 — Chat: skill and command slash commands

Workdir: packages/nax. Depends on US-012.

- `runSlashCommand` returns a `SlashOutcome` (`{ kind: "send"; message }` for skills and `/feature`, `{ kind: "command"; name; template; rest }` for catalog commands, `undefined` for local commands); it resolves catalog commands and skills after the built-ins; `ChatApp` sends a command outcome as `buildCommandMessage(template, rest)`; `/help` lists catalog entries (Design §Approach 14, 15).

### US-014 — Chat: command shell lines through `runCommand`

Workdir: packages/nax. Depends on US-002, US-013.

- Add `ChatHost.runCommand` and `routeAskEvent`; create `src/resources/command-shell.ts` with `runCommandShellLines` (exported from `src/resources/index.ts`); `ChatApp`'s `sendTurn` gains `prepare`, which expands a command outcome's shell lines inside the sending window (Design §Approach 15).

### US-015 — Chat: `/skills`, `/plugins` and the hooks notice

Workdir: packages/nax. Depends on US-012.

- Create `src/resources/listing.ts` (exported from `src/resources/index.ts`); add the `/skills` and `/plugins` built-ins and `resourceNotice()` (Design §Approach 16).

### Context Files

**US-001**
- `packages/nax-agent/src/session/native-backend.ts`
- `packages/nax-agent/src/session/native-backend-options.ts`
- `packages/nax-agent/src/session/session-tool-support.ts`
- `packages/nax-agent/src/coding-tools/coding-tool-support.ts`
- `packages/nax/src/agents/coding-tool-support-resolve.ts`

**US-002**
- `packages/nax-agent/src/session/agent-session.ts`
- `packages/nax-agent/src/session/agent-session-turn.ts`
- `packages/nax-agent/src/session/session-ask-port.ts`
- `packages/nax-agent/src/session/session-interaction.ts`
- `packages/nax-agent/src/session/session-backend.ts`

**US-003**
- `packages/nax/src/config/schemas.ts`
- `packages/nax/src/config/runtime-types.ts`
- `packages/nax/src/config/schemas-mcp.ts`
- `packages/nax/test/unit/config/defaults.test.ts`

**US-004**
- `packages/nax/src/resources/types.ts` — created by US-003
- `packages/nax/src/resources/frontmatter.ts` — created by US-003

**US-005**
- `packages/nax/src/resources/types.ts` — created by US-003
- `packages/nax/src/resources/frontmatter.ts` — created by US-003
- `packages/nax/src/resources/scan-dirs.ts` — created by US-004

**US-006**
- `packages/nax/src/resources/scan-dirs.ts` — created by US-004
- `packages/nax/src/resources/parse-mcp.ts` — created by US-005
- `packages/nax/src/resources/parse-hooks.ts` — created by US-005
- `packages/nax/src/resources/claude-paths.ts` — created by US-003

**US-007**
- `packages/nax/src/resources/claude-sources.ts` — created by US-006
- `packages/nax/src/resources/claude-paths.ts` — created by US-003

**US-008**
- `packages/nax/src/plugins/types.ts`
- `packages/nax/src/plugins/extensions.ts`
- `packages/nax/src/plugins/validator.ts`
- `packages/nax/src/plugins/registry.ts`
- `packages/nax/src/plugins/loader.ts`

**US-009**
- `packages/nax/src/prompts/builders/forge-read-builder.ts`
- `packages/nax/src/prompts/index.ts`
- `packages/nax/src/resources/types.ts` — created by US-003

**US-010**
- `packages/nax/src/forge-tools/provider.ts`
- `packages/nax/src/resources/catalog.ts` — created by US-007
- `packages/nax/src/prompts/builders/skills-builder.ts` — created by US-009

**US-011**
- `packages/nax/src/runtime/index.ts`
- `packages/nax/src/operations/call-run-options.ts`
- `packages/nax/src/agents/coding-tool-support-resolve.ts`

**US-012**
- `packages/nax/src/cli/chat.ts`
- `packages/nax/src/chat/chat-host.ts`
- `packages/nax/src/chat/open-chat-session.ts`
- `packages/nax/src/cli/trust-gate.ts`
- `packages/nax/src/execution/lifecycle/run-setup-init.ts`

**US-013**
- `packages/nax/src/tui/chat/slash-commands.ts`
- `packages/nax/test/ui/chat/slash-commands.test.tsx`

**US-014**
- `packages/nax/src/chat/turn-runner.ts`
- `packages/nax/src/tui/chat/ChatApp.tsx`
- `packages/nax/src/tui/chat/useChatKeys.ts`
- `packages/nax/test/ui/chat/chat-asks-keys.test.tsx`

**US-015**
- `packages/nax/src/tui/chat/slash-commands.ts`
- `packages/nax/src/tui/chat/ChatApp.tsx`

### Creates

**US-001**
- `packages/nax-agent/test/unit/session/native-backend-providers.test.ts`

**US-002**
- `packages/nax-agent/src/session/agent-session-command.ts`
- `packages/nax-agent/test/unit/session/agent-session-run-command.test.ts`

**US-003**
- `packages/nax/src/config/schemas-resources.ts`
- `packages/nax/src/resources/index.ts`
- `packages/nax/src/resources/types.ts`
- `packages/nax/src/resources/claude-paths.ts`
- `packages/nax/src/resources/frontmatter.ts`
- `packages/nax/test/unit/config/schemas-resources.test.ts`
- `packages/nax/test/unit/resources/frontmatter.test.ts`

**US-004**
- `packages/nax/src/resources/parse-skill.ts`
- `packages/nax/src/resources/parse-command.ts`
- `packages/nax/src/resources/scan-dirs.ts`
- `packages/nax/test/unit/resources/parse-skill.test.ts`
- `packages/nax/test/unit/resources/scan-dirs.test.ts`

**US-005**
- `packages/nax/src/resources/parse-agent.ts`
- `packages/nax/src/resources/parse-mcp.ts`
- `packages/nax/src/resources/parse-hooks.ts`
- `packages/nax/test/unit/resources/parse-agent-mcp-hooks.test.ts`

**US-006**
- `packages/nax/src/resources/claude-sources.ts`
- `packages/nax/test/unit/resources/claude-sources.test.ts`

**US-007**
- `packages/nax/src/resources/catalog.ts`
- `packages/nax/test/unit/resources/catalog.test.ts`

**US-008**
- `packages/nax/src/resources/nax-plugin-packages.ts`
- `packages/nax/test/unit/plugins/registry-resources.test.ts`

**US-009**
- `packages/nax/src/prompts/builders/skills-builder.ts`
- `packages/nax/test/unit/prompts/builders/skills-builder.test.ts`

**US-010**
- `packages/nax/src/resources/skills-provider.ts`
- `packages/nax/test/unit/resources/skills-provider.test.ts`

**US-011**
- `packages/nax/test/unit/runtime/runtime-skills-provider.test.ts`

**US-012**
- `packages/nax/test/unit/cli/chat-resources.test.ts`
- `packages/nax/test/unit/chat/chat-host-resources.test.ts`

**US-013**
- `packages/nax/test/ui/chat/slash-resources.test.tsx`

**US-014**
- `packages/nax/src/resources/command-shell.ts`
- `packages/nax/test/unit/resources/command-shell.test.ts`
- `packages/nax/test/unit/chat/chat-host-run-command.test.ts`
- `packages/nax/test/ui/chat/chat-shell-lines.test.tsx`

**US-015**
- `packages/nax/src/resources/listing.ts`
- `packages/nax/test/unit/resources/listing.test.ts`

### Modifies

**US-001**
None. `toolProviders` is a new optional field; with it absent `openNative` builds exactly today's tools and grants, so every existing `native-backend.test.ts` and `session-tool-support.test.ts` assertion stays true. The API snapshot lists names only and `NativeBackendOptions` is already on it.

**US-002**
- `packages/nax-agent/api/nax-agent.api.txt` — regenerated with bun run api:update so it gains type CommandRunResult; every existing line is kept.

**US-003**
- `packages/nax/test/unit/config/defaults.test.ts` — its hand-written NAX_CONFIG_KEYS list (the case "every DEFAULT_CONFIG key is in NAX_CONFIG_KEYS") gains "resources"; the invariant is that every DEFAULT_CONFIG key is still listed and every listed key still exists.

**US-004**
None. New files only.

**US-005**
None. New files plus one added export in `src/resources/scan-dirs.ts` (created by US-004).

**US-006**
None. New files only.

**US-007**
None. New files plus barrel exports in `src/resources/index.ts` (created by US-003).

**US-008**
None. `test/unit/plugins/validator.test.ts` asserts no closed list of plugin types; every existing valid and invalid case stays true when "resources" joins VALID_PLUGIN_TYPES.

**US-009**
None. A new builder file and one export added to `src/prompts/index.ts`; no test pins that barrel's export list.

**US-010**
None. New files only.

**US-011**
None. With `resources.skillsInRun` unset or false, `runtime.toolProviders` is exactly today's MCP providers, so every existing runtime assertion stays true.

**US-012**
- `packages/nax/test/unit/cli/chat.test.ts` — its _chatCommandDeps fakes gain ensureTrusted (resolving), loadPlugins (an empty registry) and loadResourceCatalog (an empty catalog) so the existing compose cases still reach createChatHost; the invariant is that every existing case keeps its asserted behaviour.

**US-013**
- `packages/nax/test/ui/chat/slash-commands.test.tsx` — cases that read runSlashCommand's return for /feature (a builder-made string today) now read the message of a { kind: "send" } outcome, and local commands still return undefined; the invariant is that every existing command keeps its behaviour and the built-in help list is unchanged for a host with no catalog.

**US-014**
- `packages/nax/test/unit/chat/turn-runner.test.ts` — no assertion changes; listed because runChatTurn now routes ask events through the extracted routeAskEvent, and every existing case (asks reach asks.handle, usage reaches the ledger) must stay true.

**US-015**
- `packages/nax/test/ui/chat/slash-commands.test.tsx` — a case asserting the exact help built-in list, if present, gains /skills and /plugins; the invariant is that every earlier built-in is still listed in order.

### Seams

- US-001 -> US-012: `toolProviders`; US-012 asserts, through `createChatHost({ ..., resources })` built WITHOUT an `open` override and `start(...)`, with `_openChatSessionDeps.nativeBackend`, `createAgentSession`, `createFileTranscriptStore` and `resolveRuleSet` stubbed and a fake storage, that the captured `nativeBackend` options carry `toolProviders` equal to `resources.toolProviders`.
- US-002 -> US-014: `session.runCommand`; US-014 asserts, through `host.runCommand("git status", onEvent)` over a fake session whose `runCommand` is a spy, that the spy is called once with `"git status"`.
- US-003/US-004/US-005 -> US-006: the parsers and scanners; US-006 asserts, through `discoverClaudeCodePackages` over a fixture tree, the parsed resources' names.
- US-006 -> US-007: `discoverClaudeCodePackages`; US-007 asserts, through `loadResourceCatalog` with `CLAUDE_CONFIG_DIR` at a fixture, that a fixture user skill is found.
- US-007 -> US-010: the catalog; US-010 asserts `nax-skills__load`'s `run` returns a fixture skill's body.
- US-008 -> US-012: `getResourceDirs()` and `naxPluginPackages`; US-012 asserts, through `chatCommand` with a fake `loadPlugins` returning a registry whose `getResourceDirs()` names a fixture skills directory, the real `loadResourceCatalog`, and `CLAUDE_CONFIG_DIR` pointed at an empty fixture, that `createChatHost` receives a catalog containing that skill with origin `nax-plugin`.
- US-009 -> US-010: `buildSkillsInstructions`; US-010 asserts `instructions()` contains `nax-skills__load`.
- US-009 -> US-013: `buildSkillInvocationMessage` / `buildCommandMessage`; US-013 asserts typing `/brainstorming idea` in `ChatApp` sends a message containing the fixture skill body and `idea`.
- US-010 -> US-011: `createSkillsProvider`; US-011 asserts, through `buildRunDispatchOptions(ctx, params)` with a `CallContext` whose `runtime` came from `createRuntime` with `resources.skillsInRun: true`, that the returned `providers` contain one with id `nax-skills`.
- US-012 -> US-013, US-015: `host.catalog`; US-013 and US-015 drive `ChatApp` with a host whose catalog is a fixture.
- US-013 -> US-014: the slash command's message; US-014 asserts, through `ChatApp` typing `/status-cmd` for a fixture command whose template is `` Status: !`git status` ``, that `host.runCommand` is called with `git status` and `host.send` receives `Status: <fake output>`.

## Acceptance Criteria

### US-001 — nax-agent: tool providers on the native session

- [unit] Opening a session through `nativeBackend({ model, toolProviders: [provider] })`, where `provider` is static with id `skills` and one tool with `localName` `load`, yields turn options whose `codingTools` contain exactly one tool named `skills__load`.
- [unit] With the same provider, the session's resolved permissions passed to the adapter's `openSession` include a grant for `skills__load`.
- [unit] With the same provider, a `coding-tool` interaction for `skills__load` through the session's interaction handler runs the provider tool's `run` with the call's input.
- [unit] With a provider whose `instructions()` returns `use skills`, the `providerInstructions` option passed to the adapter's `openSession` contains `use skills`.
- [unit] Opening with `toolProviders` absent yields the same `codingTools` names as an open without the option for the same profile.
- [unit] Opening with profile `none` and a static provider yields no `skills__load` in `codingTools`.
- [unit] Opening with two providers where the first's `tools()` rejects yields `codingTools` containing the second provider's tool.
- [unit] A provider with `stages: ["run"]` contributes no tool to a session.
- [unit] A provider with `stages: ["session"]` contributes its tool to a session.
- [unit] `nativeBackend({ model, toolProviders: [{ ...provider, kind: "discovered" }] })` throws `AgentSessionError` with code `AGENT_SESSION_INVALID_OPTIONS` and context `path` `backend.toolProviders`.
- [unit] `nativeBackend({ model, toolProviders: [{ id: "x" }] })` throws `AgentSessionError` with code `AGENT_SESSION_INVALID_OPTIONS`.
- [unit] Opening with an embedder tool named `skills__load` and the provider above refuses with `AgentSessionError` code `AGENT_SESSION_TOOL_NAME_RESERVED`.

### US-002 — nax-agent: `AgentSession.runCommand`

- [unit] A session from `createAgentSession` over `nativeBackend` has `runCommand` as a function.
- [unit] On a native session with profile `full`, `runCommand("echo hi", onEvent)` resolves with `isError` false.
- [unit] That result's `content` contains `hi`.
- [unit] During that call `onEvent` receives a `tool_call` event with `name` `Bash` and `input` `{ command: "echo hi" }`.
- [unit] During that call `onEvent` receives a `tool_result` event whose `callId` equals the `tool_call` event's.
- [unit] `onEvent` receives no `turn_start`, `usage` or `turn_end` event during `runCommand`.
- [unit] On a native session whose guard asks for the command, `onEvent` receives an `approval_requested` event during `runCommand`.
- [unit] Answering that ask with `session.answer(requestId, { decision: "allow" })` makes `runCommand` resolve with `isError` false.
- [unit] Answering that ask with `{ decision: "deny" }` makes `runCommand` resolve with `isError` true and not reject.
- [unit] Calling `runCommand` while a `send()` turn is running rejects with `AgentSessionError` code `AGENT_SESSION_BUSY`.
- [unit] Calling `send()` while a `runCommand` waits on an unanswered ask throws `AgentSessionError` code `AGENT_SESSION_BUSY`.
- [unit] On a session whose backend's `OpenedBackend` has no `runCommand`, `runCommand("ls", onEvent)` rejects with `AgentSessionError` code `AGENT_SESSION_CAPABILITY_UNSUPPORTED`.
- [unit] After `session.close()`, `runCommand("ls", onEvent)` rejects with `AgentSessionError` code `AGENT_SESSION_CLOSED`.
- [unit] After a `runCommand` resolves, the transcript store's `load` for the session returns the same number of messages as before the call.
- [unit] `session.cancel()` while a `runCommand` waits on an unanswered ask makes it resolve with `isError` true.
- [unit] `session.close()` while a `runCommand` waits on an unanswered ask resolves only after `runCommand` has settled.
- [unit] After a `runCommand` resolves, a following `send("hi")` is accepted (the slot is released).
- [unit] `runCommand("echo $SECRET_TOKEN=abc123...")` with a value matching a redaction pattern emits a `tool_call` event whose `input.command` is redacted the way a model Bash call's is.

### US-003 — Resources config, paths, types and the frontmatter reader

- [unit] `NaxConfigSchema.parse({}).resources` equals `{ claudeCode: true, skillsInRun: false }`.
- [unit] `NaxConfigSchema.safeParse({ resources: { skillsInRun: "yes" } })` fails.
- [unit] `NaxConfigSchema.parse({ resources: { skillsInRun: true } }).resources.claudeCode` is `true`.
- [unit] `claudeConfigDir({ CLAUDE_CONFIG_DIR: "/x/claude" })` returns `/x/claude`.
- [unit] `claudeConfigDir({})` with `_claudePathsDeps.homedir` returning `/home/u` returns `/home/u/.claude`.
- [unit] `readResourceFrontmatter("---\nname: a\ndescription: b\n---\nBody")` returns data `name` `a`.
- [unit] The same call returns data `description` `b`.
- [unit] The same call returns body `Body`.
- [unit] `readResourceFrontmatter("no frontmatter")` returns empty data and body `no frontmatter`.
- [unit] `readResourceFrontmatter` on a block whose line is `description: Use when X. Triggers: "a", "b"` (rejected by strict YAML) returns data `description` `Use when X. Triggers: "a", "b"`.
- [unit] `readResourceFrontmatter` with the fallback reading `disable-model-invocation: true` returns data `disable-model-invocation` as the boolean `true`.
- [unit] `readResourceFrontmatter` with the fallback reading `name: "quoted"` returns data `name` `quoted`.
- [unit] `readResourceFrontmatter("---\nname: a\n")` (no closing line) returns an `error`.
- [unit] `readResourceFrontmatter("---\n---\nBody")` returns empty data and body `Body`.
- [unit] `readResourceFrontmatter("---\n- a\n- b\n---\nBody")` (a YAML list) returns an `error`.

### US-004 — The skill and command parsers and their scanners

- [unit] `parseSkillFile` on `---\nname: brainstorming\ndescription: Explore intent\n---\n# Body` returns a resource matching `{ name: "brainstorming", description: "Explore intent", body: "# Body", modelInvocable: true }`.
- [unit] `parseSkillFile` on frontmatter `description: d` with no `name`, at path `<dir>/my-skill/SKILL.md`, returns a resource matching `{ name: "my-skill", baseDir: "<dir>/my-skill" }`.
- [unit] `parseSkillFile` with `disable-model-invocation: true` returns `modelInvocable` false.
- [unit] `parseSkillFile` with no `description`, and with `name: "bad name!"`, each returns exactly `{ diagnostic }` with severity `error` and the file's path (one table-driven case).
- [unit] `parseSkillFile` on a skill whose description contains `Triggers: "a"` unquoted returns a resource (not a diagnostic).
- [unit] `parseSkillFile` returns `qualifiedName` `superpowers:brainstorming` for origin `{ kind: "claude-plugin", plugin: "superpowers", marketplace: "m" }` and `brainstorming` for origin `{ kind: "claude-user" }` (one table-driven case).
- [unit] `parseCommandFile` on `<dir>/commit.md` with frontmatter `description: Create a git commit` and `argument-hint: [msg]` returns a resource matching `{ name: "commit", description: "Create a git commit", argumentHint: "[msg]" }`.
- [unit] `parseCommandFile` on a file with no frontmatter returns `template` equal to the whole text.
- [unit] `scanSkillsDir(dir)` over a fixture with `a/SKILL.md`, `b/SKILL.md` and `.hidden/SKILL.md` returns skills `a` and `b` only.
- [unit] `scanSkillsDir` on a directory that does not exist returns no resources and no diagnostics.
- [unit] `scanSkillsDir` over a fixture with 501 skill directories returns the first 500 by name plus one `warn` diagnostic.
- [unit] `scanSkillsDir` with `_resourceFsDeps` failing the read of `b/SKILL.md` returns skill `a` and one `error` diagnostic naming `b/SKILL.md`.
- [unit] `scanCommandsDir(dir)` over a fixture with `x.md`, `y.txt` and `sub/z.md` returns command `x` only.
- [unit] `scanCommandsDir` over a fixture with 501 command files returns the first 500 by name plus one `warn` diagnostic.

### US-005 — The agent, MCP and hooks parsers

- [unit] `parseAgentFile` on frontmatter `name: code-reviewer`, `description: Reviews`, `model: sonnet` returns `name` `code-reviewer` and `model` `sonnet`.
- [unit] `parseAgentFile` with `tools: Read, Grep` returns `tools` `["Read", "Grep"]`.
- [unit] `parseAgentFile` with `tools` given as a YAML list `[Read, Grep]` returns `tools` `["Read", "Grep"]`.
- [unit] `parseAgentFile` with no `description` returns an `error` diagnostic and no resource.
- [unit] `parseMcpJson` on `{"mcpServers":{"ctx":{"command":"npx","args":["x"]}}}` returns one resource with `name` `ctx` and `transport` `stdio`.
- [unit] `parseMcpJson` on an entry `{"type":"http","url":"https://h"}` returns `transport` `http`.
- [unit] `parseMcpJson` on an entry `{"url":"https://h"}` with no `type` and no `command` returns a `warn` diagnostic and no resource for it.
- [unit] `parseMcpJson` on text that is not JSON returns one `error` diagnostic and no resources.
- [unit] `parseHooksJson` on `{"hooks":{"PreToolUse":[],"Stop":[]}}` returns one `HookResource` with `events` `["PreToolUse", "Stop"]`.
- [unit] `hooksFromSettings` on a settings object with no `hooks` key returns no resource.
- [unit] `scanAgentsDir(dir)` over a fixture with `a.md` and `b.md` returns agents `a` and `b`.
- [unit] `scanAgentsDir` over a fixture with 501 agent files returns the first 500 by name plus one `warn` diagnostic.

### US-006 — Claude Code sources

- [unit] `discoverClaudeCodePackages` over a fixture repo with `.claude/skills/p/SKILL.md` returns a first package with id `claude-project` containing skill `p`.
- [unit] Over a fixture `claudeDir` with `skills/u/SKILL.md`, the `claude-user` package contains skill `u`.
- [unit] Over a fixture `claudeDir` with `commands/c.md`, the `claude-user` package contains command `c`.
- [unit] A fixture repo `.mcp.json` with one server makes the `claude-project` package contain one `mcpServers` entry.
- [unit] A `claudeDir/settings.json` `hooks` key with `Stop` makes the `claude-user` package contain a hook resource with event `Stop`.
- [unit] With `claudeDir/settings.json` `enabledPlugins` `{"sp@m": true}` and an `installed_plugins.json` version 2 mapping `sp@m` to a `scope: "user"` record whose `installPath` holds `.claude-plugin/plugin.json` `{"name":"superpowers"}` and `skills/brainstorming/SKILL.md`, the result contains a package with id `sp@m` whose skill has `qualifiedName` `superpowers:brainstorming`.
- [unit] An enabled plugin `commit-commands@m` whose install path has no `.claude-plugin/plugin.json` yields commands qualified `commit-commands:<name>`.
- [unit] A project `.claude/settings.json` `enabledPlugins` `{"sp@m": false}` over a user `true` removes the `sp@m` package.
- [unit] A project `.claude/settings.json` enabling `pp@m` adds that package after the user-enabled ones.
- [unit] An install record with `scope: "project"` and `projectPath` equal to `repoRoot` is used when no `scope: "user"` record exists.
- [unit] An install record with `scope: "project"` and a different `projectPath` is not used.
- [unit] An enabled key with no record in `installed_plugins.json` yields a `warn` diagnostic containing `is enabled but not installed` and no package for it.
- [unit] `installed_plugins.json` with `version: 1` yields no plugin packages and one `error` diagnostic.
- [unit] `installed_plugins.json` that is not JSON yields no plugin packages and one `error` diagnostic.
- [unit] An `installPath` that does not exist yields a `warn` diagnostic and no package for it.
- [unit] A `claudeDir/settings.json` that is not JSON yields an `error` diagnostic, no plugin packages and no hook resources from it, while the `claude-user` package still contains its skills.
- [unit] A missing `installed_plugins.json` with one enabled plugin yields one `warn` diagnostic and no plugin packages.

### US-007 — The resource catalog

- [unit] `buildResourceCatalog([project, user])` with no shared names exposes every skill of both through `catalog.skills`, project first.
- [unit] With a user skill `x` and a plugin `p` skill `x`, `catalog.findSkill("x")` returns the user skill.
- [unit] In the same catalog, `catalog.findSkill("p:x")` returns the plugin skill.
- [unit] In the same catalog, `catalog.diagnostics` contains a `warn` whose message contains `is shadowed by` and `p:x`.
- [unit] With two Claude Code plugin packages in order `a`, `b` both defining skill `s`, `findSkill("s")` returns `a`'s.
- [unit] A project command `c` wins `findCommand("c")` over a plugin command `c`.
- [unit] That plugin command stays reachable as `findCommand("<plugin>:c")`.
- [unit] `findSkill("missing")` returns `undefined`.
- [unit] `catalog.diagnostics` contains every package diagnostic.
- [unit] `loadResourceCatalog({ repoRoot, config, env: { CLAUDE_CONFIG_DIR: fixture }, naxPluginPackages: [] })` with `resources.claudeCode: true` finds the fixture's user skill.
- [unit] The same call with `resources.claudeCode: false` returns a catalog with no skills.
- [unit] The same call with a config that has no `resources` key finds the fixture's user skill.
- [unit] `loadResourceCatalog` with one nax plugin package containing skill `n` returns a catalog where `findSkill("n")` has origin `nax-plugin`.
- [unit] In that catalog, the nax plugin package comes after every Claude Code package in `catalog.packages`.

### US-008 — The nax plugin `resources` extension

- [unit] `validatePlugin` accepts a plugin with `provides: ["resources"]` and `extensions.resources: { skills: "skills" }`.
- [unit] `validatePlugin` refuses a plugin with `provides: ["resources"]` and no `resources` extension.
- [unit] `validatePlugin` refuses `extensions.resources: { skills: "/abs/skills" }`.
- [unit] `validatePlugin` refuses `extensions.resources: { commands: "../outside" }`.
- [unit] `validatePlugin` refuses `extensions.resources: { agents: "" }`.
- [unit] `PluginRegistry.getResourceDirs()` for a plugin `kit` loaded from `/p/kit/index.ts` with `resources: { skills: "skills", commands: "cmds" }` returns `[{ plugin: "kit", skills: "/p/kit/skills", commands: "/p/kit/cmds" }]`.
- [unit] `getResourceDirs()` returns `[]` when no plugin provides `"resources"`.
- [unit] `getResourceDirs()` skips a plugin whose source type is `builtin`.
- [unit] Through `loadPlugins` with `configPlugins` `[{ module: "./plugins/kit.ts" }]`, project root `/p` and a fixture module providing `resources: { skills: "skills" }`, `getResourceDirs()` returns `skills` `/p/plugins/skills`.
- [unit] `getResourceDirs()` skips a config plugin whose recorded source path is an npm package name.
- [unit] `naxPluginPackages([{ plugin: "kit", skills: fixtureSkills }])` returns one package with id `nax:kit` and origin `{ kind: "nax-plugin", plugin: "kit" }`.
- [unit] In that package, skill `s` has `qualifiedName` `kit:s`.
- [unit] `naxPluginPackages` for a plugin whose `skills` directory does not exist returns a package with no skills and no diagnostics.

### US-009 — The skills and command prompt builders

- [unit] `buildSkillsInstructions` imported from `src/prompts` is a function.
- [unit] `buildSkillsInstructions([{ qualifiedName: "sp:b", description: "d" }])` contains `nax-skills__load`.
- [unit] The same call contains the line `- sp:b: d`.
- [unit] `buildSkillsInstructions` with 151 entries returns 150 skill lines and a final line `- ... and 1 more`.
- [unit] `buildSkillsInstructions` cuts a 300-character description to 200 characters.
- [unit] `buildSkillsInstructions` with description `a\nb\t\tc\u0007` renders `- <name>: a b c`.
- [unit] `buildSkillInvocationMessage({ skill, args: "idea" })` contains `<skill name="<qualifiedName>"`.
- [unit] The same message contains `References are relative to <baseDir>`.
- [unit] The same message contains the skill body.
- [unit] In the same message, `idea` comes after `</skill>`.
- [unit] `buildSkillInvocationMessage({ skill, args: "" })` ends with `</skill>`.
- [unit] `buildCommandMessage("Fix $ARGUMENTS now", "  the bug ")` returns `Fix the bug now`.
- [unit] `buildCommandMessage("$1 then $2", "a b c")` returns `a then b`.
- [unit] `buildCommandMessage("$1-$3", "a")` returns `a-`.
- [unit] `buildCommandMessage("Review", "this file")` returns `Review\n\nARGUMENTS: this file`.
- [unit] `buildCommandMessage("Review", "")` returns `Review`.

### US-010 — The skills provider

- [unit] `createSkillsProvider(load)` returns a provider matching `{ id: "nax-skills", kind: "static", stages: ["*"] }`.
- [unit] Its `tools()` over a catalog with one model-invocable skill returns one tool with `localName` `load` whose input schema requires `name`.
- [unit] Its `tools()` over an empty catalog returns `[]`.
- [unit] Over a catalog with only `modelInvocable: false` skills, `tools()` returns the `load` tool and `instructions()` returns `undefined`.
- [unit] Running `load` with `{ name, file: "references/a.md" }` for a `modelInvocable: false` fixture skill returns that file's text.
- [unit] `load` is called once across two `tools()` calls and one `instructions()` call.
- [unit] Running `load` with `{ name: "brainstorming" }` returns content equal to `Base directory for this skill: <baseDir>`, a blank line, then the skill body.
- [unit] Running `load` with `{ name: "superpowers:brainstorming" }` returns that skill.
- [unit] Running `load` with `{ name: "nope" }` returns an error result whose content starts `unknown skill nope; available:`.
- [unit] Running `load` with no `file` for a skill with `modelInvocable: false` returns `{ isError: true, content: "skill <name> can only be invoked by the user" }`.
- [unit] Running `load` with `{ name, file: "references/a.md" }` for a fixture skill returns that file's text.
- [unit] Running `load` with each of `file` = `../other/SKILL.md`, an absolute path, a path containing a NUL byte, and a symlink inside the base directory pointing outside it returns an error result whose content contains `is outside skill` (one table-driven case).
- [unit] Running `load` with `file: "missing.md"` returns `{ isError: true, content: "skill <name> has no file missing.md" }`.
- [unit] Running `load` with `file: "references"` (a directory) returns an error result whose content contains `is not a regular file`.
- [unit] Running `load` with a `file` of 262145 bytes returns an error result whose content contains `exceeds 262144 bytes`.
- [unit] `instructions()` returns text containing `nax-skills__load` and the line `- superpowers:brainstorming: <description>`.

### US-011 — The skills provider in `nax run`, behind `resources.skillsInRun`

- [unit] `createRuntime(config, workdir)` with `resources.skillsInRun: true` returns a runtime whose `toolProviders` contains a provider with id `nax-skills`.
- [unit] In that runtime, the `nax-skills` provider comes after every MCP provider.
- [unit] `createRuntime` with the default config returns `toolProviders` containing no provider with id `nax-skills`.
- [unit] `createRuntime` with a config that has no `resources` key returns `toolProviders` containing no provider with id `nax-skills`.
- [unit] `createRuntime` with `resources.skillsInRun: true` does not call `_runtimeResourceDeps.loadResourceCatalog` until the skills provider's `tools()` is first called.
- [unit] `buildRunDispatchOptions(ctx, params)` with a `CallContext` whose `runtime` came from `createRuntime` with `resources.skillsInRun: true` returns `providers` that include one with id `nax-skills`.

### US-012 — Chat: trust gate, plugins, catalog and providers

- [unit] `chatCommand` with a fake `ensureTrusted` rejecting `NaxError` code `PROJECT_UNTRUSTED` with `context.root` `/r` and `context.hint` `run: nax trust add /r` writes `Project not trusted: /r` to stderr.
- [unit] In the same case stderr also gets `run: nax trust add /r`, exit code is 2, and neither `loadPlugins` nor `createChatHost` is called.
- [unit] `chatCommand` with `ensureTrusted` rejecting `TRUST_STORE_UNREADABLE` writes the error message to stderr and sets exit code 2.
- [unit] `chatCommand` with `ensureTrusted` rejecting a plain `Error("x")` writes `x` to stderr, sets exit code 1 and does not call `loadConfig`.
- [unit] `chatCommand` calls `ensureTrusted` with the resolved `cwd` before `loadConfig`.
- [unit] `chatCommand` with stdin not a TTY never calls `ensureTrusted`.
- [unit] `chatCommand` calls `loadPlugins` with the plugins directory under `globalConfigDir()` and `<repoRoot>/.nax/plugins`.
- [unit] When `loadPlugins` rejects with `boom`, stderr gets `nax plugins unavailable: boom` and `createChatHost` is still called.
- [unit] `createChatHost` receives `resources.toolProviders` containing a provider with id `nax-skills`.
- [unit] With a fake `loadPlugins` whose registry's `getResourceDirs()` names a fixture skills directory with skill `kit-skill`, the real `loadResourceCatalog` and `CLAUDE_CONFIG_DIR` at an empty fixture, `createChatHost` receives `resources.catalog` where `findSkill("kit-skill")` has origin `nax-plugin`.
- [unit] Through `createChatHost` with `resources` whose `pluginHandlers` holds one entry and a fake opener, `start(...)` passes `loopHandlers` whose first entry is that plugin entry.
- [unit] The same `loopHandlers` also contain the rule-delivery handlers after the plugin entry.
- [unit] Through the same host, `switchTo({ mode: "full" })` passes the same `loopHandlers` array object as the first open.
- [unit] `openChatSession` with a request without `toolProviders` passes `nativeBackend` options with no `toolProviders` key.
- [unit] `host.close()` calls `resources.teardown` exactly once, after the session handle's `release`.
- [unit] A host built without `resources` has `catalog` undefined and opens sessions with only the rule-delivery handlers.

### US-013 — Chat: skill and command slash commands

- [unit] Through `ChatApp` with a host whose catalog has skill `brainstorming`, typing `/brainstorming idea` plus Enter calls `host.send` once with a message containing the skill body and `idea`.
- [unit] Typing `/superpowers:brainstorming` calls `host.send` with a message containing `<skill name="superpowers:brainstorming"`.
- [unit] For a catalog skill with `modelInvocable: false`, typing `/<name>` still calls `host.send` with its body.
- [unit] With a catalog command `review` whose template is `Review $ARGUMENTS`, typing `/review x.ts` calls `host.send` with `Review x.ts`.
- [unit] `runSlashCommand` for `/feature <name>` with a fixture spec returns `{ kind: "send" }` whose `message` is `buildChatFeatureMessage`'s text.
- [unit] With a catalog command and a catalog skill both named `deploy`, typing `/deploy` sends the command's message.
- [unit] A catalog skill named `mode` does not shadow the built-in: typing `/mode full` calls `host.switchTo({ mode: "full" })` and never `host.send`.
- [unit] Typing `/nothing` with no such catalog entry shows `unknown command /nothing` and never calls `host.send`.
- [unit] `/help` with a catalog shows `/brainstorming - <description>` and `/review - <description>` after the built-ins.

### US-014 — Chat: command shell lines through `runCommand`

- [unit] `host.runCommand("git status", onEvent)` over a fake session calls `session.runCommand` once with `"git status"` and returns its result.
- [unit] An `approval_requested` event emitted during `host.runCommand` is added to `host.asks`' pending list.
- [unit] `runChatTurn` over a fake session that emits `approval_requested` still calls `asks.handle` with that event.
- [unit] `runCommandShellLines("A !`ls` B !`pwd`", run)` calls `run` with `ls` then `pwd`, in that order.
- [unit] The same call returns text `A <ls output> B <pwd output>`.
- [unit] `runCommandShellLines` with text containing no shell line returns the text unchanged and never calls `run`.
- [unit] A `run` result whose content is `$& !`rm x`` is inserted literally and `run` is not called with `rm x`.
- [unit] When the first `run` resolves `{ isError: true, content: "denied\nmore" }`, `runCommandShellLines` does not call `run` again and returns `failed` with command `ls` and reason `denied`.
- [unit] When `run` rejects with `Error("busy")`, `runCommandShellLines` returns `failed` with reason `busy`.
- [unit] Through `ChatApp` with a catalog command `status-cmd` whose template is `` Status: !`git status` `` and a host whose `runCommand` resolves `{ isError: false, content: "clean" }`, typing `/status-cmd` calls `host.runCommand` with `git status` and then `host.send` with `Status: clean`.
- [unit] With `host.runCommand` resolving `{ isError: true, content: "denied" }`, typing `/status-cmd` never calls `host.send` and shows `command /status-cmd not sent: !`git status` failed: denied`.
- [unit] Through `ChatApp` with a catalog skill whose body contains `` !`echo x` ``, typing `/<skill>` calls `host.send` with that literal text and never calls `host.runCommand`.
- [unit] Through `ChatApp` with a catalog command `say` whose template is `Say $ARGUMENTS`, typing `` /say !`rm x` `` never calls `host.runCommand` and sends ``Say !`rm x` ``.
- [unit] With a host that has no `runCommand`, typing `/status-cmd` never calls `host.send` and shows a notice containing `this session cannot run commands`.
- [unit] While `host.runCommand` is pending with an ask in `host.asks`, the rendered ask prompt is active: pressing `a` calls `host.asks.resolve(requestId, "allow_once")`.
- [unit] While `host.runCommand` is pending, Ctrl-C calls `host.cancel()` and does not close the app.

### US-015 — Chat: `/skills`, `/plugins` and the hooks notice

- [unit] `formatSkillsListing(catalog)` lists each skill as `<qualifiedName>  <origin label>  <path>`.
- [unit] Its origin labels are `project`, `user`, `plugin superpowers` and `nax-plugin kit` for the four origins.
- [unit] `formatSkillsListing` lists each `SKILL.md` diagnostic after the skill lines.
- [unit] `formatPluginsListing(catalog, naxPlugins)` contains a `Claude Code plugins` section with the line `sp@m  skills 1, commands 0, agents 2 (not delivered yet), mcp 1 (not delivered yet), hooks 1 (not executed)` for a fixture package.
- [unit] `formatPluginsListing` contains a `nax plugins` section listing `kit  resources, loop-handlers` for a fixture plugin.
- [unit] `formatPluginsListing` with no Claude Code plugin packages shows `(none)` under `Claude Code plugins`.
- [unit] Through `ChatApp`, typing `/skills` shows `formatSkillsListing`'s text and never calls `host.send`.
- [unit] Through `ChatApp`, typing `/plugins` shows `formatPluginsListing`'s text and never calls `host.send`.
- [unit] A host whose catalog has two packages declaring hooks returns `hooks declared by 2 package(s) are not executed by nax` from its first `resourceNotice()` call.
- [unit] That host returns `undefined` from its second `resourceNotice()` call.
- [unit] Through `ChatApp` over that host, the hooks line appears once in the transcript after a `/resume`.
- [unit] `/help` lists `/skills` and `/plugins` among the built-ins.
