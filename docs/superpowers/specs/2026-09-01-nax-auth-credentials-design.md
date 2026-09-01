# nax auth: credentials and login flows (Phase A, plan 2)

Date: 2026-09-01
Status: Approved, not implemented
ADR: ADR-027 §8 (amended by this work)

## Context

Phase A plan 1 shipped the native completion path: the `protocol` capability
gate, `src/agents/native/`, the registry's discriminated selection, and the
wire-isolation gate. It deliberately left credentials on ambient environment
variables, and recorded two consequences that this plan closes.

The first is that nax cannot obtain a credential at all. There is no way to put
a key where nax will find it other than exporting an environment variable, and
no way at all to use a provider that authenticates through OAuth.

The second is quieter and worse. `NativeAgentAdapter.hasCredentials()`
(`src/agents/native/adapter.ts:56`) probes *client construction*, which succeeds
with no keys anywhere — `createClient` is synchronous construction and
`piProviders()` loads a bundled static catalog. So it returns `true`
unconditionally, and `AgentManager.validateCredentials()`
(`src/agents/manager.ts:172-189`) cannot prune the native agent or fail a run
that has no usable credentials. The failure surfaces mid-run instead of at
setup.

nax-ai M5 (PR #16) shipped `login()`, covering both API-key entry and OAuth
behind a per-method policy gate. That is the missing half: nax has a
`CredentialStore` it does not pass to the client, and now an upstream flow it
does not call.

### Prerequisite

`login()` merged after the 0.1.2 release commit, so no published version
contains it, and nax depends on `"@nathapp/nax-ai": "0.1.2"` as a plain npm
dependency (`package.json:68`) rather than a workspace link. **A nax-ai 0.1.3
release, and the corresponding bump of nax's pin, is task 1 of the
implementation plan.** Every subsequent task typechecks against a real
installed API.

## Decision

### 1. The nax-ai surface stays behind one boundary

`scripts/check-nax-ai-imports.ts` permits `@nathapp/nax-ai` imports only under
`src/agents/native/`. That constraint binds harder than it first appears:
`LoginInteraction`, `LoginPrompt`, `LoginEvent`, `CredentialStore` and
`StoredCredential` are all nax-ai types, so a `src/cli/auth.ts` implementing the
terminal interaction directly would violate the gate on its import line.

nax therefore declares its own interaction vocabulary and translates at the
boundary. This is the move nax-ai itself made against pi-ai (`toPiInteraction`),
applied one layer out — which is some evidence the shape holds.

Widening the gate to allow a second consumer was considered and rejected. The
gate's own docstring records that the package is swappable *only while its
surface has one consumer*, and the first exception is what makes the second easy
to argue for. Putting the command implementation inside `src/agents/native/`
was also rejected: it inverts the layering, giving the adapter directory
ownership of terminal prompting and command output.

### 2. Module layout

Inside the gate, in `src/agents/native/`:

- **`credentials.ts`** — owns the store. `naxCredentialStore(): CredentialStore`
  wraps `createFileCredentialStore({ path: join(globalConfigDir(), "credentials") })`,
  memoised per process as `client.ts` memoises its client. `globalConfigDir()`
  already honours the `NAX_GLOBAL_CONFIG_DIR` override, and `test/preload.ts`
  already points it at a temp directory before any test file loads, so the store
  is test-isolated with no seam of its own. This file also holds the direct
  reader that `auth list` needs (see §4).
- **`auth.ts`** — the four operations in nax vocabulary: `runLogin`,
  `importPiCredentials`, `listStoredProviders`, `removeStoredProvider`. Holds
  `toLoginInteraction()`, the mapper from nax's `AuthInteraction` to nax-ai's
  `LoginInteraction`, and maps nax-ai's typed errors (see §6).
- **`auth-types.ts`** — nax's own `AuthInteraction`, `AuthPrompt`, `AuthEvent`,
  `AuthResult`. A leaf with no imports, so nothing cycles back through the
  barrel. `check:import-cycles` runs against a baseline of 135 and a new cycle
  fails it.

Outside the gate:

- **`src/cli/auth.ts`** — command implementations. Terminal I/O only. Imports
  `@/agents/native`, never `@nathapp/nax-ai`.
- **`src/cli/auth-prompt.ts`** — the secret prompt, following `src/cli/confirm.ts`
  exactly: an injectable `_authPromptDeps` stdin seam, raw mode with echo
  suppressed, terminal state restored on keypress, `end` and `error` alike,
  Ctrl+C exiting 130 and Ctrl+D cancelling. A sibling of `confirm.ts`, not an
  edit to it — that file's terminal-state handling was hard-won and is not worth
  disturbing.
- **`bin/nax.ts`** — a `program.command("auth")` group with four subcommands, in
  the shape of the `config profile` group at line 1108.

`AuthPrompt`'s four variants (`text`, `secret`, `select`, `manual-code`) and
`AuthEvent`'s four (`info`, `auth-url`, `device-code`, `progress`) mirror
nax-ai's kebab-case names one for one. The mapper is deliberately dumb: it
exists so that a rename upstream is a one-file change here.

### 3. Login is interactive only

`nax auth login <provider>` requires a TTY and refuses otherwise with a message
naming the ambient environment variable as the CI path. It never falls through
to a silent no-op.

There is no `--api-key` flag, no `--api-key-stdin`, and no `--method`. The
resolution order (§5) already means CI needs no store, an OAuth flow cannot be
non-interactive, and the absence of any flag that accepts a key is what
guarantees no secret ever reaches `argv` or a shell history.

`runLogin` passes no `method`, so nax-ai runs its own method-selection prompt
when a provider offers both. Duplicating that table in nax is how the two drift
apart.

The OAuth policy gate is nax-ai's and fires per method, before any flow loader
is touched. In practice: `anthropic` offers only its API-key path;
`openai-codex` and `openrouter` are the two permitted OAuth flows;
`github-copilot` sits in `PROHIBITED_OAUTH_FLOWS` with a recorded reason.

On success the command prints provider, method and kind from `LoginResult`,
whatever they are. It must not derive one from the other, or treat any
combination as an inconsistency to correct.

That is not a stylistic preference. M5's design predicted `openrouter` would
report `method: "oauth"` with `kind: "api-key"`, reasoning that its PKCE
exchange yields a permanent key. M5's recorded live verification (nax-ai
`ROADMAP.md`, 2026-09-01) instead observed `method: "oauth"`, `kind: "oauth"`.
A plausible prediction about the same provider was wrong within one milestone,
so the CLI reports what the result carries rather than what the method implies,
and no test asserts a kind for a given provider.

