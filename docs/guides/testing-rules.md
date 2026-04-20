# Testing Rules

**This is the single source of truth for test writing rules in nax.**

All agents (Claude Code, Codex, Gemini CLI, etc.) and human contributors must follow these rules.
Pointers to this file live in `AGENTS.md`, `CONTRIBUTING.md`, and `.claude/rules/test-writing.md`.

---

## 1. Mock Discipline

### Never use `mock.module()`

`mock.module()` in Bun 1.x is globally scoped and leaks between test files. It poisons the ESM module registry for the entire test run. `mock.restore()` does NOT undo it.

**Use dependency injection (`_deps` pattern) instead:**

```typescript
// In source file:
export const _myModuleDeps = {
  readConfig: () => loadConfig(),
  spawn: Bun.spawn,
};

// In test file:
import { _myModuleDeps } from "src/mymodule";

let origReadConfig: typeof _myModuleDeps.readConfig;
beforeEach(() => {
  origReadConfig = _myModuleDeps.readConfig;
  _myModuleDeps.readConfig = mock(() => fakeConfig);
});
afterEach(() => {
  _myModuleDeps.readConfig = origReadConfig;
  mock.restore();
});
```

### Always `mock.restore()` in `afterEach`

Every test file that uses `mock()` must call `mock.restore()` in `afterEach`. This resets function-level spies (does NOT affect `mock.module()` or `_deps` overrides — those need manual restoration).

### Never rely on test file execution order

Each test file must be independently runnable. Never assume another file ran first or set up shared state.

---

## 2. Subprocess Rules

### Never spawn `nax` processes in tests

`nax run` in a temp dir fails prechecks. Use direct function imports instead of `bun run bin/nax.ts <cmd>`.

```typescript
// ❌ WRONG — spawns subprocess, cold-start delay, fails prechecks
const proc = Bun.spawn(["bun", "run", "bin/nax.ts", "logs", "--feature", "foo"]);

// ✅ CORRECT — direct call, instant
import { logsCommand } from "../../../src/cli/logs";
await logsCommand({ feature: "foo" });
```

### Never mutate `Bun.spawn` globally

`Bun.spawn` is a global shared reference. Mutating it directly leaks between test files.

```typescript
// ❌ WRONG — leaks globally
(Bun as any).spawn = mock((cmd) => fakeResult);

// ✅ CORRECT — use the module's _deps object
import { _myModuleDeps } from "../../../src/mymodule";
let orig: typeof _myModuleDeps.spawn;
beforeEach(() => { orig = _myModuleDeps.spawn; _myModuleDeps.spawn = mock(...); });
afterEach(() => { _myModuleDeps.spawn = orig; });
```

### Never use `Bun.spawn` for OS shell utilities in tests

`Bun.spawn(["mv", ...])`, `Bun.spawn(["rm", ...])`, `Bun.spawn(["mkdir", ...])` spawn real processes. Under CI load, cold-start overhead causes 15s+ timeouts and flakiness.

**Use `node:fs/promises` APIs instead:**

```typescript
// ❌ WRONG
await Bun.spawn(["mv", src, dest], { stdout: "pipe" }).exited;
await Bun.spawn(["rm", "-rf", dir], { stdout: "pipe" }).exited;
await Bun.spawn(["mkdir", "-p", dir], { stdout: "pipe" }).exited;

// ✅ CORRECT
import { rename, rm, mkdir } from "node:fs/promises";
await rename(src, dest);
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
```

---

## 3. Timing Rules

### Never use `Bun.sleep()` in tests

Fixed-duration waits are timing-sensitive and flaky under CI load. Use polling or make the operation awaitable.

```typescript
// ❌ WRONG — may not be enough time under load
bus.emit({ type: "run:started", ... });
await Bun.sleep(50);
const meta = JSON.parse(await readFile(metaFile, "utf8"));

// ✅ CORRECT — poll with a cap
import { waitForFile } from "../../helpers/fs";
bus.emit({ type: "run:started", ... });
await waitForFile(metaFile, 500);
const meta = JSON.parse(await readFile(metaFile, "utf8"));
```

`waitForFile` lives in `test/helpers/fs.ts`:

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

### Never bump timeouts to fix flaky tests

If a test is timing-sensitive, fix the design. `--timeout=60000` on the CLI is for the full suite; individual tests should complete in milliseconds.

---

## 4. Hermetic Tests

Tests must never reach real external systems. Mock all I/O boundaries:

| Boundary | Mock strategy |
|:---------|:--------------|
| `Bun.spawn` / `execSync` | Use `_deps` injection |
| HTTP / gRPC | Mock the client or use a test server |
| File system outside temp dir | Use `mkdtemp` or `/tmp/nax-test-*` |
| Claude / acpx CLI | Guard with `process.env.CI ? test.skip : test` |
| Database / cache | Use in-memory mock (e.g. `ioredis-mock`) |

