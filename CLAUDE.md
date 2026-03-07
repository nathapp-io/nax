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

## Code Intelligence (Solograph MCP)

Use **solograph** MCP tools on-demand — do not use `web_search` or `kb_search`.

| Tool | When |
|:-----|:-----|
| `project_code_search` | Find existing patterns before writing new code |
| `codegraph_explain` | Architecture overview before tackling unfamiliar areas |
| `codegraph_query` | Dependency/impact analysis (Cypher) |
| `project_code_reindex` | After creating or deleting source files |

## Coding Standards & Forbidden Patterns

Full rules in `.claude/rules/` (loaded automatically):

- `01-project-conventions.md` — Bun-native APIs, 400-line limit, barrel imports, logging, commits
- `02-test-architecture.md` — directory mirroring, placement rules, file naming
- `03-test-writing.md` — `_deps` injection pattern, mock discipline, CI guards
- `04-forbidden-patterns.md` — banned APIs and test anti-patterns with alternatives
