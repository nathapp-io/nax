# NAX Architecture Deep Analysis

**Date:** 2026-02-28
**Version:** 0.14.1
**Codebase Size:** ~27,333 lines across 146 TypeScript files
**Analysis Method:** Complete source code review via Explore agent

---

## Executive Summary

NAX is a pipeline-based AI agent orchestrator with strong architectural foundations but one critical technical debt item: a 1,685-line god file (`execution/runner.ts`) that violates the project's 400-line guideline by 4x. Overall grade: **B+** (would be A- after refactoring the god file).

**Strengths:**
- Clean pipeline architecture with composable stages
- Excellent plugin system with 6 extension points
- Strong type safety (TypeScript + Zod)
- Good test coverage (105 test files)
- Well-isolated core modules

**Critical Issues:**
- `execution/runner.ts` is a 1,685-line god file handling 8+ concerns
- High coupling in execution module (imports from 15+ modules)
- Verification logic duplication across execution/tdd modules

---

## 1. Module Map

### Directory Structure

```
src/
├── acceptance/      [4 files, 739 lines]   Acceptance test generation
├── agents/          [6 files, 1,577 lines] Agent adapter layer
├── analyze/         [4 files, 547 lines]   PRD decomposition
├── cli/             [10 files, 2,809 lines] Command-line interface
├── commands/        [5 files, 666 lines]   Command utilities
├── config/          [7 files, 1,333 lines] Configuration system
├── constitution/    [3 files, 169 lines]   Coding standards
├── context/         [6 files, 1,354 lines] Context building
├── execution/       [20 files, 6,745 lines] ⚠️ Core orchestration (GOD MODULE)
├── hooks/           [3 files, 339 lines]   Lifecycle hooks
├── logger/          [4 files, 452 lines]   Structured logging
├── logging/         [3 files, 456 lines]   Log formatters
├── metrics/         [4 files, 513 lines]   Metrics tracking
├── optimizer/       [4 files, 387 lines]   Prompt optimization
├── pipeline/        [16 files, 1,815 lines] ✅ Stage-based execution
├── plugins/         [5 files, 1,057 lines] ✅ Plugin system
├── prd/             [2 files, 354 lines]   PRD types
├── precheck/        [3 files, 799 lines]   Pre-execution validation
├── queue/           [3 files, 310 lines]   Queue file handling
├── review/          [3 files, 246 lines]   Quality gates
├── routing/         [11 files, 1,482 lines] Model routing
├── tdd/             [7 files, 1,614 lines] TDD orchestration
├── tui/             [5 files, 732 lines]   Terminal UI
├── utils/           [2 files, ~100 lines]  Git/queue utilities
└── worktree/        [5 files, 620 lines]   Parallel execution
```

### Module Responsibility Matrix

