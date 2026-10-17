# SPEC: opencode over ACP — read-only profiles by injected permission config, optional isolated config dir

## Summary

Make opencode usable over ACP for profiles `none`, `read` and `review`. nax-agent-acp launches the opencode process for those profiles with the env var `OPENCODE_CONFIG_CONTENT` set to a permission policy that opencode itself enforces: every tool denied, then (for `read` and `review`) the read tools `read`, `glob`, `grep` and `list` allowed, and (for `review` only) `bash` set to `ask`, so each shell command reaches nax as a permission request that nax's `review` rule decides. A denied tool is removed from opencode's tool catalog, so the model never sees it. A second setting, `agent.acp.opencode.isolateConfig` (default off), points `OPENCODE_CONFIG_DIR` at an empty nax-owned directory so the user's global opencode config (plugins, MCP servers, agents) stays out of nax sessions.

This is the opencode slice of nathapp-io/nax#2372; gemini and pi stay open on that issue.

## Motivation

`acpProfileFor` (`packages/nax/src/agents/acp/profile-map.ts`) opens `read` or `review` for every op without a file-write tool: reviewers, re-reviewers and the advisor. `unmetRequirement` (`packages/nax-agent-acp/src/client/capabilities.ts`) refuses both on any agent whose registry entry has no `readOnly` enforcement, and opencode has none. So opencode can run only implementer-shaped sessions.

opencode (v2.0.27, source and a live probe on 2026-10-17) has no mode that is read-only. Its ACP `mode` option selects one of its agents; the built-in `plan` agent only denies file edits (outside its own plan directory) and leaves shell and web tools allowed, and a probe showed the model refusing a write only because the plan prompt told it to. What opencode does enforce is its permission config. Config sources merge in a fixed order and `OPENCODE_CONFIG_CONTENT` ranks highest. Rules are last-match-wins over `{ action, resource }`; a rule with effect `deny` removes the tool from the catalog. Live results under `OPENCODE_CONFIG_CONTENT` = `{"permission":{"*":"deny","read":"allow","glob":"allow","grep":"allow","list":"allow"}}`: the model read a file, had no write or shell tool, said so, and the turn ended `completed` with nothing written. opencode's code-mode `execute` tool is a pure interpreter with no filesystem, process or network access and reaches only tools the rules permit, so it cannot bypass the policy. A permission request that nax rejects comes back to the model as a tool error ("The user declined this tool call") and the turn continues to `completed`.

opencode also loads the user's global config dir (`~/.config/opencode`): plugins are code that runs in the opencode process, plus MCP servers and agents. `OPENCODE_CONFIG_DIR` replaces that dir; credentials live in opencode's data dir, so a session with an empty config dir still authenticates (probed live).

User rulings (2026-10-17): under `review`, shell commands go to nax (`bash: ask`), whose `review` rule decides them; an `agent.acp.opencode.isolateConfig` option, default off; read-only sessions keep opencode's default agent, with the injected permission policy as the enforcement (no `plan` mode).

## Design

### Integration

Symbols this feature only reads:

- `decidePermission(request, ctx)` in `packages/nax-agent-acp/src/client/permissions.ts`: under `review`, an `execute` request is rejected with `REVIEW_NO_SANDBOX_REASON` when `ctx.sandbox` is undefined; a non-`execute` request is rejected with `readOnlyReason("review")`. Unchanged.
- `routerFor(ctx, secrets, entry)` in `backend.ts` and `sandboxFor(ctx, entry)` in `open.ts` give the permission layer a sandbox only when `entry?.preApproval` is defined. opencode has no `preApproval`, so under `review` every shell command opencode asks about is rejected with `REVIEW_NO_SANDBOX_REASON`. Unchanged.
- `modeFor(profile, entry)` in `capabilities.ts` returns `entry.readOnly.mode` for `none`/`read`/`review`; `applyMode` in `open.ts` skips the `session/set_config_option` call when that mode is undefined.
- `unmetRequirement(record, req)` refuses a read-only profile when `record.readOnlyMode` is false; `buildCapabilityRecord` sets `readOnlyMode` to `entry?.readOnly !== undefined`.
- `codexAcpSettings(config)` and `withCodexAcpEnv(def, agentName, settings)` in `packages/nax/src/agents/shared/codex-acp-env.ts`; unchanged.
- `globalConfigDir()` in `packages/nax/src/config/paths/index.ts`.

