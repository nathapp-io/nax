# Subsystems — nax

> §17–§51: Pipeline, execution, TDD, acceptance, verification, routing, plugins,
> runtime, managers, operations, post-run curator, config, logger, log-format,
> CLI, commands, optimizer, plan, precheck, project, findings, prompts, analyze, utils.
> Part of the [Architecture Documentation](ARCHITECTURE.md).
>
> _Last updated: 2026-06-19._

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
          StoryOrchestratorBuilder.CANONICAL_ORDER (story-orchestrator.ts)
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
| 7 | `execution` | `execution.ts` | Run the per-story orchestrator: test-writer → greenfield-gate → implementer → full-suite-gate → verifier → verify-scoped → lint-check → typecheck-check → semantic/adversarial review, plus `runFixCycle` fix strategies. See §19 / story-orchestrator `CANONICAL_ORDER`. |
| 8 | `completion` | `completion.ts` | Mark complete, fire hooks, save metrics |

> **Per-story phases live in `src/execution/story-orchestrator.ts`, not in standalone pipeline stages.** `executionStage` builds a `StoryOrchestratorBuilder` whose `CANONICAL_ORDER` sequences the phases above. Verification flows via Operations (`verifyScopedOp` / `fullSuiteGateOp`); fixes flow via `runFixCycle` (`src/findings/`). Formatting is reactive (the `mechanical-formatfix` fix strategy), not a dedicated stage.

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

The shared mutable state passed through all stages. Acts as the single source of truth (SSOT) for config, paths, and story state — downstream functions (`reviewFromContext`, `runThreeSessionTddFromCtx`, `runRectificationLoopFromCtx`, `buildStoryContextFullFromCtx`) accept it directly instead of positional args.

**Path fields (resolved at context creation — never mutated by stages):**

| Field | Description |
|:------|:------------|
| `projectDir` | Absolute path to repo root where `.nax/` lives. Stable across worktree and monorepo mode. Used as the prompt audit base dir (fast path — no parent-dir walk). |
| `workdir` | Resolved execution directory. Includes `story.workdir` sub-path when set: `story.workdir ? join(base, story.workdir) : base`. In parallel mode, `base` is the worktree path. |

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
| Parallel | Stories in separate git worktrees | `parallel-coordinator.ts`, `parallel-worker.ts` |
| Parallel batch | Group compatible stories in one session | `parallel-batch.ts` |

### Sequential Worktree Isolation (EXEC-002)

When `execution.storyIsolation === "worktree"`, each story in sequential mode gets its own git worktree:

```
Per-story worktree lifecycle:
1. Create .nax-wt/<storyId> via git worktree add (at story start)
2. Execute story in isolated worktree (no cross-story state leakage)
3. Merge to main (if successful)
4. Remove worktree directory via git worktree remove (reclaim disk)
5. Keep branch nax/<storyId> for diagnostics and re-run cleanup
```

`src/execution/pipeline-result-handler.ts`:
- `handlePipelineSuccess()` — marks story passed, captures diff summary, records metrics, removes worktree
- `handlePipelineFailure()` — manages escalation, merging, pausing
- `removeWorktreeDirectory()` — removes `.nax-wt/<storyId>` from git worktree tracking (preserves branch)

### Parallel Execution Flow

```
ParallelCoordinator
  → creates WorktreeManager (git worktrees)
  → dispatches stories to ParallelWorker instances
  → each worker runs UnifiedExecutor in its own worktree
  → WorktreeMerge merges changes back to main branch
```

### Escalation

`src/execution/escalation/tier-escalation.ts`:
- Retries failed stories at higher tiers: `fast → balanced → powerful`
- `TierOutcome` tracks attempt results for each tier
- Max attempts configurable via `config.execution.maxRetries`

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

The three TDD sessions are typed Operations (`writeTddTestOp`, `implementTddOp`,
`verifyTddOp` in `src/operations/`), sequenced by the per-story orchestrator
(`src/execution/story-orchestrator.ts` — `CANONICAL_ORDER`). There is no
`src/tdd/orchestrator.ts`; `src/tdd/` holds isolation, verdict, rollback, and
cleanup helpers only.

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

Isolation enforced via `src/tdd/isolation.ts` — checks `git diff` between sessions.

### TDD Lite Mode

Skips strict file isolation for performance. Test-writer may add src/ stubs; implementer may expand test coverage.

### Failure Categories

| Category | Meaning |
|:---------|:--------|
| `isolation-violation` | Session modified files outside its allowed scope |
| `session-failure` | Agent session crashed or timed out |
| `tests-failing` | Tests still fail after all sessions |
| `full-suite-gate-exhausted` | Full-suite gate failed for attributable failures and rectification exhausted before verifier |
| `verifier-rejected` | Verifier found issues in implementation |
| `greenfield-no-tests` | Test-writer produced no tests |
| `runtime-crash` | Unrecoverable runtime error |

### Verdict System

`src/tdd/verdict.ts` + `verdict-reader.ts`:
- Parses agent output to determine PASS/FAIL/NEEDS_REVIEW
- Supports free-form text coercion ("APPROVED" → pass, "REJECTED" → fail)
- Used by verifier session to make final determination

---

## §20 Acceptance Test System

### Overview

`src/acceptance/`:
- **Generator** (`generator.ts`): Parse AC → generate test skeleton (unit, component, e2e, CLI, snapshot)
- **Refinement** (`refinement.ts`): LLM enhances AC text for testability
- **Fix generator** (`fix-generator.ts`): Auto-generate fix stories from failed ACs
- **Fix diagnosis** (`fix-diagnosis.ts`): Diagnose why acceptance tests fail
- **Fix execution** (`acceptanceFixSourceOp` / `acceptanceFixTestOp` in `src/operations/`): Execute acceptance fixes (source or test scope)

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
| `crash-detector.ts` | Detect runtime crashes in test output |
| `failure-records.ts` | Failure record persistence |

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
| `detector.ts` | `detectFramework()` — identifies test runner (Bun, Jest, Vitest, etc.) |
| `parser.ts` | `parseTestOutput()`, `formatFailureSummary()`, `analyzeTestExitCode()` |
| `ac-parser.ts` | `parseTestFailures()` — AC-ID extraction for the acceptance loop |

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
   - tddStrategy: `"strict"`, `"lite"`, `"off"`, `"auto"`
   - Output: `test-after`, `tdd-simple`, `three-session-tdd`, `three-session-tdd-lite`, `no-test`