### 4. Import, list and remove

**`nax auth import [--from <path>]`**, defaulting to `~/.pi/agent/auth.json`, is
a translation on two axes: pi's `type: "api_key"` becomes nax-ai's
`kind: "api-key"`, and pi's flat `{provider: credential}` map becomes the
store's `{version: 1, credentials: {...}}` shape. Each entry is written through
`store.modify()` so the cross-process lock is held.

pi's OAuth entries carry an `accountId` that nax-ai's `StoredCredential` has no
field for. Dropping it is safe and verified rather than assumed: pi derives the
value from the access-token JWT at request time
(`extractAccountId`, `dist/api/openai-codex-responses.js:1244`), and nax-ai's own
`toPi`/`fromPi` round-trip already drops it.

Existing entries are skipped rather than overwritten unless `--force`. An import
that silently replaced a credential just obtained by `login` would be the worst
kind of quiet data loss. Output is one line per provider — `imported`,
`skipped, already present`, or `unsupported type` — and never key material.

**`nax auth list`** reads the credential file directly through the reader in
`credentials.ts`. `CredentialStore` is read/modify/delete by design and has no
`list`; widening a published interface to serve one subcommand is the wrong
direction. It prints provider, kind, and for OAuth a derived expiry status. It
never prints the key, or a prefix or length of it.

**`nax auth rm <provider>`** calls `store.delete()`, which already serialises
against `modify`. Its output constraint is load-bearing: **it must not say
"logged out"**. pi has no revocation anywhere — its own types define logout as
deletion — so the provider-side token stays live until it expires. The message
says the credential was removed locally and points at the provider's revocation
page.

### 5. The store is wired into the client

`buildNativeClient()` (`src/agents/native/client.ts:22`) currently passes
`{providers, protocols}`, leaving `ClientOptions.credentials` unset so the store
is never consulted. It becomes
`{providers, protocols, credentials: naxCredentialStore()}`. That one field is
what makes `nax auth login` have any effect on a run.

ADR-027 §8's resolution order — store, then ambient environment, then fail — is
already pi-ai's behaviour and is not reimplemented here.
`resolveProviderAuthWithSignal` (`dist/auth/resolve.js:38-53`) reads the store
first and consults ambient sources only when nothing is stored; its docstring
states that a stored credential owns the provider, with no silent environment
fallback after a failed refresh. nax pins this with a test rather than building
it.

The consequence deserves stating in the command's help text, not only here: a
stored credential shadows a working environment variable. That is correct — a
silent fallback after a failed refresh is how a run gets billed to the wrong
account — but it makes `nax auth rm` the fix for "my environment variable is
being ignored", and `auth list` the diagnostic that shows why.

