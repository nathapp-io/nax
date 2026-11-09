# SPEC: Agent sandbox and permission hardening (2026-11-09 review, F1)

## Summary

Close the eight security findings in the agent's tool, credential and permission boundary from the 2026-11-09
whole-repo review (`docs/reviews/20261109-review-nax.md`): H1, H2, M1, M2, M3, M4, M5 and M6. Each one is a place
where a check that exists is skipped on one path: a dangling symlink skips write containment, an imported OAuth
credential skips the OAuth policy, a wrapper command skips Bash deny and ask rules, `git -c` skips the git escape-flag
list, a glob character in the repo path skips the sandbox, an in-tree hooks path skips the sandbox at commit time, a
package-runner subcommand widens a remembered "always allow", and a sandbox-wrapped opencode or pi command skips the
operator's shell deny rules. Every fix closes the skipped path and leaves the working path unchanged.

This is feature F1 of five cut from that review (user ruling 2026-11-09). F2 (secrets and cost ledger: M7-M11, M18),
F3 (memory forget integrity: M12-M14, M23), F4 (gates and config: M15-M17, M19-M22) and F5 (LOW sweep) follow as
separate specs.

## Motivation

The review reproduced every one of these against HEAD `475562fda` with a scratch script calling the real function.

- **H1.** `realOrRaw` (`packages/nax-agent/src/internal/realpath.ts:31-46`) falls back to the lexical path when
  `realpathSync` throws, and it throws on a dangling symlink. `resolveWithin`
  (`packages/nax-agent/src/tools/policy-paths-branch.ts:105-112`) then sees an in-root path with no `.git` segment
  and admits it, and `writeFile` follows the link. A tree containing `hook-link -> .git/hooks/pre-commit` lets the
  `Write` tool (declared for the implementer in `packages/nax/src/operations/workflow-implement.ts:32`) write a git
  hook; `out -> ../../outside/file` lets it write outside the root.
- **H2.** `importPiCredentials` (`packages/nax-agent/src/native/auth.ts:175-237`) copies every provider entry from
  `~/.pi/agent/auth.json` into the nax store with no policy check. `PERMITTED_OAUTH_FLOWS`
  (`packages/nax-ai/src/auth/oauth-policy.ts:26`) is enforced only at login (`packages/nax-ai/src/auth/pi-auth.ts:166`),
  and pi-ai resolves a stored OAuth entry for any provider that declares OAuth, Anthropic included. An imported
  Anthropic subscription token is then sent as the API key on every Anthropic request, which the policy header says
  must never happen.
- **M1.** Bash deny and ask rules match canonical segments (`packages/nax-agent/src/tools/policy-bash.ts:300-333`).
  `canonicalSegments` (`packages/nax-agent/src/tools/bash-canonical.ts`) strips only the wrappers in its `WRAPPERS`
  table and stops at any other head, so `setsid git push origin main`, `ionice -c3 git push origin main`,
  `caffeinate git push origin main` and `arch -arm64 git push origin main` are all allowed under `deny: Bash(git push*)`.
- **M2.** `checkPayload` (`policy-bash.ts:162-172`) checks `DENIED_FLAGS` (`tools/exec-guard.ts:100-120`), which has
  no git flags. `GIT_ESCAPE_FLAGS` (`tools/git-flags/index.ts:10`) is used only by the Git tool and the command
  interceptor. Under a `Bash(git *)` grant, `git -c core.fsmonitor="sh -c '...'" status` runs arbitrary code.
- **M3.** `literal()` (`packages/nax-agent/src/sandbox/policy-builder.ts:78-88`) throws `SANDBOX_POLICY_NOT_LITERAL`
  on a glob character in a policy path, and its comment says "fail closed instead". `resolveSessionSandbox`
  (`packages/nax-agent/src/coding-tools/coding-tool-sandbox.ts:188-191`) turns that error into the `unavailable`
  state, and `createCommandLauncher` (`packages/nax-agent/src/sandbox/launcher.ts:205-207`) runs `unavailable`
  commands unwrapped. A project at `~/work/app[v2]` runs every gated Bash command with no OS confinement.
- **M4.** `buildCommitArgvs` (`packages/nax-agent/src/tools/git-commit.ts:21-38`) builds `["commit", "-m", message]`,
  which runs outside the sandbox. `HARDENED_GIT_CONFIG` (`packages/nax-agent/src/internal/git-env.ts:38-42`) does not
  set `core.hooksPath`, and the sandbox denies writes only to `<gitdir>/hooks`. With `core.hooksPath=.husky` the agent
  writes `.husky/pre-commit` (no `.git` segment, so admitted) and `GitCommit` runs it unsandboxed.
- **M5.** `approvalMemoryKey` (`packages/nax-agent/src/permissions/approval-memory.ts:68-81`) treats `npx`, `bunx`
  and `pnpx` as wrappers, but `npm exec`, `npm run`, `pnpm dlx` and `yarn dlx` fall through to a two-word key. A
  remembered allow for `npm exec prettier` then auto-allows `npm exec evil-pkg`, and `npm run test` auto-allows
  `npm run deploy`.
