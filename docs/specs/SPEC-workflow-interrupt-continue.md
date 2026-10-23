# SPEC: Workflow interrupt continue, report check and story report listing

Closes: #2668

## Summary

In workflow mode, an implementer turn cut off by its step limit goes straight to the gates and the story review with no commit and no `report.md`. The review then fails on the missing report, and a fix round writes it after the fact. This spec makes the story loop recover the turn instead, and closes the two gaps that let a missing report turn into a false finding:

- **Continue on interrupt.** When an implementer turn (implement, restart, advisor answer or fix round) hits its step limit, nax sends a continue turn on the same warm session. The continue turn says how long the turn ran and which files changed, and it ends with the normal finish steps. It gets `workflow.interruptRetry.maxAttempts` tries (default 1) at `budgetMultiplier` (default 0.5) of the limit that was hit. Only when the tries are spent does nax fall back: it auto-commits the dirty tree and tells the story reviewer that the implementer was interrupted.
- **Report check before review.** On each evaluate pass whose gates are green, before the story review or re-review step, nax checks that the story's `report.md` exists. If it is missing after a DONE or DONE_WITH_CONCERNS reply, nax asks the warm session once, in a short report-only turn, to write it.
- **Story report listing.** The branch-review prompt lists every story's report path and says outright which stories have none. A deferred minor or cannot-verify item that claims a listed report is missing is to be left, not repeated.
- **Glob sees `.nax/`.** The agent Glob in both runtimes lists files under `.nax/` when the pattern's first segment is literally `.nax`. Every other dot path stays hidden (ruling D21 stands).

## Motivation

Verified on `main` @ `f4b92f3b4`.

- **Interrupt goes to review unfinished.** `softInterruptTurn` (`src/operations/_interrupt.ts`) soft-interrupts a write turn at `workflow.timeouts.implementMs` / `fixMs` and returns `WORKFLOW_INTERRUPT_MARKER`. It never rethrows, and the agent call's own timeout is the step limit plus `STEP_TIMEOUT_MARGIN_MS` (60 s), so pipeline's `fail-timeout` retry (`agent.timeoutRetry`) never fires in workflow mode. `parseImplementerReply` maps the marker to `DONE_WITH_CONCERNS: "step time limit reached"`; `runImplementerTurn` (`src/workflow/implement.ts:115`) returns it without the auto-commit a normal turn gets; and `absorbTurn` (`src/workflow/story-steps.ts:177`) records the concern and moves on. Nothing tells the still-warm session it was cut off. In #2668 (an 11-story run, US-005), the implementer ran 60 minutes, the review diff showed no commits, review failed on `report.md` ENOENT, and fix round 1 spent 6 minutes committing the work and reconstructing the TDD evidence.
- **Nobody checks the report.** No nax code checks `report.md` before review; the story reviewer discovers its absence, which costs a spec fail and a fix round. This also happens when an implementer simply forgets the report.
- **The branch reviewer cannot find the reports.** `buildWorkflowBranchReviewPrompt` is given only the feature report, so the reviewer searched with `Glob .nax/features/<f>/**/*report*`, which returned no matches although 12 reports existed, and recorded a false cannot-verify. A stale story-level "report could not be read" minor fed the same claim.
- **Agent Glob is blind to `.nax/`.** Ruling D21 (2026-10-03) hides every dot path from agent Glob, including explicitly named ones, in both `nodeGlob` (`nax-agent/src/runtime/node-glob.ts`) and `bunAgentRuntime.glob` (`nax/src/agent-runtime/bun-runtime.ts`). nax's own artifacts (briefs, reports, the ledger) live under `.nax/`, so an agent can Read them but never find them.

User rulings 2026-10-23 (issue comment and this brainstorm):
- on a step-limit interrupt, continue on the warm session; never end the implementer mid-task with DONE_WITH_CONCERNS while a try is left;
- one continue try at half the limit by default; fall back to auto-commit plus telling the reviewer only when the tries are spent; the same rule for fix turns;
- a recovered interrupt is a ledger note only, never a concern the reviewer sees;
- the report check runs for every story, not only interrupted ones;
- the branch reviewer gets the report paths in its prompt (no new subcommand or agent tool);
- the Glob fix is in this bundle, as a narrow exception to D21 for a literal `.nax` first segment only;
- the bundle ships as one feature (recorded as the one-capability confirmation for 9 stories).

## Design

### Approach

1. **Config (`src/config/schemas-workflow.ts`).**
   - `workflow.interruptRetry`: `{ maxAttempts: int >= 0, default 1; budgetMultiplier: number > 0 and <= 1, default 0.5 }`, a nested object with `.prefault({})`. `maxAttempts: 0` turns the continue off.
   - `workflow.timeouts.reportMs`: positive int, default `600_000` (10 minutes).
   - `WorkflowConfig` (`src/config/runtime-types-workflow.ts`) gains the matching fields; `FIELD_DESCRIPTIONS` (`src/cli/config-descriptions.ts`) gains `workflow.interruptRetry`, `workflow.interruptRetry.maxAttempts`, `workflow.interruptRetry.budgetMultiplier` and `workflow.timeouts.reportMs`. `docs/guides/workflow-mode.md` (config table plus a short "Step limits" paragraph) and `docs/guides/configuration.md` document them.
2. **Prompts (`src/prompts/builders/workflow-implementer-builder.ts`, exported through `src/prompts/index.ts`).**
   - `buildWorkflowContinuePrompt(input: { storyId: string; reportPath: string; limitMinutes: number; budgetMinutes: number; attempt: number; maxAttempts: number; changedFiles?: readonly string[] }): string`. Text, in order:
     - `You were stopped at the <limitMinutes>-minute step limit before you finished story <storyId>. This is continue attempt <attempt> of <maxAttempts>; you have up to <budgetMinutes> minutes.`
     - the changed files: `Files changed since the story base:` and one `- <path>` line each; or `No files have changed since the story base.` for `[]`; or `The changed-file list could not be read; check git status yourself.` when `changedFiles` is undefined;
     - `Continue from where you stopped. Do not revert, delete or redo work that is already on disk.`
     - `When you are done, commit your work, write <reportPath>, and end your reply with the json status block. If you cannot finish in this turn, commit what you have, write the report marking each unfinished acceptance criterion, and reply DONE_WITH_CONCERNS.`
     - `WORKFLOW_REPLY_CONTRACT`, last.
     It does not resend the brief: the warm session already holds it.
   - `buildWorkflowReportPrompt(input: { storyId: string; reportPath: string }): string`. Text: `Your report for story <storyId> is missing: <reportPath> does not exist. Write it now for the work you already did, with the sections the implement prompt listed: What was built, TDD evidence, Files changed, Decisions & assumptions. Report only evidence you captured; for an acceptance criterion whose failing run you did not capture, say so under Decisions & assumptions. Do not change any other file.` then `WORKFLOW_ARTIFACTS_RULE` and `WORKFLOW_REPLY_CONTRACT`, last.