Symbols this feature changes. Each **Baseline** exists only to locate the code; it is never the interface to implement. Implement the **Target**.

- `ReadOnlyEnforcement` (`packages/nax-agent-acp/src/client/registry.ts`)
  - Baseline: `{ mode: ModeSetting; disallowedTools; sessionOptions }`.
  - Target: `{ mode: ModeSetting | undefined; disallowedTools; sessionOptions; launchEnv: Readonly<Partial<Record<"none" | "read" | "review", Readonly<Record<string, string>>>>> }`. `launchEnv` holds variables added to the agent process's environment when the session's profile is that key. `freezeReadOnly` freezes `launchEnv` and each inner record, and copies `mode` only when defined. The Claude and codex entries declare `launchEnv: {}`.
- Registry entry `opencode`
  - Baseline: `entry("opencode", [local("opencode", "acp")], [])`; `readOnly`, `defaultMode`, `preApproval` undefined.
  - Target: same launch and auth env; `readOnly: { mode: undefined, disallowedTools: [], sessionOptions: {}, launchEnv: { none: { OPENCODE_CONFIG_CONTENT: OPENCODE_NONE_CONFIG }, read: { OPENCODE_CONFIG_CONTENT: OPENCODE_READ_CONFIG }, review: { OPENCODE_CONFIG_CONTENT: OPENCODE_REVIEW_CONFIG } } }`; `defaultMode` and `preApproval` undefined.
- New exported function `launchEnvFor(profile, entry)` in `capabilities.ts`, beside `modeFor`: returns `entry.readOnly.launchEnv[profile]` for `none`/`read`/`review` when present, otherwise `{}` (including `full`, `ask`, an entry without `readOnly`, and `entry` undefined).
- `openAcpSession` (`packages/nax-agent-acp/src/client/open.ts`)
  - Baseline: launches with `env: options.env`.
  - Target: launches with `env: { ...options.env, ...launchEnvFor(ctx.profile, options.entry) }`. The enforcement value wins over a caller-supplied variable of the same name, so a model's own `OPENCODE_CONFIG_CONTENT` cannot weaken a read-only session. Every launch goes through `openAcpSession` (new session, resume, and the reconnect after the agent process dies), so every launch of the session carries it.
