# DEPS-001: _deps Consolidation

**Status:** Draft
**Priority:** Low (refactor — no user-facing behavior change)
**Scope:** 63 `_*Deps` / `_deps` exports across `src/`
**Estimated LOC delta:** −250 to −350 (net reduction)

---

## Problem

The `_deps` injection pattern (exported mutable objects that tests override) is used in 63 places. Over time, boilerplate has accumulated:

1. **22 files** duplicate `spawn: Bun.spawn` wrappers — 11 agent adapters copy-paste identical typed return signatures (~15 lines each).
2. **5 files** duplicate `which: Bun.which` (identical one-liner).
3. **5 files** duplicate `sleep: Bun.sleep` (identical one-liner).
4. **7 files** duplicate `getAgent` from the same import.
5. **3 files** instantiate `adapter: new ClaudeCodeAdapter()` just for DI.
6. **9 files** use the bare name `_deps` — not greppable, confusing in stack traces.
7. **`getRunsDir`** has two different defaults in `logs-reader.ts` vs `runs.ts` (potential bug).

## Goals

- Eliminate copy-pasted Bun primitive wrappers
- Make every `_deps` export uniquely named (greppable)
- Fix the `getRunsDir` discrepancy
- No behavior changes — purely mechanical refactor
- All existing tests pass without modification (deps shape unchanged)

## Non-Goals

