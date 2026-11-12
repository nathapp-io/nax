# SPEC: bot-and-prompt — the bot readies only a reviewed head, quieter guard and warnings, test prompts match the declared placeholders, attributable cost rows

Closes: #2880, #2881

## Summary

Seven bounded fixes from the 2026-11-09 .. 11-12 run analysis. `nax bot fix` stops marking a PR ready
right after its own push: the pushed head has not been reviewed yet, so the post-push review and the
ready-only pass decide. A ready-only pass holds while the bot's review of the current head has an open
critical or important finding, and a conversation-only review is recorded as `not-reviewed` instead of
`approved`. The reviewer guard stops reporting tool-generated `.gitignore` files inside already-ignored
directories, and reports moved refs under their own event instead of "reverted". The bot fix prompt states
which paths it can never change, the fix checkout runs the same build the review checkout runs, and a red CI
names its failing checks. Agents are no longer shown a `files` value for a test command that declares no
`{{files}}` placeholder, and nax warns at config load when `testScoped` cannot scope. Declared commands run
without colour codes, the Bash tool names `$TMPDIR` up front, and rtk's compacted-output hint becomes a neutral
marker. Finally, cost rows carry the nax version and commit, partial rows inherit the story of the dispatch
error they belong to, and three noisy warnings fire once or not at all.

## Motivation

Evidence from 50 bot runs and the workflow runs of 2026-11-09 .. 11-12 (report
`telemetry/report-2026-11-09-to-12.md`, gaps G1, G3, G4 and the improvements list):

1. **Ready after its own push.** `readyStep` (`bot/fix-report.ts`) runs straight after `push` and `reply`
   in the fix graph (`bot/fix-run.ts`). It checks the item index, coverage and CI, so a PR was marked ready on
   a head no bot review had seen. The post-push review then found an `important` finding, and the following
   ready-only pass returned `ready-pass` because the PR was no longer a draft.
2. **Conversation-only reviews recorded `approved`.** 9 of 24 `bot-review.json` have
   `scope: "conversation-only"` (no code read); two of them say `quality: "approved"` with `rulings.open` 1.
3. **Reviewer guard false alarms.** `reviewer-tree-reverted` fired in 5 runs only because a tool the reviewer
   ran (`uv`, `mypy`, `bun install`) wrote a `.gitignore` under `.venv/`, `.mypy_cache/` or
   `node_modules/.bun/...`; `restoreIgnoreRules` deletes and reports it. Branch and tag moves the guard
   deliberately never restores (ruling R15) are logged inside the same "reverted" event.
4. **Fix agent handed work it cannot do.** An item needing an edit under `.nax/specs/` was attempted for
   885 s and denied; `fixProtectedPaths` already forbids the push, but the fix prompt never says so.
5. **Unbuilt workspace packages.** The review checkout runs the root `build` gate after install
   (`runReviewBuild`); the fix checkout runs the install only, so the fix agent built a workspace package by hand.
6. **Red CI says only "a check failed".** `terminalPoll` (`workflow/ci-wait.ts`) drops the failing check
   names it already parsed into `failureDetail`.
7. **`files` passed to a command with no placeholder.** The `RunCommand` `values` field description always
   shows `{ files: "a.test.ts" }`, and the rectifier's per-failing-file block wraps a `run-test` region with
   `files` whenever a `testScoped` template exists, even one with no `{{files}}`. Two consumer projects
   declare such a `testScoped`: 50 `value "files" is not a placeholder` errors, then the full suite through
   sandboxed Bash: 70 Bash timeouts at 300 s, 5-8 MB of output per call, 6 sessions at the 30/60-min limit.
8. **Output handling.** rtk's trailing `[+N hidden: ...]` hint is stripped (R4: the agent cannot run rtk),
   so the model cannot tell output was compacted. ANSI colour codes appeared in 223 of 501 `RunCommand`
   failures in one project. `/tmp` writes were denied 45 times; the Bash description names `$TMPDIR` only as
   "this run's temp directory ($TMPDIR)" without saying `/tmp` is not it.
9. **Telemetry.** Partial cost rows of an interrupted session carry `storyId: null` (~$1.9 unattributable);
   cost rows carry no `naxVersion` / `naxCommit`; `reconcileRunCost` warns on deltas of ~1e-16.
10. **Noise.** Every bot run warns `resolve() called for non-root package before hydrate()` for
    `packageDir: ".nax-wt/bot-pr-..."`, and a removed config key warns twice per bot run because the config is
    loaded twice.

## Design

### Approach

Each story is a small change at one existing site. No new config key, no new graph node, no new forge call.

**US-001 readiness.** `readyStep(env, state)` gains two holds, checked before the draft check:

- When `state.pushedSha` is set and `state.readyOnly` is not `true` (this execution pushed), it returns
  `{ patch: { markedReady: false, readyHeld }, exit: "report" }` with
  `readyHeld = "pushed <sha7>; a bot review of the pushed head decides readiness (nax bot review <n>, then nax bot fix <n> --ready-only)"`.
  The existing `waitForPrHead` check stays first. `runBotFixCycle` already reviews the pushed head and then
  runs a ready-only pass, so the default `nax bot fix` flow still readies a clean PR. With `--no-rereview`
  (documented as "Skip post-push review and ready pass") a pushed PR stays a draft until
  `nax bot fix <n> --ready-only` runs after a review of the pushed head.
- A `"not-reviewed"` artifact does not itself hold readiness: its head was reviewed before, and that earlier
  code review is the one the hold reads.
