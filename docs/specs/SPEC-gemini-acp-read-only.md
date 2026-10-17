# SPEC: Gemini over ACP — legacy session modes and models, read-only through plan mode, optional isolated home

## Summary

Make gemini-cli usable over ACP from nax. Today nax-agent-acp selects a session's mode and model only through ACP config options (`session/set_config_option`); gemini-cli 0.64 offers none, and instead returns the ACP session `modes` and `models` blocks and accepts `session/set_mode` and `session/set_model`. So every gemini session that names a model is refused, and the read-only profiles cannot be enforced. This spec adds a fallback to the session `modes`/`models` blocks when no config option offers the value, gives the `gemini` registry entry read-only enforcement through gemini's own `plan` mode for profiles `none`, `read` and `review`, and adds `agent.acp.gemini.isolateHome` (default off) to run gemini on a nax-owned home that carries over only the user's credentials and auth type.

This is the gemini slice of nathapp-io/nax#2372; pi stays open on that issue.

## Motivation

Live probe against gemini-cli 0.64.0 (free-tier `GEMINI_API_KEY`, 2026-10-17):

- `session/new` returns `{ sessionId, modes, models }` and no `configOptions`. `modes.availableModes` lists `default`, `autoEdit`, `yolo`, `plan`; `models.availableModels` lists model ids (`auto`, `gemini-3-flash-preview`, …) with `currentModelId` `auto`.
- `session/set_mode { sessionId, modeId: "plan" }` and `session/set_model { sessionId, modelId }` both answer `{}`. (`@agentclientprotocol/sdk` 1.7.0 types `session/set_mode` as `methods.agent.session.setMode`; it does not type `session/set_model` or the `models` block, but its `request(method: string, params)` overload sends any method.)
- Through nax-agent-acp today: an open with no model succeeds; an open with `model: "gemini-3-flash-preview"` is refused with `AGENT_SESSION_CAPABILITY_UNSUPPORTED`, capability `model` ("offers no model option … offered: (none)"); an open with profile `read` is refused with capability `profile`.
- In `default` mode a write (`kind: "edit"`) and a shell command (`kind: "execute"`) each arrive as `session/request_permission` with options `proceed_always` (allow_always), `proceed_once` (allow_once), `cancel` (reject_once). Answering `cancel` fails only that tool call; the model continues and the turn ends `end_turn`.
- In `plan` mode the model read the file and nothing else; when told to write and run a shell command anyway, the write failed inside gemini without any permission request and no shell tool was offered. Nothing was written. gemini's `plan.toml` policy denies every tool by default (priority 40), re-allows read-only tools, and its write tools resolve every path into gemini's own plans directory under `~/.gemini/tmp/…`, never the repository.
- `GEMINI_CLI_HOME=<dir>` replaces the home gemini resolves (`<dir>/.gemini` is its config dir). With an empty `<dir>` and `GEMINI_API_KEY` in the environment, gemini authenticated and ran in `plan` mode.

gemini's user-scoped policy tiers (saved "Always Allow" rules in `~/.gemini/policies/auto-saved.toml`, user policies, installed extensions) outrank `plan.toml`'s default-tier deny, so a user's own approvals can loosen a nax read-only session. An isolated home removes them; the user wants that optional.

User rulings (2026-10-17): support the session `modes`/`models` fallback in this slice; read-only = gemini `plan` mode (`review` accepted as plan mode: gemini runs no shell command under it); `agent.acp.gemini.isolateHome` default off, carrying the user's `oauth_creds.json`, `gemini-credentials.json` and `security.auth.selectedType` so both API-key and Google-login users keep working.

## Design

### Integration

Symbols this feature only reads:

- `modeFor(profile, entry)` in `packages/nax-agent-acp/src/client/capabilities.ts`: `none`/`read`/`review` → `entry.readOnly.mode`, other profiles → `entry.defaultMode`.
- `offersValue(options, configId, value)`, `modelOptionId(options, model)` and `selectValues(option)` in `capabilities.ts`.
- `unmetRequirement(record, req)` refuses a read-only profile when `record.readOnlyMode` is false; `buildCapabilityRecord(init, entry)` sets `readOnlyMode` to `entry?.readOnly !== undefined`.
- `routerFor` / `sandboxFor` give the permission layer a sandbox only when `entry?.preApproval` is defined; gemini has none.
- `codexAcpSettings`, `withCodexAcpEnv` (`packages/nax/src/agents/shared/codex-acp-env.ts`) and `opencodeAcpSettings`, `withOpencodeAcpEnv` (`opencode-acp-env.ts`); unchanged.
- `globalConfigDir()` in `packages/nax/src/config/paths/index.ts`.

