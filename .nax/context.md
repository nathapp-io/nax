# nax — AI Coding Agent Orchestrator

Bun + TypeScript CLI that orchestrates AI coding agents (Claude Code) with model-tier routing, TDD strategies, plugin hooks, and a Central Run Registry.

## Tech Stack

| Layer | Choice |
|:------|:-------|
| Runtime | **Bun 1.3.7+** — Bun-native APIs only, no Node.js equivalents |
| Language | **TypeScript strict** — no `any` without explicit justification |
| Test | **`bun:test`** — describe/test/expect |
| Lint/Format | **Biome** (`bun run lint`) |
| Build | `bun run build` |

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | build the source |
| `bun run typecheck` | tsc --noEmit |
| `bun run lint` | Biome |
| `bun run lint:fix` | Biome lint fix |
| `bun test test/unit/foo.test.ts --timeout=30000` | Targeted test during iteration with timeout |
| `bun run test` | Full suite |
| `bun run test:bail` | Full suite with bail |

nax runs lint, typecheck, and tests automatically via the pipeline. Run these manually only when working outside a nax session.

## Engineering Persona

- **Senior Engineer mindset**: check edge cases, null/undefined, race conditions, and error states.
- **TDD first**: write or update tests before implementation when the story calls for it.
- **Stuck rule**: if the same test fails 2+ iterations, stop, summarise failed attempts, reassess approach.

## Architecture

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

### Key Source Directories

| Directory | Purpose |
|:----------|:--------|
| `src/execution/` | Runner loop, escalation, crash recovery, parallel execution, lifecycle phases |
| `src/execution/escalation/` | Tier escalation on repeated failures (fast → balanced → powerful) |
| `src/execution/lifecycle/` | Run lifecycle phases (setup, init, completion, cleanup, regression, acceptance) |
| `src/pipeline/stages/` | 15 pipeline stages (13 default + pre-run + post-run) |
| `src/pipeline/subscribers/` | Event-driven hooks (interaction, hooks.ts) |
| `src/routing/` | Model-tier routing — keyword, LLM, plugin chain |
| `src/routing/strategies/` | llm.ts, llm-prompts.ts |
| `src/interaction/` | Interaction triggers + plugins (Auto, Webhook) |
| `src/plugins/` | Plugin system — loader, registry, validator (7 extension points) |
| `src/verification/` | Test execution, smart runner, scoped runner, rectification loop |
| `src/metrics/` | StoryMetrics, aggregator, tracker |
| `src/config/` | Config schema + layered loader (global → project) + permissions |
| `src/agents/acp/` | ACP protocol adapter — unified, agent-agnostic via `acpx` |
| `src/agents/claude/` | Claude Code CLI adapter (multi-file) |
| `src/agents/cost/` | Centralized cost calculation (pricing, token parsing) |
| `src/agents/shared/` | Cross-adapter utilities (decompose, env, model-resolution, validation) |
| `src/cli/` + `src/commands/` | CLI commands — check both locations |
| `src/prd/` | PRD types, loader, story state machine |
| `src/hooks/` | Lifecycle hook wiring (11 event types) |
| `src/constitution/` | Constitution loader + generation (6 agent types) |
| `src/context/` | Context generation + auto-detect (7 agent generators) |
| `src/acceptance/` | Acceptance test generation, refinement, fix stories, templates |
| `src/tdd/` | TDD orchestration (three-session workflow, isolation, verdict) |
| `src/review/` | Code review orchestration (built-in + semantic + plugin checks) |
| `src/analyze/` | `nax analyze` — story classifier |
| `src/debate/` | Multi-agent debate system |
| `src/queue/` | Mid-run queue control (PAUSE, ABORT, SKIP) |
| `src/worktree/` | Git worktree management for parallel execution |
| `src/tui/` | React/Ink terminal UI |
| `src/optimizer/` | Prompt optimization (rule-based, no-op) |
| `src/project/` | Auto-detect project type, language, frameworks |

### Plugin Extension Points

