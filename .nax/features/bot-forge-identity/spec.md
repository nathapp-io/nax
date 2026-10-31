# SPEC: Injected forge identity for nax bot and forge commands

## Summary

A caller that drives nax on a forge (GitHub or GitLab) can hand nax the identity to act as: a token
in a file named by `NAX_FORGE_TOKEN_FILE`, and the bot login in `NAX_FORGE_LOGIN`. nax reads the token
file once when the CLI starts and deletes it, so nothing nax spawns later can read the token from disk
or from its environment. With an identity injected, nax stops asking the forge "who am I"
(`gh api user` / `glab api user`), uses the injected login for its three identity checks (PR trust,
finding its own comments, resolving only its own threads), and hands the token only to its own
`gh` / `glab` subprocesses and to the network `git` calls `nax bot` makes. With nothing injected,
behaviour is unchanged.

## Motivation

Today `nax bot review` and `nax bot fix` act as whoever `gh` / `glab` is logged in as on the machine.
`readCurrentUser` (`packages/nax/src/forge/trust.ts`) calls `api user`, and three things hang off the
answer:

- trust: `classifyPrTrust` treats a PR whose author is the current user as trusted;
- own comments: `findOwnComments` (`forge/marker.ts`) keeps only marked comments authored by the
  current user, so the review edits its summary in place;
- own threads: the bot resolves only threads it opened.

A caller that wants the review posted by a dedicated bot account cannot get there:

1. A GitHub App installation token cannot call `/user`, so `readCurrentUser` fails. Trust then fails
   closed on every PR, `findOwnComments` finds nothing (a fresh summary every run), and no thread can
   be resolved.
2. A token in nax's environment reaches everything nax spawns. Bun copies the process environment at
   startup: a `Bun.spawn` that passes no `env` inherits the startup copy even after the variable is
   deleted from `process.env` (verified on Bun 1.4.4, also with libc `unsetenv`), and several nax spawn
   sites pass no `env`. `buildAllowedEnv` (`agents/shared/env.ts`) also forwards every `NAX_` variable
   to agent sessions. So the token must never be an environment variable of the nax process.
3. `nax bot fix` fetches and pushes with `git`, which has no way to receive a token from nax without
   writing it into `.git/config` or the command line.

## Design

### The inputs

| Variable | Required | Meaning |
|:--|:--|:--|
| `NAX_FORGE_TOKEN_FILE` | yes, to inject | Path to a file whose contents are the forge token. nax reads it once at CLI start and deletes it. |
| `NAX_FORGE_LOGIN` | GitHub: yes. GitLab: optional | The login the token acts as, in the REST form (`acme-bot[bot]` for a GitHub App). |
| `NAX_FORGE_USER_ID` | optional, needs a login | The numeric account id of that login. When present, identity comparisons use the id. |
| `NAX_FORGE_TOKEN` | never | Rejected: a token in the environment cannot be hidden from child processes. |

Rules, applied once at CLI start by `captureForgeIdentity(env)`; values are trimmed of surrounding
whitespace first, and an empty value counts as absent. The token file is consumed first, so that no
rejection leaves it on disk:

1. If `NAX_FORGE_TOKEN_FILE` is present, read it (`Bun.file(path).text()`, contents trimmed), then delete
   it (`_forgeIdentityDeps.deleteFile(path)`, by default `Bun.file(path).delete()`), whatever the rest of
   the input says. A delete that fails with `ENOENT` is not a failure (nothing is on disk). Any other
   delete failure: invalid, `NAX_FORGE_TOKEN_FILE could not be deleted`. nax never runs with the token
   still on disk. The guarantee covers the named path: when it is a symlink, the link is removed and the
   target is the caller's.
2. `NAX_FORGE_TOKEN` present: invalid, `NAX_FORGE_TOKEN is not supported; pass the token through NAX_FORGE_TOKEN_FILE`.
3. No token file, no login and no id: no identity; behaviour is exactly as before this feature.
4. A login or an id without a token file: invalid. The login is checked first: `NAX_FORGE_LOGIN requires
   NAX_FORGE_TOKEN_FILE`, else `NAX_FORGE_USER_ID requires NAX_FORGE_TOKEN_FILE`. It would change who nax
   trusts while the token in use stays the machine's ambient login.
5. An id without a login: invalid, `NAX_FORGE_USER_ID requires NAX_FORGE_LOGIN`.
6. `NAX_FORGE_USER_ID` must match `^[1-9][0-9]*$` and be at most `Number.MAX_SAFE_INTEGER`; otherwise
   invalid, `NAX_FORGE_USER_ID must be a positive integer`.
