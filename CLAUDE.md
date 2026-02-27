# nax — AI Coding Agent Orchestrator

Bun + TypeScript CLI that orchestrates AI coding agents with model routing, three-session TDD, and lifecycle hooks.

## Commands

- Test: `bun test`
- Typecheck: `bun run typecheck`
- Lint: `bun run lint`
- Dev: `bun run dev`
- Build: `bun run build`
- Run before commit: `bun test && bun run typecheck`

## Code Style

- Bun-native APIs only (Bun.file, Bun.write, Bun.spawn, Bun.sleep) — no Node.js equivalents
- Functional style for pure logic; classes only for stateful adapters (e.g., ClaudeCodeAdapter)
- Types in `types.ts` per module, barrel exports via `index.ts`
- Max ~400 lines per file — split if larger
- Biome for formatting/linting

## Testing

- Framework: `bun:test` (describe/test/expect)
- Unit tests: `test/<module>.test.ts`
- Integration tests: `test/integration/<feature>.test.ts`
- All routing, classification, and isolation logic must have unit tests

## Architecture

### Execution Flow

```
Runner.run()  [src/execution/runner.ts]
  -> loadPlugins()  [src/plugins/loader.ts]
  -> for each story:
    -> Pipeline.execute()  [src/pipeline/pipeline.ts]
      -> stages: queueCheck -> routing -> constitution -> context -> prompt -> execution -> verify -> review -> completion
      -> context stage injects plugin context providers  [src/pipeline/stages/context.ts]
      -> routing stage checks plugin routers first  [src/routing/chain.ts]
    -> Reporter.emit()  [src/plugins/registry.ts]
  -> registry.teardownAll()
```

### Key Directories

| Directory | Purpose |
|:---|:---|
| `src/execution/` | Runner loop, agent adapters (Claude Code), TDD strategies |
| `src/pipeline/stages/` | Pipeline stages (routing, context, prompt, execution, review, etc.) |
| `src/routing/` | Model routing — tier classification, router chain, plugin routers |
| `src/plugins/` | Plugin system — loader, registry, validator, types |
| `src/config/` | Config schema, loader (layered global + project) |
| `src/cli/` | CLI commands |
| `examples/plugins/` | Sample plugins (console-reporter) |

### Plugin System

Plugins extend nax via 4 extension points:

| Extension | Interface | Integration Point |
|:---|:---|:---|
| **Context Provider** | `IContextProvider` | `src/pipeline/stages/context.ts` — injects context into agent prompts before execution |
| **Reviewer** | `IReviewer` | Pipeline review stage — runs after built-in checks (typecheck/lint/test) |
| **Reporter** | `IReporter` | `src/execution/runner.ts` — receives onRunStart/onStoryComplete/onRunEnd events |
| **Router** | `IRoutingStrategy` | `src/routing/chain.ts` — overrides model routing for specific stories |

Plugin loading order: global (`~/.nax/plugins/`) -> project (`<workdir>/nax/plugins/`) -> config (`plugins[]` in config.json).

### Config

- Global: `~/.nax/config.json`
- Project: `<workdir>/nax/config.json`
- Key settings: `execution.contextProviderTokenBudget` (default: 2000), `plugins[]` array

## IMPORTANT

- Never hardcode API keys — agents use their own auth from env
- Agent adapters spawn external processes — always handle timeouts and cleanup
- Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`
- Keep commits atomic — one logical change per commit
- Do NOT push to remote — let the human review and push
