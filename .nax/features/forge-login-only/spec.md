# SPEC: Login-only injected forge identity

Closes: #2788

## Summary

Add an explicit login-only mode to the injected forge identity. A caller sets
`NAX_FORGE_IDENTITY=login-only` together with `NAX_FORGE_LOGIN` (and optionally
`NAX_FORGE_USER_ID`), with no `NAX_FORGE_TOKEN_FILE`. nax then answers "who am I" with the injected
login and never calls the forge's `/user`, but it adds no token to any `gh` / `glab` / `git`
subprocess, so those keep the host's ambient, refreshed credentials. Without the opt-in, every
existing rule is unchanged, including `NAX_FORGE_LOGIN requires NAX_FORGE_TOKEN_FILE`.

## Motivation

A fleet host runs `nax run` under a GitHub App. `readCurrentUser`
(`packages/nax/src/forge/trust.ts`) cannot call `GET /user` with an App installation token, so the
host must inject an identity. Today the only injected identity carries a token from
`NAX_FORGE_TOKEN_FILE`, read once at CLI start, and every later `gh` / `glab` spawn
(`tokenEnv` in `packages/nax/src/forge/deps.ts`) and every network `botGit` call
(`packages/nax/src/bot/git.ts`) uses that one token. App installation tokens live 1 hour, so a long
run that publishes at the end (PR create, item threads, item index) fails once the token expires.

A host that already refreshes tokens per call (for example a `gh` wrapper on `PATH` backed by a
credential broker) only needs nax to know the login. Rule 4 of `captureForgeIdentity` refuses a login
without a token file on purpose, to avoid a half-switched identity. When the caller opts in
explicitly, it asserts that the ambient credentials belong to the login it names, so there is no half
switch; without the opt-in a stray `NAX_FORGE_LOGIN` must still fail closed.

## Design

### The inputs

| Variable | Meaning |
|:--|:--|
| `NAX_FORGE_IDENTITY` | New. Optional. The only accepted value is `login-only`. |
| `NAX_FORGE_LOGIN` | Required in login-only mode. |
| `NAX_FORGE_USER_ID` | Optional in login-only mode; same format rule as today. |
| `NAX_FORGE_TOKEN_FILE` | Must be absent in login-only mode. |
| `NAX_FORGE_TOKEN` | Still always rejected. |

Values are trimmed first and an empty value counts as absent, as today (`present()`).

### Rule order in `captureForgeIdentity(env)`

The existing order is kept. A new block, called "rule 2a" here, is inserted after the `NAX_FORGE_TOKEN`
rejection and before the code's "Rule 3: nothing injected", so the token file is still consumed first
and an ambient token is still rejected first:

- Rule 1 (unchanged): token file present: read it and delete it.
- Rule 2 (unchanged): `NAX_FORGE_TOKEN` present: invalid.
- Rule 2a (new), only when `NAX_FORGE_IDENTITY` is present after trimming:
  - value is not exactly `login-only`: invalid, `NAX_FORGE_IDENTITY must be login-only`.
  - a token file was given: invalid, `NAX_FORGE_IDENTITY=login-only does not take NAX_FORGE_TOKEN_FILE`.
    The file has already been consumed by rule 1.
  - no login: invalid, `NAX_FORGE_IDENTITY=login-only requires NAX_FORGE_LOGIN`.
  - `NAX_FORGE_USER_ID` present and not matching `^[1-9][0-9]*$` (or above `Number.MAX_SAFE_INTEGER`):
    invalid, `NAX_FORGE_USER_ID must be a positive integer`. This id check must not go through
    `validateAccount` as it stands, because that function rejects any login without a token file; factor
    the id parse out of it or call a separate helper.
  - otherwise capture `{ login, id? }` with no `token` key, and stop.
