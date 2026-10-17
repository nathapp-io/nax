# SPEC: Codex over ACP — read-only profiles, configurable full mode, optional isolated home

## Summary

Make codex usable over ACP for every profile nax opens. Profiles `none`, `read` and `review` select codex-acp's own `read-only` mode (OS sandbox, read-only filesystem, no network, every escalation sent to nax as a permission request). For profile `full`, a new config setting `agent.acp.codex.fullMode` chooses codex's launch mode: `workspace-write` (default; codex works inside its OS sandbox with workspace writes, and any request to leave it reaches nax, which approves it under `full`) or `agent-full-access` (no sandbox and no requests at all). nax's embedder sandbox is honoured only by agents that can receive it, so it can no longer approve a codex escalation as if it were sandboxed. A second setting, `agent.acp.codex.isolateHome` (default off), runs codex on a nax-owned codex home that shares only the user's `auth.json`.

This is the codex slice of nathapp-io/nax#2372; opencode, gemini and pi stay open on that issue.

## Motivation

`acpProfileFor` (`packages/nax/src/agents/acp/profile-map.ts`) opens `read` or `review` for every op that declares no file-write tool: reviewers, re-reviewers and the advisor. `unmetRequirement` (`packages/nax-agent-acp/src/client/capabilities.ts`) refuses both profiles with `AGENT_SESSION_CAPABILITY_UNSUPPORTED` on any agent whose registry entry has no `readOnly` enforcement, and only `claude` has one. So codex can run implementer-shaped sessions only; a `codex-review` profile cannot review.

codex-acp (2.1.1, the registry pin, and 2.2.2, the latest) already has the mechanism. Its `mode` config option offers `read-only`, `workspace-write`, `agent` (its default, where codex's own reviewer approves escalations) and `agent-full-access`. The mode's sandbox and approval policy are applied on every turn. Every command, file-change and permission approval is forwarded as ACP `session/request_permission`, and a missing handler, stale turn or error is answered `cancel`. A new or loaded session starts in the mode named by the env var `INITIAL_AGENT_MODE` (an unknown value falls back to `agent`). codex does all work locally under its own sandbox; it never delegates file or terminal work to the client.

Three gaps follow:

1. **The embedder sandbox leaks approval.** `routerFor` (`packages/nax-agent-acp/src/client/backend.ts`) hands the session's sandbox policy to `decidePermission` for every agent. Under `review`, `decidePermission` allows an `execute` request once when a sandbox is present. codex never receives that policy (it is delivered only through Claude's `_meta`), so a codex request to run a command outside its own sandbox would be approved and run unsandboxed.
2. **`full` on codex today means codex's `agent` mode**, where codex's own AI approves escalations. The user wants codex configurable between `workspace-write` (commands and edits run in codex's OS sandbox by default; an escalation codex asks for is approved by nax's `full` permission layer, which has no sandbox to check it against for codex) and `agent-full-access` (no sandbox, no requests). Neither matches Claude's `full`, whose permission layer also refuses writes outside the sandbox roots; that stricter rule is deliberately not extended to codex (the "not too tight" ruling).
3. **The user's codex home leaks into nax sessions.** codex loads `~/.codex/config.toml`: session-start hooks, MCP servers and plugins. Claude's equivalent is switched off with `settingSources: []`; codex has no switch. The user wants it optional: a too-tight harness costs more than it saves.

User rulings (2026-10-17): an enable/disable option for an isolated codex home; `review` on codex accepted as codex's `read-only` mode (sandboxed commands, no temp writes, no network); `full` on codex configurable between `workspace-write` and `agent-full-access`, default `workspace-write`.

## Design

### Integration

Symbols this feature only reads:

- `acpProfileFor(mode, declaredTools)` in `packages/nax/src/agents/acp/profile-map.ts` returns `"full" | "review" | "read"`; unchanged (its header comment is updated, see US-002 Modifies).
- `decidePermission(request, ctx)` in `packages/nax-agent-acp/src/client/permissions.ts`: under `review`, a non-`execute` request is rejected; an `execute` request is rejected with `REVIEW_NO_SANDBOX_REASON` when `ctx.sandbox` is undefined, otherwise allowed once with `REVIEW_EXECUTE_REASON`. Under `review` or `full` with `ctx.sandbox` defined, a network request is decided by `decideNetwork`. Unchanged; this feature changes what `ctx.sandbox` holds.
- `claudeSessionMeta(kind, toolNames, readOnly, extras)` in `packages/nax-agent-acp/src/client/pre-approval.ts` returns `undefined` unless `kind === "claudeCode.allowedTools"`; unchanged.
- `modeFor(profile, entry)` in `capabilities.ts`: `none`/`read`/`review` → `entry.readOnly.mode`, other profiles → `entry.defaultMode`. `applyMode` in `open.ts` sets that mode through `session/set_config_option`, skips the call when the mode is undefined, and refuses with capability `profile` when the agent does not offer the value. Both unchanged.
- `toSessionModel(def: ModelDef): SessionModel` in `packages/nax/src/agents/session-model-mapping.ts` copies `def.env` into `SessionModel.env`. `backendEnv(opts.modelDef.env)` in `packages/nax/src/agents/acp/open-context.ts` passes it, through `buildAllowedEnv` (`packages/nax/src/agents/shared/env.ts`, step 5 "Model-level env overrides", every key), to the agent process.
- `globalConfigDir()` in `packages/nax/src/config/paths/index.ts` returns `~/.nax` (or the override env).

Symbols this feature changes. Each **Baseline** exists only to locate the code; it is never the interface to implement. Implement the **Target**.

- Registry entry `codex` (`packages/nax-agent-acp/src/client/registry.ts`)
  - Baseline: launch candidates and `authEnv: ["OPENAI_API_KEY"]`; `readOnly`, `defaultMode`, `preApproval` all undefined.
  - Target: same launch, auth env, `defaultMode: undefined` and `preApproval: undefined`; `readOnly: { mode: { configId: "mode", value: "read-only" }, disallowedTools: [], sessionOptions: {} }`. `entry()` takes the read-only enforcement without requiring a pre-approval channel. The `ReadOnlyEnforcement` doc comment drops "so only an agent with one may declare it" and says an agent may enforce read-only through its mode alone. Under `full` and `ask` codex keeps its launch mode (no `set_config_option` for `mode`).
- `sandboxFor` (`packages/nax-agent-acp/src/client/open.ts`)
  - Baseline: `sandboxFor(ctx: BackendOpenContext): SandboxPolicy | undefined` uses `ctx.sandbox` for profiles `review` and `full` and refuses the open when it is `unavailable`.
  - Target: `sandboxFor(ctx: BackendOpenContext, entry: AgentRegistryEntry | undefined): SandboxPolicy | undefined`. Returns `undefined`, without refusing, when `entry?.preApproval` is undefined; otherwise behaves as the baseline. The caller in the open sequence passes `o.options.entry`.
- `routerFor` (`packages/nax-agent-acp/src/client/backend.ts`)
  - Baseline: `routerFor(ctx: BackendOpenContext, secrets: readonly string[]): InboundRouter` puts `sandbox: ctx.sandbox.policy` into the permission context whenever `ctx.sandbox.kind === "policy"`.
  - Target: `routerFor(ctx: BackendOpenContext, secrets: readonly string[], entry: AgentRegistryEntry | undefined): InboundRouter`. Adds `sandbox` only when `entry?.preApproval` is defined and `ctx.sandbox.kind === "policy"`. Its caller in `connect()` passes `options.entry`. Elicitation answering shares the same base and reads no sandbox.
- `AgentAcpConfigSchema` (`packages/nax/src/config/schemas-infra.ts`)
  - Baseline: `promptRetries`, `trackedSpawnDeadlineMs`, `trackedSpawnStartupDeadlineMs`.
  - Target: adds `codex: z.object({ isolateHome: z.boolean().default(false), fullMode: z.enum(["workspace-write", "agent-full-access"]).default("workspace-write") })` with object default `{ isolateHome: false, fullMode: "workspace-write" }`. The two literal `acp` default objects (`schemas-infra.ts` `AgentAcpConfigSchema.default({...})`, `schemas.ts` defaults) gain the same `codex` object, and the `acp` runtime type in `src/config/runtime-types-agent.ts` gains `codex?: { isolateHome?: boolean; fullMode?: "workspace-write" | "agent-full-access" }`.