3. **Turns (`src/workflow/implement.ts`).**
   - `ImplementTurn` gains two kinds:
     - `{ kind: "continue"; limit: "implement" | "fix"; stepUps: number; attempt: number; maxAttempts: number; changedFiles?: readonly string[] }`;
     - `{ kind: "report"; stepUps: number }`.
   - `runImplementerTurn` timeouts: `continue` = `Math.floor(limitMs * workflow.interruptRetry.budgetMultiplier)`, where `limitMs` is `timeouts.implementMs` for `limit: "implement"` and `timeouts.fixMs` for `limit: "fix"`; `report` = `timeouts.reportMs`. Neither kind closes the session first (`closesSessionFirst` stays false for them). Both run on `implementerModelFor(sc, turn)`, so a continue keeps its origin's step-up.
   - `promptFor`: `continue` renders `buildWorkflowContinuePrompt` with `limitMinutes = Math.max(1, Math.round(limitMs / 60_000))`, `budgetMinutes = Math.round(continueTimeoutMs / 60_000)` and the turn's fields; `report` renders `buildWorkflowReportPrompt`.
   - An interrupted turn of any kind still returns without auto-committing (unchanged).
   - New export `autoCommitTurnEdits(sc: StepContext): Promise<boolean>`: reads the dirty list through the existing fail-open `dirtyAfterTurn` and, when it is non-empty, calls `_workflowDeps.autoCommitIfDirty(sc.projectDir, "workflow", "wf-implementer", sc.story.id, undefined, sc.dryRun)` and returns `true`; otherwise `false`. A throw from `autoCommitIfDirty` is caught, logged with `getSafeLogger()?.warn("workflow", "<message>", { storyId: sc.story.id, error: errorMessage(err) })` (`check:logger-storyid` requires the `storyId`), and returns `false`. `runImplementerTurn`'s own auto-commit goes through it.
   - `budgetMinutes` in the continue prompt is at least 1 (`Math.max(1, Math.round(continueTimeoutMs / 60_000))`).
4. **Steps and wiring (`src/workflow/story-loop.ts`, `src/workflow/stage-env.ts`, `src/workflow/no-work.ts`).**
   - `StoryLoopSteps` gains three optional steps, each absent in a caller that has not wired it:
     - `workSinceBase?(): Promise<string[]>`: the files changed since the story base, committed or not;
     - `autoCommitDirty?(): Promise<boolean>`: the fallback auto-commit;
     - `reportExists?(): Promise<boolean>`: whether the story's `report.md` exists.
   - `StoryLoopEnv` gains `readonly interrupt?: { readonly maxAttempts: number; readonly implementMs: number; readonly fixMs: number }`. Absent reads as `WORKFLOW_DEFAULTS` (`maxAttempts` 1, both limits 3,600,000).
   - `no-work.ts` exports `storyChangedFiles(sc: StepContext): Promise<string[]>`: the union of `changedFilesSince(sc.projectDir, sc.base)` and `listUncommitted(sc.projectDir)`, deduplicated, in that order, with nax-owned paths (`isNaxOwned`) removed. It throws on a git error, like `storyWorkEvidence`.
   - `buildStoryEnv` wires `workSinceBase: () => storyChangedFiles(sc)`, `autoCommitDirty: () => autoCommitTurnEdits(sc)`, `reportExists: () => Bun.file(sc.reportPath).exists()`, and `interrupt` from `workflow.interruptRetry.maxAttempts`, `workflow.timeouts.implementMs` and `workflow.timeouts.fixMs`.
   - `turnLabel` (`src/workflow/story-steps.ts`; `story-loop.ts` only re-exports it): `continue` -> `"implementer continue"`, `report` -> `"implementer report"`.
5. **Continue on interrupt (new `src/workflow/interrupt-continue.ts`, called from `absorbTurn`).**
   - Signature: `continueAfterInterrupt(env: StoryLoopEnv, outcome: ImplementOutcome, origin: { stepUps: number; limit: "implement" | "fix" }, used: number, runTurn: (turn: ImplementTurn) => Promise<ImplementOutcome>): Promise<{ outcome: ImplementOutcome; used: number; fallback: boolean }>`. It is pure orchestration over `env`, like the rest of the loop, and is injected with `runTurn` to avoid an import cycle with `story-steps.ts` (the `runNoWorkLadder` pattern).
   - `absorbTurn` hands every outcome to one helper in the same module, `absorbInterrupt(env, current, origin, used, runTurn): Promise<{ outcome: ImplementOutcome; used: number; fallback: boolean }>`, which calls `continueAfterInterrupt` only when the outcome has no `failure` and `reply.interrupted` is true and otherwise returns the outcome unchanged. It runs before the auto-commit note and the advisor-answer check, and `absorbTurn` keeps `used` across its whole call. `absorbTurn` scores 18 against `check:complexity`'s limit of 20 today, so its loop body gains no new branch: the interrupt test lives in `absorbInterrupt`, and setting `lastTurn` (US-008) goes through a small helper too. So the tries are counted per absorbed turn: the first implement turn (with its no-work restarts and answers) or one fix round.
   - While `used < maxAttempts` and the outcome is interrupted:
     - cost limit reached (`env.steps.costExceeded()`): ledger note `implementer interrupted at the step limit (<limitMinutes> min): continue skipped, cost limit reached`, and stop trying;
     - otherwise: ledger note `implementer interrupted at the step limit (<limitMinutes> min): continuing on the warm session (attempt <n> of <maxAttempts>)`; read `changedFiles` from `env.steps.workSinceBase` (absent or throwing -> `undefined`); run `{ kind: "continue", limit: origin.limit, stepUps: origin.stepUps, attempt: n, maxAttempts, changedFiles }`; `used += 1`.
     `limitMinutes` is `Math.max(1, Math.round(limitMs / 60_000))`, with `limitMs` from `env.interrupt` (`implementMs` for `origin.limit: "implement"`, `fixMs` for `"fix"`).
   - The first outcome that is not interrupted (including a `failure`) goes back to `absorbTurn` and is absorbed exactly as today: a DONE reply records no concern; NEEDS_CONTEXT or BLOCKED gets an advisor answer; a failure records `implementer session failed: <failure>`.
   - **Fallback**, when the outcome is still interrupted after the loop: call `env.steps.autoCommitDirty` (absent -> skipped, read as `false`); when it returns `true`, ledger note `auto-committed the implementer's uncommitted edits`. The outcome goes back with its reply's `concerns` replaced (a spread, not a mutation) and `fallback: true`. The concern is `stopped at the step limit after <used> continue attempt(s); its uncommitted edits were auto-committed, and it may not have finished the story or written report.md` when the auto-commit returned `true`, and `stopped at the step limit after <used> continue attempt(s); nothing was auto-committed, and it may not have finished the story or written report.md` otherwise. `absorbTurn` then records it through the existing `recordConcern`, so the story reviewer's concerns and the ledger line `implementer (interrupted) DONE_WITH_CONCERNS: <that text>` both carry it.
   - A recovered interrupt writes only the "continuing" note: no concern and no `(interrupted)` line.
