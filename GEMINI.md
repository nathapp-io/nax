# Gemini CLI Context

This file is auto-generated from `.nax/context.md`.
DO NOT EDIT MANUALLY — run `nax generate` to regenerate.

---

## Project Metadata

> Auto-injected by `nax generate`

**Project:** `@nathapp/nax`

**Language:** TypeScript

**Key dependencies:** @types/react, react, zod, @types/bun, react-devtools-core, typescript

**Commands:** test: `bun run test` | lint: `bun run lint` | typecheck: `bun run typecheck`

---
# nax — AI Coding Agent Orchestrator

Bun + TypeScript CLI that orchestrates AI coding agents (Claude Code) with model-tier routing, TDD strategies, plugin hooks, and a Central Run Registry.

## Tech Stack

| Layer | Choice |
|:------|:-------|
| Runtime | **Bun 1.4.0** (pinned in CI) — Bun-native APIs only, no Node.js equivalents |
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
| `bun run test:coverage` | Per-file coverage gate against the baseline (CI runs this) |
| `bun run test:coverage:report` | Coverage report without failing the gate |

nax runs lint, typecheck, and tests automatically via the pipeline. Run these manually only when working outside a nax session.

`test:coverage` is **not** part of the nax pipeline — it is a separate CI step with a per-file floor.
Run it by hand after changes that add or move tests, since a passing suite can still fail the gate.

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
        → Pipeline stages 1–8 (defaultPipeline)
        → executionStage delegates per-story work to
          StoryOrchestratorBuilder.CANONICAL_ORDER (test-writer →
          greenfield-gate → implementer → test-presence-gate →
          full-suite-gate → mutation-check → verifier → verify-scoped →
          lint/typecheck checks → semantic/adversarial review)
          + runFixCycle FixStrategies for rectification
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
| `src/pipeline/stages/` | 10 pipeline stages (8 default + 1 pre-run + 1 post-run) |
| `src/pipeline/subscribers/` | Event-driven hooks (interaction, hooks.ts) |
| `src/routing/` | Model-tier routing — keyword, LLM, plugin chain |
| `src/routing/strategies/` | llm.ts, llm-cache.ts, llm-parsing.ts |
| `src/interaction/` | Interaction triggers + chain + plugins (CLI, Telegram, Webhook) |
| `src/plugins/` | Plugin system — loader, registry, validator (7 extension points) |
| `src/verification/` | Test execution, smart runner, scoped runner (per-story verify via verifyScopedOp / fullSuiteGateOp) |
| `src/metrics/` | StoryMetrics, aggregator, tracker |
| `src/config/` | Config schema + layered loader (global → project) + permissions |
| `src/agents/acp/` | ACP protocol adapter — unified, agent-agnostic via `acpx` (one of two transports; see ADR-027) |
| `src/agents/cost/` | Centralized cost calculation (pricing, token parsing) |
| `src/agents/native/` | Native in-process LLM path over `@nathapp/nax-ai` (one-shot `complete()`; sessions are Phase B) |
| `src/agents/shared/` | Cross-adapter utilities (decompose, env, model-resolution, validation) |
| `src/cli/` + `src/commands/` | CLI commands — check both locations |
| `src/prd/` | PRD types, loader, story state machine |
| `src/hooks/` | Lifecycle hook wiring (12 event types) |
| `src/constitution/` | Constitution loader + generation (5 agent types) |
| `src/context/` | Context generation + auto-detect (7 agent generators) |
| `src/acceptance/` | Acceptance test generation, refinement, fix stories, templates |
| `src/tdd/` | TDD orchestration (three-session workflow, isolation, verdict) |
| `src/review/` | Code review orchestration (built-in + semantic + plugin checks) |
| `src/analyze/` | `nax analyze` — story classifier |
| `src/debate/` | Multi-agent debate system |
| `src/queue/` | Mid-run queue control (PAUSE, ABORT, SKIP) |
| `src/worktree/` | Git worktree management for parallel execution |
| `src/tui/` | React/Ink terminal UI |
| `src/optimizer/` | Prompt optimization seam (no-op built-in, plugin-provided) |
| `src/project/` | Auto-detect project type, language, frameworks |
| `src/runtime/` | Run-scoped runtime — dispatch context/events, agent middleware (incl. idle watchdog), cost aggregation, prompt auditing, paths |
| `src/operations/` | Per-story operations invoked by the orchestrator phases (implementer, verifier, reviews, autofix, acceptance generate/refine/fix) |
| `src/findings/` | Finding model + fix cycle — selection, retirement, iteration log, per-story fix history |
| `src/finish/` | `nax finish` — audit, gates, commit, PR/notify state machine |
| `src/precheck/` | Pre-run checks (agents, CLI, config, git, system) + story-size gate |
| `src/quality/` | Resolves and runs the project's real lint/typecheck/test commands |
| `src/test-runners/` | Test-framework detection, output parsing, scoped test selection |
| `src/session/` | Agent session lifecycle — naming, model selection, keeper, scratch dirs, sweep |
| `src/plan/` | `nax plan` — draft strategies, critic, spec deltas, citations |
| `src/replay/` | Reconstruct a past run from its artifacts (`nax replay`) |
| `src/bakeoff/` | Multi-contestant bakeoff runs — coordinator, ranking, report |
| `src/forge/` | Git-forge integration — provider detect, PR creation, templates |
| `src/schedule/` | Schedule parsing and waiting for deferred runs |
| `src/prompts/` | Prompt composition — core, sections, builders, loader |
| `src/logger/` | Structured JSONL logger — sinks, formatters, redaction |
| `src/log-format/` | Human-facing formatting of log records and mutation summaries |
| `src/utils/` | Shared helpers (git, file locks, JSON/JSONL, diffs, errors) |
| `src/errors.ts` | `NaxError` base class and error codes (a single file, not a directory) |