3. **`complexityToModelTier()`** (`router.ts`) — Maps complexity → tier
   - simple → fast, medium → balanced, complex/expert → powerful

### Routing Strategies (Pluggable)

| Priority | Strategy | File |
|:---------|:---------|:-----|
| 1st | Plugin routers | Plugin system |
| 2nd | LLM classification | `strategies/llm.ts` |
| 3rd | Keyword heuristic | `router.ts` (built-in) |

### RoutingResult

Stored in `ctx.routing`:

```typescript
interface RoutingResult {
  complexity: Complexity;
  initialComplexity: Complexity;
  modelTier: ModelTier;
  testStrategy: TestStrategy;
  reasoning: string;
  estimatedCost: number;
  agent?: string;  // Agent override
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
  setup?(config, logger);
  teardown?();
  extensions: PluginExtensions;
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

**Reference:** `src/plugins/registry.ts`, `src/plugins/loader.ts`

---

## §24 Context Engine & Constitution System

### Context Engine v2 (`src/context/engine/`)

Stage-aware, session-aware, pluggable context assembly. Single point of context
assembly for all pipeline stages. Spec: `SPEC-context-engine-v2.md`;
decision record: ADR-010. **User guide:** [docs/guides/context-engine.md](../guides/context-engine.md).

**Entry point:** `ContextOrchestrator.assemble(ContextRequest)` →
`ContextBundle { pushMarkdown, pullTools, digest, manifest, chunks }`.

**Pipeline (9 steps):**

1. Filter providers for this stage (`stageConfig.providerIds`).
2. Parallel `fetch()` with 5-second timeout per provider.
3. Score chunks (role × freshness × kind weights).
4. Deduplicate (character-level trigram Jaccard ≥ 0.9).
5. Role-filter (drop chunks whose audience tag mismatches `request.role`).
6. Min-score filter (`config.context.v2.minScore`).
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
| `CodeNeighborProvider` | import graph — co-changed files | `package-scoped` / `cross-package` |
| `TestCoverageProvider` | coverage metrics | `package-scoped` |
| Plugin providers | npm packages or project-relative paths | operator-registered |

**Hybrid push/pull model.** Push markdown is pre-injected on every stage. Pull
tools (`query_neighbor`, `query_feature_context`) are agent-callable mid-session,
opt-in per stage via `config.context.v2.pull`, capped by
`maxCallsPerSession`.

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
- `loader.ts` — loads from `.nax/constitution.md` or generates
- `generator.ts` — generates constitution from project analysis
- `generators/` — per-agent constitution formatting (aider, claude, cursor, opencode, windsurf)

---

## §25 Review & Quality System

### Review Execution

There is no `src/review/orchestrator.ts`. Semantic and adversarial review run as
Operations — `semanticReviewOp` (`src/operations/semantic-review.ts`) and
`adversarialReviewOp` (`src/operations/adversarial-review.ts`) — sequenced by the
story orchestrator (§17/§19). `src/review/runner.ts` (`runReview()`) is the
shared review entry used outside the per-story op path; `src/review/semantic.ts`
and `src/review/adversarial.ts` hold the review logic/helpers.

- Mechanical checks (lint, typecheck) run as their own ops (`lintCheckOp`,
  `typecheckCheckOp`); test/build run via the verification gates (§21).
- Plugin reviewers: deferred end-of-run review (`src/execution/deferred-review.ts`),
  observational by default — set `review.pluginMode: "gating"` to fail the run
  (per-story plugin gating removed, ADR-023 / #1146).
- Adversarial review supports concurrent sessions (configurable via
  `adversarial.maxConcurrentSessions`).

### Semantic Review

`src/review/semantic.ts`:
- LLM-powered behavioral review against story acceptance criteria
- Configurable diff modes: `"embedded"` (diff inlined in prompt, ~50KB cap) or `"ref"` (reviewer self-serves via git tools, no cap)
- `resetRefOnRerun` option to clear `storyGitRef` on re-run

### Mechanical vs LLM Check Classification

Checks split into **mechanical** (typecheck, lint, build, format) and **LLM** (semantic, adversarial). When mechanical checks fail but LLM checks pass, `mechanicalFailedOnly: true` is set on the result — the fix cycle uses this to suppress tier escalation for unfixable mechanical issues (e.g., lint errors in test files the implementer cannot modify).

### Adversarial Review (REVIEW-003)

`src/review/adversarial.ts`:
- LLM-based adversarial code review, distinct from semantic review
- Semantic asks: "Does this satisfy the ACs?" / Adversarial asks: "Where does this break? What is missing?"
- Own ACP session (`reviewer-adversarial`), NOT the implementer session
- Default diffMode: `"ref"` (reviewer self-serves via git tools)
- Finding categories: `input`, `error-path`, `abandonment`, `test-gap`, `convention`, `assumption`
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
has a per-strategy `maxAttempts`; the cycle is bounded globally by
`maxAttemptsTotal`. `classifyOutcome(before, after)` compares findings across
iterations to detect progress (`improved` / `unchanged` / `regressed`).

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
claims the re-tagged finding on the next iteration. Declarations with fabricated
PRD quotes inject a `prd_quote_mismatch` advisory finding (severity=warning) and
do not re-tag.

The test-writer strategy's `maxAttempts` is set to `2` to allow exactly one
re-fire after the initial source-bug-error attempt.

This wiring is internal to the fix cycle (`runFixCycle`, §Fix Cycle above).

### Review Audit Trail

`src/review/review-audit.ts`:
- Runtime-owned JSON audit writer for semantic and adversarial reviewer decisions
- Directory: `.nax/review-audit/<featureName>/<epochMs>-<sessionName>.json`
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
- Executes lint, typecheck, build, lintFix commands
- Supports command chaining and failure handling

### Quality Test Command Resolver (SSOT)

`src/quality/command-resolver.ts`:
- `resolveQualityTestCommands()` — single source of truth for test command resolution across the pipeline
- Priority: `review.commands.test` ?? `quality.commands.test`
- `{{package}}` substitution in `testScoped` template for monorepo stories
- Monorepo orchestrator promotion (turbo/nx filter syntax replaces per-file expansion)
- Scope file threshold tracking (default 10, configurable)

---

## §26 Interaction & Human-in-the-Loop

### Interaction Chain

`src/interaction/chain.ts`:
- Multi-plugin support with priority ordering
- First responsive plugin wins

### Triggers

`src/interaction/triggers.ts`:

| Trigger | Fires when |
|:--------|:-----------|
| `cost-exceeded` | Story cost exceeds budget |
| `cost-warning` | Cost approaching threshold |
| `merge-conflict` | Git merge conflict detected |
| `max-retries` | Retry limit reached |
| `security-review` | Security-critical story |
| `pre-merge` | Before merging worktree |
| `story-ambiguity` | Ambiguous AC detected |
| `review-gate` | Review findings need approval |

### Interaction Bridge

`src/interaction/bridge-builder.ts`:
- Detects questions in agent output
- Prompts user, captures response
- Re-injects response into agent session (multi-turn ACP)

### Plugins

`src/interaction/plugins/`:
- **Auto:** Non-interactive, applies heuristics
- **Webhook:** External webhook for responses
- *(Telegram, CLI plugins available via extension)*

---

## §27 Hooks & Lifecycle

### Hook Events (11 types)

`src/hooks/types.ts`:

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

### Hook Definition

```typescript
interface HookDef {
  command: string;       // Shell command to execute
  timeout: number;       // Max execution time (ms)
  enabled: boolean;      // Toggle
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
  event: string;
  feature: string;
  storyId?: string;
  status?: string;
  reason?: string;
  cost?: number;
  model?: string;
  agent?: string;
  iteration?: number;
}
```

---

## §28 Metrics & Cost Tracking

### Story Metrics

`src/metrics/tracker.ts`:

```typescript
interface StoryMetrics {
  storyId: string;
  complexity: Complexity;
  initialComplexity: Complexity;
  modelTier: ModelTier;
  modelUsed: string;
  agentUsed: string;
  attempts: number;
  finalTier: ModelTier;
  success: boolean;
  cost: number;
  durationMs: number;
  firstPassSuccess: boolean;
  startedAt: string;
  completedAt: string;
  fullSuiteGatePassed?: boolean;
  runtimeCrashes: number;
  reviewMetrics?: {            // Semantic + adversarial sub-buckets
    semantic?: ReviewMetrics;
    adversarial?: ReviewMetrics;
  };
  findingsByCategory?: Record<string, number>;  // Adversarial finding category breakdown
}
```

### Token Usage

`src/metrics/types.ts`:

```typescript
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
}
```

### Aggregator

`src/metrics/aggregator.ts`:
- Per-run aggregation: `totalCost`, `totalDuration`, `storiesCompleted`
- Batch metrics: distributes cost/duration proportionally across grouped stories

### Cost System

`src/agents/cost/`:
- `pricing.ts` — hard-coded pricing tables for major LLMs (Claude, GPT-4, Gemini)
- `calculate.ts` — `estimateCost()`, `estimateCostByDuration()`
- `parse.ts` — `parseTokenUsage()` from agent output
- ACP sessions emit exact USD via `usage_update` events (preferred over estimation)

---

## §29 Debate System

`src/debate/`:
- Multi-agent debate for complex decisions
- Configurable resolver strategies: synthesis, majority-fail-closed, majority-fail-open, custom
- `ResolverConfig` supports optional `model` field for asymmetric tier routing (resolver can use a different model tier than debaters)

### Debate Flow

```
DebateSession.run()
  → Round 1: Agent A argues position
  → Round 2: Agent B counters
  → ...N rounds
  → Resolver synthesizes final answer
