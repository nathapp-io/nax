# Project Conventions

## Language & Runtime

- **Bun-native only.** Use `Bun.file()`, `Bun.write()`, `Bun.spawn()`, `Bun.sleep()`. Never use Node.js equivalents (`fs.readFile`, `child_process.spawn`, `setTimeout` for delays).
- TypeScript strict mode. No `any` unless unavoidable (document why).
- Target: Bun 1.3.7+.

## File Size

- **400-line hard limit** for all source and test files.
- If a file approaches 400 lines, split it before adding more code.
- Split by logical concern (one function/class per file when possible).

## Module Structure

- Every directory with 2+ exports gets a barrel `index.ts`.
- Types go in `types.ts` per module directory.
- Import from barrels (`src/routing`), **never from internal paths** (`src/routing/router`). This prevents singleton fragmentation in Bun's module registry.

## Logging

- Use the project logger (`src/logger`). Never use `console.log` / `console.error` in source code.
- Log format: no emojis. Use `[OK]`, `[WARN]`, `[FAIL]`, `->`. Machine-parseable.

## Commits

- Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.
- Atomic — one logical change per commit.
- Never include `[run-release]` unless explicitly told to.

## Formatting

- Biome handles formatting and linting. Run `bun run lint` before committing.