- All later rules (the code's rule 3 "nothing injected", `validateAccount`, the token-file rule) run
  exactly as today when `NAX_FORGE_IDENTITY` is absent.

Tests refer to the variable through `FORGE_IDENTITY_ENV.mode`, as existing tests use
`FORGE_IDENTITY_ENV.tokenFile`.

Every rejection is a `NaxError` with code `FORGE_IDENTITY_INVALID`, context `{ stage: "forge" }`, and
the message prefix `[forge] Invalid injected forge identity: `, as today.

### Integration

Read-only (verified, unchanged):

- `export const _forgeIdentity: { current: InjectedForgeIdentity | undefined }` and
  `export function injectedForgeIdentity(): InjectedForgeIdentity | undefined` in
  `packages/nax/src/forge/identity.ts`.
- `export async function readCurrentUser(ref: PrRef, deps: ForgeDeps, cwd: string): Promise<CurrentUser>`
  in `packages/nax/src/forge/trust.ts`. It already returns `{ login, id? }` from `deps.identity?.()`
  whenever the identity has a login, without calling `api user`; login-only always has a login, so it
  needs no change.
- `defaultForgeDeps.identity` (`packages/nax/src/forge/deps.ts`) is `injectedForgeIdentity`.

Changed (the baseline exists only to locate the code; implement the target):

- `InjectedForgeIdentity` in `packages/nax/src/forge/identity.ts`
  - Baseline: `{ readonly token: string; readonly login?: string; readonly id?: number }`
  - Target: `{ readonly token?: string; readonly login?: string; readonly id?: number }`. A login-only
    identity has no `token` key at all (not `token: undefined`).
- `FORGE_IDENTITY_ENV` in the same file
  - Target: gains `mode: "NAX_FORGE_IDENTITY"`; the other keys are unchanged.
- `tokenEnv(cmd)` in `packages/nax/src/forge/deps.ts`
  - Target: returns `undefined` when the identity has no token, so the spawn keeps its ambient
    environment exactly as with no identity.
- `botGit(args, workdir, timeoutMs?, maxBytes?)` in `packages/nax/src/bot/git.ts`
  - Target: the credential-helper prefix and the `BOT_GIT_TOKEN_ENV` overlay require a captured identity
    WITH a token. A login-only identity on a network verb gets the plain `BOT_GIT_HOOKS_OFF` prefix (no
    `credential.helper` arguments) and an env overlay of `GIT_TERMINAL_PROMPT=0` only, so git uses the
    host's ambient credential helper and an expired ambient credential fails at once instead of prompting.
    A non-network verb is unchanged.

ACs 10, 11, 17 and 18 are intentional pins of behaviour that already holds; 17 and 18 become red before
the type change only through the typecheck gate (a token-less identity literal), not through `bun test`.

### Failure Handling

| Input | Behaviour |
|:--|:--|
| `NAX_FORGE_IDENTITY` set to anything other than `login-only` | invalid, `NAX_FORGE_IDENTITY must be login-only`; CLI exits 1 before any command (existing `bin/nax.ts` handling). |
| login-only with `NAX_FORGE_TOKEN_FILE` | file consumed (deleted), then invalid, `NAX_FORGE_IDENTITY=login-only does not take NAX_FORGE_TOKEN_FILE`. |
| login-only without `NAX_FORGE_LOGIN` | invalid, `NAX_FORGE_IDENTITY=login-only requires NAX_FORGE_LOGIN`. |
| login-only with a malformed `NAX_FORGE_USER_ID` | invalid, `NAX_FORGE_USER_ID must be a positive integer`. |
| login-only, ambient `gh` credentials belong to another account | not detected; the caller asserted they match by opting in (see Out of Scope). |

## Out of Scope

- Verifying that the ambient `gh` / `glab` / `git` credentials belong to the injected login. An App installation token cannot call `/user`, so nax cannot check it; the explicit `NAX_FORGE_IDENTITY=login-only` opt-in is the caller's assertion.
- Re-reading or refreshing a token file during a run. Token-file mode keeps its read-once-at-start behaviour.
- Any change to the error text of the existing rules when `NAX_FORGE_IDENTITY` is absent, including `NAX_FORGE_LOGIN requires NAX_FORGE_TOKEN_FILE`.
- A user guide page for the injected forge identity; none exists for the token-file mode either.
- Changes to `bin/nax.ts`; it already prints the refusal message and exits 1.

## Stories

### US-001: Login-only injected forge identity

No dependencies. Workdir: `packages/nax`

Add the `NAX_FORGE_IDENTITY=login-only` mode to `captureForgeIdentity`, make the identity token
optional, and make `tokenEnv` and `botGit` add no credentials when the identity has no token.

### Context Files

**US-001**
- `packages/nax/src/forge/identity.ts` - capture rules and the identity type
- `packages/nax/src/forge/deps.ts` - `tokenEnv` for `gh` / `glab` spawns
- `packages/nax/src/bot/git.ts` - `botGit` credential injection
- `packages/nax/src/forge/trust.ts` - `readCurrentUser`, already answers from an injected login
- `packages/nax/test/unit/forge/identity.test.ts` - existing capture-rule tests to extend
- `packages/nax/test/unit/forge/deps-identity.test.ts` - real-spawn `gh` / `glab` fixtures and token-variable save/restore to extend
- `packages/nax/test/unit/bot/git-identity.test.ts` - `botGit` spawn stub and env capture to extend
- `packages/nax/test/unit/forge/identity-trust.test.ts` - `readCurrentUser` harness to extend
- `packages/nax/test/integration/cli/forge-identity-startup.test.ts` - CLI startup refusal tests to extend

### Modifies

None. Every existing test keeps passing: the new rules apply only when `NAX_FORGE_IDENTITY` is
present, existing tests never set it, and making `token` optional does not invalidate any identity
literal the tests construct.

### Seams

None. No new exported symbol is consumed by another story; the consumers (`tokenEnv`, `botGit`,
`readCurrentUser`) are exercised directly in US-001's ACs.

## Acceptance Criteria

### US-001

1. [unit] `captureForgeIdentity` with `NAX_FORGE_IDENTITY=login-only` and `NAX_FORGE_LOGIN=acme-bot[bot]`, and no token file, resolves to an identity strictly equal to `{ login: "acme-bot[bot]" }` with no own `token` property (a `token: undefined` key fails), and `injectedForgeIdentity()` returns the same object.
2. [unit] `captureForgeIdentity` with `NAX_FORGE_IDENTITY=login-only`, `NAX_FORGE_LOGIN=acme-bot[bot]` and `NAX_FORGE_USER_ID=42` resolves to exactly `{ login: "acme-bot[bot]", id: 42 }`.
3. [unit] `captureForgeIdentity` with `NAX_FORGE_IDENTITY` surrounded by whitespace (`"  login-only  "`) and a login is accepted as login-only mode.
4. [unit] `captureForgeIdentity` with `NAX_FORGE_IDENTITY=token` and a login rejects with a `NaxError` whose code is `FORGE_IDENTITY_INVALID` and whose message contains `NAX_FORGE_IDENTITY must be login-only`.
5. [unit] `captureForgeIdentity` with `NAX_FORGE_IDENTITY=login-only` and no `NAX_FORGE_LOGIN` rejects with code `FORGE_IDENTITY_INVALID` and a message containing `NAX_FORGE_IDENTITY=login-only requires NAX_FORGE_LOGIN`.
6. [unit] `captureForgeIdentity` with `NAX_FORGE_IDENTITY=login-only`, a login and a real `NAX_FORGE_TOKEN_FILE` rejects with a message containing `NAX_FORGE_IDENTITY=login-only does not take NAX_FORGE_TOKEN_FILE`, the token file no longer exists on disk afterwards, and neither the message nor `error.context` contains the file's token value.
7. [unit] `captureForgeIdentity` with `NAX_FORGE_IDENTITY=login-only`, a login and `NAX_FORGE_TOKEN` set rejects with the existing message `NAX_FORGE_TOKEN is not supported` (the ambient-token rule wins over the mode rules), and neither the message nor the error context contains the token value.
8. [unit] `captureForgeIdentity` with `NAX_FORGE_IDENTITY=login-only`, a login and `NAX_FORGE_USER_ID=0` rejects with a message containing `NAX_FORGE_USER_ID must be a positive integer`.
9. [unit] after a rejected login-only capture, `injectedForgeIdentity()` returns `undefined`, even when an identity had been captured before the call.
10. [unit] `captureForgeIdentity` with `NAX_FORGE_LOGIN` set and neither `NAX_FORGE_IDENTITY` nor a token file still rejects with the existing message `NAX_FORGE_LOGIN requires NAX_FORGE_TOKEN_FILE`.
11. [unit] `captureForgeIdentity` with `NAX_FORGE_IDENTITY` set to whitespace only, a login and no token file treats the mode as absent and rejects with `NAX_FORGE_LOGIN requires NAX_FORGE_TOKEN_FILE`.
12. [integration] with a login-only identity captured and `GH_TOKEN=ambient-token` set by the test in the parent environment (saved and restored around the test), `defaultForgeDeps.run` spawning a stub `gh` script receives `GH_TOKEN` equal to `ambient-token` (nax adds no token of its own).
13. [integration] with a login-only identity captured and `GITLAB_TOKEN` unset in the parent environment, `defaultForgeDeps.run` spawning a stub `glab` script sees no `GITLAB_TOKEN` variable.
14. [unit] with a login-only identity captured, `botGit(["push", "origin", "HEAD"], workdir)` spawns git with the plain hooks-off prefix and no `credential.helper` arguments, the same argv it produces with no identity captured.
15. [unit] with a login-only identity captured, the git process spawned by `botGit(["fetch", "origin"], workdir)` receives `GIT_TERMINAL_PROMPT` equal to `0` and no `BOT_GIT_TOKEN_ENV` variable; the test deletes `GIT_TERMINAL_PROMPT` and `BOT_GIT_TOKEN_ENV` from the parent environment first and restores them after.
16. [unit] with a login-only identity captured, the git process spawned by `botGit(["status"], workdir)` (a non-network verb) receives the same environment as the same call with no identity captured.
17. [unit] with a login-only identity `{ login: "acme-bot[bot]", id: 42 }` returned by `deps.identity`, `readCurrentUser` for a GitHub PR ref returns `{ login: "acme-bot[bot]", id: 42 }` and `deps.run` is never called.
18. [unit] with a login-only identity `{ login: "group-bot" }` returned by `deps.identity`, `readCurrentUser` for a GitLab PR ref returns `{ login: "group-bot" }` and `deps.run` is never called.
19. [cli] running the CLI as `nax --version` with `NAX_FORGE_IDENTITY=other` and `NAX_FORGE_LOGIN` set exits 1, and stderr has a line starting `[forge] Invalid injected forge identity:` that contains `NAX_FORGE_IDENTITY must be login-only`.
20. [cli] running the CLI as `nax --version` with `NAX_FORGE_IDENTITY=login-only` and `NAX_FORGE_LOGIN` set, and no token file, exits 0 and prints the nax version.