```

### Concurrency

`src/debate/concurrency.ts`:
- Parallel argument generation across agents
- Controlled fan-out with result aggregation

---

## §30 Worktree & Parallel Support

### Worktree Manager

`src/worktree/manager.ts`:
- Creates/manages git worktrees for parallel story execution
- Each story gets an isolated copy of the repository
- Automatic cleanup on completion

### Worktree Merge

`src/worktree/merge.ts`:
- Merges changes from worktrees back to the main branch
- Conflict detection and resolution

### Dispatcher

`src/worktree/dispatcher.ts`:
- Schedules stories across available worktree workers

---

## §31 Queue Management

`src/queue/`:
- Mid-run story control via queue commands
- Commands: `PAUSE`, `ABORT`, `SKIP`
- `QueueManager` monitors a control file for commands
- `queueCheckStage` (pipeline stage 1) reads commands before each story

---

## §32 TUI (Terminal UI)

`src/tui/`:
- React/Ink-based terminal UI for real-time pipeline visualization
- `App.tsx` — main TUI component
- `components/` — pipeline status, story progress, cost display
- `hooks/` — `useKeyboard`, `useLayout`, `usePipelineEvents`, `usePty`
- Toggled via CLI flag; headless mode uses `HeadlessFormatter` instead

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
Spec: `SPEC-session-manager-integration.md`.

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
  - Scratch directory                          - acpx process lifecycle
  - index.json (sidecar replacement)           - inner interaction-bridge loop
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
  multi-prompt orchestration (debate stateful debaters, future keep-open
  patterns).

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

- `scratchDir(sessionId)` → persistent per-session scratch path consumed by
  `SessionScratchProvider` (§24).

### Runtime helpers (not on the manager)

`src/execution/session-manager-runtime.ts`:

- `closeStorySessions` / `closeAllRunSessions` — orchestration.
- `failAndClose(sm, sessionId, agentGetFn)` — atomic `→ FAILED` transition +
  `closePhysicalSession(handle, workdir, { force: true })` (AC-83). Required
  because `listActive()` excludes terminal sessions; teardown would otherwise
  miss a failed session's handle.

### Persistence & portability

- `index.json` replaces the protocol-specific `acp-sessions.json` sidecar.
- `descriptor.json` and `context-manifest-*.json` store paths **relative to
  `projectDir`**; loaders rehydrate to absolute paths for runtime use.
- One `SessionManager` per run, owned by `NaxRuntime` (§36). Sessions do
  not persist across runs; `index.json` is rewritten at run start.

### Mid-turn cancellation

If `sendPrompt` aborts mid-turn (signal abort during the adapter's inner
interaction-bridge loop), SessionManager marks the descriptor `CANCELLED`.
Subsequent `sendPrompt` against the same handle throws `SESSION_CANCELLED` —
the session must be closed and a new one opened to continue.

### Barrel

`src/session/index.ts` exports `SessionManager`, `ISessionManager`,
`SessionDescriptor`, `SessionState`, `SESSION_TRANSITIONS`, and
`CreateSessionOptions`.

---

## §35 Agent Manager

`src/agents/manager.ts` — `AgentManager` class implementing `IAgentManager`.
Decision record: ADR-012 (extraction) + ADR-019 (peer relationship with
SessionManager). Spec: `SPEC-agent-manager-integration.md`.

Owns agent *policy*: default resolution, availability fallback, unavailable-agent
tracking, and the per-call middleware envelope (audit, cost, cancellation,
logging). It is a **pure peer of SessionManager** — neither imports the other.

### Three retry layers — only one is owned here

| Layer | Owner | Scope |
|:------|:------|:------|
| **Availability retry** (auth / 429 / service-down → swap agent) | **AgentManager** | Cross-agent policy |
| **Transport retry** (broken socket, `QUEUE_DISCONNECTED`, stale session) | Adapter (`sessionErrorRetryable` loop) | Protocol-level, same agent |
| **Payload-shape retry** (JSON parse fail → re-ask LLM) | Caller (`src/review/semantic.ts`, `adversarial.ts`) | Output validation, same agent |

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
  - Middleware chain (audit, cost,
    cancellation, logging)
  - resolvePermissions for completeAs
  - Calls ContextOrchestrator.rebuildForAgent
    via buildHopCallback (§37)
  - Emits onSwapAttempt / onSwapExhausted

Neither imports the other. Integration happens at callOp / buildHopCallback.
```