6. **Report check (new `src/workflow/report-check.ts`, called from `evaluate`).**
   - `StoryLoopState` gains `reportTurnRan: boolean` (initial `false`) and `lastTurn?: { status: ImplementerStatus; fallback: boolean; stepUps: number }` (initial `undefined`; a resumed story starts without one). The `LoopState` class (`story-steps.ts`) gains both fields and copies them in its constructor; `initialStoryState` sets them.
   - `absorbTurn` sets `lastTurn` from the reply it finally absorbs, with the `stepUps` of the turn that produced it (`origin.stepUps`). When it returns early on a `failure` or with no reply, it clears `lastTurn` to `undefined`.
   - `implementStep` and `fixStep` return `lastTurn` in their patches; `evaluateStep` returns `reportTurnRan`. The step-graph engine refuses an undeclared patch key (`STEP_GRAPH_UNDECLARED_OUTPUT`, `src/step-graph/run.ts`), so `STORY_GRAPH` (`src/workflow/story-graph.ts`) adds `lastTurn` to the `implement` and `fix` nodes' `produces` and `reportTurnRan` to the `evaluate` node's.
   - `report-check.ts` exports `runReportCheck(env: StoryLoopEnv, state: { reportTurnRan: boolean; lastTurn?: StoryLoopState["lastTurn"] }, runTurn: (turn: ImplementTurn) => Promise<ImplementOutcome>): Promise<boolean>`, which returns the new `reportTurnRan`. `runTurn` is injected (the `runNoWorkLadder` pattern) to avoid an import cycle with `story-steps.ts`.
   - In `evaluate`, after the gates come back not red and before `review`, nax runs the report turn when all of these hold:
     - `reportTurnRan` is false (at most one report turn per story);
     - `lastTurn` is set, its `status` is `DONE` or `DONE_WITH_CONCERNS`, and `fallback` is false;
     - `env.steps.costExceeded()` is false;
     - `env.steps.reportExists` is wired and resolves `false` (a throw reads as present, so no turn).
   - The turn: ledger note `report.md missing after the implementer's reply: asking the session to write it`; run `{ kind: "report", stepUps: lastTurn.stepUps }` through the labelled turn runner, so it runs on the same model, and so the same warm session, as the turn that replied; set `reportTurnRan`. Its outcome is **not** absorbed (no concern, no advisor answer, no session finding). Afterwards, one ledger note: `report turn failed: <failure>` on a failure; else `report turn: report written` when `reportExists` now resolves `true`; else `report turn: report still missing, reviewing without it`. An interrupted report turn gets no continue. Review then runs as today.
7. **Story report listing (branch review).**
   - `BranchReviewPromptInput` gains `storyReports?: readonly { storyId: string; path: string; present: boolean }[]`. When it is non-empty, `buildWorkflowBranchReviewPrompt` adds, right after `## Stories`, a `## Story reports` section: `- <storyId>: <path>` for a present report, `- <storyId>: no report (<path> does not exist)` for a missing one, then the line `A deferred minor or cannot-verify item that says a story's report is missing or unreadable is settled by this list: when the list shows the report, triage that minor "leave" and do not repeat the claim in "cannotVerify".`. Absent or empty: no section (the `nax bot review` prompt is unchanged).
   - The `stories` entries of `BranchReviewPromptInput` gain `runDir?: string`. `reviewFacts` (`src/workflow/feature-steps.ts`) passes each `StorySummary.runDir` through. `feature-steps.ts` is at 597 of the 600 lines `check:file-sizes` allows, so this change must not grow it past 600: use the truthy one-line spread `...(s.runDir ? { runDir: s.runDir } : {})`, which fits Biome's 120-column width, not a `!== undefined` form that Biome wraps onto several lines.
   - `runBranchReview` builds `storyReports` from `input.facts.stories`: each story with a `runDir` maps to `path = join(workflowStoryDir(runDir, id), "report.md")` and `present` from a new `_workflowDeps.fileExists(path)` (default `Bun.file(path).exists()`); a throw reads as present. Stories without `runDir` are not listed.
8. **Glob `.nax` exemption (both runtimes).**
   - Rule: strip leading `./` segments from the pattern. If its first `/`-separated segment is exactly `.nax` (no glob metacharacter, no escape), a result whose **first** result-relative segment is `.nax` is not hidden for that segment. Every other dot segment in the result, including deeper ones under `.nax/`, is still hidden, and a pattern whose first segment is anything else (`**`, `.nax-wt`, `{.nax,src}`) hides `.nax/` as today.
   - `nodeGlob` / `nodeGlobSync` (`nax-agent/src/runtime/node-glob.ts`): `scanOptions`' `exclude` and `filePath`'s result filter both apply the rule, so Node descends into `.nax` only for an exempt pattern.
   - `bunAgentRuntime.glob` / `globSync` (`nax/src/agent-runtime/bun-runtime.ts`): the result filter applies the rule. `dot: false` stays; Bun matches a literal dot segment on its own.
   - The shared `GLOB_CASES` contract (`packages/test-kit/src/cases/glob-cases.ts`) is unchanged and still passes: none of its patterns starts with `.nax`.

### Integration

Read only (verified on `main`):
- `softInterruptTurn(prompt, ctx)` and `WORKFLOW_INTERRUPT_MARKER` — `src/operations/_interrupt.ts`, `src/operations/workflow-replies.ts`
- `ImplementerReply` (`status`, `concerns?`, `interrupted`, `noStatusBlock?`) and `ImplementerStatus` — `src/workflow/types.ts`
- `runNoWorkLadder(env, first, runTurn)` — `src/workflow/no-work.ts` (the injected-runner pattern `continueAfterInterrupt` follows)
- `changedFilesSince(projectDir, base)`, `listUncommitted(projectDir)` — `src/workflow/git.ts`
- `recordConcern(env, s, reply)`, `implementTurn(env, turn)` — `src/workflow/story-steps.ts`
- `workflowStoryDir(runDir, storyId)` — `src/workflow/paths.ts`
- `StorySummary.runDir?` — `src/workflow/types.ts`
- `WORKFLOW_REPLY_CONTRACT`, `WORKFLOW_ARTIFACTS_RULE` — `src/prompts/builders/workflow-implementer-builder.ts`

Changed. The baseline only locates the code; it is never the interface to implement.
- `ImplementTurn` — `src/workflow/implement.ts`
  - Baseline: kinds `implement`, `restart`, `answer`, `fix`.
  - Target: adds `continue` and `report` (Approach 3).
- `runImplementerTurn(sc, turn): Promise<ImplementOutcome>` — `src/workflow/implement.ts`
  - Baseline: `implement`/`restart`/implement-limit `answer` use `implementMs`, the rest `fixMs`; auto-commit inline.
  - Target: `continue` and `report` timeouts per Approach 3; auto-commit through `autoCommitTurnEdits`.
