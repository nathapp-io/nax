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
- Unit tests: `test/unit/<module>.test.ts`
- Integration tests: `test/integration/<feature>.test.ts`
- Routing tests: `test/routing/<router>.test.ts`
- UI tests: `test/ui/` (TUI testing, rarely needed)
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
| `src/execution/lifecycle/` | (v0.15.0) Lifecycle hooks, startup/teardown orchestration |
| `src/execution/escalation/` | (v0.15.0) Acceptance-loop escalation logic (when agent fails repeatedly) |
| `src/execution/acceptance/` | (v0.15.0) Acceptance-loop iteration logic |
| `src/pipeline/stages/` | Pipeline stages (routing, context, prompt, execution, review, etc.) |
| `src/routing/` | Model routing — tier classification, router chain, plugin routers |
| `src/plugins/` | Plugin system — loader, registry, validator, types |
| `src/config/` | Config schema, loader (layered global + project) |
| `src/verification/` | (planned) Unified test execution, typecheck, lint, acceptance checks |
| `src/agents/adapters/` | Agent integrations (Claude Code, future: Devin, Aider, etc.) |
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

## Target Architecture (v0.15.0+)

### File Size Hard Limit

**400 lines maximum per file.** If you are about to exceed it, STOP and split first.

### execution/ Module Re-architecture Goal

Keep `runner.ts` as a **thin orchestrator only**. Extract:

- `sequential-executor.ts` — single-story execution loop
- `parallel-runner.ts` — parallel story execution (future)
- `acceptance-loop.ts` — retry/escalation logic for failed stories
- `reporter-notifier.ts` — plugin event emission (onRunStart, onStoryComplete, onRunEnd)
- `lifecycle/` subdir — startup, teardown, cleanup handlers
- `escalation/` subdir — escalation strategies when acceptance loop fails

**Never add new concerns to `runner.ts`** — new logic goes into a focused sub-module.

### verification/ Unified Layer (Planned)

Do not duplicate test execution logic across pipeline stages. When building new verification features (typecheck, lint, test, acceptance checks), put the logic in `src/verification/` and call from pipeline stages. This prevents scattered test invocations and ensures consistent test result parsing.

### Plugin Extension Points

When adding new agent integrations (e.g., Devin, Aider, Cursor):

1. Add adapter class to `src/agents/adapters/<name>.ts`
2. Register in `src/agents/adapters/index.ts`
3. Do NOT inline agent logic in `runner.ts` or `claude.ts`

### Logging Style

- No emojis in log messages
- Use `[OK]`, `[WARN]`, `[FAIL]`, `->` instead
- Keep logs machine-parseable

### Configuration

- No hardcoded flags or credentials
- Always read from config schema (`src/config/schema.ts`)
- Validate config at startup

### Closure Passing for Long-Lived Handlers

Pass **closures, not values** to long-lived handlers (crash handlers, heartbeat timers). This ensures handlers always reference the latest state, not stale snapshots.

```typescript
// WRONG: Captures stale value
const handler = () => cleanup(currentStory)

// CORRECT: Closure references latest state
const handler = () => cleanup(() => getCurrentStory())
```

## Testing Constraints (CRITICAL)

- **Never spawn full `nax` processes in tests.** nax has prechecks (git-repo-exists, dependencies-installed) that fail in temp directories. Write unit tests with mocks instead.
- **Integration tests that need git:** Always `git init` + `git add` + `git commit` in the test fixture before running any code that triggers nax precheck validation.
- **Test files for crash/signal handling:** Use process-level mocks (e.g., mock `process.on('SIGTERM', ...)`) — do not send real signals in tests.
- **Context files:** If a test needs specific context files, create them in the test fixture directory — don't rely on auto-detection from the real workspace.

## IMPORTANT

- Never hardcode API keys — agents use their own auth from env
- Agent adapters spawn external processes — always handle timeouts and cleanup
- Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`
- Keep commits atomic — one logical change per commit
- Do NOT push to remote — let the human review and push
