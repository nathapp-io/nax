# Coding Standards — nax

> §5–§10: Functions, async patterns, type safety, testing, logging, git.
> Part of the [Architecture Documentation](ARCHITECTURE.md).

---

## 5. Function Design

### Size Limits

- **Target:** ≤30 lines per function
- **Hard limit:** 50 lines — anything longer must be split
- **Extract helpers** as private functions in the same file

### Principles

```typescript
// ✅ Small, focused functions
async function resolveAdapter(config: NaxConfig): Promise<AgentAdapter> {
  const agentName = config.execution?.agent ?? "claude";
  const adapter = getAgent(agentName);
  if (!adapter) {
    throw new Error(`[routing] Unknown agent: ${agentName}`);
  }
  return adapter;
}

// ❌ God function doing everything
async function routeAndExecuteAndVerify(ctx: PipelineContext): Promise<void> {
  // 200 lines of mixed concerns...
}
```

### Parameter Style

- **≤3 params:** positional is fine
- **>3 params:** use an options object

```typescript
// ✅ Options object for many params
interface RunOptions {
  workdir: string;
  prompt: string;
  modelTier: string;
  timeoutSeconds: number;
}
async function run(options: RunOptions): Promise<AgentResult> { ... }

// ❌ Too many positional params
async function run(workdir: string, prompt: string, tier: string, timeout: number): Promise<AgentResult> { ... }
```

---

## 6. Async Patterns (Bun-Specific)

### Process Spawning

**Always read stdout/stderr concurrently with `proc.exited`:**

```typescript
// ✅ Concurrent — no deadlock
const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
const [exitCode, stdout, stderr] = await Promise.all([
  proc.exited,
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
]);

// ❌ Sequential — deadlocks on >64KB output
const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
const exitCode = await proc.exited;
const stdout = await new Response(proc.stdout).text(); // hangs!
```

### Stream Cancellation

**Use `cancellableDelay(ms, signal?)` from `src/utils/bun-deps.ts`** — don't roll the `setTimeout + AbortController` pattern inline.

```typescript
import { cancellableDelay } from "../utils/bun-deps";

// ✅ Canonical cancellable delay — drop-in for Bun.sleep with optional abort
const controller = new AbortController();
await cancellableDelay(5000, controller.signal); // rejects on abort

// ✅ Without a signal, behaves identically to Bun.sleep(ms)
await cancellableDelay(5000);

// ❌ Cannot cancel Bun.sleep()
await Bun.sleep(5000); // blocks for full 5s even if no longer needed

// ❌ Don't re-roll the pattern at every call site
const delay = new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  controller.signal.addEventListener("abort", () => clearTimeout(timer));
});
```

Reach for `cancellableDelay` at any site that:
- Runs inside a retry/backoff loop and should respect aborts (rate-limit backoff, reconnect loops).
- Has access to an `AbortSignal` today, or is likely to receive one via future plumbing.

Use plain `Bun.sleep()` (or `_deps.sleep` in tests) only for short uninterruptible pauses where cancellation is neither possible nor meaningful — intra-tick yields, brief polling delays with no caller signal.

### Promise.race Safety

```typescript
// ✅ Always .catch() the losing promise
const result = await Promise.race([
  actualWork(),
  timeout(30_000).then(() => { throw new Error("timeout"); }),
]);
// The losing promise's rejection must be caught

// ❌ Unhandled rejection from losing promise
const result = await Promise.race([actualWork(), timeout(30_000)]);
```

### Batch Over Loop

```typescript
// ✅ Concurrent
const results = await Promise.all(items.map((item) => processItem(item)));

// ❌ Sequential when not needed
for (const item of items) {
  await processItem(item); // one at a time
}
```

---

## 7. Type Safety

### Rules

- **No `any` in public APIs** — use `unknown` + type guards instead
- **Explicit return types** on all exported functions
- **Discriminated unions** over string enums for state machines

