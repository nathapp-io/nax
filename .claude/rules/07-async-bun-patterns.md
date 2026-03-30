# Async & Bun Patterns

Project-specific async and Bun-native patterns for nax.

## Bun.spawn Exit Handling

**Always** await `.exited` on Bun.spawn processes:

```typescript
// ✅ Correct — simple await
const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
const exitCode = await proc.exited;

// ✅ Also correct — timeout enforcement via Promise.race
const exitCode = await Promise.race([
  proc.exited,
  new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
]);
// Always .catch(() => {}) the losing promise to avoid unhandled rejections
```

## Concurrent Output Draining

When capturing stdout/stderr, drain concurrently to avoid deadlock:

```typescript
// ✅ Correct — concurrent drain
const [exitCode, stdout, stderr] = await Promise.all([
  proc.exited,
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
]);

// ❌ Wrong — sequential can deadlock if stderr fills buffer
const exitCode = await proc.exited;
const stdout = await new Response(proc.stdout).text();
const stderr = await new Response(proc.stderr).text();
```

## Exit Code Checking

Check exit codes explicitly — zero ≠ success only if the command defines it:

```typescript
const exitCode = await proc.exited;
if (exitCode !== 0) {
  const stderr = await new Response(proc.stderr).text();
  throw new Error(`[execution] Command failed with exit ${exitCode}: ${stderr}`);
}
```

## Bun.sleep for Delays

Use `Bun.sleep()` for simple delays. **Exception:** `Bun.sleep()` is uncancellable — use `setTimeout` when cancellation is needed (e.g., `Promise.race` timeout patterns).

```typescript
// ✅ Simple delay
await Bun.sleep(1000);

// ✅ Cancellable timeout (setTimeout is correct here)
const timer = setTimeout(() => reject(new Error("timeout")), 5000);
// ... on success: clearTimeout(timer)

// ❌ Wrong — setTimeout for simple delay
await new Promise((resolve) => setTimeout(resolve, 1000));
```

## Bun-native File APIs

Use Bun's file APIs throughout — no Node.js equivalents:

| ❌ Forbidden | ✅ Use Instead |
|:-------------|:---------------|
| `fs.readFileSync` | `Bun.file()` + `.text()` / `.json()` |
| `fs.writeFileSync` | `Bun.write()` |
| `fs.readFile` | `Bun.file().text()` |
| `fs.writeFile` | `Bun.write()` |
| `child_process.spawn` | `Bun.spawn()` |
| `child_process.spawnSync` | `Bun.spawnSync()` |

```typescript
// ✅ Correct — read
const content = await Bun.file("config.json").text();
const json = await Bun.file("config.json").json();

// ✅ Correct — write
await Bun.write("output.json", JSON.stringify(data));
```

## Bun.spawn Options

Use `stdout: "pipe"` and `stderr: "pipe"` when you need to capture output:

```typescript
const proc = Bun.spawn(
  ["git", "diff", "--staged"],
  {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  }
);
```

Use `stdout: "inherit"` when you want output to flow to the terminal:

```typescript
const proc = Bun.spawn(
  ["git", "status"],
  { stdout: "inherit", stderr: "inherit" }
);
```

## Process Lifecycle

Always ensure processes are awaited or explicitly discarded:

```typescript
// ✅ Correct — explicitly await exit
await proc.exited;

// ✅ Correct — discard with void
void proc.exited; // fire-and-forget background process
```

## Promise.race Safety

When using `Promise.race` with timeouts, ensure the winning path cleans up the loser:

```typescript
const timeout = Bun.sleep(5000);
const work = doSomething();

const result = await Promise.race([work, timeout]);
if (result === undefined) {
  // timeout won — work is still running in background
  // ensure it doesn't cause resource leaks
}
```

## Globals & Environment

Prefer Bun-native globals where available:
- `global` → use `globalThis`
- `Buffer` → prefer `Uint8Array` or `btoa/atob`

For environment variables, both `process.env` and `Bun.env` work (they are aliases in Bun). Existing code uses `process.env` — no need to migrate. Prefer `Bun.env` in new code for consistency.

```typescript
// ✅ Both are fine
const apiKey = Bun.env.OPENAI_API_KEY;
const apiKey = process.env.OPENAI_API_KEY;
```
