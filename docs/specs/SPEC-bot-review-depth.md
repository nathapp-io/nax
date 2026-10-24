<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Bot review depth and prompt audit

Closes: #2682, #2683

## Summary

`nax bot review` checks only the lines a PR changes, never reads the PR's test changes, and approves without
searching for other callers of the code it changed. This spec makes the bot review the full code check it has to
be on a PR nax did not build. The prompt gains a "Beyond the diff" section (other callers, sibling sites, existing
solutions to the same problem) and a "Tests" section (read the test changes, check what each test asserts, run it
scoped). The green-CI wording stops implying that the new tests are verified. A reply-task line names the steps
required before an approval. The coverage retry now also requires the changed test files. Separately, `nax bot
review` and `nax bot fix` pass a feature name to `createRuntime`, so they write a prompt audit. `createRuntime`
warns when prompt audit is enabled but cannot run.

## Motivation

Verified on `main` @ `ecea2c0b4`:

- **#2682.** On PR #2680 (27 files, 2 HIGH + 6 MEDIUM fixes), `nax bot review` approved twice with 0 findings,
  each run in one agent turn of about 22 s and three shell calls (`git diff --stat`, `git diff -- packages/*/src`,
  one grep). An independent review found two verified mediums: a third caller of `loadConfigForWorkdir` in
  `parallel-batch-phases.ts:129` still reloaded without the pin, and the bounded hook drain lost all output on the
  deadline. Both sit just outside the diff.
- **The cause is the review split, not only wording.** On a nax-built PR, the story review reads and runs each
  story's tests, and the branch review checks "callers and callees agree" and reachability. The bot review then
  only handles the conversation. On any other PR, the bot review is the whole code check. The review-split spec
  (`SPEC-workflow-pr-rulings-review-split.md` US-015) gave the bot three branch-review pieces:
  `WORKFLOW_QUALITY_CHECKLIST`, `WORKFLOW_ENUMERATION_INSTRUCTION` and the coverage retry. It did not give it the
  branch remit's callers/reachability lines or anything from the story layer.
- **Tests are never required reading.** `reviewRequiredFiles` (`src/workflow/review-coverage.ts`) drops test files,
  because the branch review relies on the story reviews having read them (`SPEC-workflow-review-depth.md`). The
  bot review calls the same function with no story layer underneath, so reading only `src/` satisfies coverage.
  Every range the bot reviews lacks a story review: a non-workflow PR, the commits after a workflow PR's reviewed
  head, or a full re-review.
- **Green CI reads as "tests verified".** `ciSection` says the build, lint and test checks that passed "are
  verified: do not list them in cannotVerify". Green CI shows only that the existing suite passes. It cannot show
  that a new test would fail without the fix, or that every affected site was fixed.
- **The bot can verify when pointed at the right place.** After a human thread named the missed site, the next
  bot run opened `parallel-batch-phases.ts:115-145` straight away (tool audit `bot-pr-2680`, run `193d1f39`). The
  gap is where it looks, not what it can do.
- **#2683.** `runBotReview` (`src/bot/review-run.ts`, `reviewCheckout`) and `runBotFix` (`src/bot/fix-run.ts`,
  `fixCheckout`) call `deps.createRuntime(config, repoRoot)` with no options. `createRuntime`
  (`src/runtime/index.ts`) builds a real `PromptAuditor` only when `opts.featureName` is set and otherwise falls
  back to `createNoOpPromptAuditor()` silently. The id `bot-pr-<n>` already reaches the agent call and the tool
  audit through `src/workflow/pr-step-context.ts` (`featureName: label`). Only `createRuntime` misses it. The
  native agent already archives full transcripts (`agent.transcriptAudit`), so the gap hurts ACP runs most: they
  leave no nax-side record of the prompt.

## Design

### Approach