7. The read in rule 1 failed: invalid, `NAX_FORGE_TOKEN_FILE cannot be read`. The trimmed contents are
   empty: invalid, `NAX_FORGE_TOKEN_FILE is empty`.
8. Otherwise an identity `{ token, login?, id? }` is captured.

The rules are checked in that order; the first that fails decides the message. An invalid input makes
the CLI write one line to stderr, `[forge] Invalid injected forge identity: <message>`, and exit 1 before
any command runs. The `NaxError` carries code `FORGE_IDENTITY_INVALID` and context `{ stage: "forge" }`.
No message or context contains the token value. `NAX_FORGE_LOGIN`, `NAX_FORGE_USER_ID` and
`NAX_FORGE_TOKEN_FILE` stay in the environment; none is secret, and the file is gone. Logins are
compared exactly as given (case-sensitive), as today.

The GitHub "login required" rule cannot be checked at startup (the forge is not known until a PR ref
is resolved), so it is enforced in `readCurrentUser` (below).

### Where the identity is used

- `readCurrentUser(ref, deps, cwd)`:
  - identity with a login: returns `{ login, id? }` from the identity and makes no `deps.run` call;
  - identity without a login on GitHub: throws `NaxError` code `FORGE_IDENTITY_LOGIN_REQUIRED` with
    message `[forge] NAX_FORGE_LOGIN is required with NAX_FORGE_TOKEN_FILE on GitHub`;
    `classifyPrTrust` already turns a thrown `readCurrentUser` into an untrusted result (fail closed);
  - identity without a login on GitLab: calls `api user` as today; the token reaches `glab` through
    `defaultRun`, so the answer is the token's own bot user;
  - no identity: unchanged.
- GitHub review-thread authors: the GraphQL query in `forge/threads.ts` (`REVIEW_THREADS_QUERY`) also
  asks for the author's `__typename`; `githubThread` maps an author whose `__typename` is `Bot` to
  `<login>[bot]`, the REST form. GitHub's GraphQL API returns a bot's login without the `[bot]` suffix,
  so without this a bot's own thread comments never match its REST-form login, and a human account
  named like the bot's slug could pass as the bot. A `User` author keeps its login unchanged.
- `defaultRun(cmd, opts)`: when an identity is captured and the program `cmd[0]` is `gh` (the bare name
  or a path ending in `/gh`), the spawn environment gains `GH_TOKEN=<token>` and
  `GH_ENTERPRISE_TOKEN=<token>` (`gh` reads the second for GitHub Enterprise Server hosts); when it is
  `glab` (bare or a path ending in `/glab`), it gains `GITLAB_TOKEN=<token>`. Any other program
  (including `git`) gets no token. The token is never added to `cmd`.
- `botGit(args, ...)` (`packages/nax/src/bot/git.ts`): when an identity is captured and the git verb
  (`args[0]`; every current caller passes the verb first) is `fetch` or `push`, the argv gains `-c credential.helper=` (clears every configured helper) followed by
  `-c credential.helper=<NAX_BOT_CREDENTIAL_HELPER>`, and that one process gets
  `NAX_FORGE_GIT_TOKEN=<token>` and `GIT_TERMINAL_PROMPT=0` (a rejected token fails instead of
  prompting) through the new `gitWithTimeout` env overlay. The helper answers a
  `get` whose input carries `protocol=https` with `username=x-access-token` and
  `password=$NAX_FORGE_GIT_TOKEN`; for any other protocol, and for `store` / `erase`, it prints
  nothing. `x-access-token` is the GitHub App HTTPS username, and GitLab accepts any non-empty username
  with a token. Other verbs are unchanged. The token is never written to `.git/config` and never
  appears in argv.

Because every forge-touching command reads identity through `readCurrentUser` and spawns through
`defaultRun`, the identity applies to `nax bot review`, `nax bot fix`, the workflow commands that post
threads or rulings, and the finish phase's forge calls, with no per-command wiring. This is
deliberate: a half-switched identity (bot posts as the injected login, a workflow command still
compares against the ambient login) would break own-comment discovery.

The commit author of a `nax bot fix` commit is not decided by nax: the caller sets the standard
`GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` / `GIT_COMMITTER_NAME` / `GIT_COMMITTER_EMAIL` variables if it
wants bot-authored commits, and nax passes them through as it does today.

### Integration

Read-only (verified at `origin/main` `6e77284b6`):