- `AgentAcpConfigSchema` (`packages/nax/src/config/schemas-infra.ts`)
  - Baseline: `promptRetries`, `trackedSpawnDeadlineMs`, `trackedSpawnStartupDeadlineMs`, `codex`.
  - Target: adds `opencode: z.object({ isolateConfig: z.boolean().default(false) }).default({ ...DEFAULT_AGENT_OPENCODE_ACP_CONFIG })`, where `DEFAULT_AGENT_OPENCODE_ACP_CONFIG = { isolateConfig: false }` is exported beside `DEFAULT_AGENT_CODEX_ACP_CONFIG`. Both literal `agent.acp` defaults gain `opencode: { ...DEFAULT_AGENT_OPENCODE_ACP_CONFIG }`: the outer `acp: AgentAcpConfigSchema.default({...})` in `schemas-infra.ts` and the `acp` object in the `schemas.ts` defaults (zod's `.default(value)` returns the literal unparsed, so a literal without `opencode` leaves it unset). `DEFAULT_AGENT_OPENCODE_ACP_CONFIG` is re-exported from the `src/config/index.ts` barrel beside `DEFAULT_AGENT_CODEX_ACP_CONFIG`, and the `AgentAcpConfig` interface in `src/config/runtime-types-agent.ts` gains `opencode?: { isolateConfig?: boolean }`.
- `selectModel(opts, codex?)` (`packages/nax/src/session/model-selection.ts`)
  - Baseline: second parameter `codex?: CodexAcpSettings`, applied with `withCodexAcpEnv`; the module re-exports `codexAcpSettings` for `manager.ts`.
  - Target: `selectModel(opts: ModelSelection, acp?: AcpEnvSettings)`; when `acp` is given the config `ModelDef` is first passed through `withAcpEnv(opts.modelDef, opts.agentName, acp)`. The module re-exports `acpEnvSettings` instead of `codexAcpSettings`. A one-argument call is unchanged.
- `SessionManager.openSession` (`packages/nax/src/session/manager.ts`)
  - Baseline: `...selectModel(opts, codexAcpSettings(opts.config ?? this._config)),` with `import { codexAcpSettings, selectModel } from "./model-selection";`.
  - Target: `...selectModel(opts, acpEnvSettings(opts.config ?? this._config)),` with `import { acpEnvSettings, selectModel } from "./model-selection";`. Both lines are replaced, none added (grandfathered size 650).
- `completeAsWithFallback` (`packages/nax/src/agents/manager-complete-as.ts`)
  - Baseline: `modelDef: withCodexAcpEnv(options.modelDef, agentName, codexAcpSettings(options.config ?? input.config))`.
  - Target: `modelDef: withAcpEnv(options.modelDef, agentName, acpEnvSettings(options.config ?? input.config))`.

### Permission policy constants (`registry.ts`)

Exported strings, each the `JSON.stringify` of the object shown, keys in this order (opencode rules are last-match-wins, so `"*"` must come first):

```typescript
/** none: no tool at all. */
export const OPENCODE_NONE_CONFIG = JSON.stringify({ permission: { "*": "deny" } });
/** read: only opencode's read tools. */
export const OPENCODE_READ_CONFIG = JSON.stringify({
  permission: { "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow" },
});
/** review: the read tools, plus shell commands asked of nax (decided by the review rule). */
export const OPENCODE_REVIEW_CONFIG = JSON.stringify({
  permission: { "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow", bash: "ask" },
});
```

### New modules in `packages/nax/src/agents/shared/`

Under `src/agents/shared/` because `src/agents/acp/` may not import config (`check-adapter-no-config-import.sh`). Worked skeleton:

```typescript
// opencode-acp-env.ts
export interface OpencodeAcpSettings {
  readonly isolateConfig: boolean;
}
/** Settings from config.agent.acp.opencode; schema defaults when the config or any level is undefined. */
export function opencodeAcpSettings(config: Pick<NaxConfig, "agent"> | undefined): OpencodeAcpSettings;
/** <globalConfigDir()>/acp/opencode-config */
export function isolatedOpencodeConfigDir(): string;
/**
 * For agentName "opencode" with settings.isolateConfig true and no OPENCODE_CONFIG_DIR in def.env:
 * mkdir the isolated dir (recursive, nothing written into it) and return a NEW def whose env adds
 * OPENCODE_CONFIG_DIR = isolatedOpencodeConfigDir(). Otherwise returns the input itself.
 * Never mutates the input. When mkdir throws: one warn, the input itself is returned.
 */
export function withOpencodeAcpEnv<T extends { env?: Record<string, string> }>(
  def: T,
  agentName: string | undefined,
  settings: OpencodeAcpSettings,
): T;
/** Test seam. */
export const _opencodeAcpEnvDeps: {
  mkdir: (path: string) => void; // recursive
  warn: (message: string, data: Record<string, unknown>) => void;
};

// acp-env.ts
export interface AcpEnvSettings {
  readonly codex: CodexAcpSettings;
  readonly opencode: OpencodeAcpSettings;
}
/** { codex: codexAcpSettings(config), opencode: opencodeAcpSettings(config) } */
export function acpEnvSettings(config: Pick<NaxConfig, "agent"> | undefined): AcpEnvSettings;
/** withOpencodeAcpEnv(withCodexAcpEnv(def, agentName, settings.codex), agentName, settings.opencode) */
export function withAcpEnv<T extends { env?: Record<string, string> }>(
  def: T,
  agentName: string | undefined,
  settings: AcpEnvSettings,
): T;
```

### Failure Handling

| Situation | Behaviour |
|:---|:---|
| A read-only opencode session's model tries a write or shell tool under `none`/`read` | The tool is not in opencode's catalog; the model reports it cannot, and the turn completes. Nothing reaches nax. This is opencode's own behaviour: no AC here; covered by the billed live check named in Out of Scope. |
| opencode asks to run a shell command under `review` | Rejected with `REVIEW_NO_SANDBOX_REASON`; opencode reports "The user declined this tool call" to the model and the turn continues. |
| The model def's env already sets `OPENCODE_CONFIG_CONTENT` and the profile is `none`/`read`/`review` | The enforcement value replaces it. |
| The model def's env sets `OPENCODE_CONFIG_CONTENT` and the profile is `full` or `ask` | The model's value is passed through unchanged. |
| `isolateConfig` true and the isolated dir cannot be created | One `warn`; no `OPENCODE_CONFIG_DIR` is set, so the session runs on the user's opencode config (fail open, per the "not too tight" ruling). |
| Model env already sets `OPENCODE_CONFIG_DIR` | The model env value is kept; nax does not override it and creates no dir. |

## Out of Scope

- Read-only enforcement for gemini and pi (the rest of nathapp-io/nax#2372); this spec does not close that issue.
- Selecting opencode's `plan` agent, or any opencode mode, for read-only profiles: the injected permission policy is the enforcement and nax sends no `session/set_config_option` for `mode` on opencode.
- Profiles `full` and `ask` on opencode: unchanged, opencode's own default permissions apply (its default agent writes and runs commands without asking), and nax injects no permission policy for them.
- Running shell commands for an opencode reviewer: opencode has no sandbox nax can deliver, so every shell command under `review` is rejected (accepted 2026-10-17); nax's embedder sandbox is never applied to opencode.
- Embedder tools (the loopback MCP tool host) on opencode: opencode has no pre-approval channel, so a session with tools is still refused with capability `tools`.
- Reads outside the session's working directory under `read`/`review`: opencode classifies them as its `external_directory` action, which the policy denies.
- Copying or translating any part of the user's opencode config (providers, plugins, MCP servers, agents, the default model) into the isolated config dir; a provider defined only in the user's config is not available to an isolated session.
- Removing or cleaning the isolated config dir; it is created once and reused.
- An opencode version that renames its read tools or its `OPENCODE_CONFIG_CONTENT` / `OPENCODE_CONFIG_DIR` variables; nax does not detect it, and a renamed read tool is simply denied.
- A `complete()` call that reaches opencode only as a fallback agent: the fallback resolver supplies its own model def, so that call gets no `OPENCODE_CONFIG_DIR`.
- Updating the package context file `.nax/mono/packages/nax-agent-acp/context.md` to say opencode is read-only capable: a manual step after merge, since `.nax/` is read-only to the run.
- A billed live check against a real opencode process: a maintainer step after merge.

## Stories

### US-001: opencode read-only by injected permission config

Workdir: `packages/nax-agent-acp`. No dependencies.

Make `ReadOnlyEnforcement.mode` optional and add `launchEnv` (frozen by `freezeReadOnly`; `{}` on Claude and codex). Export `OPENCODE_NONE_CONFIG`, `OPENCODE_READ_CONFIG` and `OPENCODE_REVIEW_CONFIG` from `registry.ts` and give the `opencode` entry its `readOnly` enforcement. Add `launchEnvFor(profile, entry)` to `capabilities.ts` and make `openAcpSession` launch with `{ ...options.env, ...launchEnvFor(ctx.profile, options.entry) }`. Put this story's integration tests in a new `test/unit/client/backend-opencode.test.ts`. Claude and codex behaviour does not change.

### US-002: optional isolated opencode config dir in nax

Workdir: `packages/nax`. No dependencies.

Add `agent.acp.opencode.isolateConfig` (default `false`) to the schema, the literal `acp` default and the runtime type, with `DEFAULT_AGENT_OPENCODE_ACP_CONFIG`. Create `src/agents/shared/opencode-acp-env.ts` (`OpencodeAcpSettings`, `opencodeAcpSettings`, `isolatedOpencodeConfigDir`, `withOpencodeAcpEnv`, `_opencodeAcpEnvDeps`) and `src/agents/shared/acp-env.ts` (`AcpEnvSettings`, `acpEnvSettings`, `withAcpEnv`). Switch `selectModel`, `SessionManager.openSession` and `completeAsWithFallback` from the codex-only helpers to `acpEnvSettings` / `withAcpEnv`, so codex behaves as before and opencode gains `OPENCODE_CONFIG_DIR`. Update the `profile-map.ts` header comment that lists opencode among agents without `read`. Document `agent.acp.opencode.isolateConfig` in `docs/guides/configuration.md` beside `agent.acp.codex.isolateHome`: it points opencode at an empty `~/.nax/acp/opencode-config` so the user's plugins, MCP servers, agents and providers stay out; credentials still load from opencode's data dir; default `false`.

### Context Files

**US-001**

- `packages/nax-agent-acp/src/client/registry.ts` — `ReadOnlyEnforcement`, `freezeReadOnly`, `entry()`, the Claude and codex entries
- `packages/nax-agent-acp/src/client/capabilities.ts` — `modeFor`, `readOnlyFor`, `unmetRequirement`, `buildCapabilityRecord`
- `packages/nax-agent-acp/src/client/open.ts` — `openAcpSession`, `applyMode`
- `packages/nax-agent-acp/test/unit/client/backend-codex.test.ts` — the `inMemoryAgent` + `createAgentSession` pattern for a non-Claude agent
- `packages/nax-agent-acp/test/helpers/in-memory-launch.ts` — `InMemoryAgent.requests` (each launch request, with its `env`) and `crash()`
- `packages/nax-agent-acp/test/unit/client/backend-reconnect.test.ts` — the `RESUMABLE` script and `crash()` pattern that drives a reconnect

**US-002**

- `packages/nax/src/agents/shared/codex-acp-env.ts` — the precedent module (settings reader, isolated dir, env injection, deps seam)
- `packages/nax/src/session/model-selection.ts` — `selectModel`, `ModelSelection`
- `packages/nax/src/agents/manager-complete-as.ts` — `completeAsWithFallback`
- `packages/nax/src/config/schemas-infra.ts` — `AgentAcpConfigSchema`, `DEFAULT_AGENT_CODEX_ACP_CONFIG`
- `packages/nax/test/helpers/codex-acp-deps.ts` — how existing tests stub the codex deps seam

### Creates

**US-001**

- `packages/nax-agent-acp/test/unit/client/backend-opencode.test.ts`

**US-002**

- `packages/nax/src/agents/shared/opencode-acp-env.ts`
- `packages/nax/src/agents/shared/acp-env.ts`
- `packages/nax/test/unit/agents/shared/opencode-acp-env.test.ts`
- `packages/nax/test/unit/agents/shared/acp-env.test.ts`

### Modifies

**US-001**
- `packages/nax-agent-acp/src/client/registry.ts` — `ReadOnlyEnforcement.mode` becomes optional and `launchEnv` is added; `freezeReadOnly` freezes it; the Claude and codex entries declare `launchEnv: {}`; the three `OPENCODE_*_CONFIG` constants are exported and the opencode entry gets its `readOnly`.
- `packages/nax-agent-acp/src/client/capabilities.ts` — adds `launchEnvFor`; `modeFor` is unchanged and returns `undefined` for an entry whose `readOnly.mode` is undefined.
- `packages/nax-agent-acp/src/client/open.ts` — `openAcpSession` launches with `{ ...options.env, ...launchEnvFor(ctx.profile, options.entry) }`.
- `packages/nax-agent-acp/test/unit/client/registry.test.ts` — the table test "%s: launch candidates and auth env; no read-only enforcement, no pre-approval" lists opencode with `readOnly: undefined`, so opencode moves out of that table into its own test asserting the new `readOnly` (gemini and pi stay); the Claude and codex exact-entry tests gain `launchEnv: {}` in their expected `readOnly`; and the test "every entry declaring read-only enforcement sets a mode (nax#2372)" fails for opencode, so it is replaced by a test that every entry declaring `readOnly` either sets a `readOnly.mode` with non-empty `configId` and `value` or declares a non-empty `launchEnv` record for each of `none`, `read` and `review`.

**US-002**
- `packages/nax/src/config/schemas-infra.ts` — adds `DEFAULT_AGENT_OPENCODE_ACP_CONFIG`, the `opencode` object to `AgentAcpConfigSchema`, and `opencode: { ...DEFAULT_AGENT_OPENCODE_ACP_CONFIG }` to the outer `acp: AgentAcpConfigSchema.default({...})` literal.
- `packages/nax/src/config/index.ts` — re-exports `DEFAULT_AGENT_OPENCODE_ACP_CONFIG` from the barrel beside `DEFAULT_AGENT_CODEX_ACP_CONFIG`, so the new opencode env module and the schema defaults import it through the config barrel as the codex module does.
- `packages/nax/src/config/schemas.ts` — adds `opencode: { ...DEFAULT_AGENT_OPENCODE_ACP_CONFIG }` to the literal `acp` default object.
- `packages/nax/src/config/runtime-types-agent.ts` — adds the optional `opencode` block to the `AgentAcpConfig` interface.
- `packages/nax/src/session/model-selection.ts` — `selectModel`'s second parameter becomes `acp?: AcpEnvSettings`, applied with `withAcpEnv`; the module re-exports `acpEnvSettings` instead of `codexAcpSettings`.
- `packages/nax/src/session/manager.ts` — the import line and the `...selectModel(...)` line in `openSession` switch from `codexAcpSettings` to `acpEnvSettings`; two lines replaced, none added (grandfathered size 650).
- `packages/nax/src/agents/manager-complete-as.ts` — `completeAsWithFallback` uses `withAcpEnv(options.modelDef, agentName, acpEnvSettings(options.config ?? input.config))`.
- `packages/nax/src/agents/acp/profile-map.ts` — header comment only: opencode is removed from the list of agents refused `read` until #2372.
- `packages/nax/test/unit/config/agent-schema.test.ts` — the test "agent.acp has no transport key after S4b-5" pins the exact `agent.acp` default; its expected object gains `opencode: { isolateConfig: false }`. US-002's schema acceptance tests are added to this file.
- `packages/nax/test/unit/session/model-selection.test.ts` — the two tests "US-002: the settings argument adds the codex env to the SessionModel def" and "US-002: settings for a non-codex agent leave the model def alone" pass a bare codex settings object as the second argument; they pass `{ codex: <that object>, opencode: { isolateConfig: false } }` instead and keep their expected results. This story's `selectModel` acceptance tests are added to this file.
- `packages/nax/test/unit/session/manager-phase-b-session.test.ts` — US-002's `SessionManager.openSession` acceptance tests for opencode are added to this file; no existing test in it changes.
- `packages/nax/test/unit/agents/complete-as-with-fallback.test.ts` — US-002's `completeAsWithFallback` acceptance tests for opencode are added to this file; no existing test in it changes.
- `docs/guides/configuration.md` — documents `agent.acp.opencode.isolateConfig` beside `agent.acp.codex.isolateHome`.

### Seams

- US-001: `launchEnvFor` (new export of `capabilities.ts`) is consumed by `openAcpSession` in the same story; its seam ACs enter at `createAgentSession` with `acpBackend({ agent: "opencode" })` and assert on the recorded launch request.
- US-002: `acpEnvSettings` and `withAcpEnv` (new exports of `src/agents/shared/acp-env.ts`) are consumed by `selectModel` and `completeAsWithFallback` in the same story; the seam ACs enter at `SessionManager.openSession` and `completeAsWithFallback`, above the config read.

## Acceptance Criteria

### US-001

1. [unit] `registryEntry("opencode")?.readOnly` has `mode` `undefined`, `disallowedTools` `[]`, `sessionOptions` `{}`, and `launchEnv` equal to `{ none: { OPENCODE_CONFIG_CONTENT: OPENCODE_NONE_CONFIG }, read: { OPENCODE_CONFIG_CONTENT: OPENCODE_READ_CONFIG }, review: { OPENCODE_CONFIG_CONTENT: OPENCODE_REVIEW_CONFIG } }`; `registryEntry("opencode")?.defaultMode` and `registryEntry("opencode")?.preApproval` are both `undefined`.
2. [unit] Parsing `OPENCODE_NONE_CONFIG` as JSON yields `{ permission: { "*": "deny" } }`.
3. [unit] Parsing `OPENCODE_READ_CONFIG` as JSON yields a `permission` object whose keys, in order, are `"*"`, `"read"`, `"glob"`, `"grep"`, `"list"`, with `"*"` mapped to `"deny"` and the other four to `"allow"`.
4. [unit] Parsing `OPENCODE_REVIEW_CONFIG` as JSON yields a `permission` object whose keys, in order, are `"*"`, `"read"`, `"glob"`, `"grep"`, `"list"`, `"bash"`, with `"*"` mapped to `"deny"`, the four read tools to `"allow"` and `"bash"` to `"ask"`.
5. [unit] `registryEntry("claude")?.readOnly?.launchEnv` and `registryEntry("codex")?.readOnly?.launchEnv` both equal `{}`, and `registryEntry("opencode")?.readOnly?.launchEnv` and its `read` record are frozen.
6. [unit] Every registry entry whose `readOnly` is defined either has a `readOnly.mode` with non-empty `configId` and `value`, or has a non-empty `readOnly.launchEnv` record for each of `none`, `read` and `review`.
7. [unit] `launchEnvFor("read", registryEntry("opencode"))` equals `{ OPENCODE_CONFIG_CONTENT: OPENCODE_READ_CONFIG }`, and `launchEnvFor("none", ...)` and `launchEnvFor("review", ...)` equal the `none` and `review` records.
8. [unit] `launchEnvFor("full", registryEntry("opencode"))`, `launchEnvFor("ask", registryEntry("opencode"))`, `launchEnvFor("read", registryEntry("claude"))`, `launchEnvFor("read", registryEntry("gemini"))` and `launchEnvFor("read", undefined)` each equal `{}`.
9. [unit] `modeFor("read", registryEntry("opencode"))` and `modeFor("review", registryEntry("opencode"))` are both `undefined`.
10. [unit] `unmetRequirement(buildCapabilityRecord(init, registryEntry("opencode")), { profile: "read", toolCount: 0, resume: false })` is `undefined`, where `init` is an `initialize` response with no MCP capabilities; the same check with `profile: "review"` is `undefined`.
11. [integration] `createAgentSession` with `acpBackend({ agent: "opencode", ... })`, a fake agent and profile `read` opens, the fake's first launch request has `env.OPENCODE_CONFIG_CONTENT` equal to `OPENCODE_READ_CONFIG`, and the fake records no `session/set_config_option` call whose `configId` is `"mode"`.
12. [integration] The same opencode open with profile `review` launches with `env.OPENCODE_CONFIG_CONTENT` equal to `OPENCODE_REVIEW_CONFIG`, and with profile `none` with `OPENCODE_NONE_CONFIG`.
13. [integration] An opencode open with profile `full` and no `OPENCODE_CONFIG_CONTENT` in the backend options' `env` launches with no `OPENCODE_CONFIG_CONTENT` in its env.
14. [integration] An opencode open with profile `read` whose backend options' `env` sets `OPENCODE_CONFIG_CONTENT` to `"{}"` launches with `env.OPENCODE_CONFIG_CONTENT` equal to `OPENCODE_READ_CONFIG`.
15. [integration] An opencode open with profile `full` whose backend options' `env` sets `OPENCODE_CONFIG_CONTENT` to `"{}"` launches with `env.OPENCODE_CONFIG_CONTENT` equal to `"{}"`.
16. [integration] In an opencode session opened with profile `read` against a fake that advertises session resume (so the backend reconnects), and whose process is crashed with `InMemoryAgent.crash()` after the first turn, the second turn's relaunch request (the fake's second recorded launch request) also has `env.OPENCODE_CONFIG_CONTENT` equal to `OPENCODE_READ_CONFIG`.
17. [integration] In an opencode session opened with profile `review` and a sandbox of kind `policy`, a `session/request_permission` for an `execute` tool call is answered with the reject option, and the session records the decision `deny` with reason `REVIEW_NO_SANDBOX_REASON`.
18. [integration] In an opencode session opened with profile `read`, a `session/request_permission` for a file-edit tool call is answered with the reject option and recorded with reason `readOnlyReason("read")`.
19. [integration] An opencode open with profile `read` and one embedder tool is refused with `AGENT_SESSION_CAPABILITY_UNSUPPORTED`, capability `tools`.
20. [integration] (regression anchor: already true on main) A codex open with profile `read` (fake agent offering `CODEX_CONFIG_OPTIONS`) launches with no `OPENCODE_CONFIG_CONTENT` in its env and still records one `session/set_config_option` call with `configId` `"mode"` and `value` `"read-only"`.

### US-002

1. [unit] Parsing a config with `agent.acp` unset yields `agent.acp.opencode` equal to `{ isolateConfig: false }`, and `agent.acp.codex` still equals `{ isolateHome: false, fullMode: "workspace-write" }`.
2. [unit] Parsing a config with `agent.acp.opencode.isolateConfig: "yes"` fails validation with an issue whose path ends in `isolateConfig`.
3. [unit] `opencodeAcpSettings(undefined)` and `opencodeAcpSettings({})` return `{ isolateConfig: false }`, and `opencodeAcpSettings({ agent: { acp: { opencode: { isolateConfig: true } } } })` returns `{ isolateConfig: true }`.
4. [unit] `isolatedOpencodeConfigDir()` returns `join(globalConfigDir(), "acp", "opencode-config")`.
5. [unit] `withOpencodeAcpEnv(def, "opencode", { isolateConfig: false })` returns `def` itself (same reference) and calls no `_opencodeAcpEnvDeps` function.
6. [unit] `withOpencodeAcpEnv({ provider: "opencode-go", model: "m", env: { A: "1" } }, "opencode", { isolateConfig: true })` calls `_opencodeAcpEnvDeps.mkdir` once with `isolatedOpencodeConfigDir()`, returns a new def whose `env` equals `{ A: "1", OPENCODE_CONFIG_DIR: isolatedOpencodeConfigDir() }`, and leaves the input's `env` equal to `{ A: "1" }`.
7. [unit] `withOpencodeAcpEnv({ provider: "p", model: "m", env: { OPENCODE_CONFIG_DIR: "/mine" } }, "opencode", { isolateConfig: true })` returns a def whose `env.OPENCODE_CONFIG_DIR` is `"/mine"` and does not call `mkdir`.
8. [unit] When `_opencodeAcpEnvDeps.mkdir` throws, `withOpencodeAcpEnv(def, "opencode", { isolateConfig: true })` returns a def with no `OPENCODE_CONFIG_DIR` and `_opencodeAcpEnvDeps.warn` is called exactly once.
9. [unit] `withOpencodeAcpEnv(def, "claude", { isolateConfig: true })` and `withOpencodeAcpEnv(def, undefined, { isolateConfig: true })` each return `def` itself and call no `_opencodeAcpEnvDeps` function.
10. [unit] `withOpencodeAcpEnv({ provider: "p", model: "m" }, "opencode", { isolateConfig: true })` (no `env` on the input) returns a def whose `env` equals `{ OPENCODE_CONFIG_DIR: isolatedOpencodeConfigDir() }`.
11. [unit] `withOpencodeAcpEnv({ provider: "p", model: "m", env: { OPENCODE_CONFIG_DIR: "" } }, "opencode", { isolateConfig: true })` returns a def whose `env.OPENCODE_CONFIG_DIR` is `""` and does not call `mkdir` (a key the model env sets, even empty, is the operator's choice).
12. [unit] `acpEnvSettings({ agent: { acp: { codex: { isolateHome: false, fullMode: "agent-full-access" }, opencode: { isolateConfig: true } } } })` returns `{ codex: { isolateHome: false, fullMode: "agent-full-access" }, opencode: { isolateConfig: true } }`, and `acpEnvSettings(undefined)` returns both schema defaults.
13. [unit] `withAcpEnv(def, "codex", { codex: { isolateHome: false, fullMode: "workspace-write" }, opencode: { isolateConfig: true } })` returns a def whose env has `INITIAL_AGENT_MODE` `"workspace-write"` and no `OPENCODE_CONFIG_DIR`.
14. [unit] `withAcpEnv(def, "opencode", { codex: { isolateHome: true, fullMode: "agent-full-access" }, opencode: { isolateConfig: true } })` returns a def whose env has `OPENCODE_CONFIG_DIR` equal to `isolatedOpencodeConfigDir()` and neither `INITIAL_AGENT_MODE` nor `CODEX_HOME`.
15. [unit] `selectModel({ modelDef, agentName: "opencode" }, acpEnvSettings({ agent: { acp: { opencode: { isolateConfig: true } } } }))` returns a `modelDef` whose env has `OPENCODE_CONFIG_DIR` equal to `isolatedOpencodeConfigDir()`, with `_opencodeAcpEnvDeps.mkdir` stubbed.
16. [integration] `SessionManager.openSession` with `agentName: "opencode"` and a config whose `agent.acp.opencode.isolateConfig` is `true` calls the adapter's `openSession` with options whose `modelDef.env.OPENCODE_CONFIG_DIR` equals `isolatedOpencodeConfigDir()`, with `_opencodeAcpEnvDeps` stubbed.
17. [integration] `SessionManager.openSession` with `agentName: "codex"` and a config whose `agent.acp.codex.fullMode` is `"agent-full-access"` and `agent.acp.opencode.isolateConfig` is `true` calls the adapter's `openSession` with `modelDef.env.INITIAL_AGENT_MODE` `"agent-full-access"` and no `OPENCODE_CONFIG_DIR`.
18. [integration] `completeAsWithFallback` with `agentName` `"opencode"` and `input.config.agent.acp.opencode.isolateConfig` `true` calls `input.completeWithFallback` with options whose `modelDef.env.OPENCODE_CONFIG_DIR` equals `isolatedOpencodeConfigDir()`.
19. [integration] `completeAsWithFallback` with `agentName` `"opencode"`, `input.config.agent.acp.opencode.isolateConfig` `false` and `options.config.agent.acp.opencode.isolateConfig` `true` passes `modelDef.env.OPENCODE_CONFIG_DIR` equal to `isolatedOpencodeConfigDir()` (the per-call config wins).