Symbols this feature changes. Each **Baseline** exists only to locate the code; it is never the interface to implement. Implement the **Target**.

- `AcpLink` (`packages/nax-agent-acp/src/client/connection.ts`)
  - Baseline: `initialize`, `newSession`, `resumeSession`, `loadSession`, `setConfigOption`, `prompt`, `cancel`, `closeSession`, `closed`, `close`.
  - Target: adds `setMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse>` (sent as `methods.agent.session.setMode`) and `setModel(params: { readonly sessionId: string; readonly modelId: string }): Promise<unknown>` (sent as the method string `SET_MODEL_METHOD = "session/set_model"` through the SDK's `request(method: string, params)` overload).
- New module `packages/nax-agent-acp/src/client/session-offers.ts`:
  - `export interface SessionOffers { readonly configOptions: readonly SessionConfigOption[]; readonly modeIds: readonly string[]; readonly modelIds: readonly string[] }`
  - `export function sessionOffers(response: unknown): SessionOffers` — reads `configOptions` (as today: the array when present, else `[]`), `modes.availableModes[].id` and `models.availableModels[].modelId` from an untyped `session/new`, `session/resume` or `session/load` response. Entries that are not non-empty strings are skipped; a missing or malformed block yields `[]`.
- `newSession` (`open.ts`) and `checkRestored` (`resume.ts`)
  - Baseline: each returns an object with `configOptions: readonly SessionConfigOption[]` (resume: `[]` for a null answer).
  - Target: each returns `offers: SessionOffers` built with `sessionOffers(response)` (a null restore answer yields empty offers) in place of `configOptions`.
- `applyConfig`, `applyMode`, `applyModel`, `applyEffort` (`open.ts`)
  - Baseline: thread `offered: readonly SessionConfigOption[]`; `applyMode` refuses with capability `profile` ("the agent does not offer <configId> \"<value>\"") when no config option offers the mode; `applyModel` refuses with capability `model` when `modelOptionId` finds none, listing `offeredModels(offered, secrets)`.
  - Target: thread `SessionOffers`. `applyMode`: the config-option path is tried first, unchanged; otherwise, when `offers.modeIds` includes `mode.value`, it sends `session/set_mode { sessionId, modeId: mode.value }` (the `configId` is not used on this path); otherwise the same refusal as today. `applyModel`: the config-option path first, unchanged; otherwise, when `offers.modelIds` includes the model, it sends `session/set_model { sessionId, modelId }`; otherwise the refusal, whose offered list is the config-option model values followed by `offers.modelIds`, each id cleaned as today and the combined list capped at the existing `MAX_OFFERED_MODELS` (50) entries. `applyEffort` keeps working on `offers.configOptions` only.
- Registry entry `gemini` (`packages/nax-agent-acp/src/client/registry.ts`)
  - Baseline: `entry("gemini", [local("gemini", "--acp")], ["GEMINI_API_KEY"])`; `readOnly`, `defaultMode`, `preApproval` undefined.
  - Target: same launch and auth env; `readOnly: { mode: { configId: "mode", value: "plan" }, disallowedTools: [], sessionOptions: {}, launchEnv: {} }`; `defaultMode` and `preApproval` undefined.
- `AgentAcpConfigSchema` (`packages/nax/src/config/schemas-infra.ts`)
  - Baseline: `promptRetries`, `trackedSpawnDeadlineMs`, `trackedSpawnStartupDeadlineMs`, `codex`, `opencode`; the file is 591 of its 600-line limit.
  - Target: adds `gemini: AgentGeminiAcpConfigSchema`, imported from a new module `packages/nax/src/config/schemas-acp-agents.ts` that exports `DEFAULT_AGENT_GEMINI_ACP_CONFIG = { isolateHome: false }` and `AgentGeminiAcpConfigSchema = z.object({ isolateHome: z.boolean().default(false) }).default({ ...DEFAULT_AGENT_GEMINI_ACP_CONFIG })`. Both literal `agent.acp` defaults gain `gemini: { ...DEFAULT_AGENT_GEMINI_ACP_CONFIG }`: the outer `acp: AgentAcpConfigSchema.default({...})` in `schemas-infra.ts` and the `acp` object in `schemas.ts`. `DEFAULT_AGENT_GEMINI_ACP_CONFIG` is re-exported from the `src/config/index.ts` barrel, and the `AgentAcpConfig` interface in `src/config/runtime-types-agent.ts` gains `gemini?: { isolateHome?: boolean }`. `schemas-infra.ts` grows by at most 4 lines.
- `AcpEnvSettings`, `acpEnvSettings`, `withAcpEnv` (`packages/nax/src/agents/shared/acp-env.ts`)
  - Baseline: `{ codex, opencode }`; `withAcpEnv` applies codex then opencode.
  - Target: `{ codex, opencode, gemini: GeminiAcpSettings }`; `acpEnvSettings` adds `gemini: geminiAcpSettings(config)`; `withAcpEnv` applies codex, then opencode, then `withGeminiAcpEnv`.

### New module `packages/nax/src/agents/shared/gemini-acp-env.ts`

Under `src/agents/shared/` because `src/agents/acp/` may not import config. Worked skeleton:

```typescript
export interface GeminiAcpSettings {
  readonly isolateHome: boolean;
}
/** Settings from config.agent.acp.gemini; schema defaults when the config or any level is undefined. */
export function geminiAcpSettings(config: Pick<NaxConfig, "agent"> | undefined): GeminiAcpSettings;
/** <globalConfigDir()>/acp/gemini-home — the value GEMINI_CLI_HOME is set to (gemini reads <home>/.gemini). */
export function isolatedGeminiHomeDir(): string;
/**
 * mkdir <isolated>/.gemini (recursive). Source dir = <env GEMINI_CLI_HOME when non-empty, else homedir()>/.gemini.
 * For each of GEMINI_SHARED_FILES (["oauth_creds.json", "gemini-credentials.json"]): symlink
 * <isolated>/.gemini/<file> -> <source>/<file> when the source file exists and the isolated entry does not
 * (lstat semantics: a dangling link counts as an entry and is never replaced).
 * settings.json: when <source>/settings.json parses as a JSON object whose security.auth.selectedType is a
 * non-empty string, write <isolated>/.gemini/settings.json = {"security":{"auth":{"selectedType":<it>}}}
 * (rewritten on every call); otherwise write nothing (a parse failure logs one warn).
 * Nothing else is created. Returns the isolated home. Throws on a filesystem failure.
 */
export function prepareIsolatedGeminiHome(): string;
/**
 * For agentName "gemini" with settings.isolateHome true and no GEMINI_CLI_HOME in def.env: a NEW def whose
 * env adds GEMINI_CLI_HOME = prepareIsolatedGeminiHome(). Otherwise the input itself. Never mutates the input.
 * When prepareIsolatedGeminiHome throws: one warn, the input itself is returned.
 */
export function withGeminiAcpEnv<T extends { env?: Record<string, string> }>(
  def: T,
  agentName: string | undefined,
  settings: GeminiAcpSettings,
): T;
/** Test seam: every filesystem, environment and logger touch. */
export const _geminiAcpEnvDeps: {
  mkdir: (path: string) => void; // recursive
  entryExists: (path: string) => boolean; // lstat
  fileExists: (path: string) => boolean; // stat, regular file
  symlink: (target: string, path: string) => void;
  readText: (path: string) => string | undefined; // undefined when absent
  writeText: (path: string, text: string) => void;
  env: (name: string) => string | undefined;
  homedir: () => string;
  warn: (message: string, data: Record<string, unknown>) => void;
};
```

gemini's file keychain (`gemini-credentials.json`) derives its key from hostname and username, not the file's path, so a symlinked copy decrypts in the isolated home (source: gemini-cli `fileKeychain.ts`; not live-verified: the probe account stores its key only in the environment).

### Failure Handling

| Situation | Behaviour |
|:---|:---|
| A config option offers the mode or model | The config-option path is used, exactly as today; the session `modes`/`models` blocks are not consulted. |
| Neither a config option nor the session `modes` block offers the read-only mode | Existing refusal: `AGENT_SESSION_CAPABILITY_UNSUPPORTED`, capability `profile`, process killed. |
| Neither a config option nor the session `models` block offers the requested model | Existing refusal: capability `model`; the offered list now includes the `models` block's ids. |
| The agent answers `session/set_mode` or `session/set_model` with a JSON-RPC error | The open fails as any other failed open step does today (the step's error, process killed). |
| gemini asks permission for a write or shell command (possible only outside `plan` mode, e.g. `full`) | Decided by profile as today (`full` allows); gemini continues after a reject. |
| `isolateHome` true and the isolated home cannot be prepared | One `warn`; no `GEMINI_CLI_HOME` is set, so the session runs on the user's gemini home (fail open, the "not too tight" ruling). |
| `isolateHome` true and the user's settings.json is unparseable | One `warn`; no isolated settings.json is written; gemini falls back to its own auth default (API key from `GEMINI_API_KEY`). |
| Model env already sets `GEMINI_CLI_HOME` | The model env value is kept; nax prepares nothing. |

## Out of Scope

- Read-only enforcement for pi (the rest of nathapp-io/nax#2372); this spec does not close that issue.
- Applying nax's embedder sandbox to gemini, or letting a gemini reviewer run shell commands: under `review` gemini runs in `plan` mode, which offers no shell tool (accepted 2026-10-17).
- gemini's `plan` mode writing plan `.md` files into its own plans directory under the gemini home (`.gemini/tmp/…/plans`); those writes never reach the repository and nax does not block them.
- gemini's model routing when no model is set: with `auto` it may route `plan`-mode turns to a Pro model, which costs more free-tier quota; nax sets no model unless configured.
- Reasoning effort on gemini: it offers no effort config option, so a configured effort is skipped as for any agent that does not offer one.
- Copying or translating any other part of the user's gemini home (settings beyond `security.auth.selectedType`, policies, extensions, MCP servers, skills, history) into the isolated home.
- Keeping the isolated `settings.json` in step when the user's settings file later loses `selectedType`; a previously written isolated settings file is left in place.
- gemini workspace policies (`<repo>/.gemini/policies`): gemini 0.64 disables them by default, and nax neither enables nor checks them.
- System or admin gemini settings and policies (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`, the system policies directory); nax does not touch them.
- A gemini release that renames `session/set_model`, changes the `models` block shape, or moves auth files; nax does not detect it.
- Symlink support on Windows.
- Updating the package context file `.nax/mono/packages/nax-agent-acp/context.md` to say gemini is read-only capable: a manual step after merge, since `.nax/` is read-only to the run.
- A live check against a real gemini process: a maintainer step after merge (Google-login and stored-key isolation can only be checked with such an account).

## Stories

### US-001: session modes/models fallback; gemini read-only through plan mode

Workdir: `packages/nax-agent-acp`. No dependencies.

Add `setMode` and `setModel` to `AcpLink`, create `src/client/session-offers.ts` (`SessionOffers`, `sessionOffers`), make `newSession` and `checkRestored` return `offers`, and thread `SessionOffers` through `applyConfig` so `applyMode` and `applyModel` fall back to `session/set_mode` / `session/set_model` when no config option offers the value. Give the `gemini` registry entry its `readOnly` enforcement (mode `plan`). Extend the fake agent so a script can return `modes` and `models` blocks from `session/new` and restore answers and records `session/set_mode` and `session/set_model`, with exported `GEMINI_SESSION_MODES` and `GEMINI_SESSION_MODELS` fixtures; put this story's integration tests in a new `test/unit/client/backend-gemini.test.ts`. Claude, codex and opencode behaviour does not change.

### US-002: optional isolated gemini home in nax

Workdir: `packages/nax`. No dependencies.

Create `src/config/schemas-acp-agents.ts` (`DEFAULT_AGENT_GEMINI_ACP_CONFIG`, `AgentGeminiAcpConfigSchema`) and add `agent.acp.gemini` to `AgentAcpConfigSchema`, both literal `acp` defaults, the config barrel and the `AgentAcpConfig` interface. Create `src/agents/shared/gemini-acp-env.ts` (`GeminiAcpSettings`, `geminiAcpSettings`, `isolatedGeminiHomeDir`, `prepareIsolatedGeminiHome`, `withGeminiAcpEnv`, `_geminiAcpEnvDeps`) and add gemini to `AcpEnvSettings`, `acpEnvSettings` and `withAcpEnv`, so `SessionManager.openSession` and `completeAsWithFallback` (which already go through `withAcpEnv`) inject `GEMINI_CLI_HOME`. Update the `profile-map.ts` header comment that lists gemini among agents without `read`. Document `agent.acp.gemini.isolateHome` in `docs/guides/configuration.md` beside `agent.acp.opencode.isolateConfig`: it points `GEMINI_CLI_HOME` at `~/.nax/acp/gemini-home`, which links only `oauth_creds.json` and `gemini-credentials.json` and carries only `security.auth.selectedType`, so the user's saved approvals, policies, extensions and MCP servers stay out; default `false`.

### Context Files

**US-001**

- `packages/nax-agent-acp/src/client/open.ts` — `newSession`, `applyConfig`, `applyMode`, `applyModel`, `applyEffort`, `offeredModels`
- `packages/nax-agent-acp/src/client/resume.ts` — `checkRestored`, `RestoredSession`
- `packages/nax-agent-acp/src/client/connection.ts` — `AcpLink`, `openConnection`
- `packages/nax-agent-acp/test/fixtures/fake-agent/agent.ts` — `buildFakeAgent`, `restoredResponse`, the custom-method `onRequest(method, parser, handler)` overload
- `packages/nax-agent-acp/test/unit/client/backend-opencode.test.ts` — the `inMemoryAgent` + `createAgentSession` pattern for a non-Claude agent

**US-002**

- `packages/nax/src/agents/shared/codex-acp-env.ts` — the precedent module (isolated home, symlinks with lstat/stat split, deps seam)
- `packages/nax/src/agents/shared/acp-env.ts` — `AcpEnvSettings`, `acpEnvSettings`, `withAcpEnv`
- `packages/nax/src/config/schemas-infra.ts` — `AgentAcpConfigSchema`, `DEFAULT_AGENT_OPENCODE_ACP_CONFIG`, the outer `acp` default literal
- `packages/nax/test/helpers/opencode-acp-deps.ts` — how existing tests stub an env module's deps seam
- `packages/nax/test/unit/agents/shared/acp-env.test.ts` — the `acpEnvSettings` / `withAcpEnv` test pattern

### Creates

**US-001**

- `packages/nax-agent-acp/src/client/session-offers.ts`
- `packages/nax-agent-acp/test/unit/client/session-offers.test.ts`
- `packages/nax-agent-acp/test/unit/client/backend-gemini.test.ts`

**US-002**

- `packages/nax/src/config/schemas-acp-agents.ts`
- `packages/nax/src/agents/shared/gemini-acp-env.ts`
- `packages/nax/test/unit/agents/shared/gemini-acp-env.test.ts`

### Modifies

**US-001**
- `packages/nax-agent-acp/src/client/connection.ts` — `AcpLink` gains `setMode` and `setModel`; `openConnection` implements them; exports `SET_MODEL_METHOD`.
- `packages/nax-agent-acp/src/client/open.ts` — `newSession` returns `offers`; `applyConfig`, `applyMode`, `applyModel` and `applyEffort` take `SessionOffers`; `applyMode` and `applyModel` gain the session/set_mode / session/set_model fallback.
- `packages/nax-agent-acp/src/client/resume.ts` — `RestoredSession` carries `offers: SessionOffers` (built with `sessionOffers`) in place of `configOptions`.
- `packages/nax-agent-acp/src/client/registry.ts` — the gemini entry gets `readOnly` with mode `plan`.
- `packages/nax-agent-acp/test/fixtures/fake-agent/script.ts` — `FakeScript` gains optional `modes` and `models` blocks returned by session/new, session/resume and session/load, typed as plain records so the untyped `models` block passes through, and optional `setModeFailure` and `setModelFailure` (each an `RpcFailure`, like `newSessionFailure`); exports `GEMINI_SESSION_MODES` (available `default`, `autoEdit`, `yolo`, `plan`; current `default`) and `GEMINI_SESSION_MODELS` (available `auto`, `gemini-3-flash-preview`; current `auto`); no existing export changes.
- `packages/nax-agent-acp/test/fixtures/fake-agent/agent.ts` — returns the script's `modes`/`models` blocks from session/new and `restoredResponse`, and handles session/set_mode and session/set_model by recording their params and answering `{}`, or throwing the script's `setModeFailure` / `setModelFailure` as a JSON-RPC error when set; the `models` block is returned through a widened object, since the SDK's session/new response type has no `models` field.
- `packages/nax-agent-acp/test/unit/client/registry.test.ts` — the table test "%s: launch candidates and auth env; no read-only enforcement, no pre-approval" lists gemini with `readOnly: undefined`, so gemini moves out of that table into its own test asserting the new `readOnly` (pi stays).
- `packages/nax-agent-acp/test/unit/client/capabilities.test.ts` — the test asserting `readOnlyFor("none", registryEntry("gemini"))` is undefined switches to `registryEntry("pi")`, keeping the invariant that an agent without enforcement yields undefined.
- `packages/nax-agent-acp/test/unit/client/backend-permissions.test.ts` — the test "%s on an agent without a read-only mode: refused after initialize" opens `agent: "gemini"`; it switches to `agent: "pi"`, keeping the invariant that `read`/`none` on an agent without read-only enforcement is refused after `initialize` with capability `profile`.
- `packages/nax-agent-acp/test/unit/client/resume.test.ts` — the `checkRestored` tests assert the result's `configOptions` field (the exact-object test for a resumed id, the load test returning the offered options, and the null-answer test); they assert `offers` instead: `{ configOptions: <same>, modeIds: [], modelIds: [] }`, keeping the same invariants.

**US-002**
- `packages/nax/src/config/schemas-infra.ts` — imports `AgentGeminiAcpConfigSchema` and `DEFAULT_AGENT_GEMINI_ACP_CONFIG` from the new schemas-acp-agents module, adds `gemini` to `AgentAcpConfigSchema` and to the outer `acp: AgentAcpConfigSchema.default({...})` literal; grows by at most 4 lines (limit 600).
- `packages/nax/src/config/schemas.ts` — adds `gemini: { ...DEFAULT_AGENT_GEMINI_ACP_CONFIG }` to the literal `acp` default object.
- `packages/nax/src/config/index.ts` — re-exports `DEFAULT_AGENT_GEMINI_ACP_CONFIG` from the barrel beside `DEFAULT_AGENT_OPENCODE_ACP_CONFIG`.
- `packages/nax/src/config/runtime-types-agent.ts` — adds the optional `gemini` block to the `AgentAcpConfig` interface.
- `packages/nax/src/agents/shared/acp-env.ts` — `AcpEnvSettings` gains `gemini`; `acpEnvSettings` and `withAcpEnv` include it.
- `packages/nax/src/agents/acp/profile-map.ts` — header comment only: gemini is removed from the list of agents refused `read` until #2372.
- `packages/nax/test/unit/config/agent-schema.test.ts` — the test "agent.acp has no transport key after S4b-5" pins the exact `agent.acp` default; its expected object gains `gemini: { isolateHome: false }`. US-002's schema acceptance tests are added to this file.
- `packages/nax/test/unit/agents/shared/acp-env.test.ts` — the tests asserting the exact `acpEnvSettings(...)` result gain `gemini: { isolateHome: false }` (or the configured value) in their expected objects, and the `withAcpEnv` tests that pass a literal settings object add `gemini: { isolateHome: false }` to it, keeping their expected results. US-002's `acpEnvSettings` / `withAcpEnv` acceptance tests are added to this file.
- `packages/nax/test/unit/session/model-selection.test.ts` — tests that pass a literal settings object to `selectModel` add `gemini: { isolateHome: false }` to it and keep their expected results.
- `packages/nax/test/unit/session/manager-phase-b-session.test.ts` — US-002's `SessionManager.openSession` acceptance test for gemini is added to this file; no existing test in it changes.
- `docs/guides/configuration.md` — documents `agent.acp.gemini.isolateHome` beside `agent.acp.opencode.isolateConfig`.

### Seams

- US-001: `sessionOffers` (new export of `session-offers.ts`) is consumed by `newSession` and `checkRestored` in the same story; its seam ACs enter at `createAgentSession` with `acpBackend({ agent: "gemini" })` against a fake that returns `modes`/`models` blocks and assert on the recorded `session/set_mode` / `session/set_model` calls.
- US-002: `geminiAcpSettings` and `withGeminiAcpEnv` (new exports of `gemini-acp-env.ts`) are consumed by `acpEnvSettings` and `withAcpEnv`; the seam AC enters at `SessionManager.openSession`, above the config read.

## Acceptance Criteria

### US-001

1. [unit] `sessionOffers({ sessionId: "s", modes: { availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }], currentModeId: "default" }, models: { availableModels: [{ modelId: "auto", name: "Auto" }, { modelId: "m2", name: "M2" }], currentModelId: "auto" } })` returns `{ configOptions: [], modeIds: ["default", "plan"], modelIds: ["auto", "m2"] }`.
2. [unit] `sessionOffers` returns the response's `configOptions` array when present, and `sessionOffers(null)`, `sessionOffers({})` and `sessionOffers({ modes: "x", models: { availableModels: [{ modelId: 3 }, { modelId: "" }, {}] } })` each return empty `configOptions`, `modeIds` and `modelIds`.
3. [unit] `registryEntry("gemini")?.readOnly` equals `{ mode: { configId: "mode", value: "plan" }, disallowedTools: [], sessionOptions: {}, launchEnv: {} }`, and `registryEntry("gemini")?.defaultMode` and `registryEntry("gemini")?.preApproval` are both `undefined`.
4. [unit] `modeFor("read", registryEntry("gemini"))`, `modeFor("none", registryEntry("gemini"))` and `modeFor("review", registryEntry("gemini"))` each equal `{ configId: "mode", value: "plan" }`, and `modeFor("full", registryEntry("gemini"))` is `undefined`.
5. [unit] `unmetRequirement(buildCapabilityRecord(init, registryEntry("gemini")), { profile: "read", toolCount: 0, resume: false })` is `undefined`, where `init` is an `initialize` response with no MCP capabilities; the same check with `profile: "review"` is `undefined`.
6. [integration] `createAgentSession` with `acpBackend({ agent: "gemini", ... })`, profile `read` and a fake agent whose script sets `modes: GEMINI_SESSION_MODES` and no `configOptions` opens, and the fake records exactly one `session/set_mode` call with `sessionId` `"fake-session-1"` and `modeId` `"plan"`, and no `session/set_config_option` call.
7. [integration] The same gemini open with profile `review` and with profile `none` each record one `session/set_mode` call with `modeId` `"plan"`.
8. [integration] A gemini open with profile `full` against the same fake records no `session/set_mode` call.
9. [integration] A gemini open with profile `read` against a fake whose `modes` block has no `plan` mode is refused with `AGENT_SESSION_CAPABILITY_UNSUPPORTED`, capability `profile`, and the agent process is killed once.
10. [integration] A gemini open with `model: "gemini-3-flash-preview"` and profile `full` against a fake whose script sets `models: GEMINI_SESSION_MODELS` and no `configOptions` opens, and the fake records exactly one `session/set_model` call with `modelId` `"gemini-3-flash-preview"`.
11. [integration] A gemini open with `model: "gemini-9"` and profile `full` against the same fake is refused with capability `model`, and the refusal's offered list contains `"auto"` and `"gemini-3-flash-preview"`.
12. [integration] A Claude open with profile `read` and `model: "sonnet"` against a fake offering `CLAUDE_CONFIG_OPTIONS` and also a `modes` block containing `default` records the mode and the model through `session/set_config_option` only, and no `session/set_mode` or `session/set_model` call (config options win).
13. [integration] A codex open with profile `read` against a fake offering `CODEX_CONFIG_OPTIONS` still records one `session/set_config_option` call with `value` `"read-only"` and no `session/set_mode` call (regression anchor: already true on main).
14. [integration] A gemini session restored with profile `read` (script with `modes: GEMINI_SESSION_MODES`) records one `session/set_mode` call with `modeId` `"plan"` after the restore, both when the fake advertises only `loadSession` (restored through `session/load`) and when it advertises session resume (restored through `session/resume`).
15. [integration] A gemini open with profile `read` whose fake script sets `setModeFailure` (so `session/set_mode` answers a JSON-RPC error) fails to open, and the agent process is killed once; the same holds for `model: "gemini-3-flash-preview"`, profile `full`, `models: GEMINI_SESSION_MODELS` and `setModelFailure` set.
16. [integration] A gemini open with `model: "gemini-9"` and profile `full` against a fake whose `models` block lists 60 model ids and no `configOptions` is refused with capability `model`, and the refusal's offered list has exactly 50 entries, starting with the fake's first model id.
17. [integration] In a gemini session opened with profile `full`, a `session/request_permission` for an `execute` tool call is answered with the `allow_once` option and recorded with reason `FULL_REASON`.
18. [integration] A gemini open with profile `read` and one embedder tool is refused with `AGENT_SESSION_CAPABILITY_UNSUPPORTED`, capability `tools`.

### US-002

1. [unit] Parsing a config with `agent.acp` unset yields `agent.acp.gemini` equal to `{ isolateHome: false }`, and `agent.acp.codex` and `agent.acp.opencode` keep their defaults.
2. [unit] Parsing a config with `agent.acp.gemini.isolateHome: "yes"` fails validation with an issue whose path ends in `isolateHome`.
3. [unit] `geminiAcpSettings(undefined)` and `geminiAcpSettings({})` return `{ isolateHome: false }`, and `geminiAcpSettings({ agent: { acp: { gemini: { isolateHome: true } } } })` returns `{ isolateHome: true }`.
4. [unit] `isolatedGeminiHomeDir()` returns `join(globalConfigDir(), "acp", "gemini-home")`.
5. [unit] With `_geminiAcpEnvDeps` stubbed so `env("GEMINI_CLI_HOME")` is undefined, `homedir()` is `"/u"`, `fileExists` is true for `/u/.gemini/oauth_creds.json` and `/u/.gemini/gemini-credentials.json`, `entryExists` is false for both isolated entries, and `readText("/u/.gemini/settings.json")` returns `'{"security":{"auth":{"selectedType":"oauth-personal"}},"mcpServers":{"x":{}}}'`, `prepareIsolatedGeminiHome()` calls `mkdir` with `<isolated>/.gemini`, calls `symlink("/u/.gemini/oauth_creds.json", <isolated>/.gemini/oauth_creds.json)` and `symlink("/u/.gemini/gemini-credentials.json", <isolated>/.gemini/gemini-credentials.json)`, writes `<isolated>/.gemini/settings.json` with exactly `{"security":{"auth":{"selectedType":"oauth-personal"}}}`, and returns `isolatedGeminiHomeDir()`.
6. [unit] With `env("GEMINI_CLI_HOME")` returning `"/custom"` and that home's `.gemini/oauth_creds.json` present, the `symlink` target is `"/custom/.gemini/oauth_creds.json"`; with `env("GEMINI_CLI_HOME")` returning `""`, the source is `<homedir()>/.gemini`.
7. [unit] When `entryExists` is true for an isolated credentials entry (including a dangling link), `prepareIsolatedGeminiHome()` does not call `symlink` for it; when `fileExists` is false for a source credentials file, it does not call `symlink` for it.
8. [unit] When `readText` for the source settings returns `undefined`, JSON without `security.auth.selectedType`, or JSON whose `selectedType` is a number or an empty string, or JSON that is an array or `null`, `prepareIsolatedGeminiHome()` writes no settings file and logs no warn; when it returns text that is not JSON, it writes no settings file and calls `warn` exactly once.
9. [unit] When the isolated `settings.json` already exists (`entryExists` true) and the source settings carry `selectedType` `"gemini-api-key"`, `prepareIsolatedGeminiHome()` still writes the isolated settings file with exactly `{"security":{"auth":{"selectedType":"gemini-api-key"}}}` (rewritten on every call).
10. [unit] `withGeminiAcpEnv({ provider: "gemini", model: "m", env: { A: "1" } }, "gemini", { isolateHome: true })` returns a new def whose `env` equals `{ A: "1", GEMINI_CLI_HOME: isolatedGeminiHomeDir() }` and leaves the input's `env` equal to `{ A: "1" }`.
11. [unit] `withGeminiAcpEnv(def, "gemini", { isolateHome: false })`, `withGeminiAcpEnv(def, "claude", { isolateHome: true })` and `withGeminiAcpEnv(def, undefined, { isolateHome: true })` each return `def` itself and call no `_geminiAcpEnvDeps` function.
12. [unit] `withGeminiAcpEnv({ provider: "p", model: "m" }, "gemini", { isolateHome: true })` (no `env` on the input) returns a def whose `env` equals `{ GEMINI_CLI_HOME: isolatedGeminiHomeDir() }`.
13. [unit] `withGeminiAcpEnv({ provider: "p", model: "m", env: { GEMINI_CLI_HOME: "/mine" } }, "gemini", { isolateHome: true })` returns a def whose `env.GEMINI_CLI_HOME` is `"/mine"` and calls no `_geminiAcpEnvDeps` filesystem function; the same holds for an empty-string `GEMINI_CLI_HOME`.
14. [unit] When `_geminiAcpEnvDeps.mkdir` throws, `withGeminiAcpEnv(def, "gemini", { isolateHome: true })` returns `def` itself and `_geminiAcpEnvDeps.warn` is called exactly once.
15. [unit] `acpEnvSettings({ agent: { acp: { gemini: { isolateHome: true } } } }).gemini` equals `{ isolateHome: true }`, and `acpEnvSettings(undefined).gemini` equals `{ isolateHome: false }`.
16. [unit] `withAcpEnv(def, "gemini", { codex: { isolateHome: true, fullMode: "agent-full-access" }, opencode: { isolateConfig: true }, gemini: { isolateHome: true } })` returns a def whose env has `GEMINI_CLI_HOME` equal to `isolatedGeminiHomeDir()` and none of `INITIAL_AGENT_MODE`, `CODEX_HOME` or `OPENCODE_CONFIG_DIR`.
17. [unit] `withAcpEnv(def, "codex", { codex: { isolateHome: false, fullMode: "workspace-write" }, opencode: { isolateConfig: false }, gemini: { isolateHome: true } })` returns a def whose env has `INITIAL_AGENT_MODE` `"workspace-write"` and no `GEMINI_CLI_HOME`.
18. [integration] `SessionManager.openSession` with `agentName: "gemini"` and a config whose `agent.acp.gemini.isolateHome` is `true` calls the adapter's `openSession` with options whose `modelDef.env.GEMINI_CLI_HOME` equals `isolatedGeminiHomeDir()`, with `_geminiAcpEnvDeps` stubbed.