- `classifyPrTrust(ref: PrRef, info: PrInfo, deps: ForgeDeps, cwd: string): Promise<PrTrust>`
  (`packages/nax/src/forge/trust.ts`): compares `info.author` with `readCurrentUser`, by id when both
  ids are present, else by login; falls back to `hasWriteAccess` (`forge/access.ts`). The PR author
  comes from REST (`forge/pr-read.ts`, `reply.user.login`), so it is already in the `[bot]` form.
- `findOwnComments(ref, deps, cwd)` (`forge/marker.ts`): `readCurrentUser` then `ownComments(comments,
  user.login)`, an exact string comparison.
- `gitSpawnEnv(overlay?)` (`packages/nax-agent/src/internal/git-env.ts`): `hardenedGitEnv({...process.env,
  ...overlay})`. Hardening adds `GIT_CONFIG_*` entries and leaves credential settings alone.
- Network bot git call sites, all through `botGit`: `fetch` in `bot/checkout.ts`, `push --dry-run` in
  `checkPushAccess` (`bot/fix-input.ts`), `push` in `pushStep` (`bot/fix-steps.ts`).
- CLI entry: `packages/nax/bin/nax.ts`. Its first import must stay `../src/agent-runtime/install`
  (pinned by `test/unit/agent-runtime/install.test.ts`); it builds `const program = new Command()` and
  parses with `parseAsync`, which handles `--version`. Startup errors in `bin/` already use
  `console.error` + `process.exit(1)` (`bin/run-action.ts`).

Changed. The baseline locates the code; implement the target.

- `gitWithTimeout` (`packages/nax-agent/src/internal/git-exec.ts`)
  - Baseline: `gitWithTimeout(args, workdir, timeoutMs?, maxBytes?, argvOverride?)`, spawn env
    `hardenedGitEnv(process.env)`.
  - Target: `gitWithTimeout(args, workdir, timeoutMs?, maxBytes?, argvOverride?, envOverlay?:
    Readonly<Record<string, string>>)`, spawn env `hardenedGitEnv({ ...process.env, ...envOverlay })`
    when `envOverlay` is given, unchanged otherwise.
- `ForgeDeps` (`packages/nax/src/forge/types.ts`)
  - Baseline: `{ run(cmd, opts); readText(path) }`.
  - Target: adds optional `identity?(): InjectedForgeIdentity | undefined`. `defaultForgeDeps.identity`
    returns the captured identity. Test fakes that omit it behave as "no identity".
- `readCurrentUser` (`forge/trust.ts`): same signature; reads `deps.identity?.()` first (rules above).
- `REVIEW_THREADS_QUERY` / `githubThread` (`forge/threads.ts`)
  - Baseline: `author { login }`; `author: comment.author?.login ?? "ghost"`.
  - Target: `author { login __typename }`; a `Bot` author maps to `<login>[bot]`, anything else as before.
- `defaultRun` (`forge/deps.ts`): same signature; spawn env becomes `gitSpawnEnv(overlay)` with the token
  overlay above, `gitSpawnEnv()` when no identity or another program.
- `botGit` (`bot/git.ts`): same signature; adds the credential-helper prefix and env overlay above.

New, in `packages/nax/src/forge/identity.ts`, exported from the `@/forge` barrel:

```typescript
export interface InjectedForgeIdentity { readonly token: string; readonly login?: string; readonly id?: number }

export const FORGE_IDENTITY_ENV = {
  tokenFile: "NAX_FORGE_TOKEN_FILE",
  login: "NAX_FORGE_LOGIN",
  userId: "NAX_FORGE_USER_ID",
  rejectedToken: "NAX_FORGE_TOKEN",
} as const;

/** Mutable holder in the _deps style; tests set it and must reset it to undefined in afterEach. */
export const _forgeIdentity: { current: InjectedForgeIdentity | undefined } = { current: undefined };

/** Injectable file delete; the default is `(path) => Bun.file(path).delete()`. */
export const _forgeIdentityDeps: { deleteFile(path: string): Promise<void> };

/** Apply the input rules to `env`, read and delete the token file, store the result in
 *  `_forgeIdentity.current`. Resolves to the identity or undefined; rejects with NaxError code
 *  FORGE_IDENTITY_INVALID. */
export function captureForgeIdentity(env: Record<string, string | undefined>): Promise<InjectedForgeIdentity | undefined>;

export function injectedForgeIdentity(): InjectedForgeIdentity | undefined; // returns _forgeIdentity.current
```