1. **Prompt audit for bot runs (#2683).** `reviewCheckout` calls
   `deps.createRuntime(config, repoRoot, { featureName: \`bot-pr-${ref.number}\` })`; `fixCheckout` does the same.
   In `createRuntime`, the branch that falls back to the no-op auditor logs one warning when
   `config.agent?.promptAudit?.enabled` is true and neither `opts.featureName` nor `opts.promptAuditor` is set:
   `getSafeLogger()?.warn("runtime", "Prompt audit is enabled but no feature name was given; prompts will not be audited", { workdir })`.
   It is one call per `createRuntime` call. No other behaviour of `createRuntime` changes.
2. **"Beyond the diff" section (#2682 A).** A new exported constant `WORKFLOW_BEYOND_DIFF_SECTION` in
   `src/prompts/builders/workflow-quality-checklist.ts`, re-exported from `src/prompts/index.ts`. It lives in the
   shared checklist module so the two review engines draw review text from one place; only the bot prompt embeds
   it in this spec. Its exact text:

   ```
   ## Beyond the diff
   A change is correct only if the code it did not touch still agrees with it. For every function, type, config key or contract the diff changes, and for every defect the PR description says it fixes:
   - Search the repository for the other callers of each changed or wrapped function, and for other sites with the same pattern, including files the diff does not touch. A fix applied at some sites but not at others is a finding: quote the missed site.
   - Check that callers and callees still agree, and that every new piece is reachable from where it is meant to be used.
   - If the repository already solves the same problem elsewhere, for example in a helper or a sibling module the PR also changes, compare the new code with that solution and report where it is weaker.
   - List the files you opened outside the diff in inspectedFiles.
   ```

3. **"Tests" section (#2682 B).** A bot-only section built in `src/prompts/builders/bot-pr-review-builder.ts`.
   Text when `staticMode` is false:

   ```
   ## Tests
   Read the test changes, not only the source. For each behaviour the PR changes and each defect it says it fixes:
   - Name the test that covers it, and check that the test asserts the outcome the change promises (the returned value or the data kept), not only that the call returns or how long it took.
   - Run that test file with the project's test command, scoped to the file. If you cannot run it, list it in cannotVerify as "not run: <test file>: <reason>".
   A changed behaviour with no test that would fail without the change is a finding.
   ```

   When `staticMode` is true, the same text without the `- Run that test file ...` bullet (a static review has no
   shell tool).
4. **Placement.** When `conversationOnly` is not true, `projectSections` emits, in order: `CHECKLIST`,
   `WORKFLOW_QUALITY_CHECKLIST`, `WORKFLOW_ENUMERATION_INSTRUCTION`, `WORKFLOW_BEYOND_DIFF_SECTION`, the Tests
   section, then the existing optional sections (earlier-findings note, project checks, checkout state, CI,
   settled rulings, decisions). A conversation-only prompt gets neither new section.
5. **Green CI wording (#2682 C).** `ciSection` gains the `conversationOnly` flag. The green verdict becomes:

   ```
   Every CI check reported on this exact head passed; a skipped check counts as passed. The checks are listed below. Where they include the project's build, lint or test suite, treat those that ran and passed as proof that the existing suite passes: do not list them in "cannotVerify". CI does not show that the new or changed tests would fail without the change, or that every affected site was fixed.
   ```

   When `conversationOnly` is not true, the sentence ` The Tests and Beyond the diff sections still apply.` is
   appended to that paragraph. The red and no-result verdicts and the fenced detail are unchanged.
6. **Approval line (#2682 D).** When `conversationOnly` is not true, `## Your task` gains one line directly after
   `Review whether the code fulfills the stated intent and assess its quality. List every file you inspected in inspectedFiles.`:

   ```
   Before you answer "approved", read every changed test file and search outside the diff as "Beyond the diff" asks; name any step you skipped in cannotVerify.
   ```

   A conversation-only `## Your task` is byte-for-byte unchanged. The reply JSON schema is unchanged.
7. **Test files are required reading (#2682 B, enforced in code).** `reviewRequiredFiles` gains an optional third
   parameter `options?: { readonly keepTests?: boolean }`. With `keepTests: true` it does not resolve test
   patterns and keeps every path except the documentation, lockfile and image/document basenames it already drops.
   Without the option the function behaves as today. `runPrReview` (`src/bot/review-step.ts`) calls it with
   `{ keepTests: true }`; `runBranchReview` (`src/workflow/branch-review.ts`) keeps calling it without options.
   The existing coverage retry in `botPrReviewOp` / `botPrStaticReviewOp` then asks the reviewer to read any
   changed test file it skipped, and `unreadFiles` reports it when it still does not.

### Integration

Symbols this spec only reads (verified on `ecea2c0b4`):

- `src/workflow/pr-step-context.ts` — `buildPrStepContext`, which sets `featureName: \`bot-pr-${input.pr.number}\``
  on `callCtx` and on the dispatch wiring.
- `src/runtime/index.ts` — `CreateRuntimeOptions.featureName?: string`, `CreateRuntimeOptions.promptAuditor?`.
- `src/runtime/prompt-auditor.ts` — `PromptAuditor`, `createNoOpPromptAuditor`.
- `src/logger/logger.ts` — `getSafeLogger(): Logger | null`.
- `src/operations/bot-pr-review.ts` — `botPrReviewOp`, `botPrStaticReviewOp`, `reviewRetry` (coverage retry
  through `unreadFiles` and `buildWorkflowBranchCoverageRetry`).
- `src/operations/workflow-review-coverage.ts` — `unreadFiles(required, inspected, repoRoot)`.
- `src/prompts/builders/workflow-branch-builder.ts` — `buildWorkflowBranchReviewPrompt` (its prompt must not
  change).

Symbols this spec changes. The baseline only locates the code; it is never the interface to implement.

- `reviewCheckout` in `src/bot/review-run.ts`
  - Baseline: `const runtime = deps.createRuntime(config, repoRoot);`
  - Target: `const runtime = deps.createRuntime(config, repoRoot, { featureName: \`bot-pr-${ref.number}\` });`
- `fixCheckout` in `src/bot/fix-run.ts`
  - Baseline: `const runtime = deps.createRuntime(config, repoRoot);`
  - Target: `const runtime = deps.createRuntime(config, repoRoot, { featureName: \`bot-pr-${ref.number}\` });`
- `createRuntime` in `src/runtime/index.ts`
  - Baseline: the `else` branch assigns `createNoOpPromptAuditor()` with no log.
  - Target: the same assignment, plus the warning in Approach 1 when `auditEnabled` is true (that branch is reached
    only when `opts?.promptAuditor` is unset and `opts?.featureName` is falsy).
- `reviewRequiredFiles` in `src/workflow/review-coverage.ts`
  - Baseline: `reviewRequiredFiles(paths, fc): Promise<string[]>`
  - Target: `reviewRequiredFiles(paths, fc, options?: { readonly keepTests?: boolean }): Promise<string[]>`
- `runPrReview` in `src/bot/review-step.ts`
  - Baseline: `requiredFiles = await reviewRequiredFiles(paths, ctx);`
  - Target: `requiredFiles = await reviewRequiredFiles(paths, ctx, { keepTests: true });`
- `projectSections`, `ciSection`, `buildBotPrReviewPrompt` and the `## Your task` text in
  `src/prompts/builders/bot-pr-review-builder.ts`: target per Approach 3-6. `BotPrReviewPromptInput` is unchanged.
- `src/prompts/builders/workflow-quality-checklist.ts` gains `export const WORKFLOW_BEYOND_DIFF_SECTION: string`;
  `src/prompts/index.ts` re-exports it beside `WORKFLOW_QUALITY_CHECKLIST`.

### Failure Handling

| Failure | Behaviour |
|---|---|
| Prompt audit enabled, `createRuntime` given neither `featureName` nor `promptAuditor` | No-op auditor as today, plus the one `warn` from Approach 1; the runtime is still returned |
| No logger initialised when that warning fires | `getSafeLogger()` returns `null`; nothing is logged and `createRuntime` does not throw |
| The reviewer still skips a changed test file after the coverage retry | Verdict kept as today; the file is in `unreadFiles`, which the review summary already lists as not read |

## Out of Scope

- The workflow branch review is unchanged: its prompt does not embed `WORKFLOW_BEYOND_DIFF_SECTION` or the Tests section, and its coverage still drops test files, because the story reviews read them.
- `WORKFLOW_ENUMERATION_INSTRUCTION` and `WORKFLOW_QUALITY_CHECKLIST` are unchanged; both engines share them.
- No code guard turns an "approved" verdict into "changes" when a changed test file stays unread after the coverage retry; the summary's not-read list is the only signal.
- The bot reply schema does not gain an `observed` verbatim-excerpt field for critical or important findings.
- The bot review's session role stays `wf-branch-review`; renaming it is a separate change.
- Host-agent built-in tools that are not in the op's declared tools (the ACP claude agent's `ReportFindings`) are not blocked here.
- The `nax bot fix` prompt is unchanged.
- The `## Project checks` section text ("Prefer running them") is unchanged; the Tests section carries the scoped-run instruction.
- No new cost limit is added; the existing `bot.costLimit` bounds the extra searches and scoped test runs.
- ACP agents do not gain a transcript audit; the prompt audit is the shared record.
- No `createRuntime` caller other than `nax bot review` and `nax bot fix` gains a feature name; `nax setup` with prompt audit enabled now logs the new warning, which is intended.
- The replay of `nax bot review` on #2680's head `bf181cd` (about 3 runs, counting how many report `parallel-batch-phases.ts:129` or the hook-drain output loss) is a manual check after merge, not a test.

## Stories

Three stories in `packages/nax`, no dependencies between them. US-001 is #2683; US-002 and US-003 are #2682 (prompt,
then the coverage rule that enforces part of it in code).

### US-001: Bot runs write a prompt audit
No dependencies. Workdir: packages/nax.

`reviewCheckout` and `fixCheckout` pass `{ featureName: \`bot-pr-${ref.number}\` }` to `createRuntime`;
`createRuntime` warns when prompt audit is enabled with neither a feature name nor an auditor.

### US-002: Bot review prompt reaches beyond the diff and into the tests
No dependencies. Workdir: packages/nax.

Adds `WORKFLOW_BEYOND_DIFF_SECTION` to the shared checklist module and the barrel, adds the Tests section, the
green-CI wording and the approval line to the bot prompt, all omitted from conversation-only prompts.

### US-003: Bot review coverage requires the changed test files
No dependencies. Workdir: packages/nax.

Adds the `keepTests` option to `reviewRequiredFiles` and passes it from `runPrReview`.

### Context Files

**US-001**
- `packages/nax/src/bot/review-run.ts` — `reviewCheckout`, `_botReviewDeps` usage
- `packages/nax/src/bot/fix-run.ts` — `fixCheckout`, `_botFixDeps`
- `packages/nax/src/runtime/index.ts` — `createRuntime`, `CreateRuntimeOptions`, the prompt auditor branch
- `packages/nax/test/helpers/bot-review.ts` — review deps helper (`createRuntime: () => runtime`)
- `packages/nax/test/helpers/bot-fix.ts` — fix deps helper (`createRuntime: () => runtime`)

**US-002**
- `packages/nax/src/prompts/builders/bot-pr-review-builder.ts` — `projectSections`, `ciSection`, `REPLY_TASK`, `buildBotPrReviewPrompt`
- `packages/nax/src/prompts/builders/workflow-quality-checklist.ts` — shared checklist constants
- `packages/nax/src/prompts/index.ts` — barrel exporting the checklist constants
- `packages/nax/src/bot/review-step.ts` — `runPrReview`, which builds the prompt and calls the op
- `packages/nax/test/unit/prompts/bot-pr-review-builder.test.ts` — existing prompt cases and the `base` fixture

**US-003**
- `packages/nax/src/workflow/review-coverage.ts` — `reviewRequiredFiles`, `isNonSource`
- `packages/nax/src/bot/review-step.ts` — `runPrReview`, `_reviewStepDeps`
- `packages/nax/src/workflow/branch-review.ts` — the branch review's `reviewRequiredFiles` call, which must not change
- `packages/nax/test/unit/workflow/review-coverage.test.ts` — existing classification cases
- `packages/nax/test/unit/bot/review-step.test.ts` — existing `runPrReview` coverage cases

### Creates

**US-001**
- `packages/nax/test/unit/bot/bot-prompt-audit.test.ts`
- `packages/nax/test/unit/runtime/prompt-audit-warn.test.ts`

**US-002**
- `packages/nax/test/unit/prompts/bot-pr-review-depth.test.ts`

**US-003**
- `packages/nax/test/unit/workflow/review-coverage-keep-tests.test.ts`

### Modifies

US-001 changes no existing test: createRuntime keeps returning the same runtime, the bot deps helpers stub createRuntime with a function that ignores its arguments, and no existing test asserts the arguments the bot passes to createRuntime or that no warning is logged.

**US-002**
- `packages/nax/test/unit/prompts/bot-pr-review-builder.test.ts` — two tests change. (1) "US-014 AC-9 preserves checklist items 1-5 and the entire task/JSON contract verbatim" builds the non-conversation `base` prompt and pins the whole `## Your task` slice; the expected slice gains the line `Before you answer "approved", read every changed test file and search outside the diff as "Beyond the diff" asks; name any step you skipped in cannotVerify.` directly after the line `Review whether the code fulfills the stated intent and assess its quality. List every file you inspected in inspectedFiles.`. Every other line of the slice, and the checklist items 1-5 assertion, stay unchanged. (2) "green CI claims only what CI reported, and lets the check names decide coverage" expects `only those that ran and passed are verified: do not list them in "cannotVerify"`; that expectation becomes `treat those that ran and passed as proof that the existing suite passes: do not list them in "cannotVerify"`. The test's other expectations (the heading line, the fenced detail, no "full checks already passed") stay unchanged.

**US-003**
- `packages/nax/test/unit/bot/review-step.test.ts` — "US-015 AC-6/9 classifies changed paths and reports unread files" (both `staticMode` values) expects requiredFiles and unreadFiles to be the two paths pkg/main.go and settings.json, with the test file pkg/main_test.go dropped; the bot review now keeps test files, so both become the three paths pkg/main.go, pkg/main_test.go and settings.json, in that order. README.md stays dropped, and the `repoRoot` and `range` expectations are unchanged.

### Seams

None across stories: each story's new symbol is consumed in the same story (`WORKFLOW_BEYOND_DIFF_SECTION` by the bot
prompt builder in US-002, `keepTests` by `runPrReview` in US-003). US-002 and US-003 each pin their wiring at
`runPrReview`; US-001 pins it at `runBotReview` and `runBotFix`.

## Acceptance Criteria

### US-001

1. [integration] `runBotReview` on PR number 42, driven with the bot review deps helper and a `_botReviewDeps.createRuntime` mock, calls `createRuntime` with a third argument equal to `{ featureName: "bot-pr-42" }`.
2. [integration] `runBotFix` on PR number 42, driven with the bot fix deps helper and a `_botFixDeps.createRuntime` mock, calls `createRuntime` with a third argument equal to `{ featureName: "bot-pr-42" }`.
3. [unit] `createRuntime` with `agent.promptAudit.enabled` true and no options logs exactly one `warn` with stage `"runtime"` and message `"Prompt audit is enabled but no feature name was given; prompts will not be audited"`.
4. [unit] The warning logged by `createRuntime` with `agent.promptAudit.enabled` true and no options carries `{ workdir }` as its data, where `workdir` is the second argument given to `createRuntime`.
5. [unit] `createRuntime` with `agent.promptAudit.enabled` true and `{ featureName: "bot-pr-42" }` logs no warning with that message.
6. [unit] `createRuntime` with `agent.promptAudit.enabled` true, a supplied `promptAuditor` and no `featureName` logs no warning with that message.
7. [unit] `createRuntime` with `agent.promptAudit.enabled` false and no options logs no warning with that message.
8. [unit] `createRuntime` with `agent.promptAudit.enabled` true and no options, when `getSafeLogger()` returns `null`, returns a runtime whose `promptAuditor` is the no-op auditor and does not throw.

### US-002

1. [unit] `WORKFLOW_BEYOND_DIFF_SECTION`, imported from `@/prompts`, is a string equal to the "Beyond the diff" text in Design Approach 2.
2. [unit] `buildBotPrReviewPrompt` with `staticMode` false and `conversationOnly` unset returns a prompt containing `WORKFLOW_BEYOND_DIFF_SECTION` after `WORKFLOW_ENUMERATION_INSTRUCTION` and before `## Untrusted content`.
3. [unit] `buildBotPrReviewPrompt` with `staticMode` true and `conversationOnly` unset returns a prompt containing `WORKFLOW_BEYOND_DIFF_SECTION`.
4. [unit] `buildBotPrReviewPrompt` with `staticMode` false and `conversationOnly` unset returns a prompt containing the non-static Tests section text from Design Approach 3, after `WORKFLOW_BEYOND_DIFF_SECTION` and before `## Untrusted content`.
5. [unit] `buildBotPrReviewPrompt` with `staticMode` true and `conversationOnly` unset returns a prompt whose `## Tests` section contains the "Name the test that covers it" bullet and the closing sentence `A changed behaviour with no test that would fail without the change is a finding.`, and omits the `Run that test file` bullet.
6. [unit] `buildBotPrReviewPrompt` with `conversationOnly` true returns a prompt containing neither `## Beyond the diff` nor `## Tests`, for `staticMode` false and for `staticMode` true.
7. [unit] `buildBotPrReviewPrompt` with `ci` `{ outcome: "green", detail }` and `conversationOnly` unset returns a prompt containing the green verdict from Design Approach 5 followed by ` The Tests and Beyond the diff sections still apply.`.
8. [unit] `buildBotPrReviewPrompt` with `ci` `{ outcome: "green", detail }` returns a prompt that omits the old sentence `only those that ran and passed are verified`.
9. [unit] `buildBotPrReviewPrompt` with `ci` `{ outcome: "green", detail }` and `conversationOnly` true returns a prompt containing `CI does not show that the new or changed tests would fail without the change, or that every affected site was fixed.` and not containing `The Tests and Beyond the diff sections still apply.`.
10. [unit] `buildBotPrReviewPrompt` with `conversationOnly` unset returns a `## Your task` section whose second line is `Before you answer "approved", read every changed test file and search outside the diff as "Beyond the diff" asks; name any step you skipped in cannotVerify.`.
11. [unit] `buildBotPrReviewPrompt` with `conversationOnly` true returns a `## Your task` section without the `Before you answer "approved"` line, identical to the task text before this change.
12. [unit] `buildWorkflowBranchReviewPrompt` with any valid input returns a prompt that contains neither `WORKFLOW_BEYOND_DIFF_SECTION` nor `## Tests`.
13. [integration] `runPrReview` with `conversationOnly` unset and `_workflowDeps.callOp` scripted to return a valid verdict sends the op an input whose `prompt` contains `## Beyond the diff` and `## Tests`.

### US-003

1. [unit] `reviewRequiredFiles(["pkg/main.go", "pkg/main_test.go"], fc, { keepTests: true })`, where the package `pkg` resolves test patterns matching `_test.go`, returns `["pkg/main.go", "pkg/main_test.go"]`.
2. [unit] `reviewRequiredFiles(["README.md", "bun.lock", "logo.png", "src/a.ts"], fc, { keepTests: true })` returns `["src/a.ts"]`.
3. [unit] `reviewRequiredFiles` with `{ keepTests: true }` never calls `_workflowDeps.resolveTestPatterns`.
4. [unit] `reviewRequiredFiles(["pkg/main.go", "pkg/main_test.go"], fc)` with no options, where `pkg` resolves test patterns matching `_test.go`, returns `["pkg/main.go"]`.
5. [unit] `reviewRequiredFiles(["pkg/main.go", "pkg/main_test.go"], fc, { keepTests: false })`, where `pkg` resolves test patterns matching `_test.go`, returns `["pkg/main.go"]`.
6. [integration] `runPrReview` with `staticMode` false, a review package listing `pkg/main.go`, `pkg/main_test.go`, `README.md` and `settings.json`, and test patterns matching `_test.go`, calls the op with `requiredFiles` equal to `["pkg/main.go", "pkg/main_test.go", "settings.json"]`.
7. [integration] `runPrReview` with `staticMode` true, a review package listing `pkg/main.go`, `pkg/main_test.go`, `README.md` and `settings.json`, and test patterns matching `_test.go`, calls the op with `requiredFiles` equal to `["pkg/main.go", "pkg/main_test.go", "settings.json"]`.
8. [integration] `runPrReview` with a review package listing `pkg/main.go`, `pkg/main_test.go`, `README.md` and `settings.json`, test patterns matching `_test.go`, and a verdict whose `inspectedFiles` names `pkg/main.go` and `settings.json` but not `pkg/main_test.go` returns `unreadFiles` equal to `["pkg/main_test.go"]`.
