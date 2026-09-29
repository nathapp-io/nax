# SPEC: Credential sources and change detection

## Summary

Make the native agent's provider credentials come from a configurable source, and make a credential that changes during a run visible or refusable. A new global-only `auth` config block selects the source: `file` (today's `~/.nax/credentials`, the default) or `exec`, a helper command that returns a leased API key per provider or declines so the file serves it. Every credential nax reads is fingerprinted with a keyed hash (a file key written as a `$VAR` or `!command` template is fingerprinted as written). A fingerprint or account change during the process logs `credential.changed` and, under `auth.onChange: "refuse"`, fails the request as an authentication fault. Credential faults are classified as `fail-auth` instead of the transport-retry path they reach today, and each cost row records which credential paid for it. This closes nax#2256 and gives the koda fleet (designed, not scheduled) a stable contract to supply keys through.

## Motivation

nax#2256: a running `nax run` re-reads `~/.nax/credentials` on every LLM request (`src/agents/native/credentials.ts` memoises the store object, not its contents; nax-ai's file store reads the file on every `read()`). A `nax auth login`, `nax auth rm` or hand edit during a run changes the credential the next request uses. One story can be billed to two accounts and nothing in the run log shows it. A plain load-once snapshot is not an option: OAuth refreshes are written back under the file lock, and providers that rotate refresh tokens would log out every other process.

Two further defects surfaced while designing the fix:

- A credential-store failure reaches nax as a throw with no HTTP status. nax-ai's `classifyThrown` (`protocols/errors.js`) files every status-less throw as kind `transport`, so nax retries it (`isRetryableTransportFault` in `src/agents/native/session/turn-retry.ts`) and maps it to `fail-service-down` (`toAdapterFailure` in `src/agents/native/errors.ts`) instead of `fail-auth`.
- There is no way to supply a credential from anything but the file or an environment variable. The koda fleet design (koda `docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md` section 9.6) needs a helper-command seam, like git credential helpers or AWS `credential_process`, that nax can call per provider.