- `StoryLoopSteps` — `src/workflow/story-loop.ts`
  - Target: adds optional `workSinceBase`, `autoCommitDirty`, `reportExists`.
- `StoryLoopEnv` — `src/workflow/story-loop.ts`
  - Target: adds optional `interrupt`.
- `StoryLoopState` — `src/workflow/story-loop.ts`
  - Target: adds `reportTurnRan: boolean` and `lastTurn?`.
- `absorbTurn(env, s, outcome, origin)` — `src/workflow/story-steps.ts`
  - Baseline: an interrupted reply goes straight to `recordConcern`.
  - Target: an interrupted reply first goes through `continueAfterInterrupt`; `lastTurn` is set from the absorbed reply.
- `evaluate(env, s)` — `src/workflow/story-steps.ts`
  - Target: runs the report check between green gates and `review`.
- `BranchReviewPromptInput` — `src/prompts/builders/workflow-branch-builder.ts`
  - Target: adds `storyReports?`; `stories` entries gain `runDir?`.
- `runBranchReview(fc, input)` — `src/workflow/branch-review.ts`
  - Target: builds `storyReports` from `input.facts.stories`.
- `_workflowDeps` — `src/workflow/step-context.ts`
  - Target: adds `fileExists(path: string): Promise<boolean>`.
- `bunAgentRuntime.glob` / `globSync` — `src/agent-runtime/bun-runtime.ts`; `nodeGlob` / `nodeGlobSync` — `packages/nax-agent/src/runtime/node-glob.ts`
  - Baseline: every result with a dot segment is dropped.
  - Target: the `.nax` first-segment exemption (Approach 8).

### Failure Handling

| Case | Behaviour |
|---|---|
| `workSinceBase` throws or is not wired | The continue turn still runs, with `changedFiles` undefined, so its prompt says the list could not be read. |
| A continue turn fails (op throws or returns `failure`) | Absorbed like any failed implementer turn: `implementer session failed: <failure>`; no fallback auto-commit. |
| The cost limit is reached at an interrupt | No continue turn; the "continue skipped" note; then the fallback. |
| `autoCommitDirty` reads no dirty file, cannot read the tree, its commit throws, or it is not wired | No auto-commit note; the fallback concern is still recorded, with the "nothing was auto-committed" wording. |
| An implementer turn fails or returns no reply | `lastTurn` is cleared, so no report turn follows it. |
| `reportExists` throws | Read as present: no report turn. |
| The report turn fails or is interrupted | `report turn failed: <failure>` (failure) or the "still missing"/"written" note; no continue, no concern, no session finding; review runs. |
| The report-file check in `runBranchReview` throws | The story's report is listed as present. |

## Out of Scope

- Pipeline mode's interrupt and timeout handling, including `agent.timeoutRetry`: pipeline mode is frozen.
- Changing `STEP_TIMEOUT_MARGIN_MS` or the soft-interrupt mechanism in `softInterruptTurn`.
- A fresh-session retry or a restart of the story on a step-limit interrupt.
- Continue turns for the branch fix, the branch review, the story review or the re-review: only story implementer turns (implement, restart, answer, fix round) continue.
- Telling the re-review about an interrupt fallback in a fix round: the re-review prompt is unchanged.
- A report turn for a resumed story before any implementer turn has run in this process.
- Rewriting or filtering existing ledger lines or deferred minors: a stale missing-report claim is settled in the branch-review prompt.
- A new `nax` subcommand or agent tool that lists story reports.
- Glob exposure of any dot path other than a literal leading `.nax` segment: ruling D21 stands for `.git`, `.env`, `.nax-wt` and every other hidden path.
- ACP agents' own Glob tools, which nax does not implement.
- Adding the `.nax` exemption cases to the shared `GLOB_CASES` contract in `packages/test-kit`: each runtime pins them in its own test file.


## Stories

Nine stories across two packages. The user ruled to ship #2668's three defects and the Glob exception as one feature.

### US-001: Node glob lists files under a literal `.nax` prefix
No dependencies. Workdir: packages/nax-agent.

`nodeGlob` and `nodeGlobSync` apply the `.nax` first-segment exemption in both the scan exclusion and the result filter.

### US-002: Bun glob lists files under a literal `.nax` prefix
No dependencies. Workdir: packages/nax.

`bunAgentRuntime.glob` and `globSync` apply the `.nax` first-segment exemption in their result filter.

### US-003: Interrupt retry config and the continue and report prompts
No dependencies. Workdir: packages/nax.

Adds `workflow.interruptRetry` and `workflow.timeouts.reportMs` (schema, `WorkflowConfig`, `FIELD_DESCRIPTIONS`, the two guides), and `buildWorkflowContinuePrompt` and `buildWorkflowReportPrompt`, exported from `src/prompts/index.ts`.

### US-004: Continue and report turn kinds
Depends on US-003. Workdir: packages/nax.

Adds the `continue` and `report` kinds to `ImplementTurn`, their timeouts and prompts in `runImplementerTurn`, their `turnLabel` labels, and `autoCommitTurnEdits`, through which `runImplementerTurn`'s own auto-commit now goes.

### US-005: Story-loop steps for interrupts and reports, wired in buildStoryEnv
Depends on US-004. Workdir: packages/nax.

Adds `storyChangedFiles`, the optional `workSinceBase`, `autoCommitDirty` and `reportExists` steps, `StoryLoopEnv.interrupt`, and their wiring in `buildStoryEnv`.

### US-006: The story loop continues an interrupted turn
Depends on US-005. Workdir: packages/nax.

Adds `src/workflow/interrupt-continue.ts` (`continueAfterInterrupt` and the `absorbInterrupt` helper) and calls it from `absorbTurn`: the continue turns, their ledger notes, the cost skip and the attempt count. When the attempts are spent, the reply is recorded as today.

### US-007: Interrupt fallback auto-commits and tells the reviewer
Depends on US-006. Workdir: packages/nax.

When the continue attempts are spent, `continueAfterInterrupt` calls `autoCommitDirty`, writes its note, and replaces the reply's concern with the fallback concern, worded by whether the auto-commit happened.

### US-008: Report check before the story review
Depends on US-007. Workdir: packages/nax.

Adds `src/workflow/report-check.ts` (`runReportCheck`), the `reportTurnRan` and `lastTurn` state (with their `produces` entries in `STORY_GRAPH`), and the report turn between green gates and review.

### US-009: Branch review lists the story reports
No dependencies. Workdir: packages/nax.

Adds `storyReports` to the branch-review prompt, `runDir` to its story facts, `_workflowDeps.fileExists`, and the listing built in `runBranchReview`.

### Context Files

**US-001**
- `packages/nax-agent/src/runtime/node-glob.ts` — `scanOptions`, `filePath`, `nodeGlob`, `nodeGlobSync`
- `packages/nax-agent/test/unit/runtime/node-glob.test.ts` — how the runtime is driven in tests
- `packages/test-kit/src/cases/glob-cases.ts` — the fixture and the D21 cases that must keep passing