`bin/nax.ts` imports `captureForgeIdentity` after the `agent-runtime/install` import and awaits
`captureForgeIdentity(process.env)` before `new Command()`. ES imports are evaluated first, so the
capture runs after module evaluation and before any command; no imported module spawns at import time.
On `FORGE_IDENTITY_INVALID` it prints the message line to stderr and exits 1.

New, in `packages/nax/src/bot/git.ts`: `NAX_BOT_CREDENTIAL_HELPER`, the helper string in git's shell
function form, `!f() { ...; }; f`. Git strips the leading `!`, appends the action, and runs the rest
with `sh -c`, so `$1` is the action and the `protocol=` / `host=` lines arrive on stdin. It prints with
`printf '%s\n'` and exits 0 in every case. The ACs drive it through that same harness: the string
without its leading `!`, followed by the action, run by `sh -c` with the input on stdin.

### Failure Handling

| Situation | Behaviour |
|:--|:--|
| Any input rule 1, 3-7 fails | CLI exits 1 before any command; one stderr line `[forge] Invalid injected forge identity: <message>`; the message never contains the token. |
| GitHub PR, token injected, no login | `readCurrentUser` throws `FORGE_IDENTITY_LOGIN_REQUIRED`; `classifyPrTrust` returns untrusted with a reason naming the failure; no `api user` call. |
| Forge rejects the injected token (expired, missing permission) | Unchanged existing behaviour: the `gh` / `glab` / `git` call fails and its existing error path reports it. No retry and no fallback to the ambient login (see Out of Scope). |

## Out of Scope

- Minting, refreshing or rotating the token: the caller supplies a valid token per process; a process that outlives its token fails at the next forge call through the existing error path.
- Handling a forge that rejects the injected token: no new retry, no fallback to the ambient login, and no new error message; the existing per-call error paths are unchanged.
- A token passed in the environment or on stdin; `NAX_FORGE_TOKEN` is rejected at startup.
- A token file on a read-only mount: the file must be deletable, or the CLI refuses to start.
- Live verification against a real GitLab project or group access token; GitLab is covered by unit tests with fakes only.
- Self-managed GitLab host selection (`GITLAB_HOST`); `GITLAB_TOKEN` is applied to whatever host `glab` resolves.
- Scoping the git credential helper to one host: it answers any `https` host `origin` points at, which is the repository the caller pointed nax at.
- Setting the commit author of `nax bot fix` commits; the caller uses the standard `GIT_AUTHOR_*` / `GIT_COMMITTER_*` variables.
- The auto-pr builtin plugin's own subprocess runner (`plugins/builtin/auto-pr/index.ts`) and the finish phase's own `git push` (`finish/commit.ts`): they do not receive the token from this feature.
- GitLab thread and note author forms: GitLab returns the same `username` from every API, so no mapping is added.
- Migrating comments or threads posted under a previous login; after a switch they no longer count as the bot's own.
- Hiding the identity from in-process plugin code that imports `@/forge`; the guarantee is about child processes and the token file.
- Propagating an injected identity to nax processes that nax itself launches (for example the jobs `nax chat` starts): they inherit `NAX_FORGE_TOKEN_FILE` naming a deleted file and refuse to start with `NAX_FORGE_TOKEN_FILE cannot be read`. Running `nax chat` with an injected identity is unsupported.
- Case-insensitive login matching; `NAX_FORGE_LOGIN` must match the forge's login exactly, or own-comment and trust checks fail closed.
- A token containing an internal newline; the caller supplies a well-formed token.
- `botGit` verb detection behind a leading global git option (`-C`, `-c`); every current caller passes the verb as `args[0]`.
- User documentation for the variables.

## Stories

### US-001 — `gitWithTimeout` takes an environment overlay

Workdir: packages/nax-agent. No dependencies.

`gitWithTimeout` gains an optional sixth parameter `envOverlay`; when given, the spawned git process's
environment is the hardened merge of `process.env` and the overlay. Callers that pass nothing are
unchanged. Verification note: `bun run check:api` passes (the API snapshot lists names only).

### US-002 — Capture the injected identity at CLI start

Workdir: packages/nax. No dependencies.

Adds `packages/nax/src/forge/identity.ts` (`InjectedForgeIdentity`, `FORGE_IDENTITY_ENV`,
`_forgeIdentity`, `captureForgeIdentity`, `injectedForgeIdentity`) exported from `@/forge`, and awaits
`captureForgeIdentity(process.env)` in `bin/nax.ts` before the command tree is built. The `[cli]` ACs
spawn `bin/nax.ts`, as the existing `cli-trust-gate` and `cli-credentials-bootstrap` tests do: the
entry-point wiring cannot be observed any other way. This is the documented exception to the
`forbidden-patterns-tests.md` rule against spawning a full `nax` process: the two `[cli]` ACs stay the
only ones that do. Tests that set `_forgeIdentity.current` reset it in `afterEach`, because suites run
without isolation and a leaked identity changes other tests' `botGit` argv.

