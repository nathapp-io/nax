# SPEC: bot-setup-rebase — choose the install by `packageManager` and fall back across lockfiles, re-resolve a failed saved install from the base tip, and carry a pure rebase's review instead of re-reviewing the whole PR

Closes: #3026, #3027, #3028

## Summary

Three `nax bot` fixes found on one GitLab MR, bundled because each costs a stuck or wasted bot run on the same path: install, then fix, then a head move. The derived install step prefers the package manager that `package.json` `packageManager` names, and when the chosen frozen install fails it tries the other lockfiles' frozen installs before giving up; it never runs a non-frozen install (#3026). When `nax bot fix` replays the install step saved by the head's review and that step fails, it re-resolves the install from the current target-branch tip and retries once if the result differs, so a merged `execution.preRun` fix takes effect without a new head; the setup-failed summary names where the install came from and how to override it (#3027). When the PR head moved by a rebase only (the patch since the merge base is identical to the reviewed head's), `nax bot review` recognises it, reads no code, carries the earlier review's findings and coverage to the new head, and still resolves checks and runs install and build against the new base, instead of a full paid re-review (#3028).

## Motivation

Observed 2026-11-23 on one MR (bot artifacts under the project's `bot/pr-76/`):

1. **Stale `bun.lock` wins (#3026).** The repo uses npm (`package-lock.json`) and keeps a stale `bun.lock`. `LOCKFILE_COMMANDS` (`packages/nax/src/bot/checks.ts`) is first-found in the order `bun.lock`, `bun.lockb`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, so the base's `.nax/config.json` (which sets `quality.commands` but no `execution.preRun`) got `bun install --frozen-lockfile`. It failed (`lockfile had changes, but lockfile is frozen`) in the review (which continued with a warning) and in `nax bot fix`, which ended `setup-failed` with only "Setup failed at `bun install --frozen-lockfile`; nothing ran."
2. **A merged config fix is ignored (#3027).** A target-branch MR added `execution.preRun: npm ci`. The next `nax bot fix` ran `bun install --frozen-lockfile` again. The issue text blames the merge base; the code shows otherwise: `fetchCheckoutRefs` (`bot/checkout.ts`) fetches `refs/heads/<target>`, so `checkout.baseSha` is the target tip. The cause is `fixChecks` (`bot/fix-run.ts`), which returns `review.checks` saved by the head's review ("Saved checks belong to this reviewed head, even if the base has since moved", from #2628). Nothing tells the user that a same-head `nax bot review` (conversation-only, cheap) would refresh them.
3. **A rebase costs a full re-review (#3028).** To move past (2), the branch was rebased onto the target and force-pushed. `nax bot fix` refused (`no nax bot review of head 5c7e639; run nax bot review 76 first`, exact head match in `runBotFix`), and the next review could not narrow: `reviewRange` (`bot/review-rulings.ts`) requires the reviewed head to be an ancestor of the new head, which a rebased head never is. The review re-read the whole PR from the merge base: $1.55, against $0.27 for the earlier incremental review, for an unchanged patch.

User rulings (2026-11-23): #3026 = prefer `packageManager`; otherwise, when the frozen install fails, try the next lockfile's frozen install; never a non-frozen install; the summary names the lockfile and `execution.preRun` as the override. #3027 = keep the review's saved gates; when the saved install fails, re-resolve the install from the current target tip and retry once if it differs; the message names `nax bot review <n>`. #3028 = the review detects a patch-equivalent rebase, skips the code review, carries findings, and re-resolves checks plus install and build; `nax bot fix`'s exact-head rule stays; a changed patch gets a full review as today.

## Design

### Integration

Read-only symbols (verified on `main` `7b8f0ccb1`, v0.92.15):

- `PreRunStepConfig { command: string; timeoutSeconds: number }` (`src/config/runtime-types-execution.ts`).
- `runPreRunSteps({ steps, workdir }): Promise<void>` (`src/execution/lifecycle/pre-run-steps.ts`): runs each step in order, throws `NaxError` `PRE_RUN_FAILED` with `context.command` on the first failing step. The bot reaches it only through `_botReviewDeps.runPreRunSteps` and `_botFixDeps.runPreRunSteps`, which the existing test helpers (`test/helpers/bot-review.ts`, `test/helpers/bot-fix.ts`) stub.
- `readBaseFile(input, fileName): Promise<string | null>` (`bot/checks.ts`, not exported): `null` when the file is missing at `input.baseSha`, throws when the inspection or read fails.
- `DERIVED_INSTALL_TIMEOUT_SECONDS = 600` (`bot/checks.ts`).
- `PrCheckout { worktree, baseSha, mergeBase, snapshotDir, hasBaseNax, inPlace?, ... }` (`bot/checkout.ts`): `baseSha` is the fetched target-branch tip, `mergeBase` the merge base of tip and head.
- `_botReviewDeps.runGit` (`botGit(args, workdir, timeoutMs?, maxBytes?)`, no stdin) and `_botReviewDeps.isAncestor` (`bot/review-deps.ts`).
- `loadLatestReview(outputDir, ref, headSha, { codeOnly? })` (`bot/fix-input.ts`): exact-head match; `codeOnly` skips only artifacts whose `scope` is `"conversation-only"`.
- `recordsCodeReview` (`bot/coverage-record.ts`) and `advanceAfterReview` (`bot/review-advance.ts`) exclude only `"conversation-only"`; `advanceAfterReview` also refuses when the review left a required file unread. The workflow publish (`workflow/item-threads-index.ts`) sets `reviewedHead` only for a run whose review ran with nothing unread. So an index `reviewedHead` always names a review that read every required file.
- `workflowPrReadiness` coverage hold (`bot/workflow-ready.ts`): applies only when the `w-coverage` record's `headSha` equals the current head.
- `prepareReview` (`bot/review-step.ts`): returns without writing a review package when `input.conversationOnly` is true, so a talk-only review reads no code and reports no unread files.

Symbols this feature changes. The baseline only locates the code; the target is the interface to implement.

- `LOCKFILE_COMMANDS` (`bot/checks.ts`). Baseline: `{ path, prefix, install }` entries. Target: each entry also carries `manager: "bun" | "npm" | "pnpm" | "yarn"`; order unchanged.
- `lockfileCommands(input)` (`bot/checks.ts`). Baseline: returns the first present entry's `{ prefix, install? }`, else `{ prefix: "npm run" }`. Target: returns `LockfileChoice` (below).
- `BotChecks` (`bot/checks.ts`). Baseline: `{ source, gates, preRun }`. Target: gains optional `install?: BotInstallChoice`, set only when `preRun` is the single step derived from a lockfile.
- `checksSchema` (`bot/fix-input.ts`). Baseline: `source`, `gates`, `preRun` (zod strips unknown keys, so an artifact carrying `install` already passes). Target (US-002): also validates an optional `install` of the `BotInstallChoice` shape; an artifact whose `install` is malformed is ignored like any other invalid checks.
- `prepareReviewChecks` (`bot/review-run.ts`) and `initialFixState` (`bot/fix-run.ts`). Baseline: call `runPreRunSteps({ steps: checks.preRun, ... })` through their deps object. Target: call `runBotInstall(checks, workdir, run)` with `run` = `_botReviewDeps.runPreRunSteps` / `_botFixDeps.runPreRunSteps`. The build steps keep calling the deps object directly.
- `initialFixState(env, outputDir, input)` (`bot/fix-run.ts`). Baseline: returns `BotFixState`. Target (US-001): returns `{ state: BotFixState; checks: BotChecks }`, where `checks` is `env.checks` with `preRun` replaced by `runBotInstall`'s `ran` after a successful install (the `readyOnly` early return and a failed setup return `env.checks` unchanged); `executeFix` runs the step graph with `{ ...env, checks }`, so the fix prompt's checkout state lists the install that ran. US-002 extends the same return for the re-resolved install.
- `fixChecks` (`bot/fix-run.ts`). Target (US-002): its `resolveBotChecks` call (with `repoRoot`, `baseSha`, `snapshotDir`, `hasBaseNax`, `config` and the `botChecksExtractOp` `extract` callback) moves into `resolveFixChecks(env)` in the new `bot/fix-setup.ts`, which both `fixChecks` and the re-resolve call; the saved-checks short-circuit stays in `fixChecks`.
- `prepareReviewChecks` setup reporting (`bot/review-run.ts`). Target (US-001): the checks it returns carry `preRun` = `runBotInstall`'s `ran` after a successful install, so the review's checkout state and summary setup list name the install that ran.
- `BotFixState` (`bot/fix-steps.ts`). Baseline: `setupFailed?: string`. Target: gains `setupHint?: string`; `outcomeText` (`bot/fix-outcome-text.ts`) renders it on the line after the setup-failed sentence. `fix-run.ts` is 509 lines, so the hint builder and `resolveFixChecks` live in the new `bot/fix-setup.ts` (US-002).
- `BotReviewScope` (`bot/review-rulings.ts`). Baseline: `"full" | "incremental" | "conversation-only"`. Target: adds `"rebased"`.
- `reviewScopeOf(input)` (`bot/review-rulings.ts`). Target: input gains `rebasedFrom?: string`; a defined `rebasedFrom` returns `"rebased"` before any other rule.
- `reviewRange(input, isAncestor)` (`bot/review-rulings.ts`). Target: `reviewRange(input, isAncestor, patchEquivalent?)`; returns `{ rangeBase, conversationOnly?, rebasedFrom? }` (US-003).
- `_botReviewDeps` (`bot/review-deps.ts`). Target: gains `patchEquivalent: PatchEquivalent`, defaulting to the implementation in the new `bot/review-rebase.ts` (US-003).
- `ReviewCarryInput` / `reviewCarry` (`bot/review-carry.ts`). Target: input gains `patchEquivalent?`, passed to `reviewRange`; `ReviewCarry.range` gains `rebasedFrom?`, which `reviewCarry` also passes to `earlierCarriedFindings`.
- `PrReviewInput` (`bot/review-step.ts`), `PostReviewInput` and `BotReviewArtifact` (`bot/post.ts`), `ReviewSummaryInput` (`bot/render-comments.ts`). Target: each gains `rebasedFrom?: string`.
- `earlierCarriedFindings` (`bot/carried-findings.ts`). Baseline: returns no carry when `rangeBase !== reviewedHead` and when `scope !== "incremental"`. Target: input gains `rebasedFrom?: string`; for scope `"rebased"` the range guard becomes `rebasedFrom !== reviewedHead` and the scope guard admits `"rebased"` as well as `"incremental"` (US-004).
- `reviewQuality` (`bot/post.ts`). Baseline: `"not-reviewed"` only for `"conversation-only"`. Target: also for `"rebased"`.
- `scopeSuffix` (`bot/render-comments.ts`). Target: scope `"rebased"` renders ` (rebase of <rebasedFrom 7 chars>, code review carried)`.

New types (`bot/checks.ts`):

```ts
export type InstallReason = "package-manager" | "lockfile-order";
export interface BotInstallChoice {
  /** The lockfile the install was derived from, e.g. "bun.lock". */
  readonly lockfile: string;
  readonly reason: InstallReason;
  /** Frozen installs of the other lockfiles present on the base, in LOCKFILE_COMMANDS order, deduplicated by command. */
  readonly fallbacks: readonly PreRunStepConfig[];
}
interface LockfileChoice {
  readonly prefix: string;
  readonly install?: string;
  readonly lockfile?: string;
  readonly reason?: InstallReason;
  readonly fallbacks: readonly PreRunStepConfig[];
}
```

New module `bot/install.ts` (US-001):

```ts
/** Runs checks.preRun with `run`; on PRE_RUN_FAILED with checks.install fallbacks, runs each fallback once, in order. */
export async function runBotInstall(
  checks: BotChecks,
  workdir: string,
  run: typeof runPreRunSteps,
): Promise<{ ran: readonly PreRunStepConfig[] }>;
```

New module `bot/review-rebase.ts` (US-003). `post.ts` (592 lines) and `review-run.ts` (585) sit near the 600-line source limit, so rebase logic lives here and those files only forward `rebasedFrom`; if a forward would still push one past 600 lines, extract existing code from it in the same story.

```ts
export interface PatchRange { readonly base: string; readonly head: string }
export type PatchEquivalent = (dir: string, a: PatchRange, b: PatchRange) => Promise<boolean>;
/** sha256 of a `git diff -U0` text after dropping `index ` lines and reducing each `@@ ... @@` header to `@@`; null for an empty diff. */
export function patchIdentity(diff: string): string | null;
/** Default `_botReviewDeps.patchEquivalent`: diffs both ranges through `run` and compares their identities. */
export function makePatchEquivalent(run: typeof botGit): PatchEquivalent;
```

### Approach

**US-001 — lockfile choice and fallback.** `lockfileCommands` checks every `LOCKFILE_COMMANDS` entry with `readBaseFile` (so a read or inspection failure still throws, as today) and collects the present ones. Only when two or more entries are present (the only case where `packageManager` can change the choice) does it read base `package.json`, taking `packageManager`'s name before the first `@`; with one or no lockfile it never reads `package.json`, so the config tier's existing no-`package.json`-read behaviour holds (`"npm@10.9.0"` -> `npm`); a missing or unparseable `package.json`, or a non-string `packageManager`, is ignored. If a present entry has that `manager` and an `install`, it is chosen with reason `package-manager`; otherwise the first present entry, reason `lockfile-order`. `fallbacks` are the other present entries that have an `install`, each as `{ command, timeoutSeconds: DERIVED_INSTALL_TIMEOUT_SECONDS }`, minus any whose command equals the chosen one. The detected tier's gate prefix follows the chosen entry. `BotChecks.install` is set where the derived install becomes `preRun` (the detected tier, and the install fallback in `resolveBotChecks`); never for a configured `execution.preRun` or an install extracted from AGENTS.md / CLAUDE.md. `runBotInstall` calls `run({ steps: checks.preRun, workdir })`; when that throws `PRE_RUN_FAILED` and `checks.install?.fallbacks` is non-empty, it logs a `[WARN]` naming the failed command and the next one, then calls `run` with each fallback as a single-step list until one succeeds. When every attempt fails it throws `PRE_RUN_FAILED` with `context.command` = the first failed command and `context.tried` = every command attempted, in order. Any other error propagates at once. Every lockfile entry is now inspected (today the loop stops at the first present one), so an inspection failure on a later lockfile also fails the derivation; a `package.json` inspection or read failure (not a missing file) fails it the same way.

**US-002 — fix re-resolves a failed saved install.** Inside `initialFixState`, the checks count as saved when `env.review.version >= 2 && env.review.checks != null` (the same rule `fixChecks` uses). When `runBotInstall` throws `PRE_RUN_FAILED` and the checks are saved, the fix calls `resolveFixChecks(env)` (the same `_botFixDeps.resolveBotChecks` call `fixChecks` makes, with `repoRoot`, the checkout's `baseSha` (the target tip), `snapshotDir`, `hasBaseNax`, config and the same `extract` callback through the fix's own call context, so an instruction-tier extraction is billed to this run like the initial resolve). If the fresh `preRun` is non-empty and its commands differ from the saved ones, it logs `Saved install failed; retrying with the install resolved from the base tip` (component `bot-fix`) with both command lists and calls `runBotInstall` once with the saved checks' `preRun`/`install` replaced by the fresh ones. Success continues the fix with the saved gates and the fresh install; failure, an identical fresh install, or an empty fresh `preRun` ends `setup-failed`. `setupHint` (built in `bot/fix-setup.ts`; every lockfile name and command in it goes through `safeCode`, as the setup-failed sentence does) describes the checks whose install failed last (the fresh ones when a retry ran, else the saved ones): `The install step was derived from \`<lockfile>\` (<the packageManager field | the first lockfile found>) on the base branch.` when `install` is present, plus `Also tried: \`<command>\`, ...` when `context.tried` lists more than one command, then always `Set execution.preRun in the base branch's .nax/config.json to choose the install step; after it is merged, the next nax bot fix <n> re-reads it, or run nax bot review <n> to refresh the saved checks.` The in-place "checkout not clean after setup" outcome gets no `setupHint`.

**US-003 — patch-equivalent rebase detection.** `reviewRange` keeps every existing rule. In the branch that today returns the full range because `reviewedHead` is not an ancestor of `head` (the ancestry call answered no, not threw), it first checks: `patchEquivalent` was given, `reviewedBase` is an ancestor of `checkout.mergeBase`, and `patchEquivalent(worktree, { base: reviewedBase, head: reviewedHead }, { base: checkout.mergeBase, head })` resolves `true`. Then it returns `{ rangeBase: checkout.mergeBase, conversationOnly: true, rebasedFrom: reviewedHead }`. A `patchEquivalent` that rejects is logged and answers the full range. `makePatchEquivalent(run)` runs `git diff --no-color --no-ext-diff -U0 <base> <head>` for each range through `run`; a non-zero exit (an object missing locally) answers `false`; otherwise it compares `patchIdentity` of the two outputs, and a `null` identity on either side answers `false`. `reviewScopeOf` returns `"rebased"` for a defined `rebasedFrom`. The review then runs as conversation-only for the model (no package, no code read), and `prepareReviewChecks` resolves checks and runs install and build exactly as for any trusted review.

**US-004 — what a rebased review carries and records.** `earlierCarriedFindings` reads `index.reviewedHead`'s record for scope `"rebased"` when `rebasedFrom === index.reviewedHead` (widen and absent rules as for incremental), so blocking summary-only findings carry to the new head's carried record; inline threads carry as they already do through `mergeEarlier`. The existing `recordsCodeReview`, `advanceAfterReview` and `loadLatestReview` rules already treat any scope but `"conversation-only"` as a code review, so the coverage record is written at the new head (with no unread files, because nothing was read and the reviewed head it rests on was complete), the index moves to the new head and merge base, and `nax bot fix` loads the rebased artifact as the head's code review; US-004 pins these with ACs. `reviewQuality` reports `"not-reviewed"` for `"rebased"`.

### Failure Handling

| Case | Behaviour | Story |
|:---|:---|:---|
| `package.json` missing, unparseable, or `packageManager` not a string | ignored; reason `lockfile-order` | US-001 |
| `packageManager` names a manager with no present lockfile, or one whose entry has no install (yarn) | ignored; reason `lockfile-order` | US-001 |
| `package.json` inspection or read fails (not missing) | the derivation fails as for a lockfile read failure | US-001 |
| A present lockfile's read or inspection fails | the derivation fails as today (detected tier yields `none`, config tier keeps its gates without an install, with a warning) | US-001 |
| Configured `execution.preRun` fails | no fallback; `PRE_RUN_FAILED` as today | US-001 |
| Every lockfile install fails | `PRE_RUN_FAILED` naming the first command, `tried` lists all | US-001 |
| `runBotInstall` hits a non-`PRE_RUN_FAILED` error | propagates at once, no fallback | US-001 |
| Saved artifact has a malformed `install` | artifact ignored (existing invalid-checks warning) | US-001 |
| Saved install fails and fresh `preRun` is identical | `setup-failed`, no retry | US-002 |
| Saved install fails and fresh `preRun` is empty | `setup-failed`, no retry | US-002 |
| Saved install fails, fresh install also fails | `setup-failed` naming the fresh command | US-002 |
| `resolveBotChecks` throws during the re-resolve | `setup-failed` with the saved command; the error is logged, not thrown | US-002 |
| Checks did not come from a saved review | no re-resolve | US-002 |
| Old reviewed head missing locally (gc'd or never fetched) | the ancestry check throws first and the existing catch reviews the full range; a direct `patchEquivalent` call answers `false` | US-003 |
| `reviewedBase` not an ancestor of the new merge base | full review as today | US-003 |
| `patchEquivalent` rejects | logged; full review | US-003 |
| `--full` given | full review, no rebase detection | US-003 |
| Pending carry-widen comment on the PR | widens to a full review (existing rule) | US-004 |
| The reviewed head's carried record is unparseable | widens to a full review (existing rule) | US-004 |

## Out of Scope

- A non-frozen install (`bun install`, `npm install`) as any fallback: it rewrites a lockfile the fix session could commit (#3026 ruling).
- Reading the package manager from AGENTS.md / CLAUDE.md prose for the derived install; only `package.json` `packageManager` is read.
- Changing the saved review artifact's checks after a fallback or re-resolved install succeeds; only the running command's checks change.
- Install fallbacks for a configured `execution.preRun` or an install extracted from instruction files.
- Changing the `--in-place` cleanliness check: a fallback or re-resolved install that dirties an in-place checkout ends `setup-failed` with "in-place checkout not clean after setup", as any install does today.
- Re-resolving the saved gates (not only the install) in `nax bot fix`; the gates stay as the head's review saved them (#3027 ruling, #2628 design).
- Recording the review's own install failure in the review artifact; `nax bot fix` detects a failing saved install by running it.
- Fetching a reviewed head that is no longer present locally (force-pushed away and gc'd, or reviewed on another machine) to compare patches; that case gets a full review as today.
- Recording a durable patch identity in the workflow item index so a rebase can be recognised without the old head's objects.
- Reviewing only the commits whose content changed in a rebase that also edited the patch (`git range-diff`); a changed patch gets a full review.
- `nax bot fix` accepting a review of a different head; its exact-head rule is unchanged (#3028 ruling).
- Re-anchoring inline findings whose lines moved in the rebase (the `line_code can't be blank` re-post failures); unchanged.
- Carrying the earlier review's `quality` verdict to a rebased review; it reports `not-reviewed`.

## Stories

**US-001 — choose the install by `packageManager` and fall back across lockfiles (#3026).** Workdir: `packages/nax`. No dependencies. Adds `manager` to `LOCKFILE_COMMANDS`, `LockfileChoice` / `BotInstallChoice` / `BotChecks.install`, the new `bot/install.ts` with `runBotInstall`, and wires `runBotInstall` into `prepareReviewChecks` and `initialFixState` with each command's own `runPreRunSteps` dep, reporting the install that ran (`initialFixState` returns `{ state, checks }`).

**US-002 — `nax bot fix` re-resolves a failed saved install from the base tip and explains setup failures (#3027).** Workdir: `packages/nax`. Depends on US-001 (it uses `runBotInstall` and `BotChecks.install`). Adds `bot/fix-setup.ts` (`resolveFixChecks`, the `setupHint` builder); changes `fixChecks` to use `resolveFixChecks` and `initialFixState` to detect saved checks, re-resolve and retry once, and return the re-resolved install in its `checks`; adds `BotFixState.setupHint` rendered by `outcomeText` and the `install` field of `checksSchema`.

**US-003 — recognise a patch-equivalent rebase as a `rebased` review scope (#3028).** Workdir: `packages/nax`. No dependencies. Adds `bot/review-rebase.ts` (`patchIdentity`, `makePatchEquivalent`, `PatchEquivalent`, `PatchRange`), `_botReviewDeps.patchEquivalent`, the third `reviewRange` parameter, `rebasedFrom` through `reviewCarry`, `PrReviewInput`, `PostReviewInput`, `BotReviewArtifact` and the summary, the `"rebased"` scope in `reviewScopeOf`, and the summary suffix.

**US-004 — a rebased review carries findings and coverage and lets `nax bot fix` run on the new head (#3028).** Workdir: `packages/nax`. Depends on US-003 (it consumes the `"rebased"` scope and `rebasedFrom`). Changes `earlierCarriedFindings` and `reviewQuality` for `"rebased"`; pins the coverage record, the index advance and the fix load, which existing rules already allow.

### Context Files

**US-001**
- `packages/nax/src/bot/checks.ts` — lockfile table, tiers, `resolveBotChecks`
- `packages/nax/src/bot/review-run.ts` — `prepareReviewChecks`
- `packages/nax/src/bot/fix-run.ts` — `initialFixState`
- `packages/nax/src/bot/fix-steps.ts` — `BotFixEnv`, the fix prompt's checkout state
- `packages/nax/test/unit/bot/checks.test.ts` — the base-file fixture (`files`, `manifest`, `configGates`)

**US-002**
- `packages/nax/src/bot/fix-run.ts` — `fixChecks`, `initialFixState`, `executeFix`
- `packages/nax/src/bot/fix-outcome-text.ts` — `outcomeText`
- `packages/nax/src/bot/fix-steps.ts` — `BotFixState`, `BotFixEnv`
- `packages/nax/test/helpers/bot-fix.ts` — `makeBotFixEnv` builds a `version: 1` review with no saved checks; the saved-checks tests build a `version: 3` review with `checks`
- `packages/nax/src/bot/fix-input.ts` — `checksSchema`

**US-003**
- `packages/nax/src/bot/review-rulings.ts` — `reviewRange`, `reviewScopeOf`
- `packages/nax/src/bot/review-carry.ts` — `reviewCarry`
- `packages/nax/src/bot/review-deps.ts` — `_botReviewDeps.isAncestor`, `runGit`
- `packages/nax/src/bot/review-run.ts` — the review input and post input assembly
- `packages/nax/src/bot/render-comments.ts` — `scopeSuffix`, `renderReviewSummary`

**US-004**
- `packages/nax/src/bot/carried-findings.ts` — `earlierCarriedFindings`
- `packages/nax/src/bot/coverage-record.ts` — `recordsCodeReview`
- `packages/nax/src/bot/post.ts` — `reviewQuality`, artifact fields
- `packages/nax/src/bot/review-advance.ts` — `advanceAfterReview`
- `packages/nax/src/bot/fix-input.ts` — `loadLatestReview`

### Creates

**US-001**
- `packages/nax/src/bot/install.ts` — `runBotInstall`
- `packages/nax/test/unit/bot/install.test.ts` — fallback behaviour

**US-002**
- `packages/nax/src/bot/fix-setup.ts` — `resolveFixChecks`, the `setupHint` builder
- `packages/nax/test/unit/bot/fix-setup.test.ts` — hint text tests

**US-003**
- `packages/nax/src/bot/review-rebase.ts` — `patchIdentity`, `makePatchEquivalent`, `PatchEquivalent`, `PatchRange`
- `packages/nax/test/unit/bot/review-rebase.test.ts` — identity and equivalence tests

**US-004**

None.

### Modifies

**US-001**
- `packages/nax/test/unit/bot/checks.test.ts` — "US-003 AC-1/2: bun scripts resolve detected ordered gates" asserts the whole `resolveBotChecks` result with `toEqual` on `{ source, gates, preRun }`; a lockfile-derived result now also carries `install`, so the expectation adds `install: { lockfile: "bun.lock", reason: "lockfile-order", fallbacks: [] }`. Gates and `preRun` stay as asserted.
- `packages/nax/test/unit/bot/checks.test.ts` — the "US-003 %s: lockfile selects prefix and install" table asserts each whole result with `toEqual`; rows whose lockfile has an install (package-lock.json, pnpm-lock.yaml, bun.lockb) now also expect `install: { lockfile: <that file>, reason: "lockfile-order", fallbacks: [] }`; the yarn.lock and no-lockfile rows expect no `install` field. Prefixes and `preRun` stay as asserted.

**US-002**

None. The setup-failed tests assert the first sentence with `toContain`, which is unchanged, and their `makeBotFixEnv` review is `version: 1` with no saved checks, so no re-resolve runs.

**US-003**
- `packages/nax/test/helpers/bot-review.ts` — `makeBotReviewDeps` returns the deps the review tests install; it gains `patchEquivalent: async () => false`, so existing non-ancestor review tests stay hermetic (no real `git diff`) and keep their full-range answer. No assertion changes.

**US-004**

None. The "carries nothing when %s" table in `carried-findings.test.ts` pins `full`, `conversation-only` and a non-reviewed-head range base for incremental; the new guard keeps all three, and `rebasedFrom` is an optional input field.

### Seams

- US-001 `runBotInstall` is called by `runBotReview` (through `prepareReviewChecks`) and `runBotFix` (through `initialFixState`); each gets a seam AC entered at that command, stubbing the command's existing `runPreRunSteps` dep.
- US-003 `_botReviewDeps.patchEquivalent` is called by `runBotReview` (through `reviewCarry` -> `reviewRange`); its seam AC triggers `runBotReview`.
- US-004 consumes US-003's `"rebased"` scope; its ACs trigger `runBotReview` and `runBotFix` with a stubbed rebase.

## Acceptance Criteria

### US-001

1. [unit] `resolveBotChecks` on a base with `bun.lock`, `package-lock.json` and a `package.json` with `scripts.lint` and `packageManager` `"npm@10.9.0"` (no `.nax`, no instruction files) returns `preRun` `[{ command: "npm ci", timeoutSeconds: 600 }]`.
2. [unit] In that case the lint gate's command is `npm run lint`.
3. [unit] In that case `checks.install` equals `{ lockfile: "package-lock.json", reason: "package-manager", fallbacks: [{ command: "bun install --frozen-lockfile", timeoutSeconds: 600 }] }`.
4. [unit] On a base with `bun.lock`, `package-lock.json` and a `package.json` with `scripts.lint` and no `packageManager`, `resolveBotChecks` returns `preRun` `bun install --frozen-lockfile` and `install` `{ lockfile: "bun.lock", reason: "lockfile-order", fallbacks: [{ command: "npm ci", timeoutSeconds: 600 }] }`.
5. [unit] On a base with `bun.lock`, `package-lock.json` and a `package.json` with `scripts.lint` and `packageManager` `"pnpm@9.0.0"`, `checks.install.reason` is `lockfile-order` and `preRun` is the `bun.lock` install.
6. [unit] On a base with `yarn.lock`, `package-lock.json` and a `package.json` with `scripts.lint` and `packageManager` `"yarn@4.1.0"`, `resolveBotChecks` returns `preRun` `[{ command: "npm ci", timeoutSeconds: 600 }]` with `install.reason` `lockfile-order`.
7. [unit] On a base with `bun.lock` and `bun.lockb` (no other lockfile) and a `package.json` with `scripts.lint`, `checks.install.fallbacks` is `[]`.
8. [unit] With a base `.nax/config.json` that sets `quality.commands` and `execution.preRun` `[{ command: "make deps", timeoutSeconds: 60 }]`, `resolveBotChecks` returns that `preRun` and no `install` field.
9. [unit] With a base `.nax/config.json` that sets `quality.commands` but no `execution.preRun`, `bun.lock` and `package-lock.json` present, and a `package.json` that does not parse, `resolveBotChecks` returns source `config`, `preRun` `bun install --frozen-lockfile` and `install.fallbacks` `[{ command: "npm ci", timeoutSeconds: 600 }]`.
10. [unit] With that config tier, both lockfiles, and a `package.json` whose `packageManager` is `42`, `checks.install.reason` is `lockfile-order`.
11. [unit] With that config tier, both lockfiles and no `package.json` on the base, `checks.install.reason` is `lockfile-order`.
12. [unit] A detected-tier result (no `quality.commands`) with a base `.nax/config.json` that sets `execution.preRun` `[{ command: "make deps", timeoutSeconds: 60 }]`, `bun.lock` present and a `package.json` with `scripts.lint` has `preRun` `make deps` and no `install` field.
13. [unit] `runBotInstall` with `preRun` `[A]`, `install.fallbacks` `[B]`, and a `run` that rejects `PRE_RUN_FAILED` for `A` and resolves for `B`, resolves `{ ran: [B] }`.
14. [unit] In that case `run` was called with steps `[A]` and then `[B]`, both with the given workdir.
15. [unit] In that case a warning log line names the failed command `A` and the next command `B`.
16. [unit] `runBotInstall` with fallbacks `[B, C]` and a `run` that rejects `PRE_RUN_FAILED` for `A`, `B` and `C` rejects with a `NaxError` `PRE_RUN_FAILED` whose `context.command` is `A` and `context.tried` is the array of command strings `[A, B, C]`.
17. [unit] `runBotInstall` whose first `run` call rejects with an error whose code is not `PRE_RUN_FAILED` rejects with that same error and makes no further `run` call.
18. [unit] `runBotInstall` with no `install` field and a failing `preRun` rejects with the original `PRE_RUN_FAILED` error after exactly one `run` call.
19. [unit] `runBotInstall` whose `preRun` succeeds resolves `{ ran: preRun }` and calls `run` once.
20. [integration] `runBotReview` on a trusted PR whose resolved checks carry `preRun` `[A]` and `install.fallbacks` `[B]`, with `_botReviewDeps.runPreRunSteps` rejecting `PRE_RUN_FAILED` for `A` and resolving for `B`, posts a summary with no `Install step failed` line.
21. [integration] In that `runBotReview`, the checkout state given to the review lists `B` as the setup command, not `A`.
22. [integration] `runBotFix` whose checks carry `preRun` `[A]` and `install.fallbacks` `[B]`, with `_botFixDeps.runPreRunSteps` rejecting `PRE_RUN_FAILED` for `A` and resolving for `B`, calls `runBranchFix` and does not end `setup-failed`.
23. [integration] In that `runBotFix`, the fix prompt's checkout state lists `B` as the setup command, not `A`.

### US-002

1. [integration] `runBotFix` whose head review is `version: 3` with saved checks whose `preRun` is `bun install --frozen-lockfile`, where that install fails and `_botFixDeps.resolveBotChecks` returns `preRun` `npm ci` which succeeds, calls `runBranchFix` and does not end `setup-failed`.
2. [integration] In that case `_botFixDeps.resolveBotChecks` is called a second time (the re-resolve), with `baseSha` equal to the checkout's `baseSha` and `repoRoot` equal to the fix's repo root.
3. [integration] In that case the fix prompt's checkout state lists `npm ci` as the setup command, not `bun install --frozen-lockfile`.
4. [integration] In that case the gate commands the fix runs are the saved review's gates, not the re-resolved ones.
5. [integration] In that case an info log line with message `Saved install failed; retrying with the install resolved from the base tip` carries both command lists.
6. [integration] When the saved install fails and `resolveBotChecks` returns the identical `preRun`, `runBotFix` ends `setup-failed` naming the saved command, and `runPreRunSteps` was called once.
7. [integration] When the saved install fails and `resolveBotChecks` returns `preRun` `[]`, `runBotFix` ends `setup-failed` naming the saved command, and `runPreRunSteps` was called once.
8. [integration] When the saved install fails and the re-resolved install also fails, `runBotFix` ends `setup-failed` with `setupFailed` naming the re-resolved command.
9. [integration] When the saved install fails and `resolveBotChecks` rejects, `runBotFix` ends `setup-failed` naming the saved command and does not reject.
10. [integration] When the head review is `version: 1` (no saved checks) and the install fails, `runBotFix` ends `setup-failed` and `resolveBotChecks` was called exactly once (the initial resolve).
11. [unit] `outcomeText` for a `setup-failed` state with `setupFailed: "bun install --frozen-lockfile"` and a `setupHint` returns text whose first line is ``Setup failed at `bun install --frozen-lockfile`; nothing ran.``
12. [unit] For that state, the text's second line equals the `setupHint`.
13. [integration] The fix summary posted for a setup failure whose checks carry `install` `{ lockfile: "bun.lock", reason: "lockfile-order" }` contains ``derived from `bun.lock` (the first lockfile found) on the base branch``.
14. [integration] The fix summary posted for a setup failure whose checks carry `install` reason `package-manager` contains `(the packageManager field)`.
15. [integration] The fix summary posted for a setup failure whose error `context.tried` is `[A, B]` contains ``Also tried: `B` ``.
16. [integration] The fix summary posted for any install setup failure on PR 42 contains `Set execution.preRun in the base branch's .nax/config.json` and `nax bot review 42`.
17. [unit] `loadLatestReview` returns `null` when the head's only artifact has `checks.install.reason` `"other"`.
18. [unit] `loadLatestReview` returns the head's artifact when its `checks.install` is `{ lockfile: "bun.lock", reason: "lockfile-order", fallbacks: [] }`.
19. [unit] The `setupHint` built for an install whose `lockfile` is ``a`b.lock`` renders the name through `safeCode`, so the hint contains no unbalanced backtick.

### US-003

1. [unit] `reviewRange` with an index whose `reviewedHead` is not an ancestor of `head`, `reviewedBase` an ancestor of `checkout.mergeBase`, and a `patchEquivalent` that resolves `true`, returns `{ rangeBase: checkout.mergeBase, conversationOnly: true, rebasedFrom: reviewedHead }`.
2. [unit] In that case `patchEquivalent` is called with the worktree, `{ base: reviewedBase, head: reviewedHead }` and `{ base: checkout.mergeBase, head }`.
3. [unit] The same inputs with `patchEquivalent` resolving `false` return `{ rangeBase: checkout.mergeBase }` with no `rebasedFrom`.
4. [unit] The same inputs with `reviewedBase` not an ancestor of `checkout.mergeBase` return the full range and never call `patchEquivalent`.
5. [unit] The same inputs with `patchEquivalent` rejecting return the full range and log a warning; `reviewRange` does not reject.
6. [unit] `reviewRange` called with two arguments for a non-ancestor head returns the full range.
7. [unit] `reviewRange` for a head that descends from `reviewedHead` returns the incremental range and never calls `patchEquivalent`.
8. [unit] `reviewScopeOf({ rangeBase, mergeBase, conversationOnly: true, rebasedFrom: "a".repeat(40) })` returns `"rebased"`.
9. [unit] `patchIdentity` returns the same value for two `-U0` diff texts that differ only in their `index ` lines and the line numbers of their `@@` headers.
10. [unit] `patchIdentity` returns different values for two diff texts whose added lines differ.
11. [unit] `patchIdentity("")` returns `null`.
12. [integration] `makePatchEquivalent(botGit)` on a temporary git repository returns `true` for a commit and its rebase onto a later base commit that changes a different file.
13. [integration] It returns `false` when the rebased commit's patch differs by one changed line.
14. [integration] It returns `false` when the first range names a commit not present in the repository, and does not reject.
15. [integration] `runBotReview` on a PR whose index `reviewedHead` is not an ancestor of the head, with `_botReviewDeps.patchEquivalent` stubbed `true`, writes a review artifact with `scope: "rebased"` and `rebasedFrom` equal to the index `reviewedHead`.
16. [integration] In that `runBotReview`, the review operation receives `conversationOnly: true` and no review package is written.
17. [integration] In that `runBotReview`, `runPreRunSteps` is called with the resolved checks' `preRun`.
18. [integration] In that `runBotReview`, the posted summary's first line starts `Review of <head7> (rebase of <reviewedHead7>, code review carried):`.
19. [integration] `runBotReview` with `full: true` on the same PR never calls `patchEquivalent` and writes `scope: "full"`.

### US-004

1. [unit] `earlierCarriedFindings` with scope `"rebased"`, `rangeBase` equal to the merge base, `rebasedFrom` equal to `index.reviewedHead`, and a usable carried record for that head returns the record's findings with `widen: false`.
2. [unit] `earlierCarriedFindings` with scope `"rebased"`, `rebasedFrom` equal to `index.reviewedHead`, and an unparseable record for that head returns `widen: true`.
3. [unit] `earlierCarriedFindings` with scope `"rebased"`, `rebasedFrom` equal to `index.reviewedHead`, and a pending carry-widen comment returns `widen: true`.
4. [unit] `earlierCarriedFindings` with scope `"rebased"` and `rebasedFrom` different from `index.reviewedHead` returns no findings and `widen: false`.
5. [unit] `reviewQuality("rebased", "good")` returns `"not-reviewed"`.
6. [unit] `recordsCodeReview` returns `true` for a trusted workflow PR review with scope `"rebased"` (pin).
7. [unit] `loadLatestReview(outputDir, ref, head, { codeOnly: true })` returns an artifact for `head` whose `scope` is `"rebased"` (pin).
8. [integration] `runBotReview` of a rebased head whose reviewed head's carried record holds one blocking summary-only finding posts a carried record for the new head that holds that finding's key.
9. [integration] In that `runBotReview`, the coverage record is written with `headSha` equal to the new head and no uncovered files.
10. [integration] In that `runBotReview`, `advanceReviewedHead` is called with `head` equal to the new head and `base` equal to the new merge base.
11. [integration] `runBotFix` on a head whose only review artifact has `scope: "rebased"` does not refuse and calls `runBranchFix`.
12. [integration] In that `runBotFix` with no push, the fix summary does not mark the PR ready while the carried blocking finding's key is in the new head's carried record.
