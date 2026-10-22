<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Bot security boundary (hooks, base binding, writer-only fix items)

## Summary

`nax bot review` and `nax bot fix` check out PR heads written by people the user may not trust. Three gaps let that
content act with the user's privileges. Git hooks from the PR head can run on nax's own git calls. The base commit is
read from the shared `FETCH_HEAD`, which another git process can overwrite. And a comment from anyone, writer or
not, can become work for the Bash-capable fix agent. This spec closes all three. Every git command the bot runs
itself gets `core.hooksPath=/dev/null`, and its pushes get `--no-verify`. The checkout fetches head and base into
refs unique to the run and deletes them on dispose. A thread or comment the review agrees with becomes a fix item
only when someone with write access wrote in it.

## Motivation

Verified on `main` @ `b5a478df8` (v0.91.3). The evidence is items S1-S3 in the workspace report
`nax-bot-review-gap-analysis-2026-10-22.md`:

- **S1 (critical).** `hardenedGitEnv` (`packages/nax-agent/src/internal/git-env.ts`) sets only `core.fsmonitor`,
  `diff.ignoreSubmodules` and `submodule.recurse`, so hooks still run. With a relative `core.hooksPath` (husky v9
  writes `.husky/_` into `.git/config`), git resolves hooks inside the new worktree, which holds the PR head's
  content. Reproduced with git 2.50.1: a plain `git worktree add --detach` ran the repo's `post-checkout` hook and
  twelve `reference-transaction` hooks. The same command with `-c core.hooksPath=/dev/null` ran none.
  `preparePrCheckout` runs `worktree add` during the **static** review of an untrusted fork PR, with the user's
  environment. The fix also runs `pre-push` on `git push`, `post-checkout` in the gate baseline, and
  `reference-transaction` on the saved-fix `update-ref`.
- **S2 (high).** `fetchRefs` (`src/bot/checkout.ts`) runs `git fetch origin <head spec>`, reads `FETCH_HEAD`, then
  runs `git fetch origin <baseRef>` and reads `FETCH_HEAD` again. `FETCH_HEAD` is shared by every git process in the
  repo. If another fetch overlaps (a second bot run, `nax run`, an editor), the "base" sha can become a fork head. The
  base sha decides the base `.nax` snapshot, the pinned instruction files, gates and setup commands, so those would
  come from attacker content.
- **S3 (high).** `agreedItems` (`src/bot/post.ts`) turns every thread and top-level comment the review agrees with
  into an `AgreedItem`, which `nax bot fix` hands to an agent with Bash. Write access is checked only for rulings
  (`permissionReader` in `src/bot/rulings.ts`). On a public repo, an outsider can write a plausible request that the
  review agrees with and so steer the fix agent.

User direction 2026-10-22: bundle S1, S2 and S3 into one spec. No issues are filed. S1 is an exploitable hole in a
public repo, so it is fixed before it is described in an issue.

## Design

### Approach

Three independent changes in `packages/nax/src/bot`, one story pair each for S3, one story each for S1 and S2.

1. **No hooks on bot git (S1).** A new leaf module `src/bot/git.ts` exports `botGit`, which has the same signature as
   `gitWithTimeout` but always runs `git -c core.hooksPath=/dev/null <args>`. It passes that argv through
   `gitWithTimeout`'s `argvOverride` parameter, so the fsmonitor and submodule hardening and the timeout handling
   still apply. Every bot dependency object that has a `runGit` member (`_checkoutDeps`, `_fixInputDeps`,
   `_fixStepsDeps`, `_gateBaselineDeps`, `_savedFixDeps`, `_botReviewDeps`, `_botChecksDeps`, `_baseConfigDeps`)
   defaults it to `botGit`. Both pushes (`pushStep` and the `checkPushAccess` dry run) also pass `--no-verify`. The
   fix is bot-only: `nax run` keeps running hooks where its config asks for them (`tdd.redCommitHooks: "run"`). The
   `["git", "-c", ...]` argv literal in `git.ts` carries a `// nax-git-env-allow: handed to gitWithTimeout, which
   hardens it` marker for `check-git-spawn-env.ts`.