### US-003 — Forge calls use the injected identity

Workdir: packages/nax. Depends on US-002.

`ForgeDeps` gains optional `identity()`; `defaultForgeDeps.identity` returns the captured identity.
`readCurrentUser` returns the injected login (or fails closed on GitHub without one), GitHub GraphQL
thread authors of type `Bot` gain the `[bot]` suffix, and `defaultRun` adds `GH_TOKEN` /
`GH_ENTERPRISE_TOKEN` / `GITLAB_TOKEN` to `gh` / `glab` spawns only.

### US-004 — Bot network git calls authenticate with the injected token

Workdir: packages/nax. Depends on US-001, US-002.

`botGit` adds the credential-helper prefix and the `NAX_FORGE_GIT_TOKEN` env overlay for `fetch` and
`push` when an identity is captured; adds `NAX_BOT_CREDENTIAL_HELPER`.

### Context Files

**US-001**

- `packages/nax-agent/src/internal/git-exec.ts` — `gitWithTimeout`, the function this story extends.
- `packages/nax-agent/src/internal/git-env.ts` — `hardenedGitEnv` / `gitSpawnEnv`, the env merge to mirror.
- `packages/nax-agent/test/unit/internal/git-env.test.ts` — existing env-hardening test patterns.

**US-002**

- `packages/nax/bin/nax.ts` — CLI entry; the capture call goes before `new Command()`.
- `packages/nax/src/forge/index.ts` — the barrel that exports the new module.
- `packages/nax/test/unit/agent-runtime/install.test.ts` — pins the first import of `bin/nax.ts`.
- `packages/nax/test/integration/cli/cli-trust-gate.test.ts` — pattern for spawning `bin/nax.ts` in a test.
- `packages/nax/test/unit/forge/threads.test.ts` — existing assertion on the GraphQL query text (US-003 pattern).

**US-003**

- `packages/nax/src/forge/trust.ts` — `readCurrentUser`, `classifyPrTrust`.
- `packages/nax/src/forge/deps.ts` — `defaultRun`, `defaultForgeDeps`.
- `packages/nax/src/forge/types.ts` — `ForgeDeps`.
- `packages/nax/src/forge/threads.ts` — `REVIEW_THREADS_QUERY`, `githubThread`.
- `packages/nax/src/forge/marker.ts` — `findOwnComments`, a consumer of `readCurrentUser`.

**US-004**

- `packages/nax/src/bot/git.ts` — `botGit`, `BOT_GIT_HOOKS_OFF`.
- `packages/nax/src/bot/fix-input.ts` — `checkPushAccess`, a network `botGit` caller.
- `packages/nax/test/unit/bot/git.test.ts` — `_gitDeps.spawn` + `makeSpawn` test pattern.

### Creates

**US-002**

- `packages/nax/src/forge/identity.ts` — the identity module.
- `packages/nax/test/unit/forge/identity.test.ts` — unit tests for the input rules and the token file.
- `packages/nax/test/integration/cli/forge-identity-startup.test.ts` — CLI startup tests.

**US-003**

- `packages/nax/test/unit/forge/identity-trust.test.ts` — `readCurrentUser`, trust, thread-author and own-comment tests with an injected identity.
- `packages/nax/test/unit/forge/deps-identity.test.ts` — `defaultRun` token tests.

**US-004**

- `packages/nax/test/unit/bot/git-identity.test.ts` — `botGit` credential tests.
- `packages/nax/test/integration/bot/credential-helper.test.ts` — the helper run by a real git.

### Modifies

None. Every changed function keeps its signature (new parameters and `ForgeDeps.identity` are optional),
and with no identity captured every spawn argv and environment is unchanged, so existing tests that pin
`botGit` argv (`test/unit/bot/git.test.ts`) or env stay valid. Thread-reply fixtures without
`__typename` keep their login unchanged under the new mapping.

### Seams

- `injectedForgeIdentity` / `_forgeIdentity` (US-002) are read by `defaultForgeDeps.identity` and
  `defaultRun` (US-003) and by `botGit` (US-004); the US-003 `defaultRun` fixture ACs and the US-004
  `botGit` / `checkPushAccess` ACs set the identity through `captureForgeIdentity` and observe the spawn.
