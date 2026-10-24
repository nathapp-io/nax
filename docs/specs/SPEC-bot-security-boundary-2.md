# SPEC: Bot security boundary, part 2 (agent config, fix file policy, untrusted inputs)

## Summary

`nax bot fix` and `nax bot review` still let PR content and outsiders steer nax in six ways that the 2026-10-22 bot
review found and the first security spec (S1-S3) set aside. This spec closes them. The fix session runs on the
base branch's agent configuration (instruction files, `.claude/`, MCP, per-agent config) instead of the PR head's,
and the PR's own copies are put back before nax commits. The fix may not change agent configuration or `.husky/`
hooks, and the fix summary lists the files it changed beyond the agreed items. The pinned list covers every agent nax
supports. A fix on a repo with no nax config and no instruction-file checks needs an explicit `--trust`. A review
that read text from someone without write access cannot settle a workflow item as fixed. Confidential GitLab
issues stay out of the review prompt, CI log excerpts are fenced, an untrusted PR's own spec and PRD are not read as
intent, and two more forge credentials are kept from the native agent's shell.

## Motivation

Verified on `main` @ `6cf9150a7` (v0.91.6) against the workspace report `nax-bot-review-gap-analysis-2026-10-22.md`
(items S4, S5, S6, S9, S10, S12, H13) and the deferred minors of PR #2639:

- **S5 (ruled 2026-10-22: pin base).** `runBotFix` prepares its checkout with `pinBaseFiles: false`
  (`src/bot/fix-run.ts`), so the fix agent loads the PR head's `CLAUDE.md`, `AGENTS.md`, `.claude/` settings and
  hooks, `.mcp.json` and `.nax/rules`. The review pins these from the base; the fix does not. Pinning cannot reuse
  the review's `pinInstructions` as-is: it stages the base copies, so `git add -A` or `git commit -a` by the agent
  would commit them, and `unsafeTree` would report every fix as `dirty`. A per-worktree `info/exclude` is not read
  by git (checked with git 2.50.1), so base-only files cannot be hidden that way; `update-index --skip-worktree`
  does keep tracked files out of `git add -A` (same check).
- **S6.** `fixProtectedPaths` (`src/bot/path-policy.ts`) refuses `.nax/`, `.github/`, `.gitlab/`, `.gitlab-ci.yml`
  and secret file names only. A fix can rewrite `AGENTS.md`, `.claude/settings.json`, `.mcp.json` or `.husky/`
  hooks and nax pushes it.
- **S12.** `BASE_PINNED_PATHS` / `BASE_PINNED_NAMES` (`src/bot/checkout.ts`) miss opencode (`.opencode/`,
  `opencode.json`), gemini (`.gemini/`), codex (`.codex/`), pi (`.pi/`), aider (`.aider.conf.yml`, which can set
  `test-cmd` and `lint-cmd`), windsurf (`.windsurfrules`), codex's `AGENTS.override.md` and Claude's `CLAUDE.local.md`.
- **H13 (ruled 2026-10-22: needs `--trust`).** On a repo whose base has no nax config and no `AGENTS.md` /
  `CLAUDE.md` checks, `resolveBotChecks` falls back to package scripts (`source: "detected"`) and the fix runs.
- **S4.** `postEarlier` (`src/bot/post-earlier.ts`) posts a `wr-fixed-<key>` echo, which settles a workflow `w-`
  item, whenever the review's verdict calls it fixed. The item threads are filtered to writers' replies, but the
  same review prompt carries every other thread and top-level comment, so an outsider's "B2 is fixed now" can
  produce that verdict.
- **S9.** ACP agents get an allowlisted environment with no forge tokens (`buildAgentEnv`,
  `packages/nax-agent-acp/src/client/env.ts`). The native agent's Bash strips `quality.stripEnvVars`, whose default
  lacks `GITLAB_TOKEN`, `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN`, and the sandbox read-denies
  `.config/gh` but not glab's `.config/glab-cli`.
- **S10.** `parseReply` (`src/forge/issues.ts`) returns a GitLab issue even when it is confidential, so a fork MR
  saying "Closes #n" pulls a confidential issue into a review that posts publicly. `ciCheckIssue`
  (`src/workflow/ci-repair-steps.ts`) puts the CI log excerpt into the repair finding unfenced.
- **#2639 deferred minor.** `featureIntentPaths` (`src/bot/intent.ts`) hands the PR head's
  `.nax/features/<f>/{prd.json,spec.md}` to the review as intent for untrusted (static) PRs too.

User direction 2026-10-24: one spec. No issues are filed (as with S1-S3). Items checked and dropped: the #2623
protected-path rendering (already `safeCode` inside code spans), the #2623 unvalidated `baseSha` (now `rev-parse`
output of a run-owned ref), H15 (handled by `WORKFLOW_DESIGN_DECISIONS_ITEM`, which tells the reviewer an edited ADR
is not settled authority).

## Design

### Approach

1. **One pinned-config list (S12).** `BASE_PINNED_PATHS` and `BASE_PINNED_NAMES` move from `src/bot/checkout.ts`
   to `src/bot/path-policy.ts`, which is pure, and gain `.opencode`, `opencode.json`, `.gemini`, `.codex`, `.pi`,
   `.aider.conf.yml`, `.windsurfrules` and the names `AGENTS.override.md` and `CLAUDE.local.md`. A new `isPinnedPath(file)` answers "is this repo-relative path agent configuration":
   equal to or under a `BASE_PINNED_PATHS` entry, or a basename in `BASE_PINNED_NAMES`. `checkout.ts` imports both
   lists, so the review's pin covers the new entries unchanged.
2. **Fix file policy (S6, user ruling 2026-10-24: protected list plus report).** `fixProtectedPaths` also refuses
   `isPinnedPath` files and anything under `.husky/`; `sensitivePaths` flags the same files in the review summary.
   Files outside the agreed items are not refused: on a `pushed` outcome the fix summary adds one line listing the
   changed files no agreed item names, computed in `reportStep` from `state.changed` and the agreed items' `file`
   fields, so `checkStep` and the graph declarations are unchanged.