```typescript
// ✅ Discriminated union
type StageResult =
  | { action: "continue"; data: RoutingResult }
  | { action: "skip"; reason: string }
  | { action: "abort"; error: Error };

// ❌ Stringly-typed
interface StageResult {
  action: string; // "continue" | "skip" | "abort" — easy to typo
  data?: unknown;
}
```

### Type Guards

```typescript
// ✅ Type guard for runtime validation
function isAgentResult(value: unknown): value is AgentResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "success" in value &&
    "exitCode" in value
  );
}
```

### `satisfies` for Config Objects

```typescript
// ✅ Type-checked but inferred
const DEFAULT_CONFIG = {
  timeout: 60_000,
  retries: 3,
  bail: true,
} satisfies Partial<ExecutionConfig>;
```

---

## 8. Testing Patterns

### Structure

```
test/
├── unit/        # Pure logic, mocked deps, fast (<1s per file)
├── integration/ # Multiple modules wired together, may use fs
└── e2e/         # Full pipeline, slower
```

### Conventions

- **One `describe` per exported function** being tested
- **Test names start with what it does**, not "should"
- **Use `test.each()`** for parametric tests (3+ similar cases)

```typescript
// ✅ Descriptive test names
test("returns null when verdict file is missing", async () => { ... });
test("coerces free-form 'PASS' string to approved: true", () => { ... });

// ❌ Vague names
test("should work", () => { ... });
test("handles edge case", () => { ... });
```

### Mocking via `_deps`

```typescript
// ✅ Injectable deps — clean, isolated
const origDeps = { ..._moduleDeps };
afterEach(() => Object.assign(_moduleDeps, origDeps));

test("handles spawn failure", async () => {
  _moduleDeps.spawn = () => { throw new Error("spawn failed"); };
  // ...
});

// ❌ Global monkey-patching
test("handles spawn failure", async () => {
  const origSpawn = Bun.spawn;
  Bun.spawn = () => { throw new Error("spawn failed"); };
  // ... fragile, affects other tests
});
```

### Table-Driven Tests

```typescript
// ✅ test.each for repeated patterns
test.each([
  { input: "PASS", expected: true },
  { input: "APPROVED", expected: true },
  { input: "FAIL", expected: false },
  { input: "REJECTED", expected: false },
])("coerces '$input' to approved: $expected", ({ input, expected }) => {
  const result = coerceVerdict({ verdict: input });
  expect(result?.approved).toBe(expected);
});

// ❌ Copy-paste tests differing by one param
test("coerces PASS", () => { ... });
test("coerces APPROVED", () => { ... });
test("coerces FAIL", () => { ... });
// Same logic, repeated 4x
```

---

## 9. Logging

### Structured JSONL

All runtime logging goes through the structured logger:

```typescript
import { getLogger } from "../logger";

const logger = getLogger();
logger?.info("routing", "Task classified", {
  storyId: story.id,
  complexity: result.complexity,
  modelTier: result.modelTier,
});
```

### Rules

- **Stage prefix** is the first param — matches pipeline stage names
- **Message** is human-readable, present tense
- **Data** is a flat object — no nested structures deeper than 1 level
- **Never log secrets** — no API keys, tokens, or full prompts
- **Log at appropriate levels:**
  - `debug` — internal state, decision details
  - `info` — stage transitions, story lifecycle events
  - `warn` — recoverable issues, fallbacks
  - `error` — failures that affect story outcome

---

## 10. Git & Commits

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add Gemini CLI adapter with auth detection
fix: routing stage crash when config.execution is undefined
refactor: extract autoCommitIfDirty to shared utility
test: add table-driven tests for verdict coercion
chore: bump version to 0.36.0 [run-release]
```

### Rules

- **One concern per commit** — don't mix features with bug fixes
- **Reference story ID** when applicable: `feat(MA-003): Gemini adapter`
- **Never force push** to `master`
- **Feature branches:** `feat/<name>`, merged via MR