- `gitWithTimeout`'s `envOverlay` (US-001) is consumed by `botGit` (US-004); the US-004 `botGit` push AC
  asserts the overlay reaches the spawned git process environment (`NAX_FORGE_GIT_TOKEN` in the spawn env).
- `captureForgeIdentity` (US-002) is called from the CLI entry `bin/nax.ts`; the US-002 `[cli]` ACs run
  the CLI and observe the token file being deleted and the invalid-input exit.

## Acceptance Criteria

The token value used in tests is `tok-7f3a9c`. A "fixture" is an executable shell script in a temporary
directory that prints the requested values with `printf '%s'` (no trailing newline).

### US-001 — `gitWithTimeout` takes an environment overlay

- `[unit]` `gitWithTimeout(["fetch"], "/repo", undefined, undefined, undefined, { NAX_FORGE_GIT_TOKEN: "tok-7f3a9c" })` spawns git with an environment whose `NAX_FORGE_GIT_TOKEN` is `tok-7f3a9c`.
- `[unit]` `gitWithTimeout` called with an `envOverlay` still applies the hardened git settings: the spawned environment carries the same `GIT_CONFIG_*` entries as a call without an overlay.
- `[unit]` `gitWithTimeout(["status"], "/repo")` with no overlay spawns git with an environment that has no `NAX_FORGE_GIT_TOKEN` key when `process.env` has none.

### US-002 — Capture the injected identity at CLI start

- `[unit]` `captureForgeIdentity({})` resolves to `undefined` and leaves `_forgeIdentity.current` `undefined`.
- `[unit]` `captureForgeIdentity({ NAX_FORGE_TOKEN_FILE: <file containing "tok-7f3a9c\n">, NAX_FORGE_LOGIN: "acme-bot[bot]" })` resolves to `{ token: "tok-7f3a9c", login: "acme-bot[bot]" }`, and `injectedForgeIdentity()` then returns the same value.
- `[unit]` with a token file and `NAX_FORGE_LOGIN: "acme-bot[bot]"`, `NAX_FORGE_USER_ID: "42"`, `captureForgeIdentity` resolves to an identity whose `id` is the number `42`.
- `[unit]` with only a token file, `captureForgeIdentity` resolves to `{ token: "tok-7f3a9c" }` with no `login` and no `id`.
- `[unit]` with a token file and `NAX_FORGE_LOGIN: "  acme-bot[bot]\n"`, the resolved identity's `login` is `acme-bot[bot]`.
- `[unit]` after `captureForgeIdentity` resolves an identity from a token file, that file no longer exists.
- `[unit]` `captureForgeIdentity({ NAX_FORGE_TOKEN: "tok-7f3a9c" })` rejects with a `NaxError` code `FORGE_IDENTITY_INVALID` whose message contains `NAX_FORGE_TOKEN is not supported`, and the message text omits `tok-7f3a9c`.
- `[unit]` `captureForgeIdentity({ NAX_FORGE_TOKEN_FILE: "  ", NAX_FORGE_LOGIN: "acme-bot[bot]" })` rejects with a message containing `NAX_FORGE_LOGIN requires NAX_FORGE_TOKEN_FILE` (a blank path counts as absent).
- `[unit]` with a token file and `NAX_FORGE_USER_ID: "42"` but no login, `captureForgeIdentity` rejects with a message containing `NAX_FORGE_USER_ID requires NAX_FORGE_LOGIN`.
- `[unit]` with a token file, a login and `NAX_FORGE_USER_ID: "4x"`, `captureForgeIdentity` rejects with a message containing `NAX_FORGE_USER_ID must be a positive integer`.
- `[unit]` with a token file, a login and `NAX_FORGE_USER_ID: "9007199254740993"`, `captureForgeIdentity` rejects with a message containing `NAX_FORGE_USER_ID must be a positive integer`.
- `[unit]` with `NAX_FORGE_TOKEN_FILE` naming a path that does not exist, `captureForgeIdentity` rejects with a message containing `NAX_FORGE_TOKEN_FILE cannot be read`.
- `[unit]` with a token file whose contents are only whitespace, `captureForgeIdentity` rejects with a message containing `NAX_FORGE_TOKEN_FILE is empty`.
- `[unit]` with a token file and `_forgeIdentityDeps.deleteFile` stubbed to throw an `EACCES` error, `captureForgeIdentity` rejects with a message containing `NAX_FORGE_TOKEN_FILE could not be deleted`, and the message text omits `tok-7f3a9c`.
- `[unit]` with `NAX_FORGE_TOKEN: "tok-7f3a9c"` and a valid token file, `captureForgeIdentity` rejects with a message containing `NAX_FORGE_TOKEN is not supported`, and the token file no longer exists.
- `[unit]` with a valid token file, a login and `NAX_FORGE_USER_ID: "4x"`, after `captureForgeIdentity` rejects, the token file no longer exists.
- `[unit]` with no token file, `NAX_FORGE_LOGIN: "acme-bot[bot]"` and `NAX_FORGE_USER_ID: "42"`, `captureForgeIdentity` rejects with a message containing `NAX_FORGE_LOGIN requires NAX_FORGE_TOKEN_FILE`.
- `[unit]` `captureForgeIdentity({ NAX_FORGE_USER_ID: "42" })` rejects with a message containing `NAX_FORGE_USER_ID requires NAX_FORGE_TOKEN_FILE`.
- `[unit]` with a token file, a login and `NAX_FORGE_USER_ID: "042"`, `captureForgeIdentity` rejects with a message containing `NAX_FORGE_USER_ID must be a positive integer`.
- `[unit]` with a token file, a login and `NAX_FORGE_USER_ID: "9007199254740991"`, the resolved identity's `id` is `9007199254740991`.
- `[cli]` running `bin/nax.ts --version` with `NAX_FORGE_LOGIN=acme-bot[bot]` and no `NAX_FORGE_TOKEN_FILE` exits 1 and writes a stderr line beginning `[forge] Invalid injected forge identity:`.
- `[cli]` running `bin/nax.ts --version` with `NAX_FORGE_TOKEN_FILE` naming a file containing `tok-7f3a9c` and `NAX_FORGE_LOGIN=acme-bot[bot]` exits 0, prints the version, and the token file no longer exists afterwards.