3. **Session-scoped base pin (S5).** A new module `src/bot/session-pin.ts` pins the base agent configuration into a
   worktree for the length of one agent session and puts the head's back afterwards (skeleton below). It reads the
   pinned files of `HEAD` and of the base with `ls-tree`, removes the head copies, checks out the base copies,
   resets the index for those paths to `HEAD`, records each base-only file as intent-to-add (`git add -N`), and
   marks every pinned file present in the index (head files and the intent-to-add base-only files)
   `skip-worktree`, so the agent's `git add -A`, `git status` and `git commit -a` leave them all out (checked with
   git 2.50.1). Restore clears `skip-worktree`, resets the index for those paths to `HEAD` (which drops the
   intent-to-add entries), removes every pinned path and checks the pinned files of the then-current `HEAD` out
   again, so an agent commit that changed a pinned file stays in `HEAD` and is refused as `protected` by
   `checkStep`. A pinned path whose parent inside the worktree is a symlink or a regular file is skipped with a
   warning, both when pinning and again immediately before each removal at restore (the agent may have swapped a
   directory for a link during the session). Pathspec arguments to `checkout`, `reset` and `add -N` carry the
   `:(literal)` magic prefix, so a file name with glob characters matches only itself; `update-index` takes plain
   paths. Every git call goes through `botGit`.
4. **Wiring (S5).** `BranchStepContext` gains `sessionScope`; `runBranchFix` runs only `runFixSession` inside it,
   so `commitLeftovers` sees the head's configuration. `fixCheckout` sets `sessionScope` to
   `_botFixDeps.basePinScope(checkout.worktree, checkout.baseSha)` unless the checkout is in place (user ruling
   2026-10-24: `--in-place` is your own working tree and is not pinned). The fix and repair prompts say the agent
   configuration is the base's for this session and must not be edited or committed.
5. **`--trust` for detected checks (H13).** `nax bot fix` gains `--trust` (per invocation, never stored). In
   `fixCheckout`, checks with `source: "detected"` (also when reused from the saved review) refuse the fix unless
   `input.trust` is true. The flag covers only this case; untrusted PRs are still refused (S11 stays deferred).
6. **No outsider-driven item settling (S4, user ruling 2026-10-24: fail closed, no extra call).** When the review
   has open workflow items (`itemEarlier` non-empty), `reviewEnvironment` asks a new `hasNonWriterAuthor` whether
   any thread, top-level comment or earlier-thread comment the review read was written by someone other than the
   bot and without write access (the same cached `writerCheck`; a failed check counts as no write access).
   `PostReviewInput.itemFixedBlocked` carries the answer, and `effectiveEarlier` then treats a `fixed` verdict on a
   `w-` item as open, so `postEarlier` posts no echo and resolves nothing (one warning) and `earlierCounts` counts it
   as open in the review summary. `f-` findings and every other verdict are unchanged. A CI bot or any other
   commenter without write access blocks item settling on that PR; that is the fail-closed ruling.
