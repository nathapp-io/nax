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

## Test Structure

- One `describe()` block per source function or class being tested.
- Keep test files under 400 lines. Split by `describe()` block if needed.
- Use `test/helpers/` for shared mock factories and fixtures. Don't copy-paste mocking setup between files.

## Imports

- **Import from barrels** (`src/routing`), not internal paths (`src/routing/router`).
- This matches the project convention and prevents Bun singleton fragmentation where the same module loaded via two different paths creates two separate instances.