### US-003 — Forge calls use the injected identity

- `[unit]` `readCurrentUser` for a GitHub ref, with `deps.identity()` returning `{ token: "tok-7f3a9c", login: "acme-bot[bot]" }`, returns `{ login: "acme-bot[bot]" }` and never calls `deps.run`.
- `[unit]` `readCurrentUser` with `deps.identity()` returning `{ token: "tok-7f3a9c", login: "acme-bot[bot]", id: 42 }` returns `{ login: "acme-bot[bot]", id: 42 }`.
- `[unit]` `readCurrentUser` for a GitHub ref with `deps.identity()` returning `{ token: "tok-7f3a9c" }` throws a `NaxError` with code `FORGE_IDENTITY_LOGIN_REQUIRED` and never calls `deps.run`.
- `[unit]` `readCurrentUser` for a GitLab ref with `deps.identity()` returning `{ token: "tok-7f3a9c" }` calls `deps.run` once with the `glab` `api user` argv and returns the `username` from its reply.
- `[unit]` `readCurrentUser` with a `deps` that has no `identity` member calls `deps.run` with the `api user` argv, as before this feature.
- `[unit]` `classifyPrTrust` for a same-repo PR authored by `acme-bot[bot]`, with an injected login `acme-bot[bot]`, returns `trusted: true` with reason `author is the current user`.
- `[unit]` `classifyPrTrust` for a same-repo PR authored by `alice` (write access granted by the fake's permission reply), with an injected login `acme-bot[bot]`, returns `trusted: true` with reason `author has write access`.
- `[unit]` `classifyPrTrust` for a GitHub PR with `deps.identity()` returning `{ token: "tok-7f3a9c" }` returns `trusted: false` with a reason that contains `NAX_FORGE_LOGIN is required`.
- `[unit]` `listReviewThreads` on GitHub sends a `query=` argument in which the comment `author` selection includes `__typename`.
- `[unit]` `listReviewThreads` on GitHub, given a GraphQL reply whose thread comment author is `{ login: "acme-bot", __typename: "Bot" }`, returns that comment with `author` `acme-bot[bot]`.
- `[unit]` `listReviewThreads` on GitHub, given a thread comment author `{ login: "acme-bot", __typename: "User" }`, returns that comment with `author` `acme-bot`.
- `[unit]` `findOwnComments` on GitHub with an injected login `acme-bot[bot]` returns a marked thread comment whose GraphQL author is `{ login: "acme-bot", __typename: "Bot" }`, and does not return a marked thread comment whose author is `{ login: "acme-bot", __typename: "User" }`.
- `[unit]` `defaultForgeDeps.identity()` returns the value set in `_forgeIdentity.current`.
- `[unit]` after `captureForgeIdentity` captures `{ token: "tok-7f3a9c", login: "acme-bot[bot]" }`, `defaultRun([<tmp>/gh])`, a fixture that prints `$GH_TOKEN`, returns stdout `tok-7f3a9c`.
- `[unit]` with that identity captured, `defaultRun([<tmp>/gh])`, a fixture that prints `$GH_ENTERPRISE_TOKEN`, returns stdout `tok-7f3a9c`.
- `[unit]` with that identity captured, `defaultRun([<tmp>/glab])`, a fixture that prints `$GITLAB_TOKEN`, returns stdout `tok-7f3a9c`.
- `[unit]` with that identity captured, `defaultRun([<tmp>/other])`, a fixture that prints `$GH_TOKEN$GITLAB_TOKEN`, returns stdout that is not `tok-7f3a9c` and does not include it.
- `[unit]` with that identity captured, `defaultRun([<tmp>/gh, "api", "user"])`, a fixture that prints its arguments joined by a space, returns stdout `api user`.
- `[unit]` with no identity captured and `GH_TOKEN` absent from `process.env`, `defaultRun([<tmp>/gh])` with the `$GH_TOKEN` fixture returns empty stdout.

### US-004 — Bot network git calls authenticate with the injected token

- `[unit]` after `captureForgeIdentity` captures `{ token: "tok-7f3a9c", login: "acme-bot[bot]" }`, `botGit(["push", "origin", "HEAD:refs/heads/x"], "/repo")` spawns git with argv starting `git`, `-c`, `core.hooksPath=/dev/null`, `-c`, `credential.helper=`, `-c`, `credential.helper=<NAX_BOT_CREDENTIAL_HELPER>`, followed by the push arguments.
- `[unit]` with that identity captured, the git process `botGit(["push", "origin", "HEAD:refs/heads/x"], "/repo")` spawns has `NAX_FORGE_GIT_TOKEN` equal to `tok-7f3a9c` in its environment.
- `[unit]` with that identity captured, `botGit(["fetch", "origin"], "/repo")` spawns git with the same credential-helper prefix and `NAX_FORGE_GIT_TOKEN` equal to `tok-7f3a9c`.
- `[unit]` with that identity captured, no element of the argv `botGit` spawns for a `push` or a `fetch` includes `tok-7f3a9c`.
- `[unit]` with that identity captured, `botGit(["rev-parse", "HEAD"], "/repo")` spawns git with argv `["git", "-c", "core.hooksPath=/dev/null", "rev-parse", "HEAD"]` and no `NAX_FORGE_GIT_TOKEN` in its environment.
- `[unit]` with no identity captured, `botGit(["push", "origin", "HEAD:refs/heads/x"], "/repo")` spawns git with argv `["git", "-c", "core.hooksPath=/dev/null", "push", "origin", "HEAD:refs/heads/x"]`.
- `[unit]` with that identity captured and `_fixInputDeps.runGit` left at its default, `checkPushAccess("/repo", "x")` spawns git with the credential-helper prefix and `NAX_FORGE_GIT_TOKEN` equal to `tok-7f3a9c` in its environment.
- `[integration]` a real git run in a temporary repository as `git -c credential.helper= -c credential.helper=<NAX_BOT_CREDENTIAL_HELPER> credential fill`, with `NAX_FORGE_GIT_TOKEN=tok-7f3a9c` in its environment and the input `protocol=https` / `host=github.com`, outputs `username=x-access-token` and `password=tok-7f3a9c`.
- `[integration]` the same real git run with a repository-local `credential.helper` that would answer `password=wrong` still outputs `password=tok-7f3a9c` (the empty helper entry clears configured helpers).
- `[integration]` through the helper harness (the string without its leading `!`, plus the action, run by `sh -c` with the input on stdin and the token in `NAX_FORGE_GIT_TOKEN`), the action `get` with input `protocol=https` / `host=github.com` exits 0 and prints `username=x-access-token` and `password=tok-7f3a9c`.
- `[integration]` through the same harness, the action `get` with input `protocol=http` / `host=example.com` exits 0 and prints nothing.
- `[integration]` through the same harness, the action `store` with input `protocol=https` / `host=github.com` exits 0 and prints nothing.
- `[integration]` through the same harness, the action `erase` with input `protocol=https` / `host=github.com` exits 0 and prints nothing.
- `[unit]` with an identity captured, the git process `botGit(["push", "origin", "HEAD:refs/heads/x"], "/repo")` spawns has `GIT_TERMINAL_PROMPT` equal to `0` in its environment.
