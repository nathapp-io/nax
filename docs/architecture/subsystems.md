# Subsystems — nax

> §17–§33: Pipeline, execution, TDD, acceptance, verification, routing, plugins, and more.
> Part of the [Architecture Documentation](ARCHITECTURE.md).

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
        → Pipeline stages 1–13 (defaultPipeline)
        → Escalation on failure (fast → balanced → powerful)
  → runCompletionPhase() [lifecycle/run-completion.ts]
    → postRunPipeline (acceptance)
    → hooks, metrics, cleanup
```

### Pipeline Stages (15 total)

**Default pipeline** (13 stages, per-story):

| # | Stage | File | Purpose |
|:--|:------|:-----|:--------|
| 1 | `queueCheck` | `queue-check.ts` | Detect queue commands (PAUSE/ABORT/SKIP) |
| 2 | `routing` | `routing.ts` | Classify complexity → model tier (keyword/LLM/plugin) |
| 3 | `constitution` | `constitution.ts` | Load project coding standards/governance doc |
| 4 | `context` | `context.ts` | Auto-detect + gather relevant code/docs within token budget |
| 5 | `prompt` | `prompt.ts` | Assemble story + context + constitution into prompt |
| 6 | `optimizer` | `optimizer.ts` | Reduce token usage while preserving semantics |
| 7 | `execution` | `execution.ts` | Run agent (TDD or test-after based on routing) |
| 8 | `verify` | `verify.ts` | Test verification (scoped via smart-runner) |
| 9 | `rectify` | `rectify.ts` | Auto-fix test failures (inline retry loop) |
| 10 | `review` | `review.ts` | Quality checks (lint, typecheck, format, plugin checks) |
| 11 | `autofix` | `autofix.ts` | Auto-fix lint/format issues before escalating |
| 12 | `regression` | `regression.ts` | Full-suite gate (inline mode only) |
| 13 | `completion` | `completion.ts` | Mark complete, fire hooks, save metrics |

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
| `rootConfig` | The global project config — use only for `autoMode.defaultAgent`, `models`, and `autoMode.escalation`. Never use for per-package overrides. |

**Stage inputs:** `prd`, `story`, `stories`, `routing`, `hooks`, `plugins`

**Intermediate results:** `constitution`, `contextMarkdown`, `builtContext`, `prompt`, `agentResult`, `verifyResult`, `reviewResult`, `acceptanceFailures`, `tddFailureCategory`, `fullSuiteGatePassed`

**Metadata:** `storyStartTime`, `rectifyAttempt`, `autofixAttempt`, `storyGitRef`, `accumulatedAttemptCost`, `reviewFindings`

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

`src/tdd/orchestrator.ts`:

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
- **Fix executor** (`fix-executor.ts`): Execute acceptance fixes

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

### Orchestrator

`src/verification/orchestrator.ts` selects and executes verification strategies:

| Strategy | File | Purpose |
|:---------|:-----|:--------|
| `scoped` | `strategies/scoped.ts` | Smart-runner selects relevant test files |
| `regression` | `strategies/regression.ts` | Full-suite gate |
| `acceptance` | `strategies/acceptance.ts` | Feature-level AC tests |

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
| `parser.ts` | `parseTestOutput()`, `analyzeBunTestOutput()`, `formatFailureSummary()`, `analyzeTestExitCode()` |
| `ac-parser.ts` | `parseTestFailures()` — AC-ID extraction for the acceptance loop |

All verification strategies and the rectification loop import from `test-runners` instead of maintaining their own parsing logic.

### Rectification Loop

`src/verification/rectification-loop.ts`:
- Auto-fixes failing tests inline (fixture, mock, implementation errors)
- Crash detection and recovery
- Configurable max attempts

`src/verification/rectification.ts` — shared rectification utilities:
- `shouldRetryRectification()` — retry decision logic (attempt count, failure count, regression spiral detection)
- `buildEscalationPreamble()` — progressive prompt escalation (rethink phase, urgency phase)
- Deduplication of `TestFailure[]` by (file, testName)

### VerifyResult

```typescript
interface VerifyResult {
  status: "passed" | "failed" | "skipped" | "timeout";
  failures: TestFailure[];   // Parsed test failure context (from test-runners)
  duration: number;
  coverage?: CoverageMetrics;
}
```

---

## §22 Routing & Classification

### Router

`src/routing/router.ts`:

1. **`classifyComplexity()`** — Keyword-based heuristic
   - Examines: story title, AC count, tags
   - Keywords: `COMPLEX_KEYWORDS`, `EXPERT_KEYWORDS`, `SECURITY_KEYWORDS`, `PUBLIC_API_KEYWORDS`
   - Output: `"simple"` | `"medium"` | `"complex"` | `"expert"`

2. **`determineTestStrategy()`** — Decision tree
   - Inputs: complexity, title, AC, tags, `tddStrategy` config
   - tddStrategy: `"strict"`, `"lite"`, `"off"`, `"auto"`
   - Output: `test-after`, `tdd-simple`, `three-session-tdd`, `three-session-tdd-lite`, `no-test`

3. **`complexityToModelTier()`** — Maps complexity → tier
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

## §24 Context & Constitution System

### Context Builder

`src/context/builder.ts`:
- Token-budgeted context assembly for agent prompts
- Priority-based element selection (story context > dependencies > project context)

### Auto-Detection

`src/context/auto-detect.ts`:
- Scans git, detects language, frameworks, test files
- Populates `BuiltContext` with relevant code/docs

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

### Constitution

`src/constitution/`:
- Project-level governance document (coding standards, patterns, rules)
- `loader.ts` — loads from `.nax/constitution.md` or generates
- `generator.ts` — generates constitution from project analysis
- `generators/` — per-agent constitution formatting (6 agent types)

---

## §25 Review & Quality System

### Review Orchestrator

`src/review/orchestrator.ts`:
- Orchestrates semantic + adversarial review execution
- Built-in checks: typecheck, lint, test, format, semantic, adversarial
- Plugin reviewers: custom quality checks (semgrep, security, etc.)
- Supports concurrent review execution (configurable via `adversarial.maxConcurrentSessions`)

### Semantic Review

`src/review/semantic.ts`:
- LLM-powered behavioral review against story acceptance criteria
- Configurable diff modes: `"embedded"` (diff inlined in prompt, ~50KB cap) or `"ref"` (reviewer self-serves via git tools, no cap)
- `resetRefOnRerun` option to clear `storyGitRef` on re-run

### Mechanical vs LLM Check Classification

The orchestrator splits checks into **mechanical** (typecheck, lint, build, format) and **LLM** (semantic, adversarial). When mechanical checks fail but LLM checks pass, `mechanicalFailedOnly: true` is set on the result — autofix uses this to suppress tier escalation for unfixable mechanical issues (e.g., lint errors in test files the implementer cannot modify).

### Adversarial Review (REVIEW-003)

`src/review/adversarial.ts`:
- LLM-based adversarial code review, distinct from semantic review
- Semantic asks: "Does this satisfy the ACs?" / Adversarial asks: "Where does this break? What is missing?"
- Own ACP session (`reviewer-adversarial`), NOT the implementer session
- Default diffMode: `"ref"` (reviewer self-serves via git tools)
- Finding categories: `input`, `error-path`, `abandonment`, `test-gap`, `convention`, `assumption`
- Configurable parallel/sequential execution
- **Scope-aware routing:** adversarial findings in test files are routed to a test-writer session via `autofix-adversarial.ts`, not the implementer (TDD isolation constraint)

### Review Audit Trail

`src/review/review-audit.ts`:
- Fire-and-forget JSON audit writer for semantic and adversarial reviewer output
- Directory: `.nax/review-audit/<featureName>/<epochMs>-<sessionName>.json`
- Tracks parse success, `looksLikeFail` heuristic, and structured result
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
| `AllAgentsUnavailableError` | All configured agents failed or missing |
| `LockAcquisitionError` | Another nax instance holds the lock |
