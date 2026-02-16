# ngent — AI Coding Agent Orchestrator

Standalone CLI (Bun + TypeScript) that orchestrates AI coding agents with smart model routing, three-session TDD, and lifecycle hooks. NOT an OpenClaw skill — independent npm package.

## Commands

```bash
bun test              # Run all tests (bun:test)
bun run typecheck     # TypeScript type checking (tsc --noEmit)
bun run lint          # Biome linter (src/ bin/)
bun run dev           # Run CLI locally
bun run build         # Bundle for distribution
```

## Architecture

```
bin/ngent.ts          # CLI entry point (commander)
src/
  agents/             # AgentAdapter interface + implementations (claude.ts)
  cli/                # CLI commands (init, run, features, agents, status)
  config/             # NgentConfig schema + layered loader + validation (global → project)
  execution/          # Main orchestration loop (the core)
  hooks/              # Lifecycle hooks (hooks.json → shell commands + NGENT_* env)
  pipeline/           # Pipeline orchestration utilities
  prd/                # PRD/user-story loader, ordering, completion tracking
  queue/              # Queue manager for multi-agent parallel execution
  routing/            # Complexity classifier + test strategy decision tree
  tdd/                # Three-session TDD types + file isolation checker + orchestrator
test/                 # Bun test files (*.test.ts)
```

### Key Concepts

- **Complexity Routing**: Tasks classified as simple/medium/complex/expert → mapped to model tiers (cheap/standard/premium)
- **Three-Session TDD**: Session 1 (test-writer, only test files) → Session 2 (implementer, only source files) → Session 3 (verifier, auto-approves legitimate fixes)
- **Isolation Enforcement**: Git diff verification between TDD sessions — test-writer can't touch source, implementer can't touch tests
- **Hook System**: `hooks.json` maps lifecycle events (on-start, on-complete, on-pause, on-error, on-story-start, on-story-end) to shell commands
- **Layered Config**: `~/.ngent/config.json` (global) merged with `<project>/ngent/config.json` (project overrides)

## Code Style

- Bun-native APIs preferred (Bun.file, Bun.write, Bun.spawn, Bun.sleep)
- Each module directory: `types.ts` (interfaces), implementation files, `index.ts` (barrel exports)
- Immutable patterns — avoid mutation
- No classes unless wrapping stateful adapters (like ClaudeCodeAdapter)
- Functional style for pure logic (routing, classification, isolation checks)
- Biome for formatting and linting

## Testing

- Test framework: `bun:test` (describe/test/expect)
- Test files: `test/*.test.ts`
- Test naming: `test/<module>.test.ts`
- All routing/classification logic must have unit tests
- Isolation checker must have unit tests
- Run `bun test` before committing — all tests must pass

## File Conventions

- Max ~400 lines per file, split if larger
- Types/interfaces in dedicated `types.ts` per module
- Barrel exports via `index.ts` — import from module path, not deep paths
- Config defaults co-located with schema (`DEFAULT_CONFIG` in `schema.ts`)

## Current Status (v0.1.0)

### Done
- [x] Agent adapter interface + Claude Code implementation
- [x] Config schema + layered loader
- [x] Config validation (version, limits, escalation settings)
- [x] Hook lifecycle system
- [x] Complexity-based routing + test strategy decision tree
- [x] TDD isolation checker
- [x] Three-session TDD orchestrator
- [x] PRD loader/saver with dependency-aware ordering
- [x] Execution runner with cost tracking
- [x] Queue manager module
- [x] CLI: init, run, analyze, features create/list, agents, status
- [x] 67 tests passing

### TODO (Priority Order)
1. **Agent execution** — Actually spawn Claude Code sessions with prompts via Bun.spawn
2. **Progress logging** — Append to progress.txt after each story completion
3. **Auto-escalation** — On failure, escalate model tier (cheap → standard → premium) and retry
4. **Pipeline module** — Wire up full execution flow with quality gates

## Git

- Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`
- Run `bun test && bun run typecheck` before committing
- Keep commits atomic — one logical change per commit

## Important

- This is a Bun project — do NOT use Node.js APIs when Bun equivalents exist
- Agent adapters spawn external processes — always handle timeouts and cleanup
- Never hardcode API keys — agents use their own auth (e.g., Claude Code uses ANTHROPIC_API_KEY from env)
- The execution runner has `[TODO]` markers for unimplemented agent spawning — that's the next priority