**US-002**
- `packages/nax/src/agent-runtime/bun-runtime.ts` — `bunAgentRuntime.glob`, `globSync`
- `packages/nax/test/unit/agent-runtime/glob-runtime.test.ts` — how the runtime is driven in tests
- `packages/test-kit/src/cases/glob-cases.ts` — the fixture and the D21 cases that must keep passing

**US-003**
- `packages/nax/src/config/schemas-workflow.ts` — `WorkflowConfigObjectSchema`, `WORKFLOW_DEFAULTS`
- `packages/nax/src/config/runtime-types-workflow.ts` — `WorkflowConfig`
- `packages/nax/src/cli/config-descriptions.ts` — the `workflow.timeouts.*` entries
- `packages/nax/src/prompts/builders/workflow-implementer-builder.ts` — `WORKFLOW_REPLY_CONTRACT`, `WORKFLOW_ARTIFACTS_RULE`, `buildWorkflowRestartPrompt`
- `packages/nax/test/unit/config/workflow-config.test.ts` — the defaults assertion

**US-004**
- `packages/nax/src/workflow/implement.ts` — `ImplementTurn`, `runImplementerTurn`, `promptFor`, `dirtyAfterTurn`, `implementerModelFor`
- `packages/nax/src/workflow/story-steps.ts` — `turnLabel`
- `packages/nax/test/unit/workflow/implement.test.ts` — the `fakeImplement` and auto-commit test pattern

**US-005**
- `packages/nax/src/workflow/story-loop.ts` — `StoryLoopSteps`, `StoryLoopEnv`
- `packages/nax/src/workflow/stage-env.ts` — `buildStoryEnv`
- `packages/nax/src/workflow/no-work.ts` — `storyWorkEvidence`, `isNaxOwned`
- `packages/nax/src/workflow/implement.ts` — `autoCommitTurnEdits` (from US-004)

**US-006**
- `packages/nax/src/workflow/story-steps.ts` — `absorbTurn`, `recordConcern`, `implementTurn`, `implementStep`, `fixStep`
- `packages/nax/src/workflow/no-work.ts` — `runNoWorkLadder`, the injected-runner pattern
- `packages/nax/src/workflow/story-loop.ts` — `StoryLoopEnv`, `runStoryLoop`
- `packages/nax/test/unit/workflow/story-loop-no-work.test.ts` — the `harness` and `interruptedTurn` fixtures

**US-007**
- `packages/nax/src/workflow/interrupt-continue.ts` — created by US-006, gains the fallback here
- `packages/nax/test/unit/workflow/interrupt-continue.test.ts` — created by US-006, gains the fallback cases here
- `packages/nax/src/workflow/story-steps.ts` — `recordConcern`, `absorbTurn`

**US-008**
- `packages/nax/src/workflow/story-steps.ts` — `evaluate`, `evaluateStep`, `LoopState`, `initialStoryState`, `absorbTurn`
- `packages/nax/src/workflow/story-loop.ts` — `StoryLoopState`
- `packages/nax/src/workflow/story-graph.ts` — the nodes' `produces` lists, `costStop`
- `packages/nax/src/workflow/interrupt-continue.ts` — created by US-006, returns the fallback flag read here
- `packages/nax/test/unit/workflow/story-loop.test.ts` — the step-fake pattern

**US-009**
- `packages/nax/src/prompts/builders/workflow-branch-builder.ts` — `BranchReviewPromptInput`, `buildWorkflowBranchReviewPrompt`
- `packages/nax/src/workflow/branch-review.ts` — `runBranchReview`, `BranchReviewFacts`
- `packages/nax/src/workflow/feature-steps.ts` — `reviewFacts`, `branchReviewStep`
- `packages/nax/test/unit/workflow/branch-review.test.ts` — the `callOp` fake and facts fixture
- `packages/nax/test/unit/prompts/workflow-branch-builder.test.ts` — prompt assertions

### Creates

**US-001**
- `packages/nax-agent/test/unit/runtime/node-glob-nax-dir.test.ts` — the exemption cases for the Node runtime

**US-002**
- `packages/nax/test/unit/agent-runtime/bun-runtime-nax-dir.test.ts` — the exemption cases for the Bun runtime

**US-006**
- `packages/nax/src/workflow/interrupt-continue.ts` — `continueAfterInterrupt`, `absorbInterrupt`
- `packages/nax/test/unit/workflow/interrupt-continue.test.ts` — the continue cases (US-007 adds the fallback cases)

**US-008**
- `packages/nax/src/workflow/report-check.ts` — `runReportCheck`
- `packages/nax/test/unit/workflow/report-check.test.ts` — the report-check cases

### Modifies

**US-003**
- `packages/nax/test/unit/config/workflow-config.test.ts` — the closed-world `toEqual` on the parsed `workflow` defaults must gain `interruptRetry: { maxAttempts: 1, budgetMultiplier: 0.5 }` and `timeouts.reportMs: 600000`; the invariant is that `parse({})` yields every documented workflow default.

**US-007**
- `packages/nax/test/unit/workflow/story-loop-no-work.test.ts` — "AC-21: an interrupted restart ends the ladder and the gates run on the concern" asserts the review concern contains `DONE_WITH_CONCERNS: step time limit reached`. Once the fallback replaces the reply's concern, the interrupted restart (followed by one continue turn, since the harness repeats the interrupted outcome) reaches the review with the fallback concern instead. The replacement invariant: the turns after the warm restart include exactly one `continue` turn, the gates run after it, and the review concern contains `stopped at the step limit after 1 continue attempt(s)`.

**US-008**
- `packages/nax/test/unit/workflow/story-graph.test.ts` — `EXPECTED_PRODUCES` pins each node's `produces` by exact equality; it must gain `lastTurn` for `implement` and `fix` and `reportTurnRan` for `evaluate`. The invariant: every node's `produces` equals exactly the keys its patch can carry.
- `packages/nax/test/integration/workflow/story-e2e.test.ts` — `fakeAgent`'s `workflowImplementOp` branch never writes report.md, so with the real `buildStoryEnv` wiring `reportExists` the report check adds a `report` turn and the `toHaveLength(2)` count of `workflowImplementOp` calls breaks. The fake must write `input.reportPath` on every implementer turn; the invariant is that a story whose implementer writes its report sends no report turn and the original call count holds.
- `packages/nax/test/integration/workflow/advisor-e2e.test.ts` — `fakeWorkflowAgent`'s `workflowImplementOp` branch never writes report.md, so the report check adds a turn and "implementer question: an answered NEEDS_CONTEXT reaches the next implementer turn" sees 3 prompts instead of 2. The fake must write `input.reportPath` on every implementer turn; the invariant is that a story whose implementer writes its report sends no report turn and the existing prompt counts hold.

### Seams