- Changing the `_deps` injection pattern itself (it works well)
- Introducing a DI framework
- Touching test files (they mock the same shapes — shapes don't change)

---

## Plan

### Phase 1: Shared Bun primitives module

Create `src/utils/bun-deps.ts`:

```ts
/**
 * Shared injectable Bun primitives.
 *
 * Import these into your module's _deps object instead of
 * re-declaring Bun.spawn / Bun.which / Bun.sleep wrappers.
 *
 * Tests mock the consuming module's _deps — NOT this file.
 */

/** Typed spawn return (covers all agent adapter use cases) */
export interface SpawnResult {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  pid: number;
  kill(signal?: number | NodeJS.Signals): void;
}

/** Spawn options union covering all current call sites */
export interface SpawnOptions {
  cwd?: string;
  stdin?: "pipe" | "inherit";
  stdout: "pipe";
  stderr: "pipe" | "inherit";
  env?: Record<string, string | undefined>;
}

/** Injectable typed spawn — wraps Bun.spawn with proper return type */
export function typedSpawn(cmd: string[], opts: SpawnOptions): SpawnResult {
  return Bun.spawn(cmd, opts) as unknown as SpawnResult;
}

/** Injectable which — wraps Bun.which */
export function which(name: string): string | null {
  return Bun.which(name);
}

/** Injectable sleep — wraps Bun.sleep */
export function sleep(ms: number): Promise<void> {
  return Bun.sleep(ms);
}

/** Injectable file — wraps Bun.file */
export function file(path: string) {
  return Bun.file(path);
}

/** Injectable spawn (simple, untyped — for git/process use cases) */
export const spawn = Bun.spawn as typeof Bun.spawn;
```

**~40 lines.** No deps object here — this is just a shared import source.

### Phase 2: Agent adapter spawn consolidation

Replace 11 agent adapter spawn boilerplate with imports from `bun-deps.ts`:

**Before** (repeated in each adapter, ~15 lines each):
```ts
export const _codexRunDeps = {
  which(name: string): string | null {
    return Bun.which(name);
  },
  spawn(
    cmd: string[],
    opts: { cwd?: string; stdout: "pipe"; stderr: "pipe" | "inherit"; env?: Record<string, string | undefined> },
  ): {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    pid: number;
    kill(signal?: number | NodeJS.Signals): void;
  } {
    return Bun.spawn(cmd, opts) as unknown as { ... };
  },
};
```

**After** (~3 lines each):
```ts
import { typedSpawn, which } from "../utils/bun-deps";

export const _codexRunDeps = {
  which,
  spawn: typedSpawn,
};
```

**Files affected (11):**
- `src/agents/codex/adapter.ts` — `_codexRunDeps`, `_codexCompleteDeps`
- `src/agents/opencode/adapter.ts` — `_opencodeCompleteDeps`
- `src/agents/claude/complete.ts` — `_completeDeps`
- `src/agents/claude/adapter.ts` — `_decomposeDeps`
- `src/agents/claude/execution.ts` — `_runOnceDeps`
- `src/agents/aider/adapter.ts` — `_aiderCompleteDeps`
- `src/agents/gemini/adapter.ts` — `_geminiRunDeps`, `_geminiCompleteDeps`
- `src/agents/shared/version-detection.ts` — `_versionDetectionDeps`
- `src/agents/acp/spawn-client.ts` — `_spawnClientDeps`

**Estimated savings:** ~165 lines removed.

### Phase 3: Other Bun primitive consolidation

Replace simple `spawn`/`sleep`/`which` one-liners in non-agent files:

| File | Dep | Replace with |
|:-----|:----|:-------------|
| `src/verification/executor.ts` | `_executorDeps.spawn` | `spawn` from bun-deps |
| `src/verification/strategies/acceptance.ts` | `_acceptanceDeps.spawn` | `spawn` from bun-deps |
| `src/worktree/manager.ts` | `_managerDeps.spawn` | `spawn` from bun-deps |
| `src/worktree/merge.ts` | `_mergeDeps.spawn` | `spawn` from bun-deps |
| `src/tdd/isolation.ts` | `_isolationDeps.spawn` | `spawn` from bun-deps |
| `src/tdd/cleanup.ts` | `_cleanupDeps.spawn`, `.sleep`, `.kill` | `spawn`, `sleep` from bun-deps |
| `src/utils/git.ts` | `_gitDeps.spawn` | `spawn` from bun-deps |
| `src/precheck/checks-cli.ts` | `_deps.spawn` | `spawn` from bun-deps |
| `src/routing/strategies/llm.ts` | `_deps.spawn` | `typedSpawn` from bun-deps |
| `src/interaction/plugins/webhook.ts` | `_webhookPluginDeps.sleep` | `sleep` from bun-deps |
| `src/verification/runners.ts` | `_regressionRunnerDeps.sleep` | `sleep` from bun-deps |
| `src/agents/claude/adapter.ts` | `_claudeAdapterDeps.sleep`, `.spawn` | from bun-deps |
| `src/agents/acp/adapter.ts` | `_acpAdapterDeps.which`, `.sleep` | from bun-deps |

**Estimated savings:** ~50 lines.

### Phase 4: Rename bare `_deps` to descriptive names

| File | Current | Rename to |
|:-----|:--------|:----------|
| `src/commands/logs-reader.ts` | `_deps` | `_logsReaderDeps` |
| `src/commands/runs.ts` | `_deps` | `_runsCmdDeps` |
| `src/precheck/checks-cli.ts` | `_deps` | `_checkCliDeps` |
| `src/context/builder.ts` | `_deps` | `_contextBuilderDeps` |
| `src/context/generator.ts` | `_generatorDeps` | ✅ already named |
| `src/interaction/plugins/auto.ts` | `_deps` | `_autoPluginDeps` |
| `src/cli/plan.ts` | `_deps` | `_planDeps` |
| `src/cli/init-context.ts` | `_deps` | `_initContextDeps` |
| `src/routing/strategies/llm.ts` | `_deps` | `_llmStrategyDeps` |
| `src/review/runner.ts` | `_deps` (2nd) | `_reviewGitDeps` |

**Test files** that reference these must be updated (import name change).

### Phase 5: Fix `getRunsDir` discrepancy

`logs-reader.ts`:
```ts
getRunsDir: () => process.env.NAX_RUNS_DIR ?? join(homedir(), ".nax", "runs"),
```

`runs.ts`:
```ts
getRunsDir: () => join(homedir(), ".nax", "runs"),
```

**`runs.ts` is missing the env var override.** Fix: make both use the same logic. Extract to `src/utils/paths.ts`:

```ts
export function getRunsDir(): string {
  return process.env.NAX_RUNS_DIR ?? join(homedir(), ".nax", "runs");
}
```

### Phase 6 (optional): Consolidate `getAgent` and `adapter` deps

These 7 `getAgent` and 3 `adapter: new ClaudeCodeAdapter()` instances are **not boilerplate** — they're intentional DI seams with different call-site contexts. Leave them as-is unless a shared pattern emerges naturally.

---

## Execution Order

1. Phase 1 (bun-deps module) — foundation, no existing code changes
2. Phase 5 (getRunsDir bug) — small, independent fix
3. Phase 2 (agent adapters) — biggest win, ~165 lines
4. Phase 3 (other Bun primitives) — ~50 lines
5. Phase 4 (rename bare `_deps`) — touches test imports, do last
6. Phase 6 — skip unless motivated

Phases 1–3 can be one commit. Phase 4 is a separate commit (test file churn). Phase 5 is an independent fix (could be its own PR).

## Risks

- **Test breakage from import renames (Phase 4):** Tests import `_deps` by name. Renaming requires updating test imports. Mitigated by: grep + find-replace, run full suite after.
- **Type narrowing:** Some test mocks rely on the exact inline type shape. The shared `SpawnResult` type is a superset — should be compatible. Verify with `bun run typecheck`.

## Validation

- `bun run typecheck` — clean
- `bun test --bail` — 4349 pass, 60 skip, 0 fail
- `bun run lint` — clean
- Verify no `Bun.spawn` / `Bun.which` / `Bun.sleep` appears directly in any `_*Deps` object (grep check)
