# SPEC: Pre-release Hardening

## Summary

Bundles nine open issues that should land before the stable 0.88.0 release, where workflow mode becomes the
default. nax#2509: an implementer turn that does no work at all (no status block, no changes, no report) is
restarted once on the same session, then once on a fresh session one tier up, and closed without review if it
still does nothing. nax#2511: `nax run --fresh` / `--no-resume` stops a workflow story from resuming an
earlier run's record. nax#2513 and nax#2514: the workflow role table and the `run.complete` cost breakdowns
add up to the run's total cost. nax#2510: story-level out-of-scope entries survive load and save when the
feature-level list is at the 25-item cap. nax#2506: `session-run-hop` forwards `declaredTools` on an ACP open.
nax#2505: agent sessions cannot write `.claude/settings.json` or `.claude/settings.local.json`. nax#2520: on
macOS the sandbox description tells the agent that `ps` cannot run. nax#2515: a spec's `Closes:` line becomes
`Closes #N` lines in the workflow PR body.

Closes: #2505, #2506, #2509, #2510, #2511, #2513, #2514, #2515, #2520

## Motivation

- **nax#2509.** `parseImplementerReply` (`src/operations/workflow-replies.ts`) maps a reply with no status
  block to `DONE_WITH_CONCERNS` with the concern "implementer reply carried no status block", and
  `runStoryLoop` (`src/workflow/story-loop.ts`) goes straight on to gates and a billed story review. Observed
  on a private NestJS monorepo (nax `ee04b5483`): the implementer read the brief, replied "What would you like
  help with?", wrote nothing, and the story spent a review and two fix rounds (one hung 20 minutes) on an empty
  package.
- **nax#2511.** `buildStoryEnv` (`src/workflow/stage-env.ts`) always resumes the newest unfinished record of
  an earlier run (`loadPriorStory`, `src/workflow/result.ts`). `--fresh` / `--no-resume` only reach the
  classic checkpoint seam (`applyResumeModeDeps`, `src/execution/checkpoint/resume-cli.ts`), so a user who
  restarts a story with a different model inherits the old run's findings and round count. Workflow mode never
  sets a story `in-progress` or bumps `attempts`, so a PRD reset looks the same as a crash; the CLI flag is
  the only signal that can tell them apart.
- **nax#2513.** `runWorkflowPreflight` (`src/workflow/preflight-run.ts`) dispatches the advisor with no token
  meter running, so its spend never reaches the role table (`rolesOf`, `src/workflow/run-summary.ts`).
  Observed: role sum $1.3124 against `totalCost` $1.6107; the $0.2983 pre-flight call is missing.
- **nax#2514.** `handleRunCompletion` (`src/execution/lifecycle/run-completion.ts`) snapshots
  `costAggregator.byStage()` / `byStory()` in phase 3. With `deferRunCompleteLog`, the deferred line gets a
  fresh `totalCost` but logs the phase-3 breakdowns, which predate the feature workflow ($0.5228 missing in
  the observed run). Run-level calls carry `storyId: ""`, which `applyBackfill` turns into a pseudo-story
  `{ storyId: "", attempts: 0, success: false }` in `storyMetrics`.
- **nax#2510.** `propagateOutOfScopeToStories` (`src/prd/out-of-scope.ts`) builds each story's list as
  `dedupeAndCap([...featureLevel, ...storyLevel])`, so at 25 feature-level entries every story-specific entry
  is cut. `stripPropagatedOutOfScope` then writes the stories back without them: hand-curated entries are
  deleted from `prd.json` on the first save.
- **nax#2506.** `createSessionRunHop` (`src/runtime/session-run-hop.ts`) forwards `sandbox` but not
  `declaredTools`, while the op path (`src/operations/build-hop-callback-hop.ts`) forwards both. An ACP
  session opened through the hop cannot narrow its profile to what the caller declared.
- **nax#2505.** ACP Claude implementer sessions load project settings, and `<root>/.claude/settings.json` and
  `settings.local.json` sit inside the write roots. An agent can add allow rules, hooks or MCP servers there
  and weaken every later session in that workdir.
- **nax#2520.** On macOS the srt sandbox refuses `/bin/ps` (`Operation not permitted`; a non-setuid copy is
  killed with SIGKILL). Verified with `@anthropic-ai/sandbox-runtime` 0.0.77. A repo whose tests shell out to
  `ps` gets a failing test in every sandboxed session that the agent cannot explain, and the reviewer reports
  it as cannot-verify.