### Three entry points (ADR-019)

| Method | Use case | Session involvement |
|:---|:---|:---|
| `completeAs(name, prompt, opts)` | Sessionless one-shot — Plan, Route, semantic review, debate-propose/rebut/rank, acceptance diagnose | None — calls `adapter.complete` directly |
| `runAsSession(agent, handle, prompt, opts)` | Caller-managed session — orchestrators that keep a session open across multiple prompts (TDD multi-prompt, debate-stateful) | Caller opens handle via `SessionManager.openSession`; AgentManager wraps `sessionManager.sendPrompt` with the middleware envelope; **no internal fallback** |
| `runWithFallback(request)` | Chain iteration with per-hop callback delegation | Iterates the fallback chain; invokes `request.executeHop(agent, bundle, failure, opts)` per hop. The callback (constructed by `callOp` via `buildHopCallback`, §37) owns rebuild + open + send + close |

The middleware envelope (audit → cost → cancellation → logging) wraps every
`completeAs` and `runAsSession` call uniformly. The chain is frozen at
`createRuntime` time — see §36.

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

`resolveDefaultAgent(config)` in `src/agents/index.ts` is the standalone-module
form for code that does not carry a `ctx`. In pipeline stages, prefer
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
export interface NaxRuntime {
  readonly runId: string;
  readonly configLoader: ConfigLoader;       // current() / select(selector)
  readonly workdir: string;
  readonly projectDir: string;
  readonly agentManager: IAgentManager;      // Layer 1 — runAs middleware envelope
  readonly sessionManager: ISessionManager;  // Layer 2 — session lifecycle primitive
  readonly costAggregator: ICostAggregator;  // middleware-owned sink; drains on close
  readonly promptAuditor: IPromptAuditor;    // middleware-owned sink; flushes on close
  readonly reviewAuditor: IReviewAuditor;    // review decision audit; flushes on close
  readonly packages: PackageRegistry;        // root-equiv view when no workdir
  readonly logger: Logger;
  readonly signal: AbortSignal;              // scope-internal AbortController
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
3. Builds the observer middleware chain frozen for the runtime lifetime:
   `cancellation → logging → cost → audit`.
4. Wires `SessionManager` → `AgentManager` via the injected `sendPrompt` and
   `runHop` deps (Shape C — peer relationship).
5. Constructs `PackageRegistry` for polyglot-monorepo correctness.

### close() ordering

`close()` is idempotent and drains in this order:
`signal.abort()` → flush `promptAuditor` / `reviewAuditor` → drain
`costAggregator`. Errors are swallowed and logged (drain must not block run
completion).

### Why a runtime container?

Before ADR-018, three different code paths constructed `AgentManager`
independently (`runner.ts`, `acceptance/generator.ts`, `acceptance/refinement.ts`).
A 401 on routing fell into a different fallback chain than execution; cost events
from rectification and debate proposers landed in unrelated `CostAggregator`
instances. `NaxRuntime` collapses these into one shared lifecycle, with
middleware sinks wired once.

### Middleware chain (ADR-018 §3)

Observer middleware fires for every `completeAs` and `runAsSession` call across
every adapter, including session-internal calls. The chain is structurally
uniform — adapters cannot opt out, and there is no "remember to call the helper"
seam.

| Middleware | Concern | Sink |
|:---|:---|:---|
| `cancellation` | Threads `signal`; translates `AbortError` into a typed failure | — |
| `logging` | Structured JSONL at every entry/exit | `logger` |
| `cost` | Token/cost accumulation across the chain | `CostAggregator` |
| `audit` | Prompt + result capture for replay | `PromptAuditor` |

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
`PromptAuditor`, `PackageRegistry`, `MiddlewareChain`, `AgentMiddleware`, and
`MiddlewareContext`.

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
  readonly noFallback?: boolean;     // TDD ops opt out of cross-agent fallback
}