User rulings (2026-09-29): the `file` source keeps reading live (option D of #2256) with a configurable `onChange: "warn" | "refuse"`, default `"warn"`; one helper with a decline fall-through to the file; a helper failure fails the request unless an unexpired last good lease exists; an optional `account` label decides renewal versus change; the code lives in nax (not nax-ai) and can move to nax-ai later.

## Design

### Approach

A composite `CredentialStore` (nax-ai's existing interface: `read`, `modify`, `delete`) assembled inside nax. No nax-ai or pi-ai change. pi-ai calls `store.read(providerId)` before every request, so wrapping the store intercepts every credential read.

```
pi-ai request ──read(p)──▶ change guard ──▶ chained store ──▶ exec source (when auth.source = "exec")
                                                   │ declined
                                                   └──────────▶ nax-ai file store (~/.nax/credentials, live read)
```

### Config: the `auth` block

Top level of `NaxConfig`. The name is `auth`, not `credentials`: `SECRET_KEY_PATTERN` in `src/logger/redact.ts` matches any key containing `CREDENTIAL` and would mask the whole block in `nax config`.

```jsonc
// ~/.nax/config.json
{
  "auth": {
    "source": "exec",                                 // "file" (default) | "exec"
    "exec": { "command": ["koda-cred"], "timeoutMs": 10000 },
    "onChange": "warn"                                // "warn" (default) | "refuse"
  }
}
```

- `source` — `"file"` or `"exec"`, default `"file"`.
- `exec.command` — non-empty string array (argv); run with no shell; nax appends `"get"`. Required when `source` is `"exec"`.
- `exec.timeoutMs` — integer 1000 to 60000, default 10000.
- `onChange` — `"warn"` or `"refuse"`, default `"warn"`; applies to both sources.

**Global-only.** The credential module reads `auth` from exactly one place, `~/.nax/config.json`, through a new async `readGlobalAuthConfig(): Promise<AuthConfig>`. It builds the path as `join(globalConfigDir(), "config.json")` with `globalConfigDir` from `./paths` (as `profile.ts` does). It must not import from `loader.ts`: `loader.ts` imports `global-only-keys.ts`, and the reverse edge would create a runtime import cycle that `bun run check:import-cycles` (part of `bun run lint`) rejects. It never reads the merged run config. Every code path that builds a native client (`nax run`, `nax plan`, prechecks, `nax auth`) therefore uses the same source, without threading config into `getNativeClient`. The loader rejects `auth` everywhere else with `NaxError` code `AUTH_CONFIG_NOT_GLOBAL`: the project `.nax/config.json`, any profile, and a per-package `.nax/mono/<pkg>/config.json`. Profiles are rejected inside `loadProfile` (`src/config/profile.ts:80`), the one function every profile chain calls: the root chain (`loader.ts:168`, global and project profiles) and the per-package chain (`loader.ts:539`, profiles under `<pkg>/.nax/profiles/`). Its other callers (`nax config profile` in `src/cli/config-profile.ts`, and the bakeoff preflight) therefore refuse such a profile too, which is intended. Per-package configs are rejected at both readers: `loadConfigForWorkdir`'s overlay and `loadPackageOverride` (`loader.ts:396`, used by `runtime/packages.ts`, `cli/features-acceptance.ts` and `finish/gates/quality.ts`). The merged config still carries the global value, so `nax config` shows it. The per-package overlay also adds `auth` to the keys `pinRootOnlyKeysRaw` pins to root.

`src/config/loader.ts` is at 599 lines against the 600-line gate enforced by `bun run lint` (`check:file-sizes`). The new import of `rejectGlobalOnlyKeys` takes it to 600, leaving no further lines. The non-profile rejections (project config at `:138`, and the two per-package readers) must therefore wrap expressions those sites already have, the `profile` destructures, without adding lines. Each wrapped line fits Biome's 120-character width.

**A fourth rejection site: `applyCliOverridesLayer`.** The implementation also rejects `auth` from the CLI-override layer, which the "rejects `auth` everywhere else" rule above requires but the three-site budget above does not name. Added on review (2026-09-30), because leaving the layer unguarded would let a `--auth-source` style override through a path no other test covers, and Out of Scope rules out "a CLI flag" as a source. Paying for the extra line out of the 600-line budget forced the function's `/** Layer 4 … */` doc comment to be condensed and its `applyConfigCompatShims` call reflowed onto one line; the SEC-2 rationale for the adjacent `warnSecuritySensitiveOverrides` call is retained as an inline comment. Net line count is unchanged at 600, so the budget's "no further lines" still binds.

### The helper contract (a public interface koda will depend on)

- **Invocation:** argv `[...auth.exec.command, "get"]`, spawned without a shell, stdin a pipe, the helper inherits nax's environment. nax writes one JSON line to stdin and closes it: `{"version":1,"providerId":"anthropic"}`
- **Credential reply** (exit 0, stdout): `{"version":1,"kind":"api-key","key":"sk-...","expiresAt":1790000000000,"account":"koda:proj-42/anthropic-team"}`. `expiresAt` (epoch milliseconds) and `account` (non-secret label, at most 200 characters) are optional.
- **Decline reply** (exit 0, stdout): `{"version":1,"decline":true}` — "not mine", the file serves this provider.
- **Failure:** non-zero exit, timeout or spawn error (such as a missing binary) → `CREDENTIAL_HELPER_FAILED`. A malformed reply → `CREDENTIAL_HELPER_INVALID`: stdout over `AUTH_HELPER_STDOUT_MAX_BYTES` (65,536), not JSON, `version` not `1`, `kind` other than `"api-key"` (including `"oauth"`), empty `key` or `key` over 8,192 characters, `account` not a string or over 200 characters, `expiresAt` not a positive integer, or `expiresAt` already past at receipt.
- **Secrets:** the key travels over stdout only, never argv or environment. stdout is never logged. stderr is collected, passed through `redactSecrets` first, and only then truncated to `AUTH_HELPER_STDERR_MAX_BYTES` (4,096) before it appears in any log line or error message. Redacting first means truncation can never split a secret into a fragment the redaction patterns miss.

### Exec source: the lease lifecycle

`createExecCredentialSource(options)` in `exec-source.ts`. `read(providerId)` runs this ordered pipeline:

1. A provider this process recorded as declined returns `undefined` without spawning.
2. A **fresh** lease returns without spawning. Fresh means: no `expiresAt`, or `expiresAt - now > LEASE_FRESHNESS_MS` (60,000). A lease with no `expiresAt` is used for the life of the process.
3. If a helper call for this provider is already in flight, the read awaits it (single-flight per provider).
4. Otherwise it spawns the helper, then:
   - **credential** → becomes the provider's lease and last good lease; the consecutive-failure streak resets; returned.
   - **decline** → recorded as declined for the life of the process; returns `undefined`. A decline for a provider that already holds a lease is treated as `CREDENTIAL_HELPER_INVALID` (a provider never switches source mid-process).
   - **failure** (`CREDENTIAL_HELPER_FAILED` or `CREDENTIAL_HELPER_INVALID`) → if the last good lease has `expiresAt > now`, it is returned and `credential.helper_failed` is logged with `servedLastGood: true`; otherwise `credential.helper_failed` is logged with `servedLastGood: false` and the error is thrown. Either way, `credential.helper_failed` is logged once per consecutive-failure streak. Its data carries `providerId`, `code`, `exitCode` when there is one, `timedOut`, and the redacted stderr excerpt, and never the key.

The timeout and the stdout cap both kill the process; whichever trips first decides the code (`CREDENTIAL_HELPER_FAILED` for the timeout, `CREDENTIAL_HELPER_INVALID` for the cap), and both then take the failure branch. The timeout timer is cleared when the process exits.

A helper whose `expiresAt` is 60 seconds away or less is accepted but never fresh, so every read of that provider spawns the helper again until it returns a longer lease. This follows from the rules above and is intended: a helper controls its own call rate through the lease length it returns.

`read` returns only `{ kind: "api-key", key }`, the shape nax-ai's `StoredCredential` allows. The lease's `account` label is exposed separately: `accountOf(providerId)` returns the current lease's `account`, or `undefined`.

`modify` and `delete` on the exec source throw `NaxError` code `CREDENTIAL_MANAGED_BY_HELPER`.

### Chained store

`createChainedCredentialStore({ exec?, file })` in `chained-store.ts`.

- `read(p)`: with an exec source, try it first; a credential is returned and `p` is recorded as served by `"exec"`. On `undefined` (declined), or with no exec source, read the file store and record `"file"`. A throw from the file store is rethrown as `NaxError` code `CREDENTIAL_FILE_UNREADABLE` with the original as `cause`.
- `modify(p, fn)` and `delete(p)`: a provider recorded as `"exec"` throws `CREDENTIAL_MANAGED_BY_HELPER`; otherwise they go to the file store, so OAuth refresh keeps its file lock and write-back.
- `sourceOf(p)` returns `"exec" | "file" | undefined`.
- `accountOf(p)` returns the exec source's `accountOf(p)` when `p` was served by `"exec"`, otherwise `undefined`.

### Change guard and fingerprints

`fingerprintCredential(credential)` in `fingerprint.ts`: the first 12 lowercase hex characters of HMAC-SHA-256 keyed with a per-machine salt. Input: the `key` for `api-key`, the `refresh` token for `oauth`. The salt is 32 random bytes in `<globalConfigDir>/auth-fingerprint-salt`, created at mode `0600` on first use and read thereafter. Creation is an exclusive create, so a process that loses the creation race reads the winner's file. Bun has no exclusive-create API; `open(path, "wx", 0o600)` from `node:fs/promises` is one way to do it, and `credentials.ts` already imports `node:fs/promises`.

A file-store `api-key` whose `key` is a `$VAR` or `!command` template (nax-ai documents `key` as opaque) is fingerprinted as written, not as resolved. A salt file that is not exactly 32 bytes is left untouched: the process uses a random in-memory salt and logs `credential.salt_invalid` once. The loaded salt and the "already warned" flag are memoised per salt-file path. `fingerprint.ts` exports `_resetFingerprintSalt()` (tests only) to clear both, and US-004's `_resetCredentialStore()` calls it.

`createChangeGuard(inner, { onChange, describe })` in `change-guard.ts` returns a `GuardedCredentialStore`: nax-ai's `CredentialStore` plus `servedAuth(providerId): AuthStamp | undefined`. It wraps `read`; `modify` and `delete` pass straight through. `read`'s return value carries only the credential, so the guard learns where it came from through `describe(providerId): { source: "file" | "exec"; account?: string } | undefined`, called right after each `inner.read`. The assembly passes a `describe` that returns `undefined` when `chained.sourceOf(p)` is `undefined`, and otherwise `{ source: chained.sourceOf(p), account: chained.accountOf(p) }`, with `account` omitted when `undefined`. A `describe` result of `undefined` records `source: "file"`.

Per provider the guard keeps the last observed identity `{ kind, fingerprint, source, account? }` and compares each non-`undefined` read with it:

| Previous → current | Result |
|---|---|
| none (first read in the process) | `credential.resolved` (info) |
| identical fingerprint | nothing |
| `kind` differs | **changed** |
| `oauth` → `oauth`, different fingerprint | `credential.renewed` (info); refresh-token rotation by any process on the machine is indistinguishable from a re-login |
| `api-key` → `api-key`, both carry `account`, same label | `credential.renewed` (info) |
| `api-key` → `api-key`, both carry `account`, different label | **changed** |
| `api-key` → `api-key`, either lacks `account`, different fingerprint | **changed** |

**Changed** under `onChange: "warn"` logs `credential.changed` (warn), adopts the new identity and returns the credential. Under `"refuse"` it logs `credential.changed` and throws `NaxError` code `CREDENTIAL_CHANGED` without adopting the new identity, so every later read of that provider refuses too. A read that returns `undefined` is passed through and leaves the stored identity untouched.

`guard.servedAuth(providerId)` returns the last observed `{ fingerprint, source, account? }` or `undefined`. The module-level `servedAuth(providerId)`, exported from `src/agents/native/credentials/index.ts`, delegates to the memoised `naxCredentialStore()`; it is what the adapter reads for the cost-row stamp.

Event data fields: `providerId`, `kind`, `source`, `fingerprint`, `account` (when present), `previousFingerprint` and `previousAccount` (changed and renewed), `onChange` (changed). No field name matches `SECRET_KEY_PATTERN`; no event carries a key, token or salt.

### Store assembly and run start

`src/agents/native/credentials.ts` moves to `src/agents/native/credentials/index.ts` (the "one module per name" rule forbids keeping both), keeping its exports. `naxCredentialStore()` stays synchronous, since its callers (`client.ts:84`, `auth.ts:121`, `:204`, `:238`) are, and returns a memoised `GuardedCredentialStore`. Because `readGlobalAuthConfig()` is async, the store resolves it on its first `read`, `modify` or `delete`, builds `guard(chained(exec?, file))` from it, and reuses that for the rest of the process. The memo is keyed per credential-file path and global config path. A `config.json` rewritten in the same directory is not re-read until `_resetCredentialStore()`, so tests use a fresh `NAX_GLOBAL_CONFIG_DIR`. `_resetCredentialStore()` also clears the guard, exec-source and salt memos.

`providersWithoutCredentials(providerIds)` in `src/agents/native/auth.ts` (called by `assertDefaultNativeCredentials` for a native-default run, and by the native-credentials precheck) decides "has a stored credential" by calling `naxCredentialStore().read(providerId)` per provider instead of listing the file. These reads happen before, and outside, the `AMBIENT_PROBE_TIMEOUT_MS` (2,000) race, so a helper slower than 2 seconds is still asked. They record each provider's baseline (`credential.resolved`) before any story starts. `CREDENTIAL_HELPER_FAILED`, `CREDENTIAL_HELPER_INVALID` and `CREDENTIAL_CHANGED` propagate and refuse the run; `CREDENTIAL_FILE_UNREADABLE` keeps today's behaviour of reporting nothing missing.

`NativeAgentAdapter.hasCredentials()` returns `true` without spawning the helper when `auth.source` is `"exec"`, because a helper's providers cannot be listed.

### Credential fault classification

`credentialFaultCode(protocolError)` in `src/agents/native/errors.ts` walks the `cause` chain, at most 8 links (nax-ai's `ProtocolError` carries `cause`; pi-ai's `ModelsError` wraps the store's throw), and returns the first `NaxError` code in `CREDENTIAL_FAULT_CODES` = `CREDENTIAL_HELPER_FAILED`, `CREDENTIAL_HELPER_INVALID`, `CREDENTIAL_CHANGED`, `CREDENTIAL_FILE_UNREADABLE`. When it finds one:

- `toAdapterFailure` returns the `auth` entry (`category: "availability"`, `outcome: "fail-auth"`, `retriable: false`) with a message naming the code, whatever the protocol `kind` says.
- `isRetryableTransportFault` returns `false`, so the native turn loop does not retry it.

The existing `fail-auth` policy then applies: no same-agent retry, an immediate swap to a fallback agent, the agent cooled down for the run.

### Cost attribution

The `AuthStamp` type `{ fingerprint: string; source: "file" | "exec"; account?: string }` is declared by US-002 in `src/agents/session-types.ts` (US-002's `servedAuth` returns it) and imported from there by every later story; no story declares a local copy. `NativeAgentAdapter` sets `auth` to `servedAuth(provider)` when defined, where `provider` is the value `parseNativeModel(modelDef.model)` returns: the same value passed to `client.model(provider, model)` (`adapter.ts:203` in `complete`, `:280` in `sendTurn`). **Never `modelDef.provider`**: the adapter deliberately ignores it, because `resolveModel()` infers it from the model name and it is `"unknown"` for non-Claude models. In `complete` the stamp joins the returned `CompleteResult` object. In `sendTurn` it is spread onto the `TurnResult` from `runNativeTurn` (`adapter.ts:357`) at the method's return (`:538`), after the loop, because the credential is only read during the loop. It is forwarded like `pricingSource`: `buildCompleteEvent` / `buildSessionTurnEvent` → `CompleteDispatchEvent` / `SessionTurnDispatchEvent` → `attachCostSubscriber` → `CostEvent.auth`. Absent (not `undefined`) when not set, so ACP rows are unchanged. `COST_ROW_SCHEMA_VERSION` goes from 7 to 8, with an `8 — adds auth` entry in its version list, per the rule in `src/runtime/middleware/cost.ts`. Error rows are stamped with `COST_ROW_SCHEMA_VERSION` too (`cost.ts:250`), so they also record `8`, without an `auth` field.

**File-size budget.** Three files this story touches are at or one line under the 600-line gate (`scripts/check-file-sizes.ts`, run by `bun run lint`): two at 600 and one at 599. None is baselined:

- `src/agents/manager.ts` (600): the complete path forwards provenance through a new `completeResultProvenance(result)` helper exported from `src/agents/manager-dispatch.ts`. It returns `{ pricingSource?, rates?, auth? }` with each key omitted when its value is `undefined`. `manager.ts` replaces its two existing spread lines for `pricingSource` and `rates` (`:539-540`) with one `...completeResultProvenance(outcome.result)` line.
- `src/agents/types.ts` (600): `CompleteResult` gains `auth?: AuthStamp` with a one-line doc comment, and `AuthStamp` joins the existing `./session-types` type import. The story offsets the growth by shortening the seven-line `CompleteResult.sessionId` doc comment to four lines or fewer.
- These three files end at exactly 600 lines with no slack. Any further comment or import in them breaks `bun run lint`.
- `src/runtime/cost-aggregator.ts` (599): `CostEvent` gains the single line `readonly auth?: import("../agents/session-types").AuthStamp;` with no comment of its own, since the doc lives on `AuthStamp`.

### CLI behaviour

- `nax auth list [provider...]`
  - First line: `Credential source: file` or `Credential source: exec (<argv joined by spaces>)`.
  - Rows: every stored provider, plus each provider named as an argument. Under `exec`, each row asks the helper (bounded by `timeoutMs`) and shows `exec` plus the `account` label when present, `file (declined)`, or `error: <CODE>`. Under `file`, rows are unchanged from today.
  - Never prints a key, fingerprint or salt. Exit 0; exit 1 when `readGlobalAuthConfig()` throws.
- `nax auth rm <provider>`: when the helper serves the provider, prints `<provider> is managed by the credential helper; nothing was removed.` and exits 1. Otherwise unchanged.
- `nax auth login <provider>`: unchanged, except that under `exec`, when the helper serves the provider, it prints after the success line: `Note: the credential helper serves <provider>; this stored login is not used while it does.` Exit code unchanged.
- All output goes to stdout through `_cliAuthDeps.log`, as today.

### Failure Handling

| Failure | Behaviour |
|---|---|
| Helper non-zero exit, timeout or spawn error, no unexpired last good lease | fail-closed: `CREDENTIAL_HELPER_FAILED` → `fail-auth` |
| Helper reply malformed or oversized, no unexpired last good lease | fail-closed: `CREDENTIAL_HELPER_INVALID` → `fail-auth` |
| Helper fails while an unexpired last good lease exists | serve the last good lease, log `credential.helper_failed` (`servedLastGood: true`) once per streak |
| Helper declines a provider it previously served | `CREDENTIAL_HELPER_INVALID`, then the last-good rule |
| Credential changed, `onChange: "warn"` | log `credential.changed`, adopt, serve |
| Credential changed, `onChange: "refuse"` | log `credential.changed`, throw `CREDENTIAL_CHANGED` → `fail-auth` |
| Credential file unreadable | `CREDENTIAL_FILE_UNREADABLE` → `fail-auth` on a request; at run start, report nothing missing (unchanged) |
| Helper fails at run start | the run is refused before any story starts |
| `auth` present outside `~/.nax/config.json` | config load throws `AUTH_CONFIG_NOT_GLOBAL` naming the layer |
| `~/.nax/config.json` `auth` block invalid | `readGlobalAuthConfig()` throws `AUTH_CONFIG_INVALID` |
| Salt file wrong length | per-process random salt, log `credential.salt_invalid` once |
| `modify` or `delete` on a helper-served provider | throw `CREDENTIAL_MANAGED_BY_HELPER` |

### Integration

This feature changes these symbols. Each baseline is stated only to locate the code; it is never the interface to implement.

**`naxCredentialStore`** — `src/agents/native/credentials.ts` (US-004)
- Baseline: `naxCredentialStore(): CredentialStore` returning a memoised `createFileCredentialStore({ path })`.
- Target: moved to `src/agents/native/credentials/index.ts`; `naxCredentialStore(): GuardedCredentialStore` (a `CredentialStore` subtype, so every existing caller still type-checks), returning the memoised `guard(chained(exec?, file))`. The same module exports `servedAuth(providerId): AuthStamp | undefined`.

**`completeResultProvenance`** — `src/agents/manager-dispatch.ts` (US-006)
- Target: returns `{ pricingSource?, rates?, auth? }`, each key omitted when its value is `undefined`, with one carve-out: `auth` is additionally omitted when `result.adapterFailure` is defined. `completeWithFallback` attaches that marker to a still-billed result (an empty-output `fail-stale`, or an exhausted fallback ladder) whose dispatch is still emitted as `kind: "complete"` and still billed by `attachCostSubscriber`; forwarding the stamp there would record a FAILED call as a success-shaped row naming the credential it happened to use. The carve-out is a code-and-review ruling (2026-09-30), not a `CostErrorEvent` case: `CostErrorEvent` and partial cost rows are unchanged, and this bullet does not widen Out of Scope's "only successful cost rows carry it".

**`loadProfile`** — `src/config/profile.ts:80` (US-001)
- Baseline: `loadProfile(profileName: string, projectRoot: string): Promise<Record<string, unknown>>`.
- Target: same signature; throws `AUTH_CONFIG_NOT_GLOBAL` naming `profile:<name>` when the loaded profile contains an `auth` key.

**`providersWithoutCredentials`** — `src/agents/native/auth.ts:285` (US-004)
- Baseline: stored set from `listStoredProviders()`, ambient sweep raced against `AMBIENT_PROBE_TIMEOUT_MS`.
- Target: same signature; stored set from `naxCredentialStore().read(id)` per provider, run before the ambient race; helper and change errors propagate.

**`NativeAgentAdapter.hasCredentials`** — `src/agents/native/adapter.ts:183` (US-004)
- Target: returns `true` without I/O when `readGlobalAuthConfig().source === "exec"`; otherwise unchanged.

**`toAdapterFailure`** — `src/agents/native/errors.ts:88` (US-005)
- Baseline: `toAdapterFailure(protocolError: NativeProtocolError): AdapterFailure`, keyed on `kind` only.
- Target: same signature; `NativeProtocolError` gains `readonly cause?: unknown`; a credential fault code in the cause chain yields the `fail-auth` entry.

**`isRetryableTransportFault`** — `src/agents/native/session/turn-retry.ts:65` (US-005)
- Baseline: true for kinds `transport`, `overloaded`, `rate-limit`.
- Target: additionally false when `credentialFaultCode(err.protocolError)` finds a code.

**`CompleteResult`** (`src/agents/types.ts:439`), **`TurnResult`** (`src/agents/session-types.ts:194`), **`CompleteDispatchEvent`** and **`SessionTurnDispatchEvent`** (`src/runtime/dispatch-events.ts`), **`CostEvent`** (`src/runtime/cost-aggregator.ts:3`) (US-006)
- Target: each gains optional `auth?: AuthStamp`, forwarded with the same omission discipline as `pricingSource` (`src/agents/manager-dispatch.ts:119`, `:204`; `src/runtime/middleware/cost.ts:282`). On the complete path `src/agents/manager.ts:539-540` becomes one `...completeResultProvenance(outcome.result)` line (see File-size budget).

**`NativeAgentAdapter.complete` / `sendTurn`** — `src/agents/native/adapter.ts:197`, `:280` (US-006)
- Target: both stamp `auth: servedAuth(provider)` (provider from `parseNativeModel(modelDef.model)`), omitted when `undefined`. `sendTurn` stamps at its return (`:538`), after `runNativeTurn`.

**`COST_ROW_SCHEMA_VERSION`** — `src/runtime/middleware/cost.ts:96` (US-006)
- Baseline: `7`. Target: `8`.

**`authListCommand`** — `src/cli/auth.ts:153` (US-007)
- Baseline: `authListCommand(): Promise<number>`.
- Target: `authListCommand(providerIds: readonly string[] = []): Promise<number>`; `bin/nax.ts` registers `list [provider...]`. `authRmCommand` and `authLoginCommand` keep their signatures.

**`NaxConfig`** — `src/config/runtime-types.ts:498` (US-001)
- Target: gains `auth?: AuthConfig`. `NaxConfigSchema` (`src/config/schemas.ts`) gains `auth: AuthConfigSchema.optional()`.

Symbols this feature reads but does not change:

- `CredentialStore`, `StoredCredential` — `@nathapp/nax-ai` `dist/types.d.ts:75`
- `createFileCredentialStore` — `@nathapp/nax-ai`
- `ProtocolError` (`kind`, `message`, `status?`, `retryAfter?`, `cause?`) — `@nathapp/nax-ai` `dist/protocols/types.d.ts:37`
- `globalConfigDir()` — `src/config/paths` (not `globalConfigPath()` from `loader.ts`, see Global-only)
- `parseNativeModel` — `src/agents/native/models.ts:52`
- `redactSecrets` — `src/logger/redact.ts:128`
- `FIELD_DESCRIPTIONS` — `src/cli/config-descriptions.ts:8`

Patterns to mirror: `src/config/schemas-command-safety.ts` for a small schema file with `superRefine`; `_clientDeps` and `_authDeps` for injectable dependencies; `test/unit/agents/native/credentials.test.ts` for `NAX_GLOBAL_CONFIG_DIR` temp-dir isolation.

## Out of Scope

- The koda runner credential broker and the koda server `SecretStore` (koda fleet spec section 9.6, C10); they are unscheduled and will be specified in koda.
- OAuth credentials from the exec helper; the helper serves `api-key` only and OAuth logins stay in `~/.nax/credentials`.
- Moving `exec-source.ts` or the chained store into nax-ai; that is a later option once a second consumer exists.
- Any change to `@nathapp/nax-ai` or `@earendil-works/pi-ai`, including nax-ai's internal transport retries (default 2), which re-read the store, and so re-run a failing helper, before nax sees a credential fault.
- Resolving a file-store `api-key` whose `key` is a `$VAR` or `!command` template before fingerprinting; it is fingerprinted as written, so a change in the resolved value is not detected.
- Detecting a switch between two OAuth accounts; an OAuth-to-OAuth fingerprint change is logged as `credential.renewed`, because refresh-token rotation by any nax process on the machine looks the same.
- Scrubbing the helper's environment; the helper inherits nax's environment, as git credential helpers do.
- Keeping a future koda credential socket unreachable from the agent's sandboxed Bash tool.
- A `nax auth` command that writes a credential through the helper.
- Setting `auth` from a profile, a CLI flag or any file other than `~/.nax/config.json`.
- Making `LEASE_FRESHNESS_MS`, `AUTH_HELPER_STDOUT_MAX_BYTES` or `AUTH_HELPER_STDERR_MAX_BYTES` configurable.
- `$VAR` environment substitution inside the `auth` block.
- Stamping `auth` on `CostErrorEvent` or partial cost rows; only successful cost rows carry it.
- A run-start pre-read for `nax plan`; plan sessions still get the guard on every request.
- `docs/guides/credentials.md` and the ADR recording the #2256 ruling and the helper contract; they are written by hand before merge, not by a story.
- US-002 only: fingerprints cannot be compared across machines, because the salt is per machine.
- US-002 only: no AC pins the cross-process race on first salt creation; atomic creation is the design, verified by review.
- US-003 only: a provider that switches source mid-process is refused, not supported; a decline after a lease is `CREDENTIAL_HELPER_INVALID`.

## Stories

1. **US-001: `auth` config block and the global-only rule** — no dependencies. `AuthConfigSchema`, `AuthConfig`, `readGlobalAuthConfig()`, the `AUTH_CONFIG_NOT_GLOBAL` rejection at the project layer, in `loadProfile` (every profile chain) and at the per-package overlay, the `pinRootOnlyKeysRaw` extension, and `FIELD_DESCRIPTIONS` entries.
2. **US-002: fingerprints and the change guard** — depends on US-001. `fingerprint.ts` (keyed hash, salt file), `change-guard.ts` (identity comparison, `onChange`, `credential.*` events, `servedAuth`), and the `AuthStamp` type exported from `src/agents/session-types.ts`, tested against a stub inner store.
3. **US-003: the exec source** — no dependencies. `exec-source.ts`: the helper contract, reply validation, lease cache, single-flight, last good lease, stderr redaction, tested against fake helper scripts.
4. **US-004: store assembly and run start** — depends on US-002 and US-003. `chained-store.ts`, the move to `credentials/index.ts`, `naxCredentialStore()` returning `guard(chained(exec?, file))`, `providersWithoutCredentials` reading through the store, and the `hasCredentials` exec short-circuit. Proven end to end through `buildNativeClient` against a fake server.
5. **US-005: credential fault classification** — depends on US-004. `credentialFaultCode`, the `fail-auth` mapping in `toAdapterFailure`, and the non-retry rule in `isRetryableTransportFault`.
6. **US-006: cost attribution** — depends on US-004. `AuthStamp`, the adapter stamp, the forwarding chain to `CostEvent.auth`, and `COST_ROW_SCHEMA_VERSION` 8.
7. **US-007: `nax auth` CLI** — depends on US-004. The `list` header and per-row source, `list [provider...]`, the `rm` refusal and the `login` note.

### Context Files

**US-001**
- `src/config/schemas-command-safety.ts` — small schema file with `superRefine` to mirror
- `src/config/root-only-keys.ts` — `pinRootOnlyKeysRaw`, extended to pin `auth`
- `src/config/loader.ts` — project and per-package layers that apply the rejection (599 of 600 lines)
- `src/config/profile.ts` — `loadProfile`, the single profile choke point
- `src/cli/config-descriptions.ts` — `FIELD_DESCRIPTIONS`

**US-002**
- `src/agents/native/credentials.ts` — the store module this guard will wrap
- `src/logger/redact.ts` — `SECRET_KEY_PATTERN`, which event field names must not match
- `src/config/global-only-keys.ts` — created by US-001, `readGlobalAuthConfig` supplies `onChange`
- `test/unit/agents/native/credentials.test.ts` — temp global-dir isolation pattern
- `src/agents/session-types.ts` — where US-002 declares and exports `AuthStamp` (359 lines, room)

**US-003**
- `src/agents/native/auth.ts` — `_authDeps` injection pattern
- `src/logger/redact.ts` — `redactSecrets` for helper stderr
- `src/agents/native/credentials.ts` — `StoredCredential` usage and store conventions
- `test/helpers/temp.ts` — temp-dir helpers for fake helper scripts

**US-004**
- `src/agents/native/credentials.ts` — moved into `credentials/index.ts`
- `src/agents/native/client.ts` — `buildNativeClient`, the single credential inlet
- `src/agents/native/auth.ts` — `providersWithoutCredentials`
- `src/agents/native/adapter.ts` — `hasCredentials`
- `test/unit/agents/native/auth-store-ops.test.ts` — existing `providersWithoutCredentials` tests that must keep passing

**US-005**
- `src/agents/native/errors.ts` — `toAdapterFailure`, `FAILURES`
- `src/agents/native/session/turn-retry.ts` — `isRetryableTransportFault`
- `src/agents/native/adapter.ts` — `complete()` and the session-turn catch that call `toAdapterFailure`
- `src/agents/retry/failure-policy.ts` — the `fail-auth` policy row
- `test/unit/agents/native/errors.test.ts` — existing mapping tests to extend

**US-006**
- `src/agents/native/adapter.ts` — where `pricingSource` is set on `CompleteResult` and `TurnResult`
- `src/agents/manager-dispatch.ts` — `buildSessionTurnEvent`, `buildCompleteEvent`; gains `completeResultProvenance`
- `src/agents/manager.ts` — complete-path forwarding at `:539-540` (600 of 600 lines)
- `src/agents/types.ts` — `CompleteResult` (600 of 600 lines)
- `src/runtime/middleware/cost.ts` — `attachCostSubscriber`, `COST_ROW_SCHEMA_VERSION`

**US-007**
- `src/cli/auth.ts` — the three commands
- `bin/nax.ts` — `auth list` registration
- `test/unit/cli/auth.test.ts` — existing command tests
- `src/agents/native/credentials/chained-store.ts` — created by US-004, `sourceOf`

### Creates

**US-001**
- `src/config/schemas-auth.ts` — `AuthConfigSchema`, `AuthConfig`
- `src/config/global-only-keys.ts` — `rejectGlobalOnlyKeys(layerConf, layerName)`, `readGlobalAuthConfig()`

**US-002**
- `src/agents/native/credentials/fingerprint.ts` — `fingerprintCredential`, salt file handling
- `src/agents/native/credentials/change-guard.ts` — `createChangeGuard`, `servedAuth`

**US-003**
- `src/agents/native/credentials/exec-source.ts` — `createExecCredentialSource`, `LEASE_FRESHNESS_MS`, `AUTH_HELPER_STDOUT_MAX_BYTES`, `AUTH_HELPER_STDERR_MAX_BYTES`

**US-004**
- `src/agents/native/credentials/index.ts` — the moved store module and the assembly
- `src/agents/native/credentials/chained-store.ts` — `createChainedCredentialStore`, `sourceOf`

### Modifies

**US-006**
- `test/unit/runtime/in-flight-usage.test.ts` — `:532` (`expect(row.schemaVersion).toBe(7)`, test "AC17: maps a residual onto a schema-v7 partial cost row"), `:574` (`expect(COST_ROW_SCHEMA_VERSION).toBe(7)`) and `:591` (`expect(recorded[0].schemaVersion).toBe(7)`) pin the row version this story bumps; the test and describe names say "v7". Replacing invariant: each asserts `8` and the names say v8; the partial-row and no-partial-field assertions are unchanged.
- `test/unit/runtime/middleware/cost-rate-provenance.test.ts` — `:133`, `:146` and `:638` (`schemaVersion` of successful rows), `:134` and `:639` (`COST_ROW_SCHEMA_VERSION`), and `:651` (`errors[0].schemaVersion`, an error row, which the cost middleware also stamps from `COST_ROW_SCHEMA_VERSION`, at line 250 of its source) all assert `7`; the header comment (`:8`) and the comment at `:470` say `schemaVersion: 7`. Replacing invariant: each asserts `8`, and both comments name the `auth` bump.
- `test/unit/runtime/middleware/cost.test.ts` — `:588` and `:701` (`recorded[0].schemaVersion` of successful rows), `:589` (`COST_ROW_SCHEMA_VERSION`) and `:714` (`errors[0].schemaVersion`, an error row stamped from the same constant) assert `7`. Replacing invariant: each asserts `8`.

### Seams

- US-001 → US-004: `readGlobalAuthConfig` is consumed by `naxCredentialStore`. Seam AC in US-004: a `~/.nax/config.json` with `onChange: "refuse"` makes a request built by `buildNativeClient` refuse a changed credential.
- US-002 and US-003 → US-004: `createChangeGuard` and `createExecCredentialSource` are consumed by `naxCredentialStore`. Seam ACs in US-004 drive a real client from `buildNativeClient` against a local fake OpenAI-compatible server.
- US-004 → US-005: the `CREDENTIAL_*` codes thrown by the store are consumed by `toAdapterFailure`. Seam AC in US-005 enters at `NativeAgentAdapter.complete()`.
- US-002/US-004 → US-006: `servedAuth` is consumed by `NativeAgentAdapter`. Seam AC in US-006 enters at `NativeAgentAdapter.complete()` against the fake server.
- US-006 internal: `completeResultProvenance` is consumed by `AgentManager.completeAsWithFallback`. Seam AC in US-006 enters at `completeAsWithFallback` and asserts the recorded `CostEvent.auth`.
- US-002 internal: `describe` is supplied by the assembly in US-004. The US-004 AC on the module-level `servedAuth` proves the assembly passes `sourceOf`/`accountOf` through.
- US-004 → US-007: `naxCredentialStore` and `sourceOf` are consumed by `authListCommand` and `authRmCommand`. Seam ACs in US-007 enter at those command functions with a fake helper configured.

## Acceptance Criteria

Fake helpers are small executable scripts written to a temp dir. "The fake server" is a local OpenAI-compatible HTTP server that records the `Authorization` header of each request, reached through a provider override the way `test/unit/agents/native/client.test.ts` configures one. `NAX_GLOBAL_CONFIG_DIR` points at a temp dir in every test. Client-level integration tests build the client with `buildNativeClient(overrides, { transportRetries: 0 })`, so a credential fault is not retried inside nax-ai; tests that enter at `NativeAgentAdapter.complete()` accept nax-ai's default 2 retries (about 750 ms of backoff).

### US-001: `auth` config block and the global-only rule

- [unit] `AuthConfigSchema.parse({})` returns `source` equal to `"file"`.
- [unit] `AuthConfigSchema.parse({})` returns `onChange` equal to `"warn"`.
- [unit] `AuthConfigSchema.safeParse({ source: "exec" })` fails with an issue on path `exec`.
- [unit] `AuthConfigSchema.parse({ source: "exec", exec: { command: ["koda-cred"] } })` returns `exec.timeoutMs` equal to `10000`.
- [unit] `AuthConfigSchema.safeParse` fails when `exec.command` is `[]`.
- [unit] `AuthConfigSchema.safeParse` fails when `exec.timeoutMs` is `999`.
- [unit] `AuthConfigSchema.safeParse` fails when `exec.timeoutMs` is `60001`.
- [unit] `AuthConfigSchema.safeParse` fails when `onChange` is `"ignore"`.
- [unit] `readGlobalAuthConfig()` returns `source: "file"` when `~/.nax/config.json` does not exist.
- [unit] `readGlobalAuthConfig()` returns `exec.command` equal to `["koda-cred"]` when `~/.nax/config.json` holds `auth: { source: "exec", exec: { command: ["koda-cred"] } }`.
- [unit] `readGlobalAuthConfig()` throws `NaxError` code `AUTH_CONFIG_INVALID` when `~/.nax/config.json` holds `auth: { source: "exec" }`.
- [unit] `loadConfig(projectDir)` throws `NaxError` code `AUTH_CONFIG_NOT_GLOBAL` when `<project>/.nax/config.json` contains an `auth` key.
- [unit] The `AUTH_CONFIG_NOT_GLOBAL` error thrown for `<project>/.nax/config.json` has a message containing `project`.
- [unit] `loadConfig(projectDir, { profile: "p" })` throws `AUTH_CONFIG_NOT_GLOBAL` when the global profile `~/.nax/profiles/p.json` contains an `auth` key.
- [unit] The `AUTH_CONFIG_NOT_GLOBAL` error thrown by `loadProfile("p", projectRoot)` for a profile containing an `auth` key has a message containing `profile:p`.
- [unit] `loadConfig(projectDir, { profile: "p" })` throws `AUTH_CONFIG_NOT_GLOBAL` when the project profile `<project>/.nax/profiles/p.json` contains an `auth` key.
- [unit] `loadConfigForWorkdir(rootConfigPath, "packages/a")` throws `AUTH_CONFIG_NOT_GLOBAL` when `.nax/mono/packages/a/config.json` contains an `auth` key.
- [unit] `loadPackageOverride(repoRoot, "packages/a")` throws `AUTH_CONFIG_NOT_GLOBAL` when `.nax/mono/packages/a/config.json` contains an `auth` key.
- [unit] `loadConfigForWorkdir(rootConfigPath, "packages/a")` throws `AUTH_CONFIG_NOT_GLOBAL` when `.nax/mono/packages/a/config.json` selects profile `pp` and `packages/a/.nax/profiles/pp.json` contains an `auth` key.
- [unit] `loadConfig(projectDir)` returns `auth.source` equal to `"exec"` when only `~/.nax/config.json` sets `auth: { source: "exec", exec: { command: ["h"] } }`.
- [unit] `pinRootOnlyKeysRaw(raw, root, "packages/a", warn)` returns `auth` equal to `root.auth` when `raw.auth` differs.
- [unit] `FIELD_DESCRIPTIONS` has a non-empty entry for each of `auth`, `auth.source`, `auth.exec`, `auth.exec.command`, `auth.exec.timeoutMs` and `auth.onChange`.

### US-002: fingerprints and the change guard

- [unit] `fingerprintCredential({ kind: "api-key", key: "K" })` equals the first 12 lowercase hex characters of HMAC-SHA-256 over `"K"` keyed with the bytes of `<globalConfigDir>/auth-fingerprint-salt`.
- [unit] `fingerprintCredential` returns the same value for key `"K"` before and after `_resetFingerprintSalt()` when the salt file already exists.
- [unit] `fingerprintCredential({ kind: "oauth", access: "A1", refresh: "R", expires: 1 })` equals the fingerprint of the same credential with `access: "A2"`.
- [unit] The first `fingerprintCredential` call creates `<globalConfigDir>/auth-fingerprint-salt` holding exactly 32 bytes.
- [unit] The salt file created by the first `fingerprintCredential` call has file mode `0600`.
- [unit] When `auth-fingerprint-salt` holds 5 bytes, two `fingerprintCredential` calls leave the file's 5 bytes unchanged.
- [unit] When `auth-fingerprint-salt` holds 5 bytes, two `fingerprintCredential` calls log `credential.salt_invalid` exactly once.
- [unit] The first `createChangeGuard(inner, { onChange: "warn", describe }).read("anthropic")` of a provider logs `credential.resolved` at info with `providerId`, `kind`, `source` and `fingerprint`.
- [unit] When `describe("anthropic")` returns `{ source: "exec", account: "team-a" }`, the `credential.resolved` entry carries `source: "exec"` and `account: "team-a"`.
- [unit] A second guard read returning the identical credential logs no `credential.*` entry.
- [unit] Given `onChange: "warn"`, a guard read whose `api-key` fingerprint differs from the previous read logs `credential.changed` at warn with `previousFingerprint`.
- [unit] Given `onChange: "warn"`, a guard read whose `api-key` fingerprint differs from the previous read returns the new credential.
- [unit] Given `onChange: "refuse"`, a guard read whose `api-key` fingerprint differs from the previous read throws `NaxError` code `CREDENTIAL_CHANGED`.
- [unit] Given `onChange: "refuse"`, after one `CREDENTIAL_CHANGED` throw, a further read returning the same new credential throws `CREDENTIAL_CHANGED` again.
- [unit] A guard read whose `kind` changes from `api-key` to `oauth` logs `credential.changed`.
- [unit] Given `onChange: "refuse"`, a guard read of an `oauth` credential whose refresh token differs from the previous read returns the credential.
- [unit] A guard read of an `oauth` credential whose refresh token differs from the previous read logs `credential.renewed` at info.
- [unit] Given `onChange: "refuse"` and `describe` returning `account: "team-a"` for both reads, a guard read of an `api-key` with a new key logs `credential.renewed` and returns the credential.
- [unit] Given `onChange: "refuse"` and `describe` returning `account: "team-a"` then `account: "team-b"`, the second guard read throws `CREDENTIAL_CHANGED`.
- [unit] A guard read returning `undefined` after a stored identity logs no `credential.*` entry, and a later read of the original credential logs none either.
- [unit] `guard.servedAuth("anthropic")` returns `{ fingerprint, source }` equal to the last guard read's identity for `anthropic`.
- [unit] No `credential.*` log entry's data contains the credential's `key`, `access` or `refresh` value.

### US-003: the exec source

- [unit] `createExecCredentialSource({ command: [script] }).read("anthropic")` spawns the helper with argv `[script, "get"]`.
- [unit] The helper spawned by `read("anthropic")` receives stdin `{"version":1,"providerId":"anthropic"}`.
- [unit] `read("anthropic")` returns `{ kind: "api-key", key: "HELPER-KEY" }` when the helper replies with a credential carrying key `HELPER-KEY`.
- [unit] A second `read` of a provider whose lease has no `expiresAt` returns the lease without spawning the helper again.
- [unit] A `read` of a provider whose lease `expiresAt` is 30 seconds away spawns the helper again.
- [unit] A `read` of a provider whose lease `expiresAt` is 5 minutes away returns the lease without spawning.
- [unit] Two concurrent `read` calls for one provider with no lease spawn the helper exactly once.
- [unit] A decline reply makes `read` return `undefined`.
- [unit] After a decline, a second `read` of that provider returns `undefined` without spawning.
- [unit] A helper that exits with code 1, with no lease held, makes `read` throw `NaxError` code `CREDENTIAL_HELPER_FAILED`.
- [unit] A helper still running at `timeoutMs` makes `read` throw `CREDENTIAL_HELPER_FAILED`.
- [unit] A `command` naming a non-existent binary makes `read` throw `CREDENTIAL_HELPER_FAILED`.
- [unit] A helper exiting with code 1, with no lease held, logs `credential.helper_failed` with `servedLastGood: false`.
- [unit] A reply with `kind: "oauth"` makes `read` throw `NaxError` code `CREDENTIAL_HELPER_INVALID`.
- [unit] A reply that is not JSON makes `read` throw `CREDENTIAL_HELPER_INVALID`.
- [unit] A reply with `version: 2` makes `read` throw `CREDENTIAL_HELPER_INVALID`.
- [unit] A reply whose `expiresAt` is earlier than now makes `read` throw `CREDENTIAL_HELPER_INVALID`.
- [unit] A helper writing more than `AUTH_HELPER_STDOUT_MAX_BYTES` bytes to stdout makes `read` throw `CREDENTIAL_HELPER_INVALID`.
- [unit] Given a last good lease whose `expiresAt` is 30 seconds away, a helper exiting with code 1 makes `read` return that lease.
- [unit] Given a last good lease whose `expiresAt` is 30 seconds away, a helper exiting with code 1 logs `credential.helper_failed` with `servedLastGood: true`.
- [unit] Given a last good lease that has expired, a helper exiting with code 1 makes `read` throw `CREDENTIAL_HELPER_FAILED`.
- [unit] Two consecutive failed reads served from the last good lease log `credential.helper_failed` exactly once.
- [unit] Given a provider holding an expired lease, a decline reply makes `read` throw `CREDENTIAL_HELPER_INVALID`.

### US-004: store assembly and run start

- [unit] `createChainedCredentialStore({ exec, file }).read(p)` returns the file store's credential when the exec source returns `undefined`.
- [unit] After a declined exec read, `sourceOf(p)` returns `"file"`.
- [unit] After the exec source served `p`, `createChainedCredentialStore({ exec, file }).delete(p)` throws `NaxError` code `CREDENTIAL_MANAGED_BY_HELPER` and the file store's `delete` is not called.
- [unit] After the exec source served `p`, `createChainedCredentialStore({ exec, file }).modify(p, fn)` throws `CREDENTIAL_MANAGED_BY_HELPER`.
- [unit] `createChainedCredentialStore({ file }).read(p)` rethrows a file-store read failure as `NaxError` code `CREDENTIAL_FILE_UNREADABLE`.
- [unit] The `CREDENTIAL_FILE_UNREADABLE` error thrown by `createChainedCredentialStore` has the file store's original error as `cause`.
- [unit] When a fake helper exits 1 after writing `api_key=sk-secret123` to stderr, the `CREDENTIAL_HELPER_FAILED` message from `createExecCredentialSource(...).read` omits `sk-secret123`.
- [unit] `createExecCredentialSource({ command }).delete("anthropic")` throws `NaxError` code `CREDENTIAL_MANAGED_BY_HELPER`.
- [unit] After the exec source served `p` from a reply carrying `account: "team-a"`, `createChainedCredentialStore({ exec, file }).accountOf(p)` returns `"team-a"`.
- [unit] Given `auth.source: "exec"` and a fake helper replying with `account: "team-a"`, after `naxCredentialStore().read("anthropic")` the module-level `servedAuth("anthropic")` returns `source: "exec"` and `account: "team-a"`.
- [unit] `providersWithoutCredentials(["anthropic"])` returns `[]` when `~/.nax/credentials` holds an `anthropic` api-key.
- [unit] `providersWithoutCredentials(["anthropic"])` logs `credential.resolved` for `anthropic` when `~/.nax/credentials` holds an `anthropic` api-key.
- [unit] Given `auth.source: "exec"` and a fake helper that exits 1, `providersWithoutCredentials(["anthropic"])` rejects with `NaxError` code `CREDENTIAL_HELPER_FAILED`.
- [unit] Given `auth.source: "exec"` and a fake helper that sleeps 3 seconds before replying with a credential, `providersWithoutCredentials(["anthropic"])` returns `[]`.
- [unit] Given `~/.nax/credentials` holding invalid JSON, `providersWithoutCredentials(["anthropic"])` returns `[]` rather than rejecting with `CREDENTIAL_FILE_UNREADABLE`.
- [unit] Given `onChange: "refuse"` and a guard baseline for `anthropic` recorded from key `KEY-A`, `providersWithoutCredentials(["anthropic"])` rejects with `CREDENTIAL_CHANGED` after `~/.nax/credentials` is rewritten to `KEY-B`.
- [unit] `NativeAgentAdapter.hasCredentials()` returns `true` without spawning the helper when `~/.nax/config.json` sets `auth.source: "exec"` and `~/.nax/credentials` does not exist.
- [integration] Given one client from `buildNativeClient` pointed at the fake server, and `~/.nax/credentials` rewritten from key `KEY-A` to `KEY-B` between two requests, the second request sends `Bearer KEY-B`.
- [integration] Given one client from `buildNativeClient` pointed at the fake server, and `~/.nax/credentials` rewritten from `KEY-A` to `KEY-B` between two requests, a `credential.changed` warn entry is logged.
- [integration] Given `~/.nax/config.json` with `auth: { onChange: "refuse" }`, one client from `buildNativeClient`, and `~/.nax/credentials` rewritten from `KEY-A` to `KEY-B` between two requests, the fake server receives no request carrying `Bearer KEY-B`.
- [integration] Given `~/.nax/config.json` with `auth.source: "exec"` and a fake helper replying key `HELPER-KEY`, a request from a client built by `buildNativeClient` sends `Bearer HELPER-KEY` to the fake server.
- [integration] Given `auth.source: "exec"`, a fake helper that declines, and `~/.nax/credentials` holding key `FILE-KEY`, a request from a client built by `buildNativeClient` sends `Bearer FILE-KEY`.

### US-005: credential fault classification

- [unit] `credentialFaultCode` returns `"CREDENTIAL_HELPER_FAILED"` for a `ProtocolError` of kind `transport` whose `cause` is an `Error` whose `cause` is a `NaxError` with that code.
- [unit] `credentialFaultCode` returns `undefined` for a `ProtocolError` of kind `transport` whose cause chain holds no `NaxError`.
- [unit] `credentialFaultCode` returns `undefined` when the credential-fault `NaxError` sits at link 9 of the cause chain.
- [unit] `credentialFaultCode` returns `undefined` for a cause chain whose only `NaxError` has code `AGENT_NOT_FOUND`.
- [unit] `toAdapterFailure` returns `outcome: "fail-auth"` for a kind `transport` error whose cause chain holds `CREDENTIAL_CHANGED`.
- [unit] `toAdapterFailure` returns `retriable: false` for a kind `transport` error whose cause chain holds `CREDENTIAL_CHANGED`.
- [unit] `toAdapterFailure` returns a `message` containing `CREDENTIAL_CHANGED` for a kind `transport` error whose cause chain holds that code.
- [unit] `toAdapterFailure` returns `outcome: "fail-auth"` for a kind `unknown` error whose cause chain holds `CREDENTIAL_FILE_UNREADABLE`.
- [unit] `toAdapterFailure` returns `outcome: "fail-service-down"` for a kind `transport` error with no credential fault in its cause chain.
- [unit] `isRetryableTransportFault` returns `false` for a kind `transport` error whose cause chain holds `CREDENTIAL_HELPER_INVALID`.
- [unit] `isRetryableTransportFault` returns `true` for a kind `transport` error with no credential fault in its cause chain.
- [integration] Given `~/.nax/config.json` with `auth.source: "exec"` and a fake helper that exits 1, `NativeAgentAdapter.complete()` returns a result whose `adapterFailure.outcome` is `"fail-auth"`.
- [integration] Given `onChange: "refuse"` and `~/.nax/credentials` rewritten from `KEY-A` to `KEY-B` between two `NativeAgentAdapter.complete()` calls against the fake server, the second call returns `adapterFailure.outcome` `"fail-auth"`.

### US-006: cost attribution

- [integration] `NativeAgentAdapter.complete()` against the fake server, with `~/.nax/credentials` holding an api-key for the provider, returns `CompleteResult.auth.source` equal to `"file"`.
- [integration] `NativeAgentAdapter.complete()` against the fake server returns `CompleteResult.auth.fingerprint` equal to `servedAuth(provider).fingerprint`, where `provider` is parsed from `options.modelDef.model` and `options.modelDef.provider` is set to `"unknown"`.
- [integration] Given `auth.source: "exec"` and a fake helper replying with `account: "team-a"`, `NativeAgentAdapter.complete()` returns `CompleteResult.auth.account` equal to `"team-a"`.
- [integration] `NativeAgentAdapter.sendTurn()` against the fake server, with `~/.nax/credentials` holding an api-key for the provider parsed from `handle.modelDef.model`, returns `TurnResult.auth.source` equal to `"file"`.
- [integration] `NativeAgentAdapter.sendTurn()` against the fake server returns `TurnResult.auth.fingerprint` equal to `servedAuth(provider).fingerprint` for the provider parsed from `handle.modelDef.model`.
- [unit] `buildCompleteEvent` given `auth` returns an event whose `auth` equals the input.
- [unit] `buildCompleteEvent` given no `auth` returns an event with no `auth` key.
- [unit] `buildSessionTurnEvent` given a `TurnResult` carrying `auth` returns an event whose `auth` equals it.
- [unit] A dispatch bus with `attachCostSubscriber` attached records a `CostEvent` whose `auth` equals the emitted `CompleteDispatchEvent`'s `auth`.
- [unit] A dispatch bus with `attachCostSubscriber` attached records a `CostEvent` with no `auth` key for a `SessionTurnDispatchEvent` that has none.
- [unit] `completeResultProvenance(result)` returns `auth` equal to `result.auth` when the result carries one and defines no `adapterFailure`.
- [unit] `completeResultProvenance(result)` returns no `auth` when the result carries both `auth` and an `adapterFailure`, while still returning the other keys it carries.
- [unit] `completeResultProvenance(result)` returns an object with no `auth`, `pricingSource` or `rates` key when the result carries none of them.
- [integration] With an adapter whose `complete` returns a `CompleteResult` carrying `auth`, `AgentManager.completeAsWithFallback` emits a `CompleteDispatchEvent` whose `auth` equals it.
- [integration] With an adapter whose `complete` returns a `CompleteResult` carrying `auth`, a bus with `attachCostSubscriber` attached records a `CostEvent` whose `auth` equals it after `AgentManager.completeAsWithFallback` returns.
- [unit] `COST_ROW_SCHEMA_VERSION` equals `8`.
- [unit] A `CostEvent` recorded from a dispatch event carrying `auth` has `schemaVersion` equal to `8`.
- [unit] A cost error row recorded from a `DispatchErrorEvent` has `schemaVersion` equal to `8` and no `auth` key.

### US-007: `nax auth` CLI

- [cli] `authListCommand()` prints `Credential source: file` as its first line when `~/.nax/config.json` has no `auth` block.
- [cli] `authListCommand()` prints `Credential source: exec (koda-cred --x)` as its first line when `auth.exec.command` is `["koda-cred", "--x"]`.
- [cli] Under `auth.source: "exec"`, `authListCommand(["anthropic"])` prints an `anthropic` row containing `exec` and `team-a` when the fake helper replies with `account: "team-a"` and `~/.nax/credentials` does not exist.
- [cli] Under `auth.source: "exec"`, `authListCommand()` prints `file (declined)` in the row of a stored provider the helper declines.
- [cli] Under `auth.source: "exec"`, `authListCommand(["anthropic"])` prints `error: CREDENTIAL_HELPER_FAILED` in the `anthropic` row when the helper exits 1.
- [cli] Under `auth.source: "exec"`, `authListCommand(["anthropic"])` returns 0 when the helper exits 1.
- [cli] `authListCommand(["anthropic"])` output contains neither the helper's key nor the credential's fingerprint.
- [cli] `authListCommand()` returns 1 when `~/.nax/config.json` holds `auth: { source: "exec" }`.
- [cli] Under `auth.source: "exec"`, when the helper serves `anthropic`, `authRmCommand("anthropic")` prints `anthropic is managed by the credential helper; nothing was removed.` and returns 1.
- [cli] Under `auth.source: "exec"`, when the helper serves `anthropic`, `authRmCommand("anthropic")` leaves the stored `anthropic` entry in `~/.nax/credentials`.
- [cli] Under `auth.source: "exec"`, when the helper declines `openai`, `authRmCommand("openai")` removes the stored `openai` entry and returns 0.
- [cli] Under `auth.source: "exec"`, a successful `authLoginCommand("anthropic")` prints `Note: the credential helper serves anthropic; this stored login is not used while it does.` when the helper serves `anthropic`.
- [cli] Under `auth.source: "file"`, a successful `authLoginCommand("anthropic")` prints no line containing `credential helper`.
