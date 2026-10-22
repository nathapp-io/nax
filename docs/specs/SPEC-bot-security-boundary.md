<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Bot security boundary (hooks, base binding, writer-only fix items)

## Summary

`nax bot review` and `nax bot fix` check out PR heads written by people the user may not trust. Three gaps let that
content act with the user's privileges: git hooks from the PR head run on nax's own git calls, the base commit is
read from the shared `FETCH_HEAD` that any other git process can overwrite, and a comment from anyone (writer or
not) can become work for the Bash-capable fix agent. This spec closes all three. Every git command nax runs itself
during a bot command gets `core.hooksPath=/dev/null` (including the fix's leftover commit) and the pushes get
`--no-verify`; the checkout fetches head and base into refs unique to the run and deletes them on dispose; and an
agreed thread or comment becomes a fix item only when someone with write access opened or wrote it.

## Motivation

Verified on `main` @ `b5a478df8` (v0.91.3); evidence in the workspace report
`nax-bot-review-gap-analysis-2026-10-22.md`, items S1-S3, and in spec-review pass 1:

- **S1 (critical).** `hardenedGitEnv` (`packages/nax-agent/src/internal/git-env.ts`) sets only `core.fsmonitor`,
  `diff.ignoreSubmodules` and `submodule.recurse`; hooks still run. With a relative `core.hooksPath` (husky v9
  writes `.husky/_` into `.git/config`), git resolves hooks inside the new worktree, which holds the PR head's
  content. Reproduced with git 2.50.1: a plain `git worktree add --detach` ran the repo's `post-checkout` hook and
  twelve `reference-transaction` hooks; the same command with `-c core.hooksPath=/dev/null` ran none.
  `preparePrCheckout` runs `worktree add` during the **static** review of an untrusted fork PR, in nax's own process
  with the user's environment. The fix also runs `pre-push` on `git push`, `post-checkout` in the gate baseline,
  `reference-transaction` on the saved-fix `update-ref`, and `pre-commit` / `commit-msg` / `post-commit` when
  `runBranchFix` commits the agent's leftover edits through `autoCommitIfDirty` (`src/utils/git.ts`), which calls
  `gitWithTimeout(["commit", ...])` in the PR worktree.
- **S2 (high).** `fetchRefs` (`src/bot/checkout.ts`) runs `git fetch origin <head spec>`, reads `FETCH_HEAD`, runs
  `git fetch origin <baseRef>` and reads `FETCH_HEAD` again. `FETCH_HEAD` is shared by every git process in the repo;
  an overlapping fetch (a second bot run, `nax run`, an editor) can make the "base" sha a fork head, and the base sha
  decides the base `.nax` snapshot, the pinned instruction files, gates and setup commands.
- **S3 (high).** `agreedItems` (`src/bot/post.ts`) turns every thread and top-level comment the review agrees with
  into an `AgreedItem`, whose text `nax bot fix` hands to an agent with Bash. Write access is checked only for rulings
  (`permissionReader` in `src/bot/rulings.ts`). On a public repo an outsider can write a plausible request the review
  agrees with and steer the fix agent.

User direction 2026-10-22: bundle S1, S2 and S3 into one spec. No issues are filed: S1 is exploitable in a public
repo and is fixed before it is described.

## Design

### Approach

1. **No hooks on bot git (S1).** A new leaf module `src/bot/git.ts` exports `botGit`: same signature as
   `gitWithTimeout`, but always runs `git -c core.hooksPath=/dev/null <args>` through `gitWithTimeout`'s
   `argvOverride` parameter, so the fsmonitor and submodule hardening and the timeout handling still apply. Every
   bot dependency object with a `runGit` member (`_checkoutDeps`, `_fixInputDeps`, `_fixStepsDeps`,
   `_gateBaselineDeps`, `_savedFixDeps`, `_botReviewDeps`, `_botChecksDeps`, `_baseConfigDeps`) defaults it to
   `botGit`. Both pushes (`pushStep`, and `checkPushAccess`'s dry run) also pass `--no-verify`. The change is
   bot-only: `nax run` keeps running hooks where its config asks for them (`tdd.testWriterCommitHooks: "run"`). The
   `["git", "-c", ...]` argv literal in `git.ts` carries `// nax-git-env-allow: handed to gitWithTimeout, which
   hardens it` for `check-git-spawn-env.ts`.
2. **Hook-free leftover commit (S1).** `autoCommitIfDirty` gains an optional seventh parameter
   `runGit: typeof gitWithTimeout` (default `gitWithTimeout`) used for every git call it makes, including the
   `gitlinkSafeAdd` and `hasStagedChanges` runners. `BranchStepContext` gains `readonly runGit?: typeof
   gitWithTimeout`; `commitLeftovers` (`src/workflow/branch-fix.ts`) passes `fc.runGit` as that seventh argument.
   `runBotFix` sets `runGit: botGit` on the step context it builds. Workflow runs leave it unset, so they behave as
   today.
3. **Run-unique refs (S2).** `preparePrCheckout` reserves its worktree directory **before** fetching, so the suffix
   is owned by this run, then runs one fetch with two forced refspecs into `refs/nax-bot/pr-<n>/checkout-<suffix>/head`
   and `.../base` and reads both with `rev-parse`. The head check (`BOT_PR_HEAD_MOVED`) still compares with
   `info.headSha`. `dispose()` and the failure cleanup delete both refs with `update-ref -d`, also when the checkout
   is retained (a retained worktree is detached at a sha; the saved-fix ref keeps unpushed work). The refs are
   deleted only on paths where this run created the reservation.
4. **Writer-only fix items (S3).** A new module `src/bot/writers.ts` exports `writerCheck`, a per-login cached
   wrapper of `hasWriteAccess` where a failed check counts as "not a writer" (fail closed) and is reported through an
   injected `warn` sink, and `readWriters`, which returns the logins with write access among the authors of the
   comments it is given, forwarding each comment's `authorId`. `triage` gives `readWriters` only comments that are
   not the bot's own (`isOwn`: marker plus login), so the bot's replies never count. `PostReviewInput` gains
   `writers`. In `agreedItems` an agreed thread is a fix item only when its opener (`thread.comments[0]`) is a
   writer — the item text is the opener's — and an agreed top-level comment only when its author is a writer. An
   agreed thread or comment that fails the check is still answered, with a "not queued" note; disagree and handled
   verdicts are rendered as today. The bot review artifact becomes version 3. `loadLatestReview` keeps accepting
   versions 1 and 2 but drops their `thread` and `comment` items (never writer-checked); `fixChecks` reuses saved
   checks for version 2 and above. `permissionReader` in `rulings.ts` delegates to `writerCheck` with its existing
   warning, so write access is decided in one place.

### Integration

Read or called, unchanged:

- `gitWithTimeout(args, workdir, timeoutMs?, maxBytes?, argvOverride?)` from `@/utils/git` (re-exported from
  `@nathapp/nax-agent/internal`). It spawns `hardenedGitArgv(argvOverride ?? ["git", ...args])` with
  `hardenedGitEnv(process.env)`; `hardenedGitArgv` skips `-c <value>` pairs when it looks for the verb.
- `hasWriteAccess(ref, { login, id? }, deps, cwd): Promise<boolean>` from `@/forge`; on GitLab it throws
  `FORGE_RESPONSE_UNPARSEABLE` when `id` is missing.
- `PrComment` (`author`, `authorId?`), `PrThread` (`comments`) from `@/forge`.
- `BOT_GIT_NETWORK_TIMEOUT_MS` (120 000) from `src/bot/checkout.ts`.
- `ownComments` from `@/forge`, as `triage` already uses it for `isOwn`.

Changed. The baseline only locates the code; the target is the interface to implement.

- `fetchRefs` (`src/bot/checkout.ts`, file-local). Baseline: `fetchRefs({ repoRoot, ref, info })`, two fetches, two
  `rev-parse FETCH_HEAD`. Target: `fetchRefs({ repoRoot, ref, info, refs: CheckoutRefs }): Promise<{ baseSha;
  mergeBase }>` with one `fetch --no-tags origin +<headSpec>:<refs.head> +refs/heads/<baseRef>:<refs.base>`
  (network timeout), then `rev-parse <refs.head>` and `rev-parse <refs.base>`.
- `checkoutRefs(n: number, suffix: string): CheckoutRefs` (new export of `src/bot/checkout.ts` and `@/bot`):
  `{ head: "refs/nax-bot/pr-<n>/checkout-<suffix>/head", base: "refs/nax-bot/pr-<n>/checkout-<suffix>/base" }`.
- `preparePrCheckout` (`src/bot/checkout.ts`), signature unchanged. Baseline order: fetch, path, excludes, reserve,
  `worktree add`. Target order: path (validates the suffix), `ensureGitExcludes`, reserve, fetch into
  `checkoutRefs`, `worktree add`, snapshot, pin. `cleanup` deletes both refs when the reservation was ours.
- `pushStep` (`src/bot/fix-steps.ts`). Target argv: `push --no-verify origin HEAD:refs/heads/<headRef>`.
- `checkPushAccess` (`src/bot/fix-input.ts`). Target argv: `push --dry-run --no-verify origin HEAD:refs/heads/<headRef>`.
- `autoCommitIfDirty(workdir, stage, role, storyId, blockedWorktrees?, dryRun?, runGit?)` (`src/utils/git.ts`):
  new optional seventh parameter, default `gitWithTimeout`.
- `BranchStepContext` (`src/workflow/branch-step-context.ts`) gains `readonly runGit?: typeof gitWithTimeout`.
- `commitLeftovers` (`src/workflow/branch-fix.ts`, file-local) passes `fc.runGit` as the seventh argument.
- `runBotFix` (`src/bot/fix-run.ts`) builds its step context with `runGit: botGit`.
- `fixChecks` (`src/bot/fix-run.ts`, file-local). Baseline `review.version === 2`; target `review.version >= 2`.
- `PostReviewInput` (`src/bot/post.ts`) gains `readonly writers?: ReadonlySet<string>`; absent means empty, so no
  thread or comment qualifies.
- `BotReviewArtifact.version`: baseline `1 | 2`, target `1 | 2 | 3`; `persistArtifact` writes `3`.
- `renderThreadReply(verdict, opts?: { notQueued?: boolean })` (`src/bot/render-comments.ts`). With `notQueued` the
  body gets a second paragraph ``Not queued for `nax bot fix`: this thread was not opened by someone with write
  access.`` before the marker; the marker key stays `threadKey(verdict.id)`.
- `ReviewSummaryInput.commentVerdicts` entries gain `readonly notQueued?: boolean`; a flagged entry's line ends with
  ` (not queued for fix: author has no write access)`.
- `triage` (`src/bot/review-run.ts`, file-local) also returns `writers` = `readWriters` over the kept threads'
  non-own comments and the kept top-level comments, with `writerCheck` built on `_botReviewDeps.hasWriteAccess` and a
  `warn` writing `getSafeLogger()?.warn("bot", "Could not check commenter permission", { login, error })`.
- `_botReviewDeps` gains `hasWriteAccess` (from `@/forge`).
- `readReview` (`src/bot/fix-input.ts`, file-local) accepts versions 1, 2 and 3. For versions 1 and 2 with an array
  `agreed`, it returns the artifact with `agreed` filtered to `kind === "finding"` and, when it removed any, calls
  `getLogger()?.warn("bot-fix", "Dropped unchecked thread and comment items from an older review; re-run nax bot
  review", { path, dropped })`. A missing or non-array `agreed` is returned unchanged.
- `permissionReader` (`src/bot/rulings.ts`, file-local) returns `writerCheck(...)` built on
  `_rulingsDeps.hasWriteAccess`, whose `warn` calls the existing `warn("Could not check ruling permission", { login,
  error })` helper (stage `bot-rulings`, `_rulingsDeps.getLogger`).

### New modules

`src/bot/git.ts`:

```ts
import { gitWithTimeout } from "@/utils/git";

/** Bot git never runs hooks: a PR head can supply them through a relative core.hooksPath. */
export const BOT_GIT_HOOKS_OFF = ["-c", "core.hooksPath=/dev/null"] as const;

export function botGit(
  args: string[],
  workdir: string,
  timeoutMs?: number,
  maxBytes?: number,
): ReturnType<typeof gitWithTimeout> {
  // nax-git-env-allow: handed to gitWithTimeout, which hardens it
  return gitWithTimeout(args, workdir, timeoutMs, maxBytes, ["git", ...BOT_GIT_HOOKS_OFF, ...args]);
}
```

`src/bot/writers.ts`:

```ts
export type WriterCheck = (who: { readonly login: string; readonly id?: number }) => Promise<boolean>;

export function writerCheck(
  input: { readonly ref: PrRef; readonly deps: ForgeDeps; readonly cwd: string },
  check: typeof hasWriteAccess,
  warn: (login: string, error: string) => void,
): WriterCheck; // caches the promise per login; a rejected check calls warn(login, message) once and resolves false

export async function readWriters(
  comments: readonly PrComment[],
  check: WriterCheck,
): Promise<ReadonlySet<string>>; // distinct logins whose check resolves true; passes { login: author, id: authorId }
```

Both are exported from `src/bot/index.ts`, with `botGit`, `BOT_GIT_HOOKS_OFF` and `checkoutRefs`.

### Failure Handling

| Failure | Behaviour |
|---|---|
| The combined fetch fails (network, unknown base branch) | `BOT_CHECKOUT_FAILED` thrown; reserved directory removed; both refs deleted |
| Fetched head ref differs from `info.headSha` | `BOT_PR_HEAD_MOVED` thrown before `worktree add`; reserved directory removed; both refs deleted |
| A step after `worktree add` throws (snapshot, pin) | error rethrown; worktree, snapshot and both refs removed |
| Reservation fails (`EEXIST`) | rejected; no fetch, no ref deleted (the refs may belong to the live checkout that owns the path) |
| Deleting a checkout ref fails on dispose | warning `Failed to dispose PR checkout artifact`; dispose resolves |
| `hasWriteAccess` throws for a login | that login is not a writer; the `warn` sink is called once for the login |
| GitLab comment has no `authorId` | `hasWriteAccess` throws; the author is not a writer |
| Version 1 or 2 review artifact with thread or comment items | those items dropped; findings kept; warning with `dropped` |

## Out of Scope

- S4, a non-writer steering a `fixed` ruling on a `w-` item through prompt text, is a separate spec.
- S5, pinning the base agent config for the fix session (ruled "pin base"), is a separate spec.
- S6, limiting fix edits to the agreed items' files and extending the protected path list, is a separate spec.
- S7, validating and fencing the PRD path in the review prompt, is a separate spec.
- S9, scrubbing forge credentials from bot agent sessions, is a separate spec.
- S10, skipping confidential GitLab issues and fencing CI log text, is a separate spec.
- S12, extending the base-pinned path list for other agents' project config, is a separate spec.
- H13, requiring `--trust` for a fix on a repo with no nax config, is a separate spec.
- Hooks are not disabled for `nax run`, the workflow, or any git outside a bot command; `hardenedGitEnv` is unchanged.
- Hooks inside agent sessions are unchanged: a fix or repair agent's own `git commit` in a trusted PR's worktree still runs the repo's hooks inside the agent sandbox.
- A trusted review's setup command (for example `npm ci` running husky) can still write `core.hooksPath` into the shared repo config; trusted reviews may run head code by ruling S8.
- `readHead` in the bot fix runs `rev-parse` through the workflow's git dep, not `botGit`; `rev-parse` runs no hooks.
- The fetched base tip is not compared with a forge-reported base sha; the base branch moves legitimately and the GitLab MR API does not report its tip.
- Checkout refs left behind by a killed process are not swept; they point at fetched commits and are harmless.
- The fix prompt still carries non-writer PR text as fenced context; only the fix work items are writer-gated.
- A writer's later reply does not make a non-writer's thread a fix item; the writer re-raises it in their own thread or comment.
- User documentation of the writer rule is a manual follow-up after merge.

## Stories

Five stories in `packages/nax`, one boundary: PR content must not act with the user's privileges.

### US-001: Bot git runs no hooks
No dependencies. Workdir: packages/nax.

Adds `src/bot/git.ts` (`botGit`, `BOT_GIT_HOOKS_OFF`, exported from `src/bot/index.ts`), points every bot `runGit`
default at `botGit`, and adds `--no-verify` to `pushStep` and `checkPushAccess`.

### US-002: Bot fix leftover commit runs no hooks
Depends on US-001. Workdir: packages/nax.

Adds the optional `runGit` parameter to `autoCommitIfDirty`, `BranchStepContext.runGit`, passes it from
`commitLeftovers`, and sets `runGit: botGit` in `runBotFix`'s step context.

### US-003: Checkout fetches into run-unique refs
Depends on US-001. Workdir: packages/nax.

Adds `checkoutRefs` (exported from `src/bot/index.ts`), reserves the worktree before fetching, fetches into the
unique refs and deletes them on dispose and on failure.

### US-004: Writer check and writer-gated agreed items
No dependencies. Workdir: packages/nax.

Adds `src/bot/writers.ts` (`writerCheck`, `readWriters`, `type WriterCheck`, exported from `src/bot/index.ts`),
`PostReviewInput.writers`, the gate in `agreedItems`, the "not queued" thread reply and summary line, artifact
version 3, and `permissionReader` delegating to `writerCheck`.

### US-005: Review computes writers; fix reads version 3 and drops unchecked items
Depends on US-004. Workdir: packages/nax.

`triage` computes `writers` and passes them to `postPrReview`; `_botReviewDeps.hasWriteAccess`; `readReview` accepts
version 3 and filters versions 1 and 2; `fixChecks` reuses saved checks for version 2 and above.

### Context Files

**US-001**
- `packages/nax-agent/src/internal/git-exec.ts` — `gitWithTimeout` and its `argvOverride` parameter
- `packages/nax/src/bot/fix-steps.ts` — `pushStep`, `_fixStepsDeps`
- `packages/nax/src/bot/fix-input.ts` — `checkPushAccess`, `_fixInputDeps`
- `packages/nax/src/bot/gate-baseline.ts` — `_gateBaselineDeps`, `failingOnHead`
- `packages/nax/src/bot/saved-fix.ts` — `saveFix`, `_savedFixDeps`

**US-002**
- `packages/nax/src/utils/git.ts` — `autoCommitIfDirty`
- `packages/nax/src/workflow/branch-fix.ts` — `commitLeftovers`, `runBranchFix`
- `packages/nax/src/workflow/branch-step-context.ts` — `BranchStepContext`
- `packages/nax/src/bot/fix-run.ts` — `runBotFix`, the `buildPrStepContext` call
- `packages/nax/src/bot/git.ts` — created by US-001, used here

**US-003**
- `packages/nax/src/bot/checkout.ts` — `fetchRefs`, `preparePrCheckout`, `cleanup`, `reserveWorktree`
- `packages/nax/src/bot/saved-fix.ts` — the `refs/nax-bot/pr-<n>/` ref prefix
- `packages/nax/test/integration/bot/checkout.test.ts` — real-repo fixture with `refs/pull/42/head`

**US-004**
- `packages/nax/src/bot/post.ts` — `agreedItems`, `postThreads`, `postSummary`, `persistArtifact`, `PostReviewInput`
- `packages/nax/src/bot/render-comments.ts` — `renderThreadReply`, `renderReviewSummary`
- `packages/nax/src/bot/rulings.ts` — `permissionReader`, `_rulingsDeps`, `warn`
- `packages/nax/src/forge/access.ts` — `hasWriteAccess`

**US-005**
- `packages/nax/src/bot/review-run.ts` — `triage`, `reviewEnvironment`
- `packages/nax/src/bot/review-deps.ts` — `_botReviewDeps`
- `packages/nax/src/bot/fix-input.ts` — `readReview`, `loadLatestReview`
- `packages/nax/src/bot/fix-run.ts` — `fixChecks`
- `packages/nax/src/bot/writers.ts` — created by US-004, called here

### Creates

**US-001**
- `packages/nax/src/bot/git.ts`
- `packages/nax/test/unit/bot/git.test.ts`
- `packages/nax/test/integration/bot/git-hooks.test.ts`

**US-002**
- `packages/nax/test/integration/bot/fix-commit-hooks.test.ts`

**US-004**
- `packages/nax/src/bot/writers.ts`
- `packages/nax/test/unit/bot/writers.test.ts`

### Modifies

**US-001**
- `packages/nax/test/unit/bot/base-config.test.ts` — "F1: default git runner" expects `_baseConfigDeps.runGit` to be `gitWithTimeout`; it becomes `botGit`, imported from the bot barrel. The invariant that the archive read goes through the shared timeout runner is unchanged.
- `packages/nax/test/unit/bot/git-timeouts.test.ts` — the assertion on the argv `checkPushAccess` passes to `runGit` (push, dry-run, origin, HEAD:refs/heads/topic) gains the `--no-verify` flag right after the dry-run flag; the 120 000 ms timeout invariant is unchanged.
- `packages/nax/test/unit/bot/fix-input.test.ts` — the assertion on the argv `checkPushAccess` passes to `runGit` (push, dry-run, origin, HEAD:refs/heads/feat/x) gains the `--no-verify` flag right after the dry-run flag.
- `packages/nax/test/integration/bot/gates-push-steps.test.ts` — the assertion on the argv `pushStep` passes to `runGit` (push, origin, HEAD:refs/heads/feat/x) gains the `--no-verify` flag right after the push verb; worktree and 120 000 ms timeout unchanged.

**US-003**
- `packages/nax/test/unit/bot/checkout.test.ts` — the `runGit` stub answers `rev-parse` from whichever fetch ran last (FETCH_HEAD); it becomes keyed on the ref name (the checkout head ref answers head, the checkout base ref answers base). AC-2/3 expects the first call to be a two-argument fetch of the PR spec; it becomes the single forced two-refspec fetch into the checkout refs, and it is no longer the first call (excludes and reserve run first). The AC-4/5 invariant (no worktree call when the head moved) is unchanged.
- `packages/nax/test/unit/bot/checkout.test.ts` — "thrown removal and snapshot cleanup errors are both nonfatal" expects `logger.warn` twice; the two ref deletions add two more cleanup actions, so the expected count becomes 4 when the stubbed `runGit` throws for every call. Cleanup stays nonfatal.
- `packages/nax/test/unit/bot/git-timeouts.test.ts` — the fetch stub distinguishes head from base by the fetched argument; it becomes keyed on the `rev-parse` ref name. The list of slow calls (fetch, fetch, worktree add) expected to carry the network timeout becomes two entries (the single fetch and worktree add); the timeout invariant is unchanged.

**US-004**
- `packages/nax/test/integration/bot/post.test.ts` — AC-1 expects artifact version 2; it becomes version 3. AC-3/4 (agreeing thread `T1`) and AC-5 (agreeing comment `12`) record those items with no writer information; each input gains `writers` holding that thread's opener or comment's author, and the expected items are unchanged.
- `packages/nax/test/integration/bot/post-threads.test.ts` — the `run` mock asserts the artifact is version 2 on every forge write; it becomes version 3. The tests that expect the plain `renderThreadReply(verdicts[0])` body for the agreeing thread `T1` gain `writers` holding `T1`'s opener, so the body stays the plain reply.
- `packages/nax/test/unit/bot/post-rulings.test.ts` — "without changing artifact version" expects version 2; it becomes version 3. The invariant that recording rulings does not otherwise change the artifact shape is unchanged.

**US-005**
- `packages/nax/test/integration/bot/fix-input.test.ts` — "US-007 AC-10 unsupported version" uses version 3 as the unsupported example; it becomes version 4.
- `packages/nax/test/unit/bot/fix-input.test.ts` — the version 1 artifact fixture without `agreed` stays accepted unchanged; tests that read version 1 or 2 artifacts with thread or comment items now see only their findings.
- `packages/nax/test/integration/bot/review-run.test.ts` — its hand-built `_botReviewDeps` stub gains `hasWriteAccess: async () => true`, so the review never spawns `gh` for permissions and its existing agreed items are kept.
- `packages/nax/test/helpers/bot-review.ts` — `makeBotReviewDeps` gains `hasWriteAccess: async () => true`, so existing review tests keep their agreed thread and comment items.

### Seams

- US-001 → US-002, US-003: `botGit` (US-001) is the runner US-002 sets on the fix step context and the default
  `_checkoutDeps.runGit` that US-003's fetch and ref cleanup use. US-002's seam AC enters at `runBotFix`.
- US-004 → US-005: `readWriters` and `writerCheck` (US-004) are called by `triage` (US-005); `post.writers` (US-004
  input) is filled by `reviewEnvironment` (US-005). US-005's seam ACs enter at `runBotReview`.

## Acceptance Criteria

### US-001

- [unit] `botGit` is importable from `@/bot` and, with `_gitDeps.spawn` stubbed, spawns an argv starting `["git", "-c", "core.hooksPath=/dev/null"]` followed by the given args.
- [unit] `botGit(["status", "--porcelain"], dir)` spawns `["git", "-c", "core.hooksPath=/dev/null", "status", "--ignore-submodules=dirty", "--porcelain"]`, so the submodule hardening still applies after the `-c` pair.
- [unit] `botGit` passes its `timeoutMs` argument through: with a spawn stub that never exits and `timeoutMs` 50, the result has `timedOut` true.
- [unit] `_checkoutDeps.runGit`, `_fixInputDeps.runGit`, `_fixStepsDeps.runGit`, `_gateBaselineDeps.runGit`, `_savedFixDeps.runGit`, `_botReviewDeps.runGit`, `_botChecksDeps.runGit` and `_baseConfigDeps.runGit` each equal `botGit` by identity.
- [integration] In a real repo whose `.git/config` sets `core.hooksPath` to the relative `.husky/_` and whose committed executable `.husky/_/post-checkout`, `.husky/_/reference-transaction` and `.husky/_/pre-push` append to a marker file outside the repo, `preparePrCheckout` for a PR head at `refs/pull/42/head` completes and the marker file does not exist.
- [integration] In the same fixture, `pushStep` pushing the checkout to a local bare `origin` succeeds with outcome `pushed` and the marker file does not exist.
- [integration] In the same fixture, `saveFix` writing the saved-fix ref leaves the marker file absent.
- [integration] In the same fixture, `failingOnHead` checking out the head and back to the fix commit leaves the marker file absent.
- [integration] Control case: in the same fixture, `gitWithTimeout(["worktree", "add", "--detach", <dir>, "HEAD"], repo)` creates the marker file, proving the fixture's hooks are live.
- [unit] `pushStep` calls `_fixStepsDeps.runGit` with `["push", "--no-verify", "origin", "HEAD:refs/heads/feat/x"]` for head ref `feat/x`.
- [unit] `checkPushAccess(worktree, "feat/x")` calls `_fixInputDeps.runGit` with `["push", "--dry-run", "--no-verify", "origin", "HEAD:refs/heads/feat/x"]` and timeout `BOT_GIT_NETWORK_TIMEOUT_MS`.

### US-002

- [unit] `autoCommitIfDirty` called with a seventh argument `run` stub on a dirty tree sends its `status`, `add` and `commit` git calls to `run`, and `_gitDeps.spawn` is never called.
- [unit] `autoCommitIfDirty` called without a seventh argument on a dirty tree spawns its git calls through `_gitDeps.spawn` as before (regression pin).
- [unit] `runBranchFix` with a step context whose `runGit` is a stub and a dirty tree after the fix session calls `_workflowDeps.autoCommitIfDirty` with that stub as its seventh argument.
- [unit] `runBranchFix` with a step context without `runGit` calls `_workflowDeps.autoCommitIfDirty` with `undefined` as its seventh argument.
- [integration] `runBotFix` passes `runBranchFix` a step context whose `runGit` is `botGit` by identity.
- [integration] In a real repo whose `.git/config` sets `core.hooksPath` to the relative `.husky/_` with executable `pre-commit`, `commit-msg` and `post-commit` hooks that write a marker file, `autoCommitIfDirty(worktree, "workflow", "wf-branch-fix", "_run", undefined, false, botGit)` commits a leftover edit (the new commit exists) and the marker file does not exist.
- [integration] Control case: in that fixture, `autoCommitIfDirty` without the seventh argument creates the marker file.

### US-003

- [unit] `checkoutRefs(42, "ab12cd34")` returns `{ head: "refs/nax-bot/pr-42/checkout-ab12cd34/head", base: "refs/nax-bot/pr-42/checkout-ab12cd34/base" }`.
- [unit] For a GitHub PR 42 with base `main` and suffix `ab12cd34`, `preparePrCheckout` runs exactly one `fetch`, with argv `["fetch", "--no-tags", "origin", "+pull/42/head:refs/nax-bot/pr-42/checkout-ab12cd34/head", "+refs/heads/main:refs/nax-bot/pr-42/checkout-ab12cd34/base"]` in the repo root and timeout `BOT_GIT_NETWORK_TIMEOUT_MS`.
- [unit] For a GitLab MR 42, the head refspec of that single fetch is `+merge-requests/42/head:refs/nax-bot/pr-42/checkout-ab12cd34/head`.
- [unit] `preparePrCheckout` never runs `rev-parse FETCH_HEAD`; the returned `baseSha` is the output of `rev-parse refs/nax-bot/pr-42/checkout-ab12cd34/base`.
- [unit] `preparePrCheckout` calls `_checkoutDeps.reserveWorktree` for the checkout path before the `fetch` call.
- [unit] With an invalid suffix `a/b`, `preparePrCheckout` rejects with `BOT_CHECKOUT_SUFFIX_INVALID` and runs no `fetch`.
- [unit] When the reservation fails with `EEXIST`, `preparePrCheckout` rejects, runs no `fetch` and runs no `update-ref -d`.
- [unit] When `rev-parse` of the head ref returns a sha other than `info.headSha`, `preparePrCheckout` rejects with `BOT_PR_HEAD_MOVED`, runs no `worktree add`, and runs `update-ref -d` for both checkout refs.
- [unit] When the `fetch` call exits non-zero, `preparePrCheckout` rejects with `BOT_CHECKOUT_FAILED`, removes the reserved directory through `_checkoutDeps.rm`, and runs `update-ref -d` for both checkout refs.
- [unit] When `snapshotBaseNax` throws after `worktree add`, `preparePrCheckout` rethrows that error and runs `update-ref -d` for both checkout refs.
- [unit] `dispose()` on a successful checkout runs `update-ref -d refs/nax-bot/pr-42/checkout-ab12cd34/head` and `update-ref -d refs/nax-bot/pr-42/checkout-ab12cd34/base` in the repo root.
- [unit] `dispose()` after `retain()` still deletes both checkout refs and does not remove the worktree.
- [unit] When `update-ref -d` exits non-zero during `dispose()`, `dispose()` resolves and the logger's `warn` is called with `Failed to dispose PR checkout artifact`.
- [integration] In a real repo, with a `runGit` wrapper that runs `git fetch origin refs/pull/99/head` immediately after every `fetch` the checkout makes (overwriting `FETCH_HEAD`), the checkout's `baseSha` equals the `main` tip of `origin` and not the PR 99 head.
- [integration] In a real repo, after `dispose()`, `git for-each-ref refs/nax-bot/pr-42/` lists no ref whose name contains `checkout-`.

### US-004

- [unit] `writerCheck` is importable from `@/bot`; for a check stub resolving `true` for `alice`, `writerCheck(input, stub, warn)({ login: "alice" })` resolves `true`.
- [unit] Calling the returned `WriterCheck` twice for `alice` calls the check stub once.
- [unit] When the check stub rejects with `Error("permission unavailable")` for `mallory`, the `WriterCheck` resolves `false` and calls `warn` once with `("mallory", "permission unavailable")`.
- [unit] `writerCheck` passes `{ login, id }` through to the check, so author id 7 reaches the stub as `id: 7`.
- [unit] `readWriters` over comments by `alice`, `mallory` and `bob`, with a check that is `true` for `alice` and `bob`, returns a set equal to `{ "alice", "bob" }`.
- [unit] `readWriters` passes each comment's `authorId` as `id`: a GitLab comment by `carol` with `authorId` 9 reaches the check as `{ login: "carol", id: 9 }`.
- [unit] `readWriters` with the real `hasWriteAccess` on a GitLab `PrRef` and a comment without `authorId` returns a set without that author.
- [integration] `postPrReview` with an agreeing thread whose opener is not in `writers` records no `thread` item in the artifact's `agreed`.
- [integration] `postPrReview` with an agreeing thread opened by a non-writer and replied to by a login in `writers` records no `thread` item.
- [integration] `postPrReview` with an agreeing thread whose opener is in `writers` records the `thread` item with `issue` equal to the opener's comment body.
- [integration] `postPrReview` with an agreeing top-level comment whose author is not in `writers` records no `comment` item.
- [integration] `postPrReview` with an agreeing top-level comment whose author is in `writers` records the `comment` item with key `commentKey(<id>)`.
- [integration] `postPrReview` with `writers` absent records no `thread` or `comment` items and still records its `finding` items.
- [integration] For an agreeing thread whose opener is not a writer, `postPrReview` still replies on the thread with a body containing ``Not queued for `nax bot fix` ``.
- [integration] For a disagreeing thread whose opener is not a writer, the reply body equals `renderThreadReply` of the verdict without the `notQueued` option.
- [integration] For an agreeing top-level comment whose author is not a writer, the posted summary's `### Top-level comments` line for it ends with `(not queued for fix: author has no write access)`.
- [integration] The artifact `postPrReview` writes has `version` 3.
- [unit] `renderThreadReply({ id: "T1", decision: "agree", reason: "Valid" }, { notQueued: true })` keeps the `nax-bot` marker key `threadKey("T1")`.
- [integration] `recordPrRulings` with `_rulingsDeps.hasWriteAccess` rejecting for a replier treats that reply as a non-writer and logs, through `_rulingsDeps.getLogger`, stage `bot-rulings` with data containing `{ login, error }` (regression pin).

### US-005

- [integration] `runBotReview` on a trusted PR, with `_botReviewDeps.hasWriteAccess` stubbed to `false` for `mallory`, a top-level comment by `mallory`, and a review verdict agreeing with it, writes a `bot-review.json` whose `agreed` has no `comment` item.
- [integration] `runBotReview` with `_botReviewDeps.hasWriteAccess` stubbed to `true` for `alice`, a thread opened by `alice`, and a verdict agreeing with it, writes a `bot-review.json` whose `agreed` holds a `thread` item for that thread.
- [integration] `runBotReview` calls `_botReviewDeps.hasWriteAccess` once per distinct author login across threads and top-level comments, and never for the bot's own login.
- [integration] `runBotReview` on a re-run where a non-writer's thread already holds the bot's own marked "Not queued" reply, with `hasWriteAccess` resolving `true` for the bot login, still writes no `thread` item for it.
- [integration] `runBotReview` on an untrusted (static) PR also gates agreed comments: a non-writer's agreed comment is not in `agreed`.
- [integration] When `_botReviewDeps.hasWriteAccess` rejects for every login, `runBotReview` still posts the review and its artifact has only `finding` items.
- [unit] `loadLatestReview` for a version 2 artifact at the head with `agreed` holding one `finding`, one `thread` and one `comment` item returns `agreed` with only the `finding`.
- [unit] `loadLatestReview` for that version 2 artifact calls the logger's `warn` with data containing `dropped: 2`.
- [unit] `loadLatestReview` for a version 1 artifact without an `agreed` field returns it unchanged.
- [unit] `loadLatestReview` for a version 3 artifact returns its `thread` and `comment` items unchanged.
- [unit] `loadLatestReview` ignores an artifact with `version` 4.
- [integration] `runBotFix` given a version 3 review at the head with saved `checks` never calls `_botFixDeps.resolveBotChecks`.
- [integration] `runBotFix` given a version 2 review whose only agreed item is a `comment` ends with outcome `nothing` and starts no fix session.