| Interface | Loaded By | Purpose |
|:----------|:----------|:--------|
| `IContextProvider` | `context.ts` stage | Inject context into agent prompts |
| `IReviewPlugin` | Review stage | Post-verify quality checks |
| `IReporter` | Runner | onRunStart / onStoryComplete / onRunEnd events |
| `IRoutingStrategy` | Router chain | Override model-tier routing |
| `IPromptOptimizer` | Optimizer stage | Reduce token usage |
| `IPostRunAction` | Runner | Post-run hooks |

### Config

- Global: `~/.nax/config.json` → Project: `<workdir>/.nax/config.json`
- Schema: `src/config/schemas.ts` — no hardcoded flags or credentials anywhere

## Agent Adapter & LLM Calls

- **Two protocol modes:** CLI (`Bun.spawn`) and ACP (JSON-RPC via `acpx`), toggled by `agent.protocol` in config (default: `"acp"`)
- **LLM fallback rule:** Any code needing LLM calls MUST resolve the agent via the canonical accessors — `ctx.agentManager?.getDefault() ?? "claude"` in pipeline stages, or `resolveDefaultAgent(config)` in standalone modules. Never inline stubs, never read `config.autoMode.defaultAgent` (removed in ADR-012 Phase 6). Use `agent.complete(prompt, { jsonMode: true })` for one-shot calls.
- **Forward-compatible:** `getAgent()` returns the correct adapter for the active protocol — calling code doesn't need to know which mode is active.
- See `docs/architecture/design-patterns.md` §11 (Adapter) for full pattern.

## Permission Resolution (Mandatory)

All agent permission decisions go through `resolvePermissions(config, stage)` in `src/config/permissions.ts`.

**Rules — no exceptions:**
- **Always call `resolvePermissions(config, stage)`** — single source of truth
- **Never hardcode** `?? true`, `?? false`, or literal `"approve-all"` / `"approve-reads"`
- **Never read `dangerouslySkipPermissions` directly** — deprecated, the resolver handles it
- **Always pass `config` and `pipelineStage`** to adapter calls (`run()`, `complete()`, `plan()`, `decompose()`)

```typescript
// ✅ Correct
import { resolvePermissions } from "../config/permissions";
const { skipPermissions, mode } = resolvePermissions(config, "run");

// ❌ Wrong — local fallback
const skip = config?.execution?.dangerouslySkipPermissions ?? true;

// ❌ Wrong — hardcoded
args.push("--dangerously-skip-permissions");
```

**Profiles:** `unrestricted` (approve-all), `safe` (approve-reads), `scoped` (Phase 2).
**Full spec:** `docs/architecture/agent-adapters.md` §14.

## Workflow Protocol

1. **Explore first**: use `grep`, `cat` to understand context before writing code.
2. **Plan complex tasks**: for multi-file changes, write a short plan before implementing.
3. **Implement in small chunks**: one logical concern per commit.


## Coding Standards & Architecture Patterns

**Read `docs/architecture/ARCHITECTURE.md` (index) before writing any code.** It links to focused docs covering:

- **Dependency injection** — `_deps` pattern for all external calls (spawn, fs, fetch)
- **Error handling** — `[stage]` prefix + context + `{ cause: err }`
- **Constants** — no magic numbers, `UPPER_SNAKE_CASE`, `_` separators
- **Function design** — ≤30 lines, ≤3 positional params, options objects
- **Async patterns** — concurrent reads, `Promise.race` safety, no uncancellable `Bun.sleep`
- **Type safety** — no `any` in public APIs, discriminated unions, `satisfies`
- **Testing** — `_deps` mocking, `test.each()` for parametric tests, descriptive names
- **Logging** — structured JSONL with stage prefix
- **Git** — conventional commits, one concern per commit

Additional rules in `.claude/rules/` (loaded automatically):

- `project-conventions.md` — Bun-native APIs, 400-line limit, barrel imports, logging, commits
- `test-architecture.md` — directory mirroring, placement rules, file naming (path-scoped to `test/**/*.test.ts`)
- `forbidden-patterns.md` — banned APIs and test anti-patterns with alternatives
- `error-handling.md` — NaxError base class, cause chaining, return vs throw
- `config-patterns.md` — Zod schema validation, config SSOT, layering order
- `adapter-wiring.md` — run() vs complete(), session naming, agent resolution (path-scoped to `src/agents/**`)
