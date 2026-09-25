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
├── agents/           # Agent adapters — two transports: ACP (named CLI agents) and native (ADR-027)
│   ├── acp/          # ACP adapter over acpx (adapter, adapter-lifecycle/-output/-complete-flow, spawn-client*, parser, interaction-bridge, parse-agent-error, token-mapper)
│   ├── catalog/      # nax-ai model-catalog boundary — maps `Pricing` onto `TokenPricing`
│   ├── cost/         # Centralized cost calculation (calculate, estimate, rate-card, token-mapper, types)
│   ├── native/       # In-process native agent over @nathapp/nax-ai (adapter, client, auth, models)
│   │   └── session/  # Native session + turn loop (turn-loop, loop-events, tool-result, transcript-store, compaction)
│   ├── retry/        # Retry strategy SSOT (default-strategy, presets, parse-retry, compose, hop-retry-policy)
│   ├── shared/       # Cross-adapter utilities (decompose, env, model-resolution, agent-profile-resolver, validation, version-detection)
│   ├── manager.ts    # AgentManager (getDefault, completeAs, runWithFallback, reset)
│   ├── registry.ts   # Agent registry (KNOWN_AGENT_NAMES, createAgentRegistry, _registryTestAdapters)
│   └── types.ts      # AgentAdapter interface (complete, openSession, sendTurn, closeSession), AgentResult, AgentRunOptions
├── analyze/          # `nax analyze` — codebase scanning and story classification
├── bakeoff/          # Multi-contestant bakeoff runs (coordinator, ranking, report)
├── cli/              # CLI command handlers (init, run, plan, accept, status, config, approvals, mcp, rules, setup, etc.)
├── command-safety/   # Command-safety shadow classifier — scores every agent command, decides nothing (ADR-031)
├── commands/         # Subcommand implementations (curator, detect, logs, migrate, precheck, replay, resume, runs, unlock)
├── config/           # Configuration loading, schemas (schemas-*.ts), defaults, permissions, profiles, path security
├── constitution/     # Project governance document generation
│   └── generators/   # Per-agent constitution generators (claude, aider, cursor, opencode, windsurf)
├── context/          # Context generation for agent prompts
│   ├── engine/       # Context engine (orchestrator, providers, packing, manifests)
│   └── generators/   # Per-agent context generators (claude, codex, cursor, gemini, opencode, aider, windsurf)
├── execution/        # Run orchestration (runner, unified executor, parallel, crash recovery, pipeline result handling)
│   ├── escalation/   # Tier escalation on repeated failures (fast → balanced → powerful)
│   ├── lifecycle/    # Run lifecycle phases (setup, initialization, completion, cleanup, regression, acceptance-loop, paused-story-prompts)
│   └── story-orchestrator/ # Per-story phase orchestration + rectification (see story-orchestrator-flow.md)
├── findings/         # Finding model + fix cycle (runFixCycle), retirement, iteration log, per-story fix history
├── finish/           # `nax finish` — audit, gates, commit, PR/notify state machine
├── forge/            # Git-forge integration (provider detect, PR creation, templates)
├── hooks/            # Lifecycle hook system (script-based, 12 event types)
├── interaction/      # Human-in-the-loop (chain, triggers, ask dispatch)
│   └── plugins/      # Interaction plugins (cli, telegram, webhook)
├── log-format/       # Human-facing formatting of log records and mutation summaries
├── logger/           # Structured JSONL logger (logger, sinks, formatters, redaction)
├── mcp/              # External MCP servers whose tools the native agent may call
├── metrics/          # Story metrics collection, run-level aggregation
├── operations/       # Per-story operations invoked via callOp (implementer, verifier, gates, reviews, autofix, plan, acceptance)
├── optimizer/        # Prompt optimization seam (no-op built-in, plugin-provided)
├── permissions/      # Permission rule grammar, Bash lexer, interactive ask tier + approvals store (ADR-030)
├── pipeline/         # Pipeline engine (stages, subscribers, event bus, runner)
│   ├── stages/       # 10 pipeline stages — 8 default + pre-run acceptance-setup + post-run acceptance (see subsystems.md §17)
│   └── subscribers/  # Event subscribers (reporters, hooks, interaction, events-writer)
├── plan/             # `nax plan` — single/refine strategies, spec lint gate, PRD persist/write
├── plugins/          # Plugin system (loader, validator, registry, types)
├── precheck/         # Pre-run validation (agents, CLI, config, git, system, native credentials, story-size gate)
├── prd/              # PRD schema/parsing, story state machine, out-of-scope, spec lint/drift
├── project/          # Auto-detect project type, language, frameworks
├── prompts/          # Prompt building (domain-specific builders, loader, core engine)
│   ├── builders/     # Domain-specific prompt builders (tdd, review, adversarial-review, acceptance, rectifier, one-shot, plan, decompose, setup, …)
│   ├── core/         # Shared prompt engine (SectionAccumulator, universal sections, wrappers, types)
│   │   └── sections/ # Pure section functions (findings, instructions, json-schema, prior-failures, routing-candidates)
│   └── sections/     # Reusable prompt sections (conventions, hermetic, isolation, role-task, story, out-of-scope, verdict, …)
├── quality/          # Quality command runner (lint, typecheck, build) + test command resolver (SSOT)
├── queue/            # Mid-run queue control (PAUSE, ABORT, SKIP)
├── replay/           # `nax replay` — reconstruct a past run from its artifacts
├── review/           # Code review orchestration (runner, semantic + adversarial helpers, lint/typecheck parsing, diff utilities)
├── routing/          # Complexity classification and model-tier routing
│   └── strategies/   # LLM-based routing strategy (llm.ts, llm-cache.ts, llm-parsing.ts)
├── runtime/          # Run-scoped NaxRuntime (createRuntime), dispatch context/events, agent middleware, cost aggregation
├── sandbox/          # OS sandbox for agent-authored commands (srt backend, policy builder, launcher) — on by default
├── schedule/         # Schedule parsing and waiting for deferred runs
├── session/          # Agent session lifecycle (SessionManager, naming, model selection, keeper, scratch dirs, sweep)
├── tdd/              # TDD helpers (isolation, verdict, cleanup, rollback)
├── test-runners/     # Test framework detection and output parsing (SSOT for test parsing)
├── tools/            # Coding tools for native sessions (Read/Write/Edit/Glob/Grep/Git/Bash/RunCommand, policy, tool-audit)
├── tui/              # React/Ink terminal UI
│   ├── components/   # TUI React components
│   └── hooks/        # TUI React hooks (useKeyboard, useLayout, usePipelineEvents, usePipelineBusEvents, useAgentStreamEvents)
├── utils/            # Shared utilities (git, paths, path-frame, errors, file locks, JSON/JSONL, processes)
├── verification/     # Test execution, smart/scoped runner, flake triage, mutation testing, rectification
├── worktree/         # Git worktree management for parallel execution (manager, WorktreeId, dependencies)
├── errors.ts         # NaxError base class + derived error classes
└── version.ts        # Version management
```

### Rules

- **File size limits (tiered):**

  | File type | Soft limit | Hard limit | When to split |
  |:----------|:-----------|:-----------|:--------------|
  | Source files (`src/`) | 400 lines | **600 lines** | Logic/control flow too complex for one file |
  | Test files (`test/**/*.test.ts`) | 650 lines | **800 lines** | >3 unrelated concerns in one file |
  | Type-only files (interfaces, no logic) | 500 lines | **600 lines** | Only if mixing types with logic |
  | Docs / generated reports | — | **No limit** | N/A |

  The hard limits (600 source / 800 test) are the canonical rule (`.nax/rules/project-conventions.md`) and are **enforced** by `bun run check:file-sizes` (part of `bun run lint`): it ratchets against a baseline, so grandfathered oversized files may not grow and new files must be under the limit. After splitting a grandfathered file, lower the baseline with `bun run check:file-sizes:update`. The goal is **cognitive fit** — can you understand the file in one reading? Type declarations and test assertions are low-complexity per line; business logic is high-complexity.

- **Barrel exports:** every directory with 2+ files gets an `index.ts`. In `src/`, `bin/` and `scripts/`, value imports go through the barrel (`@/routing`, never `@/routing/router`) — enforced by `bun run check:alias-internals`; tests may reach internals. Never place `x.ts` beside `x/index.ts`.
- **Path aliases:** `@/*` → `src/*`, `@test/*` → `test/*` (optional; use when it beats deep `../` chains)
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

The `_deps` pattern is used extensively (200+ modules). Key examples by subsystem:

| Subsystem | Module | Export | Covers |
|:---|:---|:---|:---|
| **TDD** | `src/tdd/isolation.ts` | `_isolationDeps` | `git diff` → `getChangedFiles` |
| | `src/tdd/cleanup.ts` | `_cleanupDeps` | `ps`, `Bun.sleep`, `process.kill` |
| **Verification** | `src/verification/executor.ts` | `_executorDeps` | Shell test command execution |
| | `src/verification/smart-runner.ts` | `_smartRunnerDeps` | Smart test file selection |
| **Agents** | `src/agents/acp/adapter-lifecycle.ts` | `_acpAdapterDeps`, `_fallbackDeps` | ACP session management |
| | `src/agents/acp/spawn-client-deps.ts` | `_spawnClientDeps` | acpx process spawning |
| | `src/agents/native/client.ts` | `_clientDeps` | Native (nax-ai) client |
| **Pipeline** | `src/pipeline/stages/routing.ts` | `_routingDeps` | Routing stage |
| | `src/pipeline/stages/execution.ts` | `_executionDeps` | Execution stage |
| | `src/pipeline/stages/completion.ts` | `_completionDeps` | Completion stage |
| | `src/pipeline/stages/acceptance-setup.ts` | `_acceptanceSetupDeps` | Acceptance setup |
| **Execution** | `src/execution/runner.ts` | `_runnerDeps` | Main run orchestrator |
| | `src/execution/unified-executor.ts` | `_unifiedExecutorDeps` | Unified story executor |
| | `src/execution/parallel-batch.ts` | `_parallelBatchDeps` | Parallel batch execution |
| | `src/execution/escalation/tier-escalation.ts` | `_tierEscalationDeps` | Tier escalation logic |
| | `src/execution/lifecycle/run-setup.ts` | `_runSetupDeps` | Run setup phase |
| **Context** | `src/context/engine/orchestrator.ts` | `_orchestratorDeps` | Context-engine orchestrator |
| **Review** | `src/review/runner/index.ts` | `_reviewRunnerDeps`, `_reviewGitDeps`, `_reviewLintDeps` | Review runner |
| | `src/review/semantic-evidence.ts` | `_evidenceDeps` | Semantic-review evidence |
| **Sandbox / tools** | `src/sandbox/srt-backend.ts` | `_srtBackendDeps` | OS-sandbox backend |
| | `src/tools/bash.ts` | `_bashToolDeps` | Native `Bash` tool execution |
| | `src/command-safety/shadow.ts` | `_commandShadowDeps` | Command-safety shadow classifier |
| **Other** | `src/utils/git.ts` | `_gitDeps` | All git commands |
| | `src/routing/router.ts` | `_tryLlmBatchRouteDeps` | LLM batch routing |
| | `src/worktree/manager.ts` | `_worktreeManagerDeps` | Worktree management |
| | `src/execution/merge-conflict-rectify.ts` | `_mergeRectifyDeps` | Parallel merge-conflict rectification |
| | `src/project/detector.ts` | `_detectorDeps` | Project detection |
| | `src/quality/runner.ts` | `_qualityRunnerDeps` | Quality command execution |

### Reference Files

- `test/integration/tdd/_tdd-test-helpers.ts` — shared helper for TDD orchestrator tests

---

## 3. Error Handling

### NaxError (v0.38.0+) — Standard Pattern

Use `NaxError` (`src/errors.ts`) for all errors. Derived classes: `AgentNotFoundError`, `AgentNotInstalledError`, `StoryLimitExceededError`, `LockAcquisitionError`. It provides a machine-readable `code`, structured `context`, and preserves the error chain via `cause`.

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

The old `throw new Error("[stage] message")` pattern is deprecated. Do not use it for new code — `bun run check:nax-error` ratchets the remaining `throw new Error(...)` count in `src/` and fails if it grows (single-line escape: `// nax-lint-allow: plain-error`).

---

## 4. Constants

### Rules

- **No magic numbers** in function bodies
- **File-level `const`** for single-file constants
- **Values shared across 2+ files** are exported from the owning module (through its barrel) — there is no global `src/constants.ts`
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

---

## 5. Agent Resolution (ADR-012)

### Rules

Agent-selection state is owned by `AgentManager` (`src/agents/manager.ts`), constructed once per run via `createRuntime(config, workdir)` (ADR-018 — read it from `runtime.agentManager`). All default-agent reads go through one of two canonical accessors — never reach into `config.autoMode` (removed in ADR-012 Phase 6):

| Caller context | Accessor | Source |
|:---|:---|:---|
| Pipeline stages (have `ctx: PipelineContext`) | `ctx.agentManager?.getDefault() ?? "claude"` | `src/agents/manager.ts` |
| Standalone modules (only have `NaxConfig`) | `resolveDefaultAgent(config)` | `src/agents/utils.ts` |

```typescript
// ✅ Pipeline stage — uses the run-scoped manager
const defaultAgent = ctx.agentManager?.getDefault() ?? "claude";
const agent = (ctx.agentGetFn ?? _deps.getAgent)(defaultAgent);

// ✅ Standalone module — derives from config
import { resolveDefaultAgent } from "../agents";
const defaultAgent = resolveDefaultAgent(config);

// ❌ Removed — autoMode.defaultAgent no longer exists
const defaultAgent = config.autoMode.defaultAgent;  // TS error + CONFIG_LEGACY_AGENT_KEYS at load
```

Both `AgentManager.getDefault()` and `resolveDefaultAgent()` return `config.agent.default` and fall
back to `DEFAULT_AGENT_NAME` (`"native"`, `src/config/agent-defaults.ts`). The `?? "claude"` in the
pipeline-stage form applies only when no `agentManager` is on the context.

### Per-story reset

`AgentManager.reset()` (`src/agents/manager.ts`) clears per-story availability state. It is the SSOT for that reset — there is no separate adapter-level or registry-level reset hook.

### Config shape

The canonical `config.agent` shape — `default`, `protocol`, `fallback.map`, etc. — is documented in `.nax/rules/config-patterns.md` § Agent Config Shape (ADR-012). Defaults: `agent.protocol: "hybrid"` (`DEFAULT_AGENT_PROTOCOL`) and `agent.default: "native"`. `agent.protocol` (`acp` | `native` | `hybrid`) is a capability gate, not a router — it decides which transports are permitted (ADR-027).