- `selectModel(opts)` (`packages/nax/src/session/model-selection.ts`)
  - Baseline: `selectModel(opts: ModelSelection): { modelDef: SessionModel; modelTier?: string }`; `ModelSelection` is `{ modelDef, modelTier? }`.
  - Target: `selectModel(opts: ModelSelection, codex?: CodexAcpSettings)`; `ModelSelection` gains optional `agentName?: string`. When `codex` is given, the config `ModelDef` is first passed through `withCodexAcpEnv(opts.modelDef, opts.agentName, codex)`. A one-argument call behaves exactly as today.
- `SessionManager.openSession` (`packages/nax/src/session/manager.ts`)
  - Baseline: spreads `...selectModel(opts)` into the adapter's open options; `this._config` is `NaxConfig | undefined`.
  - Target: spreads `...selectModel(opts, codexAcpSettings(opts.config ?? this._config))` on the same line. `manager.ts` is at its grandfathered size (650); the change replaces the line and adds none.
- `completeAsWithFallback(input, agentName, prompt, options)` (`packages/nax/src/agents/manager-complete-as.ts`)
  - Baseline: passes `options` to `buildCompleteCallPreamble` unchanged.
  - Target: passes `{ ...options, modelDef: withCodexAcpEnv(options.modelDef, agentName, codexAcpSettings(options.config ?? input.config)) }`, reading the same config precedence `buildCompleteCallPreamble` uses for permissions. `manager-dispatch.ts` (597 of 600 lines) is not touched.

### New module: `packages/nax/src/agents/shared/codex-acp-env.ts`

Lives under `src/agents/shared/` because `src/agents/acp/` may not import config (`check-adapter-no-config-import.sh`). Worked skeleton:

```typescript
export type CodexFullMode = "workspace-write" | "agent-full-access";
export interface CodexAcpSettings {
  readonly isolateHome: boolean;
  readonly fullMode: CodexFullMode;
}

/** Settings from config.agent.acp.codex; schema defaults when the config or any level is undefined. */
export function codexAcpSettings(config: Pick<NaxConfig, "agent"> | undefined): CodexAcpSettings;

/** <globalConfigDir()>/acp/codex-home */
export function isolatedCodexHomeDir(): string;

/**
 * mkdir the isolated home (recursive); link <isolated>/auth.json -> <source>/auth.json when the
 * source file exists and the isolated home has no auth.json entry (checked with lstat semantics, so
 * a dangling link counts as an entry). Source = env CODEX_HOME when non-empty, else <homedir>/.codex.
 * Creates nothing else (no config.toml). Returns the isolated home. Throws on a filesystem failure.
 */
export function prepareIsolatedCodexHome(): string;

/**
 * For agentName "codex": returns a NEW def whose env adds
 *   INITIAL_AGENT_MODE = settings.fullMode, unless the def's env already sets INITIAL_AGENT_MODE;
 *   CODEX_HOME = prepareIsolatedCodexHome(), only when settings.isolateHome is true and the def's
 *   env does not already set CODEX_HOME.
 * Never mutates the input. For any other agentName (or undefined) returns the input itself.
 * When prepareIsolatedCodexHome throws, logs one warn, omits CODEX_HOME, still adds INITIAL_AGENT_MODE.
 */
export function withCodexAcpEnv<T extends { env?: Record<string, string> }>(
  def: T,
  agentName: string | undefined,
  settings: CodexAcpSettings,
): T;

/** Test seam. */
export const _codexAcpEnvDeps: {
  mkdir: (path: string) => void;            // recursive
  entryExists: (path: string) => boolean;   // lstat: true for files, dirs and dangling links
  fileExists: (path: string) => boolean;    // stat: true only when the target exists
  symlink: (target: string, path: string) => void;
  env: (name: string) => string | undefined;
  homedir: () => string;
  warn: (message: string, data: Record<string, unknown>) => void;
};
```