interface CompleteOperation<I, O, C> extends OperationBase<I, O, C> {
  readonly kind: "complete";
  readonly jsonMode?: boolean;
}
```

`DeterministicOperation` (kind `"deterministic"`) runs a pure function or
filesystem call with no agent session — `verifyScopedOp` and `fullSuiteGateOp`
use it.

### `callOp` — the dispatcher

```typescript
async function callOp<I, O, C>(
  ctx: CallContext,
  op: Operation<I, O, C>,
  input: I,
): Promise<O> {
  const config = ctx.packageView.select(op.config);
  const buildCtx: BuildContext<C> = { packageView: ctx.packageView, config };
  const sections = composeSections(op.build(input, buildCtx));
  const prompt = join(sections);

  if (op.kind === "complete") {
    const result = await ctx.runtime.agentManager.completeAs(name, prompt, opts);
    return op.parse(result.output, input, buildCtx);
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
  `PromptSection` slots (constitution, context, role, task, examples,
  output-format) in canonical order. Builders expose slot-specific methods;
  no middleware chain.
- `ConfigSelector<C>` — `src/config/selectors.ts`. Named, memoized config
  selectors (`reviewConfigSelector`, `planConfigSelector`,
  `acceptanceConfigSelector`, …). One file lists every subsystem's slice;
  refactoring `config.*` surfaces every dependent via the compiler.

### Operation directory

`src/operations/` is the discovery surface for every typed LLM call:

| Op | Kind | Used by |
|:---|:---|:---|
| `planDraftOp` / `planRefineOp` / `planInteractiveOp` | run | Plan stage (`src/operations/plan*.ts`) |
| `decomposeOp` | complete | Story decomposition |
| `classifyRouteOp` | complete | Routing stage |
| `acceptanceGenerateOp` / `acceptanceRefineOp` / `acceptanceDiagnoseOp` | varies | Acceptance subsystem |
| `acceptanceFixSourceOp` / `acceptanceFixTestOp` | run | Acceptance fix stories |
| `semanticReviewOp` / `adversarialReviewOp` | run | Review subsystem |
| `rectifyOp` | run | Rectification loop |
| `debateProposeOp` / `debateRebutOp` | varies | Debate subsystem |
| `writeTddTestOp` / `implementTddOp` / `verifyTddOp` | run | TDD three-session orchestrator |

Multi-session orchestrators (TDD three-session, debate) live next to their
domain (`src/tdd/`, `src/debate/`) and sequence multiple `callOp` invocations.
They are **not** `ISessionRunner` implementations — that interface was removed
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
    | "fix-cycle.iteration"   // Fix cycle iteration (from ADR-022)
    | "fix-cycle.exit"        // Fix cycle completed
    | "fix-cycle.validator-retry";

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
    "rollupPath": "~/.nax/global/curator/rollup.jsonl"  // Cross-run rollup location
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
| `nax curator gc [--keep N]` | Prune old rollup rows |

See [curator.md guide](../guides/curator.md) for full CLI reference.

### Atomicity & Safety

- **Read-only on artifacts** — curator only reads run artifacts, never modifies them
- **Append-only rollup** — multiple runs writing to rollup; POSIX append is atomic per-line
- **Idempotent proposals** — running curator twice on the same run overwrites proposals (deterministic heuristics)
- **Human gate** — `nax curator commit` opens files in `$EDITOR` for review before persisting
- **Reversible** — all changes stay in working directory; you commit to git when ready

### Integration with Review Audit

Review audit ([§25](./subsystems.md#§25-review--quality-system)) captures semantic and adversarial findings. Curator's H1 heuristic (repeated review finding) depends on `review.audit.enabled: true` to populate `<outputDir>/review-audit/`. Without it, H1 produces no proposals and curator quality degrades gracefully (other heuristics still fire).

User guide: [curator.md guide](../guides/curator.md) §Integration with Review Audit.

---

## §39 Config (`src/config/`)

Layered configuration system — the single source of truth for all nax settings. Loads `~/.nax/config.json` (global) and `<workdir>/.nax/config.json` (project), merges them with schema-derived defaults, applies per-package monorepo overrides from `.nax/mono/<pkg>/config.json`, and validates the result with Zod. Guards removed/legacy keys (`rejectLegacyAgentKeys`, `rejectUnimplementedScopedProfile`) at load time to prevent silent degradation.

**Key exports:**
- `NaxConfig`, `NaxConfigSchema`, `DEFAULT_CONFIG` — main config type + Zod schema + schema-derived default (never a hand-maintained literal)
- `loadConfig(workdir)` / `createConfigLoader()` / `ConfigLoader` — entry points; return fully merged, validated config; `ConfigLoader` is the runtime accessor for live-reload awareness
- `findProjectDir(startDir)`, `globalConfigPath()`, `globalConfigDir()`, `projectConfigDir()` — config filesystem discovery helpers (`getRunsDir` / `getEventsRootDir` live in `src/utils/paths.ts`, not here)
- `resolvePermissions(config, stage)` / `PipelineStage` / `ResolvedPermissions` — permission SSOT (see §14 in `agent-adapters.md`); lives in `src/config/permissions.ts` and is imported directly by callers, not via the config barrel
- Named selectors (20+): `tddConfigSelector`, `planConfigSelector`, `routingConfigSelector`, … — typed config slices consumed by `callOp` via `packageView.select`
- `resolveTestStrategy()`, `isThreeSessionStrategy()` — test-strategy resolution (ADR-015)
- `deepMergeConfig()`, `mergePackageConfig()` — merge primitives for the layering order
- `validateDirectory()`, `isWithinDirectory()` — path-security guards (see §12 in `design-patterns.md`)

**Entry point:** `src/config/index.ts` (barrel); slice types are imported from the leaf `src/config/selectors` (see `config-patterns.md`).

**Called by:** almost everything. Wired at bootstrap by `loadConfig` in `src/execution/lifecycle/run-setup.ts`. `resolvePermissions` is called inside `src/agents/manager.ts`, `src/session/manager.ts`, and `src/session/manager-run.ts`.

---

## §40 Logger (`src/logger/`)

Structured JSONL logging facility — the single place where `LogEntry` records are produced. Writes to an optional JSONL file and/or the console (level-gated for console; file always receives all levels). `src/log-format/` (§41) consumes `LogEntry` for human-facing presentation — the two directories are cleanly layered, distinct concerns.

**Key exports:**
- `Logger` — owns file writer + optional console output
- `initLogger(opts)` — global singleton initialiser (call once per run in `run-setup.ts`)
- `getLogger()` / `getSafeLogger()` — `getLogger` throws if not yet initialised; `getSafeLogger` returns `undefined` (for modules that may run before init)
- `resetLogger()` — test teardown helper
- `LogEntry`, `LogLevel`, `LoggerOptions`, `StoryLogger` — types
- `formatConsole()`, `formatJsonl()` — raw formatters (internal; human presentation is in §41)

**Entry point:** `src/logger/index.ts`

**Called by:** every pipeline stage and subsystem. `suppressConsole: true` is set when TUI mode is active to avoid corrupting Ink's terminal output.

---

## §41 Log Format (`src/log-format/`)

Human-facing presentation layer for log entries and run summaries. Consumes `LogEntry` records from `src/logger/` (§40) and renders them with colour and multiple verbosity modes. This module never writes `LogEntry` records — it is a pure leaf, called only by `src/pipeline/subscribers/headless-formatter.ts` and the TUI event stream.

**Key exports:**
- `formatLogEntry(entry, opts)` / `FormattedEntry` — formats a single `LogEntry` for terminal display
- `formatRunSummary(summary, opts)` — renders end-of-run statistics (cost, duration, pass/fail counts)
- `formatTimestamp()`, `formatDuration()`, `formatCost()` — display helpers
- `VerbosityMode` — `"quiet" | "normal" | "verbose" | "json"`
- `RunSummary`, `StoryStartData`, `StageResultData`, `FormatterOptions` — data types
- `EMOJI` — named emoji constants (isolated here to keep `src/logger/` machine-parseable)

**Entry point:** `src/log-format/index.ts`

> **Rename note (2026-06-17):** was `src/logging/`; renamed to remove the near-identical collision with `src/logger/` that produced false "duplicate subsystem" findings. 5 import sites updated; behaviour unchanged.

---

## §42 CLI (`src/cli/`)

High-level CLI command implementations. Each file maps to one user-facing command (`init`, `setup`, `plan`, `accept`, `runs`, `status`, `rules`, `interact`, `generate`, `config`). Commands are wired to the Bun binary in `bin/nax.ts` via `src/commands/` (§43). This is one of two directories permitted to call `process.cwd()` as the bootstrap workdir default.

**Key exports:**
- `initCommand(opts)` — interactive project initialisation
- `setupCommand(opts)` / `writeSetupConfig()` — config wizard; `writeSetupConfig` writes config files via `Bun.write` and handles mono package configs (fully implemented in `src/cli/setup-write.ts`)
- `planCommand(opts)`, `planDecomposeCommand(opts)`, `runPlanPipeline(...)` — planning flow (delegates to `src/plan/`)
- `acceptCommand(opts)` — acceptance test runner
- `runsListCommand()`, `runsShowCommand()` — run history viewer
- `displayCostMetrics()`, `displayFeatureStatus()` — status sub-commands
- `generateCommand(opts)` — `nax generate` (regenerates CLAUDE.md from context.md)
- `configCommand(opts)` — config get / set / diff display
- `rulesExportCommand()`, `rulesLintCommand()`, `rulesMigrateCommand()` — rules management
- `interactListCommand()`, `interactRespondCommand()`, `interactCancelCommand()` — interaction queue
- `resolveRunProfileOverride(opts)` — resolves `--profile` CLI flag to a permission profile name

**Entry point:** `src/cli/index.ts`

---

## §43 Commands (`src/commands/`)

Thin wrappers and shared resolution utilities that sit between `bin/nax.ts` and `src/cli/` (§42). Handles cross-cutting concerns: run-project resolution, precheck orchestration, curator, log streaming, run locking, config migration.

**Key exports:**
- `resolveProject(opts)` / `resolveProjectAsync(opts)` / `ResolvedProject` — resolves workdir + config + runtime for any command; the single entry point every command uses
- `curatorStatus()`, `curatorCommit()`, `curatorDryrun()`, `curatorGc()` — post-run curator sub-commands
- `logsCommand(opts)` — streams / filters `.nax/logs/*.jsonl` entries
- `precheckCommand(opts)` — wires `src/precheck/` (§46) to the CLI
- `runsCommand(opts)` — run history listing
- `unlockCommand(opts)` — removes stale `.nax/nax.lock` files
- `migrateCommand(opts)` / `detectGeneratedContent()` — migrates legacy PRD/config formats

**Entry point:** `src/commands/index.ts`

---

## §44 Optimizer (`src/optimizer/`)

Prompt token-reduction layer, invoked as pipeline stage 6 (`src/pipeline/stages/optimizer.ts`). Two built-in implementations: `NoopOptimizer` (pass-through) and `RuleBasedOptimizer` (heuristic whitespace/section reduction). A plugin can provide a third via `IPromptOptimizer`. Strategy is resolved once per run by `resolveOptimizer(config, pluginRegistry)`.

**Key exports:**
- `IPromptOptimizer` — interface: `optimize(input) → Promise<PromptOptimizerResult>`
- `PromptOptimizerInput`, `PromptOptimizerResult` — input/output types
- `NoopOptimizer` — returns prompt unchanged; used when no plugin or rule-based config is active
- `RuleBasedOptimizer` — strips redundant whitespace, collapses repeated sections
- `resolveOptimizer(config, pluginRegistry?)` — factory: plugin → rule-based → noop
- `estimateTokens(text)` — rough character-based token estimator

**Entry point:** `src/optimizer/index.ts`

> **Coverage note:** `rule-based.optimizer.ts` core logic has thin unit test coverage (§10 gap in gap analysis). Add targeted tests before extending rule logic.

---

## §45 Plan (`src/plan/`)

Planning pipeline that converts a feature spec into a `prd.json`. Supports four strategies — `single` (one-shot LLM), `pipeline` (sequential critique passes), `debate` (multi-agent parallel then synthesise), `refine` (existing PRD + spec delta). Orchestrated by `planCommand` (§42). The `runPlanCritic` step runs mechanical checks (citation, contradiction, AC-anchoring, coverage) and an LLM judge; blockers trigger a draft revision via `planDraftOp`.

**Key exports:**
- `IPlanStrategy`, `PlanModeContext`, `PlanCommandOptions`, `PlanDeps` — shared types
- `SinglePlanStrategy`, `PipelinePlanStrategy`, `DebatePlanStrategy`, `RefinePlanStrategy` — four concrete strategies
- `createPlanStrategy(mode, deps)` — factory; selects strategy from `config.plan.mode`
- `buildPlanModeContext(opts, deps)` — assembles the context object threaded through strategy execution
- `writeOrRecoverPrd(path, content)` — atomic PRD write with recovery on parse failure
- `runPlanCritic(input)` — mechanical + LLM critic; triggers revision on blockers
- `finalizePrdRouting(prd, config)` — sets per-story `modelTier` / `testStrategy` from routing config
- `buildPlanComposition(config)` — builds debate composition for pipeline/debate modes

**Entry point:** `src/plan/index.ts`

**Called by:** `src/cli/plan-command.ts`, `src/cli/plan-decompose.ts`. Depends on `src/debate/` (§29), `src/operations/` (§37), `src/prd/`, `src/prompts/` (§49).

---

## §46 Precheck (`src/precheck/`)

Pre-run validation suite. Runs ordered checks before story execution and fails-fast on Tier-1 blockers. Two tiers: environment checks (git, agent CLI, dependencies, disk — no PRD required) and project checks (PRD validity, story counts, story size gate — PRD required). Output is a human-readable table or machine-readable JSON.

**Key exports:**
- `runPrechecks(prd, workdir, config, opts)` — main entry point; returns `PrecheckOutput`
- `PrecheckOutput` — `{ passed, blockers, warnings, summary, feature }`
- `EXIT_CODES` — `{ SUCCESS: 0, BLOCKER: 1, INVALID_PRD: 2 }`
- `Check`, `PrecheckResult`, `PrecheckOptions` — types
- Named check functions: `checkGitRepoExists`, `checkAgentCLI`, `checkPRDValid`, `checkPendingStories`, `storySizeGate`, and 15+ others
- `storySizeGate(prd, config)` — checks individual story complexity / AC count against configured thresholds

**Entry point:** `src/precheck/index.ts`

**Called by:** `src/commands/precheck.ts` (`nax precheck` command) and `src/execution/lifecycle/run-setup.ts` (automatic pre-run gate on every `nax run`).

---

## §47 Project (`src/project/`)

Auto-detects project language, type, test framework, and lint tool from filesystem manifest files. Language detection inspects `go.mod`, `Cargo.toml`, `pyproject.toml`, `requirements.txt`, `package.json`, `tsconfig.json`. Project-type detection (web-app, api, library, cli, fullstack) infers from dependency lists. All detection is heuristic; the result populates `ProjectProfile` in config and is used by context generators and routing. This is the authoritative detector — new code must call these functions, not re-derive manifest lookups (see `monorepo-awareness.md` §5 / §C).

**Key exports:**
- `detectLanguage(packageDir)` → `"typescript" | "javascript" | "go" | "python" | "rust" | "unknown"`
- `inferFrameworkAndTestRunner(language, pkg)` → `{ framework, testRunner }` from package deps
- `detectProjectProfile(workdir, existing?)` — full profile detection; skips fields already set in `existing`

**Entry point:** `src/project/index.ts` (re-exports from `detector.ts` and `package-stack.ts`)

**Called by:** `src/analyze/scanner.ts` (§50), `src/cli/setup-analyze.ts`, `src/execution/lifecycle/run-setup.ts` (`detectProjectProfile`), `src/context/engine/providers/code-neighbor.ts` and `src/quality/self-verification.ts` (`detectLanguage`), `src/acceptance/hardening.ts` (`detectLanguage` via leaf path).

---

## §48 Findings (`src/findings/`)

Unified finding wire format (ADR-021) and fix-cycle orchestration (ADR-022). All subsystems that detect problems (lint, typecheck, semantic review, adversarial review, acceptance, TDD verifier, plugins) convert their outputs to `Finding[]` at their boundary. The fix cycle (`runFixCycle`) iterates up to `maxIterations`, applies `FixStrategy` instances, validates results, and classifies outcomes.

**Key exports:**
- `Finding`, `FindingSeverity`, `FindingSource`, `FixTarget` — wire types (ADR-021 SSOT)
- `SEVERITY_ORDER`, `compareSeverity(a, b)`, `findingKey(f)` — severity ordering and stable identity key
- Per-producer adapters: `lintDiagnosticToFinding()`, `reviewFindingToFinding()`, `testFailureToFinding()`, `testSummaryToFindings()`, `acFailureToFinding()`, `pluginToFinding()`, `executionFailureToFinding()`, `genericTypecheckDiagnosticToFinding()` — convert subsystem-specific outputs to `Finding`
- `FixStrategy`, `FixCycle`, `FixCycleConfig`, `FixCycleContext`, `FixCycleResult`, `FixCycleExitReason`, `ValidateResult` — cycle-orchestration types
- `runFixCycle(ctx, strategies, findings, config)` — the fix loop (`story-orchestrator.ts` is the primary consumer)
- `classifyOutcome(result)` — determines overall story outcome from cycle result

**Entry point:** `src/findings/index.ts`

**Called by:** `src/execution/story-orchestrator.ts` (primary consumer of `runFixCycle`). All review/lint/test subsystems call the adapter converters at their output boundaries.

---

## §49 Prompts (`src/prompts/`)

Single home for all LLM prompt construction. No prompt template literals are permitted outside this module (see `forbidden-patterns.md` → Prompt Builder Convention). Every string sent to an agent surfaces from a builder class in `src/prompts/builders/`. Builders compose `PromptSection` objects via `SectionAccumulator`; section content functions live in `src/prompts/core/sections/`.

**Builder classes:**
| Builder | Handles |
|:---|:---|
| `TddPromptBuilder` | Implementer, test-writer, verifier, no-test, single-session, tdd-simple, batch roles |
| `RectifierPromptBuilder` | TDD-test-failure, TDD-suite-failure, verify-failure, review-findings rectification |
| `ReviewPromptBuilder` | Semantic review dialogue |
| `AdversarialReviewPromptBuilder` | Adversarial review dialogue |
| `AcceptancePromptBuilder` | Acceptance generator, diagnoser, fix-executor |
| `DebatePromptBuilder` | Propose, critique, rebut, synthesise |
| `OneShotPromptBuilder` | Short single-turn prompts (router, decomposer, auto-approver) |
| `PlanPromptBuilder` | `nax plan` decomposition prompts |
| `GrounderPromptBuilder` | Debate pre-phase: repo grounding |
| `CriticPromptBuilder` | Plan critic (mechanical + LLM checks) |
| `PatchPromptBuilder` | Verifier-pick selector |

**Key infrastructure exports:**
- `composeSections(sections)` → assembled prompt string — used by `callOp` (§37)
- `PromptSection` — `{ key, content, separator? }` — unit of composition
- `loadPromptOverride(role, workdir)` — disk-based prompt override for TDD roles
- `buildSourceRootsSection(roots)` — formats `SourceRoot[]` for plan/grounding prompts
- `SectionAccumulator` — internal builder engine (not barrel-exported; used only within `src/prompts/builders/`)

**Entry point:** `src/prompts/index.ts` (barrel). No subsystem imports from `src/prompts/builders/` directly — always via the barrel.

**Called by:** all `Operation` implementations in `src/operations/` (§37) via `composeSections`, and `src/pipeline/stages/prompt.ts` (stage 5).

---

## §50 Analyze (`src/analyze/`)

Codebase scanner used by `nax analyze` and the planning pipeline. Discovers workspace packages, detects their language, reads `package.json` dep lists, and emits a `CodebaseScan` with `SourceRoot[]` entries (path, language, framework, testRunner, dependencies). Internally delegates to `discoverWorkspacePackages` (§ test-runners module) and `detectLanguage` (§47) — does not re-implement package boundary detection.

**Key exports:**
- `scanCodebase(workdir)` — main entry point; returns `CodebaseScan`
- `scanSourceRoots(workdir)` — returns `SourceRoot[]` (lower-level; used by `nax plan`)
- `CodebaseScan`, `SourceRoot` — output types
- `_scannerDeps` — injectable deps (`discoverWorkspacePackages`, `detectLanguage`, `readPackageJson`) for testing

**Entry point:** `src/analyze/index.ts`

**Called by:** `src/cli/plan-runtime.ts` (wires `scanSourceRoots` into `_planDeps`), `src/cli/plan-command.ts`, `src/cli/plan-decompose.ts`, `src/plan/strategies/context-builder.ts`, `src/debate/pre-phase/grounder.ts` — all consume `scanSourceRoots` via the `_planDeps` injection point.

---

## §51 Utils (`src/utils/`)

General-purpose utilities with no shared subsystem home. No internal cross-dependencies within `src/utils/`. Each file is independently importable from its leaf path (no barrel — `import from "src/utils/llm-json"`, not `"src/utils"`).

**Key files:**
| File | Key Exports | Purpose |
|:---|:---|:---|
| `llm-json.ts` | `parseLLMJson<T>()`, `extractJsonFromMarkdown()`, `buildJsonOutputPrompt()` | **SSOT for LLM JSON parsing** (see `forbidden-patterns.md`). Three-tier extraction: markdown fence → JSON5 → raw. Called by every Operation parser. |
| `git.ts` | `getRepoRoot()`, `getHeadCommit()`, `getBranchName()`, `commitChanges()`, `stageFiles()`, `captureOutputFiles()`, `captureDiffSummary()` | Git operations via `Bun.spawn`. |
| `path-filters.ts` | `filterNaxInternalPaths()`, `filterLockfiles()` | Removes `.nax/` and lockfile paths from "changed files" lists before surfacing to LLM prompts. |
| `path-security.ts` | `resolveSafePath()`, `containsPath()` | Lexical + realpath containment checks (see §12 in `design-patterns.md`). |
| `json-file.ts` | `loadJsonFile<T>()`, `writeJsonFile()` | Typed JSON read/write wrappers over `Bun.file` / `Bun.write`. |
| `errors.ts` | `errorMessage(err)` | Safely extracts a string from `unknown` thrown values. |
| `process-kill.ts` | `killProcessTree(pid)` | SIGTERM + SIGKILL with timeout; used by crash recovery. |
| `bun-deps.ts` | Injectable `spawn`, `sleep`, `file`, `write` refs | Test mocking shims for Bun built-ins. |
| `queue-writer.ts` | `writeQueueCommand()` | Writes PAUSE/ABORT/SKIP signals to `.nax/queue`. |

Other files (`gitignore.ts`, `diff-files.ts`, `feature-name.ts`, `command-argv.ts`, `nax-project-root.ts`, `log-test-output.ts`) are single-purpose helpers — consult their source for details.
