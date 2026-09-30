# SPEC: Machine-readable `nax auth list` and profile-chain `nax config`

## Summary

Add `--json` to `nax auth list` and add `--profile <chain>` plus `--json` to `nax config`. `nax auth list --json` prints one JSON object describing the credential source and, per provider, the stored entry, the exec helper's verdict, whether an ambient source (such as an environment variable) supplies a credential, and whether nax can authenticate that provider at all. `nax config --profile <chain> --json` resolves an explicit profile chain against the project root the way `nax run` does and prints the masked resolved config together with a `requirements` block: the default agent, its transport, the `agent.protocol` gate, the providers its native tier map needs, and whether it needs the OS sandbox. The provider derivation moves out of the native-credentials precheck into one shared helper so the precheck and `nax config --json` cannot disagree.

## Motivation

An external orchestrator that dispatches `nax run --profile <chain>` onto several machines has to decide, before it dispatches, whether a machine can run that chain: does the machine hold a credential for every provider the chain's model tiers use, and does the chain need the sandbox. Today it cannot ask nax either question in a parseable form.

- `nax auth list` prints coloured, human-formatted rows (`src/cli/auth.ts:230-280`). Since the credential-sources feature (#2295) a row can say `exec (<account>)`, `file (declined)` or `error: <CODE>`, and none of it is machine-readable.
- `nax config` has no `--profile` option, so no command resolves a profile chain. `nax config profile show <name>` prints one unmerged profile file (`src/cli/config-profile.ts`).
- Which providers a config needs is decided by a private helper, `providerTiers()` in `src/precheck/checks-native-credentials.ts:49`. A caller outside nax would have to copy its rules (default agent must be `native`; walk `models.native`; provider is the id prefix before `/`; skip `agent.native.catalogOverrides` providers) and would drift whenever nax changes them.

## Design

### Approach

Both commands keep their text output. Each gains a JSON mode that renders the same collected data, so text and JSON cannot report different facts:

- `nax auth list`: a new `collectAuthList(providerIds)` gathers an `AuthListReport`; `renderAuthListText(report)` produces today's lines and `renderAuthListJson(report)` produces the JSON document. `authListCommand` picks the renderer.
- `nax config`: a new `buildConfigRequirements(config)` (`src/cli/config-requirements.ts`) derives the `requirements` block, and a new `configJsonCommand(options)` (`src/cli/config-json.ts`) loads the config with the profile chain as a CLI override, from the project's `.nax` directory when `findProjectDir(dir)` finds one and from `dir` otherwise (`loadConfig(findProjectDir(dir) ?? dir, { profile: chain })`, the call shape `nax run` uses), builds a `ConfigJsonReport`, and prints it.
- `nativeTierProviders(config)` is extracted from the precheck into `src/agents/native/tier-providers.ts`, exported from the `@/agents/native` barrel, and used by both `findMissingNativeCredentials` and `buildConfigRequirements`.

JSON documents are printed with `JSON.stringify(value, null, 2)` as a single `log` call, and carry no ANSI colour codes. In JSON mode stdout carries only that document.

### CLI behaviour

`nax auth list [provider...] [--json]`

- Without `--json`: a successful listing prints exactly today's lines, and every existing `nax auth list` test keeps passing. One error path changes: when the credentials file is unreadable, today's header line `Credential source: …` is no longer printed before the red error, because the collector fails before anything is rendered.
- With `--json`: prints one `AuthListReport` and exits 0, including when the helper fails for some provider (that provider's `exec.status` is `"error"`). With no stored provider and no argument it prints `"providers": []` rather than the text hint.
- On a failure that aborts the listing it prints `{"error":{"code":"<CODE>","message":"<message>"}}` and exits 1.

`nax config [-d <dir>] [--profile <name>]... [--explain | --diff | --json]`

- `--profile <name>` is registered with the same `collectProfile` collector as `nax run` (repeatable, comma-separated, later overrides earlier). A non-empty chain is passed as `{ profile: chain }` to `loadConfig(findProjectDir(dir) ?? dir, …)`; an empty chain leaves `loadConfig`'s own resolution (`NAX_PROFILE`, project, global) in charge.
- `--profile` applies to the default view, `--explain` and `--json`. `--diff` compares the raw global and project files and cannot take a chain: `configCommand` rejects `diff` together with a non-empty `profile` the same way it rejects `explain` with `diff` (`console.error` then `process.exit(1)`).
- `--json` prints one `ConfigJsonReport` and exits 0. It is mutually exclusive with `--explain` and `--diff`: the combination prints the error document with code `CONFIG_FLAGS_CONFLICT` and exits 1.
- In `--json` mode every failure (bad `-d`, missing or invalid profile, invalid config) prints the error document and exits 1. `configJsonCommand` validates `-d` itself with `validateDirectory`, so a bad directory is reported as JSON, not as red text.
- `bin/nax.ts` registers the options and, when `--json` is set, branches before its own `validateDirectory` call (so a bad `-d` is reported as JSON) and calls `process.exit(await configJsonCommand({ dir: options.dir, profile: options.profile, explain: options.explain, diff: options.diff }))`.

### Output format: `AuthListReport`

```json
{
  "source": "exec",
  "helper": { "command": ["/usr/local/bin/cred-helper", "--team", "a"] },
  "providers": [
    {
      "providerId": "deepseek",
      "stored": null,
      "exec": { "status": "served", "account": "team-a" },
      "ambient": false,
      "available": true
    },
    {
      "providerId": "openai",
      "stored": { "kind": "oauth", "expires": "2026-10-01T00:00:00.000Z", "expired": false },
      "exec": { "status": "declined" },
      "ambient": true,
      "available": true
    }
  ]
}
```

- `source` — `readGlobalAuthConfig().source`.
- `helper` — present only when `source` is `"exec"`; `command` is `auth.exec.command` verbatim.
- `providers` — every stored provider plus every non-blank argument, de-duplicated and sorted by `providerId` (the set and order the text view uses today).
- `stored` — the `listStoredProviders()` entry, or `null`. `expires` is present only when the entry has one, as `new Date(expires).toISOString()`; `expired` is `expires <= Date.now()` (`false` when there is no `expires`).
- `exec` — present only when `source` is `"exec"`. The collector calls `naxCredentialStore().read(providerId)`. If it throws: `{ "status": "error", "code": <the error's code, or "CREDENTIAL_HELPER_FAILED"> }`. If it resolves and `servedAuth(providerId)?.source` is `"exec"`: `{ "status": "served" }` plus `account` when the stamp carries one, cleaned by the existing `safeAccountLabel`. Otherwise `{ "status": "declined" }`.
- `ambient` — whether `_authDeps.ambientAuthAvailable(providerId)` reports a credential pi would resolve without nax's store (environment variables and pi's other ambient sources), via `ambientShadows`; a probe that throws counts as `false`.
- `available` — whether nax can authenticate this provider on this machine:
  - `source` `"file"`: `stored !== null || ambient`.
  - `source` `"exec"`: `exec.status === "served"`, or `exec.status === "declined"` and `(stored !== null || ambient)`. An `"error"` status is `false`: the chained store fails closed on a helper failure and never consults the file.

The report never carries a key, fingerprint or salt. `AuthListReport` and `AuthListProvider` are exported types:

```ts
export type AuthListExecStatus =
  | { status: "served"; account?: string }
  | { status: "declined" }
  | { status: "error"; code: string };

export interface AuthListProvider {
  providerId: string;
  stored: { kind: "api-key" | "oauth"; expires?: string; expired: boolean } | null;
  exec?: AuthListExecStatus;
  ambient: boolean;
  available: boolean;
}

export interface AuthListReport {
  source: "file" | "exec";
  helper?: { command: string[] };
  providers: AuthListProvider[];
}
```

### Output format: `ConfigJsonReport`

```json
{
  "profile": "codex-review+ds",
  "profileChain": ["codex-review", "ds"],
  "sources": { "global": "/home/runner/.nax/config.json", "project": null },
  "requirements": {
    "agent": "native",
    "transport": "native",
    "protocol": "hybrid",
    "providers": ["deepseek", "openai"],
    "sandbox": true
  },
  "config": { "...": "the masked resolved config" }
}
```

- `profile` / `profileChain` — the values `loadConfig` force-sets on the resolved config (`"default"` and `[]` when no overlay applied).
- `sources` — `determineConfigSources(dir)`: the global config path when the file exists, and `<projectDir>/config.json` when `findProjectDir(dir)` finds a project and that file exists; `null` otherwise.
- `requirements` — `_configJsonDeps.buildConfigRequirements(config)`:
  - `agent` — `resolveDefaultAgent(config)`.
  - `transport` — `"native"` when `agent === NATIVE_AGENT`, else `"acp"` (the agent registry's routing rule).
  - `protocol` — `config.agent?.protocol ?? DEFAULT_AGENT_PROTOCOL` (the `acp | native | hybrid` gate, reported as configured).
  - `providers` — when `transport` is `"native"`, the keys of `_configRequirementsDeps.nativeTierProviders(config)` sorted ascending; `[]` otherwise.
  - `sandbox` — `transport === "native" && config.execution.sandbox?.enabled !== false`. Only the native agent runs Bash, and the schema default for `enabled` is `true`.
- `config` — `maskProfileValues(config)`, the masking the default text view already applies.

```ts
export interface ConfigRequirements {
  agent: string;
  transport: "native" | "acp";
  protocol: "acp" | "native" | "hybrid";
  providers: string[];
  sandbox: boolean;
}

export interface ConfigJsonReport {
  profile: string;
  profileChain: string[];
  sources: { global: string | null; project: string | null };
  requirements: ConfigRequirements;
  config: Record<string, unknown>;
}

export interface ConfigJsonOptions {
  dir: string;
  profile?: string[];
  explain?: boolean;
  diff?: boolean;
}

// src/cli/config-requirements.ts
export const _configRequirementsDeps: { nativeTierProviders: typeof nativeTierProviders };
export function buildConfigRequirements(config: NaxConfig): ConfigRequirements;

// src/cli/config-json.ts
export const _configJsonDeps: {
  log: (text: string) => void;
  buildConfigRequirements: typeof buildConfigRequirements;
};
export async function configJsonCommand(options: ConfigJsonOptions): Promise<number>;
```

`providers` has the same scope as the precheck: the default agent's root `models.native` map only. Pins, fallback rungs and per-package overrides are not counted.

### Worked skeleton: `nativeTierProviders`

```ts
// src/agents/native/tier-providers.ts
import type { PrecheckConfig } from "../../config/selectors";
import { NATIVE_AGENT } from "./models";

export type NativeTierConfig = Pick<PrecheckConfig, "agent" | "models">;

/** The provider prefix of a native id, or undefined when it has none (never guessed). */
function providerOf(id: string): string | undefined {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : undefined;
}

/** provider -> tiers, for the `models.native` map, skipping catalog-override providers. */
export function nativeTierProviders(config: NativeTierConfig): Map<string, string[]> {
  const overridden = new Set((config.agent?.native?.catalogOverrides ?? []).map((o) => o.provider));
  const byProvider = new Map<string, string[]>();
  for (const [tier, entry] of Object.entries(config.models?.[NATIVE_AGENT] ?? {})) {
    if (entry === undefined) continue;
    const provider = providerOf(typeof entry === "string" ? entry : entry.model);
    if (provider === undefined || overridden.has(provider)) continue;
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), tier]);
  }
  return byProvider;
}
```

This is the body of today's `providerTiers` and `providerOf`, moved verbatim. The parameter type is `Pick<PrecheckConfig, "agent" | "models">`, a slice type from the leaf `config/selectors` per `.nax/rules/config-patterns.md`; both `PrecheckConfig` and `NaxConfig` satisfy it.

### Integration

Symbols this feature changes. The baseline exists only to locate the code; it is never the interface to implement.

**`authListCommand`** — `src/cli/auth.ts:247`
- Baseline: `authListCommand(providerIds: readonly string[] = []): Promise<number>`.
- Target: `authListCommand(providerIds: readonly string[] = [], options: { json?: boolean } = {}): Promise<number>`. It calls `_cliAuthDeps.collectAuthList(providerIds)` and prints through `_cliAuthDeps.log` either each line of `renderAuthListText(report)` or the single string `renderAuthListJson(report)`. `_cliAuthDeps` gains `collectAuthList: typeof collectAuthList`. `safeAccountLabel`, `skipAnsiSequence` and `errorCode` move to `src/cli/auth-list.ts` (US-002); `helperRowStatus` and `formatAuthListRow` are replaced by the collector and `renderAuthListText` (US-003).

```ts
// src/cli/auth-list.ts
export async function collectAuthList(providerIds: readonly string[]): Promise<AuthListReport>; // US-002
export function renderAuthListText(report: AuthListReport): string[]; // US-003
export function renderAuthListJson(report: AuthListReport): string; // US-003
```
- `bin/nax.ts` registers `.option("--json", "Emit machine-readable JSON to stdout", false)` on `auth list` and passes `{ json: options.json }`.

**`configCommand` / `ConfigCommandOptions`** — `src/cli/config-display.ts:19-40`
- Baseline: `ConfigCommandOptions { explain?: boolean; diff?: boolean }`.
- Target: `ConfigCommandOptions` gains `profile?: string[]`; `configCommand` rejects `diff` with a non-empty `profile`.

**`determineConfigSources`** — `src/cli/config-display.ts:113`
- Baseline: `function determineConfigSources(): { global: string | null; project: string | null }` (reads `findProjectDir()` from `process.cwd()`).
- Target: `export function determineConfigSources(startDir?: string): { global: string | null; project: string | null }`, calling `findProjectDir(startDir)`. The text views keep calling it with no argument.

**`findMissingNativeCredentials` / `_nativeCredentialDeps`** — `src/precheck/checks-native-credentials.ts:33-68`
- Baseline: `_nativeCredentialDeps = { providersWithoutCredentials }`; the private `providerTiers(config)` and `providerOf(id)` build the provider map.
- Target: `_nativeCredentialDeps = { providersWithoutCredentials, nativeTierProviders }`; `findMissingNativeCredentials` calls `_nativeCredentialDeps.nativeTierProviders(config)`. `providerTiers` and `providerOf` are deleted from this file.

**`nax config` registration** — `bin/nax.ts:764-785`
- Target: adds `--profile <name>` (with `collectProfile`, default `[]`) and `--json`. The text path loads with the same call the JSON path uses, `loadConfig(findProjectDir(workdir) ?? workdir, …)`, passing `{ profile }` when the chain is non-empty, and passes `profile` to `configCommand`; so text and JSON resolve the same chain from a subdirectory.

Symbols this feature reads but does not change:
- `readGlobalAuthConfig(): Promise<AuthConfig>` — `src/config/auth.ts:7`.
- `listStoredProviders(): Promise<StoredEntry[]>` — `src/agents/native/auth.ts:228`; `StoredEntry { providerId; kind: "api-key" | "oauth"; expires?: number }`.
- `ambientShadows(providerIds: readonly string[]): Promise<string[]>` and `_authDeps.ambientAuthAvailable` — `src/agents/native/auth.ts:255`.
- `naxCredentialStore()`, `servedAuth(providerId): AuthStamp | undefined` — `src/agents/native/credentials/index.ts:147`; `AuthStamp { fingerprint; source: "file" | "exec"; account? }`.
- `loadConfig(startDir?, cliOverrides?)` — `src/config/loader.ts:313`; `parseProfileList` — `src/config/profile.ts:182`; `validateDirectory` — `src/config/path-security.ts:24`.
- `maskProfileValues` — `src/cli/config-profile.ts:166`; `resolveDefaultAgent` — `src/agents/utils.ts:6`; `NATIVE_AGENT` — `src/agents/native/models.ts`; `DEFAULT_AGENT_PROTOCOL` — `src/config/agent-defaults.ts:14` (`"hybrid"`).

### Failure Handling

| Failure | Behaviour |
|---|---|
| `auth list --json`: `readGlobalAuthConfig()` throws (invalid `auth` block) | error document with the error's code (`AUTH_CONFIG_INVALID`), exit 1 |
| `auth list --json`: `listStoredProviders()` throws (unreadable credentials file) | error document with the error's code (`CREDENTIAL_FILE_UNREADABLE`), exit 1 |
| `auth list --json`: the helper fails for one provider | that provider's `exec` is `{ status: "error", code }` and `available` is `false`; exit 0 |
| `auth list --json`: the ambient probe throws for a provider | that provider's `ambient` is `false` |
| `config --json`: `-d` does not exist | error document with code `PATH_DIRECTORY_NOT_FOUND`, exit 1 |
| `config --json`: a profile in the chain does not exist | error document with code `PROFILE_NOT_FOUND`, exit 1 |
| `config --json`: a profile in the chain sets `auth` | error document with code `AUTH_CONFIG_NOT_GLOBAL`, exit 1 |
| `config --json` with `--explain` or `--diff` | error document with code `CONFIG_FLAGS_CONFLICT`, exit 1 |
| `config --diff` with `--profile` | `console.error` message naming both flags, `process.exit(1)` |
| any error without a string `code` | error document code `AUTH_LIST_FAILED` (auth) or `CONFIG_JSON_FAILED` (config) |

## Out of Scope

- Counting providers reached through model pins, fallback rungs or per-package overrides in `requirements.providers`; the scope stays the default agent's root `models.native` map, the same as the native-credentials precheck.
- Probing whether the OS sandbox actually works on the machine; `requirements.sandbox` reports only whether the resolved config needs it.
- A `--json` mode for any other `nax auth` or `nax config` subcommand (`auth login`, `auth rm`, `auth import`, `config profile *`, `config get`).
- Changing the text output of a successful `nax auth list` or of `nax config`; both stay as today. The only text change is the dropped header line on an unreadable credentials file (see CLI behaviour).
- Counting fallback rungs that reach the native agent in `requirements.sandbox`; like `requirements.providers`, it reflects the default agent only.
- Asking the exec helper about providers under `auth.source: "file"`; the file source never spawns a helper.
- Resolving per-package (`.nax/mono/<pkg>/config.json`) overlays in `nax config --json`; it resolves the root config as `loadConfig(dir, …)` does.

## Stories

1. **US-001: shared native tier-provider helper** — no dependencies. Extract `providerTiers`/`providerOf` from the native-credentials precheck into `nativeTierProviders` in `src/agents/native/tier-providers.ts`, export it from `@/agents/native`, and route `findMissingNativeCredentials` through `_nativeCredentialDeps.nativeTierProviders`. Removal of the private helpers is verified by `bun run typecheck` and `bun run lint`.
2. **US-002: auth list collector** — no dependencies. `collectAuthList` and the `AuthListReport` / `AuthListProvider` / `AuthListExecStatus` types in `src/cli/auth-list.ts`; `safeAccountLabel`, `skipAnsiSequence` and `errorCode` move there from `src/cli/auth.ts`, which imports them back.
3. **US-003: `nax auth list --json`** — depends on US-002. `renderAuthListText` and `renderAuthListJson` in `src/cli/auth-list.ts`; `authListCommand` gains `options.json`, reads the report through `_cliAuthDeps.collectAuthList`, and prints the error document on failure in JSON mode; `helperRowStatus` and `formatAuthListRow` are deleted; `bin/nax.ts` registers `--json` on `auth list`.
4. **US-004: config requirements** — depends on US-001. `buildConfigRequirements`, `ConfigRequirements` and `_configRequirementsDeps` in `src/cli/config-requirements.ts`.
5. **US-005: `nax config --profile <chain> --json`** — depends on US-004. `configJsonCommand`, `ConfigJsonReport`, `ConfigJsonOptions` and `_configJsonDeps` in `src/cli/config-json.ts`, re-exported through `src/cli/config.ts` (which `src/cli/index.ts` re-exports); `determineConfigSources(startDir?)` exported; `ConfigCommandOptions.profile` and the `--diff` rejection; `bin/nax.ts` registers `--profile` and `--json` on `nax config`.

### Context Files

**US-001**
- `src/precheck/checks-native-credentials.ts` — the private `providerTiers` / `providerOf` to extract, and `_nativeCredentialDeps`
- `src/agents/native/index.ts` — the barrel the helper is exported from
- `src/agents/native/models.ts` — `NATIVE_AGENT`
- `test/unit/precheck/checks-native-credentials.test.ts` — existing precheck tests that must stay green

**US-002**
- `src/cli/auth.ts` — `helperRowStatus` (the served/declined/error decision to mirror) and the helpers that move out
- `src/agents/native/auth.ts` — `listStoredProviders`, `ambientShadows`, `_authDeps`
- `src/agents/native/credentials/index.ts` — `naxCredentialStore`, `servedAuth`, `StoredEntry`
- `test/unit/cli/auth-credential-source.test.ts` — fake-helper harness to mirror

**US-003**
- `src/cli/auth.ts` — `authListCommand`, `_cliAuthDeps`, `formatAuthListRow`
- `src/cli/auth-list.ts` — created by US-002, extended here
- `test/unit/cli/auth-list.test.ts` — created by US-002; US-003's tests go in this file (one test file per source file)
- `bin/nax.ts` — `auth list` registration

**US-004**
- `src/agents/native/tier-providers.ts` — created by US-001, consumed here
- `src/agents/utils.ts` — `resolveDefaultAgent`
- `src/config/agent-defaults.ts` — `DEFAULT_AGENT_PROTOCOL`, `AgentProtocol`
- `src/config/schemas-sandbox.ts` — `execution.sandbox.enabled` default

**US-005**
- `src/cli/config-display.ts` — `configCommand`, `ConfigCommandOptions`, `determineConfigSources`
- `src/config/loader.ts` — `loadConfig` profile-chain resolution
- `src/cli/config-profile.ts` — `maskProfileValues`
- `bin/nax.ts` — `nax config` registration and `collectProfile`
- `src/cli/config-requirements.ts` — created by US-004, consumed here

### Creates

**US-001**
- `src/agents/native/tier-providers.ts`
- `test/unit/agents/native/tier-providers.test.ts`

**US-002**
- `src/cli/auth-list.ts`
- `test/unit/cli/auth-list.test.ts`

**US-004**
- `src/cli/config-requirements.ts`
- `test/unit/cli/config-requirements.test.ts`

**US-005**
- `src/cli/config-json.ts`
- `test/unit/cli/config-json.test.ts`

### Modifies

None. US-001 moves the provider derivation without changing its results, and the precheck tests enter through `findMissingNativeCredentials` and `_nativeCredentialDeps.providersWithoutCredentials`, which keep their names and behaviour. US-002 and US-003 keep the text output of a successful `nax auth list` unchanged (the only change is the header line dropped on an unreadable credentials file, which no existing test asserts), so the existing `auth list` assertions in `test/unit/cli/auth.test.ts` and `test/unit/cli/auth-credential-source.test.ts` hold. US-005 only adds an optional `profile` field and an exported, argument-optional `determineConfigSources`, so `test/unit/cli/config-display.test.ts` holds.

### Seams

- US-001 internal: `nativeTierProviders` is consumed by `findMissingNativeCredentials`. Seam AC in US-001 enters at `findMissingNativeCredentials` with `_nativeCredentialDeps.nativeTierProviders` stubbed.
- US-001 → US-004: `nativeTierProviders` is consumed by `buildConfigRequirements`. Seam AC in US-004 stubs `_configRequirementsDeps.nativeTierProviders`.
- US-002 → US-003: `collectAuthList` is consumed by `authListCommand`. Seam AC in US-003 enters at `authListCommand`, the handler `bin/nax.ts` calls, with `_cliAuthDeps.collectAuthList` stubbed.
- US-004 → US-005: `buildConfigRequirements` is consumed by `configJsonCommand`. Seam AC in US-005 enters at `configJsonCommand`, the handler `bin/nax.ts` calls, with `_configJsonDeps.buildConfigRequirements` stubbed.

## Acceptance Criteria

`NAX_GLOBAL_CONFIG_DIR` points at a fresh temp dir in every test (`test/preload.ts` isolates it; tests that write `config.json`, `credentials` or `profiles/*.json` write them there). Fake exec helpers are small executable scripts in a temp dir, as in `test/unit/cli/auth-credential-source.test.ts`. `_authDeps.ambientAuthAvailable` is stubbed in every US-002 and US-003 test and restored after. Output is captured by replacing `_cliAuthDeps.log` (US-003) or `_configJsonDeps.log` (US-005) and restored after. In US-005, a directory is a nax project only when it contains `.nax/config.json` (that is what `findProjectDir` looks for); unless an AC says otherwise, `dir` is a fresh temp project whose `.nax/config.json` holds `{}`, and `NAX_PROFILE` is unset in every US-005 test so `profile: []` resolves no overlay. "The document" means the single captured string parsed as JSON.

### US-001: shared native tier-provider helper

- [unit] `nativeTierProviders` imported from `@/agents/native`, given `models.native` `{ fast: "openai/gpt-a", balanced: "deepseek/ds-b", powerful: "openai/gpt-c" }`, returns a map whose `openai` entry is `["fast", "powerful"]`.
- [unit] For the same input, `nativeTierProviders` returns a map whose `deepseek` entry is `["balanced"]`.
- [unit] `nativeTierProviders` given the object-form tier entry `{ fast: { provider: "anthropic", model: "anthropic/claude-x" } }` returns a map with the key `anthropic`.
- [unit] `nativeTierProviders` given `{ fast: "gpt-a" }` (no `/` in the id) returns an empty map.
- [unit] `nativeTierProviders` given `models.native` `{ fast: "local/m" }` and an `agent.native.catalogOverrides` entry with `provider: "local"` returns an empty map.
- [unit] `nativeTierProviders` given a config with no `models.native` entry returns an empty map.
- [unit] With `_nativeCredentialDeps.nativeTierProviders` stubbed to return `new Map([["x-provider", ["fast"]]])`, `_nativeCredentialDeps.providersWithoutCredentials` spied, and `agent.default` `"native"`, calling `findMissingNativeCredentials(config)` invokes the spy once with `["x-provider"]`.
- [unit] With the same stubs and the spy returning `["x-provider"]`, `findMissingNativeCredentials(config)` returns `[{ provider: "x-provider", tiers: ["fast"] }]`.

Verification note: `providerTiers` and `providerOf` are deleted from `src/precheck/checks-native-credentials.ts`; `bun run typecheck` and `bun run lint` confirm no reference remains.

### US-002: auth list collector

- [unit] Under `auth.source` `"file"` with a stored `api-key` entry for `openai`, `collectAuthList([])` resolves a report whose `source` is `"file"`.
- [unit] Under `auth.source` `"file"` with a stored `api-key` entry for `openai`, the report from `collectAuthList([])` has no `helper` key.
- [unit] Under `auth.source` `"file"` with a stored `api-key` entry for `openai` (no `expires`), the report's `openai` provider has `stored` equal to `{ kind: "api-key", expired: false }`.
- [unit] Under `auth.source` `"file"` with a stored `api-key` entry for `openai`, the report's `openai` provider has no `exec` key.
- [unit] Under `auth.source` `"file"` with a stored `api-key` entry for `openai` and `_authDeps.ambientAuthAvailable` resolving `false`, the report's `openai` provider has `available` `true`.
- [unit] A stored `oauth` entry whose `expires` is `1000` yields `stored.expires` `"1970-01-01T00:00:01.000Z"` in the report from `collectAuthList([])`.
- [unit] A stored `oauth` entry whose `expires` is `1000` yields `stored.expired` `true` in the report from `collectAuthList([])`.
- [unit] Under `auth.source` `"file"` with nothing stored, `collectAuthList(["mistral"])` yields a `mistral` provider whose `stored` is `null`.
- [unit] Under `auth.source` `"file"` with nothing stored and `_authDeps.ambientAuthAvailable` resolving `false`, `collectAuthList(["mistral"])` yields a `mistral` provider whose `available` is `false`.
- [unit] With `_authDeps.ambientAuthAvailable` resolving `true` for `mistral`, `collectAuthList(["mistral"])` yields a `mistral` provider whose `ambient` is `true`.
- [unit] Under `auth.source` `"file"` with nothing stored and `_authDeps.ambientAuthAvailable` resolving `true` for `mistral`, `collectAuthList(["mistral"])` yields a `mistral` provider whose `available` is `true`.
- [unit] With `_authDeps.ambientAuthAvailable` throwing for `mistral`, `collectAuthList(["mistral"])` yields a `mistral` provider whose `ambient` is `false`.
- [unit] Under `auth.source` `"exec"` with `exec.command` `[<helperScript>, "--x"]`, the report from `collectAuthList([])` has `helper.command` equal to `[<helperScript>, "--x"]`.
- [unit] Under `auth.source` `"exec"` with a helper serving `deepseek` with account `team-a`, `collectAuthList(["deepseek"])` yields a `deepseek` provider whose `exec` equals `{ status: "served", account: "team-a" }`.
- [unit] Under `auth.source` `"exec"` with a helper serving `deepseek` and nothing stored, `collectAuthList(["deepseek"])` yields a `deepseek` provider whose `available` is `true`.
- [unit] Under `auth.source` `"exec"` with a helper serving `deepseek` with the account `"\u001b[31mteam-a\u001b[0m"`, `collectAuthList(["deepseek"])` yields `exec.account` `"team-a"`.
- [unit] Under `auth.source` `"exec"` with a helper declining `openai` and a stored `openai` entry, `collectAuthList([])` yields an `openai` provider whose `exec` equals `{ status: "declined" }`.
- [unit] Under `auth.source` `"exec"` with a helper declining `openai` and a stored `openai` entry, `collectAuthList([])` yields an `openai` provider whose `available` is `true`.
- [unit] Under `auth.source` `"exec"` with a helper declining `mistral`, nothing stored and `_authDeps.ambientAuthAvailable` resolving `false`, `collectAuthList(["mistral"])` yields a `mistral` provider whose `available` is `false`.
- [unit] Under `auth.source` `"exec"` with a helper exiting 1 and a stored `openai` entry, `collectAuthList([])` yields an `openai` provider whose `exec` equals `{ status: "error", code: "CREDENTIAL_HELPER_FAILED" }`.
- [unit] Under `auth.source` `"exec"` with a helper exiting 1 and a stored `openai` entry, `collectAuthList([])` yields an `openai` provider whose `available` is `false`.
- [unit] Under `auth.source` `"exec"` with a helper serving key `sk-helper-secret` for `deepseek`, the JSON serialisation of the report from `collectAuthList(["deepseek"])` does not include `sk-helper-secret`.
- [unit] With stored entries for `openai` and `anthropic`, the report from `collectAuthList([])` lists `anthropic` before `openai` in `providers`.
- [unit] With nothing stored and no arguments, `collectAuthList([])` resolves a report whose `providers` is `[]`.

### US-003: `nax auth list --json`

- [unit] With `_cliAuthDeps.collectAuthList` stubbed to resolve a fixed `AuthListReport`, `authListCommand(["mistral"], { json: true })` calls the stub once with `["mistral"]`.
- [unit] With `_cliAuthDeps.collectAuthList` stubbed to resolve a fixed `AuthListReport`, the document printed by `authListCommand(["mistral"], { json: true })` deep-equals the fixed report.
- [unit] With `_cliAuthDeps.collectAuthList` stubbed to resolve a fixed `AuthListReport`, `authListCommand(["mistral"], { json: true })` calls `_cliAuthDeps.log` exactly once.
- [unit] With `_cliAuthDeps.collectAuthList` stubbed to resolve a fixed `AuthListReport`, `authListCommand(["mistral"], { json: true })` returns `0`.
- [unit] With `_cliAuthDeps.collectAuthList` stubbed to resolve `{ source: "file", providers: [] }`, the only line `authListCommand([], { json: true })` logs is the document, whose `providers` is `[]`.
- [unit] With the real collector, `auth.source` `"file"` and a stored `api-key` entry for `openai`, `authListCommand([], { json: true })` yields a document whose `providers[0].providerId` is `"openai"`.
- [unit] Under `auth.source` `"exec"` with a helper exiting 1 and a stored `openai` entry, `authListCommand([], { json: true })` returns `0`.
- [unit] With a `config.json` holding `auth: { source: "exec" }` (no `exec` block), `authListCommand([], { json: true })` returns `1`.
- [unit] With a `config.json` holding `auth: { source: "exec" }` (no `exec` block), the document printed by `authListCommand([], { json: true })` has `error.code` `AUTH_CONFIG_INVALID`.
- [unit] With a `config.json` holding `auth: { source: "exec" }` (no `exec` block), the document printed by `authListCommand([], { json: true })` has a non-empty string `error.message`.
- [unit] With a `credentials` file holding invalid JSON, `authListCommand([], { json: true })` yields a document whose `error.code` is `CREDENTIAL_FILE_UNREADABLE`.
- [unit] With `_cliAuthDeps.collectAuthList` stubbed to reject with a plain `Error("boom")`, `authListCommand([], { json: true })` yields a document whose `error.code` is `AUTH_LIST_FAILED`.
- [unit] With a stored `api-key` entry for `openai` under `auth.source` `"file"`, `authListCommand([])` logs `Credential source: file` as its first line.
- [unit] With a stored `api-key` entry for `openai` under `auth.source` `"file"`, the second line `authListCommand([])` logs, with ANSI codes stripped, starts with two spaces followed by `openai`.
- [unit] With `_cliAuthDeps.collectAuthList` stubbed to resolve a report with `source` `"exec"`, `helper.command` `["cred", "--x"]` and one provider whose `exec` is `{ status: "served", account: "team-a" }`, `authListCommand([])` logs `Credential source: exec (cred --x)` as its first line.
- [unit] With `_cliAuthDeps.collectAuthList` stubbed to resolve a report with `source` `"exec"` and one provider whose `exec` is `{ status: "served", account: "team-a" }`, that provider's line logged by `authListCommand([])`, with ANSI codes stripped, contains `exec (team-a)`.
- [unit] With `_cliAuthDeps.collectAuthList` stubbed to resolve `{ source: "file", providers: [] }`, `authListCommand([])` logs `No credentials stored. Add one with \`nax auth login <provider>\`.` as its second line.

Verification note: `helperRowStatus` and `formatAuthListRow` are deleted from `src/cli/auth.ts`, together with the imports they leave unused there (`StoredEntry`, `servedAuth`, `naxCredentialStore` if no other command uses it, and the `safeAccountLabel`/`skipAnsiSequence` imports); `bun run typecheck` and `bun run lint` confirm no reference remains. The `--json` option on `auth list` in `bin/nax.ts` is a registration line with no unit test (tests never spawn `nax`).

### US-004: config requirements

- [unit] `buildConfigRequirements` given a config with `agent.default` `"claude"` returns `agent` `"claude"`.
- [unit] `buildConfigRequirements` given a config with `agent.default` `"claude"` returns `transport` `"acp"`.
- [unit] `buildConfigRequirements` given a config with `agent.default` `"native"` returns `transport` `"native"`.
- [unit] `buildConfigRequirements` given a config with no `agent.protocol` returns `protocol` `"hybrid"`.
- [unit] `buildConfigRequirements` given a config with `agent.protocol` `"native"` returns `protocol` `"native"`.
- [unit] `buildConfigRequirements` given `agent.default` `"native"` and `models.native` `{ fast: "openai/gpt-a", balanced: "deepseek/ds-b", powerful: "openai/gpt-c" }` returns `providers` `["deepseek", "openai"]`.
- [unit] `buildConfigRequirements` given `agent.default` `"claude"` and `models.native` `{ fast: "openai/gpt-a", balanced: "deepseek/ds-b", powerful: "openai/gpt-c" }` returns `providers` `[]`.
- [unit] `buildConfigRequirements` given `agent.default` `"native"` and `execution.sandbox` at its default returns `sandbox` `true`.
- [unit] `buildConfigRequirements` given `agent.default` `"native"` and `execution.sandbox.enabled` `false` returns `sandbox` `false`.
- [unit] `buildConfigRequirements` given `agent.default` `"claude"` returns `sandbox` `false`.
- [unit] With `_configRequirementsDeps.nativeTierProviders` stubbed to return `new Map([["stub-provider", ["fast"]]])`, `buildConfigRequirements` given `agent.default` `"native"` returns `providers` `["stub-provider"]`.
- [unit] With `_configRequirementsDeps.nativeTierProviders` stubbed, `buildConfigRequirements(config)` given `agent.default` `"native"` calls the stub once with that same `config` object.

### US-005: `nax config --profile <chain> --json`

- [unit] With a global profile `profiles/p.json` holding `{}`, `configJsonCommand({ dir: <tempProject>, profile: ["p"] })` yields a document whose `profileChain` is `["p"]`.
- [unit] With a global profile `profiles/p.json` holding `{}`, `configJsonCommand({ dir: <tempProject>, profile: ["p"] })` returns `0`.
- [unit] With global profiles `a` and `b`, `configJsonCommand({ dir, profile: ["a", "b"] })` yields `profile` `"a+b"`.
- [unit] With global profiles `a` and `b`, `configJsonCommand({ dir, profile: ["a,b"] })` yields `profileChain` `["a", "b"]`.
- [unit] With `<tempProject>/.nax/config.json` holding `{}`, a project profile at `<tempProject>/.nax/profiles/proj.json` and `dir` set to `<tempProject>/src` (an existing subdirectory), `configJsonCommand({ dir, profile: ["proj"] })` yields `profileChain` `["proj"]`.
- [unit] With `<tempProject>/.nax/config.json` holding `{}` and `dir` set to `<tempProject>/src`, `configJsonCommand({ dir, profile: [] })` yields `sources.project` equal to the absolute path of `<tempProject>/.nax/config.json`.
- [unit] With a global profile `p` setting `agent.default` `"native"` and `models.native` `{ fast: "openai/gpt-a", balanced: "openai/gpt-b", powerful: "deepseek/ds-c" }`, `configJsonCommand({ dir, profile: ["p"] })` yields `requirements.providers` `["deepseek", "openai"]`.
- [unit] With `_configJsonDeps.buildConfigRequirements` stubbed to return a fixed `ConfigRequirements`, `configJsonCommand({ dir, profile: ["p"] })` yields a document whose `requirements` deep-equals the fixed value.
- [unit] With `_configJsonDeps.buildConfigRequirements` stubbed, `configJsonCommand({ dir, profile: ["p"] })` calls the stub once with a config whose `profile` is `"p"`.
- [unit] A global profile `p` whose `models.native.fast` is `{ provider: "openai", model: "openai/gpt-a", env: { OPENAI_API_KEY: "sk-profile-secret" } }` makes the output captured from `configJsonCommand({ dir, profile: ["p"] })` exclude `sk-profile-secret`.
- [unit] With `<tempProject>/.nax/config.json` present, `configJsonCommand({ dir: <tempProject>, profile: [] })` yields `sources.project` equal to the absolute path of that file.
- [unit] With `config.json` present in the isolated global config dir, `configJsonCommand({ dir, profile: [] })` yields `sources.global` equal to the absolute path of that file.
- [unit] With `dir` a temp directory that has no `.nax/` directory and a global profile `p`, `configJsonCommand({ dir, profile: ["p"] })` returns `0`.
- [unit] With `dir` a temp directory that has no `.nax/` directory and a global profile `p`, `configJsonCommand({ dir, profile: ["p"] })` yields `sources.project` `null`.
- [unit] `configJsonCommand({ dir, profile: ["missing"] })` returns `1`.
- [unit] `configJsonCommand({ dir, profile: ["missing"] })` yields a document whose `error.code` is `PROFILE_NOT_FOUND`.
- [unit] A global profile `p` holding an `auth` key makes `configJsonCommand({ dir, profile: ["p"] })` yield `error.code` `AUTH_CONFIG_NOT_GLOBAL`.
- [unit] `configJsonCommand({ dir: <nonexistent path>, profile: [] })` yields `error.code` `PATH_DIRECTORY_NOT_FOUND`.
- [unit] `configJsonCommand({ dir, profile: [], explain: true })` yields `error.code` `CONFIG_FLAGS_CONFLICT`.
- [unit] `configJsonCommand({ dir, profile: [], diff: true })` yields `error.code` `CONFIG_FLAGS_CONFLICT`.
- [unit] With `_configJsonDeps.buildConfigRequirements` stubbed to throw a plain `Error("boom")`, `configJsonCommand({ dir, profile: [] })` yields `error.code` `CONFIG_JSON_FAILED`.
- [unit] `configJsonCommand({ dir, profile: ["missing"] })` calls `_configJsonDeps.log` exactly once.
- [unit] With `process.exit` replaced by a spy that throws, `configCommand(DEFAULT_CONFIG, { diff: true, profile: ["p"] })` calls the spy with `1`.
- [unit] `determineConfigSources(<tempProject>)` returns `project` equal to `<tempProject>/.nax/config.json` when that file exists.

Verification note: the `--profile` and `--json` options on `nax config` in `bin/nax.ts` are registration and routing lines with no unit test (tests never spawn `nax`).