| Module | Responsibility | Complexity | Quality |
|--------|---------------|------------|---------|
| **pipeline/** | Stage-based execution framework | Medium | ✅ Excellent |
| **execution/** | Core orchestration loop | High | ⚠️ God file |
| **routing/** | Complexity classification & model selection | Medium | ✅ Good |
| **agents/** | Agent adapter abstraction | Medium | ✅ Good |
| **tdd/** | Three-session TDD orchestration | High | ✅ Good |
| **plugins/** | Plugin system architecture | Medium | ✅ Excellent |
| **config/** | Configuration loading & validation | Medium | ⚠️ Large schema |
| **context/** | Story context building | Medium | ✅ Good |
| **cli/** | Command-line interface | Medium | ✅ Good |
| **acceptance/** | Acceptance test generation | Low | ✅ Good |
| **metrics/** | Story metrics tracking | Low | ✅ Good |
| **worktree/** | Git worktree management | Medium | ✅ Good |
| **review/** | Quality gate review | Low | ✅ Good |
| **queue/** | Queue file handling | Low | ✅ Good |
| **constitution/** | Coding standards loading | Low | ✅ Good |
| **logger/** | Structured logging | Low | ✅ Good |
| **optimizer/** | Prompt optimization | Low | ✅ Good |
| **analyze/** | PRD decomposition | Medium | ✅ Good |
| **precheck/** | Pre-execution validation | Medium | ✅ Good |
| **hooks/** | Lifecycle hooks | Low | ✅ Good |

---

## 2. Data Flow: PRD → Completion

### High-Level Flow

```
1. CLI Entry (bin/nax.ts)
   ↓
2. CLI Command (cli/index.ts)
   ↓
3. Runner Setup (execution/runner.ts)
   ↓
4. Load Plugins (plugins/loader.ts)
   ↓
5. For Each Story:
   ↓
   Pipeline.execute() [pipeline/runner.ts]
   ├─ queue-check     Check for PAUSE/ABORT/SKIP
   ├─ routing         Classify complexity, select model
   ├─ constitution    Load coding standards
   ├─ context         Build story context (plugin providers)
   ├─ prompt          Assemble final prompt
   ├─ optimizer       Optimize prompt for tokens
   ├─ execution       Spawn agent session (TDD or test-after)
   ├─ verify          Run tests & quality checks
   ├─ review          Run plugin reviewers
   ├─ acceptance      Run acceptance tests
   └─ completion      Mark complete, fire hooks
   ↓
6. Reporter Events (plugins/registry.ts)
   ↓
7. Teardown (registry.teardownAll())
```

### Detailed Execution Flow

**Path 1: Test-After Strategy**
```
execution/runner.ts::run()
  → pipeline/runner.ts::execute()
    → stages/execution.ts
      → agents/claude.ts::run()
        → Spawn Claude Code process
        → Wait for completion
    → stages/verify.ts
      → execution/verification.ts::verify()
        → Run test commands
        → Parse results
  → Reporter.emit('storyComplete')
```

**Path 2: Three-Session TDD Strategy**
```
execution/runner.ts::run()
  → pipeline/runner.ts::execute()
    → stages/execution.ts
      → tdd/orchestrator.ts::orchestrate()
        ├─ Session 1: Scaffold (sonnet)
        │   → agents/claude.ts::scaffold()
        │   → tdd/isolation.ts::verify()
        ├─ Session 2: Implement (opus)
        │   → agents/claude.ts::run()
        │   → tdd/isolation.ts::verify()
        └─ Session 3: Verify (haiku)
            → agents/claude.ts::run()
            → tdd/verdict.ts::parseVerdict()
            → execution/verification.ts::verify()
            → [IF FAIL] tdd/rectification.ts::retry()
    → stages/verify.ts
  → Reporter.emit('storyComplete')
```

**Path 3: Parallel Execution**
```
execution/runner.ts::run()
  → execution/batching.ts::shouldBatch()
  → execution/parallel.ts::executeParallel()
    → worktree/dispatcher.ts::dispatch()
      ├─ Story 1 → Worktree A → Pipeline.execute()
      ├─ Story 2 → Worktree B → Pipeline.execute()
      └─ Story 3 → Worktree C → Pipeline.execute()
    → worktree/merge.ts::mergeAll()
```

---

## 3. Dependency Graph

### Tier Architecture

**Tier 1 (Foundation):**
- `errors.ts` - Error types
- `logger/` - Logging
- `config/` - Configuration
- `prd/types.ts` - PRD data structures

**Tier 2 (Core Domain):**
- `agents/` - Agent adapters (imports: config)
- `routing/` - Routing strategies (imports: config, prd, plugins)
- `context/` - Context building (imports: config, prd, logger)
- `tdd/` - TDD orchestration (imports: agents, config, logger, prd)

**Tier 3 (Infrastructure):**
- `plugins/` - Plugin system (imports: agents, routing, optimizer, prd)
- `metrics/` - Metrics tracking (imports: prd)
- `hooks/` - Lifecycle hooks (imports: config)
- `worktree/` - Parallel execution (imports: config, logger)

**Tier 4 (Orchestration):**
- `pipeline/` - Stage-based execution (imports: tier 1-3 modules)
- `execution/` - Core runner (imports: tier 1-4 modules) ⚠️

**Tier 5 (Interface):**
- `cli/` - Command-line (imports: all tiers)
- `tui/` - Terminal UI (imports: pipeline events)

### Module Import Analysis

**Most Imported Modules (Used By):**
1. `config/` - Used by 90% of modules
2. `logger/` - Used by 80% of modules
3. `prd/types.ts` - Used by 70% of modules
4. `agents/` - Used by execution, pipeline, tdd, cli

**Highest Import Count (Imports From):**
1. `execution/runner.ts` - Imports from 15+ modules ⚠️
2. `pipeline/stages/` - Imports from 8-10 modules each
3. `cli/` commands - Imports from 6-8 modules each

**Well-Isolated Modules:**
- `agents/` - Only imports config
- `logger/` - No domain dependencies
- `metrics/` - Only imports prd types
- `routing/` - Only imports config, prd, plugins

### Coupling Matrix

```
                 agents config context exec pipeline plugins routing tdd
agents              -      ✓      ✗      ✗      ✗       ✗       ✗     ✗
config              ✗      -      ✗      ✗      ✗       ✗       ✗     ✗
context             ✗      ✓      -      ✗      ✗       ✗       ✗     ✗
execution           ✓      ✓      ✓      -      ✓       ✓       ✓     ✓  ⚠️
pipeline            ✓      ✓      ✓      ✗      -       ✓       ✓     ✓
plugins             ✓      ✗      ✗      ✗      ✗       -       ✓     ✗
routing             ✗      ✓      ✗      ✗      ✗       ✓       -     ✗
tdd                 ✓      ✓      ✗      ✓      ✗       ✗       ✗     -

Legend: ✓ = imports, ✗ = does not import, ⚠️ = excessive coupling
```

**Observation:** `execution/` module has the highest coupling (imports from 8/8 other modules).

---

## 4. Code Smells & Technical Debt

### Critical Issues

#### 🔴 God File: `execution/runner.ts` (1,685 lines)

**Problem:** Violates 400-line guideline by **4.2x**

**Concerns Handled:**
1. Run lifecycle (start/end hooks)
2. Story dispatching
3. Sequential execution loop
4. Parallel execution coordination
5. Escalation logic (tier bumping)
6. Acceptance test retry loop
7. Crash recovery
8. Heartbeat monitoring
9. Status file writing
10. Reporter event emission

**Impact:**
- Difficult to test (requires mocking 15+ modules)
- High risk of merge conflicts
- Hard to onboard new contributors
- Violates single-responsibility principle

**Effort to Fix:** Large (L) - 2-3 days

**Recommendation:**
```
execution/
  runner.ts (300 lines)              Core sequential loop
  parallel-runner.ts (300 lines)     Parallel execution
  lifecycle/
    run-start.ts (100 lines)         Run start hooks
    run-end.ts (100 lines)           Run end hooks
    story-hooks.ts (100 lines)       Story lifecycle
  escalation/
    tier-escalation.ts (200 lines)   Tier bumping logic
    attempt-tracking.ts (100 lines)  Attempt counters
  acceptance/
    acceptance-loop.ts (400 lines)   Acceptance retry
    fix-generator.ts (200 lines)     Fix story generation
```

---

### Major Issues

#### 🟠 Large Files Approaching Threshold

| File | Lines | Threshold | Over By |
|------|-------|-----------|---------|
| `config/schema.ts` | 792 | 800 | -8 (close) |
| `execution/story-dispatcher.ts` | 765 | 800 | -35 |
| `agents/claude.ts` | 751 | 800 | -49 |
| `tdd/orchestrator.ts` | 730 | 800 | -70 |
| `cli/diagnose.ts` | 658 | 800 | -142 |

**Analysis:**
- `config/schema.ts` should be split into domain-specific schemas
- `story-dispatcher.ts` is complex but focused (acceptable for now)
- `claude.ts` is an adapter - complexity is justified
- `tdd/orchestrator.ts` is complex but well-structured
- `diagnose.ts` could be split into check categories

**Effort to Fix:** Medium (M) - 1 day each

---

#### 🟠 High Coupling in Execution Module

**Problem:** `execution/runner.ts` imports from 15+ modules

**Dependencies:**
```typescript
// execution/runner.ts imports:
import { agents } from '../agents'
import { config } from '../config'
import { pipeline } from '../pipeline'
import { prd } from '../prd'
import { tdd } from '../tdd'
import { routing } from '../routing'
import { plugins } from '../plugins'
import { hooks } from '../hooks'
import { metrics } from '../metrics'
import { context } from '../context'
import { acceptance } from '../acceptance'
import { worktree } from '../worktree'
import { logger } from '../logger'
import { review } from '../review'
import { queue } from '../queue'
```

**Impact:**
- Difficult to unit test (requires extensive mocking)
- High risk of circular dependencies
- Changes to any module ripple through execution

**Effort to Fix:** Large (L) - Requires god file refactoring

---

#### 🟠 Verification Logic Duplication

**Problem:** Test execution logic appears in 3 places:

1. `execution/verification.ts` (552 lines) - Full test suite verification
2. `tdd/orchestrator.ts` (lines 400-500) - Post-session verification
3. `pipeline/stages/verify.ts` (80 lines) - Pipeline verification stage

**Duplication:**
- Test command execution
- Test output parsing
- Rectification retry logic
- Scoped vs full-suite logic

**Impact:**
- Code maintenance burden
- Inconsistent behavior across paths
- Bugs fixed in one place but not others

**Effort to Fix:** Medium (M) - 1 day

**Recommendation:**
```
verification/
  executor.ts      Run test commands (Bun.spawn wrapper)
  parser.ts        Parse test output (shared parser)
  gate.ts          Verification gates (scoped/full/regression)
  rectification.ts Retry logic with exponential backoff
  types.ts         Verification result types
```

Used by:
- `execution/verification.ts` → `verification/gate.ts::fullSuite()`
- `tdd/orchestrator.ts` → `verification/gate.ts::scoped()`
- `pipeline/verify.ts` → `verification/gate.ts::regression()`

---

### Minor Issues

#### 🟡 Mixed Abstractions in `execution/helpers.ts` (435 lines)

**Problem:** Contains both high-level orchestration and low-level git utils

**Contents:**
- High-level: Story filtering, dependency resolution
- Low-level: Git branch operations, file writing

**Effort to Fix:** Small (S) - 2 hours

**Recommendation:**
```
execution/
  helpers/
    story-filtering.ts  Story selection logic
    dependency.ts       Dependency resolution
  utils/ (move to root)
    git.ts              Git operations
```

---

#### 🟡 Routing Duplication: `routeTask()` vs `routeStory()`

**Problem:** Two similar functions in `routing/router.ts`

```typescript
// Legacy API
export function routeTask(task: Task): RoutingResult

// New API
export function routeStory(story: Story): RoutingResult
```

**Impact:** Minor - both are maintained

**Effort to Fix:** Small (S) - 1 hour

**Recommendation:** Deprecate `routeTask()` and migrate all callers to `routeStory()`

---

#### 🟡 Large Config Schema (792 lines)

**Problem:** `config/schema.ts` contains all Zod schemas in one file

**Effort to Fix:** Small (S) - 3 hours

**Recommendation:**
```
config/
  schema/
    models.ts       Model tier definitions
    execution.ts    Execution config
    quality.ts      Quality gate config
    tdd.ts          TDD config
    routing.ts      Routing config
    plugins.ts      Plugin config
    precheck.ts     Precheck config
  schema.ts (200 lines) Main schema assembly
```

---

## 5. Extension Points

### Designed Extension Points ✅

The codebase has **6 well-designed extension points** via the plugin system:

| Extension Point | Interface | Integration | Quality |
|----------------|-----------|-------------|---------|
| **Context Provider** | `IContextProvider` | `pipeline/stages/context.ts` | ✅ Excellent |
| **Router** | `IRoutingStrategy` | `routing/chain.ts` | ✅ Excellent |
| **Optimizer** | `IOptimizer` | `pipeline/stages/optimizer.ts` | ✅ Excellent |
| **Reviewer** | `IReviewer` | `pipeline/stages/review.ts` | ✅ Excellent |
| **Reporter** | `IReporter` | `execution/runner.ts` | ✅ Excellent |
| **Hooks** | `IHook` | `execution/run-lifecycle.ts` | ✅ Excellent |

**Example Plugin Structure:**
```typescript
// plugins/types.ts
export interface IContextProvider {
  name: string
  shouldProvide(story: Story): boolean
  provideContext(story: Story): Promise<string>
}

// Integration in pipeline/stages/context.ts
for (const provider of registry.contextProviders) {
  if (provider.shouldProvide(story)) {
    const ctx = await provider.provideContext(story)
    context.pluginContext.push(ctx)
  }
}
```

**Strengths:**
- Clean interface-based design
- Dependency injection via registry
- Teardown lifecycle support
- Strong validation via `plugins/validator.ts`

---

### Missing Extension Points ⚠️

| Extension | Current State | Should Be Pluggable? |
|-----------|---------------|---------------------|
| **Agent Adapters** | Hardcoded Claude only | ✅ Yes - for Codex, Aider, Gemini |
| **Verification Strategies** | Hardcoded Bun test | ✅ Yes - for pytest, jest, cargo test |
| **PRD Parsers** | Hardcoded JSON | ⚠️ Maybe - for YAML, TOML |
| **Merge Strategies** | Hardcoded git merge | ⚠️ Maybe - for custom resolvers |

**Recommendation:**

1. **Agent Adapter Plugin (Priority: High)**
   ```typescript
   export interface IAgentAdapter {
     name: string
     scaffold(prompt: string): Promise<AgentResult>
     run(prompt: string): Promise<AgentResult>
     decompose(prd: string): Promise<Story[]>
   }
   ```

2. **Verification Plugin (Priority: Medium)**
   ```typescript
   export interface IVerifier {
     name: string
     supports(project: ProjectInfo): boolean
     verify(scope: VerificationScope): Promise<VerificationResult>
   }
   ```

---

## 6. Test Coverage Map

### Test Organization

```
test/
├── unit/             [37 tests]   Pure logic, no I/O
├── integration/      [64 tests]   Cross-module integration
├── routing/          [8 tests]    Routing strategies
├── execution/        [6 tests]    Execution flows
└── ui/               [4 tests]    TUI components
```

### Coverage by Module

| Module | Unit Tests | Integration Tests | Coverage Quality |
|--------|-----------|-------------------|------------------|
| **routing/** | ✅ Yes | ✅ Yes | ✅ Excellent |
| **context/** | ✅ Yes | ✅ Yes | ✅ Excellent |
| **plugins/** | ✅ Yes | ✅ Yes | ✅ Excellent |
| **config/** | ✅ Yes | ✅ Yes | ✅ Excellent |
| **metrics/** | ✅ Yes | ✅ Yes | ✅ Good |
| **worktree/** | ✅ Yes | ✅ Yes | ✅ Good |
| **acceptance/** | ✅ Yes | ✅ Yes | ✅ Good |
| **review/** | ✅ Yes | ✅ Yes | ✅ Good |
| **queue/** | ✅ Yes | ⚠️ Limited | ✅ Good |
| **analyze/** | ✅ Yes | ✅ Yes | ✅ Good |
| **precheck/** | ✅ Yes | ✅ Yes | ✅ Good |
| **constitution/** | ✅ Yes | ⚠️ Limited | ✅ Good |
| **logger/** | ✅ Yes | ✅ Yes | ✅ Good |
| **optimizer/** | ✅ Yes | ⚠️ Limited | ✅ Good |
| **agents/** | ⚠️ Limited | ✅ Yes | ⚠️ Needs improvement |
| **tdd/** | ⚠️ Limited | ⚠️ Limited | 🔴 **Gap** |
| **execution/** | ⚠️ Limited | ✅ Yes | 🔴 **Gap** |
| **pipeline/** | ⚠️ Limited | ✅ Yes | ⚠️ Needs improvement |
| **cli/** | ✅ Yes | ✅ Yes | ✅ Good |
| **tui/** | ✅ Yes | ✗ No | ⚠️ Acceptable |

### Critical Coverage Gaps

#### 🔴 TDD Orchestrator (730 lines, minimal tests)

**Missing Tests:**
- Three-session flow (scaffold → implement → verify)
- Isolation verification between sessions
- Rectification retry logic
- Greenfield vs existing project flows
- Verdict parsing edge cases

**Recommendation:** Add `test/integration/tdd-orchestrator.test.ts`

---

#### 🔴 Execution Runner (1,685 lines, minimal direct tests)

**Missing Tests:**
- Escalation logic (tier bumping)
- Acceptance retry loop
- Parallel execution coordination
- Crash recovery
- Heartbeat monitoring

**Recommendation:** Split god file first, then add focused unit tests

---

#### ⚠️ Agent Adapters (751 lines, limited tests)

**Missing Tests:**
- Claude Code adapter edge cases
- Timeout handling
- Process cleanup on error
- Plan/decompose/scaffold methods

**Recommendation:** Add `test/unit/agents/claude.test.ts`

---

### Test Quality Assessment

**Strengths:**
- Good unit test coverage for routing, context, plugins
- Integration tests for cross-module flows
- UI tests for TUI components

**Weaknesses:**
- Orchestration code (execution, tdd) has minimal coverage
- Missing tests for complex flows (escalation, rectification)
- Some tests skip prechecks, reducing realism

**Overall Test Quality:** B (would be A with orchestration coverage)

---

## 7. Re-architecture Recommendations

### Priority 1: Split `execution/runner.ts` (Effort: L, Impact: High)

**Current State:** 1,685-line god file handling 8+ concerns

**Target State:**
```
execution/
  runner.ts (300 lines)
    - Core sequential loop
    - Story iteration
    - Pipeline invocation

  parallel-runner.ts (300 lines)
    - Parallel execution via worktrees
    - Batch coordination
    - Merge orchestration

  lifecycle/
    run-start.ts (100 lines)
      - Load plugins
      - Initialize reporters
      - Fire onRunStart hooks
    run-end.ts (100 lines)
      - Teardown plugins
      - Fire onRunEnd hooks
      - Write final metrics
    story-hooks.ts (100 lines)
      - Fire onStoryStart/Complete
      - Emit reporter events

  escalation/
    tier-escalation.ts (200 lines)
      - Tier bumping logic
      - Attempt tracking
      - Escalation strategy
    attempt-tracking.ts (100 lines)
      - Attempt counters
      - Max attempt limits

  acceptance/
    acceptance-loop.ts (400 lines)
      - Acceptance test retry
      - Fix story generation
      - Acceptance timeout
    fix-generator.ts (200 lines)
      - Generate fix stories
      - Link to parent story
```

**Migration Plan:**
1. Extract lifecycle functions (low risk)
2. Extract escalation logic (medium risk)
3. Extract acceptance loop (high risk - complex)
4. Extract parallel execution (high risk - complex)
5. Add comprehensive tests for each module
6. Deprecate old runner.ts

**Benefits:**
- Each file < 400 lines
- Single-responsibility modules
- Easier to test
- Reduced coupling
- Easier to onboard contributors

---

### Priority 2: Create Unified Verification Layer (Effort: M, Impact: Medium)

**Current State:** Test execution logic duplicated across 3 modules

**Target State:**
```
verification/
  executor.ts (150 lines)
    - Run test commands via Bun.spawn
    - Capture stdout/stderr
    - Handle timeouts

  parser.ts (200 lines)
    - Parse Bun test output
    - Extract pass/fail counts
    - Parse error messages

  gate.ts (250 lines)
    - scoped()       Run tests for modified files
    - fullSuite()    Run entire test suite
    - regression()   Run subset for sanity check

  rectification.ts (200 lines)
    - Retry logic with exponential backoff
    - Max attempt tracking
    - Failure categorization

  types.ts (100 lines)
    - VerificationResult
    - VerificationScope
    - VerificationStrategy

  index.ts
    - Barrel exports
```

**Migration:**
1. Extract common test execution logic
2. Create unified parser
3. Implement verification gates
4. Migrate `execution/verification.ts` to use new layer
5. Migrate `tdd/orchestrator.ts` to use new layer
6. Migrate `pipeline/verify.ts` to use new layer

**Benefits:**
- DRY - single test execution implementation
- Consistent behavior across paths
- Easier to add new test frameworks (jest, pytest)
- Better error handling

---

### Priority 3: Split Config Schema (Effort: S, Impact: Low)

**Current State:** `config/schema.ts` is 792 lines

**Target State:**
```
config/
  schema/
    models.ts (100 lines)
      - ModelTier enum
      - Model definitions

    execution.ts (150 lines)
      - Execution config
      - Parallel execution
      - Crash recovery

    quality.ts (100 lines)
      - Quality gate config
      - Verification thresholds

    tdd.ts (100 lines)
      - TDD config
      - Session prompts
      - Isolation rules

    routing.ts (100 lines)
      - Routing config
      - Complexity thresholds
      - Strategy selection

    plugins.ts (150 lines)
      - Plugin config
      - Plugin paths
      - Plugin options

    precheck.ts (50 lines)
      - Precheck config

  schema.ts (200 lines)
    - Assemble all schemas
    - Main Config type
    - Default values
```

**Benefits:**
- Easier to navigate
- Domain-specific organization
- Faster IDE performance

---

### Priority 4: Add Agent Adapter Plugin System (Effort: M, Impact: Medium)

**Current State:** Only Claude Code is supported (hardcoded)

**Target State:**
```
agents/
  types.ts
    - IAgentAdapter interface
    - AgentRegistry

  registry.ts
    - Register adapters
    - Select adapter by name

  adapters/
    claude.ts (current implementation)
    codex.ts (new)
    aider.ts (new)
    gemini.ts (new)

plugins/types.ts
  - Add IAgentAdapterPlugin
```

**Migration:**
1. Define `IAgentAdapter` interface
2. Refactor `claude.ts` to implement interface
3. Add agent registry
4. Update config to support `agent: "claude" | "codex" | "aider"`
5. Add plugin extension point for custom agents

**Benefits:**
- Support multiple agents (Codex, Aider, Gemini)
- Users can choose agent per story
- Plugin authors can add custom agents

---

### Priority 5: Extract Business Logic from Orchestration (Effort: L, Impact: High)

**Current State:** Business rules embedded in runner/orchestrator

**Target State:**
```
domain/
  escalation/
    rules.ts
      - When to escalate tier
      - Max attempts per tier
      - Escalation strategy

  verification/
    rules.ts
      - When to run scoped vs full tests
      - Verification thresholds
      - Quality gates

  acceptance/
    rules.ts
      - When to generate fix stories
      - Max acceptance retries
      - Acceptance timeout

  routing/
    rules.ts
      - Complexity classification rules
      - Model selection rules
      - Strategy selection

execution/runner.ts
  - Use domain/escalation/rules
  - Use domain/verification/rules
  - Pure orchestration, no business logic
```

**Benefits:**
- Testable business rules
- Centralized decision logic
- Easier to understand and modify
- Domain-driven design

---

## 8. Effort Estimates

| Recommendation | Priority | Effort | Impact | Risk |
|----------------|----------|--------|--------|------|
| Split `execution/runner.ts` | P1 | Large (2-3 days) | High | Medium |
| Unified verification layer | P2 | Medium (1 day) | Medium | Low |
| Split config schema | P3 | Small (3 hours) | Low | Low |
| Agent adapter plugins | P4 | Medium (1 day) | Medium | Medium |
| Extract business logic | P5 | Large (3-4 days) | High | High |
| Add TDD orchestrator tests | P2 | Medium (1 day) | High | Low |
| Add execution runner tests | P1 | Large (2 days) | High | Low |
| Split `tdd/orchestrator.ts` | P3 | Medium (1 day) | Low | Medium |

**Total Effort:** 12-15 days for all recommendations

**Recommended Phased Approach:**

**Phase 1 (Week 1):** Foundation
- Split `execution/runner.ts` (P1)
- Add execution runner tests (P1)
- Unified verification layer (P2)

**Phase 2 (Week 2):** Quality
- Add TDD orchestrator tests (P2)
- Split config schema (P3)
- Split `tdd/orchestrator.ts` (P3)

**Phase 3 (Week 3):** Extensions
- Agent adapter plugins (P4)
- Extract business logic (P5)

---

## 9. Architectural Strengths (Keep These)

### ✅ Pipeline Architecture

**Why It's Good:**
- Clean separation of concerns via stages
- Immutable context with explicit mutation contract
- Composable and testable
- Easy to add new stages
- Event-driven for TUI integration

**Example:**
```typescript
// pipeline/runner.ts - Clean, focused (162 lines)
export async function execute(story: Story): Promise<PipelineResult> {
  const stages = [
    queueCheckStage,
    routingStage,
    constitutionStage,
    contextStage,
    promptStage,
    optimizerStage,
    executionStage,
    verifyStage,
    reviewStage,
    acceptanceStage,
    completionStage,
  ]

  let context = createContext(story)

  for (const stage of stages) {
    context = await stage.execute(context)
    if (context.shouldAbort) break
  }

  return context.result
}
```

**Don't Change:** This is the backbone of the architecture.

---

### ✅ Plugin System

**Why It's Good:**
- 6 well-designed extension points
- Clean interface-based design
- Strong validation
- Teardown lifecycle
- Dependency injection via registry

**Example:**
```typescript
// plugins/types.ts - Clean interfaces
export interface IContextProvider {
  name: string
  shouldProvide(story: Story): boolean
  provideContext(story: Story): Promise<string>
}

export interface IReviewer {
  name: string
  review(result: AgentResult): Promise<ReviewResult>
}
```

**Don't Change:** This is a major architectural strength.

---

### ✅ Type Safety

**Why It's Good:**
- Comprehensive TypeScript types
- Zod validation for config
- Type-safe event emitter
- Discriminated unions for result types

**Example:**
```typescript
// prd/types.ts - Strong typing
export type Story = {
  id: string
  title: string
  description: string
  acceptanceCriteria?: string[]
  dependencies?: string[]
  category?: FailureCategory
  auto?: AutoDefault
}

export type RoutingResult = {
  tier: ModelTier
  strategy: TestStrategy
  reason: string
}
```

**Don't Change:** Maintain strong typing throughout.

---

### ✅ Layered Configuration

**Why It's Good:**
- Global + project config merging
- Environment variable override
- Strong validation
- Path security

**Example:**
```typescript
// config/loader.ts - Clean layering
export async function loadConfig(): Promise<Config> {
  const globalConfig = await loadGlobalConfig()
  const projectConfig = await loadProjectConfig()
  return mergeConfigs(globalConfig, projectConfig)
}
```

**Don't Change:** This is a solid foundation.

---

## 10. Final Recommendations

### Immediate Actions (This Sprint)

1. **Create Issue for God File:**
   - Title: "Refactor execution/runner.ts (1,685 lines → 300 lines)"
   - Priority: Critical
   - Label: technical-debt

2. **Add Missing Tests:**
   - `test/integration/tdd-orchestrator.test.ts`
   - `test/unit/agents/claude.test.ts`

3. **Document Extension Points:**
   - Add `docs/plugin-system.md`
   - Example plugins for each extension point

### Short-Term (Next 2 Sprints)

1. **Split `execution/runner.ts`** (see Priority 1 recommendation)
2. **Create unified verification layer** (see Priority 2 recommendation)
3. **Add comprehensive tests** for orchestration code

### Long-Term (Next Quarter)

1. **Agent adapter plugin system** (support Codex, Aider)
2. **Extract business logic** to domain layer
3. **Verification plugin system** (support jest, pytest)

---

## Conclusion

NAX has a **solid architectural foundation** with excellent plugin system, clean pipeline pattern, and strong type safety. The primary technical debt is the 1,685-line god file in `execution/runner.ts`, which should be split into focused modules.

**Current Grade: B+**
**Potential Grade: A** (after refactoring god file and adding orchestration tests)

**Key Takeaway:** The architecture is well-designed overall. Focus refactoring efforts on the execution module to bring it up to the quality standards of the rest of the codebase.

---

**Analysis Date:** 2026-02-28
**Analyzed By:** Claude Code Explore Agent
**Review Status:** Internal Consumption
**Next Review:** After execution module refactoring