### 6. `hasCredentials()` becomes honest, within the recorded boundary

`AgentAdapter.hasCredentials?()` (`src/agents/types.ts:430`) takes no provider
argument, and the manager cannot supply one: `agentManagerConfigSelector`
(`src/config/selectors.ts:78`) excludes `config.models` by design under ADR-019,
and plan 1's review already recorded that widening that slice was a worse fix
than the bug it addressed.

The honest probe at the granularity the interface offers is therefore: **the
store holds at least one credential, or at least one provider environment
variable is set.** That catches the real failure — `protocol: "native"` enabled
with nothing stored and nothing exported — and fails the run at setup with
`AGENT_CREDENTIALS_MISSING` rather than mid-run.

The residual gap is recorded rather than papered over: this cannot catch
"configured `deepseek` but stored only `openrouter`". That case still surfaces
per provider at request time through the typed mapping plan 1 already ships,
`ProtocolError.kind: "auth"` to `availability` / `fail-auth`.

This also makes ADR-027 §8's "Interface fit" bullet true for the first time.
That bullet already promised `isInstalled()` reports whether credentials
resolve; plan 1 shipped it delegating to a `hasCredentials()` that could not
answer that question. This plan does not change the promise, it keeps it.

Widening `hasCredentials` to take a provider id is deliberately not proposed. It
is an interface change affecting every adapter, for a gap that has a working
path, and it belongs with plan 3's routing work if it is ever worth doing.

### 7. Errors

`check:nax-error` is a ratchet forbidding new `throw new Error` in `src/`, so
every failure is a `NaxError` with a code. nax-ai's typed errors are mapped at
the `src/agents/native/auth.ts` boundary rather than leaking into the CLI:

| nax-ai error | nax behaviour |
|---|---|
| `LoginCancelledError` | exit 130, no error output — Ctrl+C is not a failure |
| `AuthMethodUnavailableError` | message naming the methods the provider does offer |
| `LoginFailedError` | the provider's reason |
| `OAuthFlowProhibitedError` | its own branch: for `github-copilot`, the subscription-clause reason and that a terms review can reverse it |

## Security invariants

Each gets a test that fails if the invariant breaks.

- `login()` returns metadata only — provider, method, kind — never the
  credential. Nothing in nax holds the secret; it is on disk at `0600` under the
  store's lock before `login()` returns.
- No command prints `key`, or any prefix or length of it. It is documented
  opaque and may be a `$VAR` template or a `!command`.
- The secret prompt suppresses echo and restores terminal state on every exit
  path.
- No key reaches `argv`. The interactive-only decision is what guarantees this.
- The credential file is never logged, and a parse failure refuses to overwrite
  rather than starting fresh. This is the store's own behaviour, and it is worth
  a test because "recover by resetting" would silently log the user out of every
  provider at once.

## Testing

`bun:test`, `TEST_LIMIT` 800, mirroring the existing layout:
`test/unit/agents/native/{credentials,auth}.test.ts` and
`test/unit/cli/{auth,auth-prompt}.test.ts`.

The store under test is real, in the preload's temp directory. A memory store
would not exercise the lock or the on-disk shape, which are the parts most
likely to be wrong. nax-ai's `login()` is stubbed through an `_authDeps` seam
following the `_clientDeps` and `_confirmDeps` precedent, and `auth-prompt.ts`
takes the injectable stdin seam `confirm.ts` already proves works.

**The suite must scrub ambient provider environment variables in
`test/preload.ts`.** A developer with `OPENROUTER_API_KEY` exported would see
`hasCredentials()` pass for the wrong reason, and green would mean nothing. This
is the case the preload already handles for Telegram credentials, and it belongs
in the same block rather than in individual tests.

## Verification

One manual live check after implementation: `nax auth import`, then
`nax auth list`, then a real `classify-route` completion over the native path
proving the imported credential is the one used.

Separately, one login run from `dist/nax.js` rather than from source. pi loads
its OAuth flows through a deliberately bundler-opaque dynamic import, so the
bundle is the case that can break while source passes.

## Out of scope

- **Logout.** pi has no revocation. `rm` is deletion, and says so.
- **Credential listing through `CredentialStore`.** The interface has no `list`
  by design; `auth list` reads the file.
- **A non-interactive login path.** See §3.
- **Widening `hasCredentials` to take a provider id.** See §6.
- **Plans 3 and 4** (routing amendments, op cutover). Plan 3 is independent of
  this work and can land in either order.