2. **Run-unique refs (S2).** `preparePrCheckout` reserves its worktree directory **before** fetching. Owning the
   directory makes the suffix unique to this run. It then runs one fetch with two forced refspecs into
   `refs/nax-bot/pr-<n>/checkout-<suffix>/head` and `.../base` and reads both refs with `rev-parse`. The head check
   (`BOT_PR_HEAD_MOVED`) keeps comparing against `info.headSha`. `dispose()` and the failure cleanup delete both
   refs with `update-ref -d`, including when the checkout is retained. A retained worktree is detached at a sha, and
   its unpushed work is kept by the saved-fix ref, not by these refs.
3. **Writer-only fix items (S3).** A new module `src/bot/writers.ts` exports `writerCheck`. It wraps
   `hasWriteAccess` with a per-login cache, and a failed check counts as "not a writer" (fail closed). It also
   exports `readWriters`, which returns the set of logins with write access among the authors of the threads and
   comments being triaged. `PostReviewInput` gains `writers`. In `agreedItems`, an agreed thread is a fix item only
   when a writer wrote any comment in it, and an agreed top-level comment only when a writer wrote it. An agreed
   thread or comment that fails the check is still answered, with a "not queued" note. The bot review artifact
   becomes version 3. `loadLatestReview` still accepts versions 1 and 2, but drops their `thread` and `comment`
   items: those were never writer-checked. `permissionReader` in `rulings.ts` delegates to `writerCheck`, so write
   access is decided in one place.

### Integration

Symbols read or called unchanged:

- `gitWithTimeout(args, workdir, timeoutMs?, maxBytes?, argvOverride?)` from `@/utils/git` (re-exported from
  `@nathapp/nax-agent/internal`). It spawns `hardenedGitArgv(argvOverride ?? ["git", ...args])` with
  `hardenedGitEnv(process.env)`. `hardenedGitArgv` skips `-c <value>` pairs when it looks for the verb, so
  `--ignore-submodules=dirty` is still placed after `status`/`diff`.
- `hasWriteAccess(ref, { login, id? }, deps, cwd): Promise<boolean>` from `@/forge`. On GitLab it throws
  `FORGE_RESPONSE_UNPARSEABLE` when `id` is missing.
- `PrComment` (`author`, `authorId?`), `PrThread` (`comments`) from `@/forge`.
- `BOT_GIT_NETWORK_TIMEOUT_MS` (120 000) from `src/bot/checkout.ts`.
- `savedFixRef(prNumber)` in `src/bot/saved-fix.ts` returns `refs/nax-bot/pr-<n>/fix`. The new checkout refs sit
  under the same `refs/nax-bot/pr-<n>/` prefix.

Symbols this spec changes. The baseline only locates the code; the target is the interface to implement.

- `fetchRefs` (`src/bot/checkout.ts`, file-local).
  Baseline: `fetchRefs({ repoRoot, ref, info }): Promise<{ baseSha; mergeBase }>`, two fetches, two
  `rev-parse FETCH_HEAD`.
  Target: `fetchRefs({ repoRoot, ref, info, refs: CheckoutRefs }): Promise<{ baseSha; mergeBase }>` with one
  `fetch --no-tags origin +<headSpec>:<refs.head> +refs/heads/<baseRef>:<refs.base>` (network timeout), then
  `rev-parse <refs.head>` and `rev-parse <refs.base>`.
- `checkoutRefs(n: number, suffix: string): CheckoutRefs` (new export, `src/bot/checkout.ts`) returns
  `{ head: "refs/nax-bot/pr-<n>/checkout-<suffix>/head", base: "refs/nax-bot/pr-<n>/checkout-<suffix>/base" }`.
- `preparePrCheckout` (`src/bot/checkout.ts`). The signature is unchanged. The order changes:
  Baseline: fetch, compute path, `ensureGitExcludes`, reserve, `worktree add`.
  Target: compute path (validates the suffix), `ensureGitExcludes`, reserve, fetch into `checkoutRefs`,
  `worktree add`, snapshot, pin. `cleanup` also deletes `refs.head` and `refs.base`.
- `pushStep` (`src/bot/fix-steps.ts`).
  Baseline argv `["push", "origin", "HEAD:refs/heads/<headRef>"]`.
  Target `["push", "--no-verify", "origin", "HEAD:refs/heads/<headRef>"]`.
- `checkPushAccess` (`src/bot/fix-input.ts`).
  Baseline argv `["push", "--dry-run", "origin", ...]`.
  Target `["push", "--dry-run", "--no-verify", "origin", ...]`.
