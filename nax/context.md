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

## Git Identity

```bash
git config user.name "subrina.tai"
git config user.email "subrina8080@outlook.com"
```

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run typecheck` | tsc --noEmit |
| `bun run lint` | Biome |
| `bun test test/unit/foo.test.ts` | Targeted test during iteration |
| `NAX_SKIP_PRECHECK=1 bun test test/ --timeout=60000 --bail` | Full suite |

nax runs lint, typecheck, and tests automatically via the pipeline. Run these manually only when working outside a nax session.

## Engineering Persona

- **Senior Engineer mindset**: check edge cases, null/undefined, race conditions, and error states.
- **TDD first**: write or update tests before implementation when the story calls for it.
- **Stuck rule**: if the same test fails 2+ iterations, stop, summarise failed attempts, reassess approach.
- **Never push to remote** — the human reviews and pushes.

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
| `src/agents/adapters/` | Agent integrations (Claude Code) |
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

- Global: `~/.nax/config.json` → Project: `<workdir>/nax/config.json`
- Schema: `src/config/schema.ts` — no hardcoded flags or credentials anywhere

## Workflow Protocol

1. **Explore first**: use `grep`, `cat`, and solograph MCP to understand context before writing code.
2. **Plan complex tasks**: for multi-file changes, write a short plan before implementing.
3. **Implement in small chunks**: one logical concern per commit.

## Code Intelligence (Solograph MCP) — MANDATORY

**Always use solograph MCP tools before writing code or analyzing architecture.** Do NOT use `web_search` or `kb_search` as substitutes.

### Tool Selection Guide

| Tool | Capability | When to Use | Availability |
|:-----|:-----------|:-----------|:-------------|
| `codegraph_query` | Structural queries (Cypher) — find calls, dependencies, imports | **Preferred for dependency analysis, call tracing, symbol lookup** | ✅ Always works (in-memory graph) |
| `project_code_search` | Semantic search (Redis vector DB) — pattern matching by meaning | Natural language queries like "find auth patterns" | ⚠️ Requires explicit `project_code_reindex` |
| `codegraph_explain` | Architecture overview for unfamiliar subsystems | Understand module relationships before major changes | ✅ Always works |
| `project_code_reindex` | Index project for semantic search | After creating/deleting source files | ✅ Always works |

### Recommended Workflow

For nax, **prefer `codegraph_query`** for routine tasks:
- Finding where functions are called
- Analyzing dependencies before refactoring
- Tracing import/export chains
- Querying symbol definitions and relationships

**Use `project_code_search` only if:**
- You need semantic similarity ("find authentication patterns")
- Redis is indexed and running (not guaranteed in all sessions)

### Example Queries

```cypher
-- Find files calling calculateAggregateMetrics
MATCH (f:File)-[:CALLS]->(s:Symbol {name: "calculateAggregateMetrics"})
RETURN f.path

-- Find all imports of aggregator.ts
MATCH (f:File)-[:IMPORTS]->(target:File {path: "src/metrics/aggregator.ts"})
RETURN f.path

-- Find symbols defined in a file
MATCH (f:File {path: "src/metrics/aggregator.ts"})-[:DEFINES]->(s:Symbol)
RETURN s.name, s.type
```

## Coding Standards & Architecture Patterns

**Read `docs/ARCHITECTURE.md` before writing any code.** It defines all enterprise-grade patterns:

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