`withCodexAcpEnv` sets `INITIAL_AGENT_MODE` for every codex session, whatever the profile; `none`, `read` and `review` still switch to `read-only` explicitly through `applyMode`, so the env never weakens them. The `auth.json` link is a symlink because codex's file credential store (codex-rs `login/src/auth/storage.rs`) saves with truncate-and-write on the existing path, which writes through the link, so a token refresh in either home is seen by both.

### Failure Handling

| Situation | Behaviour |
|:---|:---|
| codex does not offer the mode value `read-only` | Existing `applyMode` refusal: `AGENT_SESSION_CAPABILITY_UNSUPPORTED`, capability `profile`, process killed. |
| Profile `review` or `full` on codex with the embedder sandbox `unavailable` | The open proceeds; the unusable sandbox is not codex's to apply. (Claude still refuses as today.) |
| codex asks to run a command outside its sandbox under `review` | Rejected with `REVIEW_NO_SANDBOX_REASON`. |
| `isolateHome` true and the isolated home cannot be created or linked | One `warn`; no `CODEX_HOME` is set, so the session runs on the user's codex home (fail open, per the "not too tight" ruling). |
| `isolateHome` true and the user has no `auth.json` | No link is made; codex reports its own auth requirement (or authenticates from `OPENAI_API_KEY`). |
| Model env already sets `CODEX_HOME` or `INITIAL_AGENT_MODE` | The model env value is kept; nax does not override it. |

## Out of Scope