- `PostReviewInput` (`src/bot/post.ts`) gains `readonly writers?: ReadonlySet<string>`. When it is absent, the set
  counts as empty, so no thread or comment qualifies (fail closed).
- `BotReviewArtifact.version`. Baseline `1 | 2`; target `1 | 2 | 3`. `persistArtifact` writes `3`.
- `renderThreadReply(verdict)` (`src/bot/render-comments.ts`).
  Target: `renderThreadReply(verdict, opts?: { notQueued?: boolean })`. With `notQueued`, the body gets a second
  paragraph: ``Not queued for `nax bot fix`: no one with write access wrote in this thread.``
- `ReviewSummaryInput.commentVerdicts` entries gain `readonly notQueued?: boolean`. A flagged entry's line ends
  with ` (not queued for fix: author has no write access)`.
- `triage` (`src/bot/review-run.ts`, file-local) also returns `writers`, computed by `readWriters` over the kept
  threads and comments with a `writerCheck` built on `_botReviewDeps.hasWriteAccess`. `reviewEnvironment` passes it
  into `post`.
- `_botReviewDeps` gains `hasWriteAccess` (from `@/forge`).
- `readReview` (`src/bot/fix-input.ts`, file-local) accepts versions 1, 2 and 3. For versions 1 and 2 it returns the
  artifact with `agreed` filtered to `kind === "finding"` and logs a warning when it removed any items.
- `permissionReader` (`src/bot/rulings.ts`, file-local) returns `writerCheck(...)` built on
  `_rulingsDeps.hasWriteAccess` with the warning text `Could not check ruling permission`.

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
  warning: string,
): WriterCheck; // caches the promise per login; a rejected check logs `warning` and resolves false