- Otherwise, when the readiness review's `agreed` list holds an item with `kind: "finding"` and `severity`
  `"critical"` or `"important"`, it holds with
  `readyHeld = "<n> open critical/important finding(s) in the bot review of <sha7>: <key>, <key>"`
  (keys in `agreed` order, at most 5 shown, then `, +<m> more`). The readiness review is the new optional
  `BotFixEnv.codeReview` when set, else `env.review`. `fixCheckout` sets `codeReview` from
  `loadLatestReview(outputDir, prNumber, headSha, { codeOnly: true })`, which skips artifacts whose
  `scope` is `"conversation-only"`. A conversation-only review runs only when the head was already reviewed
  (`reviewedHead === head` in `review-rulings.ts`) and reads no code, so the head's open findings live in the
  earlier code review; reading only the newest artifact would let a conversation-only review hide them. The
  `agreed` list already excludes settled findings, so a finding fixed, ruled or withdrawn before that review
  does not hold. Minor findings, threads and comments never hold. `loadLatestReview` without the option is
  unchanged.
- `nax bot fix <pr> --ready-only` is a new CLI flag: `botFixCommand` calls `runBotFix` with `readyOnly: true`
  directly (no fix session, no post-push review), prints the readiness result the way the cycle's ready pass
  is printed today, and exits 0 whether the PR was readied or held. It is the documented recovery for a
  `--no-rereview` push and for a hold lifted by a ruling or a new review.

`BotReviewArtifact.quality` and the `posted` result's `quality` widen to
`PrReviewVerdict["quality"] | "not-reviewed"`. `persistArtifact` and `runBotReview` write `"not-reviewed"`
when the review's scope is `"conversation-only"`, and the verdict's own quality otherwise. The review summary
line (`renderReviewSummary`) prints the same value. The `PrReviewVerdict` type itself is unchanged.