- US-003 -> US-004: `runImplementerTurn` renders `buildWorkflowContinuePrompt` / `buildWorkflowReportPrompt` and reads `workflow.interruptRetry.budgetMultiplier` and `workflow.timeouts.reportMs` (US-004 AC-1, AC-2, AC-4, AC-6, AC-7).
- US-004 -> US-005: `buildStoryEnv` wires `steps.autoCommitDirty` to `autoCommitTurnEdits` (US-005 AC-6).
- US-005 -> US-006: `absorbTurn` sends a `continue` turn and reads `steps.workSinceBase` and `env.interrupt`, which `buildStoryEnv` wires (US-005 AC-3, AC-5; US-006 AC-2, AC-11).
- US-005 -> US-007: the fallback calls `steps.autoCommitDirty` (US-005 AC-6; US-007 AC-1).
- US-005 -> US-008: `evaluate` sends a `report` turn and reads `steps.reportExists` (US-005 AC-4; US-008 AC-1).
- US-007 -> US-008: the fallback flag `continueAfterInterrupt` returns becomes `lastTurn.fallback`, which suppresses the report turn (US-008 AC-6).

## Acceptance Criteria

### US-001

Fixture for every AC: a temporary root holding `.nax/features/f/workflow/r1/US-001/report.md`, `.nax/.hidden/x.md`, `.nax-wt/a.ts`, `.git/HEAD` and `src/a.ts`.

- AC-1 [unit] `nodeRuntime.glob(".nax/features/**/report.md", { cwd: root, absolute: false })` yields exactly `.nax/features/f/workflow/r1/US-001/report.md`.
- AC-2 [unit] `nodeRuntime.globSync(".nax/features/**/report.md", { cwd: root, absolute: false })` yields exactly `.nax/features/f/workflow/r1/US-001/report.md`.
- AC-3 [unit] `nodeRuntime.glob("./.nax/features/**/report.md", …)` yields exactly `./.nax/features/f/workflow/r1/US-001/report.md`.
- AC-4 [unit] `nodeRuntime.glob(".nax/**/*", …)` yields the report path and not `.nax/.hidden/x.md`, because a dot segment below `.nax` stays hidden.
- AC-5 [unit] `nodeRuntime.glob("**/*", …)` yields exactly `src/a.ts`, so a wildcard first segment never reaches `.nax/`.
- AC-6 [unit] `nodeRuntime.glob("**/report.md", …)` yields nothing.
- AC-7 [unit] `nodeRuntime.glob(".nax-wt/**/*", …)` yields nothing.
- AC-8 [unit] `nodeRuntime.glob("{.nax,src}/**/*", …)` yields exactly `src/a.ts`.
- AC-9 [unit] `nodeRuntime.glob(".git/*", …)` yields nothing.
- AC-10 [unit] `nodeRuntime.glob(".nax/features/**/report.md", { cwd: root, absolute: true })` yields exactly the absolute path of the report under `root`.

### US-002

Fixture for every AC: the same temporary root as US-001.

- AC-1 [unit] `bunAgentRuntime.glob(".nax/features/**/report.md", { cwd: root, absolute: false })` yields exactly `.nax/features/f/workflow/r1/US-001/report.md`.
- AC-2 [unit] `bunAgentRuntime.globSync(".nax/features/**/report.md", { cwd: root, absolute: false })` yields exactly `.nax/features/f/workflow/r1/US-001/report.md`.
- AC-3 [unit] `bunAgentRuntime.glob("./.nax/features/**/report.md", …)` yields exactly `./.nax/features/f/workflow/r1/US-001/report.md`.
- AC-4 [unit] `bunAgentRuntime.glob(".nax/**/*", …)` yields the report path and not `.nax/.hidden/x.md`.
- AC-5 [unit] `bunAgentRuntime.glob("**/*", …)` yields exactly `src/a.ts`.
- AC-6 [unit] `bunAgentRuntime.glob(".nax-wt/**/*", …)` yields nothing.
- AC-7 [unit] `bunAgentRuntime.glob("{.nax,src}/**/*", …)` yields exactly `src/a.ts`.
- AC-8 [unit] `bunAgentRuntime.glob(".git/*", …)` yields nothing.
- AC-9 [unit] `bunAgentRuntime.glob(".nax/features/**/report.md", { cwd: root, absolute: true })` yields exactly the absolute path of the report under `root`.

### US-003

- AC-1 [unit] `NaxConfigSchema.parse({})` yields `workflow.interruptRetry` equal to `{ maxAttempts: 1, budgetMultiplier: 0.5 }`.
- AC-2 [unit] `NaxConfigSchema.parse({})` yields `workflow.timeouts.reportMs === 600000`.
- AC-3 [unit] `NaxConfigSchema.safeParse` accepts `workflow.interruptRetry.maxAttempts: 0`.
- AC-4 [unit] `NaxConfigSchema.safeParse` rejects `workflow.interruptRetry.maxAttempts: -1`.
- AC-5 [unit] `NaxConfigSchema.safeParse` rejects `workflow.interruptRetry.maxAttempts: 1.5`.
- AC-6 [unit] `NaxConfigSchema.safeParse` rejects `workflow.interruptRetry.budgetMultiplier: 0`.
- AC-7 [unit] `NaxConfigSchema.safeParse` rejects `workflow.interruptRetry.budgetMultiplier: 1.5`.
- AC-8 [unit] `NaxConfigSchema.safeParse` rejects `workflow.timeouts.reportMs: 0`.
- AC-9 [unit] `buildWorkflowContinuePrompt({ storyId: "US-005", reportPath: "/r/report.md", limitMinutes: 60, budgetMinutes: 30, attempt: 1, maxAttempts: 1, changedFiles: ["src/a.ts"] })` starts with `You were stopped at the 60-minute step limit before you finished story US-005. This is continue attempt 1 of 1; you have up to 30 minutes.`
- AC-10 [unit] With `changedFiles: ["src/a.ts", "test/a.test.ts"]`, `buildWorkflowContinuePrompt` returns text holding `Files changed since the story base:` followed by the lines `- src/a.ts` and `- test/a.test.ts`.
- AC-11 [unit] With `changedFiles: []`, `buildWorkflowContinuePrompt` returns text holding `No files have changed since the story base.`
- AC-12 [unit] With `changedFiles` undefined, `buildWorkflowContinuePrompt` returns text holding `The changed-file list could not be read; check git status yourself.`
- AC-13 [unit] `buildWorkflowContinuePrompt` returns text holding `Do not revert, delete or redo work that is already on disk.`
- AC-14 [unit] `buildWorkflowContinuePrompt` returns text holding `When you are done, commit your work, write /r/report.md, and end your reply with the json status block.`
- AC-15 [unit] `buildWorkflowContinuePrompt` returns text whose last characters are the value of the exported `WORKFLOW_REPLY_CONTRACT` constant.
- AC-16 [unit] `buildWorkflowReportPrompt({ storyId: "US-005", reportPath: "/r/report.md" })` starts with `Your report for story US-005 is missing: /r/report.md does not exist.`
- AC-17 [unit] `buildWorkflowReportPrompt` returns text holding `Do not change any other file.`
- AC-18 [unit] `buildWorkflowReportPrompt` returns text whose last characters are the value of the exported `WORKFLOW_REPLY_CONTRACT` constant, and which holds the value of `WORKFLOW_ARTIFACTS_RULE`.
- AC-19 [unit] `buildWorkflowContinuePrompt` and `buildWorkflowReportPrompt` are importable from `src/prompts/index.ts` and callable as functions returning strings.

