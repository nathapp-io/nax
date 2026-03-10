# nax Project Constitution

> Condensed architectural rules. Full details: `docs/ARCHITECTURE.md`

## Size Limits

- **Files:** ≤400 lines — split before exceeding
- **Functions:** ≤30 lines target, 50 hard max — extract helpers
- **Positional params:** ≤3 — use options object beyond that

## Dependency Injection (`_deps`)

All external calls (Bun.spawn, Bun.file, Bun.which, fetch) MUST go through an exported `_deps` object for testability:

```typescript
export const _myDeps = {
  spawn(cmd: string[], opts: SpawnOpts) { return Bun.spawn(cmd, opts) as any; },
  which(name: string) { return Bun.which(name); },
};
```

Tests override `_deps` — never monkey-patch Bun globals. See `src/agents/adapters/gemini.ts` as reference.

## Async Patterns (Critical)

**Always read stdout/stderr concurrently with proc.exited — sequential reads deadlock on >64KB:**

```typescript
// ✅ Correct
const [exitCode, stdout, stderr] = await Promise.all([
  proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()
]);

// ❌ Deadlocks
const exitCode = await proc.exited;
const stdout = await new Response(proc.stdout).text();
```

- `Bun.sleep()` is uncancellable — use `setTimeout` pattern when cancellation is needed
- `Promise.race`: always `.catch(() => {})` on the losing promise
- Prefer `Promise.all` batch over sequential `for await` when items are independent

## Error Messages

Always include `[stage]` prefix and identifiers:

```typescript
throw new Error(`[routing] LLM strategy failed for story ${story.id}: ${err.message}`);
```

Wrap external errors with `{ cause: err }`. Never swallow errors silently.

## Type Safety

- No `any` in public APIs — use `unknown` + type guards
- Explicit return types on all exported functions
- Use discriminated unions for state, not stringly-typed objects
- Use `satisfies` for config objects

## Testing

- Mock via `_deps` pattern, not global monkey-patching
- Use `test.each()` for 3+ similar test cases
- Test names describe behavior: "returns null when file is missing"
- One `describe` per exported function

## Logging

Use structured logger — never `console.log`:

```typescript
const logger = getLogger();
logger?.info("stage-name", "Human-readable message", { storyId, key: value });
```

Levels: `debug` (internal state), `info` (lifecycle), `warn` (recoverable), `error` (failures).

## Bun-Native

- Runtime: Bun — no Node.js equivalents (no `child_process`, no `fs.promises` — use `Bun.spawn`, `Bun.file`)
- Package manager: `bun` (never npm/yarn)
- Test runner: `bun:test` (describe/test/expect)

## Design Patterns

Follow established patterns — see `docs/ARCHITECTURE.md` §11 for details:
- **Builder:** `static for()` → method chain → `.build()` (PromptBuilder, DecomposeBuilder)
- **Adapter:** interface in `types.ts`, class per backend (AgentAdapter)
- **Registry:** typed accessors, never raw Map (PluginRegistry, agent registry)
- **Strategy:** interface + implementations, selected by orchestrator (verification, routing)
- **Chain:** priority-ordered handlers with timeout/fallback (InteractionChain)
- **Singleton:** `getX()` / `getSafeX()` getters, never export instance directly (Logger)

## Boundaries

- Never modify `docs/ROADMAP.md` unless the story explicitly requires it
- Never modify CI config (`.gitlab-ci.yml`) unless the story explicitly requires it
- Never add dependencies without justification in acceptance criteria
