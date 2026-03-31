# Codex Instructions

This file is auto-generated from `.nax/context.md`.
DO NOT EDIT MANUALLY — run `nax generate` to regenerate.

---

## Project Metadata

> Auto-injected by `nax generate`

**Project:** `@nathapp/nax`

**Language:** TypeScript

**Key dependencies:** @types/react, react, zod, @types/bun, react-devtools-core, typescript

---
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
Runner.run()  [src/execution/runner.ts — thin orchestrator only]
  → loadPlugins()
  → for each story:
    → Pipeline.execute()  [src/pipeline/pipeline.ts]
      → stages: queueCheck → routing → constitution → context → prompt
               → execution → verify → review → completion
    → Reporter.emit()
  → registry.teardownAll()
```

### Key Source Directories

| Directory | Purpose |
|:----------|:--------|
| `src/execution/` | Runner loop, agent adapters, escalation, lifecycle hooks |
| `src/execution/escalation/` | Tier escalation on repeated failures |
| `src/pipeline/stages/` | One file per pipeline stage |
| `src/pipeline/subscribers/` | Event-driven hooks (interaction, hooks.ts) |
| `src/routing/` | Model-tier routing — keyword, LLM, plugin chain |
| `src/routing/strategies/` | keyword.ts, llm.ts, llm-prompts.ts |
| `src/interaction/` | Interaction triggers + plugins (Auto, Telegram, Webhook) |
| `src/plugins/` | Plugin system — loader, registry, validator |
| `src/verification/` | Test execution, smart runner, scoped runner |
| `src/metrics/` | StoryMetrics, aggregator, tracker |
| `src/config/` | Config schema + layered loader (global → project) |
| `src/agents/adapters/` | Legacy CLI agent adapters (Claude Code, Codex, Gemini, etc.) |
| `src/agents/acp/` | ACP protocol adapter — unified, agent-agnostic via `acpx` |
| `src/cli/` + `src/commands/` | CLI commands — check both locations |
| `src/prd/` | PRD types, loader, story state machine |
| `src/hooks/` | Lifecycle hook wiring |
| `src/constitution/` | Constitution loader + injection |
| `src/analyze/` | `nax analyze` — story classifier |

### Plugin Extension Points

| Interface | Loaded By | Purpose |
|:----------|:----------|:--------|
| `IContextProvider` | `context.ts` stage | Inject context into agent prompts |
| `IReviewer` | Review stage | Post-verify quality checks |
| `IReporter` | Runner | onRunStart / onStoryComplete / onRunEnd events |
| `IRoutingStrategy` | Router chain | Override model-tier routing |

### Config

- Global: `~/.nax/config.json` → Project: `<workdir>/.nax/config.json`
- Schema: `src/config/schema.ts` — no hardcoded flags or credentials anywhere

## Agent Adapter & LLM Calls

- **Two protocol modes:** CLI (`Bun.spawn`) and ACP (JSON-RPC via `acpx`), toggled by `agent.protocol` in config (default: `"acp"`)
- **LLM fallback rule:** Any code needing LLM calls MUST use `getAgent(config.autoMode.defaultAgent)` from `src/agents/registry` — never inline stubs. Use `agent.complete(prompt, { jsonMode: true })` for one-shot calls.
- **Forward-compatible:** `getAgent()` returns the correct adapter for the active protocol — calling code doesn't need to know which mode is active.
- See `docs/architecture/ARCHITECTURE.md` §Adapter for full pattern.

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
**Full spec:** `docs/architecture/ARCHITECTURE.md` §14.

## Workflow Protocol

1. **Explore first**: use `grep`, `cat` to understand context before writing code.
2. **Plan complex tasks**: for multi-file changes, write a short plan before implementing.
3. **Implement in small chunks**: one logical concern per commit.


## Coding Standards & Architecture Patterns

**Read `docs/architecture/ARCHITECTURE.md` before writing any code.** It defines all enterprise-grade patterns:

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

- `01-project-conventions.md` — Bun-native APIs, 400-line limit, barrel imports, logging, commits
- `02-test-architecture.md` — directory mirroring, placement rules, file naming
- `03-test-writing.md` — `_deps` injection pattern, mock discipline, CI guards
- `04-forbidden-patterns.md` — banned APIs and test anti-patterns with alternatives