- **M6.** `decideSandboxedShell` (`packages/nax-agent-acp/src/client/permissions.ts:223-250`) decodes the wrapped
  inner command only when `plan.verify` is set, and `verify` is `agent === "cursor"`
  (`packages/nax-agent-acp/src/client/shell-sandbox.ts:128`). For opencode and pi the deny rule is matched against the
  sandbox wrapper text and never fires.

## Design

Each fix closes the skipped path at the seam that already owns the check. No new modules. The only new exported
shape is the `failClosed` flag on the `unavailable` sandbox state (US-006) and the `"refused"` import status (US-003).

### Integration

All symbols below were opened at HEAD `475562fda` and verified at the shapes listed.

**Read-only. None of these changes.**

- `isOAuthFlowPermitted(providerId: ProviderId): boolean` and `assertOAuthFlowPermitted(providerId: ProviderId): void`
  — `packages/nax-ai/src/auth/oauth-policy.ts:49,59`. Both are exported from the `@nathapp/nax-ai` package root
  (`packages/nax-ai/src/index.ts:39-40`). `assertOAuthFlowPermitted` throws `OAuthFlowProhibitedError` for a provider in
  `PROHIBITED_OAUTH_FLOWS` (`anthropic`, `github-copilot`).
- `createFileCredentialStore(options: FileCredentialStoreOptions): CredentialStore` —
  `packages/nax-ai/src/credentials/file-store.ts:114`.
- `createPiAuthResolver(models: MutableModels): AuthResolver` — `packages/nax-ai/src/auth/pi-auth.ts:89`.
  `packages/nax-ai/src/protocols/pi-client.ts:951` builds the models as
  `builtinModels({ credentials: toPiCredentialStore(store) })`.
- `compileToolPolicy(grants, root, options?): ToolPolicy` — `packages/nax-agent/src/tools/policy.ts:103`;
  `ToolPolicy.check(tool, scope, input): PolicyVerdict` — `packages/nax-agent/src/tools/types.ts:186-190`.
- `writeTool` — `packages/nax-agent/src/tools/write.ts`. Calls `mkdir(dirname(target), { recursive: true })` and
  `writeFile(target, ...)` on the path the policy resolved.
- `isSandboxWrapped(prefix: string, command: string): boolean` — `packages/nax-agent-acp/src/client/shell-sandbox.ts:46`.
  True only when the suffix after `prefix` is exactly one POSIX single-quoted word, for every agent.
- `wrapForSandbox(prefix: string, command: string): string` — `shell-sandbox.ts:41`. The wrapping used for every agent.

**Changed. The baseline is shown only to locate the code; the Target is the interface to implement.**