**US-002 guard.** `restoreIgnoreRules` resets the snapshot's own `.gitignore` files first, then classifies
each added `.gitignore` (one outside the snapshot-time `known` set). An added `.gitignore` whose containing
directory is ignored by the restored rules (`git check-ignore -q -- <dir>/` through the guard's `git` seam
`_snapshotDeps.git`, exit 0) is left in place and not returned: it can only affect paths that
are already ignored, so it cannot hide a reviewer's file from the comparison. Every other added
`.gitignore` is removed and returned as today, including when `check-ignore` exits with anything other than 0
or 1. Known `.gitignore` files reset to their snapshot content are still returned in `paths`, as today. The
`known === null` branch is unchanged.
`ReviewerTreeGuard.restoreEntry` logs `reviewer-tree-reverted` only when `paths`, `indexRestored`,
`headRestored` or `failures` report something, and logs `refsLeft` / `stashLeft` under a separate warning
`reviewer-refs-left` (fields `storyId`, `role`, `refsLeft`, `stashLeft`) when either is non-empty. Ref and
stash restore behaviour (R15: only this worktree's own HEAD) is unchanged.

**US-003 bot fix.** Three changes:

- `buildBotPrFixPrompt` in `"fix"` mode adds one rule to "How to work": the fix can never change files under
  `.nax/`, `.github/` or `.gitlab/`, agent configuration (`AGENTS.md`, `CLAUDE.md`, `.claude/`, `.nax/rules`
  and similar), `.env` files or key files, because nax refuses to push them; an item whose fix needs one of
  them is left unchanged and named in `"concerns"` with status `DONE_WITH_CONCERNS`. The rule is a constant
  next to the other shared rules; the `repair` and `prepare` modes do not carry it.
- `initialFixState` (`bot/fix-run.ts`), after a successful install and when the checkout is not in place,
  runs `reviewBuildSteps(env.checks)` through `_botFixDeps.runPreRunSteps` in the worktree. A
  `PRE_RUN_FAILED` from the build logs the warning `Fix build step failed` (fields `pr`, `command`) and the
  fix continues; any other error propagates. A ready-only run and an in-place checkout run no build.
- `terminalPoll` (`workflow/ci-wait.ts`) returns `{ outcome: "failed", detail: poll.failureDetail ?? "a check failed" }`
  for a finished failure, the same fallback the pending-failure path in `checkHistory` already uses, so
  `readyHeld: "CI failed: ..."` names the failing GitHub checks. GitLab polls carry
  no `failureDetail` and keep the fallback text.

**US-004 noise.**

- `createPackageRegistry(...).resolve(packageDir)` warns only when the override key
  (`packageOverrideKey(relativeKey)`) is non-empty. A `.nax-wt/<id>` worktree root has an empty override key,
  so it resolves to the root view silently, as the repo root does.
- `warnOrDefer(stage, message)` with an initialized logger calls `instance.warnOnce(stage, message)` instead
  of `instance.warn(stage, message)`, so the same config warning from a second config load in one run is
  written once. The deferred (pre-logger) branch already de-duplicates and is unchanged.
- `reconcileRunCost` warns only when `totalCost - aggregatorTotal` exceeds `COST_RECONCILE_EPSILON_USD`
  (`1e-9`); the returned value is still `Math.max(totalCost, aggregatorTotal)`.

**US-005 nax-agent tool text and env.**

- `createRunCommandTool(declared, opts)` computes `takesFiles` (at least one declared command's template
  carries a `{{files}}` placeholder, via `placeholdersOf`) and passes it to
  `runCommandInputSchema(keys, exec, takesFiles)`, which passes it to `declaredInputProperties(keys, takesFiles)`.
  The `values` description keeps today's `files` examples when `takesFiles` is `true`, and reads
  `"None of the declared commands take placeholders: omit values."` when it is `false`. The `command` enum is
  unchanged. The flag is passed in rather than computed in `run-command-surface.ts`, which `run-command.ts`
  imports.
- `sandboxSentence(network, sharedTmp, platform)` with `sharedTmp` `false` reads
  `"this run's temp directory ($TMPDIR) rather than /tmp, which is not writable"` in place of
  `"this run's temp directory ($TMPDIR)"`; the old phrase stays a prefix. The `sharedTmp = true` default and the
  shared-temp phrase are unchanged.

**US-006 nax prompts, declared-command env and rtk.**

- `runQualityCommand` (`quality/runner.ts`), which runs every declared command an agent calls through
  `RunCommand` and every quality gate, spawns with `NO_COLOR: "1"` and `FORCE_COLOR: "0"` added to the env
  built by `withAgentOutputEnv`, through a new exported helper `withNoColorEnv(env, strippedVars)` in the same
  file. A variable the base env already sets, or one named in `stripEnvVars`, is left as it is; the caller's
  `env` option still overrides last. `withAgentOutputEnv` itself and the Bash tool env are unchanged.

- `failingTestRectification`'s per-failing-file block wraps a line in a `run-test` region (with `files`) only
  when `opts.testScopedTemplate` contains `{{files}}`. A template with no `{{files}}` placeholder renders a
  single line holding the template, wrapped in a `run-check` region `{ command: opts.fileScopeCommandName }`,
  instead of one line per failing file.
- `warnScopedTestCommand(conf, warn)` in `config/config-guards.ts`, called by the loader right after
  `warnQualityCommandChains`, warns when `quality.commands.testScoped` is declared and either holds no
  `{{files}}` placeholder (`"quality.commands.testScoped declares no {{files}} placeholder, so agents cannot scope a test run to their files; add {{files}} where the runner takes test paths"`)
  or equals `quality.commands.test` (`"quality.commands.testScoped equals quality.commands.test, so every scoped run is the full suite"`).
  A command list is checked across its entries: it warns for no placeholder only when no entry holds one.
- The rtk interceptor's `postProcess` replaces a trailing `[+N hidden: rtk ...]` hint with
  `[output compacted: N lines hidden]` and a trailing `[full output: rtk ...]` or `[full diff: rtk ...]` hint
  with `[output compacted]`. Output without a trailing hint is returned byte-for-byte, as today. No rtk
  command reaches the agent (R4).

**US-007 cost rows.**

- Every cost row nax writes (`attachCostSubscriber` success and error rows, `toPartialCostEvent`, the chat
  ledger row) carries `naxVersion: NAX_VERSION` and `naxCommit: NAX_COMMIT` from `src/version.ts`.
  `CostEvent` gains both as optional strings; readers of older rows are unaffected.
- In `attachInFlightUsageTracker`, the inner `onDispatchError` handler copies the event's `storyId` and `stage` onto every ended
  entry that matches the event by scope (`matchesScope`) and has no `storyId` of its own, whether or not the
  event recorded spend. A later `toPartialCostEvent` for that entry therefore carries the story. The existing
  clear-on-recorded-spend rule (rule 6) is unchanged.

### Integration (extends existing code)

Read-only (verified at `b6f494593`):

- `loadLatestReview(outputDir, prNumber, headSha): Promise<BotReviewArtifact | null>` (`bot/fix-input.ts`)
- `BotFixEnv.review: BotReviewArtifact` (`bot/fix-steps.ts`); `AgreedItem` (`bot/post.ts`), finding variant
  `severity: WorkflowSeverity` (`"critical" | "important" | "minor"`)
- `runBotFixCycle(cycleInput, deps)` (`bot/fix-cycle.ts`) — fix, then post-push review, then ready-only fix
- `reviewBuildSteps(checks: BotChecks): PreRunStepConfig[]` (`bot/checks.ts`)
- `fixProtectedPaths(files)` (`bot/path-policy.ts`)
- `packageOverrideKey(packageDir)` (`runtime/packages.ts`)
- `Logger.warnOnce(stage, message, data?, discriminator?)` (`logger/logger.ts`)
- `NAX_VERSION`, `NAX_COMMIT` (`src/version.ts`)
- `placeholdersOf(spec)` (`nax-agent/src/tools/run-command.ts`, module-private; its consumer `createRunCommandTool` is in the same file)

New exported symbols (in existing files; no new files): `withNoColorEnv(env, strippedVars)` in
`quality/runner.ts` (US-006), `warnScopedTestCommand(conf, warn)` in `config/config-guards.ts` (US-006),
`COST_RECONCILE_EPSILON_USD` in `execution/run-cost-reconcile.ts` (US-004), the optional `codeReview` field
on `BotFixEnv` and the `{ codeOnly }` option of `loadLatestReview` (US-001), and the `--ready-only` option on
`nax bot fix` (US-001).

Changed (the baseline only locates the code; implement the target):

- `readyStep` — Baseline: holds only on head mismatch, head gates, workflow items and CI. Target: also holds
  after this execution's own push, and on an open critical/important finding in `env.review.agreed`.
- `BotReviewArtifact.quality` — Baseline: `PrReviewVerdict["quality"]`. Target:
  `PrReviewVerdict["quality"] | "not-reviewed"`; same widening on the `posted` `BotReviewResult`.
- `restoreIgnoreRules(ctx, failures)` — Baseline: removes every added `.gitignore`. Target: keeps an added one
  inside an ignored directory, unreported.
- `ReviewerTreeGuard.restoreEntry` — Baseline: one `reviewer-tree-reverted` event carrying refs and stash.
  Target: `reviewer-tree-reverted` for reverted state only, `reviewer-refs-left` for refs and stash.
- `buildBotPrFixPrompt(input)` — Target: fix mode carries the protected-path rule.
- `initialFixState(env, outputDir, input)` — Target: runs the build steps after install in a fresh checkout.
- `terminalPoll(poll)` — Target: a finished failure's detail is `poll.failureDetail` when present.
- `resolve(packageDir)` in `createPackageRegistry` — Target: no warning for an empty override key.
- `warnOrDefer(stage, message)` — Target: `warnOnce` when the logger is initialized.
- `loadLatestReview(outputDir, prNumber, headSha)` — Target: optional fourth argument `{ codeOnly?: boolean }`.
- `botFixCommand(options, deps)` / `BotFixOptions` — Target: `readyOnly?: boolean` from `--ready-only`.
- `reconcileRunCost(totalCost, costAggregator)` — Target: warns only above `COST_RECONCILE_EPSILON_USD`.
- `runCommandInputSchema(keys, exec)` and `declaredInputProperties(keys)` — Baseline: take the key list.
  Target: `runCommandInputSchema(keys, exec, takesFiles: boolean)` and
  `declaredInputProperties(keys, takesFiles: boolean)`; the only caller is `createRunCommandTool`.
- `runQualityCommand(opts)` — Target: the spawn env also carries `NO_COLOR`/`FORCE_COLOR` via `withNoColorEnv`.
- `sandboxSentence(network, sharedTmp, platform)` — Target: non-shared temp phrase names `/tmp`.
- `failingTestRectification(findings, story, opts)` — Target: `run-test` region only for a `{{files}}` template.
- `postProcess(output)` of `createRtkInterceptor` — Target: neutral marker in place of the hint.
- `CostEvent` (`runtime/cost-aggregator.ts`) — Target: optional `naxVersion`, `naxCommit`.
- `onDispatchError` in `in-flight-usage.ts` — Target: copies `storyId`/`stage` onto matching ended entries.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| Fix build step exits non-zero (`PRE_RUN_FAILED`) | warn `Fix build step failed`, continue the fix |
| Fix build step throws anything else | propagate, as the install step does |
| `git check-ignore` for an added `.gitignore`'s directory exits other than 0 or 1 | the file is removed and returned, as today (fail toward restoring) |
| `env.review.agreed` holds only minor findings, threads or comments | no hold |
| Caller env already sets `NO_COLOR` or `FORCE_COLOR` | kept as set |

## Out of Scope

- Fetching failed CI job logs (`gh run view --log-failed`, `glab ci trace`) and repairing from them; a red CI only names its failing checks.
- Naming failing checks for GitLab pipelines; GitLab keeps "a check failed".
- Restoring branches, tags or stash entries a reviewer moved; ruling R15 stands, they are only reported.
- The 136 tool-audit sessions with zero recorded calls; no root cause is known yet.
- A distinct error code for a session that hit its time or step limit; the dispatch error row keeps today's `errorCode`.
- `naxVersion` / `naxCommit` in prompt-audit and tool-audit headers; cost rows and the `run.start` log line identify the build.
- Building workspace packages when the project declares no root `build` gate; adding one is a project config change.
- Wrapping user-authored command strings with rtk (ruling R10).
- A per-package `testScoped` warning from `.nax/mono/<pkg>/config.json`; the warning reads the loaded root config.

## Stories

### US-001 — the bot readies only a reviewed head with no open critical or important finding

Workdir: packages/nax. No dependencies.

Add the two `readyStep` holds (reading the latest code review of the head), the `--ready-only` CLI flag, and
the `"not-reviewed"` quality for a conversation-only review (artifact, `posted` result, summary line).

### US-002 — the reviewer guard keeps tool `.gitignore` files in ignored directories and reports refs apart

Workdir: packages/nax. No dependencies.

Reorder `restoreIgnoreRules` to reset known ignore files first and keep added ones inside ignored directories;
split the guard's log into `reviewer-tree-reverted` and `reviewer-refs-left`.

### US-003 — bot fix states protected paths, builds its checkout, and names failing CI checks

Workdir: packages/nax. No dependencies.

Add the protected-path rule to the fix-mode prompt, run `reviewBuildSteps` in `initialFixState`, and return
`failureDetail` from `terminalPoll`.

### US-004 — worktree-root resolves, repeated config warnings and float-noise cost deltas stay quiet

Workdir: packages/nax. No dependencies.

Skip the hydrate warning for an empty override key, route initialized `warnOrDefer` through `warnOnce`, and add
`COST_RECONCILE_EPSILON_USD` to `reconcileRunCost`.

### US-005 — RunCommand describes values from the declared placeholders; Bash names $TMPDIR over /tmp

Workdir: packages/nax-agent. No dependencies.

Pass `takesFiles` from `createRunCommandTool` into the `values` description, and name `/tmp` in the
non-shared temp phrase.

### US-006 — rectifier test regions follow the template, testScoped is checked at load, declared commands run without colour, rtk leaves a neutral marker

Workdir: packages/nax. No dependencies.

Gate the `run-test` region on `{{files}}`, add `warnScopedTestCommand` to the loader, add `withNoColorEnv` to
`runQualityCommand`, and replace the rtk hint with the neutral marker.

### US-007 — cost rows carry the nax build and partial rows carry their story

Workdir: packages/nax. No dependencies.

Add `naxVersion`/`naxCommit` to every cost row and copy `storyId`/`stage` from a matching dispatch error onto
in-flight entries.

### Context Files

**US-001**
- `packages/nax/src/bot/fix-report.ts` — `readyStep`, `workflowReadyHold`.
- `packages/nax/src/bot/fix-steps.ts` — `BotFixEnv`, `BotFixState`.
- `packages/nax/src/bot/post.ts` — `BotReviewArtifact`, `persistArtifact`, `postSummary`.
- `packages/nax/src/bot/review-run.ts` — `BotReviewResult`, the posted result.
- `packages/nax/src/bot/fix-input.ts` — `loadLatestReview`.
- `packages/nax/src/cli/bot.ts` — `botFixCommand`, the `nax bot fix` options.

**US-002**
- `packages/nax/src/review/reviewer-guard/snapshot-ignore-rules.ts` — `restoreIgnoreRules`.
- `packages/nax/src/review/reviewer-guard/guard.ts` — `restoreEntry`.
- `packages/nax/src/review/reviewer-guard/snapshot.ts` — the restore report.
- `packages/nax/src/review/reviewer-guard/deps.ts` — `git`, `gitRaw`.

**US-003**
- `packages/nax/src/prompts/builders/bot-pr-fix-builder.ts` — `buildBotPrFixPrompt`.
- `packages/nax/src/bot/fix-run.ts` — `initialFixState`, `_botFixDeps`.
- `packages/nax/src/bot/checks.ts` — `reviewBuildSteps`.
- `packages/nax/src/workflow/ci-wait.ts` — `terminalPoll`, `classifyGh`.
- `packages/nax/src/bot/path-policy.ts` — `fixProtectedPaths`, the protected path classes.

**US-004**
- `packages/nax/src/runtime/packages.ts` — `createPackageRegistry`, `packageOverrideKey`.
- `packages/nax/src/logger/logger.ts` — `warnOrDefer`, `warnOnce`.
- `packages/nax/src/execution/run-cost-reconcile.ts` — `reconcileRunCost`.

**US-005**
- `packages/nax-agent/src/tools/run-command-surface.ts` — `runCommandInputSchema`, `declaredInputProperties`.
- `packages/nax-agent/src/tools/run-command.ts` — `createRunCommandTool`, `placeholdersOf`.
- `packages/nax-agent/src/sandbox/messages.ts` — `sandboxSentence`, `tempRootsPhrase`.

**US-006**
- `packages/nax/src/prompts/builders/rectifier-builder-helpers.ts` — `failingTestRectification`.
- `packages/nax/src/config/config-guards.ts` — `warnQualityCommandChains`, home of `warnScopedTestCommand`.
- `packages/nax/src/config/loader.ts` — the warn call sites.
- `packages/nax/src/execution/interceptors/rtk/index.ts` — `RTK_HINT_LINE`, `postProcess`.
- `packages/nax/src/quality/runner.ts` — `runQualityCommand`, home of `withNoColorEnv`.

**US-007**
- `packages/nax/src/runtime/middleware/cost.ts` — `attachCostSubscriber` row builders.
- `packages/nax/src/runtime/in-flight-usage.ts` — `onDispatchError`, `toPartialCostEvent`.
- `packages/nax/src/runtime/cost-aggregator.ts` — `CostEvent`.
- `packages/nax/src/chat/chat-ledger.ts` — the chat ledger row.
- `packages/nax/src/version.ts` — `NAX_VERSION`, `NAX_COMMIT`.

### Creates

**US-001**
None.

**US-002**
None.

**US-003**
None.

**US-004**
None.

**US-005**
None.

**US-006**
None.

**US-007**
None.

### Modifies

**US-001**
- `packages/nax/test/integration/bot/fix-graph.test.ts` — a fix that pushes no longer ends with `markedReady: true`; assert the `readyHeld` text naming the pushed head instead, and give a ready-path fixture review an `agreed` list with no critical or important finding where the test is about another hold.
- `packages/nax/test/integration/bot/fix-report.test.ts` — a fix that pushes no longer ends with `markedReady: true`; assert the `readyHeld` text naming the pushed head instead, and give a ready-path fixture review an `agreed` list with no critical or important finding where the test is about another hold.
- `packages/nax/test/integration/bot/fix-report-workflow.test.ts` — a fix that pushes no longer ends with `markedReady: true`; assert the `readyHeld` text naming the pushed head instead, and give a ready-path fixture review an `agreed` list with no critical or important finding where the test is about another hold.
- `packages/nax/test/integration/bot/fix-ready-coverage.test.ts` — a fix that pushes no longer ends with `markedReady: true`; assert the `readyHeld` text naming the pushed head instead, and give a ready-path fixture review an `agreed` list with no critical or important finding where the test is about another hold.
- `packages/nax/test/integration/bot/fix-report-head-gates.test.ts` — a fix that pushes no longer ends with `markedReady: true`; assert the `readyHeld` text naming the pushed head instead, and give a ready-path fixture review an `agreed` list with no critical or important finding where the test is about another hold.
- `packages/nax/test/integration/bot/fix-run.test.ts` — a fix that pushes no longer ends with `markedReady: true`; assert the `readyHeld` text naming the pushed head instead, and give a ready-path fixture review an `agreed` list with no critical or important finding where the test is about another hold.
- `packages/nax/test/unit/bot/fix-report.test.ts` — `readyStep` called with `pushedSha` and a head that reached it now returns the pushed-head hold before reading rulings; the expected call order becomes `["head"]` and the patch is the pushed-head `readyHeld`.
- `packages/nax/test/integration/bot/fix-ready-only.test.ts` — a ready-only fixture review whose `agreed` holds a critical or important finding now holds; empty that `agreed` list where the test is about another outcome.

**US-002**
- `packages/nax/test/unit/review/reviewer-guard/guard.test.ts` — refs and stash differences are now logged under `reviewer-refs-left`, and a `reviewer-tree-reverted` event no longer carries `refsLeft`/`stashLeft` when only refs moved; update the event-name and field assertions to match.
- `packages/nax/test/unit/review/reviewer-guard/snapshot.test.ts` — an added `.gitignore` inside a directory the snapshot rules ignore is no longer removed or listed in `paths`; an assertion that such a file is deleted becomes an assertion that it is kept and unreported.

**US-003**
None. The fix prompt tests assert with substring checks, and the CI-wait tests that pin `"a check failed"` stub `waitForChecks` rather than running `terminalPoll`.

**US-004**
- `packages/nax/test/unit/logger/warn-or-defer.test.ts` — "AC-4: initialized warnings log immediately, including repetitions" now expects one `warn` call for two identical initialized `warnOrDefer("config", "m")` calls, since repeats go through `warnOnce`; rename the test to match.
- `packages/nax/test/unit/runtime/packages.test.ts` — the before-hydrate warning test must resolve a real package directory; a worktree root under the reserved worktree directory no longer warns.

**US-005**
None. The tests that pin the temp phrase use `toContain("this run's temp directory ($TMPDIR)")`, which the extended phrase still contains, and no test pins the `values` description text.

**US-006**
- `packages/nax/test/unit/execution/interceptors/rtk.test.ts` — a trailing rtk hint is now replaced by the neutral marker instead of removed: `"diff body\n[full diff: rtk git diff --no-compact]"` now yields `"diff body\n[output compacted]"`, `"body\n[+12 hidden: rtk recall 3f9c2a81d4e7]"` yields `"body\n[output compacted: 12 lines hidden]"`, and `"body\n[full output: rtk recall 3f9c2a81d4e7]"` yields `"body\n[output compacted]"`; the not-contain `rtk recall` checks still hold.
- `packages/nax/test/unit/tools/git-interception-rtk.test.ts` — the Git tool's output after a trailing `[full diff: rtk git diff --no-compact]` hint is now `"body\n[output compacted]"` instead of `"body"`; update the expected content.
- `packages/nax/test/unit/tools/bash-intercept.test.ts` — "US-003 AC10" feeds `"out\n[full output: rtk recall 12]"`; the framed content is now `"exit 0\nout\n[output compacted]\n"` instead of `"exit 0\nout\n"`.

**US-007**
None. Cost-row tests assert with `toMatchObject` or on named fields, and the two new fields are optional.

### Seams

- US-001 relies on `runBotFixCycle` (unchanged) to review the pushed head and run the ready-only pass. The
  pushed-head hold is proven through the real fix graph by US-001 AC8 (`runBotFix` with stubbed session,
  gates, push and forge); AC15 drives `runBotFixCycle` with stubbed fix and review only to pin that the cycle's
  ready-only result, not the pushing fix, carries `markedReady: true`.
- US-005's `takesFiles` flag is computed and consumed inside `createRunCommandTool` (same story).
- US-006's `warnScopedTestCommand` is new and exported from `config/config-guards.ts`; its consumer is
  `loadConfig` in the same story (seam AC US-006 #8).
- No other story consumes a symbol another story creates.

## Acceptance Criteria

### US-001

1. [integration] `readyStep` for a draft PR, with `state.pushedSha` `"abc1234def"`, `state.readyOnly` unset and `waitForPrHead` stubbed to resolve `true`, returns `markedReady: false` and a `readyHeld` that starts with `"pushed abc1234; a bot review of the pushed head decides readiness"`.
2. [integration] In the same case, the stubbed forge `run` is never called with the mark-ready argv.
3. [integration] `readyStep` with `state.readyOnly` `true`, a draft PR, green CI, and `env.review.agreed` holding one finding with key `"f-1"` and severity `"important"` returns `markedReady: false` and a `readyHeld` that includes `"1 open critical/important finding(s)"` and `"f-1"`.
4. [integration] `readyStep` with `state.readyOnly` `true` and `env.review.agreed` holding one finding with severity `"critical"` returns `markedReady: false`.
5. [integration] `readyStep` with `state.readyOnly` `true`, a draft non-workflow PR, green CI, and `env.review.agreed` holding only a finding with severity `"minor"` and one item of kind `"thread"` calls the mark-ready argv and returns `markedReady: true`.
6. [integration] `readyStep` with `state.readyOnly` `true` and `env.review.agreed` holding 7 important findings returns a `readyHeld` that lists the first 5 keys followed by `", +2 more"`.
7. [integration] `readyStep` with `state.readyOnly` `true`, an important finding in `env.review.agreed`, and a PR that is not a draft returns `markedReady: false` with the open-finding `readyHeld`, not a bare `markedReady: false`.
8. [integration] `runBotFix` (not ready-only) on a draft PR, with the fix session, gates and push stubbed so the push step yields `pushedSha` `"abc1234def"` and `waitForPrHead` resolving `true`, returns `markedReady` not `true` and a `readyHeld` that starts with `"pushed abc1234"`.
9. [integration] `runBotFix` with `readyOnly: true`, where the newest bot review of the head has scope `"conversation-only"` and an empty `agreed`, and an older review of the same head has scope `"full"` and an important finding `"f-9"`, returns `markedReady: false` and a `readyHeld` that includes `"f-9"`.
10. [unit] `loadLatestReview` with `{ codeOnly: true }` over two artifacts of one head, the newer with scope `"conversation-only"`, returns the older artifact.
11. [unit] `loadLatestReview` without the option over the same two artifacts returns the newer artifact.
12. [integration] `botFixCommand` with `readyOnly: true` calls `runBotFix` once with `readyOnly: true` and never calls `runBotFixCycle`.
13. [integration] `botFixCommand` with `readyOnly: true` and `runBotFix` returning `outcome: "ready-pass"`, `markedReady: false` and a `readyHeld` exits 0 and logs the `readyHeld` text.
14. [integration] `botFixCommand` with `rereview: false` and the cycle's fix returning `outcome: "pushed"` calls `runBotFixCycle` with `rereview: false`, and the fix it reports carries no `markedReady: true`.
15. [integration] `runBotFixCycle` with the fix stub returning `outcome: "pushed"` and `pushedSha` `"abc1234def"`, the review stub returning `outcome: "posted"`, and the ready-only fix stub returning `markedReady: true` returns a result whose `fix.markedReady` is not `true` and whose `ready.markedReady` is `true`.
16. [integration] `runBotReview` for a review whose scope is `"conversation-only"` and whose verdict quality is `"approved"` writes a `bot-review.json` whose `quality` is `"not-reviewed"`.
17. [integration] In the same case, the returned `posted` result's `quality` is `"not-reviewed"`.
18. [integration] `runBotReview` for a review whose scope is `"full"` and whose verdict quality is `"approved"` writes a `bot-review.json` whose `quality` is `"approved"`.
19. [unit] `renderReviewSummary` with `quality: "not-reviewed"` and scope `"conversation-only"` returns a summary line that includes `"quality not-reviewed"`.

### US-002

1. [integration] In a temporary git repository whose root `.gitignore` ignores `.venv/`, a reviewer turn that creates `.venv/.gitignore` leaves `.venv/.gitignore` on disk after `restoreRepoSnapshot`.
2. [integration] In the same case, the restore report's `paths` does not include `.venv/.gitignore`.
3. [integration] In a temporary git repository, a reviewer turn that creates `sub/.gitignore` holding `*` in a directory the snapshot rules do not ignore removes `sub/.gitignore` and lists it in `paths`.
4. [integration] In a temporary git repository, a reviewer turn that appends `planted*` to the root `.gitignore` and also creates `.venv/.gitignore` restores the root `.gitignore` to its snapshot content and leaves `.venv/.gitignore` in place, with `planted*` files still reverted.
5. [integration] In a temporary git repository whose root `.gitignore` ignores `.venv/`, with `_snapshotDeps.git` wrapped so a `check-ignore` call exits 128, a reviewer turn that creates `.venv/.gitignore` removes it and lists it in `paths`.
6. [integration] In a temporary git repository, a reviewer turn that edits the known root `.gitignore` still lists `.gitignore` in `paths` after the restore.
7. [unit] `ReviewerTreeGuard.afterTurn` with the restore stub reporting only `refsLeft: ["moved refs/heads/x"]` logs a warning `reviewer-refs-left` carrying that `refsLeft` value and logs no `reviewer-tree-reverted`.
8. [unit] `ReviewerTreeGuard.afterTurn` with the restore stub reporting only `stashLeft: ["added abc"]` logs `reviewer-refs-left` carrying that `stashLeft` value.
9. [unit] `ReviewerTreeGuard.afterTurn` with the restore stub reporting `paths: ["a.ts"]` and empty `refsLeft` and `stashLeft` logs `reviewer-tree-reverted` with `paths` `["a.ts"]` and logs no `reviewer-refs-left`.
10. [unit] `ReviewerTreeGuard.afterTurn` with the restore stub reporting nothing logs neither event.

### US-003

1. [unit] `buildBotPrFixPrompt` with `mode: "fix"` returns text that states files under `.nax/`, `.github/` and `.gitlab/` can never be changed by the fix.
2. [unit] In the same case, the text tells the agent to leave an item that needs such a file unchanged and name it in `"concerns"` with status `DONE_WITH_CONCERNS`.
3. [unit] `buildBotPrFixPrompt` with `mode: "repair"`, and again with `mode: "prepare"`, returns text without the protected-path rule.
4. [integration] `runBotFix` on a fresh (not in-place) checkout whose checks declare a `build` gate `"bun run build"` calls the stubbed `_botFixDeps.runPreRunSteps` a second time, after the install call, with a step whose `command` is `"bun run build"` and with the checkout worktree as `workdir`.
5. [integration] `runBotFix` on an in-place checkout with the same `build` gate calls `runPreRunSteps` once (install only).
6. [integration] `runBotFix` with `readyOnly: true` never calls `runPreRunSteps`.
7. [integration] `runBotFix` whose build call throws `NaxError` code `PRE_RUN_FAILED` with context `command: "bun run build"` logs the warning `Fix build step failed` with `command` `"bun run build"` and still runs the fix session.
8. [integration] `runBotFix` whose build call throws a plain `Error` rejects with that error.
9. [integration] `waitForChecks` for a GitHub PR whose stubbed `gh pr checks` output reports check `lint` with bucket `fail` and every other check passed returns `outcome: "failed"` and a `detail` that includes `"lint"`.

### US-004

1. [unit] A package registry created for repo root `/repo`, before `hydrate`, resolving `/repo/.nax-wt/bot-pr-7` returns the root view and logs no warning.
2. [unit] The same registry, before `hydrate`, resolving `/repo/packages/lib` still logs the `resolve() called for non-root package before hydrate()` warning.
3. [unit] With an initialized logger, calling `warnOrDefer("config", "x removed")` twice writes one warning entry with message `"x removed"`.
4. [unit] With an initialized logger, `warnOrDefer("config", "a")` then `warnOrDefer("config", "b")` writes two warning entries.
5. [integration] With an initialized logger, two `loadConfig` calls on a project config holding a removed key write that key's removal warning once.
6. [unit] `reconcileRunCost(1.0000000000000002, aggregator)` with the aggregator total `1` logs no `cost-reconcile` warning and returns `1.0000000000000002`.
7. [unit] `reconcileRunCost(1.5, aggregator)` with the aggregator total `1` logs the `cost-reconcile` warning and returns `1.5`.

### US-005

1. [unit] The `inputSchema` of `createRunCommandTool` for declared commands `{ test: "bun test", testScoped: "bun test {{files}}" }` has a `values` description that includes `{ files: "a.test.ts" }`.
2. [unit] The `inputSchema` of `createRunCommandTool` for declared commands `{ test: "npx turbo test", testScoped: "npx turbo test --filter=[HEAD^1]" }` has a `values` description equal to `"None of the declared commands take placeholders: omit values."`.
3. [unit] In the second case, the `command` enum is still `["test", "testScoped"]`.
4. [unit] The `inputSchema` of `createRunCommandTool` for declared commands `{ check: ["tsc --noEmit", "bun test {{files}}"] }` has a `values` description that includes `{ files: "a.test.ts" }`.
5. [unit] `sandboxSentence("open", false)` returns text that includes `"this run's temp directory ($TMPDIR) rather than /tmp, which is not writable"`.
6. [unit] `sandboxSentence("open", true)` returns text that includes `"the system temp directories"` and does not include `"rather than /tmp"`.

### US-006

1. [unit] `failingTestRectification` with `testScopedTemplate` `"bun test {{files}}"`, `fileScopeCommandName` `"testScoped"` and one failing finding in `a.test.ts` returns text holding a `run-test` region whose spec has `files` `"a.test.ts"`.
2. [unit] `failingTestRectification` with `testScopedTemplate` `"npx turbo test --filter=[HEAD^1]"`, `fileScopeCommandName` `"testScoped"` and failing findings in `a.test.ts` and `b.test.ts` returns text with no `run-test` region.
3. [unit] In the second case, the per-failing-file block holds exactly one line, wrapped in a `run-check` region whose spec is `{ "command": "testScoped" }`.
4. [unit] `warnScopedTestCommand` given `quality.commands.testScoped` `"npx turbo test --filter=[HEAD^1]"` calls `warn` once with a message that includes `"declares no {{files}} placeholder"`.
5. [unit] `warnScopedTestCommand` given `test` `"pytest -q"` and `testScoped` `"pytest -q"` calls `warn` with a message that includes `"equals quality.commands.test"`.
6. [unit] `warnScopedTestCommand` given `testScoped` `["tsc --noEmit", "bun test {{files}}"]` does not call `warn`.
7. [unit] `warnScopedTestCommand` given a config with no `quality.commands.testScoped` does not call `warn`.
8. [integration] `loadConfig` on a project whose `.nax/config.json` declares `quality.commands.testScoped` `"npx turbo test --filter=[HEAD^1]"` logs a warning that includes `"declares no {{files}} placeholder"`.
9. [integration] `runQualityCommand` with `_qualityRunnerDeps.spawn` stubbed and a process env that sets neither colour variable spawns with an env whose `NO_COLOR` is `"1"` and whose `FORCE_COLOR` is `"0"`.
10. [integration] `runQualityCommand` with a process env holding `FORCE_COLOR` `"1"` spawns with `FORCE_COLOR` `"1"`.
11. [integration] `runQualityCommand` with `stripEnvVars: ["NO_COLOR"]` spawns with an env that has no `NO_COLOR` key.
12. [integration] `runQualityCommand` with the `env` option `{ NO_COLOR: "" }` spawns with `NO_COLOR` `""`.
13. [unit] The rtk interceptor's `postProcess` given `"ok\n[+12 hidden: rtk recall abc]"` returns an object whose `output` is `"ok\n[output compacted: 12 lines hidden]"`.
14. [unit] `postProcess` given `"diff\n[full diff: rtk git diff --no-compact]"` returns an object whose `output` is `"diff\n[output compacted]"`.
15. [unit] `postProcess` given `"out\n[full output: rtk recall abc]"` returns an object whose `output` is `"out\n[output compacted]"`.
16. [unit] `postProcess` given `"plain output  \n"` returns an object whose `output` is `"plain output  \n"`, unchanged.

### US-007

1. [integration] A cost subscriber attached to a runtime, given a successful dispatch event, appends a cost row whose `naxVersion` equals `NAX_VERSION` and whose `naxCommit` equals `NAX_COMMIT`.
2. [integration] The same subscriber, given a dispatch error event, appends an error cost row carrying the same `naxVersion` and `naxCommit`.
3. [unit] `toPartialCostEvent` for a residual returns a row whose `naxVersion` equals `NAX_VERSION` and whose `naxCommit` equals `NAX_COMMIT`.
4. [unit] The chat ledger's cost row carries `naxVersion` and `naxCommit`.
5. [unit] An in-flight usage tracker that saw a round-trip usage update and a `cancelled` call end for stream `c1` with `scopeId` `"s1"` and no `storyId`, then a dispatch error event with `scopeId` `"s1"`, `storyId` `"US-003"`, `stage` `"run"` and no token usage, returns a residual for `c1` whose `storyId` is `"US-003"` and whose `stage` is `"run"`.
6. [unit] In the same case, `toPartialCostEvent` for that residual returns a row whose `storyId` is `"US-003"`.
7. [unit] A tracker whose ended entry already has `storyId` `"US-001"`, given a matching dispatch error event with `storyId` `"US-003"`, keeps `storyId` `"US-001"` on the residual.
8. [unit] A tracker given a dispatch error event whose `scopeId` matches no ended entry leaves every residual's `storyId` unchanged.
9. [unit] A tracker given a matching dispatch error event that recorded positive `estimatedCostUsd` returns no residual for that stream, as before.
