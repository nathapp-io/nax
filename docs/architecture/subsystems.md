# Subsystems — nax

> §17–§57: Pipeline, execution, TDD, acceptance, verification, routing, plugins,
> runtime, managers, operations, post-run curator, config, logger, log-format,
> CLI, commands, optimizer, plan, precheck, project, findings, prompts, analyze, utils,
> native agent loop, coding tools, permissions & approvals, OS sandbox,
> command-safety shadow, MCP.
> Part of the [Architecture Documentation](ARCHITECTURE.md).
>
> _Last updated: 2026-09-25 (v0.82.1)._

---

## §17 Pipeline Architecture

### Execution Flow

```
Runner.run()  [src/execution/runner.ts — thin orchestrator]
  → runSetupPhase()     [lifecycle/run-setup.ts]
    → loadPlugins(), initLogger(), crash handlers
  → runExecutionPhase() [runner-execution.ts]
    → for each story (sequential or parallel):
      → UnifiedExecutor.execute()  [unified-executor.ts]
        → Pipeline stages 1–8 (defaultPipeline)
        → executionStage delegates per-story work to
          StoryOrchestratorBuilder.CANONICAL_ORDER (story-orchestrator/)
        → Escalation on failure (fast → balanced → powerful)
  → runCompletionPhase() [lifecycle/run-completion.ts]
    → postRunPipeline (acceptance)
    → hooks, metrics, cleanup
```

### Pipeline Stages (8 default + 1 pre-run + 1 post-run = 10 total)