export async function readWriters(
  sources: { readonly threads: readonly PrThread[]; readonly comments: readonly PrComment[] },
  check: WriterCheck,
): Promise<ReadonlySet<string>>; // logins (distinct) of every comment author that check resolves true
```

Both are exported from `src/bot/index.ts`.

### Failure Handling

| Failure | Behaviour |
|---|---|
| The combined fetch fails (network, unknown base branch) | `BOT_CHECKOUT_FAILED` thrown; reserved directory and any created ref removed |
| Fetched head ref differs from `info.headSha` | `BOT_PR_HEAD_MOVED` thrown before `worktree add`; reserved directory and both refs removed |
| Deleting a checkout ref fails on dispose | logged as a warning; dispose continues and does not throw |
| `hasWriteAccess` throws for a login | that login counts as not a writer; a warning is logged once per login |
| GitLab comment has no `authorId` | `hasWriteAccess` throws; the author counts as not a writer |
| Version 1 or 2 review artifact with thread or comment items | those items are dropped; findings kept; warning logged |

## Out of Scope

- S4 (a non-writer steering a `fixed` ruling on a `w-` item through prompt text) is a separate spec.
- S5 (pinning the base agent config for the fix session, ruled "pin base") is a separate spec.
- S6 (fix file scope and the protected path list), S7 (PRD path fencing), S9 (forge credential scrub for agent sessions), S10 (confidential issues, CI log fencing), S12 (pin list for other agents) and H13 (`--trust` for a fix with no nax config) are a separate spec.
- Hooks are not disabled for `nax run`, the workflow, or any git outside `packages/nax/src/bot`; `hardenedGitEnv` is unchanged.
- Hooks inside agent sessions are not changed: a fix or repair agent's own `git commit` in a trusted PR's worktree still runs the repo's hooks inside the agent sandbox.
- A trusted review's setup command (for example `npm ci` running husky) can still write `core.hooksPath` into the shared repo config; trusted reviews may run head code by ruling S8.
- The fetched base tip is not compared with a forge-reported base sha; the base branch moves legitimately and the GitLab MR API does not report its tip.
- Checkout refs left behind by a killed process are not swept; they are harmless and removed by the user with `git for-each-ref` cleanup.
- The fix prompt still carries non-writer PR text as fenced context; only the fix work items are writer-gated.
- A writer's reply in a thread counts regardless of its content; the review's agree verdict decides whether it is a valid item.
- User documentation of the writer rule is a manual follow-up after merge.

## Stories

Four stories in `packages/nax`. All four close one boundary: PR content must not act with the user's privileges.

### US-001: Bot git runs no hooks
No dependencies. Workdir: packages/nax.

Adds `src/bot/git.ts` (`botGit`, `BOT_GIT_HOOKS_OFF`, exported from `src/bot/index.ts`). Points every bot `runGit`
default at `botGit`. Adds `--no-verify` to `pushStep` and `checkPushAccess`.

### US-002: Checkout fetches into run-unique refs
Depends on US-001. Workdir: packages/nax.

Adds `checkoutRefs` (exported from `src/bot/index.ts`, which this story may edit). Reserves the worktree before fetching, fetches into the unique refs, and deletes them on
dispose and on failure.

### US-003: Writer check and writer-gated agreed items
No dependencies. Workdir: packages/nax.

Adds `src/bot/writers.ts` (`writerCheck`, `readWriters`, `type WriterCheck`, exported from `src/bot/index.ts`, which this story may edit). Adds `PostReviewInput.writers`, the gate in
`agreedItems`, the "not queued" thread reply and summary line, artifact version 3, and `permissionReader`
delegating to `writerCheck`.

### US-004: Review computes writers; fix drops legacy unchecked items
Depends on US-003. Workdir: packages/nax.

`triage` computes `writers` with `readWriters` over a `writerCheck` on `_botReviewDeps.hasWriteAccess` and passes
them to `postPrReview`. `readReview` accepts version 3 and filters versions 1 and 2.

### Context Files

**US-001**
- `packages/nax-agent/src/internal/git-exec.ts` — `gitWithTimeout` and its `argvOverride` parameter
- `packages/nax-agent/src/internal/git-env.ts` — `hardenedGitArgv`
- `packages/nax/src/bot/fix-steps.ts` — `pushStep`, `_fixStepsDeps`
- `packages/nax/src/bot/fix-input.ts` — `checkPushAccess`, `_fixInputDeps`
- `packages/nax/src/bot/gate-baseline.ts` — `_gateBaselineDeps`, `failingOnHead`

**US-002**
- `packages/nax/src/bot/checkout.ts` — `fetchRefs`, `preparePrCheckout`, `cleanup`, `reserveWorktree`
- `packages/nax/src/bot/saved-fix.ts` — `savedFixRef`
- `packages/nax/test/integration/bot/checkout.test.ts` — real-repo fixture with `refs/pull/42/head`

**US-003**
- `packages/nax/src/bot/post.ts` — `agreedItems`, `postThreads`, `persistArtifact`, `PostReviewInput`
- `packages/nax/src/bot/render-comments.ts` — `renderThreadReply`, `renderReviewSummary`
- `packages/nax/src/bot/rulings.ts` — `permissionReader`, `_rulingsDeps`
- `packages/nax/src/forge/access.ts` — `hasWriteAccess`

**US-004**
- `packages/nax/src/bot/review-run.ts` — `triage`, `reviewEnvironment`
- `packages/nax/src/bot/review-deps.ts` — `_botReviewDeps`
- `packages/nax/src/bot/fix-input.ts` — `readReview`, `loadLatestReview`
- `packages/nax/src/bot/writers.ts` — created by US-003, called here

### Creates

**US-001**
- `packages/nax/src/bot/git.ts`
- `packages/nax/test/integration/bot/git-hooks.test.ts`

**US-002**
- `packages/nax/test/integration/bot/checkout-refs.test.ts`

**US-003**
- `packages/nax/src/bot/writers.ts`
- `packages/nax/test/unit/bot/writers.test.ts`
- `packages/nax/test/integration/bot/post-writers.test.ts`

**US-004**
- `packages/nax/test/integration/bot/review-writers.test.ts`

### Modifies

**US-001**
- `packages/nax/src/bot/checkout.ts` — `_checkoutDeps.runGit` defaults to `botGit`.
- `packages/nax/src/bot/fix-input.ts` — `_fixInputDeps.runGit` defaults to `botGit`; `checkPushAccess` adds `--no-verify`.
- `packages/nax/src/bot/fix-steps.ts` — `_fixStepsDeps.runGit` defaults to `botGit`; `pushStep` adds `--no-verify`.
- `packages/nax/src/bot/gate-baseline.ts` — `_gateBaselineDeps.runGit` defaults to `botGit`.
- `packages/nax/src/bot/saved-fix.ts` — `_savedFixDeps.runGit` defaults to `botGit`.
- `packages/nax/src/bot/review-deps.ts` — `_botReviewDeps.runGit` defaults to `botGit`.
- `packages/nax/src/bot/checks.ts` — `_botChecksDeps.runGit` defaults to `botGit`.
- `packages/nax/src/bot/base-config.ts` — `_baseConfigDeps.runGit` defaults to `botGit`.
- `packages/nax/src/bot/index.ts` — exports `botGit` and `BOT_GIT_HOOKS_OFF`.
- `packages/nax/test/unit/bot/git-timeouts.test.ts` — the assertion on the argv `checkPushAccess` passes to `runGit` (push, dry-run, origin, HEAD:refs/heads/topic) gains the `--no-verify` flag right after the dry-run flag; the 120 000 ms timeout invariant is unchanged.
- `packages/nax/test/unit/bot/fix-input.test.ts` — the assertion on the argv `checkPushAccess` passes to `runGit` (push, dry-run, origin, HEAD:refs/heads/feat/x) gains the `--no-verify` flag right after the dry-run flag.
- `packages/nax/test/integration/bot/gates-push-steps.test.ts` — the assertion on the argv `pushStep` passes to `runGit` (push, origin, HEAD:refs/heads/feat/x) gains the `--no-verify` flag right after the push verb; worktree and 120 000 ms timeout unchanged.

**US-002**
- `packages/nax/src/bot/checkout.ts` — `fetchRefs` fetches into `checkoutRefs`, `preparePrCheckout` reserves before fetching, `cleanup` deletes the refs, `checkoutRefs` exported.
- `packages/nax/test/unit/bot/checkout.test.ts` — the `runGit` stub answers `rev-parse` from whichever fetch ran last (FETCH_HEAD); it becomes keyed on the ref name (the checkout head ref answers head, the checkout base ref answers base). AC-2/3 expects the first call to be a two-argument fetch of the PR spec; it becomes the single forced two-refspec fetch into the checkout refs described in US-002, and it is no longer the first call (exclude and reserve run first). The AC-4/5 invariant (no worktree call when the head moved) is unchanged.
- `packages/nax/test/unit/bot/git-timeouts.test.ts` — the fetch stub distinguishes head from base by `argv[2] === baseRef`; it becomes keyed on the `rev-parse` ref name; the network-timeout invariant for the fetch and `worktree add` is unchanged.

**US-003**
- `packages/nax/src/bot/post.ts` — `PostReviewInput.writers`, writer gate in `agreedItems`, not-queued replies, artifact version 3.
- `packages/nax/src/bot/render-comments.ts` — `renderThreadReply` `notQueued` option; `commentVerdicts` `notQueued` line suffix.
- `packages/nax/src/bot/rulings.ts` — `permissionReader` delegates to `writerCheck`.
- `packages/nax/test/integration/bot/post.test.ts` — AC-1 expects artifact version 2; it becomes version 3. AC-3/4 (agreeing thread `T1`) and AC-5 (agreeing comment `12`) record those items with no writer information; each input gains `writers` holding that thread's or comment's author, and the expected items are unchanged.

**US-004**
- `packages/nax/src/bot/review-run.ts` — `triage` computes `writers`; `reviewEnvironment` passes them to `post`.
- `packages/nax/src/bot/review-deps.ts` — `_botReviewDeps.hasWriteAccess`.
- `packages/nax/src/bot/fix-input.ts` — `readReview` accepts version 3 and filters versions 1 and 2.
- `packages/nax/test/helpers/bot-review.ts` — the review fixture's `_botReviewDeps` stub set gains `hasWriteAccess` resolving `true`, so existing review tests keep their agreed thread and comment items.

### Seams

- US-001 → US-002: `fetchRefs` and the ref cleanup run through `_checkoutDeps.runGit`, which US-001 points at
  `botGit`; US-002's real-repo test therefore also runs hook-free.
- US-003 → US-004: `readWriters` and `writerCheck` (US-003) are called by `triage` (US-004); `post.writers`
  (US-003 input) is filled by `reviewEnvironment` (US-004). Seam ACs in US-004 enter at `runBotReview`.

## Acceptance Criteria

### US-001

- [unit] `botGit` is importable from `@/bot` and, with `_gitDeps.spawn` stubbed, spawns an argv starting `["git", "-c", "core.hooksPath=/dev/null"]` followed by the given args.
- [unit] `botGit(["status", "--porcelain"], dir)` spawns `["git", "-c", "core.hooksPath=/dev/null", "status", "--ignore-submodules=dirty", "--porcelain"]`, so the submodule hardening still applies after the `-c` pair.
- [unit] `botGit` passes its `timeoutMs` argument through: with a spawn stub that never exits and `timeoutMs` 50, the result has `timedOut` true.
- [unit] `_checkoutDeps.runGit`, `_fixInputDeps.runGit`, `_fixStepsDeps.runGit`, `_gateBaselineDeps.runGit`, `_savedFixDeps.runGit`, `_botReviewDeps.runGit`, `_botChecksDeps.runGit` and `_baseConfigDeps.runGit` each equal `botGit` by identity.
- [integration] In a real repo whose `.git/config` sets `core.hooksPath` to the relative `.husky/_` and whose committed `.husky/_/post-checkout` and `.husky/_/reference-transaction` append to a marker file outside the repo, `preparePrCheckout` for a PR head at `refs/pull/42/head` completes and the marker file does not exist.
- [integration] In the same fixture, `pushStep` pushing the checkout to a local bare `origin` whose clone has an executable relative `.husky/_/pre-push` that writes the marker succeeds with outcome `pushed`, and the marker file does not exist.
- [integration] In the same fixture, `saveFix` writing `refs/nax-bot/pr-42/fix` leaves the marker file absent.
- [integration] In the same fixture, `failingOnHead` checking out the head and back to the fix commit leaves the marker file absent.
- [integration] Control case: in the same fixture, `gitWithTimeout(["worktree", "add", "--detach", <dir>, "HEAD"], repo)` creates the marker file, proving the fixture's hooks are live.
- [unit] `pushStep` calls `_fixStepsDeps.runGit` with `["push", "--no-verify", "origin", "HEAD:refs/heads/feat/x"]` for head ref `feat/x`.
- [unit] `checkPushAccess(worktree, "feat/x")` calls `_fixInputDeps.runGit` with `["push", "--dry-run", "--no-verify", "origin", "HEAD:refs/heads/feat/x"]` and timeout `BOT_GIT_NETWORK_TIMEOUT_MS`.

### US-002

- [unit] `checkoutRefs(42, "ab12cd34")` returns `{ head: "refs/nax-bot/pr-42/checkout-ab12cd34/head", base: "refs/nax-bot/pr-42/checkout-ab12cd34/base" }`.
- [unit] For a GitHub PR 42 with base `main` and suffix `ab12cd34`, `preparePrCheckout` runs exactly one `fetch`, with argv `["fetch", "--no-tags", "origin", "+pull/42/head:refs/nax-bot/pr-42/checkout-ab12cd34/head", "+refs/heads/main:refs/nax-bot/pr-42/checkout-ab12cd34/base"]` in the repo root and timeout `BOT_GIT_NETWORK_TIMEOUT_MS`.
- [unit] For a GitLab MR 42, the head refspec of that single fetch is `+merge-requests/42/head:refs/nax-bot/pr-42/checkout-ab12cd34/head`.
- [unit] `preparePrCheckout` never runs `rev-parse FETCH_HEAD`; the returned `baseSha` is the `rev-parse refs/nax-bot/pr-42/checkout-ab12cd34/base` output.
- [unit] `preparePrCheckout` calls `_checkoutDeps.reserveWorktree` for the checkout path before the `fetch` call.
- [unit] With an invalid suffix `a/b`, `preparePrCheckout` rejects with `BOT_CHECKOUT_SUFFIX_INVALID` and runs no `fetch`.
- [unit] When the reservation fails with `EEXIST`, `preparePrCheckout` rejects and runs no `fetch`.
- [unit] When `rev-parse` of the head ref returns a sha other than `info.headSha`, `preparePrCheckout` rejects with `BOT_PR_HEAD_MOVED`, runs no `worktree add`, and runs `update-ref -d` for both the head ref and the base ref.
- [unit] When the `fetch` call exits non-zero, `preparePrCheckout` rejects with `BOT_CHECKOUT_FAILED` and removes the reserved directory through `_checkoutDeps.rm`.
- [unit] `dispose()` on a successful checkout runs `update-ref -d refs/nax-bot/pr-42/checkout-ab12cd34/head` and `update-ref -d refs/nax-bot/pr-42/checkout-ab12cd34/base` in the repo root.
- [unit] `dispose()` after `retain()` still deletes both checkout refs and does not remove the worktree.
- [unit] When `update-ref -d` exits non-zero during `dispose()`, `dispose()` resolves and the logger's `warn` is called with `Failed to dispose PR checkout artifact`.
- [integration] In a real repo, after `FETCH_HEAD` is overwritten between two fetches by a concurrent `git fetch origin refs/pull/99/head` (simulated by a `runGit` wrapper that runs that fetch right after the checkout's fetch), the checkout's `baseSha` equals the `main` tip of `origin` and not the PR 99 head.
- [integration] In a real repo, after `dispose()`, `git for-each-ref refs/nax-bot/pr-42/` lists no `checkout-` refs.

### US-003

- [unit] `writerCheck` is importable from `@/bot`; for a check stub resolving `true` for `alice`, `writerCheck(input, stub, "w")({ login: "alice" })` resolves `true`.
- [unit] Calling the returned `WriterCheck` twice for `alice` calls the check stub once.
- [unit] When the check stub rejects for `mallory`, the `WriterCheck` resolves `false` and the logger's `warn` is called once with message containing `w` and data `login: "mallory"`.
- [unit] `writerCheck` passes `{ login, id }` through to the check, so a GitLab comment author id 7 reaches the stub as `id: 7`.
- [unit] `readWriters` over one thread with comments by `alice` and `mallory` and one top-level comment by `bob`, with a check that is `true` for `alice` and `bob`, returns a set equal to `{ "alice", "bob" }`.
- [integration] `postPrReview` with an agreeing thread whose only comment author is not in `writers` records no `thread` item in the artifact's `agreed`.
- [integration] `postPrReview` with an agreeing thread opened by a non-writer and replied to by a login in `writers` records the `thread` item.
- [integration] `postPrReview` with an agreeing top-level comment whose author is not in `writers` records no `comment` item.
- [integration] `postPrReview` with an agreeing top-level comment whose author is in `writers` records the `comment` item with key `commentKey(<id>)`.
- [integration] `postPrReview` with `writers` absent records no `thread` or `comment` items while still recording `finding` items.
- [integration] For an agreeing thread with no writer, `postPrReview` still replies on the thread, and the reply body contains ``Not queued for `nax bot fix` ``.
- [integration] For an agreeing thread with a writer, the reply body is exactly `renderThreadReply` of the verdict with no `notQueued` option.
- [integration] For an agreeing top-level comment with no writer, the posted summary's `### Top-level comments` line for that comment ends with `(not queued for fix: author has no write access)`.
- [integration] The artifact `postPrReview` writes has `version` 3.
- [unit] `renderThreadReply({ id: "T1", decision: "agree", reason: "Valid" }, { notQueued: true })` keeps the `nax-bot` marker key `threadKey("T1")`.
- [integration] `recordPrRulings` with `_rulingsDeps.hasWriteAccess` rejecting for a replier treats that reply as a non-writer and logs `Could not check ruling permission`, as before the change.