### Plugin Extension Points

| Interface | Loaded By | Purpose |
|:----------|:----------|:--------|
| `AgentAdapter` | Agent registry | Supply a custom agent adapter |
| `IContextProvider` | `context.ts` stage | Inject context into agent prompts |
| `IReviewPlugin` | Deferred end-of-run review (`deferred-review.ts`) | Observational by default; set `review.pluginMode: "gating"` to fail the run on findings. Per-story gating removed (ADR-023 / #1146). |
| `IReporter` | Runner | onRunStart / onStoryComplete / onRunEnd events |
| `IRoutingStrategy` | Router chain | Override model-tier routing |
| `IPromptOptimizer` | Optimizer stage | Reduce token usage |
| `IPostRunAction` | Runner | Post-run hooks |

### Config

- Global: `~/.nax/config.json` → Project: `<workdir>/.nax/config.json`
- Schema: `src/config/schemas.ts` — no hardcoded flags or credentials anywhere

## Agent Adapter & LLM Calls

- **Two transports, selected by agent name:** ACP via `acpx` for every named CLI
  agent, and the in-process native path (`@nathapp/nax-ai`) for the `native`
  agent. `agent.protocol` (`acp` | `native` | `hybrid`, default `acp`) is a
  capability gate, not a router — it decides which are permitted. See ADR-027.
- **nax-ai is importable only from `src/agents/native/`**, enforced by
  `bun run check:nax-ai-imports`.
- **LLM fallback rule:** Any code needing LLM calls MUST resolve the agent via the canonical accessors — `ctx.agentManager?.getDefault() ?? "claude"` in pipeline stages, or `resolveDefaultAgent(config)` in standalone modules. Never inline stubs, never read `config.autoMode.defaultAgent` (removed in ADR-012 Phase 6). Use `agent.complete(prompt, { jsonMode: true })` for one-shot calls.
- **Forward-compatible:** `getAgent()` returns the active adapter — calling code doesn't depend on the protocol.
- See `docs/architecture/design-patterns.md` §11 (Adapter) for full pattern.

## Permission Resolution (Mandatory)

All agent permission decisions go through `resolvePermissions(config, stage)` in `src/config/permissions.ts`.

**Rules — no exceptions:**
- **Always call `resolvePermissions(config, stage)`** — single source of truth
- **Never hardcode** `?? true`, `?? false`, or literal `"approve-all"` / `"approve-reads"`
  — enforced by `scripts/check-permission-mode-ssot.ts`; a site that only *consumes* an already-resolved mode takes `// nax-permission-mode-allow: <reason>`
- **Unset `permissionProfile` resolves to `approve-all`** — ruled 2026-08-30 (ENH-45), named as `DEFAULT_PERMISSION_PROFILE`. nax's own pipeline is the caller and must run unattended. An *invalid* profile is a different case: it fails closed to `approve-reads` and logs, because reaching that arm means config validation was bypassed
- **The session-close path is a ruled exemption** — `SESSION_CLOSE_PERMISSION_MODE` (SEC-12). `src/agents/acp/` cannot see `NaxConfig` by design (`check:adapter-no-config-import`), and no agent work runs under the loaded-then-closed session
- **Never reintroduce `dangerouslySkipPermissions`** — removed, not deprecated: it has zero occurrences in `src/`, and `test/unit/config/permissions.test.ts` pins that at zero
- **Always pass `config` and `pipelineStage`** to adapter calls (`run()`, `complete()`, `plan()`, `decompose()`)

```typescript
// ✅ Correct
import { resolvePermissions } from "../config/permissions";
const { mode } = resolvePermissions(config, "run");

// ❌ Wrong — local fallback on a field that no longer exists
const skip = config?.execution?.dangerouslySkipPermissions ?? true;

// ❌ Wrong — hardcoded
args.push("--dangerously-skip-permissions");
```

`mode` is the only resolved value. Both `dangerouslySkipPermissions` and the older
`skipPermissions` field belonged to the CLI adapter, which no longer exists, and were
removed — do not reintroduce either.

**Profiles:** `unrestricted` (approve-all), `safe` (approve-reads), `scoped` (approve-reads,
per-stage allowlist). `scoped` resolves through `resolveScopedPermissions`
(`src/config/permissions.ts`) and the `execution.permissions` block is enforced at config
load by `validatePermissionsBlock` (`src/config/config-guards.ts`); `scoped` is in the
schema enum in `src/config/schemas-execution.ts`. GitHub #374 tracked the original design;
the block is wired and enforced, not rejected.
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

Additional rules live in `.nax/rules/` — the agent-neutral canonical store. `.claude/rules/` is
**generated** from it by `nax generate`; edit `.nax/rules/`, never the generated copies.
`bun run check:rules-drift` fails if the two diverge. Each file carries frontmatter (`priority`,
`appliesTo`, `stages`) so it is loaded only for the paths and stages it applies to.

- `project-conventions.md` — Bun-native APIs, 400-line limit, barrel imports, logging, commits
- `monorepo-awareness.md` — per-package config, workspace-scoped commands
- `error-handling.md` — NaxError base class, cause chaining, return vs throw
- `config-patterns.md` — Zod schema validation, config SSOT, layering order
- `adapter-wiring.md` — run() vs complete(), session naming, agent resolution (path-scoped to `src/agents/**`)
- `retry-strategy.md` — retry/hop policy, idle watchdog, escalation boundaries
- `forbidden-patterns-source.md` — banned APIs in `src/` with alternatives
- `forbidden-patterns-tests.md` — test anti-patterns with alternatives
- `test-architecture.md` — directory mirroring, placement rules, file naming (path-scoped to `test/**/*.test.ts`)
- `test-writing.md` — what a test must assert to count
- `test-helpers.md` — shared mock/helper catalogue, no inline re-implementations
- `test-ratchets.md` — the escape-hatch and coverage baselines and how to move them
- `testing-commands.md` — which test command to run when
