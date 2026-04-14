# Conventions — nax Coding Standards

> §1–§4: File structure, dependency injection, error handling, constants.
> Part of the [Architecture Documentation](ARCHITECTURE.md).

---

## 1. File Structure

### Layout

```
src/
├── acceptance/       # Acceptance test generation, refinement, fix stories, templates
│   └── templates/    # Test templates (unit, component, e2e, CLI, snapshot)
├── agents/           # Agent adapters — all agents run via ACP protocol
│   ├── acp/          # ACP adapter (adapter, spawn-client, parser, cost, interaction-bridge, parse-agent-error)
│   ├── cost/         # Centralized cost calculation (calculate, parse, pricing, types)
│   ├── shared/       # Cross-adapter utilities (decompose, decompose-prompt, env, model-resolution, validation, version-detection, types-extended)
│   ├── registry.ts   # Agent registry (KNOWN_AGENT_NAMES, createAgentRegistry, _registryTestAdapters)
│   └── types.ts      # AgentAdapter interface, AgentResult, AgentRunOptions
├── analyze/          # Codebase scanning and LLM-enhanced story classification
├── cli/              # CLI command handlers (init, run, plan, analyze, accept, status, config, etc.)
├── commands/         # Subcommand implementations (diagnose, logs, precheck, runs, unlock)
├── config/           # Configuration loading, schemas, types, permissions, profiles, path security
├── constitution/     # Project governance document generation
│   └── generators/   # Per-agent constitution generators (claude, aider, cursor, opencode, windsurf)
├── context/          # Context generation for agent prompts
│   └── generators/   # Per-agent context generators (claude, codex, cursor, gemini, opencode, aider, windsurf)
├── debate/           # Multi-agent debate system (session, concurrency, resolvers, prompts)
├── execution/        # Run orchestration (parallel, crash recovery, pipeline result handling)
│   ├── escalation/   # Tier escalation on repeated failures (fast → balanced → powerful)
│   └── lifecycle/    # Run lifecycle phases (setup, initialization, completion, cleanup, regression, acceptance-loop, paused-story-prompts)
├── hooks/            # Lifecycle hook system (script-based, 11 event types)
├── interaction/      # Human-in-the-loop plugins (telegram, auto, webhook)
│   └── plugins/      # Interaction plugin implementations
├── logger/           # Logger module (formatters, types)
├── logging/          # Structured JSONL logger
├── metrics/          # Story metrics collection, run-level aggregation
├── optimizer/        # Prompt optimization (rule-based, no-op)
├── pipeline/         # Pipeline engine (stages, subscribers, runner)
│   ├── stages/       # 15 pipeline stages (see subsystems.md §17)
│   └── subscribers/  # Event subscribers (reporters, interaction)
├── plugins/          # Plugin system (loader, validator, registry, types)
├── precheck/         # Pre-run validation (agents, CLI, config, git, system, story-size gate)
├── prd/              # PRD parsing, story state machine, story management
├── project/          # Auto-detect project type, language, frameworks
├── prompts/          # Prompt building (domain-specific builders, loader, core engine)
│   ├── builders/     # 7 domain-specific prompt builders (tdd, debate, review, acceptance, rectifier, one-shot, adversarial-review)
│   ├── core/         # Shared prompt engine (SectionAccumulator, universal sections, wrappers, types)
│   │   └── sections/ # Pure section functions (findings, instructions, json-schema, prior-failures, routing-candidates)
│   └── sections/     # Legacy prompt sections (conventions, hermetic, isolation, role-task, story, tdd-conventions, verdict)
├── quality/          # Quality command runner (lint, typecheck, build) + test command resolver (SSOT)
├── queue/            # Mid-run queue control (PAUSE, ABORT, SKIP)
├── review/           # Code review orchestration (built-in + plugin checks, semantic review, adversarial review, diff utilities)
├── routing/          # Complexity classification and model-tier routing
│   └── strategies/   # LLM-based routing strategy (llm.ts, llm-parsing.ts)
├── tdd/              # TDD orchestration (three-session workflow, isolation, verdict, rectification-gate)
├── tui/              # React/Ink terminal UI
│   ├── components/   # TUI React components
│   └── hooks/        # TUI React hooks (useKeyboard, useLayout, usePipelineEvents, usePty)
├── utils/            # Shared utilities (git, paths, errors, processes)
├── test-runners/     # Test framework detection and output parsing (SSOT for test parsing)
├── verification/     # Test execution orchestration, rectification loop
│   └── strategies/   # Verification strategies (scoped, regression, acceptance)
├── worktree/         # Git worktree management for parallel execution (manager, dispatcher, merge)
├── errors.ts         # NaxError base class + derived error classes
└── version.ts        # Version management
```