- **nax#2515.** The workflow PR body (`assemble`, `src/workflow/pr-body.ts`) has no issue references, so a
  person adds `Closes #N` by hand after every bundled-issue run (PR #2512).

## Design

### Approach

Seven stories, each in a single package. US-002 depends on US-001; no other story depends on another.

- **No-work turns, implementer side (US-001).** `parseImplementerReply` marks a reply with no status block
  `noStatusBlock: true`. A new `restart` implementer turn runs warm (same session, the short restart prompt) or
  fresh (session closed first, the full implement prompt, stepped up by `stepUps` through `fixModelFor`, which
  keeps the routed model when there is no higher rung).
- **No-work ladder (US-002).** A no-work turn is one whose reply has `noStatusBlock: true` and after which the
  story has no work evidence: no files changed since the story base (`changedFilesSince(projectDir, sc.base)`
  empty), no uncommitted files (`listUncommitted` empty) and no `report.md` at `sc.reportPath`.
  `buildStoryEnv` wires this as `steps.workProduced`; the changed-file list it checks excludes paths under
  `.nax/` and `.nax-*`, the same filter `listUncommitted` applies. The check runs only after the first
  implement turn of a non-resumed story and after each restart turn. `runStoryLoop` and `absorbTurn` are at
  the complexity ratchet (Biome scores 20 and 19 against a strict limit of 20; `story-loop.ts` has no
  baseline entry), so `runStoryLoop` must not gain a branch: its `if (!resumed) { ... }` block moves into a
  private helper `openStory(env, s)` in `story-loop.ts` that returns `StoryLoopOutcome | undefined`, and
  `runStoryLoop` keeps only `const early = await openStory(env, s); if (early) return early;`. `openStory`
  runs the first implement turn, calls `runNoWorkLadder` (new, `src/workflow/no-work.ts`), absorbs the last
  turn's outcome, and returns the `closeLoop` result when the ladder closed the story. To avoid an import
  cycle (`story-loop.ts` imports `no-work.ts`), `runNoWorkLadder` takes the turn runner as a parameter
  instead of importing `implementTurn`. `openStory` and `runNoWorkLadder` each stay at a Biome complexity of
  20 or below. The turn's outcome is absorbed with origin `{ stepUps: 0, limit: "implement" }` after the
  implement turn or a warm restart, and `{ stepUps: 1, limit: "implement" }` after a fresh restart, so an
  advisor answer to a question from the fresh restart runs on the stepped-up model. The ladder:
  1. the implement turn is a no-work turn → ledger note "no work: reply carried no status block, no changes
     since the story base, no report", then a **warm restart** turn `{ kind: "restart", fresh: false, stepUps: 0 }`;
  2. the warm restart is a no-work turn → ledger note "no work after the restart: restarting fresh one tier
     up", then a **fresh restart** turn `{ kind: "restart", fresh: true, stepUps: 1 }`;
  3. the fresh restart is a no-work turn → ledger note "no work after the fresh restart: closing the story
     without review", and the story closes `complete-gate-open` with reason `no work produced`. Gates, story
     review, fix rounds and adjudication do not run.

  Before each restart the ladder checks `steps.costExceeded()`; when it is true the ladder stops and the loop
  continues as today (its own cost check then stops the story). A restart turn that fails (`failure` set) or
  is interrupted is absorbed as today and ends the ladder; the loop continues to gates. A restart turn that
  produces work continues the loop exactly as a normal implement turn does.
- **`--fresh` reaches workflow resume (US-003).** A module-level `_workflowResumeDeps.mode` (default `"auto"`,
  in `src/execution/checkpoint/resume-cli.ts` beside `applyResumeModeDeps`, exported through `@/execution`;
  `execution/` may not import `@/workflow` statically and `stage-env.ts` already imports `@/execution`) is set by `run()` (`src/execution/runner.ts`) to its `resumeMode` next to the
  existing `applyResumeModeDeps` call, and restored to its prior value at the two places `run()` already
  restores `_storyOrchestratorDeps.loadCheckpoints` (the setup-error path and the outer `finally`).
  `applyResumeModeDeps` is not changed. `buildStoryEnv` ignores a resumable prior record when the mode is not
  `"auto"`, logs it, and starts the story fresh. Old run directories stay on disk.
- **declaredTools on the hop (US-003).** `createSessionRunHop` forwards `codingSupport.declaredTools` on
  `openSession`, through a helper next to `sandboxOption` (the function is at the complexity ratchet).
- **Cost totals (US-004).** `runWorkflowPreflight` runs `startTokenMeter(input.runtime.dispatchEvents)` around
  the pre-flight and, in a `finally` (so spend before a pre-flight error is kept) when the meter recorded at least one call, writes its `byRole()` into this run's
  `result.json` as a new top-level `preflightTokensByRole`; `rolesOf` folds it in. A pre-flight that dispatched
  nothing (an adopted prior pre-flight) writes nothing. The deferred `run.complete` line (the `logComplete`
  closure in `handleRunCompletion`) re-reads `costAggregator.byStage()` / `byStory()` when it is written, and
  passes those to `logRunCompletion` (`run-completion-phases.ts`), where `costByStory` reports the run-level
  key `""` as `_run`. `backfillDomain` (`backfill-story-metrics.ts`) skips `""`.
- **Out-of-scope round trip (US-005).** A new `dedupeOutOfScope(items)` in `out-of-scope-extract.ts` applies
  `dedupeAndCap`'s filters (empty sentinels, list lead-ins, canonical duplicates) without the cap;
  `dedupeAndCap` becomes `dedupeOutOfScope` plus the cap. `propagateOutOfScopeToStories` builds each story's
  list as `dedupeOutOfScope([...dedupeAndCap(featureLevel), ...storyLevel])`, so the cap applies only to the
  feature-level part and every story-specific entry is kept. `stripPropagatedOutOfScope` then writes them all
  back. `test/unit/prd/out-of-scope.test.ts` is 749 lines against the 800-line test limit, so new tests go in
  a new satellite file.
- **Sandbox (US-006).** `buildSandboxPolicy` adds `<root>/.claude/settings.json` and
  `<root>/.claude/settings.local.json` to `denyWrite`. The ACP edit-path check (`firstOutsidePolicy`,
  `packages/nax-agent-acp/src/client/edit-targets.ts`) already refuses any path under a `denyWrite` entry, so
  the same list covers the Write/Edit tools and Bash. `sandboxSentence` gains an optional `platform`
  argument; on `"darwin"` it appends one sentence about `ps`. The Bash tool (both `sandboxSentence` call sites
  in `bashToolDescription`: raw mode and gated/escalate) and the RunCommand tool pass the platform from a deps
  seam. `_runCommandToolDeps` is not exported from `src/internal.ts` (tests import it
  through `#src`), so the API snapshot does not change.
- **Closes lines (US-007).** A new `parseClosingIssues(specText)` reads `Closes:` lines from the feature spec.
  `bodyFacts` (`src/workflow/finalize.ts`) resolves the spec through `_workflowDeps.resolveFeatureSpec`, reads
  it the way `loadSpec` in `brief.ts` does (a relative path joined to the project dir), parses it and sets
  `closes` on the PR body facts; `assemble` renders a `## Closes` section right after `## Summary` when the
  list is non-empty (the body's 60,000-character cut trims the tail, so the section sits near the top).

### Integration

Read-only symbols (verified at `af2cadf7f`):

- `changedFilesSince(projectDir: string, base: string): Promise<string[]>` and
  `listUncommitted(projectDir: string): Promise<string[]>` — `packages/nax/src/workflow/git.ts`.
- `fixModelFor(story, tierOrder, stepUps): ConfiguredModel | undefined` — `packages/nax/src/workflow/fix-round.ts`.
- `closeImplementerSession(sessionManager, storyId)` — `packages/nax/src/workflow/sessions.ts`.
- `startTokenMeter(source): TokenMeter` and `addRoleTokens(a, b)` — `packages/nax/src/workflow/tokens.ts`.
- `ledgerText.note(text)` returns `oneLine(text)`; `ledgerText.end(state, summary)` returns
  `` `${state} (${summary})` `` — `packages/nax/src/workflow/ledger.ts`.
- `_workflowDeps.resolveFeatureSpec(feature, workdir)` returns `{ specSource?: { path } | null }`, a path
  relative to the repo — `packages/nax/src/workflow/step-context.ts`.
- `firstOutsidePolicy(targets, policy, cwd)` — `packages/nax-agent-acp/src/client/edit-targets.ts`.
- `dedupeAndCap(items)`, `canonical(item)`, `MAX_OUT_OF_SCOPE_ITEMS = 25` — `packages/nax/src/prd/out-of-scope-extract.ts`.

Mutated symbols. The baseline exists only to locate the code; implement the target.

- `ImplementerReply` (`packages/nax/src/operations/workflow-types.ts`).
  Baseline: `{ status, commits, testSummary, concerns?, interrupted, failure? }`.
  Target: adds `readonly noStatusBlock?: true`, set only by the no-status branch of `parseImplementerReply`.
- `ImplementTurn` (`packages/nax/src/workflow/implement.ts`).
  Baseline: `implement | answer | fix`.
  Target: adds `{ readonly kind: "restart"; readonly fresh: boolean; readonly stepUps: number }`.
  `runImplementerTurn` closes the session first when `fresh`; the prompt is `buildWorkflowRestartPrompt` when
  warm and `buildWorkflowImplementPrompt` when fresh; the timeout is `timeouts.implementMs`;
  `implementerModelFor` steps up by `stepUps` for a restart turn. `turnLabel` gives the restart turns their
  own run-log label (wording is the implementer's choice).
- `StoryLoopSteps` (`packages/nax/src/workflow/story-loop.ts`).
  Target: adds optional `workProduced?(): Promise<boolean>`. Absent means "work produced", so the guard never
  fires.
- `run()` (`packages/nax/src/execution/runner.ts`).
  Target: assigns `_workflowResumeDeps.mode = resumeMode` where it calls `applyResumeModeDeps`, and restores the
  prior value wherever it restores `_storyOrchestratorDeps.loadCheckpoints`.
- `dedupeAndCap(items)` (`packages/nax/src/prd/out-of-scope-extract.ts`).
  Target: same output as today, implemented as `dedupeOutOfScope(items)` truncated to `MAX_OUT_OF_SCOPE_ITEMS`.
- `WorkflowResultFile` (`packages/nax/src/workflow/types.ts`).
  Target: adds `readonly preflightTokensByRole?: Readonly<Record<string, RoleTokens>>`. `upsertStoryRecord`
  and `upsertFeatureRecord` keep it when present.
- `RunCompletionResult.logRunComplete` (`run-completion.ts`): unchanged signature; the breakdowns it logs are
  read at call time.
- `sandboxSentence(network, sharedTmp = true)` (`packages/nax-agent/src/sandbox/messages.ts`).
  Target: `sandboxSentence(network, sharedTmp = true, platform?: NodeJS.Platform)`. Output is unchanged
  unless `platform === "darwin"`.
- `WorkflowPrBodyFacts` (`packages/nax/src/workflow/pr-body.ts`).
  Target: adds `readonly closes?: readonly number[]`.

New symbols:

- `buildWorkflowRestartPrompt(input: { storyId: string; briefPath: string; reportPath: string }): string` —
  `packages/nax/src/prompts/builders/workflow-implementer-builder.ts`, exported from `@/prompts`.
- `_workflowResumeDeps: { mode: ResumeMode }` (default `"auto"`) — `packages/nax/src/execution/checkpoint/resume-cli.ts`, exported from `@/execution`.
- `writePreflightTokens(runDir, header, byRole): Promise<void>` — `packages/nax/src/workflow/result.ts`.
- `parseClosingIssues(text: string): number[]` — `packages/nax/src/workflow/closing-issues.ts` (new file).
- `runNoWorkLadder(env: StoryLoopEnv, first: ImplementOutcome, runTurn: (turn: ImplementTurn) => Promise<ImplementOutcome>): Promise<NoWorkLadderResult>` —
  `packages/nax/src/workflow/no-work.ts` (new file). `NoWorkLadderResult` is
  `{ readonly closed: boolean; readonly outcome: ImplementOutcome; readonly stepUps: number }`: `closed` true
  means the story closes with `no work produced`; otherwise `outcome` is the last turn's outcome and `stepUps`
  the step-up it ran at, which `openStory` absorbs.
- `dedupeOutOfScope(items: string[]): string[]` — `packages/nax/src/prd/out-of-scope-extract.ts`.
- `_bashToolDeps.platform: () => NodeJS.Platform` (added to the existing seam in `packages/nax-agent/src/tools/bash.ts`)
  and `_runCommandToolDeps: { platform: () => NodeJS.Platform }` (new in `packages/nax-agent/src/tools/run-command.ts`).

### Prompt and message text

Warm restart prompt (`buildWorkflowRestartPrompt`), verbatim apart from the interpolations:

```text
You have not started story ${storyId}: there are no commits, no changes and no report yet. Read the brief at
${briefPath} now and implement it as it says. Write ${reportPath}, commit your work, and end your reply with
the json status block.
```

followed by the existing `WORKFLOW_REPLY_CONTRACT`.

darwin sentence appended by `sandboxSentence` (after the existing text, separated by one space):

```text
On macOS the sandbox also refuses ps and other setuid programs ("Operation not permitted"), so a test that shells out to ps fails here for that reason alone.
```

### Closes line format

A `Closes:` line is a line whose trimmed text starts with `Closes:` (case-insensitive) outside a fenced code
block. Its remainder is split on commas and whitespace; each token that is exactly `#` followed by digits
counts, and every other token on the line is ignored. Numbers are deduplicated and kept in first-appearance
order across all `Closes:` lines. Rendered section:

```markdown
## Closes

Closes #2505
Closes #2506
```

### Failure Handling

| Failure | Behaviour |
|---|---|
| `workProduced` throws (git error, unreadable report path) | Treated as work produced: the guard does not fire and the loop goes on as today (fail-open). |
| A restart turn fails (`failure` set) or is interrupted | Absorbed as today (a `session` finding or a concern); the ladder ends and the loop continues to gates. |
| `steps.costExceeded()` is true before a restart | The ladder stops without the restart; the loop's own cost check closes the story `complete-gate-open` with reason `cost-limit`. |
| `writePreflightTokens` throws | Logged at debug with `storyId: "_run"`; the pre-flight result is unaffected. |
| `resolveFeatureSpec` throws, returns no `specSource`, or the spec file is missing or unreadable, while building PR body facts | `closes` is omitted; the body is built as today. |

## Out of Scope

- A per-story reset command or flag (`--reset-story`, `nax workflow reset`) — `--fresh` / `--no-resume` is the only reset this spec adds.
- Reconciling a prior workflow record against the PRD story's `status` or `attempts` — workflow mode leaves both unchanged, so a reset cannot be told apart from a crash.
- The no-work guard on fix rounds, answer turns or a resumed story — it runs only on the first implement turn of a fresh story and its restarts.
- Loading only the implementer's `CLAUDE.md` instead of full user and project Claude settings (the second half of nax#2505).
- Settings-file `allow` rules that Claude honours without a permission request (the first half of nax#2505) — the deny list stops new edits to the settings files, not rules already in them.
- Per-package `.claude/settings*.json` under a monorepo package other than the session root.
- An opt-out for the new `.claude/settings*.json` write denies.
- Creating other files under a `.claude/` directory that does not exist yet on Linux — srt's bwrap mounts an empty directory at the first missing component of a deny path, which blocks that; accepted.
- Making `ps` or other setuid programs runnable inside the macOS sandbox — srt refuses them and kills a non-setuid copy.
- A darwin note for ACP Claude sessions, whose Bash sandbox description is Claude's own.
- Cache read/write token columns in the workflow role table.
- Forwarding `providerTools` / `toolSurface` from `session-run-hop` — only `declaredTools` is added.
- Cross-repo issue references (`koda#270`, `owner/repo#N`) and guessing issue numbers from spec prose — only explicit `Closes:` lines count.
- `Closes` lines in the finish (pipeline-mode) PR body, and issue references in the run report for `workflow.publish` `push` / `none`.
- MCP server instructions (nax#2517) and a blocking pre-run setup step (nax#2521).

## Stories

### US-001 — No-work turns, implementer side: `noStatusBlock` and the `restart` turn

Workdir: `packages/nax`

Adds `ImplementerReply.noStatusBlock`, the `restart` implementer turn in `runImplementerTurn`, its run-log
label, and `buildWorkflowRestartPrompt`.

Dependencies: none.

### US-002 — No-work ladder: restart, restart one tier up, then close without review

Workdir: `packages/nax`

Adds `runNoWorkLadder` in `src/workflow/no-work.ts`, called once by `runStoryLoop` after the first implement
turn, and the optional `StoryLoopSteps.workProduced` step wired in `buildStoryEnv`.

Dependencies: US-001.

### US-003 — Run-start plumbing: `--fresh` reaches workflow resume, the hop forwards `declaredTools`

Workdir: `packages/nax`

Adds `_workflowResumeDeps.mode`, set and restored by `run()` and honoured by `buildStoryEnv`; and forwards
`codingSupport.declaredTools` from `createSessionRunHop` on `openSession`.

Dependencies: none.

### US-004 — Cost breakdowns add up to the total

Workdir: `packages/nax`

Meters the workflow pre-flight into `result.json` `preflightTokensByRole` and the role table; re-reads the
aggregator breakdowns when the deferred `run.complete` line is written; reports the run-level story key as
`_run`; keeps run-level spend out of `storyMetrics`.

Dependencies: none.

### US-005 — Story-level out-of-scope survives the cap

Workdir: `packages/nax`

Adds `dedupeOutOfScope` and changes `propagateOutOfScopeToStories` so the cap applies only to the
feature-level part and every story-specific entry is kept, making load and save a round trip.

Dependencies: none.

### US-006 — Sandbox: Claude settings denied, `ps` note on macOS

Workdir: `packages/nax-agent`

Adds the two `.claude/settings*.json` write denies to `buildSandboxPolicy`, the `platform` argument and the
darwin sentence to `sandboxSentence`, and the platform seams on the Bash and RunCommand tools.

Dependencies: none.

### US-007 — `Closes #N` in the workflow PR body

Workdir: `packages/nax`

Adds `parseClosingIssues`, `WorkflowPrBodyFacts.closes`, the `## Closes` section in `assemble`, and the
spec read in `bodyFacts`.

Dependencies: none.

Story split rationale: the project's `maxAcCount` is 24 and the hard story ceiling is 7. nax#2509 is two
stories because its assertions exceed 24 together: US-001 (the reply flag, the turn and its prompt, in
`implement.ts`, `workflow-replies.ts` and the prompt builder) and US-002 (the ladder in a new module and its
wiring), which uses US-001's turn kind. nax#2511 and nax#2506 are each under 6 assertions and both sit on the
run-start path in `packages/nax`, so they share US-003. nax#2513 and nax#2514 share one invariant (breakdowns
equal the total). nax#2505 and nax#2520 are both the `nax-agent` sandbox.

### Context Files

**US-001**
- `packages/nax/src/workflow/implement.ts` — `ImplementTurn`, `runImplementerTurn`, `promptFor`, `implementerModelFor`
- `packages/nax/src/operations/workflow-replies.ts` — `parseImplementerReply`
- `packages/nax/src/prompts/index.ts` — the `@/prompts` export list `buildWorkflowRestartPrompt` joins
- `packages/nax/src/prompts/builders/workflow-implementer-builder.ts` — `buildWorkflowImplementPrompt`, `WORKFLOW_REPLY_CONTRACT`
- `packages/nax/src/workflow/story-loop.ts` — `turnLabel`

**US-002**
- `packages/nax/src/workflow/story-loop.ts` — `runStoryLoop`, `absorbTurn`, `implementTurn`, `closeLoop`; `openStory` is added here
- `packages/nax/src/workflow/stage-env.ts` — `buildStoryEnv`, the steps object
- `packages/nax/src/workflow/git.ts` — `changedFilesSince`, `listUncommitted`
- `packages/nax/test/unit/workflow/story-loop.test.ts` — the `harness()` step fakes

**US-003**
- `packages/nax/src/execution/runner.ts` — `run()`, the `applyResumeModeDeps` call and the two restore points
- `packages/nax/src/workflow/stage-env.ts` — `buildStoryEnv`, the resume decision
- `packages/nax/src/execution/checkpoint/resume-cli.ts` — `applyResumeModeDeps`; `_workflowResumeDeps` is added here
- `packages/nax/src/runtime/session-run-hop.ts` — `createSessionRunHop`, `sandboxOption`
- `packages/nax/src/operations/build-hop-callback-hop.ts` — the op path's `openSession` options to mirror

**US-004**
- `packages/nax/src/workflow/preflight-run.ts` — `runWorkflowPreflight`
- `packages/nax/src/workflow/result.ts` — `upsertStoryRecord`, `upsertFeatureRecord`, `writeResult`, `rolesOf`'s input
- `packages/nax/src/execution/lifecycle/run-completion.ts` — `handleRunCompletion`, the deferred `logComplete`
- `packages/nax/src/execution/lifecycle/run-completion-phases.ts` — `snapshotCostsAndBackfill`, `logRunCompletion`
- `packages/nax/src/execution/lifecycle/backfill-story-metrics.ts` — `backfillDomain`, `applyBackfill`

**US-005**
- `packages/nax/src/prd/out-of-scope.ts` — `propagateOutOfScopeToStories`, `stripPropagatedOutOfScope`
- `packages/nax/src/prd/out-of-scope-extract.ts` — `dedupeAndCap`, `canonical`, `MAX_OUT_OF_SCOPE_ITEMS`
- `packages/nax/src/prd/index.ts` — `loadPRD` / `savePRD` call sites
- `packages/nax/test/unit/prd/out-of-scope.test.ts` — existing propagate and strip tests

**US-006**
- `packages/nax-agent/src/sandbox/policy-builder.ts` — `buildSandboxPolicy`, the `denyWrite` list
- `packages/nax-agent/src/sandbox/messages.ts` — `sandboxSentence`
- `packages/nax-agent/src/tools/bash.ts` — `bashToolDescription`, `_bashToolDeps`
- `packages/nax-agent/src/tools/run-command.ts` — `execSandboxNote`
- `packages/nax-agent/test/unit/sandbox/policy-builder.test.ts` — the policy fixture and `denyWrite` assertions

**US-007**
- `packages/nax/src/workflow/pr-body.ts` — `WorkflowPrBodyFacts`, `assemble`, `buildWorkflowPrBody`
- `packages/nax/src/workflow/finalize.ts` — `bodyFacts`, `publish`
- `packages/nax/src/workflow/brief.ts` — `loadSpec`, the relative-path spec read to mirror
- `packages/nax/test/unit/workflow/finalize.test.ts` — the `wire()` forge fakes that capture PR bodies

### Creates

**US-002**
- `packages/nax/src/workflow/no-work.ts` — `runNoWorkLadder`, `NoWorkLadderResult`

**US-005**
- `packages/nax/test/unit/prd/out-of-scope-cap.test.ts` — the new propagate/strip cap tests (the existing file is near the 800-line test limit)

**US-007**
- `packages/nax/src/workflow/closing-issues.ts` — `parseClosingIssues`

### Modifies

**US-001**

None. No existing reply sets `noStatusBlock` and no existing test constructs a `restart` turn; tests of the
no-status reply assert `status` and `concerns` with `toBe`/`toContain`, not the whole object.

**US-002**

None. Every existing `StoryLoopSteps` fake omits `workProduced`, so the ladder never fires in current tests;
existing `buildStoryEnv` tests use the non-commit base `base123`, on which `changedFilesSince` throws and the
step fails open.

**US-003**

None. Existing resume tests run with the default `"auto"` mode, which `applyResumeModeDeps` callers do not
change, and existing hop tests assert the options they set, not the full option object.

**US-004**

None. No existing test asserts a `""` story key in `costByStory` or `storyMetrics`, or the full key set of
`result.json`.

**US-005**
- `packages/nax/test/unit/prd/out-of-scope.test.ts` — the test "feature-level items outrank story-level ones when the cap truncates" asserts the merged list `toHaveLength(MAX_OUT_OF_SCOPE_ITEMS)` for one feature-level entry plus 25 story-specific ones. Under US-005 story-specific entries are never truncated, so the merged list has 26 entries; US-005 owns changing that assertion to length 26, keeping `merged[0]` equal to "FEATURE-LEVEL-CRITICAL".

**US-006**

None. Tests pin `denyWrite` entries with `toContain`, and the verbatim `sandboxSentence` tests call it without
a platform, which keeps today's text.

**US-007**

None. `closes` is optional, so existing fixtures and bodies are unchanged when no spec declares it.

### Seams

- The `restart` turn kind (US-001) is issued by `runNoWorkLadder` (US-002) — US-002's ACs drive `runStoryLoop` with scripted steps and assert the turns `steps.implement` receives.
- `runNoWorkLadder` (US-002, new) is called by `runStoryLoop` — US-002's ACs drive `runStoryLoop`, not the helper directly.
- `StoryLoopSteps.workProduced` (US-002, new) is wired by `buildStoryEnv` — US-002's ACs drive `buildStoryEnv` against a git fixture.
- `buildWorkflowRestartPrompt` (US-001, new) is called by `runImplementerTurn` — US-001's ACs drive `runImplementerTurn` with a `restart` turn and assert the prompt the faked op receives.
- `_workflowResumeDeps.mode` (US-003, new) is set by `run()` and read by `buildStoryEnv` — US-003's ACs drive `run()` for the set/restore and `buildStoryEnv` for the read.
- `writePreflightTokens` (US-004, new) is called by `runWorkflowPreflight` — US-004's ACs drive `runWorkflowPreflight` with `input.runtime.dispatchEvents` emitting an advisor event and read the written `result.json`.
- `dedupeOutOfScope` (US-005, new) is called by `propagateOutOfScopeToStories` and `dedupeAndCap` — US-005's ACs drive `propagateOutOfScopeToStories` and `loadPRD`/`savePRD`.
- `parseClosingIssues` (US-007, new) is called by `bodyFacts` — US-007's ACs drive `publish` with a faked spec and assert the body passed to `_featureDeps.openDraftFinishPr`.

## Acceptance Criteria

### US-001

- [unit] `parseImplementerReply("I changed some files.")` returns `noStatusBlock: true`.
- [unit] `parseImplementerReply` on a reply whose fenced json block has `status: "DONE"` returns an object without a `noStatusBlock` key.
- [unit] `parseImplementerReply` on the workflow interrupt marker returns an object without a `noStatusBlock` key.
- [unit] `parseImplementerReply('Agent "native" failed: 503 upstream')` returns an object without a `noStatusBlock` key.
- [unit] `runImplementerTurn` with `{ kind: "restart", fresh: false, stepUps: 0 }` passes `_workflowDeps.callOp` a prompt equal to `buildWorkflowRestartPrompt({ storyId, briefPath, reportPath })` for the story.
- [unit] `runImplementerTurn` with `{ kind: "restart", fresh: false, stepUps: 0 }` does not call `closeImplementerSession`.
- [unit] `runImplementerTurn` with `{ kind: "restart", fresh: true, stepUps: 1 }` calls `closeImplementerSession` before `_workflowDeps.callOp`.
- [unit] `runImplementerTurn` with `{ kind: "restart", fresh: true, stepUps: 1 }` passes `_workflowDeps.callOp` a prompt equal to `buildWorkflowImplementPrompt({ storyId, briefPath, reportPath })`.
- [unit] `runImplementerTurn` with `{ kind: "restart", fresh: true, stepUps: 1 }` on a story routed to tier `fast` with tier order `fast`, `balanced` passes `_workflowDeps.callOp` the `model` `fixModelFor` returns for one step-up (`balanced`).
- [unit] `runImplementerTurn` with a `restart` turn passes `timeoutMs` equal to `workflow.timeouts.implementMs`.
- [unit] `buildWorkflowRestartPrompt({ storyId: "US-001", briefPath: "/b/brief.md", reportPath: "/b/report.md" })` returns text that starts with "You have not started story US-001" and names "/b/brief.md" and "/b/report.md".
- [unit] `turnLabel` returns different labels for a warm restart turn, a fresh restart turn and an `implement` turn.

### US-002

- [unit] `runStoryLoop` on a fresh story whose implement turn returns a reply with `noStatusBlock: true` and whose `steps.workProduced` resolves `false` passes `steps.implement` a second turn `{ kind: "restart", fresh: false, stepUps: 0 }` before `steps.gates` is called.
- [unit] In that case the ledger receives "no work: reply carried no status block, no changes since the story base, no report" before the restart turn.
- [unit] When the warm restart is also a no-work turn, the third turn `steps.implement` receives is `{ kind: "restart", fresh: true, stepUps: 1 }`, preceded by the ledger line "no work after the restart: restarting fresh one tier up".
- [unit] When the fresh restart is also a no-work turn, `runStoryLoop` returns `state: "complete-gate-open"` and `reason: "no work produced"`.
- [unit] In that case `runStoryLoop` calls none of `steps.gates`, `steps.storyReview` and `steps.fullSuite`, and the ledger receives "no work after the fresh restart: closing the story without review".
- [unit] In that case the last record update carries `state: "complete-gate-open"`, `reason: "no work produced"` and `phase: "closed"`.
- [unit] When the warm restart returns a `DONE` reply and `steps.workProduced` then resolves `true`, `runStoryLoop` calls `steps.gates` next and issues no fresh restart.
- [unit] When the implement turn's reply has `noStatusBlock: true` but `steps.workProduced` resolves `true`, `runStoryLoop` issues no restart turn and calls `steps.gates`.
- [unit] When the implement turn's reply has `status: "DONE"` without `noStatusBlock` and `steps.workProduced` resolves `false`, `runStoryLoop` issues no restart turn.
- [unit] When `steps.workProduced` is absent, a `noStatusBlock: true` reply issues no restart turn.
- [unit] When `steps.workProduced` rejects, a `noStatusBlock: true` reply issues no restart turn and `runStoryLoop` calls `steps.gates`.
- [unit] When the warm restart turn returns `failure: "boom"`, `runStoryLoop` issues no fresh restart and calls `steps.gates`.
- [unit] When `steps.costExceeded()` returns `true` after the first no-work implement turn, `runStoryLoop` issues no restart turn and returns `reason: "cost-limit"`.
- [unit] A resumed story (`env.resume` set) never calls `steps.workProduced`.
- [unit] When the fresh restart replies `NEEDS_CONTEXT` and the advisor answers, the answer turn `steps.implement` receives has `stepUps: 1` and `limit: "implement"`.
- [integration] In a git repo fixture whose HEAD equals the story base, with a clean tree and no `report.md`, `env.steps.workProduced()` from `buildStoryEnv` resolves `false`.
- [integration] In the same fixture after a commit on top of the story base, `env.steps.workProduced()` resolves `true`.
- [integration] In the same fixture with only `report.md` written at `sc.reportPath`, `env.steps.workProduced()` resolves `true`.
- [integration] In the same fixture after a commit that changes only a file under `.nax/`, `env.steps.workProduced()` resolves `false`.

### US-003

- [integration] With `_workflowResumeDeps.mode` set to `"fresh"`, `buildStoryEnv` with a seeded mid-loop prior record (`phase: "fix"`, `round: 2`) returns `env.resume` `null` and logs an info entry "Ignoring a prior run's workflow record (resume mode fresh)" with the story id.
- [integration] With `_workflowResumeDeps.mode` set to `"no-resume"`, `buildStoryEnv` with the same seeded prior record returns `env.resume` `null`.
- [integration] With `_workflowResumeDeps.mode` at its default, `buildStoryEnv` with the same seeded prior record returns `env.resume.round` `2`.
- [integration] With `_workflowResumeDeps.mode` set to `"fresh"`, `buildStoryEnv` writes a story record with `round: 0` and `phase: "implement"`, and the ledger has no "resumed at round" line.
- [integration] With `_workflowResumeDeps.mode` set to `"fresh"` and a seeded prior record at `phase: "implement"` (which never resumes), `buildStoryEnv` logs no "Ignoring a prior run's workflow record" entry.
- [integration] `run()` called with `resumeMode: "fresh"` and a feature dir, whose setup phase throws, leaves `_workflowResumeDeps.mode` equal to its value before the call.
- [integration] `run()` called with `resumeMode: "fresh"` and a feature dir sets `_workflowResumeDeps.mode` to `"fresh"` before the setup phase runs (observed from a faked setup phase).
- [unit] `createSessionRunHop` with options whose resolved coding-tool support has `declaredTools` `["Read", "Grep"]` calls `sessionManager.openSession` with options whose `declaredTools` equals `["Read", "Grep"]`.
- [unit] When the resolved coding-tool support has no `declaredTools`, the `openSession` options have no `declaredTools` key.
- [unit] When the resolved support carries both `declaredTools` and `acpSandbox`, the `openSession` options carry both `declaredTools` and `sandbox`.

### US-004

- [integration] `runWorkflowPreflight` with workflow pre-flight enabled, one pending story, and `input.runtime.dispatchEvents` emitting one event `{ sessionRole: "advisor", exactCostUsd: 0.3, tokenUsage: { inputTokens: 10, outputTokens: 5 } }` from the faked advisor call writes this run's `result.json` with `preflightTokensByRole.advisor` equal to `{ inputTokens: 10, outputTokens: 5, costUsd: 0.3, calls: 1 }`.
- [integration] `runWorkflowPreflight` whose pre-flight dispatches nothing creates no `result.json` in this run's directory.
- [unit] An event emitted on `input.runtime.dispatchEvents` after `runWorkflowPreflight` returns does not change `preflightTokensByRole`.
- [unit] `upsertStoryRecord` on a `result.json` that holds `preflightTokensByRole` keeps it unchanged.
- [unit] `upsertFeatureRecord` on a `result.json` that holds `preflightTokensByRole` keeps it unchanged.
- [unit] `buildWorkflowRunSummary` on a result with one story at `advisor` $0.1, a feature record at `advisor` $0.2 and `preflightTokensByRole.advisor` $0.3 returns one `advisor` role row whose `costUsd` is 0.6.
- [unit] `buildWorkflowRunSummary` on a result without `preflightTokensByRole` returns the same `roles` as before this change.
- [unit] When `writePreflightTokens` throws, `runWorkflowPreflight` still resolves and logs the "Pre-flight done" entry.
- [integration] When the pre-flight advisor call emits one `advisor` dispatch event and then `runPreflight` throws, `runWorkflowPreflight` resolves and this run's `result.json` holds `preflightTokensByRole.advisor` with `calls: 1`.
- [integration] `handleRunCompletion` with `deferRunCompleteLog: true` and a cost aggregator whose `byStage()` gains a `review` entry after the call returns, then `logRunComplete(final)`, logs `run.complete` with `costByStage.review` present.
- [integration] In that run, when the aggregator's stage snapshots' `totalCostUsd + totalErrorCostUsd` sum to `final.totalCost`, the logged `costByStage` entries' `totalCostUsd + totalErrorCostUsd` sum to the logged `totalCost`.
- [integration] `handleRunCompletion` without `deferRunCompleteLog` logs `costByStage` from the aggregator as read during the call (pipeline-mode behaviour unchanged).
- [unit] `logRunCompletion` given `aggByStory` with keys `""` and `"US-001"` logs `costByStory` with keys `_run` and `US-001` and no `""` key.
- [unit] `backfillDomain` with `aggregatorKeys` `["", "US-001"]` returns a domain without `""`.
- [integration] `handleRunCompletion` with an aggregator whose `byStory()` holds `""` at $0.2983 and no story metrics produces no `storyMetrics` entry with `storyId: ""`.

### US-005

- [unit] `dedupeOutOfScope` on 30 distinct entries returns all 30.
- [unit] `dedupeAndCap` on 30 distinct entries returns the first 25, as today.
- [unit] `propagateOutOfScopeToStories` with 25 feature-level entries and a story carrying 2 story-specific entries gives that story 27 entries: the 25 feature-level ones first, then the 2 story-specific ones in their order.
- [unit] `propagateOutOfScopeToStories` with 1 feature-level entry and a story carrying 25 story-specific entries gives that story 26 entries with the feature-level entry first.
- [unit] `propagateOutOfScopeToStories` with 30 feature-level entries gives a story with no story-specific entries exactly the first 25 feature-level ones.
- [unit] A story-specific entry that equals a feature-level entry on canonical form appears once in the propagated list.
- [unit] A story-specific entry `"None."` is dropped from the propagated list.
- [unit] `stripPropagatedOutOfScope(propagateOutOfScopeToStories(prd))` equals `prd` for a PRD with 25 feature-level entries and stories carrying 1, 2, 0 and 5 story-specific entries.
- [integration] `savePRD` after `loadPRD` of a `prd.json` with 25 feature-level entries and a story carrying 5 story-specific entries writes the story's `outOfScope` with all 5 entries.

### US-006

- [unit] `buildSandboxPolicy` for root `/repo` returns `denyWrite` containing `/repo/.claude/settings.json` (through the same `realOrRaw` resolution as the other entries).
- [unit] `buildSandboxPolicy` for root `/repo` returns `denyWrite` containing `/repo/.claude/settings.local.json`.
- [unit] Those two entries are present when `/repo/.claude/` does not exist.
- [unit] Those two entries are present for `platform: "linux"` and for `platform: "darwin"`.
- [unit] `/repo/.claude` itself is not an entry of `denyWrite`.
- [unit] `sandboxSentence("open", true, "darwin")` ends with "On macOS the sandbox also refuses ps and other setuid programs ("Operation not permitted"), so a test that shells out to ps fails here for that reason alone."
- [unit] `sandboxSentence("open", true, "linux")` equals `sandboxSentence("open", true)`.
- [unit] `sandboxSentence("open", false, "darwin")` names "this run's temp directory ($TMPDIR)" and ends with the darwin sentence.
- [unit] With `bashApproval: "gated"`, an available sandbox launcher state and `_bashToolDeps.platform` returning `"darwin"`, the Bash tool's description ends with the darwin sentence.
- [unit] With `bashApproval: "gated"`, an available sandbox launcher state and `_bashToolDeps.platform` returning `"linux"`, the Bash tool's description ends with "-- that is the sandbox, not a bug in your command.".
- [unit] With `bashApproval: "raw"`, an available sandbox launcher state and `_bashToolDeps.platform` returning `"darwin"`, the Bash tool's description includes the darwin sentence.
- [unit] With an available sandbox launcher state and `_runCommandToolDeps.platform` returning `"darwin"`, the RunCommand tool's description includes the darwin sentence.

### US-007

- [unit] `parseClosingIssues("Closes: #2508, #2507")` returns `[2508, 2507]`.
- [unit] `parseClosingIssues("closes: #12 #13")` returns `[12, 13]`.
- [unit] `parseClosingIssues` on text with two `Closes:` lines `#5, #6` and `#6, #7` returns `[5, 6, 7]`.
- [unit] `parseClosingIssues("Closes: #12, koda#270, owner/repo#9, 14")` returns `[12]`.
- [unit] `parseClosingIssues` on text whose only `Closes: #12` line sits inside a fenced code block returns `[]`.
- [unit] `parseClosingIssues` on prose that mentions "since #2491" with no `Closes:` line returns `[]`.
- [unit] `buildWorkflowPrBody` with `closes: [2508, 2507]` renders a `## Closes` section with the lines "Closes #2508" and "Closes #2507" in that order, directly after the `## Summary` section and before `## Stories`.
- [unit] `buildWorkflowPrBody` with `closes: [7]` and facts large enough that the body is cut to `PR_BODY_MAX_CHARS` still includes "Closes #7".
- [unit] `buildWorkflowPrBody` with `closes: []` returns the same string as with `closes` absent.
- [integration] `publish` on a publishable branch with a forge, where `_workflowDeps.resolveFeatureSpec` resolves a spec file holding "Closes: #41, #42", calls `_featureDeps.openDraftFinishPr` with a body that has the lines "Closes #41" and "Closes #42".
- [integration] `publish` where `_workflowDeps.resolveFeatureSpec` rejects calls `_featureDeps.openDraftFinishPr` with a body that has no "## Closes" section.
- [integration] `publish` where `_workflowDeps.resolveFeatureSpec` resolves `{ specSource: null }` calls `_featureDeps.openDraftFinishPr` with a body that has no "## Closes" section.
- [integration] `publish` where the resolved spec path does not exist on disk calls `_featureDeps.openDraftFinishPr` with a body that has no "## Closes" section.