7. **Untrusted inputs (S10, #2639, S9 in nax).** `parseReply` returns `null` for a GitLab issue with
   `confidential: true`. `ciCheckIssue` wraps the excerpt in `markdownFence`. `reviewEnvironment` passes intent
   paths only when the review is not static. The `quality.stripEnvVars` default gains `GITLAB_TOKEN`,
   `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` at both places that define it: the field default in
   `QualityConfigSchema` (`src/config/schemas-execution.ts`) and the `QualityConfigSchema.default({...})` literal
   in `NaxConfigSchema` (`src/config/schemas.ts`), which is what `DEFAULT_CONFIG` reads.
8. **glab credentials (S9 in nax-agent).** `BUILTIN_CREDENTIAL_READ_DENIES` gains `.config/glab-cli`.

### Integration

Read or called, unchanged:

- `botGit(args, workdir, timeoutMs?, maxBytes?)` from `src/bot/git.ts`: `git -c core.hooksPath=/dev/null <args>`.
- `PrCheckout` (`src/bot/checkout.ts`): `worktree`, `inPlace?`, `baseSha`, `mergeBase`, `changedFiles`.
- `writerCheck`, `type WriterCheck` (`@/forge`, re-exported by `src/bot/writers.ts`): cached per login; a rejected
  check resolves `false`.
- `markdownFence(text): string` (`@/utils/markdown-fence`): fence one backtick longer than the longest run, minimum 3.
- `safeCode(text, max?)` (`src/workflow/pr-body-safe.ts`).
- `resolveBotChecks` (`src/bot/checks.ts`) and `BotChecks.source: "config" | "agents-md" | "claude-md" | "detected" | "none"`.
- `featureIntentPaths(checkout)` (`src/bot/intent.ts`).
- `extractDispatchConfigFields(config).stripEnvVars` (`src/agents/dispatch-config-fields.ts`), which the native
  agent's Bash strips.
- `buildSandboxPolicy(input)` (`packages/nax-agent/src/sandbox/policy-builder.ts`): `denyRead` starts with
  `BUILTIN_CREDENTIAL_READ_DENIES` joined to the home directory.

Changed. The baseline only locates the code; the target is the interface to implement.

- `BASE_PINNED_PATHS`. Baseline: in `src/bot/checkout.ts`, `[".nax/rules", ".claude", ".cursor", ".mcp.json",
  ".github/copilot-instructions.md"]`. Target: in `src/bot/path-policy.ts`, that list followed by `".opencode",
  "opencode.json", ".gemini", ".codex", ".pi", ".aider.conf.yml", ".windsurfrules"`; `src/bot/index.ts` exports it from `./path-policy`.
- `BASE_PINNED_NAMES`. Baseline: in `src/bot/checkout.ts`, `["AGENTS.md", "CLAUDE.md", "GEMINI.md", "codex.md",
  ".cursorrules"]`. Target: in `src/bot/path-policy.ts`, that list followed by `"AGENTS.override.md", "CLAUDE.local.md"`; exported from
  `./path-policy`.
- `isPinnedPath(file: string): boolean` (new export of `src/bot/path-policy.ts` and `@/bot`).
- `fixProtectedPaths(files)` (`src/bot/path-policy.ts`): also keeps a file when `isPinnedPath(file)` or it starts
  with `.husky/`. Input order and spelling preserved.
- `sensitivePaths(files)` (`src/bot/path-policy.ts`): also keeps a file when `isPinnedPath(file)` or it starts with
  `.husky/`.
- `reportStep` (`src/bot/fix-report.ts`). Target: on outcome `pushed`, when at least one agreed item has a `file`,
  the `changed` files not equal to any agreed item's `file` are rendered as one line
  ``Also changed, not named by an agreed item: `a`, `b` `` (each through `safeCode`, at most 20 shown, the
  file-local constant `OUT_OF_ITEM_FILES_SHOWN`, then ` and <n> more`), passed to `renderFixSummary` with the other
  detail lines. Paths are compared as spelled (both are repo-relative); an absent `state.changed` yields no line.
- `BranchStepContext` (`src/workflow/branch-step-context.ts`) gains
  `readonly sessionScope?: <T>(run: () => Promise<T>) => Promise<T>`.
- `runBranchFix` (`src/workflow/branch-fix.ts`). Baseline: `ensureReport`, `runFixSession`, `commitLeftovers`.
  Target: `runFixSession` runs as `fc.sessionScope ? fc.sessionScope(() => runFixSession(...)) : runFixSession(...)`;
  `ensureReport` before and `commitLeftovers` after stay outside the scope.
- `_botFixDeps` (`src/bot/fix-run.ts`) gains `basePinScope` (from `./session-pin`).
- `fixCheckout` (`src/bot/fix-run.ts`, file-local). Baseline env `ctx: { ...context.ctx, runGit: botGit }`. Target:
  `ctx: { ...context.ctx, runGit: botGit, ...(checkout.inPlace ? {} : { sessionScope:
  deps.basePinScope(checkout.worktree, checkout.baseSha) }) }`; and after the `source === "none"` refusal, a
  refusal with reason `BOT_FIX_DETECTED_REFUSAL` when `checks.source === "detected"` and `input.trust !== true`.
- `BOT_FIX_DETECTED_REFUSAL` (new export of `src/bot/fix-run.ts` and `@/bot`): `"the base branch has no nax config
  and no AGENTS.md or CLAUDE.md checks; run nax setup, or pass --trust to run the package scripts nax detected"`.
- `BotFixInput` (`src/bot/fix-run.ts`) gains `readonly trust?: boolean`.
- `BotFixOptions` (`src/cli/bot.ts`) gains `readonly trust?: boolean`; `registerBotCommand` adds
  `.option("--trust", "Run on checks detected from package scripts (no nax config on the base branch)")` to the
  `fix` command only; `botFixCommand` passes `...(options.trust === true && { trust: true })` to `runBotFixCycle`.
- `runBotFixCycle` (`src/bot/fix-cycle.ts`) is unchanged: it already spreads `input` into the ready pass.
- `CheckoutStateInput` (`src/prompts/builders/bot-checkout-state-builder.ts`) gains `pinnedBase?: boolean`; with it
  `renderCheckoutState` appends, as its last line, `PINNED_BASE_NOTE` (new export of that builder file, re-exported
  from `@/prompts` beside `renderCheckoutState`): "Agent configuration (CLAUDE.md, AGENTS.md
  and the other instruction files, .claude/, .mcp.json and each agent's config directory) holds the base branch's
  versions for this session; nax restores the PR's versions afterwards. Do not edit, stage or commit those files."
- `fixStep` (`src/bot/fix-steps.ts`) and `repairStep` (`src/bot/repair-step.ts`) pass
  `pinnedBase: env.checkout.inPlace !== true` to `renderCheckoutState`.
- `hasNonWriterAuthor(comments: readonly PrComment[], login: string, check: WriterCheck): Promise<boolean>` (new
  export of `src/bot/writers.ts` and `@/bot`): `true` when any comment whose `author` is not `login` fails `check`
  (passing `{ login: author, id: authorId }`); `false` for an empty list.
- `PostReviewInput` (`src/bot/post.ts`) gains `readonly itemFixedBlocked?: boolean`; absent means `false`.
- `reviewEnvironment` (`src/bot/review-run.ts`, file-local). Target: when `recorded.itemEarlier` is non-empty, it
  sets `post.itemFixedBlocked` to `await hasNonWriterAuthor([...items.threads.flatMap((t) => t.comments),
  ...items.comments, ...postEarlier.flatMap((t) => t.comments)], items.login, writerCheck)`; otherwise it makes no
  such call. It passes `...intent` into the review input only when `staticMode` is false.
- `effectiveEarlier` (`src/bot/post-earlier.ts`). Target: for a `w-` key with verdict `fixed` and
  `input.itemFixedBlocked === true`, the entry's `verdict` becomes `{ ...verdict, status: "open" }` and the entry
  carries `blocked: true` (`EarlierEntry` gains `readonly blocked?: true`). `earlierCounts` and `withdrawalEvents`
  read the downgraded verdict unchanged.
- `postEarlier` (`src/bot/post-earlier.ts`). Target: for each entry with `blocked: true` it calls
  `getLogger()?.warn("bot-post", "Kept item open: the review read text from someone without write access",
  { threadId, key })` once; the existing `status === "open"` skip then posts and resolves nothing.
- `parseReply` (`src/forge/issues.ts`, file-local): a GitLab reply with `confidential === true` returns `null`.
  `readLinkedIssues`'s skip warning for a `null` result becomes `"Skipping linked reference: a pull request or a
  confidential issue"`.
- `ciCheckIssue` (`src/workflow/ci-repair-steps.ts`, file-local): the excerpt line becomes
  `markdownFence(check.excerpt)`; the heading lines are unchanged.
- `quality.stripEnvVars` default, at both sites: the `stripEnvVars` field default inside `QualityConfigSchema`
  (`src/config/schemas-execution.ts`) and the `stripEnvVars` array in the `quality: QualityConfigSchema.default({...})`
  literal of `NaxConfigSchema` (`src/config/schemas.ts`). Each becomes its existing list followed by
  `"GITLAB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"`.
- `BUILTIN_CREDENTIAL_READ_DENIES` (`packages/nax-agent/src/sandbox/defaults.ts`): the existing list followed by
  `".config/glab-cli"`.

### New modules

`src/bot/session-pin.ts` (worked skeleton; the builder owns the details):

```ts
import { lstat, rm } from "node:fs/promises";
import { botGit } from "./git";
import { isPinnedPath } from "./path-policy";

export const _sessionPinDeps = {
  runGit: botGit,
  rm: (path: string) => rm(path, { recursive: true, force: true }),
  lstat,
};

export interface SessionPin {
  /** Repo-relative pinned files touched: head copies removed, base copies written. */
  readonly paths: readonly string[];
  /** Put the head's (current HEAD's) pinned files back; clears skip-worktree. */
  restore(): Promise<void>;
}

/**
 * ls-tree -r HEAD and <baseSha>, keep isPinnedPath files, drop any under a linked or non-directory parent (warn),
 * rm head copies, `checkout <baseSha> -- <base files>`, `reset -q HEAD -- <all>`,
 * `add -N -- <base-only files>`, `update-index --skip-worktree -- <head files + base-only files>`.
 * `checkout`, `reset` and `add -N` pathspecs carry `:(literal)`; `update-index` takes plain paths (it rejects the
 * magic prefix); every `ls-tree` is `-r --name-only -z`. Throws BOT_SESSION_PIN_FAILED on a git failure.
 */
export async function pinBaseForSession(worktree: string, baseSha: string): Promise<SessionPin>;

/** pin -> run -> restore; a restore failure is logged and rethrown (fail closed), discarding the run's result. */
export function basePinScope(worktree: string, baseSha: string): <T>(run: () => Promise<T>) => Promise<T>;
```

`restore()` runs `update-index --no-skip-worktree -- <head files + base-only files>` (plain paths),
`reset -q HEAD -- <all>` (`:(literal)` pathspecs),
removes every path in `paths` whose parents are still real directories (re-checked with `lstat` right before each
removal; a linked or non-directory parent is skipped with the same warning), lists the pinned files of the current
`HEAD` with `ls-tree -r` and checks them out from `HEAD`; it throws `BOT_SESSION_RESTORE_FAILED` on a git failure.
With no pinned file at either side, `pinBaseForSession` runs only the two `ls-tree` calls.

### Failure Handling

| Failure | Behaviour |
|---|---|
| A git call in `pinBaseForSession` fails | `NaxError` `BOT_SESSION_PIN_FAILED` (stage `bot-fix`); `basePinScope` rejects without running the session |
| The session (`run`) rejects | `basePinScope` still calls `restore()`, then rethrows the session's error |
| `restore()` fails | `basePinScope` logs `warn("bot-fix", "Could not restore head agent configuration after the fix session", { worktree, error })` and rejects with that `BOT_SESSION_RESTORE_FAILED` error, so `runBotFix` rejects and nothing is pushed |
| A pinned path has a symlinked or regular-file parent in the worktree, at pin or at restore | path skipped, `warn("bot-fix", "Skipped pinning a path under a linked or non-directory parent", { path })`; pin or restore continues |
| The agent commits a change to a pinned file | the change stays in `HEAD` after restore; `checkStep` refuses it as `protected` |
| `checks.source === "detected"` without `--trust` | fix refused with `BOT_FIX_DETECTED_REFUSAL`; no fix session |
| `writerCheck` fails for a login while computing `itemFixedBlocked` | that login counts as no write access, so `itemFixedBlocked` is `true` |
| GitLab issue is confidential | skipped like a pull-request reference, with the warning above |

## Out of Scope

- `nax bot fix --in-place` does not pin the base agent configuration; it runs in the user's own working tree (user ruling 2026-10-24).
- A fix that changes files no agreed item names is reported in the fix summary, never refused (user ruling 2026-10-24); a stricter file scope is not built.
- `--trust` lifts only the detected-checks refusal; it does not let `nax bot fix` run on an untrusted PR, and sandboxed gates for untrusted PRs (S11) stay deferred.
- `nax bot review` does not gain `--trust`; a review on detected checks keeps running as today.
- A `w-` item is not settled by a second, writer-only model call; a blocked `fixed` verdict stays open until a writer rules or `nax bot fix` pushes a fix (user ruling 2026-10-24).
- `itemFixedBlocked` does not consider linked issue bodies or the PR description; only thread, top-level and earlier-thread comments count.
- Base pinning skips any pinned path under a symlinked or regular-file parent; the head's file at such a path stays for the session.
- An agent that deliberately clears `skip-worktree` and commits a pinned file gets its fix refused as `protected`; the pin does not try to prevent that.
- Agreed item `file` values and changed paths are compared as spelled for the out-of-item line; a non-canonical spelling such as `./src/a.ts` is not normalised.
- A user or project config that sets `quality.stripEnvVars` replaces the default list, so the three new tokens are not stripped there.
- Git hook managers other than husky (`.githooks/`, `lefthook.yml`, `.pre-commit-config.yaml`) are not added to the protected list.
- An uncommitted agent edit to a pinned file is discarded when the head's copy is restored; the fix proceeds without it.
- `.husky/` is matched at the repo root only, and pinned names match case-sensitively, so a `claude.md` that a case-insensitive filesystem treats as `CLAUDE.md` is neither pinned nor protected.
- A fix process killed mid-session leaves its throwaway worktree pinned (skip-worktree set); no recovery path reuses that worktree's index, and the saved fix keeps only the commit.
- The three new `quality.stripEnvVars` tokens are also stripped from nax's own gate and test runs, not just the native agent's Bash; that is intended.
- The review's own pin (`pinInstructions`) is unchanged apart from reading the longer lists.
- Whether each ACP agent's static review really has no network access is not checked here; it needs a per-agent probe.
- The macOS keychain is not denied to the native agent's shell; `gh` or `glab` reading a keychain token is not blocked by this spec.
- CI check names and failed-step names in the CI repair finding are not fenced; only the log excerpt is.
- A second `nax bot fix` posting duplicate replies on agreed threads, and the other GitLab and rerun-state bugs (C1-C8 of the 2026-10-22 report), are a separate spec.
- H15 (design decisions read from the PR head) is not changed; `WORKFLOW_DESIGN_DECISIONS_ITEM` already tells the reviewer an edited ADR is not settled authority.
- User documentation of `--trust`, the protected list and the pinned fix session, and the denied read paths list in `docs/guides/sandbox-and-command-safety.md`, are a manual follow-up after merge.

## Stories

Nine stories, one boundary: PR content and outsiders must not steer nax with the user's privileges. Eight are in
`packages/nax`, one in `packages/nax-agent`. Confirmed as one spec by the user (2026-10-24); the session pin is two
stories only because its acceptance criteria exceed the per-story cap as one.

### US-001: One pinned agent-config list covering every supported agent
No dependencies. Workdir: packages/nax.

Moves `BASE_PINNED_PATHS` and `BASE_PINNED_NAMES` to `src/bot/path-policy.ts`, adds the opencode, gemini and codex
entries, the pi, aider and windsurf entries, `AGENTS.override.md` and `CLAUDE.local.md`, adds `isPinnedPath`, and points `src/bot/checkout.ts` and the barrel at the moved
lists.

### US-002: Fix file policy protects agent config and reports out-of-item files
Depends on US-001. Workdir: packages/nax.

`fixProtectedPaths` and `sensitivePaths` also cover `isPinnedPath` files and `.husky/`; `reportStep` adds the
out-of-item line to a `pushed` summary.

### US-003: Session-scoped base pin and restore
Depends on US-001. Workdir: packages/nax.

Adds `src/bot/session-pin.ts` with `pinBaseForSession`, `SessionPin` and `_sessionPinDeps`: the pin, the restore and
their git mechanics.

### US-004: Pin path safety and the session scope wrapper
Depends on US-003. Workdir: packages/nax.

Adds the linked-or-non-directory parent check to `pinBaseForSession` and `restore()` (re-checked before each
removal), and adds `basePinScope`, all in `src/bot/session-pin.ts`.

### US-005: The fix session runs on the base agent configuration
Depends on US-004. Workdir: packages/nax.

Adds `BranchStepContext.sessionScope` and runs `runFixSession` inside it, sets it from `_botFixDeps.basePinScope`
in `fixCheckout` for worktree checkouts, and adds the `pinnedBase` note to the fix and repair prompts.

### US-006: `--trust` gates a fix on detected checks
No dependencies. Workdir: packages/nax.

Adds `--trust` to `nax bot fix`, `BotFixInput.trust`, `BOT_FIX_DETECTED_REFUSAL` and the refusal in `fixCheckout`.

### US-007: A review that read outsider text cannot settle a workflow item as fixed
No dependencies. Workdir: packages/nax.

Adds `hasNonWriterAuthor`, `PostReviewInput.itemFixedBlocked`, its computation in `reviewEnvironment`, and the
blocked branch in `postEarlier`.

### US-008: Untrusted text and forge tokens kept out of prompts and shells
No dependencies. Workdir: packages/nax.

Skips confidential GitLab issues, fences the CI log excerpt, drops head intent paths from static reviews, and adds
three forge tokens to the `quality.stripEnvVars` default.

### US-009: The native sandbox denies glab's credential store
No dependencies. Workdir: packages/nax-agent.

Adds `.config/glab-cli` to `BUILTIN_CREDENTIAL_READ_DENIES`.

### Context Files

**US-001**
- `packages/nax/src/bot/path-policy.ts` — `fixProtectedPaths`, `sensitivePaths`
- `packages/nax/src/bot/checkout.ts` — `BASE_PINNED_PATHS`, `BASE_PINNED_NAMES`, `pinInstructions`
- `packages/nax/src/bot/index.ts` — the barrel lines exporting both lists
- `packages/nax/test/integration/bot/checkout.test.ts` — real-repo pin fixture

**US-002**
- `packages/nax/src/bot/path-policy.ts` — `isPinnedPath`, created by US-001, used here
- `packages/nax/src/bot/fix-report.ts` — `reportStep`, `renderFixSummary`, `outcomeText`
- `packages/nax/src/bot/post.ts` — `AgreedItem` and its `file` field
- `packages/nax/test/unit/bot/path-policy.test.ts` — existing policy cases

**US-003**
- `packages/nax/src/bot/checkout.ts` — `pinInstructions`, `removePinnedPath` (the review's pin to mirror)
- `packages/nax/src/bot/git.ts` — `botGit`
- `packages/nax/src/bot/path-policy.ts` — `isPinnedPath`, created by US-001, used here

**US-004**
- `packages/nax/src/bot/session-pin.ts` — created by US-003, extended here
- `packages/nax/src/bot/checkout.ts` — `removePinnedPath`, `hasErrorCode` (the review's ENOENT/ENOTDIR handling)

**US-005**
- `packages/nax/src/workflow/branch-fix.ts` — `runBranchFix`, `runFixSession`, `commitLeftovers`
- `packages/nax/src/workflow/branch-step-context.ts` — `BranchStepContext`
- `packages/nax/src/bot/fix-run.ts` — `fixCheckout`, `_botFixDeps`
- `packages/nax/src/bot/repair-step.ts` — `repairStep`
- `packages/nax/src/prompts/builders/bot-checkout-state-builder.ts` — `renderCheckoutState`
- `packages/nax/src/bot/session-pin.ts` — created by US-003, used here

**US-006**
- `packages/nax/src/bot/fix-run.ts` — `fixCheckout`, `BotFixInput`, `fixChecks`
- `packages/nax/src/cli/bot.ts` — `BotFixOptions`, `botFixCommand`, `registerBotCommand`
- `packages/nax/src/bot/fix-cycle.ts` — `runBotFixCycle`

**US-007**
- `packages/nax/src/bot/post-earlier.ts` — `postEarlier`, `effectiveEarlier`
- `packages/nax/src/bot/review-run.ts` — `reviewEnvironment`
- `packages/nax/src/bot/review-triage.ts` — `triage` (returns `threads`, `comments`, `earlier`, `login`, `writerCheck`)
- `packages/nax/src/bot/writers.ts` — `readWriters`
- `packages/nax/src/bot/post.ts` — `PostReviewInput`

**US-008**
- `packages/nax/src/forge/issues.ts` — `parseReply`, `readLinkedIssues`
- `packages/nax/src/workflow/ci-repair-steps.ts` — `ciCheckIssue`
- `packages/nax/src/bot/review-run.ts` — `reviewEnvironment`
- `packages/nax/src/config/schemas-execution.ts` — `QualityConfigSchema`, its `stripEnvVars` field default
- `packages/nax/src/config/schemas.ts` — the `quality: QualityConfigSchema.default({...})` literal and its `stripEnvVars` array

**US-009**
- `packages/nax-agent/src/sandbox/defaults.ts` — `BUILTIN_CREDENTIAL_READ_DENIES`
- `packages/nax-agent/src/sandbox/policy-builder.ts` — `buildSandboxPolicy`
- `packages/nax-agent/test/unit/sandbox/policy-builder.test.ts` — policy input fixture

### Creates

**US-003**
- `packages/nax/src/bot/session-pin.ts`
- `packages/nax/test/unit/bot/session-pin.test.ts`
- `packages/nax/test/integration/bot/session-pin.test.ts`

**US-004**
- `packages/nax/test/unit/bot/session-pin-scope.test.ts`
- `packages/nax/test/integration/bot/session-pin-links.test.ts`

**US-005**
- `packages/nax/test/integration/bot/fix-pinned-session.test.ts`

**US-006**
- `packages/nax/test/integration/bot/fix-trust.test.ts`

**US-007**
- `packages/nax/test/integration/bot/item-fixed-blocked.test.ts`

### Modifies

**US-006**
- `packages/nax/test/integration/bot/fix-run.test.ts` — the `beforeEach` env uses checks with `source: "detected"`, and every test runs `runBotFix(input)` expecting the fix to proceed; the shared `input` object gains `trust: true` so those tests keep running the fix. The invariant each test pins is unchanged.

**US-008**
- `packages/nax/test/unit/workflow/feature-steps-ci-repair-decision.test.ts` — the mixed-evidence test (about line 138, labelled AC-13 in the CI-repair-decision block), the draft-with-failed-CI test (about line 153, AC-5), and the step-facts tests at about lines 368, 374 and 380 (AC-15, AC-16, AC-17) expect the CI finding's issue to end with the bare excerpt after the heading line (for example the heading `CI check e2e failed:` then `boom`); the excerpt becomes `markdownFence(<excerpt>)`, so each expected issue becomes the heading lines, a newline, then `markdownFence` of the same excerpt. The heading text, the skipped-steps line and their order are unchanged.

### Seams

- US-001 → US-002, US-003: `isPinnedPath` (US-001) is called by `fixProtectedPaths` and `sensitivePaths` (US-002) and
  by `pinBaseForSession` (US-003).
- US-003 → US-004: `pinBaseForSession` and `SessionPin.restore` (US-003) are what `basePinScope` (US-004) wraps.
- US-004 → US-005: `basePinScope` (US-004) is `_botFixDeps.basePinScope`, which `fixCheckout` (US-005) calls; US-005's
  seam ACs enter at `runBotFix`.
- US-007: `hasNonWriterAuthor` is called by `reviewEnvironment` in the same story; its seam ACs enter at `runBotReview`.

## Acceptance Criteria

### US-001

- [unit] `BASE_PINNED_PATHS` imported from `@/bot` equals `[".nax/rules", ".claude", ".cursor", ".mcp.json", ".github/copilot-instructions.md", ".opencode", "opencode.json", ".gemini", ".codex", ".pi", ".aider.conf.yml", ".windsurfrules"]`.
- [unit] `BASE_PINNED_NAMES` imported from `@/bot` equals `["AGENTS.md", "CLAUDE.md", "GEMINI.md", "codex.md", ".cursorrules", "AGENTS.override.md", "CLAUDE.local.md"]`.
- [unit] `isPinnedPath(".claude/settings.json")` returns `true`.
- [unit] `isPinnedPath("packages/x/CLAUDE.md")` returns `true`.
- [unit] `isPinnedPath("opencode.json")` returns `true`.
- [unit] `isPinnedPath("packages/x/opencode.json")` returns `false`, because `opencode.json` is a root path entry, not a name.
- [unit] `isPinnedPath(".aider.conf.yml")` returns `true`.
- [unit] `isPinnedPath("packages/x/CLAUDE.local.md")` returns `true`.
- [unit] `isPinnedPath(".claudex/a.md")` returns `false`.
- [unit] `isPinnedPath("docs/claude.md")` returns `false` (names match exactly, case included).
- [integration] In a real repo whose base commit has `opencode.json` with text `base` and whose PR head changes it to `head`, `preparePrCheckout` with `pinBaseFiles: true` leaves the worktree's `opencode.json` reading `base`.
- [integration] In that fixture, a PR head that adds `.gemini/settings.json` (absent at the base) yields a worktree without `.gemini/settings.json` after `preparePrCheckout` with `pinBaseFiles: true`.
- [integration] In that fixture, a PR head that adds `packages/x/AGENTS.override.md` yields a worktree without that file after `preparePrCheckout` with `pinBaseFiles: true`.
- [integration] In that fixture, with `.codex/config.toml` reading `base` at the base and `head` at the PR head, the pinned worktree's `.codex/config.toml` reads `base`.
- [integration] In that fixture, with `.opencode/agent.md` reading `base` at the base and `head` at the PR head, the pinned worktree's `.opencode/agent.md` reads `base`.

### US-002

- [unit] `fixProtectedPaths([".claude/settings.json", "src/a.ts"])` returns `[".claude/settings.json"]`.
- [unit] `fixProtectedPaths(["packages/x/CLAUDE.md"])` returns `["packages/x/CLAUDE.md"]`.
- [unit] `fixProtectedPaths([".mcp.json"])` returns `[".mcp.json"]`.
- [unit] `fixProtectedPaths([".husky/pre-commit"])` returns `[".husky/pre-commit"]`.
- [unit] `fixProtectedPaths(["AGENTS.override.md", "opencode.json"])` returns both, in that order.
- [unit] `fixProtectedPaths(["src/claude.ts", "app/.huskyrc"])` returns `[]`.
- [unit] `sensitivePaths([".claude/hooks/x.sh", "src/a.ts", ".husky/pre-push"])` returns `[".claude/hooks/x.sh", ".husky/pre-push"]`.
- [integration] `checkStep` with `_fixStepsDeps.changedPaths` returning `["AGENTS.md", "src/a.ts"]` returns exit `protected` with `protectedFiles` `["AGENTS.md"]`.
- [integration] `reportStep` for outcome `pushed`, agreed items naming files `src/a.ts`, and `changed` `["src/a.ts", "src/b.ts"]` posts a fix summary containing the line ``Also changed, not named by an agreed item: `src/b.ts` ``.
- [integration] `reportStep` for outcome `pushed` whose `changed` files are all named by agreed items posts a summary without a line starting `Also changed, not named by an agreed item`.
- [integration] `reportStep` for outcome `pushed` where no agreed item has a `file` posts a summary without a line starting `Also changed, not named by an agreed item`.
- [integration] `reportStep` for outcome `gates-failed` with `changed` files no agreed item names posts a summary without a line starting `Also changed, not named by an agreed item`.
- [integration] `reportStep` for outcome `pushed` with 23 unnamed changed files lists the first 20 and ends that line with ` and 3 more`.
- [integration] `reportStep` renders each unnamed path as backticks around `safeCode(path)`: a changed path `src/@alice.ts` appears as `` `${safeCode("src/@alice.ts")}` ``.

### US-003

The fixture for every integration AC here: a real repo whose base commit has `CLAUDE.md` reading `base` and
`.mcp.json` reading `base-mcp`, and whose checked-out head has `CLAUDE.md` reading `head`, adds
`.claude/settings.json` reading `head-settings` and deletes `.mcp.json`.

- [integration] `pinBaseForSession(worktree, baseSha)` leaves the worktree's `CLAUDE.md` reading `base`.
- [integration] After that pin, `git status --porcelain` in the worktree has no line naming `CLAUDE.md`.
- [integration] After that pin, `git diff --cached --name-only` in the worktree prints nothing.
- [integration] After that pin, `.claude/settings.json` does not exist in the worktree.
- [integration] After that pin, `.mcp.json` reads `base-mcp`.
- [integration] After that pin, `git status --porcelain` has no line naming `.mcp.json`.
- [integration] After that pin, editing `src/a.ts` and running `git add -A` and `git commit -m x` creates a commit whose changed-file list (`git show --name-only` of `HEAD`) is exactly `src/a.ts`.
- [integration] After that commit, `git show HEAD:CLAUDE.md` prints `head`.
- [integration] After the pin, `restore()` leaves `CLAUDE.md` reading `head`.
- [integration] After the pin, `restore()` leaves `.claude/settings.json` reading `head-settings`.
- [integration] After the pin, `restore()` leaves no `.mcp.json` in the worktree.
- [integration] After the pin, `restore()` leaves `git status --porcelain` empty.
- [integration] When, after the pin, the test writes `agent` to `CLAUDE.md`, runs `git update-index --no-skip-worktree CLAUDE.md`, `git add CLAUDE.md` and `git commit -m x`, `restore()` leaves `CLAUDE.md` reading `agent`.
- [unit] `_sessionPinDeps.runGit` equals `botGit` by identity.
- [unit] With a `runGit` stub whose `ls-tree` calls list no pinned file on either side, `pinBaseForSession` makes exactly two `runGit` calls, both `ls-tree -r --name-only -z`.
- [unit] With a `runGit` stub listing `CLAUDE.md` at both sides, every `update-index` call `pinBaseForSession` makes passes the plain path `CLAUDE.md`, and every `checkout` and `reset` call passes `:(literal)CLAUDE.md`.
- [unit] When the stubbed `checkout` call exits non-zero, `pinBaseForSession` rejects with code `BOT_SESSION_PIN_FAILED`.
- [unit] When a stubbed git call in `restore()` exits non-zero, `restore()` rejects with code `BOT_SESSION_RESTORE_FAILED`.

### US-004

- [integration] In a real repo whose base commit has a real `docs/AGENTS.md` reading `base` and whose head makes `docs` a symlink to a directory outside the worktree holding `AGENTS.md` reading `outside`, pin and restore leave that outside `AGENTS.md` reading `outside`.
- [integration] In that fixture, `pinBaseForSession` calls the logger's `warn` with `Skipped pinning a path under a linked or non-directory parent`.
- [integration] In a real repo with a real `docs/AGENTS.md` at both base and head, when the test replaces the worktree's `docs` directory with a symlink to an outside directory holding `AGENTS.md` reading `outside` after the pin, `restore()` leaves that outside file reading `outside`.
- [integration] In that swapped-directory fixture, `restore()` calls the logger's `warn` with `Skipped pinning a path under a linked or non-directory parent`.
- [integration] In a real repo whose base commit has `.github/copilot-instructions.md` and whose head makes `.github` a regular file reading `head file`, `pinBaseForSession` resolves and the worktree's `.github` still reads `head file`.
- [integration] In that `.github` fixture, `pinBaseForSession` calls the logger's `warn` with `Skipped pinning a path under a linked or non-directory parent`.
- [unit] `basePinScope(worktree, baseSha)(run)`, with a `_sessionPinDeps.runGit` stub that records each argv and a `run` that records a marker, records the pin's `update-index --skip-worktree` call before the marker.
- [unit] In that recording, the restore's `update-index --no-skip-worktree` call comes after the marker.
- [unit] That `basePinScope` call resolves to `run`'s value.
- [unit] When `run` rejects with `Error("session failed")`, `basePinScope` still makes the restore's `update-index --no-skip-worktree` call.
- [unit] That `basePinScope` call rejects with the `session failed` error.
- [unit] When a restore git call exits non-zero after `run` resolved, `basePinScope` rejects with code `BOT_SESSION_RESTORE_FAILED`.
- [unit] That failed restore calls the logger's `warn` with `Could not restore head agent configuration after the fix session`.
- [unit] When the pin's `checkout` call exits non-zero, `basePinScope` rejects with code `BOT_SESSION_PIN_FAILED`.
- [unit] That failed pin never calls `run`.

### US-005

- [unit] `runBranchFix` with a `sessionScope` stub calls it once, and `_workflowDeps.callOp` runs after the scope started and before it ended.
- [unit] `runBranchFix` with a `sessionScope` stub and a dirty tree after the session calls `_workflowDeps.autoCommitIfDirty` after the scope ended.
- [unit] `runBranchFix` without `sessionScope` calls `_workflowDeps.callOp` once, as before (regression pin).
- [integration] `runBotFix` on a worktree checkout with one agreed item calls `_botFixDeps.basePinScope` with the checkout's `worktree` and `baseSha`.
- [integration] `runBotFix` on a worktree checkout with one agreed item calls `_fixStepsDeps.runBranchFix` with a context whose `sessionScope` is the function `_botFixDeps.basePinScope` returned.
- [integration] `runBotFix` with `inPlace: true` and one agreed item calls `_fixStepsDeps.runBranchFix` with a context whose `sessionScope` is `undefined`, and never calls `_botFixDeps.basePinScope`.
- [integration] On a red-gate repair round (one agreed item, `gatesStep` exiting `repair`), the repair's `runBranchFix` call also receives that `sessionScope`.
- [integration] `runBotFix` with one agreed item whose `_botFixDeps.basePinScope` returns a scope that runs the session and then rejects with code `BOT_SESSION_RESTORE_FAILED` rejects with that code and never calls `_botFixDeps.pushStep`.
- [unit] `renderCheckoutState({ phase: "fresh", headSha: "abcdef1234", setup: [], ciFiles: [], pinnedBase: true })` ends with the line `PINNED_BASE_NOTE`.
- [unit] `renderCheckoutState` without `pinnedBase` has no line equal to `PINNED_BASE_NOTE` (regression pin).
- [integration] `fixStep` with one agreed item for a worktree checkout sends a prompt containing `PINNED_BASE_NOTE`.
- [integration] `fixStep` with one agreed item for an in-place checkout sends a prompt without `PINNED_BASE_NOTE`.
- [integration] `repairStep` for a worktree checkout sends a prompt containing `PINNED_BASE_NOTE`.
- [integration] In a real repo with `CLAUDE.md` reading `base` at the base and `head` at the head, `runBranchFix` with `sessionScope: basePinScope(worktree, baseSha)` and a `callOp` stub that records the worktree's `CLAUDE.md` and edits `src/a.ts` records `base`, and afterwards the worktree's `CLAUDE.md` reads `head` and `git show HEAD:CLAUDE.md` prints `head`.

### US-006

- [integration] `runBotFix` with checks whose `source` is `detected` and no `trust` returns outcome `refused` with reason `BOT_FIX_DETECTED_REFUSAL`.
- [integration] That refused `runBotFix`, with one agreed item, never calls `_fixStepsDeps.runBranchFix`.
- [integration] `runBotFix` with one agreed item and checks whose `source` is `detected` and `trust: true` calls `_fixStepsDeps.runBranchFix`.
- [integration] `runBotFix` with one agreed item and checks whose `source` is `config` and no `trust` calls `_fixStepsDeps.runBranchFix`.
- [integration] `runBotFix` with one agreed item and checks whose `source` is `agents-md` and no `trust` calls `_fixStepsDeps.runBranchFix`.
- [integration] `runBotFix` reusing a version 3 review's saved `checks` with `source` `detected`, without `trust`, returns outcome `refused` with reason `BOT_FIX_DETECTED_REFUSAL`.
- [cli] `nax bot fix 42 --trust` calls `runBotFixCycle` with an input whose `trust` is `true`.
- [cli] `nax bot fix 42` calls `runBotFixCycle` with an input that has no `trust` property.
- [unit] `runBotFixCycle` given `trust: true` and a pushed fix calls the ready pass's `runBotFix` with `readyOnly: true` and `trust: true`.
- [unit] `BOT_FIX_DETECTED_REFUSAL` imported from `@/bot` contains `run nax setup` and `--trust`.

### US-007

- [unit] `hasNonWriterAuthor` imported from `@/bot`, over comments by `alice` and `mallory` with a check that is `true` for `alice` only, resolves `true`.
- [unit] `hasNonWriterAuthor` over comments by `alice` and the bot login `bot`, with a check `true` for `alice` and `false` for `bot`, resolves `false` (the bot's own comments never count).
- [unit] `hasNonWriterAuthor([], "bot", check)` resolves `false` and never calls `check`.
- [unit] `hasNonWriterAuthor` passes `{ login: "carol", id: 9 }` to the check for a comment by `carol` with `authorId` 9.
- [integration] `postPrReview` with `itemFixedBlocked: true`, an `itemEarlier` thread whose opener carries a `w-` marker, and an earlier verdict `fixed` for it posts no comment whose marker key starts `wr-fixed-` and does not resolve the thread.
- [integration] That blocked `postPrReview` calls the logger's `warn` with stage `bot-post`, message `Kept item open: the review read text from someone without write access`, and data `{ threadId, key }`.
- [integration] That blocked `postPrReview` posts a review summary whose earlier-findings line counts the item as still open and 0 fixed.
- [integration] `postPrReview` with `itemFixedBlocked` absent and the same `w-` thread and `fixed` verdict posts the `wr-fixed-<key>` echo and resolves the thread (regression pin).
- [integration] `postPrReview` with `itemFixedBlocked: true` and an `f-` earlier thread with verdict `fixed` still replies and resolves it.
- [integration] `postPrReview` with `itemFixedBlocked: true` and a `w-` thread with verdict `withdrawn` still replies as today.
- [integration] `runBotReview` on a nax workflow PR with an open `w-` item, a top-level comment by `mallory`, `_botReviewDeps.hasWriteAccess` `false` for `mallory`, and a review verdict `fixed` for the item posts no `wr-fixed-` comment.
- [integration] `runBotReview` on that PR with a reply by `mallory` inside another commenter's thread (not top-level) also posts no `wr-fixed-` comment.
- [integration] `runBotReview` on that PR with a reply by `mallory` on one of the bot's own `f-` finding threads also posts no `wr-fixed-` comment.
- [integration] `runBotReview` on that PR where every other comment's author has write access posts the `wr-fixed-` echo for the item.
- [integration] `runBotReview` on that PR where `_botReviewDeps.hasWriteAccess` rejects for `mallory` posts no `wr-fixed-` comment.
- [integration] `runBotReview` on a PR without open `w-` items never calls `_botReviewDeps.hasWriteAccess` for a thread replier who opened nothing (regression pin of the S3 call count).

### US-008

- [unit] `readIssue` on a GitLab ref whose reply is `{ "title": "Leak", "description": "secret", "confidential": true }` returns `null`.
- [unit] `readIssue` on a GitLab ref whose reply has `"confidential": false` returns the issue with title `Leak`.
- [unit] `readLinkedIssues` over a body closing a confidential GitLab issue and a public one returns only the public one.
- [unit] That `readLinkedIssues` call logs `warn("forge", "Skipping linked reference: a pull request or a confidential issue", …)` with the confidential issue's number in the data.
- [unit] The CI repair finding for a check named `e2e` with excerpt `boom` and no step facts has an issue equal to `CI check e2e failed:`, a newline, then `markdownFence("boom")`.
- [unit] The CI repair finding for a check named `Security audit` with failed step `bun audit`, no skipped steps and excerpt `E` has an issue equal to `CI check Security audit failed at step "bun audit".`, a newline, then `markdownFence("E")`.
- [unit] The CI repair finding for an excerpt containing a line of three backticks has an issue whose fenced block opens and closes with a line of four backticks.
- [integration] `runBotReview` on an untrusted (static) PR whose changed files are `.nax/features/x/prd.json` and `.nax/features/x/spec.md` calls the review with an input that has no `prdPath` and no `specPath`.
- [integration] `runBotReview` on a trusted PR with the same changed files calls the review with `prdPath` and `specPath` inside the checkout (regression pin).
- [unit] `DEFAULT_CONFIG.quality.stripEnvVars` contains `GITLAB_TOKEN`.
- [unit] `DEFAULT_CONFIG.quality.stripEnvVars` contains `GH_ENTERPRISE_TOKEN`.
- [unit] `DEFAULT_CONFIG.quality.stripEnvVars` contains `GITHUB_ENTERPRISE_TOKEN`.
- [unit] `extractDispatchConfigFields(DEFAULT_CONFIG).stripEnvVars`, the list the native agent's Bash strips, contains `GITLAB_TOKEN`.
- [unit] `QualityConfigSchema.parse({}).stripEnvVars` (a `quality` object given without the list) contains `GITLAB_TOKEN`, `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN`.

### US-009

- [unit] `buildSandboxPolicy` returns a `denyRead` containing the input's home directory joined with `.config/glab-cli`.
- [unit] That policy's `denyRead` still contains the input's home directory joined with `.config/gh` (regression pin).