**Default pipeline** (8 stages, per-story — `src/pipeline/stages/index.ts` `defaultPipeline`; ADR-023 / issue #1116 removed the standalone verify/rectify/review/autofix/regression stages — those now run inside `executionStage`):

| # | Stage | File | Purpose |
|:--|:------|:-----|:--------|
| 1 | `queueCheck` | `queue-check.ts` | Detect queue commands (PAUSE/ABORT/SKIP) |
| 2 | `routing` | `routing.ts` | Classify complexity → model tier (keyword/LLM/plugin) |
| 3 | `constitution` | `constitution.ts` | Load project coding standards/governance doc |
| 4 | `context` | `context.ts` | Auto-detect + gather relevant code/docs within token budget |
| 5 | `prompt` | `prompt.ts` | Assemble story + context + constitution into prompt |
| 6 | `optimizer` | `optimizer.ts` | Reduce token usage while preserving semantics |
| 7 | `execution` | `execution.ts` | Run the per-story orchestrator: test-writer → greenfield-gate → implementer → test-presence-gate → full-suite-gate → mutation-check → verifier → verify-scoped → lint-check → typecheck-check → semantic-review → adversarial-review, plus `runFixCycle` fix strategies. See §19 / story-orchestrator `CANONICAL_ORDER`. |
| 8 | `completion` | `completion.ts` | Mark complete, fire hooks, save metrics |

> **Per-story phases live in `src/execution/story-orchestrator/` (`CANONICAL_ORDER` in `types.ts`, builder in `builder.ts`), not in standalone pipeline stages.** `executionStage` builds a `StoryOrchestratorBuilder` whose `CANONICAL_ORDER` sequences the phases above; see [story-orchestrator-flow.md](story-orchestrator-flow.md). Verification flows via Operations (`verifyScopedOp` / `fullSuiteGateOp`); fixes flow via `runFixCycle` (`src/findings/`). Formatting is reactive (the `mechanical-formatfix` fix strategy), not a dedicated stage.

**Pre-run pipeline** (before story loop):

| Stage | File | Purpose |
|:------|:-----|:--------|
| `acceptanceSetup` | `acceptance-setup.ts` | Generate acceptance tests, run RED gate |

**Post-run pipeline** (after all stories):

| Stage | File | Purpose |
|:------|:-----|:--------|
| `acceptance` | `acceptance.ts` | Run feature-level acceptance tests |

### Stage Contract

```typescript
interface PipelineStage {
  name: string;
  enabled(ctx: PipelineContext): boolean;
  skipReason?(ctx: PipelineContext): string;
  execute(ctx: PipelineContext): Promise<StageResult>;
}
```

### StageResult Actions

| Action | Meaning |
|:-------|:--------|
| `continue` | Proceed to next stage |
| `skip` | Skip this stage (with reason) |
| `fail` | Story failed — stop pipeline |
| `escalate` | Escalate to higher model tier |
| `pause` | Pause execution (human-in-the-loop) |
| `retry` | Retry current stage |

### PipelineContext

The shared mutable state passed through all stages (`src/pipeline/types.ts`; extends `DispatchContext`). Acts as the single source of truth (SSOT) for config, paths, and story state — downstream helpers such as `buildStoryContextFullFromCtx` accept it directly instead of positional args.

**Path fields (resolved at context creation — never mutated by stages):**

| Field | Description |
|:------|:------------|
| `projectDir` | Absolute path to repo root where `.nax/` lives. Stable across worktree and monorepo mode. Used as the prompt audit base dir (fast path — no parent-dir walk). |
| `workdir` | Agent-spawn working directory. Equals `projectDir` for single-package repos; `join(projectDir, story.workdir)` when the story targets a monorepo sub-package. In worktree mode the base is `.nax-wt/<worktreeId>/`. Code that needs the repo root must use `projectDir` — never re-join `story.workdir` onto this value. |

**Config fields:**

| Field | Description |
|:------|:------------|
| `config` | Always the effective merged config for this story (global → project → per-package). Use for execution decisions, feature flags, timeouts. |
| `rootConfig` | The global project config — use only for `agent.default` (ADR-012), `models`, and `autoMode.escalation`. Never use for per-package overrides. |

**Stage inputs:** `prd`, `story`, `stories`, `routing`, `hooks`, `plugins`

**Intermediate results:** `constitution`, `contextMarkdown`, `builtContext`, `prompt`, `agentResult`, `acceptanceFailures`, `tddFailureCategory`, `fullSuiteGatePassed`, `reviewFindings` (canonical `Finding[]` — there is no `verifyResult` / `reviewResult` field)

For three-session TDD, the full-suite gate runs after implementer and before verifier. If rectification exhausts for attributable failures, the orchestrator stops before verifier and sets `tddFailureCategory: "full-suite-gate-exhausted"` with `fullSuiteGatePassed: false`.

**Autofix state:** `retrySkipChecks` — set of check names (e.g. `"lint"`, `"semantic"`) that passed during a prior autofix cycle and should be skipped on the next review retry. Accumulated across partial-progress cycles; cleared implicitly when the story completes.

**Metadata:** `storyStartTime`, `rectifyAttempt`, `storyGitRef`, `accumulatedAttemptCost`, `reviewFindings`

---

## §18 Execution Modes & Batching

### Execution Strategies

| Strategy | Description | Key file |
|:---------|:-----------|:---------|
| Sequential | One story at a time, optional per-story worktree isolation (EXEC-002) | `iteration-runner.ts`, `pipeline-result-handler.ts` |
| Parallel | Independent stories run concurrently, each in its own git worktree | `parallel-batch.ts`, `parallel-worker.ts` |
| Batching | Consecutive simple-complexity stories grouped into one agent session | `batching.ts` |

### Sequential Worktree Isolation (EXEC-002)

When `execution.storyIsolation === "worktree"`, each story in sequential mode gets its own git worktree:

```
Per-story worktree lifecycle (worktreeId = deriveStoryWorktreeId(feature, storyId), see §30):
1. Create .nax-wt/<worktreeId> via git worktree add (at story start)
2. Execute story in isolated worktree (no cross-story state leakage)
3. Merge to main (if successful)
4. Remove worktree directory via git worktree remove (reclaim disk)
5. Keep branch nax/<worktreeId> for diagnostics and re-run cleanup
```

`src/execution/pipeline-result-handler.ts`:
- `handlePipelineSuccess()` — marks story passed, captures diff summary, records metrics, removes worktree
- `handlePipelineFailure()` — manages escalation, merging, pausing; records a `refs/nax/orphan/<worktreeId>` ref after a non-conflict merge failure
- `removeWorktreeDirectory()` (internal) — removes `.nax-wt/<worktreeId>` from git worktree tracking (preserves branch)

### Parallel Execution Flow

```
UnifiedExecutor → runParallelBatch()        [parallel-batch.ts]
  → creates WorktreeManager (git worktrees)
  → executeParallelBatch() / executeStoryInWorktree()  [parallel-worker.ts]
      → each story runs the pipeline in its own worktree
  → MergeEngine merges changes back in dependency order
  → rectification pass for merge conflicts (merge-conflict-rectify.ts)
```

### Escalation

`src/execution/escalation/tier-escalation.ts`:
- Retries failed stories at higher tiers: `fast → balanced → powerful`
- `tier-outcome.ts` / `max-attempts-outcome.ts` decide the next action per tier
- Per-tier attempts come from `autoMode.escalation.tierOrder` (default `{ tier, attempts: 2 }` for each of fast / balanced / powerful); `autoMode.escalation.enabled` defaults to `true`

### Crash Recovery

| Component | File | Purpose |
|:----------|:-----|:--------|
| Heartbeat | `crash-heartbeat.ts` | Detect hung processes |
| Signal handlers | `crash-signals.ts` | SIGTERM/SIGINT cleanup |
| Status writer | `crash-writer.ts` | Atomic state persistence |
| PID registry | `pid-registry.ts` | Track spawned child processes for cleanup |
| Lock file | `lock.ts` | Prevent concurrent runs |

### Lifecycle Phases

`src/execution/lifecycle/`:

| Phase | File | Purpose |
|:------|:-----|:--------|
| Setup | `run-setup.ts` | Load PRD, init loggers, crash handlers |
| Init | `run-initialization.ts` | Reconcile story state, resume from crash, review re-run for reconciled stories |
| Completion | `run-completion.ts` | Final metrics, hooks, cleanup |
| Cleanup | `run-cleanup.ts` | Remove temp files, worktrees |
| Regression | `run-regression.ts` | Full-suite regression after all stories |
| Acceptance | `acceptance-loop.ts` | Feature-level acceptance test loop |
| Paused prompts | `paused-story-prompts.ts` | Interactive re-run prompts for paused stories (resume, skip, keep paused) |

---

## §19 TDD Orchestration

### Three-Session TDD Workflow

The three TDD sessions are typed Operations (`testWriterOp`, `implementerOp`,
`verifierOp` in `src/operations/`; `writeTddTestOp` / `implementTddOp` /
`verifyTddOp` are aliases), sequenced by the per-story orchestrator
(`src/execution/story-orchestrator/` — `CANONICAL_ORDER`). There is no
`src/tdd/orchestrator.ts`; `src/tdd/` holds isolation, verdict, rollback, and
cleanup helpers only (and re-exports the three ops).

```
Session 1: test-writer  → writes tests only (no src/ changes)
Session 2: implementer  → implements code (no test changes)
Session 3: verifier     → runs full suite, confirms pass
```

### Session Roles & Isolation

| Role | Allowed changes | ACP session naming |
|:-----|:---------------|:-------------------|
| `test-writer` | Test files only | `nax-<hash>-<feature>-<story>-test-writer` |
| `implementer` | Source files only | `nax-<hash>-<feature>-<story>-implementer` |
| `verifier` | All files (read + verify) | `nax-<hash>-<feature>-<story>-verifier` |

Isolation is checked via `src/tdd/isolation.ts` (`verifyTestWriterIsolation` /
`verifyImplementerIsolation`, `git diff` between sessions). The mechanical checks are
**advisory** — they detect which files changed but cannot judge legitimacy (a `src/`
stub may be required); the verifier's verdict is what rejects test tampering.

### TDD Lite Mode

Skips strict file isolation for performance. Test-writer may add src/ stubs; implementer may expand test coverage.

### Failure Categories

| Category | Meaning |
|:---------|:--------|
| `isolation-violation` | Test-writer violated isolation / created no tests. Routed and rolled back, but no producer currently emits it (the mechanical checks are advisory) |
| `session-failure` | Agent session crashed or timed out |
| `tests-failing` | Tests still fail after all sessions |
| `test-incorrect` | Verifier found test assertions that conflict with otherwise-met acceptance criteria |
| `full-suite-gate-exhausted` | Full-suite gate failed for attributable failures and rectification exhausted before verifier |
| `verifier-rejected` | Verifier explicitly rejected the implementation |
| `greenfield-no-tests` | Greenfield project with no test files — TDD not applicable (BUG-010) |
| `no-tests-authored` | Single-session implementer authored no test files — re-runs implementer with a test directive |
| `review-incomplete` | A configured review phase (semantic / adversarial) never ran before the verdict |
| `dependency-prep` | Worktree dependency preparation failed before pipeline execution |
| `runtime-crash` | Unrecoverable runtime error |

`FailureCategory` is owned by `src/execution/types.ts` and re-exported from `src/tdd/types.ts`.

### Verdict System

`src/tdd/verdict.ts` + `verdict-reader.ts`:
- The verifier writes a structured `VerifierVerdict` (`approved`, `tests`, `testModifications`, optional `testFailureDiagnosis`, …) to `.nax-verifier-verdict.json` (`VERDICT_FILE`); `readVerdict` / `isValidVerdict` load it
- `coerceVerdict()` maps free-form agent output (`verdict: "PASS"` / `"APPROVED"` / `"VERIFIED…"`) onto the schema; `allPassing` is only ever set from real test evidence
- `categorizeVerdict(verdict, testsPass)` turns the verdict into a `FailureCategory`

---

## §20 Acceptance Test System

### Overview

`src/acceptance/` holds the deterministic helpers; every LLM call is an Operation in `src/operations/` (§37):
- **Generator** (`generator.ts` + `generator-helpers.ts`): Parse AC → generate test skeleton (unit, component, e2e, CLI, snapshot); LLM generation via `acceptanceGenerateOp`
- **Refinement** (`refinement.ts`): parses the `acceptanceRefineOp` response that rewrites AC text into testable assertions
- **Fix diagnosis** (`fix-diagnosis.ts`): `loadSourceFilesForDiagnosis()` feeds `acceptanceDiagnoseOp`
- **Fix execution** (`acceptanceFixSourceOp` / `acceptanceFixTestOp`): driven by `runFixCycle` from the acceptance retry loop (`src/execution/lifecycle/acceptance-loop.ts`), which also regenerates the test file when failures look test-level
- **Hardening** (`hardening.ts`): non-blocking pass that tests plan-suggested criteria after acceptance passes and promotes the passing ones

### Templates

`src/acceptance/templates/`:

| Template | File | Use case |
|:---------|:-----|:---------|
| Unit | `unit.ts` | Pure function testing |
| Component | `component.ts` | React Testing Library |
| E2E | `e2e.ts` | Playwright browser tests |
| CLI | `cli.ts` | Command-line tool testing |
| Snapshot | `snapshot.ts` | Output stability |

### RED Gate

The `acceptanceSetupStage` generates tests and verifies they fail (RED) before implementation. This ensures tests are meaningful — they don't accidentally pass without the feature being implemented.

---

## §21 Verification & Test Runners

### Module layout

`src/verification/` is a flat utility module (no `orchestrator.ts`, no
`strategies/` directory). Per-story verification is now driven by Operations —
`verifyScopedOp` (`src/operations/verify-scoped.ts`) and `fullSuiteGateOp`
(`src/operations/full-suite-gate.ts`) — sequenced by the story orchestrator (§17/§19).

| File | Purpose |
|:-----|:--------|
| `executor.ts` | `executeWithTimeout()`, `buildTestCommand()`, environment normalization |
| `runners.ts` | Verification gates: `fullSuite()`, `scoped()`, `regression()`, `verifyAssets()` |
| `smart-runner.ts` | Scoped test selection (`mapSourceToTests`, `buildSmartTestCommand`, changed-file detection) |
| `rectification.ts` | `shouldRetryRectification()` retry-decision helper |
| `crash-detector.ts` | `detectRuntimeCrash()` — detect runtime crashes in test output |
| `failure-records.ts` | `buildFailureRecords()` |
| `test-baseline.ts` | Run / per-story test baselines (`writeRunBaseline`, `resolveStoryBaseline`, `applyBaselineDispositions`) — separates pre-existing failures from story-attributable ones |
| `flake-triage.ts` / `flake-probe.ts` | Run-scoped flaky-test quarantine: a failing test is quarantined only when it is outside the story diff **and** an isolated re-run passes; memoised in `runtime.quarantineMemo` |
| `changed-line-ranges.ts` | `getChangedLineRanges()` for diff-scoped checks |
| `mutation/` | Mutation testing behind the `mutation-check` phase (`mutationCheckOp`) — operators, selection, apply, classify, journal |

### Smart Runner

`src/verification/smart-runner.ts`:
- Analyzes git diff to identify changed files
- Maps changed files to relevant test files
- Runs only the scoped subset for faster feedback

### Test Runners Module (SSOT)

`src/test-runners/` — centralized test output parsing extracted from `src/verification/parser.ts`:

| File | Purpose |
|:-----|:--------|
| `types.ts` | `TestFailure`, `TestSummary`, `TestOutputAnalysis` types |
| `detector.ts` | `detectFramework()` — identifies test runner (Bun, Jest, Vitest, etc.); `isTestFile()` |
| `parser.ts` | `parseTestOutput()`, `parseBunTestOutput()`, `formatFailureSummary()`, `analyzeTestExitCode()` (framework parsers in `parse-bun.ts`, `parse-mocha.ts`, `parse-rust.ts`) |
| `ac-parser.ts` | `parseTestFailures()` / `parseTestFailuresDetailed()` — AC-ID extraction for the acceptance loop |
| `resolver.ts` | `resolveTestFilePatterns()` — SSOT for "which files are tests" (ADR-009): per-package config → root `execution.smartTestRunner.testFilePatterns` → detection → defaults |
| `classifier.ts` | `createTestFileClassifier(resolved)` — sync `(path) => boolean` predicate |
| `conventions.ts` | `DEFAULT_TEST_FILE_PATTERNS` and glob/regex helpers |
| `scoped-selection.ts` | `selectScopedTests()`, `buildScopedCommand()` — scoped-test selection incl. monorepo orchestrators |
| `detect/` | Framework config detection and workspace discovery |

All verification strategies and the rectification loop import from `test-runners` instead of maintaining their own parsing logic.

### Rectification / Fix Cycle

The standalone `rectification-loop.ts` is gone. Auto-fix of failing tests and
review findings now runs through the three-layer fix cycle (`runFixCycle` in
`src/findings/cycle.ts`, ADR-021/022), driven by the story orchestrator via
fix strategies (mechanical lint/format fix, autofix implementer, autofix
test-writer). Failures are carried as canonical `Finding[]` (see below), not a
bespoke `VerifyResult`.

`src/verification/rectification.ts` — shared retry helper:
- `shouldRetryRectification(state, config)` — retry decision logic (attempt count,
  failure count, spiral detection); re-exports `RectificationState`.

### Findings (canonical result type)

Verification and review results flow as `Finding[]` from `src/findings/` (there
is no `VerifyResult` type). Each `Finding` carries a `fixTarget` (`"source"` /
`"test"`) that tells the fix cycle where the fix should land:

```typescript
// src/findings/types.ts
export interface Finding {
  // …id, severity, message, file, source (verify | lint | typecheck | semantic | adversarial)…
  fixTarget?: FixTarget;   // where the fix LANDS, not what produced the finding
}
```

### Strategy → Op envelope mapping (issue #1116)

> Historical migration mapping. The `ScopedStrategy` / `RegressionStrategy`
> classes have been removed; only the right-hand op outputs
> (`VerifyScopedOutput` in `src/operations/verify-scoped.ts`,
> `FullSuiteGateOutput` in `src/operations/full-suite-gate.ts`) exist today. The
> table records how the old strategy fields were folded into the op envelopes.

`ScopedStrategy.VerifyResult` → `VerifyScopedOutput`:

| Strategy field | Op field | Notes |
|:---|:---|:---|
| `status: "PASS" \| "FAIL" \| "SKIPPED"` | `success` + `status: "passed" \| "failed" \| "skipped" \| "timeout"` | Op uses explicit status union |
| `rawOutput` | (in `findings` + log) | Raw output goes through findings + outcome log, not envelope |
| `passCount` | `passCount` | Same |
| `failCount` | (in `findings.length`) | Derived |
| `durationMs` | `durationMs` | Same |
| `scopeTestFallback` | `scopeTestFallback?: boolean` | New |
| `failures: StructuredTestFailure[]` | `findings: Finding[]` | Already converted via `testSummaryToFindings` |
| `countsTowardEscalation` | (in outcome log only) | Story-orchestrator decides escalation |

`RegressionStrategy.VerifyResult` → `FullSuiteGateOutput`:

| Strategy field | Op field | Notes |
|:---|:---|:---|
| `status: "PASS" \| "FAIL" \| "SKIPPED"` | `status: "passed" \| "failed" \| "skipped" \| "passed-on-timeout" \| "execution-failed"` | Op adds explicit timeout-accept status |
| acceptOnTimeout TIMEOUT → PASS | TIMEOUT → `status: "passed-on-timeout"`, `passed: true` | BUG-026 semantics preserved |
| `enabled: false` → SKIPPED | `status: "skipped"`, `success: true` | Same |

---

## §22 Routing & Classification

### Router

`src/routing/classify.ts` (classification) + `src/routing/router.ts` (tier mapping):

1. **`classifyComplexity()`** (`classify.ts`) — Keyword-based heuristic
   - Examines: story title, AC count, tags
   - Keywords: `COMPLEX_KEYWORDS`, `EXPERT_KEYWORDS`, `SECURITY_KEYWORDS`, `PUBLIC_API_KEYWORDS`
   - Output: `"simple"` | `"medium"` | `"complex"` | `"expert"`

2. **`determineTestStrategy()`** (`classify.ts`) — Decision tree
   - Inputs: complexity, title, AC, tags, `tddStrategy` config
   - tddStrategy: `"auto"` (default), `"strict"`, `"lite"`, `"simple"`, `"off"`
   - Output: `test-after`, `tdd-simple`, `three-session-tdd`, `three-session-tdd-lite`, `no-test`

3. **`complexityToModelTier(complexity, config)`** (`router.ts`) — Maps complexity → tier via `autoMode.complexityRouting`
   - Defaults: simple → fast, medium → balanced, complex/expert → powerful
   - An entry may be rung-qualified (`{ tier, agent }`); `complexityToRungAgent()` reads the agent

`resolveRouting()` / `routeStory()` (`router.ts`) run the priority chain below;
`src/routing/calibrate/` backs `nax routing calibrate`, and the built-in
`auto-route` plugin (`autoRoute` config, disabled by default) proposes tier
upgrades/downgrades from run history.

### Routing Strategies (Pluggable)

| Priority | Strategy | File |
|:---------|:---------|:-----|
| 1st | Plugin routers (`plugins.getRouters()`, first win) | Plugin system |
| 2nd | LLM classification (when `routing.strategy === "llm"`; `classifyRouteOp`) | `strategies/llm.ts` (+ `llm-cache.ts`, `llm-parsing.ts`) |
| 3rd | Keyword fallback (always available) | `router.ts` (internal) |

### RoutingResult

Stored in `ctx.routing`:

```typescript
// src/pipeline/types.ts
interface RoutingResult {
  complexity: "simple" | "medium" | "complex" | "expert";
  modelTier: "fast" | "balanced" | "powerful";
  testStrategy: "no-test" | "test-after" | "tdd-simple" | "three-session-tdd" | "three-session-tdd-lite";
  reasoning: string;
  estimatedCostUsd?: number;
  agent?: string;  // Agent override from story.routing.agent
}
```

---

## §23 Plugin System

### Plugin Interface

`src/plugins/types.ts`:

```typescript
interface NaxPlugin {
  name: string;
  version: string;
  provides: PluginType[];
  setup?(config: Record<string, unknown>, logger: PluginLogger): Promise<void>;
  teardown?(): Promise<void>;
  extensions: PluginExtensions;   // optimizer, router, agent, reviewer, contextProvider, reporter, postRunAction
}
```

### Extension Points (7 types)

| Type | Interface | Purpose |
|:-----|:----------|:--------|
| `optimizer` | `IPromptOptimizer` | Reduce token usage |
| `router` | `RoutingStrategy` | Custom complexity classification |
| `agent` | `AgentAdapter` | Custom coding agent |
| `reviewer` | `IReviewPlugin` | Custom quality checks |
| `context-provider` | `IContextProvider` | Inject external context |
| `reporter` | `IReporter` | Dashboard, CI integration |
| `post-run-action` | `IPostRunAction` | Post-run hooks |

### Plugin Lifecycle

```
loadPlugins() → plugin.setup(config, logger)
  → Pipeline executes → plugins invoked per extension point
  → plugin.teardown()
```

**Built-in plugins** (`src/plugins/builtin/`, registered by `loader.ts` with source type `builtin`):

| Plugin | Kind | Gate |
|:---|:---|:---|
| `curator` | post-run action | `curator.enabled` (default `true`) — §38 |
| `auto-pr` | post-run action | `autoPr.enabled` (default `false`) |
| `auto-route` | routing tuning | `autoRoute.enabled` (default `false`) |
| `webhook-reporter` / `otel-reporter` | reporters | `reporters.webhook.enabled` / `reporters.otel.enabled` — see `docs/superpowers/specs/2026-07-18-builtin-reporter-design.md` |

**Reference:** `src/plugins/registry.ts`, `src/plugins/loader.ts`

---

## §24 Context Engine & Constitution System

### Context Engine v2 (`src/context/engine/`)

Stage-aware, session-aware, pluggable context assembly. Single point of context
assembly for all pipeline stages. Spec: `docs/specs/SPEC-context-engine-v2.md`;
decision record: ADR-010. **User guide:** [docs/guides/context-engine.md](../guides/context-engine.md).

**Entry point:** `ContextOrchestrator.assemble(ContextRequest)` →
`ContextBundle { pushMarkdown, pullTools, digest, manifest, chunks }`.

**Pipeline (9 steps):**

1. Filter providers for this stage (`stageConfig.providerIds`).
2. Parallel `fetch()` with 5-second timeout per provider.
3. Score chunks (role × freshness × kind weights).
4. Deduplicate (character-level trigram Jaccard ≥ 0.9).
5. Role-filter (drop chunks whose audience tag mismatches `request.role`).
6. Min-score filter (`config.context.v2.minScore`, default 0.1).
7. Greedy pack (floor items first, then fill budget ceiling).
8. Render push markdown (scope-ordered: project → feature → story → session → retrieved).
9. Build digest (≤250 tokens, deterministic — threaded into the next stage's `priorStageDigest`).

**Provider contract — `IContextProvider`:** duck-typed, three fields —
`id: string`, `kind: ChunkKind`, `fetch(request): Promise<ContextProviderResult>`.
No base class; validated structurally at load time.

**Built-in providers (`src/context/engine/providers/`):**

| Provider | Source | Scope |
|:---------|:-------|:------|
| `StaticRulesProvider` | `.nax/rules/` — canonical, agent-agnostic markdown | `repo-scoped` |
| `FeatureContextProvider` | `context.md` — feature working memory | `repo-scoped` |
| `SessionScratchProvider` | per-session scratch dir | `package-scoped` |
| `GitHistoryProvider` | git log diffs — recent changes | `package-scoped` |
| `CodeNeighborProvider` | import graph — co-changed files | `package-scoped` (default) / `repo-scoped` scan via `neighborScope: "repo"` |
| `TestCoverageProvider` | coverage metrics | `package-scoped` |
| `LintConfigProvider` | package lint config via `detectProjectProfile()` (`lint-config` chunk) | package dir; chunk scope `project` |
| `PriorRunFailureProvider` | `<outputDir>/metrics.json` prior-run failures of this story (`prior-failure` chunk) | chunk scope `story` |
| `ToolDiagnosticsProvider` | lint/typecheck `tool-diagnostics` scratch entries (`diagnostics` chunk) | chunk scope `session` |
| Plugin providers (`PluginProvider`) | npm packages or project-relative paths | operator-registered |

**Hybrid push/pull model.** Push markdown is pre-injected on every stage. Pull
tools (`query_neighbor`, `query_feature_context`, `query_scratch`) are agent-callable
mid-session, opt-in via `config.context.v2.pull` (default `enabled: false`), capped by
`maxCallsPerSession` (default 5) and `maxCallsPerRun` (default 50).

**Availability fallback (ADR-010 D5).** On agent-availability failure,
`ContextOrchestrator.rebuildForAgent(prior, { newAgentId, failure })` re-renders
the existing bundle under the new agent's profile without re-fetching providers
and injects a synthetic failure-note chunk. Called by `AgentManager` during
swap (see §35).

**Auditability.** Every bundle emits a `ContextManifest` recording exactly which
chunks were included, excluded, and why. Persisted per story for post-hoc review.

**Barrel:** `src/context/engine/index.ts` exports `ContextOrchestrator`,
`IContextProvider`, all built-in providers, types (`ContextRequest`,
`ContextBundle`, `ContextChunk`, `RawChunk`, `ContextManifest`), and utilities
(`scoreChunks`, `dedupeChunks`, `packChunks`, `renderChunks`, `buildDigest`).

### Context v1 (Legacy)

`src/context/builder.ts` + `src/context/auto-detect.ts` remain for
backwards compatibility and fall-through when v2 is disabled. New code must use
the v2 engine; v1 is no longer the recommended entry point.

### Context Generators

`src/context/generators/` — per-agent context file generation:

| Agent | File | Output |
|:------|:-----|:-------|
| Claude | `claude.ts` | `CLAUDE.md` |
| Codex | `codex.ts` | Agent config |
| Cursor | `cursor.ts` | `.cursorrules` |
| Gemini | `gemini.ts` | Agent config |
| OpenCode | `opencode.ts` | Agent config |
| Aider | `aider.ts` | `.aider.conf` |
| Windsurf | `windsurf.ts` | Agent config |

Generators remain agent-facing shims over the canonical `.nax/rules/` store
consumed by `StaticRulesProvider`.

### Constitution

`src/constitution/`:
- Project-level governance document (coding standards, patterns, rules)
- `loader.ts` — loads `constitution.path` (default `constitution.md`) from the global config dir and the project `.nax/` dir
- `generator.ts` — generates constitution from project analysis
- `generators/` — per-agent constitution formatting (aider, claude, cursor, opencode, windsurf)

---

## §25 Review & Quality System

### Review Execution

There is no `src/review/orchestrator.ts`. Semantic and adversarial review run as
Operations — `semanticReviewOp` (`src/operations/semantic-review.ts`) and
`adversarialReviewOp` (`src/operations/adversarial-review.ts`) — sequenced by the
story orchestrator (§17/§19). `src/review/runner/index.ts` (`runReview()`) is the
shared review entry used outside the per-story op path; `src/review/semantic-helpers.ts`,
`semantic-evidence.ts`, `adversarial-helpers.ts` and `categorization.ts` hold the
review logic/helpers.

- Mechanical checks (lint, typecheck) run as their own ops (`lintCheckOp`,
  `typecheckCheckOp`); test/build run via the verification gates (§21).
- Plugin reviewers: deferred end-of-run review (`src/execution/deferred-review.ts`),
  observational by default — set `review.pluginMode: "gating"` to fail the run
  (per-story plugin gating removed, ADR-023 / #1146).
- Semantic and adversarial review can run concurrently when
  `review.adversarial.parallel: true` (default `false`), bounded by
  `review.adversarial.maxConcurrentSessions` (default 2).

### Semantic Review

`semanticReviewOp` (`src/operations/semantic-review.ts`) + `src/review/semantic-*.ts`:
- LLM-powered behavioral review against story acceptance criteria
- Configurable diff modes: `"ref"` (default — reviewer self-serves via git tools, no cap) or `"embedded"` (diff inlined in prompt, ~50KB cap)
- `resetRefOnRerun` (default `false`) clears `storyGitRef` on re-run

### Mechanical vs LLM Check Classification

Checks split into **mechanical** (typecheck, lint, build, format) and **LLM** (semantic, adversarial). When mechanical checks fail but LLM checks pass, `mechanicalFailedOnly: true` is set on the result — the fix cycle uses this to suppress tier escalation for unfixable mechanical issues (e.g., lint errors in test files the implementer cannot modify).

### Adversarial Review (REVIEW-003)

`adversarialReviewOp` (`src/operations/adversarial-review.ts`) + `src/review/adversarial-helpers.ts`:
- LLM-based adversarial code review, distinct from semantic review
- Semantic asks: "Does this satisfy the ACs?" / Adversarial asks: "Where does this break? What is missing?"
- Own ACP session (`reviewer-adversarial`), NOT the implementer session
- Default diffMode: `"ref"` (reviewer self-serves via git tools)
- Finding categories: `input`, `error-path`, `abandonment`, `test-gap`, `convention`, `assumption` (`input` / `error-path` / `abandonment` / `assumption` are blocking — `BLOCKING_CATEGORIES` in `src/review/category-fix-target.ts`)
- Configurable parallel/sequential execution
- **Scope-aware routing:** adversarial findings carry `fixTarget` (`"test"` / `"source"`); test-targeted findings are routed to the test-writer fix strategy (`src/operations/autofix-test-writer-strategy.ts`), source findings to the implementer fix strategy — never crossing the TDD isolation boundary

### Fix Cycle (ADR-021/022)

The standalone `src/pipeline/stages/autofix.ts` is gone. Fixing review/verify
findings now runs through `runFixCycle` (`src/findings/cycle.ts`), invoked by the
story orchestrator. It iterates a set of **fix strategies** against the current
`Finding[]` until they resolve or a budget/bail condition fires:

| Strategy | File (`src/operations/`) | Targets |
|:---|:---|:---|
| Mechanical lint fix | `mechanical-lintfix-strategy.ts` | lint findings via `lintFix` command |
| Mechanical format fix | `mechanical-formatfix-strategy.ts` | format findings via `formatFix` command |
| Autofix implementer | `autofix-implementer-strategy.ts` | source-targeted findings (implementer session) |
| Autofix test-writer | `autofix-test-writer-strategy.ts` | test-targeted findings (test-writer session) |

**Dual budgets** (`FixCycleConfig` in `src/findings/cycle-types.ts`): each strategy
has a per-strategy `maxAttempts` (from `execution.rectification.maxAttemptsPerStrategy`,
default 3); the cycle is bounded globally by `maxAttemptsTotal`
(`execution.rectification.maxAttemptsTotal`, default 12). `classifyOutcome(before, after)`
(`src/findings/classify-outcome.ts`) compares findings across iterations to detect progress
(`resolved` / `partial` / `unchanged` / `regressed` / `regressed-different-source` / `rotated`).

**Bail / escalation conditions:**
- A strategy hits its per-strategy `maxAttempts` cap → drops from the active set
- Global `maxAttemptsTotal` exhausted → cycle exits, story escalates
- No active strategy can make progress → cycle exits

### Implementer→test-writer feedback loop

When the implementer encounters a test that contradicts the PRD, it emits a
`TEST_EDIT_REASON: prd_contract` block in its rectification output. The block is
parsed into a `TestEditDeclaration` (see `src/operations/test-edit-declaration.ts`)
and stashed on `ctx.testEditDeclarations` by the implementer strategy's
`extractApplied`. The cycle's `validate()` hook applies these declarations to
fresh findings: each declaration whose `PRD_QUOTE` is verbatim-present in the
story description or AC text causes a finding on the declared file to be
re-tagged from `fixTarget: "source"` to `"test"`. The test-writer strategy
claims the re-tagged finding on the next iteration.

The re-tag is gated on `isThreeSession` (`allowTestRetag`). `fixTarget: "test"`
exists to hand a finding to the test-writer, and `autofix-test-writer` — its only
claimer — is registered only for three-session strategies. A single-session
implementer (`tdd-simple` / `test-after` / `no-test`) owns both source and tests,
so there is no handoff to make: the declaration is informational and the finding
stays `fixTarget: "source"` for the implementer to claim and edit the test
itself. Re-tagging there would strand it with no claimer (#1330).

Declarations with fabricated
PRD quotes do not re-tag, and are reported as a `prd_quote_mismatch`
`DeclarationDiagnostic` that the `postValidate` caller logs at warn — never as a
finding. The non-re-tag *is* the enforcement; a diagnostic carries no fix, and
the findings stream is the cycle's work queue, so every entry in it must be
claimable by some strategy's `appliesTo`. An unclaimable finding makes
`selectActiveStrategies` return `[]` and the cycle exit `no-strategy`, failing a
story whose gates all passed (#1327). The same rule applies to invalid
`mock_structure` handoffs.

The test-writer strategy's `maxAttempts` follows
`execution.rectification.maxAttemptsPerStrategy` like every other strategy.

This wiring is internal to the fix cycle (`runFixCycle`, §Fix Cycle above).

### Review Audit Trail

`src/review/review-audit.ts`:
- Runtime-owned JSON audit writer for semantic and adversarial reviewer decisions
- Directory: `<outputDir>/review-audit/<featureName>/<epochMs>-<sessionName>.json` (falls back to `<projectRoot>/.nax/review-audit/…` when no output dir is known); enabled by `review.audit.enabled` (default `false`)
- Captures sessionName/sessionId/recordId from reviewer dispatch events
- Tracks parse success, `looksLikeFail`, fail-open, threshold, and structured result
- Errors warn but never throw — audit failures cannot interrupt a run

### Diff Utilities (SSOT)

`src/review/diff-utils.ts` — shared diff utilities for semantic + adversarial:
- `collectDiff()` — git diff with configurable `excludePatterns`
- `collectDiffStat()` — diff --stat summary
- `computeTestInventory()` — test file audit for adversarial review
- `truncateDiff()` — 50KB cap for embedded mode
- `resolveEffectiveRef()` — BUG-114 ref fallback chain (supplied ref → merge-base → undefined)

### Quality Runner

`src/quality/runner.ts`:
- `runQualityCommand()` executes lint, typecheck, build, lintFix commands (project-declared, run through a shell)
- Supports command chaining and failure handling

### Quality Test Command Resolver (SSOT)

`src/quality/command-resolver.ts`:
- `resolveQualityTestCommands()` — single source of truth for test command resolution across the pipeline
- Priority: `review.commands.test` ?? `quality.commands.test`
- `{{package}}` substitution in `testScoped` template for monorepo stories
- Monorepo orchestrator promotion (turbo/nx filter syntax replaces per-file expansion)
- Scope file threshold tracking (`quality.scopeTestThreshold`, default 10)

---

## §26 Interaction & Human-in-the-Loop

### Interaction Chain

`src/interaction/chain.ts`:
- Multi-plugin support with priority ordering
- First responsive plugin wins

### Triggers

`src/interaction/triggers.ts`:

`TriggerName` (`src/interaction/types.ts`), with default fallback:

| Trigger | Fires when | Default fallback |
|:--------|:-----------|:-----------------|
| `security-review` | Critical security issues found | abort |
| `cost-exceeded` | Cost limit exceeded | abort |
| `merge-conflict` | Git merge conflict detected | abort |
| `cost-warning` | Cost approaching threshold | escalate |
| `max-retries` | Retry limit reached | skip |
| `pre-merge` | Before merging to main | escalate |
| `human-review` | Human review required on max retries / critical failure | skip |
| `story-oversized` | Story has too many acceptance criteria | continue |
| `review-gate` | Code review checkpoint | continue |

### Interaction Bridge

`src/interaction/bridge-builder.ts`:
- Builds the `interactionBridge` (`detectQuestion` / `onQuestionDetected`) from the chain
- Prompts user, captures response
- Re-injects response into the agent session (multi-turn)

### Permission asks

The interaction chain is also the human channel for the permission ask tier (§54):
`ask-link.ts` renders an `AskRequest` into an interaction request (the human link
of the ask chain), and `dispatch-ask.ts` (`buildDispatchAskWiring` /
`buildRunDispatchAskWiring`) attaches the ask resolver and the command-safety shadow
(§56) to every Bash-dispatching `CallContext`. The `interaction` config section is
root-only.

### Plugins

`src/interaction/plugins/`:
- **CLI** (`cli.ts`): terminal prompts
- **Telegram** (`telegram*.ts`): bot-based approvals
- **Webhook** (`webhook*.ts`): external webhook for responses

---

## §27 Hooks & Lifecycle

### Hook Events (12 types)

`src/hooks/types.ts` (`HOOK_EVENTS`):

| Event | Fires when |
|:------|:-----------|
| `on-start` | Run begins |
| `on-story-start` | Story execution starts |
| `on-story-complete` | Story passes all stages |
| `on-story-fail` | Story fails |
| `on-pause` | Execution paused (queue or interaction) |
| `on-resume` | Execution resumes |
| `on-session-end` | Agent session closes |
| `on-all-stories-complete` | All stories processed |
| `on-complete` | Run finishes successfully |
| `on-error` | Unrecoverable run error |
| `on-final-regression-fail` | Post-run regression fails |
| `on-post-run-action` | A registered post-run action settles (success, failure, skip, or error) |

### Hook Definition

```typescript
interface HookDef {
  command: string;       // Shell command to execute
  timeout?: number;      // Max execution time (ms, default 5000)
  enabled?: boolean;     // Toggle (default true)
  interaction?: {        // v0.15.0+ interactive hooks
    type: "confirm" | "choose" | "input" | "review" | "notify";
    // ...
  };
}
```

### HookContext

Passed to each hook script via environment/stdin:

```typescript
interface HookContext {
  event: HookEvent;
  feature: string;
  storyId?: string;
  status?: string;
  reason?: string;
  cost?: number;
  model?: string;
  agent?: string;
  iteration?: number;
  failedTests?: number;
  affectedStories?: string[];
  subStoryCount?: number;
  pluginName?: string;
  actionName?: string;
  url?: string;
}
```

---

## §28 Metrics & Cost Tracking

### Story Metrics

`src/metrics/types.ts` (collected by `src/metrics/tracker.ts`), abridged:

```typescript
interface StoryMetrics {
  storyId: string;
  complexity: string;
  initialComplexity?: string;
  modelTier: string;
  modelUsed: string;
  agentUsed?: string;
  attempts: number;
  finalTier: string;
  success: boolean;
  cost: number;
  errorCostUsd?: number;
  durationMs: number;
  firstPassSuccess: boolean;
  startedAt: string;
  completedAt: string;
  source?: "parallel" | "sequential" | "rectification" | "completion-phase" | "execution-failed";
  runtimeCrashes?: number;
  reviewsFailedOpen?: number;
  fullSuiteGatePassed?: boolean;
  rectificationCost?: number;
  tokens?: TokenUsage;
  tokenAttribution?: "direct" | "even-split";
  fallback?: { hops: AgentFallbackHop[] };   // cross-agent swaps (ADR-012)
  reviewMetrics?: {            // Semantic + adversarial sub-buckets
    semantic?: { cost; wallClockMs; findingsCount; findingsBySeverity };
    adversarial?: { cost; wallClockMs; findingsCount; findingsBySeverity;
                    findingsByCategory };   // adversarial heuristic categories
  };
  // …plus context / scope-test / failing-test-file fields — see types.ts
}
```

### Token Usage

`src/metrics/types.ts`:

```typescript
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;      // omitted when 0
  cacheCreationInputTokens?: number;  // omitted when 0
}
```

### Aggregator

`src/metrics/aggregator.ts`:
- `calculateAggregateMetrics()` — cross-run aggregation; `getLastRun()`
- `deriveRunFallbackAggregates()` — run-level agent-swap rollup from `StoryMetrics.fallback.hops`

### Cost System

`src/agents/cost/`:
- `rate-card.ts` — `resolveRateCard()` maps a configured model id to a `TokenPricing` card: alias file (`model-aliases.json`) → nax-ai model catalog (`src/agents/catalog/`, `catalog-rates`) → `FALLBACK_RATES` (`fallback-rates`, with a warning)
- `estimate.ts` — `priceCall()` / `estimateCostUsd()`, tier-aware (cache read/creation fall back to input price)
- `calculate.ts` — `addTokenUsage()`, `inputClassTokens()`, `formatCostWithConfidence()`, `resolvePricingSource()`
- `token-mapper.ts` — maps adapter usage payloads onto `TokenUsage`
- ACP sessions emit exact USD via `usage_update` events (preferred over estimation); the native path prices each round trip from the rate card
- The runtime's `CostAggregator` (§36) is the per-run sink

---

## §30 Worktree & Parallel Support

### Worktree Identity (`WorktreeId`)

`src/worktree/worktree-id.ts` is the single SSOT for every spelling of a worktree
identity; `scripts/check-worktree-id-ssot.ts` enforces that callers never
interpolate these strings themselves.

- `WorktreeId` — branded `string`; only the producers mint one, so passing a raw
  story id where a worktree id is expected fails to type-check
- `deriveStoryWorktreeId(feature, storyId)` → `story-<feature>-<storyId>`;
  `deriveBakeoffWorktreeId(feature, profile)` → `bakeoff-<feature>-<profile>`.
  Sanitized to the story-id alphabet, capped at 64 chars with a stable hash suffix
  when truncation would collide
- `storyWorktreePath(root, id)` → `<root>/.nax-wt/<id>`; `storyBranchName(id)` → `nax/<id>`
- `naxOrphanRefName(id)` (`nax-orphan-ref.ts`) → `refs/nax/orphan/<id>`, written after a
  non-conflict merge failure and read back by `WorktreeManager.create()`

### Worktree Manager

`src/worktree/manager.ts` — `WorktreeManager`:
- `create(root, id)` / `remove(root, id)` / `list(root)` — git worktrees for per-story
  and parallel execution
- `ensureGitExcludes(root)` — writes nax runtime files into `.git/info/exclude` so parallel
  worktrees never commit them

### Worktree Dependencies

`src/worktree/dependencies.ts` — `prepareWorktreeDependencies()` resolves the cwd a
story runs from inside its worktree, installing dependencies first when
`execution.worktreeDependencies.mode` is `"provision"` (default `"off"`;
`setupCommand`, `timeoutSeconds` default 300). A failure surfaces as the
`dependency-prep` failure category.

### Worktree Merge

`src/worktree/merge.ts` — `MergeEngine`:
- `merge(root, id)` / `mergeAll(...)` — merges worktree branches back in dependency order
- Returns `MergeResult` with `MergeFailureKind` (`"conflict" | "error"`); conflicts go to a
  rectification pass (`src/execution/merge-conflict-rectify.ts`)

### Project identity across checkouts

The project's output directory lives outside the repo at
`~/.nax/<projectKey>/` unless `outputDir` overrides it (`projectOutputDir`,
`src/runtime/paths.ts`); `projectKey`
is the configured `name` or the directory basename (`src/config/project-key.ts`).
`claimProjectIdentity()` writes `~/.nax/<projectKey>/.identity` (name, workdir,
`remoteUrl`, timestamps) and matches later claims by **normalized git remote**
(`isSameProject()`, `src/runtime/same-project.ts` — scheme, credentials, port,
`.git` suffix and scp-style differences ignored; host significant). A second
checkout or worktree of the same repository therefore shares one identity and one
output dir, so runs from any checkout are attributed to the same project; a
different remote under the same key throws `RUN_NAME_COLLISION` (resolve via
rename or `nax migrate --reclaim` / `--merge`).

---

## §31 Queue Management

`src/queue/`:
- Mid-run story control via the `.queue.txt` control file
- `parseQueueFile()` (`manager.ts`) parses commands: `PAUSE`, `ABORT`, `SKIP <id>`,
  `RETRY <id>`, `PRIORITY <id> <n>`, `INJECT <path>`; text after `--- PENDING ---` is guidance
- `src/execution/queue-handler.ts` consumes the file atomically
  (`.queue.txt` → `.queue.txt.processing` → delete) between stories
- `queueCheckStage` (pipeline stage 1) acts on commands before each story
- `writeQueueCommand()` (`src/utils/queue-writer.ts`) is the writer side
- Agents cannot write the queue files: they are nax-owned paths (§53)

---

## §32 TUI (Terminal UI)

`src/tui/`:
- React/Ink-based terminal UI for real-time pipeline visualization
- `App.tsx` — main TUI component
- `components/` — `StoriesPanel`, `LiveActivityPanel`, `StatusBar`, `CostOverlay`, `HelpOverlay`
- `hooks/` — `useKeyboard`, `useLayout`, `usePipelineEvents`, `usePipelineBusEvents`, `useAgentStreamEvents`
- Headless mode (`--headless` flag or env, `src/cli/run-mode.ts`) prints via
  `src/execution/lifecycle/headless-formatter.ts` instead

---

## §33 Error Classes

`src/errors.ts`:

| Error class | When to use |
|:------------|:-----------|
| `NaxError` | Base class — all nax errors (with `code` + `context`) |
| `AgentNotFoundError` | Agent name not in registry |
| `AgentNotInstalledError` | Agent binary not installed on system |
| `StoryLimitExceededError` | Too many stories for current plan |
| `LockAcquisitionError` | Another nax instance holds the lock |

---

## §34 Session Manager

`src/session/manager.ts` — `SessionManager` class implementing `ISessionManager`.
Decision record: ADR-011 (extraction) + ADR-019 (full lifecycle ownership).
Spec: `docs/specs/SPEC-session-manager-integration.md`.

Owns the **full session lifecycle**. The adapter exposes 4 protocol primitives
(`openSession`, `sendTurn`, `closeSession`, `complete`) — SessionManager
orchestrates them.

### Ownership boundary (ADR-019)

```
SessionManager                               AgentAdapter (4 primitives)
─────────────────────────────────            ─────────────────────────
Owns:                                        Owns:
  - Stable descriptor ID (sess-<uuid>)         - openSession  / sendTurn /
  - State machine (7 states)                     closeSession  / complete
  - Scratch directory                          - transport: acpx process (ACP) or
  - descriptor.json persistence                  transcript file + turn loop (native, §52)
                                               - inner interaction-bridge loop
  - Session naming (agent-agnostic)              (tool calls, permission prompts)
  - Turn count (descriptor field)              - protocolIds (returned via
  - Resume detection (descriptor lookup)         openSession / TurnResult)
  - sendPrompt (delegates to sendTurn)         - Transport-level retry
  - handoff() across fallback agent swaps        (QUEUE_DISCONNECTED)
  - Permission resolution at openSession
  - Orphan detection (state-based)
  - Prompt audit metadata (per #523)
```

ADR-013's `SessionManager` > `AgentManager` hierarchy was superseded by ADR-019.
The two are now pure peers — neither imports the other. Integration happens at
the operation / `callOp` layer via `buildHopCallback` (see §37).

### State machine

```
CREATED → RUNNING → { PAUSED | COMPLETED | FAILED | CLOSING }
PAUSED   → { RESUMING | FAILED }
RESUMING → { RUNNING | FAILED }
CLOSING  → { COMPLETED | FAILED }
```

Transitions are validated by `SESSION_TRANSITIONS`. `COMPLETED` and `FAILED` are
terminal.

### Key methods

**Lifecycle primitives (ADR-019 Phase B):**

- `openSession(name, opts)` → `SessionHandle`. Resolves permissions internally
  (`resolvePermissions(config, opts.pipelineStage)`) and calls
  `adapter.openSession(name, { resolvedPermissions, resume })`. The
  resource-opener-resolves-permissions rule applies — see §14.
- `sendPrompt(handle, prompt, opts)` → `TurnResult`. Delegates to
  `adapter.sendTurn` with the framework's `interactionHandler`. Single-flight
  per handle (concurrent calls throw `SESSION_BUSY`).
- `closeSession(handle)` → idempotent close; calls `adapter.closeSession`.

**Convenience:**

- `runInSession(name, prompt, opts)` → open + sendPrompt + close (try/finally).
- `runInSession(name, runFn, opts)` — callback overload for transactional
  multi-prompt orchestration (future keep-open patterns).

**Naming + introspection:**

- `nameFor(req)` → agent-agnostic session name (was previously
  `computeAcpHandle` inside the adapter).
- `descriptor(name)` / `get(sessionId)` / `listActive()` → descriptor lookup;
  `listActive()` excludes terminal states.
- `transition(sessionId, toState)` → state-machine guard.

**Cross-agent fallback:**

- `handoff(id, newAgent, reason?)` → updates `descriptor.agent` while preserving
  `id`, scratch dir, and audit correlation. **Metadata only** — does NOT call
  `adapter.openSession` / `closeSession`. Each fallback hop opens a fresh
  adapter-level session via `buildHopCallback` (§37); one descriptor wraps N
  adapter sessions across the lifetime of one story attempt (AC-42).
- `bindHandle(sessionId, name, protocolIds)` → records protocolIds returned by
  the adapter; preserved across `handoff()`.

**Scratch:**

- `descriptor.scratchDir` → persistent per-session scratch path
  (`.nax/features/<feature>/sessions/<id>/`) consumed by `SessionScratchProvider` (§24).
- `resume(storyId, role)`, `getForStory(storyId)`, `closeStory(storyId)`,
  `sweepOrphans(ttlMs)` — story-scoped lookup and cleanup.

### Runtime helpers (not on the manager)

`src/execution/session-manager-runtime.ts`:

- `closeStorySessions` / `closeAllRunSessions` — orchestration.
- `failAndClose(sm, sessionId, agentGetFn)` — atomic `→ FAILED` transition +
  `closePhysicalSession(handle, workdir, { force: true })` (AC-83). Required
  because `listActive()` excludes terminal sessions; teardown would otherwise
  miss a failed session's handle.

### Persistence & portability

- Each descriptor is persisted to `<scratchDir>/descriptor.json`
  (`.nax/features/<feature>/sessions/<id>/descriptor.json`), replacing the old
  protocol-specific `acp-sessions.json` sidecar.
- `descriptor.json` and `context-manifest-*.json` store paths **relative to
  `projectDir`**; loaders rehydrate to absolute paths for runtime use.
- Native session transcripts are written under the run's output dir
  (`transcriptRoot`), never the project tree (§52).
- One `SessionManager` per run, owned by `NaxRuntime` (§36).

### Mid-turn cancellation

If `sendPrompt` aborts mid-turn (signal abort during the adapter's inner
interaction-bridge loop), SessionManager records the handle as cancelled
(`isCancelled(name)`; this is not a descriptor state). Subsequent `sendPrompt`
against the same handle throws `SESSION_CANCELLED` — the session must be closed
and a new one opened to continue. `sendPrompt` on a terminal (`COMPLETED` /
`FAILED`) descriptor throws `SESSION_TERMINAL_STATE`.

### Barrel

`src/session/index.ts` exports `SessionManager`, `ISessionManager`,
`SessionDescriptor`, `SessionState`, `SESSION_TRANSITIONS`,
`CreateSessionOptions`, `formatSessionName`, `SessionKeeper`, and the
scratch-writer helpers (`appendScratchEntry`, `scratchFilePath`, …).

---

## §35 Agent Manager

`src/agents/manager.ts` — `AgentManager` class implementing `IAgentManager`.
Decision record: ADR-012 (extraction) + ADR-019 (peer relationship with
SessionManager). Spec: `docs/specs/SPEC-agent-manager-integration.md`.

Owns agent *policy*: default resolution, availability fallback, unavailable-agent
tracking, the per-call cancellation middleware, and emitting the dispatch events
that the audit / cost / logging subscribers consume (§36). It is a **pure peer of
SessionManager** — neither imports the other.

### Three retry layers — only one is owned here

| Layer | Owner | Scope |
|:------|:------|:------|
| **Availability retry** (auth / 429 / service-down → swap agent) | **AgentManager** | Cross-agent policy |
| **Transport retry** (broken socket, `QUEUE_DISCONNECTED`, stale session) | Adapter (`sessionErrorRetryable` loop) | Protocol-level, same agent |
| **Payload-shape retry** (JSON parse fail → re-ask LLM) | Caller — the op's `retry` / `verify` / `recover` hooks in `callOp` (e.g. review requote) | Output validation, same agent |

Conflating these was the root of the T16.3 silent-fallback regression. Reviewers
must preserve this boundary — availability swaps never fire on payload-shape
failures.

### Ownership boundary (ADR-019 Shape C)

```
AgentManager                                  SessionManager
─────────────────────────────────             ─────────────────────────
Owns:                                         Owns (see §34):
  - Default agent resolution                    - openSession / sendTurn /
  - Fallback chain (flat or keyed map)            closeSession (4 primitives)
  - Per-run unavailable-agent tracking          - Lifecycle state machine
  - shouldSwap(failure) decision                - Naming, turn count, resume
  - nextCandidate(current, failure)             - handoff() across swaps
  - runWithFallback (chain iteration)
  - Cancellation middleware + dispatch
    events (audit/cost/logging subscribers)
  - resolvePermissions for completeAs
  - Calls ContextOrchestrator.rebuildForAgent
    via buildHopCallback (§37)
  - Emits onSwapAttempt / onSwapExhausted

Neither imports the other. Integration happens at callOp / buildHopCallback.
```

### Three entry points (ADR-019)

| Method | Use case | Session involvement |
|:---|:---|:---|
| `completeAs(name, prompt, opts)` / `completeAsWithFallback(name, prompt, opts)` | Sessionless one-shot — routing, decompose, acceptance refine (`kind:"complete"` ops go through `completeAsWithFallback`, which also returns agent-swap records) | None — calls `adapter.complete` directly |
| `runAsSession(agent, handle, prompt, opts)` | Caller-managed session — orchestrators that keep a session open across multiple prompts (TDD multi-prompt) | Caller opens handle via `SessionManager.openSession`; AgentManager wraps `sessionManager.sendPrompt` with the middleware envelope; **no internal fallback** |
| `runWithFallback(request)` | Chain iteration with per-hop callback delegation | Iterates the fallback chain; invokes `request.executeHop(agent, bundle, failure, opts)` per hop. The callback (constructed by `callOp` via `buildHopCallback`, §37) owns rebuild + open + send + close |

Every `completeAs*` and `runAsSession` call runs through the same middleware
chain and emits a dispatch event (or dispatch-error event) that the runtime's
subscribers record uniformly. Both are wired once at `createRuntime` time — see §36.

### Why three entries, not one

A single `runAs` would force every caller to either accept fallback iteration
(unwanted by orchestrators that need pin-an-agent semantics) or manage handles
(unwanted by ops that just want one prompt). `completeAs` is structurally
distinct — sessionless one-shots have no handle to manage.

### Shape C: peer relationship via `executeHop` callback

`runWithFallback` does NOT call SessionManager directly. It invokes a
caller-supplied `executeHop` callback per hop. The callback (built by
`buildHopCallback` in `src/operations/`) owns:

1. Context rebuild for the new agent (`contextEngine.rebuildForAgent`)
2. Descriptor handoff (`sessionManager.handoff(id, newAgent)`)
3. Fresh adapter-level session open (`sessionManager.openSession`)
4. Prompt dispatch (`agentManager.runAsSession(agent, handle, prompt)`)
5. Adapter session close (`sessionManager.closeSession`) in `finally`

One descriptor lives across all hops; each hop opens and closes its own
adapter-level session. See ADR-019 §5 and §37.

### Canonical resolution helper

`resolveDefaultAgent(config)` (`src/agents/utils.ts`, exported from
`src/agents/index.ts`) is the standalone-module form for code that does not carry
a `ctx`. The built-in default agent is `native` under `agent.protocol: "hybrid"`
(ADR-027); `agent.protocol` is a capability gate — `"acp"` cannot reach `native`,
`"native"` permits only the native agent (`src/config/schemas-protocol-gate.ts`). In pipeline stages, prefer
`ctx.agentManager?.getDefault() ?? "claude"`. **Never** read
`config.autoMode.defaultAgent` directly — that key was removed in ADR-012
Phase 6 and is rejected at config-load time.

### Configuration

See `docs/guides/configuration.md` → *Agent Configuration* for the canonical
`config.agent` shape. Legacy keys (`autoMode.defaultAgent`,
`autoMode.fallbackOrder`, `context.v2.fallback`) are rejected at load time with
a migration hint (`NaxError code: CONFIG_LEGACY_AGENT_KEYS`).

### Barrel

`src/agents/index.ts` exports `AgentManager`, `IAgentManager`,
`resolveDefaultAgent`, `AgentRunRequest`, `AgentRunOutcome`,
`AgentCompleteOutcome`, and `AgentManagerEvents`.

---

## §36 NaxRuntime

`src/runtime/index.ts` — `NaxRuntime` interface + `createRuntime()` factory.
Decision record: ADR-018 (runtime layering).

Single lifecycle container per run / plan / standalone CLI invocation. Owns
every long-lived service the pipeline needs and replaces the three orphan
`createAgentManager` instantiations that previously diverged (ADR-018 §2.1
"Orphan consolidation"; closes #523).

### Container shape

```typescript
// abridged — see src/runtime/index.ts
export interface NaxRuntime {
  readonly runId: string;
  readonly configLoader: ConfigLoader;       // current() / select(selector)
  readonly workdir: string;
  readonly projectDir: string;
  readonly outputDir: string;                // ~/.nax/<projectKey>/ unless overridden (§30)
  readonly globalDir: string;
  readonly curatorRollupPath: string;
  readonly projectKey: string;
  readonly agentManager: IAgentManager;      // Layer 1 — dispatch + fallback policy
  readonly sessionManager: ISessionManager;  // Layer 2 — session lifecycle primitive
  readonly costAggregator: ICostAggregator;  // subscriber-fed sink; drains on close
  readonly promptAuditor: IPromptAuditor;    // subscriber-fed sink; flushes on close
  readonly usageAuditor: IUsageAuditor;      // agent-stream usage audit; flushes on close
  readonly reviewAuditor: IReviewAuditor;    // review decision audit; flushes on close
  readonly dispatchEvents: IDispatchEventBus;      // per-dispatch events (§35)
  readonly agentStreamEvents: IAgentStreamEventBus; // streamed agent activity
  readonly packages: PackageRegistry;        // root-equiv view when no workdir
  readonly pidRegistry: PidRegistry;
  readonly mcpPool: McpPool;                 // run-scoped MCP connections (§57)
  readonly toolProviders: readonly ToolProvider[];
  readonly logger: Logger;
  readonly signal: AbortSignal;              // scope-internal AbortController
  readonly dryRun: boolean;
  // …run-scoped stores: quarantineMemo, review iteration histories,
  //   agentFallbacks, storyFixHistory, routingCache, mutationSummaries, …
  close(): Promise<void>;                    // idempotent
}
```

### Construction

`createRuntime(config, workdir, opts?)` is the only public constructor for
`AgentManager` and `SessionManager`. The factory:

1. Allocates an `AbortController`; if `opts.parentSignal` is provided (e.g. CLI
   SIGINT), aborts cascade.
2. Builds the `ConfigLoader` (`current()` / `select<C>(selector)` memoized per
   `selector.name`).
3. Builds the middleware chain frozen for the runtime lifetime
   (`MiddlewareChain.from([cancellationMiddleware()])`) and attaches the observer
   subscribers to the event buses: logging, cost, prompt audit, review audit
   (dispatch events) and usage audit, agent-stream logging, idle watchdog
   (agent-stream events).
4. Wires `SessionManager` → `AgentManager` via the injected `sendPrompt` and
   `runHop` deps (Shape C — peer relationship).
5. Constructs `PackageRegistry` for polyglot-monorepo correctness, the MCP pool
   and tool providers.

### close() ordering

`close()` is idempotent and drains in this order:
`signal.abort()` → detach subscribers → reset/close `agentManager` and
`sessionManager` → close the MCP pool and write the MCP rollup → flush
`promptAuditor` / `usageAuditor` / `reviewAuditor` and drain `costAggregator`
(settled together). Errors are swallowed and logged (drain must not block run
completion).

### Why a runtime container?

Before ADR-018, three different code paths constructed `AgentManager`
independently (`runner.ts`, `acceptance/generator.ts`, `acceptance/refinement.ts`).
A 401 on routing fell into a different fallback chain than execution; cost events
from rectification proposers landed in unrelated `CostAggregator`
instances. `NaxRuntime` collapses these into one shared lifecycle, with
middleware sinks wired once.

### Middleware chain and event subscribers (ADR-018 §3, ADR-020)

Every `completeAs*` and `runAsSession` call across every adapter runs through the
middleware chain and emits a dispatch event; observers subscribe to the event
buses rather than sitting in the chain. Both are structurally uniform — adapters
cannot opt out, and there is no "remember to call the helper" seam.
`src/runtime/middleware/`:

| Piece | Kind | Concern | Sink |
|:---|:---|:---|:---|
| `cancellation` | middleware | Threads `signal`; translates `AbortError` into a typed failure | — |
| `logging` | dispatch subscriber | Structured JSONL per dispatch | `logger` |
| `cost` | dispatch subscriber | Token/cost accumulation | `CostAggregator` |
| `audit` | dispatch subscriber | Prompt + result capture for replay | `PromptAuditor` |
| `review-audit` | dispatch subscriber | Reviewer decision capture | `ReviewAuditor` |
| `usage-audit` | agent-stream subscriber | Streamed usage | `UsageAuditor` |
| `agent-stream-logging` | agent-stream subscriber | Streamed activity logging | `logger` |
| `idle-watchdog` | agent-stream subscriber | Warns/cancels idle agent turns | — |

Permission resolution is **pre-chain**, once, on the resource-opener side
(`SessionManager.openSession` for sessions; `AgentManager.completeAs` for
sessionless calls). See §14.

### Threading

`NaxRuntime` flows through `PipelineContext` as `ctx.runtime`. Ops never read
from `runtime.configLoader.current()` directly — they receive a sliced config
view through `ctx.packageView.select(op.config)` so per-package overrides
always apply (polyglot-monorepo correctness by construction).

### Barrel

`src/runtime/index.ts` exports `NaxRuntime`, `createRuntime`, `CostAggregator`,
`PromptAuditor`, `UsageAuditor`, `ReviewAuditor`, `PackageRegistry`,
`MiddlewareChain`, `AgentMiddleware`, `MiddlewareContext`, `DispatchEventBus`,
`AgentStreamEventBus`, `formatSessionName`, and the project-path helpers
(`ProjectIdentity`, `isSameProject`, …).

---

## §37 Operations & `callOp`

`src/operations/` — typed `Operation<I, O, C>` framework + `callOp()` dispatcher.
Decision record: ADR-018 (operation envelope) + ADR-019 (Shape C integration).

Operations are the **Layer-4 semantic envelope**: each op declares its config
slice, prompt builder, and parser. `callOp` slices config, composes the prompt,
dispatches through the appropriate manager, and parses the output.

### `Operation<I, O, C>` shape

```typescript
type Operation<I, O, C> =
  | RunOperation<I, O, C>
  | CompleteOperation<I, O, C>
  | DeterministicOperation<I, O, C>;   // pure fn / FS call, no LLM session

interface OperationBase<I, O, C> {
  readonly name: string;
  readonly stage: PipelineStage;
  readonly config: ConfigSelector<C> | readonly (keyof NaxConfig)[];
  readonly build: (input: I, ctx: BuildContext<C>) => ComposeInput;
  readonly parse: (output: string, input: I, ctx: BuildContext<C>) => O;
}

interface RunOperation<I, O, C> extends OperationBase<I, O, C> {
  readonly kind: "run";
  readonly model?: OperationModel<I, C>;
  readonly session: { role: SessionRole; lifetime: "fresh" | "warm" };
  readonly tools?: readonly CodingToolName[];  // coding tools the op declares (§53)
  readonly noFallback?: boolean;     // TDD ops opt out of cross-agent fallback
}

interface CompleteOperation<I, O, C> extends OperationBase<I, O, C> {
  readonly kind: "complete";
}
```

`DeterministicOperation` (kind `"deterministic"`) exposes `execute(input, ctx, deps?)`
and runs a pure function or filesystem call with no agent session — the gate and
check ops (`verifyScopedOp`, `fullSuiteGateOp`, `greenfieldGateOp`,
`testPresenceGateOp`, `mutationCheckOp`, `lintCheckOp`, `typecheckCheckOp`) use it.

### `callOp` — the dispatcher

```typescript
async function callOp<I, O, C>(
  ctx: CallContext,
  op: Operation<I, O, C>,
  input: I,
): Promise<O> {
  if (op.kind === "deterministic") return op.execute(input, ctx);

  const config = ctx.packageView.select(op.config);
  const buildCtx: BuildContext<C> = { packageView: ctx.packageView, config };
  const sections = composeSections(op.build(input, buildCtx));
  const prompt = join(sections);

  if (op.kind === "complete") {
    const outcome = await ctx.runtime.agentManager.completeAsWithFallback(name, prompt, opts);
    return op.parse(outcome.result.output, input, buildCtx);
  }

  // kind:"run" — buildHopCallback owns rebuild + open + send + close per hop
  const executeHop = buildHopCallback(ctx, op, input, prompt);
  const outcome = await ctx.runtime.agentManager.runWithFallback({
    runOptions, bundle: ctx.contextBundle, executeHop, signal: ctx.signal,
  });
  return op.parse(outcome.result.output, input, buildCtx);
}
```

### `buildHopCallback` — per-hop integration

`src/operations/build-hop-callback.ts`. Replaces the deleted
`SingleSessionRunner` (ADR-019 Phase C). Steps per hop:

1. **Rebuild context** for the new agent (`contextEngine.rebuildForAgent`) when
   this is a fallback hop.
2. **Handoff descriptor** (`sessionManager.handoff(id, newAgent)`) — metadata
   only; preserves audit correlation across the agent swap.
3. **Open** a fresh adapter-level session via `sessionManager.openSession`.
4. **Send** the prompt via `agentManager.runAsSession(agent, handle, prompt)` —
   the middleware envelope (audit / cost / cancellation / logging) fires here.
5. **Bind protocolIds** early to the descriptor (closes #591).
6. **Close** the adapter session in `finally` — each hop is self-contained.

One descriptor wraps N adapter sessions across the lifetime of one story attempt.

### `composeSections()` and `ConfigSelector`

- `composeSections(input)` — `src/prompts/compose.ts`. Materializes typed
  `PromptSection` slots in canonical `SLOT_ORDER` (`constitution`, `instructions`,
  `input`, `candidates`, `json-schema`). Builders expose slot-specific methods;
  no middleware chain.
- `ConfigSelector<C>` — `src/config/selectors.ts`. Named, memoized config
  selectors (`reviewConfigSelector`, `planConfigSelector`,
  `acceptanceConfigSelector`, …). One file lists every subsystem's slice;
  refactoring `config.*` surfaces every dependent via the compiler.

### Operation directory

`src/operations/` is the discovery surface for every typed LLM call:

| Op | Kind | Used by |
|:---|:---|:---|
| `planInteractiveOp` / `planRefineOp` | run | `nax plan` (`src/operations/plan.ts`, `plan-refine.ts`) |
| `decomposeOp` | complete | Story decomposition |
| `classifyRouteOp` / `classifyRouteBatchOp` | complete | Routing stage |
| `acceptanceGenerateOp` / `acceptanceDiagnoseOp` | run | Acceptance subsystem |
| `acceptanceRefineOp` | complete | Acceptance AC refinement |
| `acceptanceFixSourceOp` / `acceptanceFixTestOp` | run | Acceptance fix cycle |
| `testWriterOp` / `implementerOp` / `verifierOp` (aliases `writeTddTestOp` / `implementTddOp` / `verifyTddOp`) | run | Per-story orchestrator phases |
| `semanticReviewOp` / `adversarialReviewOp` | run | Review phases |
| `rectifyOp`, `implementerRectifyOp`, `testWriterRectifyOp`, `fullSuiteRectifyOp` | run | Fix strategies / rectification |
| `mechanicalLintFixOp` / `mechanicalFormatFixOp` | deterministic | Mechanical fix strategies |
| `finishReviewOp` / `finishFixOp` / `finishNarrativeOp` | run | Finish phase at run completion (`src/finish/`) |
| `setupGenerateOp` | run | `nax setup` (LLM fill, `src/cli/setup-llm.ts`) |
| gate / check ops (see above) | deterministic | Per-story orchestrator phases |

Multi-session sequencing (TDD three-session) lives in the per-story orchestrator
(`src/execution/story-orchestrator/`), which issues one `callOp` per phase.
There are no `ISessionRunner` implementations — that interface was removed
in ADR-019 Phase C.

### Barrel

`src/operations/index.ts` exports `callOp`, `buildHopCallback`, every concrete
op spec, and the type aliases (`Operation`, `RunOperation`, `CompleteOperation`,
`BuildContext`, `CallContext`).

---

## §38 Post-Run Curator

### Overview

The **context curator** is a built-in `IPostRunAction` plugin that runs automatically after each feature completes. It analyzes run artifacts to generate proposals for improving your project's canonical context sources (`.nax/features/<id>/context.md` and `.nax/rules/`).

**Key principle:** Curator never modifies canonical sources directly. All proposals are human-reviewed and applied explicitly via `nax curator commit`.

**Technology:** Deterministic heuristics (frequency counts, manifest joins, status flags) — no LLM, no auto-apply. Produces two artifacts per run:
- `observations.jsonl` — normalized event table (all observations from this run)
- `curator-proposals.md` — human-readable proposal checklist

### Plugin Architecture

`src/plugins/builtin/curator/`:

| Module | Purpose |
|:---|:---|
| `index.ts` | `IPostRunAction` plugin registration and lifecycle |
| `collect.ts` | Read Tier 1 sources; project to `Observation[]` schema |
| `heuristics.ts` | Apply 6 deterministic heuristics; generate `Proposal[]` |
| `render.ts` | Produce `observations.jsonl` and `curator-proposals.md` |
| `rollup.ts` | Append observations to cross-run rollup (append-only) |
| `rollup-prune.ts` / `auto-prune.ts` | Rollup retention: prune to the newest `keepRuns` run ids once the file exceeds `pruneThresholdBytes` |
| `jsonl-stream.ts` | Bounded streaming line reader for the (machine-wide, unbounded) rollup |
| `types.ts` | `Observation`, `Proposal`, config types |
| `paths.ts` | Resolve output paths (`projectDir`, `rollupPath`) |

### Observation Schema

Every signal from run artifacts maps to one row in `observations.jsonl`. Schema (`src/plugins/builtin/curator/types.ts`):

```typescript
type Observation = {
  // identity
  runId: string;
  featureId: string;
  storyId: string;
  stage: string;              // "execution" | "review" | "rectify" | …
  ts: string;                 // ISO timestamp
  schemaVersion: number;      // 1 for v0.38.0+

  // discriminated by kind
  kind:
    | "chunk-included"        // Context chunk was included
    | "chunk-excluded"        // Context chunk excluded (with reason)
    | "provider-empty"        // Context provider returned zero results
    | "review-finding"        // Semantic or adversarial finding
    | "rectify-cycle"         // Test retry attempt
    | "escalation"            // Model tier escalation
    | "acceptance-verdict"    // Feature acceptance test result
    | "pull-call"             // Agent called a pull tool
    | "co-change"             // Files co-changed together
    | "verdict"               // Story-level pass/fail
    | "fix-cycle-iteration"   // Fix cycle iteration (from ADR-022)
    | "fix-cycle-exit"        // Fix cycle completed
    | "fix-cycle-validator-retry";

  // payload: discriminated union, only fields relevant to this kind
  payload: { … }  // See types.ts for full discriminated union
};
```

Observations are append-only within a run (never mutated). Schema versioning via `schemaVersion` field on each row.

### Data Sources (Tier 1)

The curator reads six artifact families:

| Source | Location | What curator extracts |
|:---|:---|:---|
| **Context manifest** | `.nax/features/<id>/stories/<sid>/context-manifest-*.json` | `includedChunks`, `excludedChunks` (with reason), `providerResults` |
| **Review audit** | `<outputDir>/review-audit/<feature>/*.json` (requires `review.audit.enabled: true`) | `findings[]`, `passed`, `failOpen`, `blockingThreshold` |
| **Run log** | `.nax/features/<id>/runs/<ts>.jsonl` | `stage:"rectify"` / `"escalation"` / `"acceptance"` / `"findings.cycle"` events |
| **Story metrics** | `<outputDir>/metrics.json` | `firstPassSuccess`, `attempts`, `agentUsed`, `finalTier`, `tokensProduced` |
| **Pull-tool emits** | Run log `stage:"pull-tool"` events | `tool`, `keyword`, `resultCount` |
| **Acceptance verdict** | Run log `stage:"acceptance"` events | `passed`, `failedACs`, `retries` |

All reading is **tolerant** — missing or malformed artifacts degrade gracefully with warnings logged, never crashing.

### Heuristics (v0.38.0)

Six deterministic heuristics run after collection. Each produces zero or more `Proposal` with severity (HIGH / MED / LOW) and traceability ID (H1–H6):

| ID | Heuristic | Threshold | Output |
|:---|:---|:---|:---|
| **H1** | Repeated review finding | `count(checkId) >= N` | Add to `.nax/rules/` |
| **H2** | Pull-tool empty result | `resultCount==0 for same keyword >= N` | Add to `.nax/features/<id>/context.md` |
| **H3** | Repeated rectification cycle | `attempts >= N` for same story | Add to context.md |
| **H4** | Escalation chain | `fromTier→toTier >= N` | Add to context.md |
| **H5** | Stale chunk | `chunk excluded as stale, story passed` | Drop from rules |
| **H6** | Fix-cycle unchanged | `outcome=="unchanged" >= N` in a row | Advisory (prompt diagnosis) |

Thresholds are config-driven (`config.curator.thresholds.<heuristicName>`) to enable calibration without code changes.

### Configuration

```json
{
  "curator": {
    "enabled": true,          // Enable/disable post-run plugin
    "thresholds": {           // Heuristic trigger points
      "repeatedFinding": 2,
      "emptyKeyword": 2,
      "rectifyAttempts": 2,
      "escalationChain": 2,
      "staleChunkRuns": 2,
      "unchangedOutcome": 2
    },
    "rollupPath": "~/.nax/global/curator/rollup.jsonl",  // Cross-run rollup location (absolute or ~/)
    "retention": {            // Automatic rollup pruning after each run
      "pruneThresholdBytes": 67108864,   // 64 MiB
      "keepRuns": 50
    }
  },
  "review": {
    "audit": {
      "enabled": true         // Required for H1 (review findings)
    }
  }
}
```

### Lifecycle

`IPostRunAction.execute(context: PostRunContext)`:

1. **Collect phase** — walk all Tier 1 sources, project to `Observation[]`
2. **Heuristic phase** — apply H1–H6, generate `Proposal[]`
3. **Render phase** — write `observations.jsonl` and `curator-proposals.md`
4. **Rollup append** — append observations to cross-run rollup (append-only)
5. **Auto-prune** — when the rollup exceeds `retention.pruneThresholdBytes`, keep this project's newest `retention.keepRuns` runs

All phases are tolerant of errors (logged, never fatal). Partial output (e.g., heuristics succeeded but rollup write failed) is acceptable — the next run regenerates.

### Output Files

Per run:

- **`<outputDir>/runs/<runId>/observations.jsonl`** — one row per observation (JSONL format, schema version 1)
- **`<outputDir>/runs/<runId>/curator-proposals.md`** — human-readable checklist for review + acceptance

Cross-run (append-only):

- **`~/.nax/global/curator/rollup.jsonl`** (or `config.curator.rollupPath`) — append one observation row per run, `runId` retained for deduplication on read

### CLI Integration

Four subcommands in `src/commands/curator.ts`:

| Command | Purpose |
|:---|:---|
| `nax curator status [--run <runId>]` | Show observations + proposals for a run |
| `nax curator commit <runId>` | Apply checked proposals to canonical sources |
| `nax curator dryrun [--run <runId>]` | Re-run heuristics on existing observations (threshold calibration) |
| `nax curator gc [--keep N]` | Prune old rollup rows (default keep 50) |

See [curator.md guide](../guides/curator.md) for full CLI reference.

### Atomicity & Safety

- **Read-only on artifacts** — curator only reads run artifacts, never modifies them
- **Append-only rollup** — multiple runs writing to rollup; POSIX append is atomic per-line
- **Idempotent proposals** — running curator twice on the same run overwrites proposals (deterministic heuristics)
- **Human gate** — `nax curator commit` opens files in `$EDITOR` for review before persisting
- **Reversible** — all changes stay in working directory; you commit to git when ready

### Integration with Review Audit

Review audit ([§25](#25-review--quality-system)) captures semantic and adversarial findings. Curator's H1 heuristic (repeated review finding) depends on `review.audit.enabled: true` to populate `<outputDir>/review-audit/`. Without it, H1 produces no proposals and curator quality degrades gracefully (other heuristics still fire).

User guide: [curator.md guide](../guides/curator.md) §Integration with Review Audit.

---

## §39 Config (`src/config/`)

Layered configuration system — the single source of truth for all nax settings. Loads `~/.nax/config.json` (global) and `<workdir>/.nax/config.json` (project), merges them with schema-derived defaults, applies per-package monorepo overrides from `.nax/mono/<pkg>/config.json`, and validates the result with Zod. Guards in `config-guards.ts` reject removed/legacy keys at load time to prevent silent degradation: `rejectLegacyAgentKeys` (`CONFIG_LEGACY_AGENT_KEYS`), `rejectLegacyRectificationKeys`, `rejectDeadQualityFlags`, `rejectRemovedPlanModes` (`plan.mode: "pipeline"` / `"debate"` → `CONFIG_REMOVED_PLAN_MODE`); `validatePermissionsBlock` enforces the `scoped` profile's `execution.permissions` block; `stripRemovedNoOpKeys` strips inert keys with a warning.

**Notable defaults** (from `src/config/schemas*.ts` / `agent-defaults.ts`): `agent.protocol: "hybrid"`, `agent.default: "native"` (ADR-027); `execution.sandbox.enabled: true` (§55); `execution.bashApproval: "raw"` (ADR-030, §54); `execution.commandSafety` absent = shadow off (§56); `mcp.servers: {}` (§57).

**Root-only execution keys (ADR-031).** `execution.bashApproval`, `execution.approvalTimeout`, `execution.sandbox` and `execution.commandSafety` (`ROOT_ONLY_EXECUTION_KEYS`, `src/config/root-only-keys.ts`) are always taken from the root config: per-package overlays and package profiles cannot widen or narrow the agent-command safety posture. The `interaction` section is likewise never overridden per package.

**Key exports:**
- `NaxConfig`, `NaxConfigSchema`, `DEFAULT_CONFIG` — main config type + Zod schema + schema-derived default (never a hand-maintained literal)
- `loadConfig(workdir)` / `createConfigLoader()` / `ConfigLoader` — entry points; return fully merged, validated config; `ConfigLoader` is the runtime accessor for live-reload awareness
- `findProjectDir(startDir)`, `globalConfigPath()`, `globalConfigDir()`, `projectConfigDir()` — config filesystem discovery helpers (`getRunsDir` / `getEventsRootDir` live in `src/utils/paths.ts`, not here)
- `resolvePermissions(config, stage)` / `PipelineStage` / `ResolvedPermissions` — permission SSOT (see §14 in `agent-adapters.md`); lives in `src/config/permissions.ts` and is imported directly by callers, not via the config barrel. It also resolves the stage's bash approval mode (`resolveBashApproval()`, `src/config/bash-approval.ts`); `inert-bash-stages.ts` warns about stages that declare Bash under `gated`/`escalate` but hold no `Bash(...)` allow rule
- Named selectors (20+): `tddConfigSelector`, `planConfigSelector`, `routingConfigSelector`, … — typed config slices consumed by `callOp` via `packageView.select`
- `resolveTestStrategy()`, `isThreeSessionStrategy()` — test-strategy resolution (ADR-015)
- `deepMergeConfig()`, `mergePackageConfig()` — merge primitives for the layering order
- `validateDirectory()`, `isWithinDirectory()` — path-security guards (see §12 in `design-patterns.md`)

**Entry point:** `src/config/index.ts` (barrel); slice types are imported from the leaf `src/config/selectors` (see `config-patterns.md`).

**Called by:** almost everything. Wired at bootstrap by `loadConfig` in `src/execution/lifecycle/run-setup.ts`. `resolvePermissions` is called inside `src/agents/manager.ts`, `src/agents/manager-dispatch.ts`, `src/agents/coding-tool-support.ts`, and `src/session/manager.ts`.

---

## §40 Logger (`src/logger/`)

Structured JSONL logging facility — the single place where `LogEntry` records are produced. Writes to an optional JSONL file and/or the console (level-gated for console; file always receives all levels). `src/log-format/` (§41) consumes `LogEntry` for human-facing presentation — the two directories are cleanly layered, distinct concerns.

**Key exports:**
- `Logger` — owns file writer + optional console output
- `initLogger(opts)` — global singleton initialiser (call once per run in `run-setup.ts`)
- `getLogger()` / `getSafeLogger()` — `getLogger` throws if not yet initialised; `getSafeLogger` returns `null` (for modules that may run before init)
- `resetLogger()` — test teardown helper; `addSink()` — register an extra `LogSink`
- `redactSecrets()` / `SECRET_VALUE_PATTERNS` — secret redaction applied to log output
- `LogEntry`, `LogLevel`, `LoggerOptions`, `LogSink`, `StoryLogger` — types
- `formatConsole()`, `formatJsonl()` — raw formatters (internal; human presentation is in §41)

**Entry point:** `src/logger/index.ts`

**Called by:** every pipeline stage and subsystem. `suppressConsole: true` is set when TUI mode is active to avoid corrupting Ink's terminal output.

---

## §41 Log Format (`src/log-format/`)

Human-facing presentation layer for log entries and run summaries. Consumes `LogEntry` records from `src/logger/` (§40) and renders them with colour and multiple verbosity modes. This module never writes `LogEntry` records — it is a pure leaf, called by `src/execution/lifecycle/headless-formatter.ts`, `src/commands/logs-formatter.ts` (`nax logs`), `src/cli/runs.ts`, and the logger's console path.

**Key exports:**
- `formatLogEntry(entry, opts)` / `FormattedEntry` — formats a single `LogEntry` for terminal display
- `formatRunSummary(summary, opts)` — renders end-of-run statistics (cost, duration, pass/fail counts); `formatAdvisorySummary()`, `formatMutationSummary()`
- `formatTimestamp()`, `formatDuration()`, `formatCost()` — display helpers
- `VerbosityMode` — `"quiet" | "normal" | "verbose" | "json"`
- `RunSummary`, `StoryStartData`, `StageResultData`, `FormatterOptions` — data types
- `EMOJI` — named emoji constants (isolated here to keep `src/logger/` machine-parseable)

**Entry point:** `src/log-format/index.ts`

> **Rename note (2026-06-17):** was `src/logging/`; renamed to remove the near-identical collision with `src/logger/` that produced false "duplicate subsystem" findings. 5 import sites updated; behaviour unchanged.

---

## §42 CLI (`src/cli/`)

High-level CLI command implementations. Each file maps to one user-facing command (`init`, `setup`, `plan`, `accept`, `runs`, `status`, `rules`, `generate`, `config`, `agents`, `auth`, `mcp`, `approvals`, `context`, `spec`, `prompts`, `plugins`, `routing`, `features`). Commands are wired to the Bun binary in `bin/nax.ts`, directly or via `src/commands/` (§43). This is one of two directories permitted to call `process.cwd()` as the bootstrap workdir default.

**Key exports:**
- `initCommand(opts)` — interactive project initialisation
- `setupCommand(opts)` / `writeSetupConfig()` — config wizard; `writeSetupConfig` writes config files via `Bun.write` and handles mono package configs (fully implemented in `src/cli/setup-write.ts`)
- `planCommand(opts)`, `planDecomposeCommand(opts)`, `resolvePlanMode(config)` — planning flow (delegates to `src/plan/`)
- `acceptCommand(opts)` — acceptance test runner
- `runsListCommand()`, `runsShowCommand()` — run history viewer
- `displayCostMetrics()`, `displayFeatureStatus()` — status sub-commands
- `generateCommand(opts)` — `nax generate` (regenerates CLAUDE.md from context.md)
- `configCommand(opts)` — config get / set / diff display; `nax config profile list|show|use|current|create`
- `rulesExportCommand()`, `rulesLintCommand()`, `rulesMigrateCommand()` — rules management
- `resolveRunProfileOverride(opts)` — resolves `--profile` CLI flag to a permission profile name
- `authLoginCommand()` / `authImportCommand()` / `authListCommand()` / `authRmCommand()` — `nax auth`: provider credentials for the native agent
- `runMcpLockCommand(workdir)` (`mcp.ts`) — `nax mcp lock`: refresh `.nax/mcp-lock.json` (§57)
- `registerApprovalsCommand()` / `approvalsListCommand()` / `approvalsRmCommand()` (`approvals.ts`) — `nax approvals list [--json]` and `nax approvals rm [ids...] [--stage <s>] [--all] [--yes]` over remembered approvals (§54)
- `specLintCommand()` — `nax spec lint`; `contextInspectCommand()`, `fragmentsInspectCommand()` / `fragmentsPruneCommand()`, `effectivenessEvalCommand()` — `nax context …`; `routingCalibrateCommand()` — `nax routing calibrate`; `agentsListCommand()`, `pluginsListCommand()`, `promptsCommand()`

**Entry point:** `src/cli/index.ts`

---

## §43 Commands (`src/commands/`)

Thin wrappers and shared resolution utilities that sit between `bin/nax.ts` and `src/cli/` (§42). Handles cross-cutting concerns: run-project resolution, precheck orchestration, curator, log streaming, run locking, config migration, replay and resume.

**Key exports:**
- `resolveProject(opts)` / `resolveProjectAsync(opts)` / `ResolvedProject` — resolves workdir + config + runtime for any command; the single entry point every command uses
- `curatorStatus()`, `curatorCommit()`, `curatorDryrun()`, `curatorGc()` — post-run curator sub-commands
- `logsCommand(opts)` — streams / filters `.nax/logs/*.jsonl` entries
- `precheckCommand(opts)` — wires `src/precheck/` (§46) to the CLI
- `runsCommand(opts)` — run history listing
- `unlockCommand(opts)` — releases stale locks (checkout lock and `<outputDir>/features/<feature>/nax.lock`; `-f` scopes to one feature, `--force` skips the liveness check)
- `migrateCommand(opts)` / `detectGeneratedContent()` — migrates legacy PRD/config formats; `--reclaim` / `--merge` resolve project-identity collisions (§30)
- `registerReplayCommand()` / `runReplay()` — `nax replay` (reconstruct a past run from `src/replay/`)
- `registerResumeCommand()` / `runResume()` — `nax resume`

**Entry point:** `src/commands/index.ts`

---

## §44 Optimizer (`src/optimizer/`)

Prompt token-reduction seam, invoked as pipeline stage 6 (`src/pipeline/stages/optimizer.ts`). One built-in implementation: `NoopOptimizer` (pass-through). A plugin can provide a real optimizer via `IPromptOptimizer`. Resolved once per run by `resolveOptimizer(config, pluginRegistry)`.

**Key exports:**
- `IPromptOptimizer` — interface: `optimize(input) → Promise<PromptOptimizerResult>`
- `PromptOptimizerInput`, `PromptOptimizerResult` — input/output types
- `NoopOptimizer` — returns prompt unchanged; used whenever no plugin optimizer is active
- `resolveOptimizer(config, pluginRegistry?)` — factory: plugin → noop
- `estimateTokens(text)` — rough character-based token estimator

**Entry point:** `src/optimizer/index.ts`

> **History:** a `RuleBasedOptimizer` built-in shipped in v0.10 (2026-02-23) and was removed on 2026-08-20. No config ever selected it, and its per-rule `optimizer.strategies` block was never in `OptimizerConfigSchema`, so it was unconfigurable even when opted into. The `optimizer.strategy` / `optimizer.strategies` keys are stripped with a warning by `_applyRemovedOptimizerKeysShim`.

---

## §45 Plan (`src/plan/`)

Planning pipeline that converts a feature spec into a `prd.json`. Supports two strategies — `single` (one planning call via `planInteractiveOp`) and `refine` (a draft turn followed by a self-audit turn via `planRefineOp`; `plan.specGuard` adds a spec-drift repair turn), selected by `config.plan.mode` (`resolvePlanMode()`: unset → `single`). The retired `pipeline` and `debate` modes are rejected at config load (`CONFIG_REMOVED_PLAN_MODE`). Orchestrated by `planCommand` (§42).

**Key exports:**
- `IPlanStrategy`, `PlanModeContext`, `PlanCommandOptions`, `PlanDeps` — shared types
- `SinglePlanStrategy`, `RefinePlanStrategy` — the two surviving strategies
- `createPlanStrategy(mode)` — factory; maps `single` | `refine` to its strategy
- `buildPlanModeContext(opts, deps)` — assembles the context object threaded through strategy execution
- `writeOrRecoverPrd(path, content)` — atomic PRD write with recovery on parse failure
- `persistPrd()` / `finalizeAndWritePrd()` — the single pre-write invariant: plan-fidelity repair → canonicalize → finalize routing → write
- `finalizePrdRouting(prd, config)` — sets per-story `modelTier` / `testStrategy` from routing config
- `assertIsValidPrd()` — structural check used by the `single` strategy
- `assertSpecLintClean()` (`spec-lint-gate.ts`) — runs the spec linter before the plan spends

**Entry point:** `src/plan/index.ts`

**Called by:** `src/cli/plan-command.ts`, `src/cli/plan-decompose.ts`. Depends on `src/operations/` (§37), `src/prd/`, `src/prompts/` (§49).

---

## §46 Precheck (`src/precheck/`)

Pre-run validation suite. Runs ordered checks before story execution and fails-fast on Tier-1 blockers. Two tiers: environment checks (git, agent CLI, dependencies, disk — no PRD required) and project checks (PRD validity, story counts, story size gate — PRD required). Output is a human-readable table or machine-readable JSON.

**Key exports:**
- `runPrecheck(config, prd, options)` — main entry point; returns `PrecheckResultWithCode`. `runEnvironmentPrecheck()` runs the PRD-free tier alone
- `PrecheckOutput` — `{ passed, blockers, warnings, summary, feature }`
- `EXIT_CODES` — `{ SUCCESS: 0, BLOCKER: 1, INVALID_PRD: 2 }`
- `Check`, `PrecheckResult`, `PrecheckOptions` — types
- Named check functions: `checkGitRepoExists`, `checkAgentCLI`, `checkPRDValid`, `checkPendingStories`, `checkModelResolution`, `checkNativeCredentials`, `checkMultiAgentHealth`, `checkStaleLock`, and ~15 others
- `checkStorySizeGate(config, prd)` (`story-size-gate.ts`) — flags stories whose complexity / AC count exceeds configured thresholds

**Entry point:** `src/precheck/index.ts`

**Called by:** `src/commands/precheck.ts` (`nax precheck` command) and `src/execution/lifecycle/precheck-runner.ts` (`runPrecheckValidation`, invoked from `run-setup.ts` as the automatic pre-run gate on every `nax run`).

---

## §47 Project (`src/project/`)

Auto-detects project language, type, test framework, and lint tool from filesystem manifest files. Language detection inspects `go.mod`, `Cargo.toml`, `pyproject.toml`, `requirements.txt`, `package.json`, `tsconfig.json`. Project-type detection (web-app, api, library, cli, fullstack) infers from dependency lists. All detection is heuristic; the result populates `ProjectProfile` in config and is used by context generators and routing. This is the authoritative detector — new code must call these functions, not re-derive manifest lookups (see `.nax/rules/monorepo-awareness.md` rule 5).

**Key exports:**
- `detectLanguage(packageDir)` → `ProjectProfile["language"] | undefined` (detects `typescript`, `javascript`, `go`, `python`, `rust`; cached — `clearLanguageCache()`)
- `inferFrameworkAndTestRunner(language, pkg)` → `{ framework, testRunner }` from package deps
- `detectProjectProfile(workdir, existing?)` — full profile detection; skips fields already set in `existing`

**Entry point:** `src/project/index.ts` (re-exports from `detector.ts` and `package-stack.ts`)

**Called by:** `src/analyze/scanner.ts` (§50), `src/cli/setup-analyze.ts`, `src/execution/lifecycle/run-setup.ts` (`detectProjectProfile`), `src/context/engine/providers/code-neighbor.ts` and `src/quality/self-verification.ts` (`detectLanguage`), `src/acceptance/hardening.ts` (`detectLanguage` via leaf path).

---

## §48 Findings (`src/findings/`)

Unified finding wire format (ADR-021) and fix-cycle orchestration (ADR-022). All subsystems that detect problems (lint, typecheck, semantic review, adversarial review, acceptance, TDD verifier, plugins) convert their outputs to `Finding[]` at their boundary. The fix cycle (`runFixCycle`) iterates up to `FixCycleConfig.maxAttemptsTotal`, applies `FixStrategy` instances (each capped by its own `maxAttempts`), validates results, and classifies outcomes.

**Key exports:**
- `Finding`, `FindingSeverity`, `FindingSource`, `FixTarget` — wire types (ADR-021 SSOT)
- `SEVERITY_ORDER`, `compareSeverity(a, b)`, `findingKey(f)`, `findingRecurrenceKey(f)` — severity ordering and stable identity keys
- Per-producer adapters: `lintDiagnosticToFinding()`, `testFailureToFinding()`, `testSummaryToFindings()`, `acFailureToFinding()`, `acSentinelToFinding()`, `acceptanceDiagnoseRawToFinding()`, `pluginToFinding()`, `executionFailureToFinding()`, `genericTypecheckDiagnosticToFinding()` — convert subsystem-specific outputs to `Finding`
- `FixStrategy`, `FixCycle`, `FixCycleConfig`, `FixCycleContext`, `FixCycleResult`, `FixCycleExitReason`, `Iteration`, `IterationOutcome`, `ValidateResult` — cycle-orchestration types
- `runFixCycle(cycle, ctx, cycleName, deps?)` — the fix loop (the per-story orchestrator and the acceptance loop are the consumers)
- `classifyOutcome(before, after)` — per-iteration progress classification (`resolved` / `partial` / `unchanged` / `regressed` / `regressed-different-source` / `rotated`)
- `StoryFixHistory` (`story-fix-history.ts`), `createDeclineLedger()`, retirement stamps — cross-attempt fix state and finding retirement

**Entry point:** `src/findings/index.ts`

**Called by:** `src/execution/story-orchestrator/` (primary consumer of `runFixCycle`) and `src/execution/lifecycle/acceptance-loop.ts`. All review/lint/test subsystems call the adapter converters at their output boundaries.

---

## §49 Prompts (`src/prompts/`)

Single home for all LLM prompt construction. No prompt template literals are permitted outside this module (see `.nax/rules/forbidden-patterns-source.md` → Prompt Builder Convention). Every string sent to an agent surfaces from a builder class in `src/prompts/builders/`. Builders compose `PromptSection` objects via `SectionAccumulator`; section content functions live in `src/prompts/sections/` and `src/prompts/core/sections/`.

**Builder classes:**
| Builder | Handles |
|:---|:---|
| `TddPromptBuilder` | Implementer, test-writer, verifier, no-test, tdd-simple, batch roles |
| `RectifierPromptBuilder` | TDD-test-failure, TDD-suite-failure, verify-failure, review-findings rectification |
| `ReviewPromptBuilder` | Semantic review dialogue |
| `AdversarialReviewPromptBuilder` | Adversarial review dialogue |
| `AcceptancePromptBuilder` | Acceptance generator, diagnoser, fix-executor |
| `OneShotPromptBuilder` | Short single-turn prompts (router, decomposer, auto-approver) |
| `PlanPromptBuilder` | `nax plan` decomposition prompts |
| `SetupPromptBuilder` | `nax setup` LLM fill |

Function-style builders sit alongside: `buildDecomposePromptSync()` (decompose), `buildPriorIterationsBlock()`, `timeoutRetry()`.

**Key infrastructure exports:**
- `composeSections(sections)` → assembled prompt string — used by `callOp` (§37)
- `PromptSection` — `{ id, content, overridable, slot? }` — unit of composition; `SLOT_ORDER` fixes slot order
- `loadOverride(role, workdir, config)` (`src/prompts/loader.ts`) — disk-based prompt override for TDD roles, loaded by `TddPromptBuilder`
- `buildSourceRootsSection(roots)` — formats `SourceRoot[]` for plan prompts
- `SectionAccumulator` — internal builder engine (exported from `src/prompts/core/`, not the top-level barrel)

**Entry point:** `src/prompts/index.ts` (barrel). No subsystem imports from `src/prompts/builders/` directly — always via the barrel.

**Called by:** all `Operation` implementations in `src/operations/` (§37) via `composeSections`, and `src/pipeline/stages/prompt.ts` (stage 5).

---

## §50 Analyze (`src/analyze/`)

Codebase scanner used by the planning pipeline (`nax plan`); there is no `nax analyze` command. Discovers workspace packages, detects their language, reads `package.json` dep lists, and emits a `CodebaseScan` with `SourceRoot[]` entries (path, language, framework, testRunner, dependencies). Internally delegates to `discoverWorkspacePackages` (`src/test-runners/detect/workspace.ts`, §21) and `detectLanguage` (§47) — does not re-implement package boundary detection.

**Key exports:**
- `scanCodebase(workdir)` — main entry point; returns `CodebaseScan`
- `scanSourceRoots(workdir)` — returns `SourceRoot[]` (lower-level; used by `nax plan`)
- `CodebaseScan`, `SourceRoot` — output types
- `_scannerDeps` — injectable deps (`discoverWorkspacePackages`, `detectLanguage`, `readPackageJson`) for testing

**Entry point:** `src/analyze/index.ts`

**Called by:** `src/cli/plan-runtime/index.ts` (wires `scanSourceRoots` into `_planDeps`), `src/cli/plan-command.ts`, `src/cli/plan-decompose.ts`, `src/plan/strategies/context-builder.ts` — all consume `scanSourceRoots` via the `_planDeps` injection point.

---

## §51 Utils (`src/utils/`)

General-purpose utilities with no shared subsystem home. Cross-dependencies within `src/utils/` are few and local (e.g. the lock files share `file-lock.ts`, `git.ts` uses `porcelain.ts`). Each file is independently importable from its leaf path (no barrel — `import from "src/utils/llm-json"`, not `"src/utils"`).

**Key files:**
| File | Key Exports | Purpose |
|:---|:---|:---|
| `llm-json.ts` | `parseLLMJson<T>()`, `tryParseLLMJson<T>()`, `extractJsonFromMarkdown()`, `wrapJsonPrompt()` | **SSOT for LLM JSON parsing** (see `.nax/rules/forbidden-patterns-source.md`). Multi-tier extraction (fence → object extraction → trailing-comma / control-char repair). Called by every Operation parser. |
| `git.ts` | `getGitRoot()`, `gitWithTimeout()`, `captureGitRef()`, `getMergeBase()`, `autoCommitIfDirty()`, `captureOutputFiles()`, `captureDiffSummary()`, `detectMergeConflict()` | Git operations via `Bun.spawn` (`GIT_TIMEOUT_MS` 10s). |
| `path-filters.ts` | `filterNaxInternalPaths()`, `isNaxInternalPath()`, `buildNaxIgnoreIndex()` | Removes `.nax/` / `.naxignore`d paths from "changed files" lists before surfacing to LLM prompts. |
| `path-frame.ts` | `toRepoFrame()`, `normalizeWorkdir()`, `storyWorkdir()`, `storyPackageDir()`, `storyAbsWorkdir()` | **Path-frame SSOT (ADR-032):** every nax-internal relative path is held in one repo-rooted frame; agent file tools are rooted at the story execution root. |
| `nax-owned-paths.ts` | `NAX_OWNED_GIT_EXCLUDE_PATHSPECS`, `NAX_OWNED_REVIEW_EXCLUDE_PATHSPECS`, `NAX_OWNED_TOP_EXCLUDE_PATHSPECS` | Pathspecs that hide nax's own run state from `git status` / review diffs. |
| `path-security.ts` | `isRelativeAndSafe()`, `validateModulePath()` | Path validation (see §12 in `design-patterns.md`; config-side guards live in `src/config/path-security.ts`). |
| `realpath.ts` | `realOrRaw()`, `isInside()` | Symlink-tolerant path comparison (e.g. macOS `/tmp` vs `/private/tmp`). |
| `json-file.ts` | `loadJsonFile<T>()`, `loadJsonFileStrict<T>()`, `saveJsonFile()`, `atomicWriteText()` | Typed JSON read/write wrappers over `Bun.file` / `Bun.write`. |
| `errors.ts` | `errorMessage(err)` | Safely extracts a string from `unknown` thrown values. |
| `process-kill.ts` | `killProcessGroup(pid)` | Process-group kill used by crash recovery and spawned-command deadlines. |
| `argv-exec.ts` | `runArgv()` | Run an argv with no shell, a deadline, concurrent drain and a process-group kill. |
| `file-lock.ts` / `path-file-lock.ts` / `queue-file-lock.ts` | `withFileLock()`, `withPathFileLock()`, `withQueueFileLock()` | Exclusive-create single-file locks (`<target>.lock`). |
| `bun-deps.ts` | `typedSpawn`, `which`, `sleep`, `cancellableDelay`, `file`, `spawn` | Injectable wrappers over Bun built-ins for test mocking. |
| `queue-writer.ts` | `writeQueueCommand()`, `writeRetryCommand()` | Writes queue control commands (§31). |
| `paths.ts` | `packageDirRelative()`, `getRunsDir()`, `getEventsRootDir()` | Shared run/event path helpers. |

Other files (`gitignore.ts`, `diff-files.ts`, `feature-name.ts`, `command-argv.ts`, `nax-project-root.ts`, `porcelain.ts`, `git-add.ts`, `git-env.ts`, `jsonl-tail.ts`, `process-alive.ts`, `log-test-output.ts`, …) are single-purpose helpers — consult their source for details.

---

## §52 Native Agent & Turn Loop (`src/agents/native/`)

The in-process transport for the `native` agent (ADR-027), the built-in default
(`agent.default: "native"` under `agent.protocol: "hybrid"`). Decision records:
ADR-028 (native sessions and the tool loop), ADR-029 (Phase C coding-agent scope).
`@nathapp/nax-ai` may be imported only from `src/agents/native/` and `src/agents/catalog/`
(`bun run check:nax-ai-imports`).

- `adapter.ts` — the native `AgentAdapter`. `complete()` is a one-shot nax-ai call;
  there is no binary, command or pid. `openSession` / `closeSession` are
  transcript-file bookkeeping and `sendTurn` runs the turn loop. Each round trip is
  priced with `priceCall()` (§28).
- `auth.ts` / `credentials.ts` — provider credentials, managed by `nax auth
  login|import|list|rm`; checked by the `checkNativeCredentials` precheck.
- `session/turn-loop.ts` (`runNativeTurn`) — nax owns the conversation: append the
  prompt, call the model, and while it requests tools execute them through the
  `InteractionHandler` and call again. Split into steps: `turn-complete-step.ts`
  (one round trip with a bounded transport-fault retry and a context-overflow
  compaction backstop), `turn-compaction-step.ts` (proactive compaction —
  `execution.compaction`, default `{ enabled: true, compactAtPercent: 90,
  keepRecentPercent: 30 }`), `turn-tool-batch.ts`, and `turn-ask-human.ts` (the
  `ask_human` channel, bounded by `agent.maxInteractionTurns`, default 20).
- **Loop events** (`session/loop-events/`) — a typed in-process handler seam,
  distinct from shell hooks (§27): `before_turn`, `transform_context`
  (shapes the wire copy of history only), `before_request`,
  `after_response`, `before_tool`, `after_tool`, `before_compaction`,
  `before_turn_end`. Built-in handlers (`session/loop-handlers.ts`): invalid-tool-call
  repair and the spin breaker on `before_tool`; model-facing truncation on
  `after_tool`, registered last. Dispatch snapshots array fields so a handler cannot
  rewrite history in place.
- **Tool-result policy** — `session/tool-result.ts` is the only place a
  `tool-result` message is built, so `after_tool` shapes a result *before* it
  enters the message array (no history rewrite, no prompt-cache re-bill).
  Truncation is `src/tools/truncate.ts` (per-line, line-count and byte caps); the
  untruncated body spills to the session scratchpad (`spill/<tool>-<callId>.txt`,
  `src/tools/spill.ts`). Refusals are structural denial markers (ADR-029 §5), never
  string conventions.
- **Transcript store** (`session/transcript-store.ts`) — nax-ai's client is
  stateless, so nax persists the message array under the run output dir
  (`<outputDir>/features/<feature>/sessions/`), never the project tree. A transcript
  records its owner (the op invocation) and the model that wrote it; a different
  model reads it as a **new conversation** rather than replaying cross-model
  history.
- **Turn cancellation** — when the turn signal aborts mid-batch, every outstanding
  tool call is answered synthetically (the tool never runs), the transcript is
  saved with one result per call id, and the abort reason propagates
  (`AbortError` when none); the session handle is then cancelled (§34).

---

## §53 Coding Tools (`src/tools/`)

The tools an operation hands a native session (ADR-029). An op declares its tools
(`RunOperation.tools`, §37); `resolveCodingToolSupport()`
(`src/agents/coding-tool-support.ts`) intersects that declaration with the grants
`resolvePermissions(config, stage)` resolved and builds the session's
`CodingToolRuntime` (`runtime.ts`). `policy.ts`, `runtime.ts` and
`coding-tool-support.ts` carry `nax-permission-mode-allow` markers: they consume resolved grants and decide no
permission of their own.

- **Built-in tools** (`CodingToolName`, `types.ts`): `Read`, `Glob`, `Grep`,
  `Write`, `Edit`, `Delete`, `Git` (verb-gated), `GitCommit`, `RunCommand`
  (runs a *project-declared* command by key — `run-command.ts`), `Exec` (a
  model-authored argv, no shell — `run-command-exec.ts`, guarded by
  `exec-guard.ts`), `Bash` (model-authored shell, only when declared — `bash.ts`),
  `RequestCapability` (records a capability the model wanted and could not
  reach; runs nothing), `ScratchpadWrite` / `ScratchpadRead` / `ScratchpadList`
  (confined to the session scratchpad).
- **Policy** (`policy.ts`) — containment runs before pattern matching (the root
  cannot be widened by any profile); rule precedence is deny > ask > allow.
  `narrow-grants.ts` lets an op narrow an inherited grant (e.g. `Write` to one
  file); `deny-paths.ts` applies `execution.denyPaths` to `Delete`.
- **nax-owned writes** (`nax-owned-writes.ts`) — `.nax/config.json` and
  `.nax/mono/<pkg>/config.json` are refused to every tool (their `quality.commands`
  run through a shell unchecked, so a model must never be able to write them);
  the mutating tools (`Write`, `Edit`, `Delete`, `GitCommit`) are also refused on
  feature PRDs and the root queue-control files (`.queue.txt`,
  `.queue.txt.processing`).
- **Bash policy** — under `gated` / `escalate` (§54) `policy-bash.ts` evaluates a
  command per segment: lexer refusal → deny; any segment matching a deny rule →
  deny; every segment must match an allow rule; then payload checks (denied flags,
  containment, redirects, `cd`); finally any segment matching an ask rule → ask
  (evaluated last, so ask never grants). Under `raw`, `policy-bash-raw.ts` is pass-through
  except a best-effort screen that denies a *parseable* command naming or
  redirecting into nax config files, feature `prd.json` or the queue-control files —
  advisory by construction (substitution is not screened).
- **Tool providers** (`provider-*.ts`) — tools supplied outside `CodingToolName`:
  `static` (schema reviewed in-repo) or `discovered` (schema from an external
  process, e.g. MCP, §57), advertised under a `<providerId>__<tool>` namespace.
- **Tool audit** (`tool-audit.ts`) — a durable record of every coding-tool call,
  one JSON file per session under `<outputDir>/tool-audit/<feature>/`
  (`toolAuditDir()`). Rows carry `schemaVersion` (`TOOL_AUDIT_SCHEMA_VERSION` = 1;
  new fields are additive and optional), `tool`, `outcome`
  (`ok | error | denied | denied:ask`), `input`, `resultBytes` /
  `resultBytesPreTruncation`, `executed`, `approval` (`decidedBy`, `remembered`,
  `latencyMs`), `sandbox` (§55), Bash/Exec `exitCode`, `provider`, and correlation
  ids `callId` (operation-layer, spans retries and hops — a foreign key, not
  unique), `scopeId`, `turnId`, `roundTrips`, `toolCallId`. Join on `runId` +
  `callId` / `turnId`.

---

## §54 Permissions, Bash Approval & Approvals (`src/permissions/`)

Permission resolution itself stays in `resolvePermissions()`
(`src/config/permissions.ts`, §14 in `agent-adapters.md`); `src/permissions/`
holds the rule grammar, the Bash lexer, and the interactive ask tier.

- `grammar.ts` — `parseToolExpression()` / `parseRuleList()` for
  `execution.permissions` rules (`Read`, `Write(src/**,test/**)`,
  `Git(diff,log)`, `Bash(ls *, git status*)`). Rules sit in `allow` / `deny` / `ask`
  lists per stage.
- `bash-lex.ts` — `lexBashCommand()`: a deliberately small shell language;
  anything it does not model (command/process substitution, backticks, subshells,
  here-docs, fd duplication, `&>`, unbalanced quotes) is refused by name under
  `gated`; brace/glob characters in a token are refused later by `policy-bash.ts`.

**Bash approval modes (ADR-030).** `execution.bashApproval` (default `raw`), with a
per-stage override `execution.permissions.<stage>.bashApproval`, resolved by
`resolveBashApproval()`:

| Mode | Behaviour |
|:---|:---|
| `raw` | Pass-through; only the best-effort protected-path screen (§53). With `execution.sandbox.enabled` the command runs inside the OS sandbox and is **refused** if the sandbox is unavailable (§55) |
| `gated` | Per-segment adjudication (§53). Bash is offered only when a `Bash(...)` allow rule resolves for the stage |
| `escalate` | `gated`, except a denial the gate could not adjudicate goes to the `ask` tier instead of `deny` |

A stage that declares Bash under `gated` / `escalate` but has no `Bash(...)` allow
rule is **inert** — the tool is never offered; `src/config/inert-bash-stages.ts`
warns once per such stage at run start.

**Ask tier.** An `ask`-matched call is resolved by a fail-closed chain
(`ask-chain.ts`, `chainAskLinks()`; the chain appends its own terminal deny):

1. **Approvals cache** (`approvals-link.ts`, `approvals-store.ts`) — remembered
   human decisions, byte-exact on `(stage, command)`, stored in
   `<outputDir>/approvals.json` (outside the repo/worktree). `approvals-taint.ts`
   taints and empties the store around any dispatch scope of a forge-capable run
   (a `raw` stage with no sandbox), and the cache link abstains on a tainted store.
2. **Human** — `src/interaction/ask-link.ts` renders the request through the
   interaction chain (§26); secrets are masked (`secret-spans.ts`) and a request
   whose masked text would hide shell syntax is denied as unshowable. The wait is
   bounded by `execution.approvalTimeout` (default 600 000 ms). Headless runs use
   `headlessAskResolver` (deny).

Every resolved ask appends a row (`decidedBy`: `cache | model | human | timeout |
unavailable | cancelled | unshowable`) to `<outputDir>/approval-audit/<runId>.jsonl`
(`approval-audit.ts`). The ask resolver is attached to each Bash-dispatching
`CallContext` by `buildDispatchAskWiring()` (`src/interaction/dispatch-ask.ts`).

**CLI.** `nax approvals list [--json]` and
`nax approvals rm [ids...] [--stage <stage>] [--all] [--yes]` (`src/cli/approvals.ts`,
`-d/--dir` selects the project).

`bashApproval`, `approvalTimeout`, `sandbox` and `commandSafety` are root-only
(ADR-031, §39).

---

## §55 OS Sandbox (`src/sandbox/`)

Wraps **agent-authored** commands — the `Bash` tool and `RunCommand`'s `Exec`
branch — in an OS sandbox. Project-declared commands (`quality.commands`,
`RunCommand` verbs) are never wrapped. Config `execution.sandbox`
(`src/config/schemas-sandbox.ts`):

| Key | Default | Meaning |
|:---|:---|:---|
| `enabled` | `true` | Sandbox on by default |
| `backend` | `"srt"` | `@anthropic-ai/sandbox-runtime`; `srt-backend.ts` is its only importer (`scripts/check-sandbox-imports.ts`) |
| `filesystem.allowWrite` | `[]` | Extra write roots (`~` expanded; relative to the story root). A top-level `.nax/` entry listed here is opened to agents (never `features`, `config.json`, `mono`) |
| `filesystem.denyRead` | `[]` | Extra read denies |
| `network.allowedDomains` | absent | Absent = unrestricted; `[]` = no network; list = allow-list |

Paths must be literal (no glob characters — srt silently drops globbed entries).

- `launcher.ts` — `createCommandLauncher()` decides *how* a command runs, never
  *whether* (that is policy's call). A wrap that throws is an error: a command
  never silently runs unwrapped.
- `policy-builder.ts` (pure) + `policy-inputs.ts` (I/O) — per-call policy, rebuilt
  each command and realpath-resolved: write roots (story root, temp roots,
  package-manager caches, `filesystem.allowWrite`); write denies for every
  top-level `.nax/` entry except `scratchpad/` (plus the entries nax loads as
  input -- `config.json`, `mono/`, `rules/`, `context.md`, `hooks.json`,
  `plugins/`, `templates/`, `prompts/` -- even when absent, minus allowWrite
  opt-ins, nax#2260),
  the queue-control files, git internals / redirect files and `approvals.json`; read denies for
  credential stores (`~/.ssh`, `~/.aws`, `~/.config/gh`, …, nax's own credentials,
  `filesystem.denyRead`).
- `probe.ts` / `registry.ts` — availability is decided by running one wrapped
  command (a sandbox that runs but does not enforce counts as absent); the result
  is cached per process. `SandboxState` is `disabled | available | unavailable`.
- `git-guards.ts` — tripwire after each wrapped command for files that would
  redirect git config/hooks, so nax's next unsandboxed git call cannot run agent
  code.
- `messages.ts` — every sandbox sentence the agent sees (sandboxed or not, writable
  roots, denial hints).

**When unavailable** (e.g. no working bwrap): `raw` Bash is refused
(`rawBashRefusalReason`) and `gated` / `escalate` commands run unwrapped, with a
once-per-process warning. Each Bash / Exec tool-audit row records a `sandbox` entry
(`backend`, `wrapped`, `reason`).

---

## §56 Command-Safety Shadow (`src/command-safety/`)

An **observational** classifier for every agent-authored `Bash` / `Exec` command
(P5; ADR-030 single-gate rule). It decides nothing: it never changes a verdict,
delays a call or fails a call. Config `execution.commandSafety.shadow`
(root-only, ADR-031); absent = off (default):

| Key | Default | Meaning |
|:---|:---|:---|
| `url` | — | SystemOne endpoint; must be loopback unless `allowRemote` |
| `timeoutMs` | 3000 | Per-classification timeout (200–30 000) |
| `authEnv` | `NAX_COMMAND_SAFETY_AUTH` | *Name* of the env var holding the auth token |
| `allowRemote` | `false` | Permit a non-loopback URL |

- `tap.ts` — the only code `runtime.callTool` calls; observes `Bash` and `Exec`
  only (a `RunCommand` verb runs a user-declared command and is never observed).
- `shadow.ts` — per-story shadow built by `buildCommandShadow()` (`build.ts`):
  `observe()` scores rules synchronously and starts classification (never
  awaited); `settle()` attaches the ledger outcome; a row is written once both
  halves exist.
- `rule-scorer.ts` — deterministic regex baseline to measure the model against;
  given the project root it does not flag paths inside the project as
  `outside_project`.
- `questions.ts` — the versioned question set (`QUESTION_SET_VERSION`) sent via
  `systemone-client.ts` (one POST, no retries, total by construction).
- `row.ts` — appends one redacted JSON row per command to
  `<outputDir>/command-safety/<runId>.jsonl`, carrying the command / argv, the
  executed argv and `cwd`, the mechanical verdict, the ledger outcome, the rule
  result, the model answers, and the tool-audit correlation ids
  (`identifiers.ts`) so shadow rows join tool-audit rows.

---

## §57 MCP (`src/mcp/`)

External MCP servers whose tools the native agent may call, surfaced as
`discovered` tool providers (§53). Config `mcp.servers.<id>` (`src/config/schemas-mcp.ts`,
`.strict()`):

| Key | Default | Meaning |
|:---|:---|:---|
| `command` / `args` / `env` | — / `[]` / `{}` | stdio server launch |
| `stages` | `[]` | Pipeline stages (or `"*"`) the server attaches to |
| `allowedTools` | all locked tools | Optional allow-list |
| `timeoutMs` | 60 000 | Per-call ceiling |
| `enabled` | `true` | Kill switch |

- `provider.ts` — one `ToolProvider` per server; tools are advertised as
  `<id>__<tool>` (the id is the namespace, so it may not contain `__`).
- `lock.ts` — `.nax/mcp-lock.json` pins each server's tool names and input-schema
  hashes; a new or changed tool is **withheld** until a human runs `nax mcp lock`
  (`src/cli/mcp.ts`), like `bun.lock`.
- `pool.ts` — run-scoped connections keyed by `(serverId, workdir)` so parallel
  worktrees never query another checkout; owned by `NaxRuntime.mcpPool` and closed
  in `runtime.close()` (§36).
- `client.ts` — the only SDK wrapper (stdio transport, explicit env).
- `rollup.ts` — per-run server lifecycle rollup at
  `<outputDir>/mcp/<runId>-servers.json`, including withheld tools.