- Read-only enforcement for opencode, gemini and pi (the rest of nathapp-io/nax#2372); this spec does not close that issue.
- Applying nax's embedder sandbox to codex sessions, or refusing codex escalations outside the workspace under `full`: codex's own mode is its only boundary, every escalation it requests under `full` is approved with `FULL_REASON`, and nax's sandbox policy is never sent to it.
- Profile `ask` on codex: it keeps codex's launch mode, which is now `agent.acp.codex.fullMode`; nax sets no mode for `ask`.
- Embedder tools (the loopback MCP tool host) on codex: codex has no pre-approval channel, so a session with tools is still refused with capability `tools`.
- Commands a codex reviewer runs that need temp-file writes or the network: they fail inside codex's read-only sandbox and the review reports them as it reports any failed command (accepted 2026-10-17).
- Copying or translating any part of the user's codex config (hooks, MCP servers, plugins, skills, model providers) into the isolated home; only `auth.json` is linked.
- Credentials kept in the OS keyring (`cli_auth_credentials_store = "keyring"`): codex keys them by home path, so an isolated session does not find them.
- A future codex release that saves `auth.json` by rename instead of in place would detach the link on the next token refresh; nax does not detect or repair that.
- Turning `isolateHome` on or off moves where codex keeps its own session history, so a codex session started under the other setting cannot be resumed.
- A `complete()` call that reaches codex only as a fallback agent: the fallback resolver supplies its own model def, so that call runs with codex's defaults (user home, mode `agent`).
- Symlink support on Windows.
- Bumping the codex-acp launch pin (`~2.1.1`).
- Updating the package context file `.nax/mono/packages/nax-agent-acp/context.md` to say codex is read-only capable: a manual step after merge, since `.nax/` is read-only to the run.
- A billed live check against a real codex-acp process: a maintainer step after merge, modelled on phase C of `packages/nax-agent-acp/test/node/fixtures/live-claude-smoke.mjs`.

## Stories

### US-001: codex read-only mode; sandbox only where it is delivered

Workdir: `packages/nax-agent-acp`. No dependencies.

Give the `codex` registry entry its `readOnly` enforcement and let `entry()` accept read-only enforcement without a pre-approval channel. Add the `entry` parameter to `sandboxFor` (`open.ts`) and `routerFor` (`backend.ts`) and gate the embedder sandbox on `entry?.preApproval`, passing `o.options.entry` and `options.entry` from their callers. Update the `ReadOnlyEnforcement` comment. Add `CODEX_CONFIG_OPTIONS` to the fake-agent script and put this story's integration tests in a new `test/unit/client/backend-codex.test.ts`. Claude's behaviour does not change.

### US-002: codex full mode and optional isolated home in nax

Workdir: `packages/nax`. No dependencies.

Add `agent.acp.codex` (`isolateHome` default `false`, `fullMode` default `"workspace-write"`) to the schema, both literal defaults and the runtime type. Create `src/agents/shared/codex-acp-env.ts` with `CodexAcpSettings`, `codexAcpSettings`, `isolatedCodexHomeDir`, `prepareIsolatedCodexHome`, `withCodexAcpEnv` and `_codexAcpEnvDeps`. Wire it at the two places a model def enters an agent call: `selectModel` (called by `SessionManager.openSession`) and `completeAsWithFallback`. Update the `profile-map.ts` header comment that lists codex among agents without `read`. Document both keys in `docs/guides/configuration.md` beside `agent.acp.promptRetries`: what `fullMode` chooses (with `workspace-write`, codex runs in its OS sandbox and nax approves any escalation it requests; with `agent-full-access`, no sandbox and no requests), that `isolateHome` shares only `auth.json`, and both defaults.

### Context Files

**US-001**

- `packages/nax-agent-acp/src/client/registry.ts` — `AgentRegistryEntry`, `ReadOnlyEnforcement`, `entry()`, the Claude entry
- `packages/nax-agent-acp/src/client/capabilities.ts` — `modeFor`, `readOnlyFor`, `unmetRequirement`, `buildCapabilityRecord`
- `packages/nax-agent-acp/src/client/open.ts` — `sandboxFor`, `sessionSetup`, `applyMode`
- `packages/nax-agent-acp/src/client/permissions.ts` — `decidePermission` review and full branches, the reason constants
- `packages/nax-agent-acp/test/unit/client/backend-permissions.test.ts` — the `inMemoryAgent` + `createAgentSession` test pattern

**US-002**

- `packages/nax/src/session/model-selection.ts` — `selectModel`, `ModelSelection`
- `packages/nax/src/agents/manager-complete-as.ts` — `completeAsWithFallback`
- `packages/nax/src/config/schemas-infra.ts` — `AgentAcpConfigSchema` and its literal default
- `packages/nax/src/config/tracked-spawn-deadlines.ts` — the precedent for a config reader that accepts an undefined config
- `packages/nax/test/unit/agents/complete-as-with-fallback.test.ts` — the `completeAsWithFallback` test pattern

### Creates

**US-001**

- `packages/nax-agent-acp/test/unit/client/backend-codex.test.ts`

**US-002**

- `packages/nax/src/agents/shared/codex-acp-env.ts`
- `packages/nax/test/unit/agents/shared/codex-acp-env.test.ts`

### Modifies

**US-001**
- `packages/nax-agent-acp/src/client/registry.ts` — sets the codex entry's `readOnly`, lets `entry()` take read-only enforcement for an agent without pre-approval, and rewrites the `ReadOnlyEnforcement` comment that says only an agent with a pre-approval channel may declare it.
- `packages/nax-agent-acp/src/client/open.ts` — `sandboxFor` gains the `entry` parameter and returns `undefined` for an agent whose entry has no `preApproval`; its caller passes `o.options.entry`.
- `packages/nax-agent-acp/src/client/backend.ts` — `routerFor` gains the `entry` parameter and omits `sandbox` from the permission context for an agent whose entry has no `preApproval`; its caller in `connect()` passes `options.entry`.
- `packages/nax-agent-acp/test/unit/client/registry.test.ts` — the table test "%s: launch candidates and auth env; no read-only enforcement, no pre-approval" asserts codex has `readOnly: undefined`, so codex moves out of that table into its own test asserting the new `readOnly` (gemini, opencode and pi stay in the table); and the test "only an agent with a pre-approval channel declares read-only enforcement" fails once codex declares `readOnly` without `preApproval`, so it is replaced by a test that every entry declaring `readOnly` sets a `readOnly.mode`, the invariant this feature relies on.
- `packages/nax-agent-acp/test/unit/client/capabilities.test.ts` — the test "modeFor and readOnlyFor: default mode for every Claude profile; nothing for agents without enforcement" asserts `readOnlyFor("none", registryEntry("codex"))` is undefined; that check switches to `registryEntry("gemini")`, keeping the invariant that an agent without enforcement yields undefined.
- `packages/nax-agent-acp/test/unit/client/backend-permissions.test.ts` — the test "%s on an agent without a read-only mode: refused after initialize" opens `agent: "codex"`; it switches to `agent: "gemini"`, keeping the invariant that `read`/`none` on an agent without read-only enforcement is refused after `initialize` with capability `profile`.
- `packages/nax-agent-acp/test/fixtures/fake-agent/script.ts` — adds an exported `CODEX_CONFIG_OPTIONS` (a `mode` select with category `mode` offering `read-only`, `workspace-write`, `agent`, `agent-full-access`, current value `agent`) beside `CLAUDE_CONFIG_OPTIONS`; no existing export changes.

**US-002**
- `packages/nax/src/config/schemas-infra.ts` — adds the `codex` object to `AgentAcpConfigSchema` and to its literal `.default({...})`.
- `packages/nax/src/config/schemas.ts` — adds `codex: { isolateHome: false, fullMode: "workspace-write" }` to the literal `acp` default object.
- `packages/nax/src/config/runtime-types-agent.ts` — adds the optional `codex` block to the `acp` runtime type.
- `packages/nax/src/session/model-selection.ts` — `selectModel` gains the optional `codex` settings parameter and `ModelSelection` the optional `agentName`; a one-argument call is unchanged, so its existing tests keep passing as written.
- `packages/nax/src/session/manager.ts` — the `...selectModel(opts)` line in `openSession` becomes `...selectModel(opts, codexAcpSettings(opts.config ?? this._config))`; replaces one line, adds none (grandfathered size 650).
- `packages/nax/src/agents/manager-complete-as.ts` — `completeAsWithFallback` passes the codex-adjusted model def to `buildCompleteCallPreamble`.
- `packages/nax/src/agents/acp/profile-map.ts` — header comment only: codex is removed from the list of agents refused `read` until #2372.
- `packages/nax/test/unit/config/agent-schema.test.ts` — the test "agent.acp has no transport key after S4b-5" pins the exact `agent.acp` default; its expected object gains `codex: { isolateHome: false, fullMode: "workspace-write" }`. US-002's schema acceptance tests are added to this file.
- `packages/nax/test/unit/session/model-selection.test.ts` — US-002's `selectModel` acceptance tests are added to this file; no existing test in it changes.
- `packages/nax/test/unit/session/manager.test.ts` — US-002's `SessionManager.openSession` acceptance tests are added to this file; no existing test in it changes.
- `packages/nax/test/unit/agents/complete-as-with-fallback.test.ts` — US-002's `completeAsWithFallback` acceptance tests are added to this file; no existing test in it changes.
- `docs/guides/configuration.md` — documents `agent.acp.codex.fullMode` and `agent.acp.codex.isolateHome` beside `agent.acp.promptRetries`.

### Seams

- US-002: `withCodexAcpEnv` and `codexAcpSettings` (new exports of `src/agents/shared/codex-acp-env.ts`) are consumed by `selectModel` and `completeAsWithFallback` in the same story; the seam ACs enter at `SessionManager.openSession` and `completeAsWithFallback`, above the config read.

## Acceptance Criteria

### US-001

1. [unit] `registryEntry("codex")?.readOnly` equals `{ mode: { configId: "mode", value: "read-only" }, disallowedTools: [], sessionOptions: {} }`, and `registryEntry("codex")?.defaultMode` and `registryEntry("codex")?.preApproval` are both `undefined`.
2. [unit] Every registry entry whose `readOnly` is defined has a `readOnly.mode` with a non-empty `configId` and `value`.
3. [unit] `modeFor("read", registryEntry("codex"))`, `modeFor("none", registryEntry("codex"))` and `modeFor("review", registryEntry("codex"))` each equal `{ configId: "mode", value: "read-only" }`.
4. [unit] `modeFor("full", registryEntry("codex"))` and `modeFor("ask", registryEntry("codex"))` are both `undefined`.
5. [unit] `unmetRequirement(buildCapabilityRecord(init, registryEntry("codex")), { profile: "read", toolCount: 0, resume: false })` is `undefined`, where `init` is an `initialize` response with no MCP capabilities.
6. [unit] The same check with `profile: "review"` is `undefined`.
7. [integration] With a fake agent offering `CODEX_CONFIG_OPTIONS`, `createAgentSession` with `acpBackend({ agent: "codex", ... })` and profile `read` opens, and the fake records exactly one `session/set_config_option` call, with `configId` `"mode"` and `value` `"read-only"`.
8. [integration] The same codex open with profile `full` records no `session/set_config_option` call whose `configId` is `"mode"`.
9. [integration] A codex open with profile `read` sends `session/new` with `mcpServers: []` and no `_meta` field.
10. [integration] A codex open with profile `review` whose session carries a sandbox of kind `unavailable` opens without error.
11. [integration] A codex open with profile `full` whose session carries a sandbox of kind `unavailable` opens without error.
12. [integration] In a codex session opened with profile `review` and a sandbox of kind `policy`, a `session/request_permission` for an `execute` tool call is answered with the reject option, and the session records the decision `deny` with reason `REVIEW_NO_SANDBOX_REASON`.
13. [integration] In a Claude session opened with profile `review` and the same `policy` sandbox, the same `execute` permission request is answered with the `allow_once` option and recorded with reason `REVIEW_EXECUTE_REASON` (unchanged behaviour).
14. [integration] A Claude open with profile `review` and a sandbox of kind `unavailable` is still refused with `AGENT_SESSION_CAPABILITY_UNSUPPORTED`, capability `profile`.
15. [integration] In a codex session opened with profile `read`, a `session/request_permission` for a file-edit tool call is answered with the reject option and recorded with reason `readOnlyReason("read")`.
16. [integration] A codex open with profile `read` whose fake agent offers a `mode` option without the value `read-only` is refused with `AGENT_SESSION_CAPABILITY_UNSUPPORTED`, capability `profile`, and the agent process is killed once.
17. [integration] A codex open with profile `read` and one embedder tool is refused with `AGENT_SESSION_CAPABILITY_UNSUPPORTED`, capability `tools` (unchanged).
18. [integration] In a codex session opened with profile `full` and a sandbox of kind `policy`, a `session/request_permission` for a file-edit tool call whose target lies outside the session's working directory is answered with the `allow_once` option and recorded with reason `FULL_REASON`.

### US-002

1. [unit] Parsing a config with `agent.acp` unset yields `agent.acp.codex` equal to `{ isolateHome: false, fullMode: "workspace-write" }`.
2. [unit] Parsing a config with `agent.acp.codex.fullMode: "agent-full-access"` yields `"agent-full-access"`, and `agent.acp.codex.isolateHome` keeps its default `false`.
3. [unit] Parsing a config with `agent.acp.codex.fullMode: "danger"` fails validation with an issue whose path ends in `fullMode`.
4. [unit] Parsing a config with `agent.acp.codex.isolateHome: "yes"` fails validation with an issue whose path ends in `isolateHome`.
5. [unit] `codexAcpSettings(undefined)` returns `{ isolateHome: false, fullMode: "workspace-write" }`, and `codexAcpSettings({ agent: { acp: { codex: { isolateHome: true, fullMode: "agent-full-access" } } } })` returns `{ isolateHome: true, fullMode: "agent-full-access" }`.
6. [unit] `isolatedCodexHomeDir()` returns `join(globalConfigDir(), "acp", "codex-home")`.
7. [unit] With `_codexAcpEnvDeps` stubbed so `fileExists("/u/.codex/auth.json")` is true, `entryExists` is false for the isolated `auth.json`, `env("CODEX_HOME")` is undefined and `homedir()` is `"/u"`, `prepareIsolatedCodexHome()` calls `mkdir` with the isolated home, calls `symlink("/u/.codex/auth.json", <isolated>/auth.json)` once, and returns the isolated home.
8. [unit] With `env("CODEX_HOME")` returning `"/custom/codex"` and that `auth.json` present, the `symlink` target is `"/custom/codex/auth.json"`.
9. [unit] With `env("CODEX_HOME")` returning `""`, the source home is `<homedir()>/.codex`.
10. [unit] When `entryExists` is true for the isolated `auth.json` (including a dangling link), `prepareIsolatedCodexHome()` does not call `symlink` and returns the isolated home.
11. [unit] When `fileExists` is false for the source `auth.json`, `prepareIsolatedCodexHome()` calls `mkdir`, does not call `symlink`, and returns the isolated home.
12. [unit] `withCodexAcpEnv({ provider: "openai", model: "gpt", env: { A: "1" } }, "codex", { isolateHome: false, fullMode: "workspace-write" })` returns a new object whose `env` equals `{ A: "1", INITIAL_AGENT_MODE: "workspace-write" }`, the input's `env` still equals `{ A: "1" }`, and no `_codexAcpEnvDeps` filesystem function is called.
13. [unit] `withCodexAcpEnv(def, "codex", { isolateHome: false, fullMode: "agent-full-access" })` returns a def whose `env.INITIAL_AGENT_MODE` is `"agent-full-access"`.
14. [unit] `withCodexAcpEnv(def, "codex", { isolateHome: true, fullMode: "workspace-write" })` returns a def whose `env.CODEX_HOME` is the isolated home and whose `env.INITIAL_AGENT_MODE` is `"workspace-write"`.
15. [unit] `withCodexAcpEnv(def, "claude", { isolateHome: true, fullMode: "agent-full-access" })` returns `def` itself (same reference) and calls no `_codexAcpEnvDeps` function.
16. [unit] `withCodexAcpEnv({ provider: "openai", model: "gpt", env: { CODEX_HOME: "/mine", INITIAL_AGENT_MODE: "read-only" } }, "codex", { isolateHome: true, fullMode: "agent-full-access" })` returns a def whose `env` still has `CODEX_HOME` `"/mine"` and `INITIAL_AGENT_MODE` `"read-only"`.
17. [unit] When `_codexAcpEnvDeps.mkdir` throws, `withCodexAcpEnv(def, "codex", { isolateHome: true, fullMode: "workspace-write" })` returns a def with no `CODEX_HOME`, with `INITIAL_AGENT_MODE` `"workspace-write"`, and `_codexAcpEnvDeps.warn` is called exactly once.
18. [unit] `selectModel({ modelDef, agentName: "codex" })` (one argument) returns a `modelDef` whose env has neither `CODEX_HOME` nor `INITIAL_AGENT_MODE`.
19. [integration] `SessionManager.openSession` with `agentName: "codex"` and a config whose `agent.acp.codex` is `{ isolateHome: true, fullMode: "agent-full-access" }` calls the adapter's `openSession` with options whose `modelDef.env.CODEX_HOME` equals `isolatedCodexHomeDir()` and whose `modelDef.env.INITIAL_AGENT_MODE` is `"agent-full-access"`, with `_codexAcpEnvDeps` stubbed.
20. [integration] `SessionManager.openSession` with `agentName: "codex"` on a manager constructed with no config, and a request with no config, opens without throwing and passes `modelDef.env.INITIAL_AGENT_MODE` `"workspace-write"` and no `CODEX_HOME`.
21. [integration] `SessionManager.openSession` with `agentName: "claude"` and `isolateHome` `true` calls the adapter's `openSession` with a `modelDef` whose env has neither `CODEX_HOME` nor `INITIAL_AGENT_MODE`.
22. [integration] `completeAsWithFallback` with `agentName` `"codex"` and `input.config.agent.acp.codex` `{ isolateHome: true, fullMode: "workspace-write" }` calls `input.completeWithFallback` with options whose `modelDef.env.CODEX_HOME` equals `isolatedCodexHomeDir()` and `modelDef.env.INITIAL_AGENT_MODE` is `"workspace-write"`.
23. [integration] `completeAsWithFallback` with `agentName` `"codex"`, `input.config.agent.acp.codex.fullMode` `"workspace-write"` and `options.config.agent.acp.codex.fullMode` `"agent-full-access"` passes `modelDef.env.INITIAL_AGENT_MODE` `"agent-full-access"` (the per-call config wins).