### US-004

- [integration] `runBotReview` on a trusted PR, with `_botReviewDeps.hasWriteAccess` stubbed to `false` for `mallory`, a top-level comment by `mallory`, and a review verdict agreeing with it, writes a `bot-review.json` whose `agreed` has no `comment` item.
- [integration] `runBotReview` with `_botReviewDeps.hasWriteAccess` stubbed to `true` for `alice`, a thread opened by `alice`, and a verdict agreeing with it, writes a `bot-review.json` whose `agreed` holds a `thread` item for that thread.
- [integration] `runBotReview` calls `_botReviewDeps.hasWriteAccess` once per distinct author login across threads and top-level comments, and never for the bot's own login.
- [integration] `runBotReview` on an untrusted (static) PR also gates agreed comments: a non-writer's agreed comment is not in `agreed`.
- [integration] When `_botReviewDeps.hasWriteAccess` rejects for every login, `runBotReview` still posts the review and its artifact has only `finding` items.
- [unit] `loadLatestReview` for a version 2 artifact at the head with `agreed` holding one `finding`, one `thread` and one `comment` item returns `agreed` with only the `finding`.
- [unit] `loadLatestReview` for that version 2 artifact calls the logger's `warn` with data `dropped: 2`.
- [unit] `loadLatestReview` for a version 3 artifact returns its `thread` and `comment` items unchanged.
- [unit] `loadLatestReview` for a version 1 artifact with a `thread` item returns `agreed` without it.
- [unit] `loadLatestReview` ignores an artifact with `version` 4.
- [integration] `runBotFix` given a version 2 review whose only agreed item is a `comment` ends with outcome `nothing` and starts no fix session.
