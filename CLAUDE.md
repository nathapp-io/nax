# nax — AI Coding Agent Orchestrator

Bun + TypeScript CLI that orchestrates AI coding agents with model routing, TDD strategies, and lifecycle hooks.

## Git Identity

```bash
git config user.name "subrina.tai"
git config user.email "subrina8080@outlook.com"
```

## Commands

```bash
bun test                          # Full test suite
bun test test/unit/foo.test.ts    # Specific file
bun run typecheck                 # tsc --noEmit
bun run lint                      # Biome
bun run build                     # Production build
bun test && bun run typecheck     # Pre-commit check
```

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

### Key Directories

| Directory | Purpose |
|:---|:---|
| `src/execution/` | Runner loop, agent adapters, TDD strategies |
| `src/execution/lifecycle/` | Lifecycle hooks, startup/teardown |
| `src/execution/escalation/` | Escalation logic on repeated failures |
| `src/execution/acceptance/` | Acceptance-loop iteration |
| `src/pipeline/stages/` | Pipeline stages |
| `src/routing/` | Model routing — tier classification, router chain |
| `src/plugins/` | Plugin system — loader, registry, validator |
| `src/config/` | Config schema, loader (layered global + project) |
| `src/agents/adapters/` | Agent integrations (Claude Code) |
| `src/cli/` + `src/commands/` | CLI commands (check both locations) |
| `src/verification/` | Test execution, smart test runner |
| `src/review/` | Post-verify review (typecheck, lint, plugin reviewers) |

### Plugin System (4 extension points)

| Extension | Interface | Integration Point |
|:---|:---|:---|
| Context Provider | `IContextProvider` | `context.ts` stage — injects into prompts |
| Reviewer | `IReviewer` | Review stage — after built-in checks |
| Reporter | `IReporter` | Runner — onRunStart/onStoryComplete/onRunEnd |
| Router | `IRoutingStrategy` | Router chain — overrides model routing |

### Config

- Global: `~/.nax/config.json` → Project: `<workdir>/nax/config.json`
- Schema: `src/config/schema.ts` — no hardcoded flags or credentials

## Design Principles

- **`runner.ts` is a thin orchestrator.** Never add new concerns — extract into focused sub-modules.
- **`src/verification/` is the single test execution layer.** Don't duplicate test invocation in pipeline stages.
- **Closures over values** for long-lived handlers (crash handlers, timers) — prevents stale state capture.
- **New agent adapters** go in `src/agents/adapters/<name>.ts` — never inline in runner or existing adapters.

## Rules

Detailed coding standards, test architecture, and forbidden patterns are in `.claude/rules/`. Claude Code loads these automatically.

## IMPORTANT

- Do NOT push to remote — let the human review and push.
- Never hardcode API keys — agents use their own auth from env.
- Agent adapters spawn external processes — always handle timeouts and cleanup.
