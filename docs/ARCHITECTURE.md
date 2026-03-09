# ARCHITECTURE.md — nax Coding Standards & Patterns

> **Purpose:** Single source of truth for code patterns in the nax codebase.
> All contributors (human and AI agent) must follow these patterns.
> This file is injected into agent context during `nax run`.

---

## 1. File Structure

### Layout

```
src/
├── agents/           # Agent adapters (claude, codex, gemini, aider, opencode)
│   ├── adapters/     # Non-Claude adapters
│   ├── claude.ts     # Claude Code adapter (primary)
│   ├── registry.ts   # Agent discovery and lookup
│   └── types.ts      # AgentAdapter interface, AgentResult, AgentRunOptions
├── cli/              # CLI command handlers
├── commands/         # Subcommand implementations (logs, runs, agents)
├── config/           # Configuration loading, schemas, types
├── context/          # Context generation for agent prompts
├── execution/        # Run orchestration (sequential, parallel, crash recovery)
├── interaction/      # Human-in-the-loop plugins (telegram, auto, webhook)
├── logging/          # Structured JSONL logger
├── pipeline/         # Pipeline engine (stages, subscribers, runner)
│   ├── stages/       # Individual pipeline stages (routing, execution, verify, etc.)
│   └── subscribers/  # Event subscribers (reporters, interaction)
├── plugins/          # Plugin system (loader, validator, types)
├── precheck/         # Pre-run validation checks
├── prd/              # PRD parsing, story management
├── prompts/          # Prompt building (sections, templates)
├── review/           # Code review integration
├── routing/          # Complexity classification strategies
├── tdd/              # TDD orchestration, verification, verdict parsing
├── utils/            # Shared utilities
└── verification/     # Test execution and result parsing
```

### Rules

- **400-line hard limit** per file — split before exceeding
- **Barrel exports:** every directory with 2+ files gets an `index.ts`
- **File naming:** `kebab-case.ts` for files, `PascalCase` for classes/interfaces
- **One primary export per file** — avoid files with 5+ unrelated exports

---

## 2. Dependency Injection (`_deps` Pattern)

### Pattern

Every module that calls external services (process spawning, file I/O, network) must expose an injectable `_deps` object:

```typescript
// ✅ Correct: injectable, testable
export const _myModuleDeps = {
  which(name: string): string | null {
    return Bun.which(name);
  },
  spawn(
    cmd: string[],
    opts: { stdout: "pipe"; stderr: "pipe" | "inherit" },
  ): { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; pid: number } {
    return Bun.spawn(cmd, opts) as any;
  },
};

// In the function:
export async function myFunction(): Promise<Result> {
  const path = _myModuleDeps.which("tool");
  // ...
}
```

```typescript
// ❌ Wrong: direct calls, not testable without monkey-patching
export async function myFunction(): Promise<Result> {
  const path = Bun.which("tool");
  // ...
}
```

### Test Usage

```typescript
import { _myModuleDeps } from "../../src/my-module";

const origDeps = { ..._myModuleDeps };

afterEach(() => {
  Object.assign(_myModuleDeps, origDeps);
});

test("handles missing binary", async () => {
  _myModuleDeps.which = () => null;
  // ...
});
```

### When to Use `_deps`

| Scenario | Use `_deps`? |
|:---------|:-------------|
| `Bun.spawn()`, `Bun.which()` | ✅ Always |
| File reads (`Bun.file()`, `readdir`) | ✅ Always |
| Network calls (`fetch`) | ✅ Always |
| Pure computation, string manipulation | ❌ No |
| Calling other nax modules | ❌ No (mock at boundary) |

### Reference Files

- `src/pipeline/stages/routing.ts` — `_routingDeps`
- `src/agents/adapters/gemini.ts` — `_geminiRunDeps`, `_geminiCompleteDeps`
- `src/agents/adapters/codex.ts` — `_codexCompleteDeps`

---

## 3. Error Handling

### Current Pattern (Transitional)

Until `NaxError` class is introduced (v0.38.0), follow these rules:

```typescript
// ✅ Descriptive message with context
throw new Error(`[routing] LLM strategy failed for story ${story.id}: ${err.message}`);

// ✅ Include stage prefix in brackets
throw new Error(`[verify] Test command timed out after ${timeoutMs}ms`);

// ❌ Vague message
throw new Error("Something went wrong");

// ❌ No context
throw new Error("Failed");
```

### Rules

1. **Always include stage prefix** in error messages: `[routing]`, `[verify]`, `[execution]`
2. **Include identifiers** — story ID, file path, command that failed
3. **Wrap external errors** — catch and re-throw with context, preserving original as `cause`
4. **Never swallow errors silently** — at minimum, log them

```typescript
// ✅ Wrapping external errors
try {
  await externalCall();
} catch (err) {
  throw new Error(`[execution] Agent spawn failed for ${storyId}`, { cause: err });
}

// ❌ Swallowing
try {
  await externalCall();
} catch {
  // silently ignored
}
```

### Future: NaxError (v0.38.0)

```typescript
// Target pattern — not yet implemented
throw new NaxError("ROUTING_LLM_FAILED", {
  stage: "routing",
  storyId: story.id,
  cause: err,
});
```

---

## 4. Constants

### Rules

- **No magic numbers** in function bodies
- **File-level `const`** for single-file constants
- **`src/constants.ts`** for values shared across 2+ files
- **Naming:** `UPPER_SNAKE_CASE`

```typescript
// ✅ Named constant at file level
const MAX_AGENT_OUTPUT_CHARS = 5_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RETRY_ATTEMPTS = 3;

// ❌ Magic number in function body
if (output.length > 5000) { ... }
```

### Numeric Literals

Use `_` separators for readability:

```typescript
// ✅ Readable
const MAX_CONTEXT_TOKENS = 1_000_000;
const TIMEOUT_MS = 60_000;

// ❌ Hard to read
const MAX_CONTEXT_TOKENS = 1000000;
```

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

```typescript
// ✅ Bun.sleep() is uncancellable — use setTimeout for cancellable delays
const controller = new AbortController();
const delay = new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  controller.signal.addEventListener("abort", () => clearTimeout(timer));
});

// ❌ Cannot cancel Bun.sleep()
await Bun.sleep(5000); // blocks for full 5s even if no longer needed
```

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

---

## Quick Reference Card

| Rule | Limit |
|:-----|:------|
| File size | ≤400 lines |
| Function size | ≤30 lines (50 hard max) |
| Positional params | ≤3 (use options object beyond) |
| Test file size | ≤500 lines (800 hard max) |
| `any` in public API | Forbidden |
| Magic numbers | Forbidden (use named constants) |
| `_deps` for externals | Required |
| Error messages | Must include `[stage]` prefix + context |

---

*Created: 2026-03-10. Maintained by nax-dev.*
