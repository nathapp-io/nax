# Test Writing Rules

## Mocking

### Never use `mock.module()`

`mock.module()` in Bun 1.x is **globally scoped and leaks between test files**. It poisons the ESM module registry for the entire test run. `mock.restore()` does NOT undo `mock.module()` overrides.

**Instead, use dependency injection:**

```typescript
// In source file: export a swappable deps object
export const _deps = {
  readConfig: () => loadConfig(),
  runCommand: (cmd: string) => Bun.spawn(cmd.split(" ")),
};

// In test file: override _deps directly
import { _deps } from "src/mymodule";

beforeEach(() => {
  _deps.readConfig = mock(() => fakeConfig);
});

afterEach(() => {
  mock.restore(); // restores mock() spies (NOT mock.module)
  _deps.readConfig = originalReadConfig;
});
```

### General Mocking Rules

- Always call `mock.restore()` in `afterEach()`.
- Use `mock()` (function-level) freely — it's properly scoped.
- Never rely on test file execution order. Each file must be independently runnable.
- Store original function references before overriding `_deps` and restore in `afterEach`.

## CI Compatibility

- Tests requiring the `claude` binary: guard with `const skipInCI = process.env.CI ? test.skip : test;`
- Tests requiring specific OS features: guard with platform checks.
- Never send real signals (`process.kill`) — mock `process.on()` instead.

## Spawning & Subprocesses

- Never spawn full `nax` processes in tests — prechecks fail in temp dirs.
- Wrap `Bun.spawn()` in try/catch — throws `ENOENT` for missing binaries (not a failed exit code).

### Never mutate `Bun.spawn` globally

`Bun.spawn` is a **global shared reference**. Mutating it directly (`Bun.spawn = mock(...)`) leaks between test files when they run in the same process.

**Use the module's injectable `_deps` object instead:**

```typescript
// ❌ WRONG — leaks to other files
Bun.spawn = mock((cmd) => fakeResult);

// ✅ CORRECT — scoped to this module only
import { _isolationDeps } from "../../../src/tdd/isolation";

let orig: typeof _isolationDeps.spawn;
beforeEach(() => { orig = _isolationDeps.spawn; _isolationDeps.spawn = mock(...); });
afterEach(() => { _isolationDeps.spawn = orig; });
```

**Injectable deps available in nax source:**

| Module | Deps export | Covers |
|:---|:---|:---|
| `src/tdd/isolation.ts` | `_isolationDeps.spawn` | `git diff` in `getChangedFiles` |
| `src/tdd/cleanup.ts` | `_cleanupDeps.spawn/sleep/kill` | `ps`, `Bun.sleep`, `process.kill` in `cleanupProcessTree` |
| `src/tdd/session-runner.ts` | `_sessionRunnerDeps.spawn/getChangedFiles/verifyTestWriterIsolation/verifyImplementerIsolation/captureGitRef/cleanupProcessTree/buildPrompt` | All session runner dependencies |
| `src/tdd/rectification-gate.ts` | `_rectificationGateDeps.executeWithTimeout/parseBunTestOutput/shouldRetryRectification` | Gate logic |
| `src/utils/git.ts` | `_gitDeps.spawn` | All git commands |
| `src/verification/executor.ts` | `_executorDeps.spawn` | Shell test command execution |
| `src/verification/strategies/acceptance.ts` | `_acceptanceDeps.spawn` | Acceptance test runner |

For orchestrator/multi-module tests, use the shared helper:
```typescript
import { saveDeps, restoreDeps, mockGitSpawn, mockAllSpawn } from "./_tdd-test-helpers";
```

## File System Operations in Tests

### Never use `Bun.spawn` for shell utilities — use `fs.*` directly

Using `Bun.spawn(["mv", ...])`, `Bun.spawn(["rm", ...])`, or `Bun.spawn(["mkdir", ...])` in tests spawns real OS processes. Under CI load, cold-start overhead causes 15s+ timeouts and flakiness.

**Use Node/Bun fs APIs instead — they are synchronous or properly awaitable:**

```typescript
// ❌ WRONG — spawns a process, timing-sensitive
await Bun.spawn(["mv", src, dest], { stdout: "pipe" }).exited;
await Bun.spawn(["rm", "-rf", dir], { stdout: "pipe" }).exited;
await Bun.spawn(["mkdir", "-p", dir], { stdout: "pipe" }).exited;

// ✅ CORRECT — direct fs call, no process overhead
import { rename, rm, mkdir } from "node:fs/promises";
await rename(src, dest);
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
```

### Never use `Bun.sleep()` in tests — use awaitable writes or polling

`Bun.sleep(N)` is a fixed-duration wait. Under CI load, N ms may not be enough for async writes to complete. The right fix is to make the write awaitable or poll for the result.

```typescript
// ❌ WRONG — timing-sensitive, flaky under load
bus.emit({ type: "run:started", ... });
await Bun.sleep(50);
const meta = JSON.parse(await readFile(metaFile, "utf8"));

// ✅ CORRECT — poll with a cap
import { waitForFile } from "../../helpers/fs";
bus.emit({ type: "run:started", ... });
await waitForFile(metaFile, 500); // polls every 10ms, up to 500ms
const meta = JSON.parse(await readFile(metaFile, "utf8"));
```

Add `waitForFile` to `test/helpers/fs.ts` if not present:
```typescript
export async function waitForFile(path: string, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`waitForFile: ${path} not created within ${timeoutMs}ms`);
}
```

## Test Structure

- One `describe()` block per source function or class being tested.
- Keep test files under 400 lines. Split by `describe()` block if needed.
- Use `test/helpers/` for shared mock factories and fixtures. Don't copy-paste mocking setup between files.

## Imports

- **Import from barrels** (`src/routing`), not internal paths (`src/routing/router`).
- This matches the project convention and prevents Bun singleton fragmentation where the same module loaded via two different paths creates two separate instances.