Project-level hermetic config lives in `.nax/config.json`:

```json
{
  "quality": {
    "testing": {
      "hermetic": true,
      "externalBoundaries": ["claude", "acpx"],
      "mockGuidance": "Use injectable _deps for CLI spawning"
    }
  }
}
```

---

## 5. CI Guards

```typescript
// Tests requiring the claude binary:
const skipInCI = process.env.CI ? test.skip : test;
skipInCI("runs real claude session", async () => { ... });

// Tests requiring specific OS features:
const skipOnLinux = process.platform === "linux" ? test.skip : test;
```

Never send real signals in tests — mock `process.on()` instead.

---

## 6. Test Structure

- **One `describe()` per source function or class** being tested
- **Target test files ≤ 400 lines** — split by `describe()` block when practical
- **Use `test/helpers/`** for shared mock factories and fixtures — no copy-paste setup
- **Use `test.each()`** for parametric tests (multiple inputs, same logic)
- **Descriptive names** — `"returns null when config is missing"` not `"test 3"`
- **Independent files** — each file must pass when run in isolation

### File size limits

| Limit | Lines | Action |
|:------|:------|:-------|
| Soft | 500 | Warning |
| Hard | 800 | Build fails |

Run `bun run check:test-sizes` to check.

---

## 7. Imports

Import from barrel files (`src/routing`), not internal paths (`src/routing/router`). This prevents Bun singleton fragmentation where the same module loaded via two paths creates two separate instances.

---

## 8. Git Integration Tests

Tests calling `git commit` in temp dirs need global git config. Set up in `beforeEach`:

```typescript
execSync('git config user.name "Test"', { cwd: tmpDir });
execSync('git config user.email "test@test.com"', { cwd: tmpDir });
```

## 9. Temporary Directory Pattern

All tests that need a temporary directory **must** use the standardized helper from `test/helpers/temp.ts`. Never create temp directories manually in test files or use `import.meta.dir`-relative paths.

### Use `makeTempDir()` + `cleanupTempDir()` (sync, for `beforeEach`/`afterEach`)

```typescript
import { cleanupTempDir, makeTempDir } from "../helpers/temp";

let tempDir: string;

beforeEach(() => {
  tempDir = makeTempDir("nax-my-test-");
  // mkdirSync(join(tempDir, ".nax"), { recursive: true }); // if needed
});

afterEach(() => {
  cleanupTempDir(tempDir);
});
```

### Use `withTempDir()` (async, for inline callback)

```typescript
import { withTempDir } from "../helpers/temp";

test("writes output file", async () => {
  await withTempDir(async (dir) => {
    await Bun.write(join(dir, "file.txt"), "content");
    expect(existsSync(join(dir, "file.txt"))).toBe(true);
  });
  // auto-cleaned up
});
```

### Why not `os.tmpdir()` directly in test files?

- Direct `mkdtempSync(join(tmpdir(), "nax-test-"))` in every test scatters temp dirs and makes cleanup easy to forget
- `import.meta.dir`-relative `.tmp/` paths break on machines where the repo parent is not writable (EACCES)
- The helper centralizes cleanup and guarantees `os.tmpdir()` portability across all environments

### Never hard-code `.nax` subdirectory creation

If your test writes to `<tempDir>/.nax/config.json`, you **must** explicitly create the `.nax` subdirectory:

```typescript
// ✅ CORRECT — explicit subdirectory
tempDir = makeTempDir("nax-config-test-");
mkdirSync(join(tempDir, ".nax"), { recursive: true });

// ❌ WRONG — makeTempDir only creates the root temp directory
tempDir = makeTempDir("nax-config-test-");
// .nax/ does NOT exist — writeFileSync to .nax/config.json will ENOENT
```

## 10. Config Schema Coverage Rule

**When adding a new top-level field to `NaxConfig` (in `src/config/runtime-types.ts`):**

1. **Add a Zod schema** in `src/config/schemas.ts` and wire it into `NaxConfigSchema`
2. **Add the field to `MAXIMAL_CONFIG`** in `test/unit/config/schema-coverage.test.ts` with a valid fixture value
3. **Assert it survives `safeParse`** in the coverage test (add an `expect(data.newField).toBeDefined()` line)
4. **Add the key** to `EXPECTED_KEYS` in the shape-coverage test

### Why

Zod's `safeParse` strips unknown keys by default. A TypeScript interface field that has no matching Zod schema silently disappears from the loaded config at runtime — no error, no warning, just `undefined`. This pattern caused `config.generate.agents` to be always `undefined` (fixed in PR #117).

### Quick checklist

```
[ ] runtime-types.ts — added interface field
[ ] schemas.ts       — added Zod schema + wired into NaxConfigSchema
[ ] schema-coverage.test.ts — MAXIMAL_CONFIG updated, assertion added, EXPECTED_KEYS updated
[ ] test passes: bun test test/unit/config/schema-coverage.test.ts
```
