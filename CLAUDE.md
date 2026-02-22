# nax — AI Coding Agent Orchestrator

Bun + TypeScript CLI that orchestrates AI coding agents with model routing, three-session TDD, and lifecycle hooks.

## Commands

- Test: `bun test`
- Typecheck: `bun run typecheck`
- Lint: `bun run lint`
- Dev: `bun run dev`
- Build: `bun run build`

## Code Style

- Bun-native APIs only (Bun.file, Bun.write, Bun.spawn, Bun.sleep) — no Node.js equivalents
- Functional style for pure logic; classes only for stateful adapters (e.g., ClaudeCodeAdapter)
- Types in `types.ts` per module, barrel exports via `index.ts`
- Max ~400 lines per file — split if larger
- Biome for formatting/linting

## Testing

- Framework: `bun:test` (describe/test/expect)
- Files: `test/*.test.ts` named `test/<module>.test.ts`
- All routing, classification, and isolation logic must have unit tests
- Run `bun test && bun run typecheck` before committing

## Architecture

- **Pipeline stages** (`src/pipeline/stages/*.ts`): queueCheck → routing → constitution → context → prompt → execution → verify → review → completion
- **Execution runner** (`src/execution/runner.ts`): outer loop loads PRD → picks story/batch → runs pipeline → repeats
- **TDD isolation**: git diff verification — test-writer can only touch test files, implementer can only touch source files
- **Config**: layered `~/.nax/config.json` (global) + `<project>/nax/config.json` (project)

## IMPORTANT

- Never hardcode API keys — agents use their own auth from env
- Agent adapters spawn external processes — always handle timeouts and cleanup
- Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`
- Keep commits atomic — one logical change per commit