- `realOrRaw(p: string): string` — `packages/nax-agent/src/internal/realpath.ts:31`.
  - Baseline: when `realpathSync` throws for a path component, it walks up to the nearest ancestor that resolves and
    re-attaches the remaining segments lexically, so a dangling symlink among them is never followed.
  - Target: signature unchanged and it still never throws. A remaining segment that is a symbolic link (by `lstat`)
    is replaced by its link target (from `readlink`, resolved against the link's own directory) and resolution
    continues from there, so the result names where a write would actually land. Link-following is bounded (40 hops);
    on a cycle it stops and returns the lexical form, which no write can follow either.
- `resolveWithin(root: string, candidate: string, owned: OwnedPathsPolicy): string | null` —
  `packages/nax-agent/src/tools/policy-paths-branch.ts:105`.
  - Baseline: correct for every path `realOrRaw` resolves; admits a dangling symlink whose target is outside the root
    or under `.git/`.
  - Target: signature unchanged. With the `realOrRaw` change, the containment, `.git/` and `configRefusal` checks run
    on the link target, so such a candidate returns `null`. An in-root dangling link whose target is also in-root and
    outside `.git/` is still admitted, resolved to its target.
- `toPiCredentialStore(store: CredentialStore): PiCredentialStore` — `packages/nax-ai/src/auth/pi-auth.ts:57`.
  - Baseline: `read` and `modify` pass every stored credential to pi unchanged.
  - Target: signature unchanged. A stored `kind: "oauth"` credential for a provider where `isOAuthFlowPermitted` is
    false is invisible to pi: `read` returns `undefined`, and `modify` hands its callback `undefined` as the current
    value. A `modify` callback that returns an OAuth credential for such a provider throws through
    `assertOAuthFlowPermitted` and leaves the store unchanged. A `modify` callback that returns `undefined` leaves the
    stored entry unchanged, as today. The stored entry is never deleted by this adapter.
- `importPiCredentials(options?: { from?: string; force?: boolean }): Promise<ImportOutcome[]>` —
  `packages/nax-agent/src/native/auth.ts:175`; `ImportOutcome.status` — `auth.ts:135`;
  `authImportOutcomeLabel(status)` — `auth.ts:253`.
  - Baseline: `status` is `"imported" | "skipped" | "unsupported"`, and every parsed entry is written.
  - Target: `status` gains `"refused"`. An `oauth` entry for a provider where `isOAuthFlowPermitted` is false is not
    written, with or without `force`, and reports `"refused"`. `authImportOutcomeLabel("refused")` returns
    `"refused, OAuth login is not permitted for this provider"`. `nax auth import` (`packages/nax/src/cli/auth.ts:100-115`)
    already prints the label per outcome and needs no change.
- `checkBashCommand(args: BashCheckArgs): BashCheck` — `packages/nax-agent/src/tools/policy-bash.ts:314`, with its
  helpers `ruleSegments` (`:300`) and `checkPayload` (`:162`).
  - Baseline: deny and ask rules match each lexed segment plus its canonical view; `checkPayload` refuses only
    `DENIED_FLAGS`.
  - Target: signature unchanged. Two changes:
    1. **Rule views.** When `denyEntry` or `askEntry` is set, `ruleSegments` also adds, for every segment, a view of
       each token suffix starting at index 1 or later. Deny and ask matching see these views; grant and payload checks
       still see the original tokens only, so a view can never grant anything. This subsumes every unlisted wrapper
       (`setsid`, `ionice`, `chrt`, `taskset`, `flock`, `caffeinate`, `arch`, `unbuffer`, `script`, `chroot`,
       `unshare`, `nsenter`, `su`, `runuser`) without an option table per wrapper.
    2. **Git config flags.** `checkPayload` refuses the git global options `-c`, `--config-env` and `--exec-path`, in
       both the separate-value and the `=value` spelling, wherever a token whose text is `git` (or ends in `/git`) is
       followed by one of them before the git subcommand. The scan runs over every token position in the original
       segment, not only the command word, so a wrapper in front (`env git -c ...`, `setsid git -c ...`) is covered
       whether or not any deny or ask rule exists. Options after the subcommand are subcommand options and are not
       checked (`git log -c` stays allowed). The boundary: after the `git` token, skip flag options without a value
       (`--no-pager`, `-p`, `--paginate`, `--bare`, `--literal-pathspecs`, `--no-replace-objects`) and skip the value
       of `-C`, `--git-dir`, `--work-tree` and `--namespace` (separate or `=value` spelling); the first token that is
       neither is the subcommand, and the scan stops there. This is the same option grammar as `GIT_OPTIONS` in
       `bash-canonical.ts:89-92`. `-C`, `--git-dir` and `--work-tree` keep their current Bash handling. A false
       positive (`echo git -c x`) is refused, which fails closed.
- `approvalMemoryKey(request: ApprovalMemoryRequest): string | undefined` —
  `packages/nax-agent/src/permissions/approval-memory.ts:68`.
  - Baseline: a non-wrapper first word plus a plain second word gives a two-word key.
  - Target: signature unchanged. When the first word is `npm`, `pnpm` or `yarn`:
    - a second word of `exec`, `x`, `dlx` or `create` gives no key, and so does `init` followed by a third word
      (`npm init <pkg>` runs `create-<pkg>`); each runs an arbitrary package;
    - a second word of `run`, `install`, `i` or `add` followed by a plain, non-flag third word gives a three-word key
      (`Bash:npm run test`, `Bash:npm install lodash`), so a remembered allow names the script or package;
    - every other request keys as today, including a bare `npm install` (`Bash:npm install`).
- `SandboxState`'s `unavailable` variant — `packages/nax-agent/src/sandbox/types.ts:83`;
  `createCommandLauncher(opts)` — `packages/nax-agent/src/sandbox/launcher.ts`; `resolveSessionSandbox(args)` —
  `packages/nax-agent/src/coding-tools/coding-tool-sandbox.ts:97`.
  - Baseline: `{ kind: "unavailable"; backend; reason }`, and `run` executes every request unwrapped.
  - Target: the variant gains an optional `readonly failClosed?: true`. `resolveSessionSandbox` sets it only when the
    policy could not be built (`literalPolicyError` returned a reason). A launcher in that state rejects every request
    that is not `unwrapped: true` with a `NaxError` coded `SANDBOX_POLICY_NOT_LITERAL` whose message names the path,
    without spawning. A host-capability `unavailable` state (no `failClosed`) keeps running unwrapped, as today. Every
    other reader of the `unavailable` variant (`rawRefusalFor`, the Bash tool description,
    `packages/nax-agent/src/session/session-tool-support.ts:126`, `packages/nax-agent/src/sandbox/session-sandbox.ts:11`) keeps treating it as unavailable.
- `buildCommitArgvs(input: Record<string, unknown>): { add: string[]; commit: string[] } | { error: string }` —
  `packages/nax-agent/src/tools/git-commit.ts:21`. The input carries `message` and `paths`.
  - Baseline: `commit` is `["commit", "-m", message]`.
  - Target: `commit` is `["-c", "core.hooksPath=/dev/null", "commit", "-m", message]`, so no hook (pre-commit,
    prepare-commit-msg, commit-msg, post-commit) runs from any hooks path. `add` is unchanged; `git add` runs no hooks.
    The two leading elements mirror `BOT_GIT_HOOKS_OFF` in `packages/nax/src/bot/git.ts:6`; nax-agent cannot import
    from nax (dependency direction), so the value is repeated, not shared.
- `decideSandboxedShell(request, display, offered, auto, ctx): RequestPermissionResponse` —
  `packages/nax-agent-acp/src/client/permissions.ts:223`.
  - Baseline: the inner command is decoded only when `wrapped && plan.verify`.
  - Target: signature unchanged. The inner command is decoded whenever `wrapped` is true, for every agent.
    `isSandboxWrapped` already guarantees the suffix is one single-quoted word for every agent, so the decode is safe.

### Failure Handling

| Situation | Behaviour |
|:---|:---|
| A path segment is a symlink cycle | `realOrRaw` stops after 40 hops and returns the lexical form; it never throws and never hangs. |
| A dangling symlink's target is outside the root or under `.git/` | `resolveWithin` returns `null`, and the tool reports the existing refusal reason. |
| A stored OAuth credential is for a non-permitted provider | pi sees no credential for that provider; ambient environment auth, if any, is what pi uses. The stored entry is kept. |
| An imported pi entry is OAuth for a non-permitted provider | Not written; outcome `"refused"`; the rest of the import continues. |
| A git escape flag follows a non-command `git` token (`echo git -c x`) | Refused. The scan fails closed; the agent can rephrase. |
| A rule view is a false positive (`echo git push` under `deny: Bash(git push*)`) | Denied. Deny and ask rules fail closed; the agent can rephrase. |
| The sandbox policy cannot be built (glob character in a policy path) | Every gated command is refused with `SANDBOX_POLICY_NOT_LITERAL` naming the path, unless the call is `unwrapped: true` (the approval-gated `unsandboxed` escape). The one-time warning still logs. This includes a policy path that is a dangling symlink whose target has a glob character, which US-001 now resolves to that target. |
| The sandbox is unavailable because the host lacks the backend | Unchanged: commands run unwrapped with the existing warning. |

## Out of Scope

- Extending the `WRAPPERS` option table in `bash-canonical.ts` with per-wrapper option grammars (review M1 second fix). The suffix rule views in US-004 already make deny and ask rules see the wrapped command, and a per-wrapper table can only add precision, not coverage.
- Making git hooks an explicit opt-in for `GitCommit` (review M4 second half). This feature turns hooks off unconditionally; an opt-in is a new config surface needing its own design.
- Writing with `O_NOFOLLOW` in the `Write`, `Edit` and `Delete` tools (review H1 alternative fix). Containment is decided in `resolveWithin`; a second, per-tool check is defence in depth for a later change.
- Git configuration injected through environment variables in a Bash command (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`, `GIT_CONFIG_PARAMETERS`, `GIT_PAGER`, `GIT_EXTERNAL_DIFF`, `GIT_SSH_COMMAND`, `GIT_EDITOR`), or written with `git config` before a later git command. These are the same class as review M2, but gated Bash runs inside the OS sandbox, and US-004 only brings the Bash `-c` form to parity with the Git tool's existing refusal. Closing the environment and config-write forms needs its own design.
- Hard links. A hard link to `.git/hooks/pre-commit` inside the root is admitted by `resolveWithin`, because a hard link is an ordinary directory entry. It cannot arrive through repository content (git stores file contents, not links, so a clone never creates one), and creating one needs Bash `ln` against an existing in-root target. Refusing every regular file with a link count above one would also refuse legitimate hard-linked files (for example a package-manager store); that trade-off needs its own decision.
- The window between `resolveWithin` admitting a path and `writeFile` following it (a symlink created in between). US-001 closes the dangling-link case that exists before the call; a race-free write needs `O_NOFOLLOW` per tool, deferred above.
- Escaping glob characters in sandbox policy paths so a glob-named repo can still be sandboxed (review M3 alternative fix). Whether each backend accepts escaped literals is backend-specific and unverified; this feature refuses instead.
- A config option to make a host-capability `unavailable` sandbox fail closed. Only the policy-build failure is a nax fault; a missing backend stays fail-open by the existing design.
- Removing or rewriting an Anthropic OAuth credential that is already in a user's `~/.nax` credential store. US-002 hides it from pi; deleting user data is a separate decision.
- The other review findings (M7-M23, L1-L37). They belong to features F2-F5 of this review.
- US-004 only: rule views are added only when a deny or ask rule exists; they never affect grant matching, payload checks or path containment.
- US-006 only: a request with `unwrapped: true` still runs unwrapped under a fail-closed launcher, because that flag is an explicit, separately approved escape hatch.

## Stories

Seven stories. None depends on another; they may run in any order. Seven stories is close to the size where branch
residuals appear in hardening bundles; the user chose this cut on 2026-11-09. Every story is one package; US-004 and
US-006 each pair two findings that share a gate (the Bash gate; code that runs outside the sandbox).

### US-001: Follow dangling symlinks in path containment

Workdir: packages/nax-agent. No dependencies.

Fix review H1. Make `realOrRaw` follow a dangling symlink to its target so `resolveWithin` checks where a write would
land, not the lexical link path.

### US-002: Hide non-permitted OAuth credentials from pi

Workdir: packages/nax-ai. No dependencies.

Fix the resolver half of review H2. `toPiCredentialStore` stops passing an OAuth credential for a provider outside
`PERMITTED_OAUTH_FLOWS` to pi, and refuses to write one.

### US-003: Refuse non-permitted OAuth credentials on import

Workdir: packages/nax-agent. No dependencies.

Fix the import half of review H2. `importPiCredentials` skips an OAuth entry for a provider outside
`PERMITTED_OAUTH_FLOWS` and reports it as `"refused"`.

### US-004: Bash deny and ask rules see wrapped commands, and git config flags are refused

Workdir: packages/nax-agent. No dependencies.

Fix review M1 and M2 in the Bash gate (`checkBashCommand`): add token-suffix views for deny and ask matching, and
refuse `git -c`, `--config-env` and `--exec-path` before the git subcommand.

### US-005: Package-runner subcommands do not widen a remembered allow

Workdir: packages/nax-agent. No dependencies.

Fix review M5 in `approvalMemoryKey`: no key for `npm|pnpm|yarn` with `exec|x|dlx`, and a three-word key for
`npm|pnpm|yarn run <script>`.

### US-006: A sandbox policy failure refuses gated commands, and GitCommit runs no hooks

Workdir: packages/nax-agent. No dependencies.

Fix review M3 and M4, the two paths where agent-controlled code runs outside the sandbox: a launcher whose policy
could not be built refuses instead of running unwrapped, and `GitCommit` disables every hooks path.

### US-007: Shell deny rules apply to sandbox-wrapped commands for every ACP agent

Workdir: packages/nax-agent-acp. No dependencies.

Fix review M6 in `decideSandboxedShell`: decode the wrapped inner command whenever it is wrapped, not only for cursor.

### Context Files

**US-001**

- `packages/nax-agent/src/internal/realpath.ts`
- `packages/nax-agent/src/tools/policy-paths-branch.ts`
- `packages/nax-agent/src/tools/write.ts`
- `packages/nax-agent/test/unit/tools/policy-paths-branch-edges.test.ts`

**US-002**

- `packages/nax-ai/src/auth/pi-auth.ts`
- `packages/nax-ai/src/auth/oauth-policy.ts`
- `packages/nax-ai/src/credentials/file-store.ts`
- `packages/nax-ai/test/auth/pi-auth.test.ts`

**US-003**

- `packages/nax-agent/src/native/auth.ts`
- `packages/nax-ai/src/auth/oauth-policy.ts`
- `packages/nax-agent/test/unit/native/auth-store-ops.test.ts`

**US-004**

- `packages/nax-agent/src/tools/policy-bash.ts`
- `packages/nax-agent/src/tools/bash-canonical.ts`
- `packages/nax-agent/src/tools/git-flags/index.ts`
- `packages/nax-agent/src/tools/exec-guard.ts`
- `packages/nax-agent/test/unit/tools/policy-bash.test.ts`

**US-005**

- `packages/nax-agent/src/permissions/approval-memory.ts`
- `packages/nax-agent/test/unit/permissions/approval-memory.test.ts`

**US-006**

- `packages/nax-agent/src/coding-tools/coding-tool-sandbox.ts`
- `packages/nax-agent/src/sandbox/launcher.ts`
- `packages/nax-agent/src/sandbox/types.ts`
- `packages/nax-agent/src/tools/git-commit.ts`
- `packages/nax-agent/test/unit/coding-tools/coding-tool-sandbox.test.ts`

**US-007**

- `packages/nax-agent-acp/src/client/permissions.ts`
- `packages/nax-agent-acp/src/client/shell-sandbox.ts`
- `packages/nax-agent-acp/test/unit/client/permissions.test.ts`

### Creates

None. Every story changes existing source and adds cases to existing test files.

### Modifies

**US-006**

- `packages/nax-agent/test/unit/tools/git-commit.test.ts` — the cases at lines 73, 79 and 110 assert that the commit argv from buildCommitArgvs is exactly: commit, -m, message, and line 111 asserts the message sits at index 2. The commit argv now starts with the two elements -c and core.hooksPath=/dev/null; the replacement invariant is that the argv is: -c, core.hooksPath=/dev/null, commit, -m, message, with the message as one argv element at index 4, unchanged in content. Separately, the case "returns the git commit failure after a successful stage" (lines 404-412) makes the commit fail with a rejecting pre-commit hook under .git/hooks, which no longer runs. The replacement invariant: the commit is made to fail by a cause other than a hook (for example repo config commit.gpgsign=true with gpg.program=false), and the tool still returns `isError: true` with content containing "git commit failed:". The case "emits no escape flag in either argv" (lines 98-105) asserts the commit argv contains no GIT_ESCAPE_FLAGS member, and -c is one; the replacement invariant is that the add argv contains no escape flag, the commit argv contains -c exactly once, at index 0, followed by core.hooksPath=/dev/null, and a message that looks like an escape flag (-c core.pager=id) stays a single element after -m.

### Seams

None. No story introduces a symbol another story calls. US-002 and US-003 both read the existing
`isOAuthFlowPermitted` export and do not depend on each other.

## Acceptance Criteria

### US-001

- [unit] `realOrRaw(<root>/out)` where `<root>/out` is a symlink to `../outside/new.txt` and that target does not exist returns `<realpath of root's parent>/outside/new.txt`.
- [unit] `realOrRaw(<root>/dir-link/new.txt)` where `<root>/dir-link` is a symlink to `../outside/missing-dir` and that directory does not exist returns `<realpath of root's parent>/outside/missing-dir/new.txt`.
- [unit] `realOrRaw(<root>/abs-link)` where `<root>/abs-link` is a symlink to the absolute path `<tmp>/elsewhere/missing.txt` and that target does not exist returns `<realpath of tmp>/elsewhere/missing.txt`.
- [unit] `realOrRaw(<root>/a)` where `<root>/a` links to `b` and `<root>/b` links to `a` returns `<realpath of root>/a` (the lexical form) without throwing.
- [unit] `resolveWithin(root, "out", EMPTY_OWNED_PATHS_POLICY)` where `out` is a dangling symlink to `../outside/new.txt` returns `null`.
- [unit] `resolveWithin(root, "hook-link", EMPTY_OWNED_PATHS_POLICY)` where `hook-link` is a symlink to `.git/hooks/pre-commit` and that hook does not exist returns `null`.
- [unit] `resolveWithin(root, "dir-link/new.txt", EMPTY_OWNED_PATHS_POLICY)` where `dir-link` is a dangling symlink to `../outside/missing-dir` returns `null`.
- [unit] `resolveWithin(root, "inner-link", EMPTY_OWNED_PATHS_POLICY)` where `inner-link` is a symlink to `build/missing.txt` inside the root and that target does not exist returns `<realpath of root>/build/missing.txt`.
- [unit] `resolveWithin(root, "existing-link", EMPTY_OWNED_PATHS_POLICY)` where `existing-link` is a symlink to an existing in-root file `src/a.ts` returns `<realpath of root>/src/a.ts`.
- [integration] With a `Write` grant from `compileToolPolicy` over a temp git repo whose `hook-link` is a dangling symlink to `.git/hooks/pre-commit`, `policy.check("Write", writeTool.scope, { path: "hook-link", content: "x" })` returns a deny verdict, and `<root>/.git/hooks/pre-commit` does not exist afterwards.

### US-002

- [unit] With a `CredentialStore` holding `{ kind: "oauth", access, refresh, expires }` for `anthropic`, `toPiCredentialStore(store).read("anthropic")` resolves to `undefined`.
- [unit] With a `CredentialStore` holding an OAuth credential for `github-copilot`, `toPiCredentialStore(store).read("github-copilot")` resolves to `undefined`.
- [unit] After `toPiCredentialStore(store).read("anthropic")` on a store holding an OAuth credential for `anthropic`, `store.read("anthropic")` still resolves to that OAuth credential.
- [unit] With a `CredentialStore` holding an OAuth credential for `openai-codex`, `toPiCredentialStore(store).read("openai-codex")` resolves to `{ type: "oauth", access, refresh, expires }` with the stored values.
- [unit] With a `CredentialStore` holding `{ kind: "api-key", key: "sk-test" }` for `anthropic`, `toPiCredentialStore(store).read("anthropic")` resolves to `{ type: "api_key", key: "sk-test" }`.
- [unit] With an OAuth credential stored for `anthropic`, `toPiCredentialStore(store).modify("anthropic", fn)` calls `fn` with `undefined` as the current credential.
- [unit] With no credential stored for `anthropic`, `toPiCredentialStore(store).modify("anthropic", fn)` where `fn` returns `{ type: "oauth", access: "a", refresh: "r", expires: 1 }` rejects with `OAuthFlowProhibitedError`, and `store.read("anthropic")` still resolves to `undefined`.
- [unit] With an OAuth credential stored for `anthropic`, `toPiCredentialStore(store).modify("anthropic", fn)` where `fn` returns `undefined` leaves `store.read("anthropic")` returning the original OAuth credential.
- [integration] With a `createFileCredentialStore` store in a temp directory holding an OAuth credential for `anthropic` and no Anthropic environment variable set, `createPiAuthResolver(builtinModels({ credentials: toPiCredentialStore(store) })).resolve({ provider: "anthropic", ... })` resolves to an object with no `apiKey`.

### US-003

- [unit] `importPiCredentials({ from })` with an auth file holding `{ "anthropic": { "type": "oauth", "access": "a", "refresh": "r", "expires": 1 } }` returns `[{ providerId: "anthropic", status: "refused" }]`.
- [unit] After that import, the nax credential store holds no entry for `anthropic`.
- [unit] `importPiCredentials({ from, force: true })` with the nax store already holding `{ kind: "api-key", key: "sk-keep" }` for `anthropic` and the auth file holding an `anthropic` OAuth entry returns status `"refused"` for `anthropic`, and the stored api-key is still `sk-keep`.
- [unit] `importPiCredentials({ from })` with an auth file holding an `anthropic` OAuth entry and an `openai-codex` OAuth entry returns `"refused"` for `anthropic` and `"imported"` for `openai-codex`.
- [unit] `importPiCredentials({ from })` with an auth file holding `{ "anthropic": { "type": "api_key", "key": "sk-a" } }` returns `[{ providerId: "anthropic", status: "imported" }]`.
- [unit] `authImportOutcomeLabel("refused")` returns `"refused, OAuth login is not permitted for this provider"`.

### US-004

- [unit] `checkBashCommand` with grant `Bash(*)` and deny rule `Bash(git push*)` returns `kind: "deny"` for `setsid git push origin main`.
- [unit] `checkBashCommand` with grant `Bash(*)` and deny rule `Bash(git push*)` returns `kind: "deny"` for `ionice -c3 git push origin main`.
- [unit] `checkBashCommand` with grant `Bash(*)` and deny rule `Bash(git push*)` returns `kind: "deny"` for `caffeinate git push origin main`.
- [unit] `checkBashCommand` with grant `Bash(*)` and deny rule `Bash(git push*)` returns `kind: "deny"` for `arch -arm64 git push origin main`.
- [unit] `checkBashCommand` with grant `Bash(*)` and ask rule `Bash(git push*)` returns `kind: "ask"` for `setsid git push origin main`.
- [unit] `checkBashCommand` with grant `Bash(*)` and deny rule `Bash(git push*)` returns `kind: "allow"` for `git status`.
- [unit] `checkBashCommand` with grant `Bash(*)` and deny rule `Bash(git push*)` returns `kind: "deny"` for `echo git push`.
- [unit] `checkBashCommand` with grant `Bash(*)` and no deny or ask rule returns `kind: "allow"` for `setsid git push origin main`.
- [unit] `checkBashCommand` with grant `Bash(git *)` returns `kind: "deny"` for `git -c core.pager=sh status`, with a reason naming `-c`.
- [unit] `checkBashCommand` with grant `Bash(git *)` returns `kind: "deny"` for `git --config-env=core.pager=X status`.
- [unit] `checkBashCommand` with grant `Bash(git *)` returns `kind: "deny"` for `git --config-env core.pager=X status`.
- [unit] `checkBashCommand` with grant `Bash(git *)` returns `kind: "deny"` for `git --exec-path=/tmp/x status`.
- [unit] `checkBashCommand` with grant `Bash(*)` returns `kind: "deny"` for `env git -c core.fsmonitor=x status`.
- [unit] `checkBashCommand` with grant `Bash(*)` and no deny or ask rule returns `kind: "deny"` for `setsid git -c core.pager=sh status`.
- [unit] `checkBashCommand` with grant `Bash(git *)` returns `kind: "allow"` for `git log -c`.
- [unit] `checkBashCommand` with grant `Bash(git *)` returns `kind: "deny"` for `git -C . -c core.pager=sh status`.
- [unit] `checkBashCommand` with grant `Bash(git *)` returns `kind: "deny"` for `git --no-pager -C . -c core.pager=sh status`.
- [unit] `checkBashCommand` with grant `Bash(git *)` returns `kind: "allow"` for `git -C . log -c`.
- [unit] `checkBashCommand` with grant `Bash(*)` returns `kind: "deny"` for `echo git -c x`.

### US-005

- [unit] `approvalMemoryKey({ tool: "Bash", command: "npm exec prettier" })` returns `undefined`.
- [unit] `approvalMemoryKey({ tool: "Bash", command: "npm x prettier" })` returns `undefined`.
- [unit] `approvalMemoryKey({ tool: "Bash", command: "pnpm dlx create-app" })` returns `undefined`.
- [unit] `approvalMemoryKey({ tool: "Bash", command: "pnpm exec tsc" })` returns `undefined`.
- [unit] `approvalMemoryKey({ tool: "Bash", command: "yarn dlx create-app" })` returns `undefined`.
- [unit] `approvalMemoryKey({ tool: "Bash", command: "yarn exec tsc" })` returns `undefined`.
- [unit] `approvalMemoryKey({ tool: "Bash", command: "npm create vite" })` returns `undefined`.
- [unit] `approvalMemoryKey({ tool: "Bash", command: "pnpm create vite" })` returns `undefined`.
- [unit] `approvalMemoryKey({ tool: "Bash", command: "yarn create vite" })` returns `undefined`.
- [unit] `approvalMemoryKey({ tool: "Bash", command: "npm init vite" })` returns `undefined`.
- [unit] `approvalMemoryKey({ tool: "Bash", command: "npm install lodash" })` returns `"Bash:npm install lodash"`, so an allow remembered for it is not found for `npm install evil`.
- [unit] `approvalMemoryKey({ tool: "Bash", command: "npm install" })` returns `"Bash:npm install"`.
- [unit] `approvalMemoryKey({ tool: "Bash", command: "npm run test" })` returns `"Bash:npm run test"`.
- [unit] `approvalMemoryKey({ tool: "Bash", command: "npm run deploy" })` returns `"Bash:npm run deploy"`, so an allow remembered under `"Bash:npm run test"` is not found for it.
- [unit] `approvalMemoryKey({ tool: "Bash", command: "pnpm run build" })` returns `"Bash:pnpm run build"`.
- [unit] `approvalMemoryKey({ tool: "Bash", command: "npm test" })` returns `"Bash:npm test"`.
- [unit] `approvalMemoryApplies({ tool: "Bash", command: "npm run test --watch" }, "allow")` returns `false`.

### US-006

- [unit] `createCommandLauncher({ state: { kind: "unavailable", backend: "srt", reason: "glob", failClosed: true } }).run(request)` for a shell request without `unwrapped` rejects with a `NaxError` whose `code` is `SANDBOX_POLICY_NOT_LITERAL`, and `_launcherDeps.runArgv` is never called.
- [unit] The same fail-closed launcher's `run(request)` with `unwrapped: true` calls `_launcherDeps.runArgv` once.
- [unit] `createCommandLauncher({ state: { kind: "unavailable", backend: "srt", reason: "no bwrap" } }).run(request)` without `unwrapped` calls `_launcherDeps.runArgv` once.
- [integration] `resolveSessionSandbox` with sandboxing enabled, an available backend and a root path containing `re[x]po` returns a launcher whose `state` is `kind: "unavailable"` with `failClosed: true` and a `reason` naming `re[x]po`.
- [integration] `resolveSessionSandbox` with sandboxing enabled and a backend whose probe reports unavailable (`"no bwrap"`) returns a launcher whose `state` has no `failClosed` field.
- [integration] The Bash tool, given the launcher `resolveSessionSandbox` returns for a `re[x]po` root and the command `echo hi`, returns a result with `isError: true` whose content names `re[x]po`, and no process is spawned.
- [unit] `buildCommitArgvs({ message: "feat: x", paths: ["src/a.ts"] })` returns a `commit` argv equal to `["-c", "core.hooksPath=/dev/null", "commit", "-m", "feat: x"]`.
- [integration] In a temp git repo with `core.hooksPath=.husky` and an executable `.husky/pre-commit` that writes a `marker` file, running the `GitCommit` tool on a staged change creates the commit, and `marker` does not exist afterwards.
- [integration] In a temp git repo with the default hooks path and an executable `.git/hooks/commit-msg` that writes a `marker` file, running the `GitCommit` tool creates the commit, and `marker` does not exist afterwards.
- [integration] In a temp git repo with an executable `.git/hooks/post-commit` that writes a `marker` file, running the `GitCommit` tool creates the commit, and `marker` does not exist afterwards.

### US-007

- [unit] `decideSandboxedShell` with a shell-sandbox plan for agent `opencode` (`verify: false`), rules denying `Bash(git push *)`, and the command `wrapForSandbox(plan.prefix, "git push origin main")` selects the reject option.
- [unit] `decideSandboxedShell` with a shell-sandbox plan for agent `pi` (`verify: false`), rules denying `Bash(git push *)`, and the command `wrapForSandbox(plan.prefix, "git push origin main")` selects the reject option.
- [unit] `decideSandboxedShell` with an `opencode` plan, rules denying `Bash(git push *)`, and the command `wrapForSandbox(plan.prefix, "git status")` selects the allow-once option.
- [unit] `decideSandboxedShell` with an `opencode` plan, rules denying `Bash(rm *)`, and the command `wrapForSandbox(plan.prefix, "rm -rf 'it'\''s here'")` selects the reject option.
- [unit] `decideSandboxedShell` with a `cursor` plan (`verify: true`), rules denying `Bash(git push *)`, and the command `wrapForSandbox(plan.prefix, "git push origin main")` selects the reject option.