### Rules

- **File size limits (tiered):**

  | File type | Soft limit | Hard limit | When to split |
  |:----------|:-----------|:-----------|:--------------|
  | Source files (`src/`) | 300 lines | **400 lines** | Logic/control flow too complex for one file |
  | Test files (`test/`) | 500 lines | **800 lines** | >3 unrelated concerns in one file |
  | Type-only files (interfaces, no logic) | 500 lines | **600 lines** | Only if mixing types with logic |
  | Docs / generated reports | — | **No limit** | N/A |

  The goal is **cognitive fit** — can you understand the file in one reading? Type declarations and test assertions are low-complexity per line; business logic is high-complexity.

- **Barrel exports:** every directory with 2+ files gets an `index.ts`
- **File naming:** `kebab-case.ts` for files, `PascalCase` for classes/interfaces
- **One primary export per file** — avoid files with 5+ unrelated exports

---

## 2. Dependency Injection (`_deps` Pattern)

### Pattern

Every module that calls external services (process spawning, file I/O, network) must expose an injectable `_deps` object:

```typescript
// ✅ Correct: injectable, testable
export const _myModuleDeps = {
  which(name: string): string | null {
    return Bun.which(name);
  },
  spawn(
    cmd: string[],
    opts: { stdout: "pipe"; stderr: "pipe" | "inherit" },
  ): { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; pid: number } {
    return Bun.spawn(cmd, opts) as any;
  },
};

// In the function:
export async function myFunction(): Promise<Result> {
  const path = _myModuleDeps.which("tool");
  // ...
}
```

```typescript
// ❌ Wrong: direct calls, not testable without monkey-patching
export async function myFunction(): Promise<Result> {
  const path = Bun.which("tool");
  // ...
}
```

### Test Usage

```typescript
import { _myModuleDeps } from "../../src/my-module";

const origDeps = { ..._myModuleDeps };

afterEach(() => {
  Object.assign(_myModuleDeps, origDeps);
});

test("handles missing binary", async () => {
  _myModuleDeps.which = () => null;
  // ...
});
```

### When to Use `_deps`

| Scenario | Use `_deps`? |
|:---------|:-------------|
| `Bun.spawn()`, `Bun.which()` | ✅ Always |
| File reads (`Bun.file()`, `readdir`) | ✅ Always |
| Network calls (`fetch`) | ✅ Always |
| Pure computation, string manipulation | ❌ No |
| Calling other nax modules | ❌ No (mock at boundary) |

### ⚠️ Critical: Never Mutate Globals in Tests

**`Bun.spawn = mock(...)` is forbidden.** Bun runs test files sequentially in the same process. Mutating `Bun.spawn` directly — even with beforeEach/afterEach save-restore — is unreliable and causes cross-file contamination. **`mock.module()` is also forbidden** — it permanently replaces the module for the entire process lifetime and `mock.restore()` does NOT undo it.

```typescript
// ❌ WRONG — contaminates other test files
Bun.spawn = mock((cmd) => fakeResult);
mock.module("../src/isolation", () => ({ getChangedFiles: mock(...) }));

// ✅ CORRECT — scoped to the module's _deps object
import { _isolationDeps } from "../../../src/tdd/isolation";
let orig = _isolationDeps.spawn;
beforeEach(() => { _isolationDeps.spawn = mock(...); });
afterEach(() => { _isolationDeps.spawn = orig; });
```

This was the root cause of 38 test failures (March 2026) — fixed in commit `a110d6a`.

### Injectable `_deps` Across the Codebase

The `_deps` pattern is used extensively (70+ modules). Key examples by subsystem:

| Subsystem | Module | Export | Covers |
|:---|:---|:---|:---|
| **TDD** | `src/tdd/isolation.ts` | `_isolationDeps` | `git diff` → `getChangedFiles` |
| | `src/tdd/cleanup.ts` | `_cleanupDeps` | `ps`, `Bun.sleep`, `process.kill` |
| | `src/tdd/session-runner.ts` | `_sessionRunnerDeps` | isolation, git, cleanup, prompt deps |
| | `src/tdd/rectification-gate.ts` | `_rectificationGateDeps` | `executeWithTimeout`, test output parsing |
| **Verification** | `src/verification/executor.ts` | `_executorDeps` | Shell test command execution |
| | `src/verification/strategies/acceptance.ts` | `_acceptanceDeps` | Acceptance test runner |
| | `src/verification/strategies/scoped.ts` | `_scopedDeps` | Scoped verification strategy |
| | `src/verification/smart-runner.ts` | `_smartRunnerDeps` | Smart test file selection |
| | `src/verification/rectification-loop.ts` | `_rectificationDeps` | Rectification loop |
| **Agents** | `src/agents/acp/adapter.ts` | `_acpAdapterDeps`, `_fallbackDeps` | ACP session management |
| | `src/agents/acp/spawn-client.ts` | `_spawnClientDeps` | acpx process spawning |
| **Pipeline** | `src/pipeline/stages/routing.ts` | `_routingDeps` | Routing stage |
| | `src/pipeline/stages/execution.ts` | `_executionDeps` | Execution stage |
| | `src/pipeline/stages/verify.ts` | `_verifyDeps` | Verify stage |
| | `src/pipeline/stages/review.ts` | `_reviewDeps` | Review stage |
| | `src/pipeline/stages/autofix.ts` | `_autofixDeps` | Autofix stage |
| | `src/pipeline/stages/completion.ts` | `_completionDeps` | Completion stage |
| | `src/pipeline/stages/acceptance-setup.ts` | `_acceptanceSetupDeps` | Acceptance setup |
| **Execution** | `src/execution/runner.ts` | `_runnerDeps` | Main run orchestrator |
| | `src/execution/unified-executor.ts` | `_unifiedExecutorDeps` | Unified story executor |
| | `src/execution/parallel-batch.ts` | `_parallelBatchDeps` | Parallel batch execution |
| | `src/execution/escalation/tier-escalation.ts` | `_tierEscalationDeps` | Tier escalation logic |
| | `src/execution/lifecycle/run-setup.ts` | `_runSetupDeps` | Run setup phase |
| **Review** | `src/review/orchestrator.ts` | `_orchestratorDeps` | Review orchestrator |
| | `src/review/semantic.ts` | `_semanticDeps` | Semantic review |
| | `src/review/runner.ts` | `_reviewRunnerDeps`, `_reviewGitDeps` | Review runner |
| **Other** | `src/utils/git.ts` | `_gitDeps` | All git commands |
| | `src/routing/router.ts` | `_tryLlmBatchRouteDeps` | LLM batch routing |
| | `src/worktree/manager.ts` | `_managerDeps` | Worktree management |
| | `src/worktree/merge.ts` | `_mergeDeps` | Worktree merge |
| | `src/debate/session.ts` | `_debateSessionDeps` | Debate sessions |
| | `src/acceptance/generator.ts` | `_generatorPRDDeps` | Acceptance test generation |
| | `src/project/detector.ts` | `_detectorDeps` | Project detection |
| | `src/quality/runner.ts` | `_qualityRunnerDeps` | Quality command execution |

### Reference Files

- `test/integration/tdd/_tdd-test-helpers.ts` — shared helper for TDD orchestrator tests

---

## 3. Error Handling

### NaxError (v0.38.0+) — Standard Pattern

Use `NaxError` for all errors. It provides a machine-readable `code`, structured `context`, and preserves the error chain via `cause`.

```typescript
import { NaxError } from "../../src/errors";

throw new NaxError(
  `LLM strategy failed for story ${story.id}`,
  "ROUTING_LLM_FAILED",
  { storyId: story.id, stage: "routing", cause: err }
);
```

### Rules

1. **Always use `NaxError`** — not plain `Error`
2. **Use descriptive error codes** — `ROUTING_LLM_FAILED`, `AGENT_NOT_FOUND`, `VERIFICATION_TIMEOUT`
3. **Include `storyId` in context** — for all pipeline stage errors
4. **Preserve the error chain** — pass `cause: err`
5. **Never swallow errors silently** — at minimum, log them

```typescript
// ✅ Wrapping external errors
try {
  await externalCall();
} catch (err) {
  throw new NaxError(
    `Agent spawn failed for ${storyId}`,
    "AGENT_SPAWN_FAILED",
    { storyId, stage: "execution", cause: err }
  );
}

// ❌ Swallowing
try {
  await externalCall();
} catch {
  // silently ignored
}
```

### Legacy Pattern (pre-v0.38.0)

The old `throw new Error("[stage] message")` pattern is deprecated. Do not use it for new code.

---

## 4. Constants

### Rules

- **No magic numbers** in function bodies
- **File-level `const`** for single-file constants
- **`src/constants.ts`** for values shared across 2+ files
- **Naming:** `UPPER_SNAKE_CASE`

```typescript
// ✅ Named constant at file level
const MAX_AGENT_OUTPUT_CHARS = 5_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RETRY_ATTEMPTS = 3;

// ❌ Magic number in function body
if (output.length > 5000) { ... }
```

### Numeric Literals

Use `_` separators for readability:

```typescript
// ✅ Readable
const MAX_CONTEXT_TOKENS = 1_000_000;
const TIMEOUT_MS = 60_000;

// ❌ Hard to read
const MAX_CONTEXT_TOKENS = 1000000;
```