### US-004

- AC-1 [unit] `runImplementerTurn` with turn `{ kind: "continue", limit: "implement", stepUps: 0, attempt: 1, maxAttempts: 1 }`, `timeouts.implementMs` 3,600,000 and `interruptRetry.budgetMultiplier` 0.5 passes `timeoutMs: 1800000` to `workflowImplementOp` through `_workflowDeps.callOp`.
- AC-2 [unit] `runImplementerTurn` with a `continue` turn of `limit: "fix"`, `timeouts.fixMs` 1,000,001 and `budgetMultiplier` 0.5 passes `timeoutMs: 500000`.
- AC-3 [unit] `runImplementerTurn` with a `continue` turn never calls `closeImplementerSession` (the session manager's close is not invoked).
- AC-4 [unit] `runImplementerTurn` with turn `{ kind: "continue", limit: "implement", stepUps: 0, attempt: 1, maxAttempts: 1, changedFiles: ["src/a.ts"] }`, `implementMs` 3,600,000 and multiplier 0.5 passes as `prompt` exactly `buildWorkflowContinuePrompt({ storyId, reportPath, limitMinutes: 60, budgetMinutes: 30, attempt: 1, maxAttempts: 1, changedFiles: ["src/a.ts"] })`.
- AC-5 [unit] With a step context whose `tierOrder` holds two tiers, `implementerModelFor` for a `continue` turn with `stepUps: 1` returns a defined model equal to the one it returns for a fix turn with `stepUps: 1`.
- AC-6 [unit] `runImplementerTurn` with turn `{ kind: "report", stepUps: 0 }` and `timeouts.reportMs` 600,000 passes `timeoutMs: 600000`.
- AC-7 [unit] `runImplementerTurn` with a `report` turn passes as `prompt` exactly `buildWorkflowReportPrompt({ storyId, reportPath })`.
- AC-8 [unit] `runImplementerTurn` with a `report` turn never calls `closeImplementerSession`.
- AC-9 [unit] An interrupted reply (`interrupted: true`) to a `continue` turn returns `autoCommitted: false` without calling `autoCommitIfDirty`.
- AC-10 [unit] `autoCommitTurnEdits(sc)` with a dirty tree calls `_workflowDeps.autoCommitIfDirty` with `(sc.projectDir, "workflow", "wf-implementer", sc.story.id, undefined, sc.dryRun)`.
- AC-11 [unit] `autoCommitTurnEdits(sc)` with a dirty tree resolves `true`.
- AC-12 [unit] `autoCommitTurnEdits(sc)` with a clean tree resolves `false` without calling `autoCommitIfDirty`.
- AC-13 [unit] `autoCommitTurnEdits(sc)` when `git status` exits non-zero resolves `false` without calling `autoCommitIfDirty`.
- AC-14 [unit] `autoCommitTurnEdits(sc)` with a dirty tree and `autoCommitIfDirty` rejecting resolves `false`.
- AC-15 [unit] `turnLabel` returns `"implementer continue"` for a `continue` turn.
- AC-16 [unit] `turnLabel` returns `"implementer report"` for a `report` turn.

### US-005

- AC-1 [unit] `storyChangedFiles(sc)` with `git diff --name-only` returning `src/a.ts` and `.nax/features/f/x.md`, and `git status --porcelain` returning ` M src/a.ts` and `?? src/b.ts`, resolves `["src/a.ts", "src/b.ts"]`.
- AC-2 [unit] `storyChangedFiles(sc)` rejects when `git diff` exits non-zero.
- AC-3 [unit] `buildStoryEnv` with `workflow.interruptRetry.maxAttempts: 2`, `timeouts.implementMs: 5400000` and `timeouts.fixMs: 3600000` returns an env whose `interrupt` is `{ maxAttempts: 2, implementMs: 5400000, fixMs: 3600000 }`.
- AC-4 [unit] The env from `buildStoryEnv` has `steps.reportExists` resolving `false` while the story's `report.md` is absent, and `true` once that file is written.
- AC-5 [unit] The env from `buildStoryEnv`, with `_workflowDeps.git` answering `git diff --name-only` with `src/a.ts` and `git status --porcelain` with `?? src/b.ts`, has `steps.workSinceBase()` resolving `["src/a.ts", "src/b.ts"]`.
- AC-6 [unit] The env from `buildStoryEnv`, with `git status --porcelain` answering ` M src/a.ts`, has `steps.autoCommitDirty()` resolving `true` after calling `_workflowDeps.autoCommitIfDirty` once.

### US-006

Every AC drives `runStoryLoop` with faked `StoryLoopSteps` whose `implement` returns scripted outcomes; "interrupted" means a reply `{ status: "DONE_WITH_CONCERNS", concerns: "step time limit reached", interrupted: true }`; `env.interrupt` is `{ maxAttempts: 1, implementMs: 3600000, fixMs: 3600000 }` unless an AC says otherwise.

- AC-1 [unit] When the first implement turn is interrupted and the next turn replies DONE, `steps.implement` receives exactly one turn of kind `continue`, with `limit: "implement"`, `stepUps: 0`, `attempt: 1` and `maxAttempts: 1`.
- AC-2 [unit] The `continue` turn's `changedFiles` equals what `steps.workSinceBase` resolved (`["src/a.ts"]`).
- AC-3 [unit] When `steps.workSinceBase` rejects, the `continue` turn is still sent, with `changedFiles` undefined.
- AC-4 [unit] After an interrupted turn recovered by a DONE continue, the ledger holds `implementer interrupted at the step limit (60 min): continuing on the warm session (attempt 1 of 1)`.
- AC-5 [unit] After an interrupted turn recovered by a DONE continue, `steps.storyReview` receives an empty concerns list.
- AC-6 [unit] After an interrupted turn recovered by a DONE continue, no ledger line holds `(interrupted)`.
- AC-7 [unit] With `env.interrupt.maxAttempts: 2` and every turn interrupted, `steps.implement` receives two `continue` turns, with `attempt` 1 and then 2.
- AC-8 [unit] With `env.interrupt.maxAttempts: 0`, an interrupted first turn sends no `continue` turn.
- AC-9 [unit] When `steps.costExceeded` returns `true` from its first call, an interrupted first implement turn sends no `continue` turn, and the ledger holds `implementer interrupted at the step limit (60 min): continue skipped, cost limit reached`.
- AC-10 [unit] When a fix round's turn (`stepUps: 1`) is interrupted, with `steps.costExceeded` returning `false` at the top of the fix pass, the `continue` turn carries `limit: "fix"` and `stepUps: 1`.
- AC-11 [unit] With `env.interrupt.implementMs: 5400000`, the "continuing" ledger note reads `(90 min)`.
- AC-12 [unit] When the continue turn replies NEEDS_CONTEXT and the advisor answers, an `answer` turn follows the `continue` turn.
- AC-13 [unit] When that `answer` turn is interrupted after the only continue attempt was used, no second `continue` turn is sent.
- AC-14 [unit] When the continue turn returns `failure: "boom"`, the story's open findings hold `implementer session failed: boom`.

### US-007

Every AC drives `runStoryLoop` as in US-006, with `env.interrupt.maxAttempts: 1` and both the first turn and the continue turn interrupted, unless an AC says otherwise.

- AC-1 [unit] With `steps.autoCommitDirty` resolving `true`, `steps.autoCommitDirty` is called once, after the continue turn and before `steps.gates`.
- AC-2 [unit] With `steps.autoCommitDirty` resolving `true`, the ledger holds `auto-committed the implementer's uncommitted edits`.
- AC-3 [unit] With `steps.autoCommitDirty` resolving `true`, `steps.storyReview` receives the concern `DONE_WITH_CONCERNS: stopped at the step limit after 1 continue attempt(s); its uncommitted edits were auto-committed, and it may not have finished the story or written report.md`.
- AC-4 [unit] With `steps.autoCommitDirty` resolving `true`, the ledger holds `implementer (interrupted) DONE_WITH_CONCERNS: stopped at the step limit after 1 continue attempt(s); its uncommitted edits were auto-committed, and it may not have finished the story or written report.md`.
- AC-5 [unit] With `steps.autoCommitDirty` resolving `false`, the concern reaching `steps.storyReview` is `DONE_WITH_CONCERNS: stopped at the step limit after 1 continue attempt(s); nothing was auto-committed, and it may not have finished the story or written report.md`.
- AC-6 [unit] With `steps.autoCommitDirty` not wired, the same "nothing was auto-committed" concern reaches `steps.storyReview` and no ledger line holds `auto-committed the implementer's uncommitted edits`.
- AC-7 [unit] With `env.interrupt.maxAttempts: 0` and only the first turn interrupted, the concern reaching `steps.storyReview` holds `after 0 continue attempt(s)`.
- AC-8 [unit] When the continue turn replies NEEDS_CONTEXT, the advisor answers, and the `answer` turn is interrupted, the fallback concern reaches `steps.storyReview`.
- AC-9 [unit] When the continue turn returns `failure: "boom"`, `steps.autoCommitDirty` is not called.

### US-008

Every AC drives `runStoryLoop` with faked steps: gates green, `storyReview` recording its call order, `costExceeded` returning `false`, and `reportExists` scripted per call, unless an AC says otherwise.

- AC-1 [unit] When the implement turn replies DONE and `steps.reportExists` resolves `false`, `steps.implement` receives a `report` turn after `steps.gates` and before `steps.storyReview`.
- AC-2 [unit] When the implement turn replies DONE_WITH_CONCERNS (not interrupted) and the report is missing, a `report` turn is sent.
- AC-3 [unit] When `steps.reportExists` resolves `true`, no `report` turn is sent.
- AC-4 [unit] When the implement turn replies BLOCKED and the advisor gives no answer, no `report` turn is sent.
- AC-5 [unit] When the gates are red on the first pass, no `report` turn is sent in that pass.
- AC-6 [unit] When the implement turn ends in the interrupt fallback, no `report` turn is sent.
- AC-7 [unit] With `steps.costExceeded` counting its calls, returning `false` for the cost stop at the top of the evaluate pass and `true` for the report check after the gates, no `report` turn is sent.
- AC-8 [unit] When `steps.reportExists` is not wired, no `report` turn is sent.
- AC-9 [unit] When `steps.reportExists` rejects, no `report` turn is sent.
- AC-10 [unit] When `steps.reportExists` rejects, `steps.storyReview` still runs.
- AC-11 [unit] For a resumed story (`env.resume` set), the first evaluate pass sends no `report` turn.
- AC-12 [unit] When the report is still missing after a fix round, and a report turn already ran earlier in the story, no second `report` turn is sent before the re-review.
- AC-13 [unit] When the first review passes the report check with the report present, and a fix round replies DONE with the report then missing, a `report` turn is sent before the re-review.
- AC-14 [unit] Before the report turn, the ledger holds `report.md missing after the implementer's reply: asking the session to write it`.
- AC-15 [unit] When `steps.reportExists` resolves `true` after the report turn, the ledger holds `report turn: report written`.
- AC-16 [unit] When `steps.reportExists` still resolves `false` after the report turn, the ledger holds `report turn: report still missing, reviewing without it`.
- AC-17 [unit] When the report turn returns `failure: "boom"`, the ledger holds `report turn failed: boom` and the story's open findings hold no `implementer session failed` item.
- AC-18 [unit] When the report turn is interrupted, no `continue` turn follows it.
- AC-19 [unit] When the turn that replied DONE ran at `stepUps: 1` (a fresh no-work restart), the `report` turn carries `stepUps: 1`.
- AC-20 [unit] When a fix round's turn fails (`failure: "boom"`) after an earlier DONE reply, and the report is missing, no `report` turn is sent before the next review step.

### US-009

- AC-1 [unit] `buildWorkflowBranchReviewPrompt` with `storyReports: [{ storyId: "US-001", path: "/r/US-001/report.md", present: true }]` returns text holding a `## Story reports` section with the line `- US-001: /r/US-001/report.md`.
- AC-2 [unit] With `storyReports: [{ storyId: "US-002", path: "/r/US-002/report.md", present: false }]`, the section holds `- US-002: no report (/r/US-002/report.md does not exist)`.
- AC-3 [unit] With a non-empty `storyReports`, the prompt holds `A deferred minor or cannot-verify item that says a story's report is missing or unreadable is settled by this list`.
- AC-4 [unit] With `storyReports` absent, and again with it empty, the prompt holds no `## Story reports` heading.
- AC-5 [unit] `runBranchReview` with `facts.stories` `[{ id: "US-001", state: "complete", runDir: "/run" }]` and `_workflowDeps.fileExists` resolving `true` sends a prompt (captured from `_workflowDeps.callOp`) holding `- US-001: /run/US-001/report.md`.
- AC-6 [unit] When `_workflowDeps.fileExists` resolves `false`, the prompt holds `- US-001: no report (/run/US-001/report.md does not exist)`.
- AC-7 [unit] When `_workflowDeps.fileExists` rejects, the prompt holds `- US-001: /run/US-001/report.md`.
- AC-8 [unit] A story in `facts.stories` with no `runDir` gets no line in the `## Story reports` section.
- AC-9 [unit] `branchReviewStep(env, rec)` with a record that has a `seed`, and `env.facts.stories` holding a `StorySummary` with `runDir: "/run"`, calls `env.steps.branchReview` with facts whose matching `stories` entry carries `runDir: "/run"`.
