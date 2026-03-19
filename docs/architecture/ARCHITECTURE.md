# ARCHITECTURE.md — nax Coding Standards & Patterns

> **Purpose:** Single source of truth for code patterns in the nax codebase.
> All contributors (human and AI agent) must follow these patterns.
> This file is injected into agent context during `nax run`.

---

## 1. File Structure

### Layout

```
src/
├── agents/           # Agent adapters (CLI + ACP protocol modes)
│   ├── acp/          # ACP protocol adapter — multi-file (adapter, spawn-client, parser, cost, interaction-bridge)
│   ├── claude/       # Claude Code CLI adapter — multi-file (adapter, execution, complete, interactive, plan, cost)
│   ├── aider/        # Aider CLI adapter (adapter.ts)
│   ├── codex/        # Codex CLI adapter (adapter.ts)
│   ├── gemini/       # Gemini CLI adapter (adapter.ts)
│   ├── opencode/     # OpenCode CLI adapter (adapter.ts)
│   ├── shared/       # Cross-adapter utilities (decompose, model-resolution, validation, version-detection, types-extended)
│   ├── registry.ts   # Agent discovery, lookup, and protocol routing
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

- **File size limits (tiered):**

  | File type | Soft limit | Hard limit | When to split |
  |:----------|:-----------|:-----------|:--------------|
  | Source files (`src/`) | 300 lines | **400 lines** | Logic/control flow too complex for one file |
  | Test files (`test/`) | 500 lines | **800 lines** | >3 unrelated concerns in one file |
  | Type-only files (interfaces, no logic) | 500 lines | **600 lines** | Only if mixing types with logic |
  | Docs / generated reports | — | **No limit** | N/A |

  The goal is **cognitive fit** — can you understand the file in one reading? Type declarations and test assertions are low-complexity per line; business logic is high-complexity.

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

### ⚠️ Critical: Never Mutate Globals in Tests

**`Bun.spawn = mock(...)` is forbidden.** Bun runs test files sequentially in the same process. Mutating `Bun.spawn` directly — even with beforeEach/afterEach save-restore — is unreliable and causes cross-file contamination. **`mock.module()` is also forbidden** — it permanently replaces the module for the entire process lifetime and `mock.restore()` does NOT undo it.

```typescript
// ❌ WRONG — contaminates other test files
Bun.spawn = mock((cmd) => fakeResult);
mock.module("../src/isolation", () => ({ getChangedFiles: mock(...) }));

// ✅ CORRECT — scoped to the module's _deps object
import { _isolationDeps } from "../../../src/tdd/isolation";
let orig = _isolationDeps.spawn;
beforeEach(() => { _isolationDeps.spawn = mock(...); });
afterEach(() => { _isolationDeps.spawn = orig; });
```

This was the root cause of 38 test failures (March 2026) — fixed in commit `a110d6a`.

### Injectable `_deps` in TDD modules

| Module | Export | Covers |
|:---|:---|:---|
| `src/tdd/isolation.ts` | `_isolationDeps` | `git diff` → `getChangedFiles` |
| `src/tdd/cleanup.ts` | `_cleanupDeps` | `ps`, `Bun.sleep`, `process.kill` |
| `src/tdd/session-runner.ts` | `_sessionRunnerDeps` | isolation, git, cleanup, prompt deps |
| `src/tdd/rectification-gate.ts` | `_rectificationGateDeps` | `executeWithTimeout`, test output parsing |
| `src/utils/git.ts` | `_gitDeps` | All git commands |
| `src/verification/executor.ts` | `_executorDeps` | Shell test command execution |
| `src/verification/strategies/acceptance.ts` | `_acceptanceDeps` | Acceptance test runner |

### Reference Files

- `src/pipeline/stages/routing.ts` — `_routingDeps`
- `src/agents/adapters/gemini.ts` — `_geminiRunDeps`, `_geminiCompleteDeps`
- `test/integration/tdd/_tdd-test-helpers.ts` — shared helper for TDD orchestrator tests
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

## 11. Design Patterns

nax is primarily functional (~90% exported functions, ~10% classes). Use patterns only when they solve a real problem — not as default.

### When to Use a Pattern vs Plain Function

| Scenario | Use | Example |
|:---------|:----|:--------|
| Stateless transformation or computation | **Plain function** | `estimateTokens()`, `coerceVerdict()`, `buildStorySection()` |
| Single-use utility with no variants | **Plain function** | `loadConstitution()`, `runReview()`, `autoCommitIfDirty()` |
| Multi-step construction with optional config | **Builder** | `PromptBuilder`, `DecomposeBuilder` |
| Multiple backends sharing a contract | **Adapter** | `AgentAdapter` → Claude, Codex, Gemini |
| Collection with typed lookup/lifecycle | **Registry** | `PluginRegistry`, agent registry |
| Interchangeable algorithms for same task | **Strategy** | Verification strategies, routing strategies |
| Ordered handler dispatch with fallback | **Chain** | `InteractionChain`, `StrategyChain` |
| Global service with init-once semantics | **Singleton** | Logger |
| Stateful object managing resources (PIDs, connections) | **Class** | `PidRegistry`, `StatusWriter` |

**Rule: prefer plain functions.** Only introduce a class/pattern when you need state, multiple implementations, or complex construction. Never wrap a simple function in a class just to "follow patterns."

### Builder (Fluent API)

For multi-step object construction with optional configuration:

```typescript
// ✅ Static .for() entry point, method chaining, terminal .build()
const prompt = await PromptBuilder.for("implementer")
  .story(story)
  .constitution(constitutionContent)
  .context(contextMd)
  .build();

const result = await DecomposeBuilder.for(story)
  .prd(prd)
  .config(builderConfig)
  .decompose(adapter);
```

**Rules:**
- Entry point: `static for(...)` — returns new instance
- Each setter returns `this` for chaining
- Terminal method (`.build()`, `.decompose()`) produces the result
- Setters are optional — builder has sensible defaults

**Reference:** `src/prompts/builder.ts`, `src/decompose/builder.ts`

### Adapter (Interface + Implementations)

For extensible subsystems where multiple backends share a common contract:

```typescript
// ✅ Interface defines the contract
export interface AgentAdapter {
  name: string;
  capabilities: AgentCapabilities;
  run(options: AgentRunOptions): Promise<AgentResult>;
  complete(prompt: string, options?: CompleteOptions): Promise<string>;
  plan(options: PlanOptions): Promise<PlanResult>;
  decompose(options: DecomposeOptions): Promise<DecomposeResult>;
}

// ✅ Each backend implements it
export class ClaudeCodeAdapter implements AgentAdapter { ... }  // CLI mode (Bun.spawn)
export class AcpAgentAdapter implements AgentAdapter { ... }    // ACP mode (protocol)
```

**Rules:**
- Interface in `types.ts`, implementations in separate files
- Implementations are classes (stateful — may hold config, PID registries, etc.)
- Capabilities declared as data, not methods — enables routing decisions without instantiation

**Reference:** `src/agents/types.ts`, `src/agents/claude.ts`, `src/agents/acp/adapter.ts`

#### Agent Protocol Modes

nax supports two agent communication protocols, configured via `agent.protocol` in config:

| Mode | Config value | Adapter | Communication |
|:-----|:-------------|:--------|:--------------|
| CLI (default) | `"cli"` | `ClaudeCodeAdapter` | `Bun.spawn(["claude", "-p", ...])` → parse stdout |
| ACP | `"acp"` | `AcpAgentAdapter` | JSON-RPC over stdio via `AcpClient` from `acpx` |

The protocol toggle is transparent to all consumers — pipeline stages, routing, TDD, acceptance generators all call the same `AgentAdapter` interface methods.

#### LLM Fallback Rule

**Any code that needs LLM capabilities MUST resolve the default agent adapter — never use inline stubs.**

```typescript
// ✅ Correct: resolve the default agent adapter
import { getAgent } from "../agents/registry";

const agent = getAgent(config.autoMode.defaultAgent);
if (!agent) {
  throw new Error(`[stage] Agent "${config.autoMode.defaultAgent}" not found`);
}
// Use agent.complete() for one-shot LLM calls
const result = await agent.complete(prompt, { jsonMode: true });

// ✅ Correct: wrapping agent.complete() for domain-specific interfaces
const adapter = {
  async decompose(prompt: string): Promise<string> {
    return agent.complete(prompt, { jsonMode: true });
  },
};

// ❌ Wrong: inline stub that throws
const adapter = {
  async decompose(_prompt: string): Promise<string> {
    throw new Error("No LLM adapter configured");
  },
};

// ❌ Wrong: hardcoding a specific agent
import { ClaudeCodeAdapter } from "../agents/claude";
const adapter = new ClaudeCodeAdapter();
```

This pattern is **forward-compatible** with ACP: when `agent.protocol` switches from `"cli"` to `"acp"`, `getAgent()` returns `AcpAgentAdapter` whose `complete()` uses the ACP protocol — no calling code changes needed.

**Where this applies:**
- Pipeline stages needing LLM calls (routing decompose, classification)
- CLI commands (`nax analyze --decompose`)
- Acceptance test generation and refinement
- Any future feature that needs one-shot LLM completions

### Registry (Lookup + Discovery)

For collecting and retrieving instances by name or capability:

```typescript
// ✅ Registry wraps a collection with typed accessors
export class PluginRegistry {
  getReviewers(): IReviewPlugin[] { ... }
  getReporters(): IReporterPlugin[] { ... }
  getOptimizers(): IPromptOptimizer[] { ... }
}

// ✅ Function-based registry for simpler cases
export function getAgent(name: string): AgentAdapter | undefined { ... }
export function listAgents(): AgentAdapter[] { ... }
```

**Rules:**
- Class registry when it needs lifecycle (setup/teardown) — `PluginRegistry`
- Function registry when it's pure lookup — agent registry
- Never use Map/object directly in consumer code — wrap in typed accessor

**Reference:** `src/plugins/registry.ts`, `src/agents/registry.ts`

### Strategy (Pluggable Algorithms)

For subsystems with multiple interchangeable algorithms:

```typescript
// ✅ Interface defines the strategy contract
export interface IVerificationStrategy {
  verify(workdir: string, options: VerifyOptions): Promise<VerifyResult>;
}

// ✅ Each strategy is a class implementing the interface
export class ScopedStrategy implements IVerificationStrategy { ... }
export class RegressionStrategy implements IVerificationStrategy { ... }
export class AcceptanceStrategy implements IVerificationStrategy { ... }
```

**Rules:**
- Strategy interface in `types.ts`
- Selection logic outside the strategies (orchestrator or config-driven)
- Strategies are stateless when possible — receive all context via method params

**Reference:** `src/verification/strategies/`, `src/routing/strategies/`

### Chain (Priority-Ordered Pipeline)

For processing requests through prioritized handlers:

```typescript
// ✅ Register handlers with priority, first response wins
const chain = new InteractionChain({ defaultTimeout: 30_000, defaultFallback: "abort" });
chain.register(telegramPlugin, 10);  // highest priority
chain.register(autoPlugin, 50);      // fallback
const response = await chain.prompt(request);
```

**Rules:**
- Lower priority number = higher precedence
- Chain handles timeout and fallback — consumers don't
- Used for interaction (human-in-the-loop) and routing (strategy selection)

**Reference:** `src/interaction/chain.ts`, `src/routing/chain.ts`

### Singleton (Module-Level Instance)

For global services with one-time initialization:

```typescript
// ✅ Module-scoped instance with getter
let _instance: Logger | null = null;

export function initLogger(options: LoggerOptions): Logger {
  _instance = new Logger(options);
  return _instance;
}

export function getLogger(): Logger {
  if (!_instance) throw new Error("Logger not initialized");
  return _instance;
}

// ✅ Safe variant that returns null instead of throwing
export function getSafeLogger(): Logger | null {
  return _instance;
}
```

**Rules:**
- Use `getX()` / `getSafeX()` pattern — never export the instance directly
- `getSafeLogger()` preferred in library code (no crash if logger not yet initialized)
- Init once during startup (`run-setup.ts`), use everywhere via getter

**Reference:** `src/logger/logger.ts`

---

## 12. Security Standards

> Codified from code reviews on 2026-03-11 (security-review) and 2026-03-15 (deep code review).

### 12.1 Path & File Security

| Rule | Rationale |
|:-----|:----------|
| **Always `realpathSync()` before path containment checks** | Lexical `normalize()` does not follow symlinks — a symlink inside an allowed root can point anywhere (SEC-1 fix, 2026-03-15) |
| **Use `safeRealpath()` helper for non-existent paths** | Fall back to resolving the parent directory when the target doesn't exist yet |
| **`O_CREAT \| O_EXCL` for atomic lock creation** | Prevents TOCTOU race between check-and-create (BUG-2 fix) |
| **Use `fs.unlink()` for file deletion, never `Bun.spawn(["rm", ...])`** | Subprocess for a single syscall is ~1000x slower and adds unnecessary complexity (BUG-3 fix) |

### 12.2 Command Construction

| Rule | Rationale |
|:-----|:----------|
| **Always use argv arrays for subprocess spawning** | String interpolation enables argument injection |
| **Validate user-editable config values before interpolating into command strings** | Model names, paths, hook commands from config.json are user-controlled (SEC-2) |
| **Use `buildAllowedEnv()` for all spawned processes** | Never pass full `process.env` — prevents credential leakage to agent subprocesses |

### 12.3 Process & Handler Lifecycle

| Rule | Rationale |
|:-----|:----------|
| **Store named references for all `process.on()` handlers** | `removeListener` compares by reference — anonymous arrows create a new ref each time, making cleanup a silent no-op (BUG-1 fix) |
| **Track spawned PIDs via `PidRegistry`** | Enables cleanup on crash; register in `prompt()`, unregister on exit (v0.42.6 PidRegistry pattern) |
| **Never hardcode permission modes anywhere** | All permission decisions go through `resolvePermissions(config, stage)` — see §14. No `?? true`, `?? false`, or literal `"approve-all"` (SEC-3 fix, PERM-001) |
| **Kill active subprocess before graceful close** | `close()` and `cancelActivePrompt()` must kill `activeProc` first, then close the session |

### 12.4 Type Safety for Security

| Rule | Rationale |
|:-----|:----------|
| **Never `undefined as unknown as T`** | Lies to the type system — use `T \| null` and set `null` explicitly (BUG-2 fix) |
| **Validate JSON parse results with proper null typing** | Corrupt files should produce `null`, not unsafe casts that bypass guards |

---

## 13. Test Performance Patterns

> Codified from the slow-test optimization campaign (v0.41.0, 2026-03-14).
> Full suite went from ~4 min → ~2.5 min (4,087+ tests) by eliminating fixed sleeps.

### 13.1 Injectable Sleep Pattern

**Problem:** Production code uses `Bun.sleep()` or config-driven delays. Tests pay the real wall-clock cost.

**Solution:** Export `_moduleDeps.sleep` as an injectable, override with instant spy in tests.

```typescript
// ✅ Production code — injectable sleep
export const _myModuleDeps = {
  sleep: (ms: number) => Bun.sleep(ms),
};

async function retryWithBackoff() {
  await _myModuleDeps.sleep(2000); // 2s in prod
}

// ✅ Test — instant spy, assert correct values
const sleepCalls: number[] = [];
_myModuleDeps.sleep = async (ms: number) => { sleepCalls.push(ms); };

test("retries with exponential backoff", async () => {
  await retryWithBackoff();
  expect(sleepCalls).toEqual([2000, 4000]);  // assert timing, don't wait for it
});
```

**Applied in:** `claude.ts` (rate-limit retry: 6138ms → 9ms), `webhook.ts` (backoff: 757ms → 10ms), `runners.ts` (regression cleanup: 2s → 10ms)

### 13.2 Zero-Delay Config for Integration Tests

**Problem:** `DEFAULT_CONFIG.execution.iterationDelayMs = 2000` — every test calling `run()` sleeps 2s per iteration.

**Solution:** Define `TEST_CONFIG` with `iterationDelayMs: 0` at top of each integration test file.

```typescript
// ✅ Test config — zero delay
const TEST_CONFIG = {
  ...DEFAULT_CONFIG,
  execution: { ...DEFAULT_CONFIG.execution, iterationDelayMs: 0 },
};

// ❌ Don't use DEFAULT_CONFIG in tests — you'll sleep 2s per iteration
```

**Applied in:** `execution.test.ts` (12 tests: ~20s → 435ms), `cli-precheck.test.ts` (~2.7s → 50ms)

### 13.3 Shared `beforeAll` for Expensive Setup

**Problem:** Multiple tests in the same `describe` call the same expensive function (e.g., `scanCodebase()`) independently.

**Solution:** Run once in `beforeAll`, share the result across tests.

```typescript
// ✅ Shared expensive setup
describe("scanCodebase", () => {
  let result: ScanResult;
  beforeAll(async () => {
    result = await scanCodebase(workdir);  // 1 call, shared across 5 tests
  });

  test("finds TypeScript files", () => expect(result.files.length).toBeGreaterThan(0));
  test("respects gitignore", () => expect(result.files).not.toContainEqual(expect.stringContaining("node_modules")));
});

// ❌ Each test calls scanCodebase independently (10s × 5 = 50s)
```

**Applied in:** `scanner.ts` tests (7 tests: ~53s → 43ms)

### 13.4 Event-Driven Waits over Fixed Sleeps

**Problem:** Tests use `Bun.sleep(1000)` to wait for async side effects.

**Solution:** Wait for the actual event (first data chunk, file write, etc.) with a timeout fallback.

```typescript
// ✅ Event-driven wait
const firstChunk = new Promise<void>((resolve) => {
  stream.on("data", () => resolve());
  setTimeout(() => resolve(), 5000); // fallback
});
await firstChunk;

// ❌ Fixed sleep — wastes 1s or flakes if operation takes longer
await Bun.sleep(1000);
```

**Applied in:** `cli-core.test.ts` `--follow` mode tests (~1s each → ~50ms each)

### 13.5 Mock at Call Site, Not Inside Callee

**Problem:** Mocking `_gitDeps.spawn` to verify `autoCommitIfDirty` is called is fragile — internal guards (like `rev-parse --show-toplevel`) silently early-return in CI.

**Solution:** Export `_sessionRunnerDeps = { autoCommitIfDirty }` and mock the injectable directly.

```typescript
// ✅ Mock at the call site
_sessionRunnerDeps.autoCommitIfDirty = async (dir, msg) => {
  commitCalls.push({ dir, msg });
};

// ❌ Mock deep inside the callee's internal deps
_gitDeps.spawn = (cmd) => { /* fragile — depends on every internal code path */ };
```

**Applied in:** `session-runner.ts` (CI-flaky mock → reliable injectable, commit `e41e076`)

### 13.6 Security & Regression Test Patterns

| Pattern | When | Example |
|:--------|:-----|:--------|
| **Listener count assertion** | Any `process.on`/`removeListener` code | `expect(process.listenerCount("unhandledRejection")).toBe(originalCount)` after cleanup |
| **Symlink rejection test** | Any path validation code | Create temp symlink pointing outside root → assert validation rejects |
| **Permission inheritance test** | Session resume/reconnect | Assert resumed session uses caller's permission, not hardcoded default |
| **Null-safety parse test** | Any JSON parse with fallback | Feed corrupt input → assert `null` result, not unsafe cast |
| **Crash-produces-failure test** | Any stage that parses external output | Feed exit code ≠ 0 with no parseable output → assert `fail`, not `continue` (v0.42.1 acceptance fix) |

---

## Quick Reference Card

| Rule | Limit |
|:-----|:------|
| Source file size | ≤400 lines |
| Test file size | ≤800 lines (split if >3 unrelated concerns) |
| Type-only file size | ≤600 lines |
| Function size | ≤30 lines (50 hard max) |
| Positional params | ≤3 (use options object beyond) |
| `any` in public API | Forbidden |
| Magic numbers | Forbidden (use named constants) |
| `_deps` for externals | Required |
| Error messages | Must include `[stage]` prefix + context |
| `realpathSync` before containment | Required (no lexical-only checks) |
| `process.on` handlers | Must store named ref for removal |
| Permission resolution | `resolvePermissions(config, stage)` only — no local fallbacks |
| Permission booleans | Never read `dangerouslySkipPermissions` directly |
| `pipelineStage` on adapter calls | Required on all `run()`, `complete()`, `plan()`, `decompose()` |
| Test sleep | Injectable `_deps.sleep`, never real `Bun.sleep` |
| Integration test config | `iterationDelayMs: 0` (never DEFAULT_CONFIG) |

| Pattern | When to use | Entry point |
|:--------|:-----------|:------------|
| Builder | Multi-step object construction | `static for()` → chain → `.build()` |
| Adapter | Multiple backends, one contract | Interface in `types.ts`, class per backend |
| Registry | Lookup by name/capability | Class (lifecycle) or function (pure lookup) |
| Strategy | Pluggable algorithms | Interface + classes, selected by orchestrator |
| Chain | Priority-ordered handlers | `.register(handler, priority)` → `.prompt()` |
| Singleton | Global services | `initX()` once, `getX()` / `getSafeX()` everywhere |
| Injectable sleep | Test performance | `_moduleDeps.sleep = Bun.sleep` → spy in tests |
| PidRegistry | Subprocess lifecycle | Register on spawn, unregister on exit, `killAll()` on crash |
| Permission resolver | Agent permissions | `resolvePermissions(config, stage)` → `{ mode, skipPermissions }` |

---

## 14. Permission Resolution

> Introduced in v0.43.0 (PERM-001). Single source of truth for all agent permission decisions.

### Architecture

All permission decisions flow through one function: `resolvePermissions(config, stage)` in `src/config/permissions.ts`.

```
┌─────────────┐     ┌──────────────────────┐     ┌─────────────────────┐
│ Config       │────▶│ resolvePermissions()  │────▶│ ResolvedPermissions │
│ • profile    │     │ src/config/           │     │ • mode              │
│ • legacy bool│     │ permissions.ts        │     │ • skipPermissions   │
│ • stage      │     └──────────────────────┘     │ • allowedTools?     │
└─────────────┘                                   └─────────────────────┘
                                                         │
                              ┌───────────────────────────┤
                              ▼                           ▼
                    ┌──────────────────┐        ┌──────────────────┐
                    │ ACP adapter      │        │ CLI adapter      │
                    │ reads .mode      │        │ reads             │
                    │ ("approve-all"   │        │ .skipPermissions  │
                    │  "approve-reads")│        │ (true/false)      │
                    └──────────────────┘        └──────────────────┘
```

### Permission Profiles

| Profile | ACP mode | CLI flag | When to use |
|:--------|:---------|:---------|:------------|
| `unrestricted` | `approve-all` | `--dangerously-skip-permissions` | Development, trusted environments |
| `safe` | `approve-reads` | *(no flag)* | Production, untrusted projects |
| `scoped` | Per-stage (Phase 2) | Per-stage (Phase 2) | Fine-grained control (future) |

### Config Precedence

```jsonc
// nax/config.json — execution block
{
  "execution": {
    // NEW — preferred (v0.43.0+)
    "permissionProfile": "unrestricted",

    // DEPRECATED — backward compat only, ignored when permissionProfile is set
    "dangerouslySkipPermissions": true
  }
}
```

Resolution order:
1. `execution.permissionProfile` → used if present
2. `execution.dangerouslySkipPermissions` → mapped: `true` → `"unrestricted"`, `false` → `"safe"`
3. Neither set → defaults to `"safe"` (approve-reads)

### Pipeline Stages

Every call to `resolvePermissions()` includes the pipeline stage:

| Stage | Used by | Typical profile |
|:------|:--------|:----------------|
| `plan` | `plan.ts`, `claude-plan.ts` | Same as config (plan writes prd.json) |
| `run` | `execution.ts`, `claude.ts`, `claude-execution.ts`, `session-runner.ts` | Primary execution — most permissive |
| `verify` | Verification strategies | Read-heavy — could be restricted in Phase 2 |
| `rectification` | `rectification-loop.ts`, `rectification-gate.ts` | Needs write access for fixes |
| `complete` | `claude-complete.ts`, `acp/adapter.ts` | One-shot LLM calls — varies by caller |
| `acceptance` | Acceptance generator | Write access for test files |
| `regression` | Regression gate | Read + test execution |
| `review` | Code review | Read-only in Phase 2 |

In Phase 1, all stages resolve to the same profile. Phase 2 (`scoped`) will enable per-stage overrides.

### Rules (Mandatory)

| Rule | Rationale |
|:-----|:----------|
| **Always call `resolvePermissions(config, stage)`** | Single source of truth — no local fallbacks |
| **Never hardcode permission booleans** | No `?? true`, `?? false`, or literal `"approve-all"` |
| **Never read `dangerouslySkipPermissions` directly** | Deprecated field — resolver handles backward compat |
| **Always pass `config` and `pipelineStage` to adapters** | Required for resolver to work — both fields are on `AgentRunOptions` and `CompleteOptions` |
| **New code must set `pipelineStage`** | Every `adapter.run()`, `.complete()`, `.plan()`, `.decompose()` call must specify the stage |

### Adding New Call Sites

When writing code that spawns an agent session or calls `complete()`:

```typescript
// ✅ Correct: use resolvePermissions with config and stage
import { resolvePermissions } from "../config/permissions";

const { skipPermissions, mode } = resolvePermissions(config, "run");

// For CLI adapter — pass skipPermissions
await adapter.run({
  ...options,
  config,
  pipelineStage: "run",
  dangerouslySkipPermissions: skipPermissions,
});

// For ACP adapter — pass mode
session.setPermissionMode(mode);
```

```typescript
// ❌ Wrong: local fallback
const skip = config?.execution?.dangerouslySkipPermissions ?? true;

// ❌ Wrong: hardcoded
const args = ["--dangerously-skip-permissions", ...rest];

// ❌ Wrong: no stage
const perms = resolvePermissions(config, undefined as any);
```

### Reference Files

- **Resolver:** `src/config/permissions.ts` — `resolvePermissions()`, types, profiles
- **Schema:** `src/config/schemas.ts` — `permissionProfile` field definition
- **CLI adapter:** `src/agents/claude.ts`, `claude-execution.ts`, `claude-plan.ts`, `claude-complete.ts`
- **ACP adapter:** `src/agents/acp/adapter.ts`
- **Call sites:** `execution.ts`, `session-runner.ts`, `rectification-loop.ts`, `rectification-gate.ts`, `plan.ts`
- **Spec:** `docs/specs/scoped-permissions.md` — PERM-001 + PERM-002 design

---

## §15 Test Strategy Resolution

### Single Source of Truth

`src/config/test-strategy.ts` defines all valid test strategies, shared prompt fragments,
and the `resolveTestStrategy()` normalizer. This module is the ONLY place where test
strategy values, descriptions, and classification rules are defined.

### Available Strategies

| Strategy | Complexity | Description |
|:---------|:-----------|:------------|
| `test-after` | simple | Write tests after implementation |
| `tdd-simple` | medium | Write key tests first, then implement |
| `three-session-tdd` | complex | 3 sessions: test-writer (strict, no src/ changes) → implementer (no test changes) → verifier |
| `three-session-tdd-lite` | expert | 3 sessions: test-writer (lite, may add src/ stubs) → implementer (lite, may expand coverage) → verifier |

### Rules

1. **resolveTestStrategy()** normalizes unknown/legacy values to valid strategies
2. **Security override**: Security-critical stories → minimum "medium" / "tdd-simple"
3. **No standalone test stories**: Testing is handled per-story via testStrategy
4. Both `plan.ts` and `claude-decompose.ts` import shared prompt fragments — never inline strategy definitions

### Consumers

| File | Uses |
|:-----|:-----|
| `src/cli/plan.ts` | `COMPLEXITY_GUIDE`, `TEST_STRATEGY_GUIDE`, `GROUPING_RULES` |
| `src/agents/shared/decompose.ts` | Same prompt fragments |
| `src/pipeline/stages/routing.ts` | `resolveTestStrategy()` (via prd/schema.ts normalization) |
| `src/prd/schema.ts` | `resolveTestStrategy()` for PRD validation |

---

---

## §16 Agent Adapter Conventions

*Added: 2026-03-16 (MR !52 — agents folder restructure)*

### Folder Structure

Each agent adapter lives in its own subfolder under `src/agents/`. The depth matches the adapter's complexity:

| Adapter | Folder | Files |
|:--------|:-------|:------|
| Claude Code (CLI) | `claude/` | adapter, execution, complete, interactive, plan, cost, index |
| ACP protocol | `acp/` | adapter, spawn-client, parser, cost, interaction-bridge, types, index |
| Aider / Codex / Gemini / OpenCode | `aider/`, `codex/`, `gemini/`, `opencode/` | adapter only |

### Rules

1. **One subfolder per adapter** — never flat files at `src/agents/` root (only `index.ts`, `types.ts`, `registry.ts` live at root)
2. **Each multi-file adapter needs `index.ts`** — re-exports everything external callers need; internal modules import directly without going through the barrel
3. **Cross-adapter code goes in `shared/`** — if two different adapters import the same module, that module belongs in `shared/`, not inside either adapter's folder
4. **Adapter-specific cost stays with the adapter** — `claude/cost.ts` (tier-based) and `acp/cost.ts` (model-name-based) are separate; they have different pricing strategies and callers

### `shared/` Contents

| File | Purpose | Used by |
|:-----|:--------|:--------|
| `shared/decompose.ts` | PRD decomposition prompt + parser | `claude/adapter.ts`, `acp/adapter.ts` |
| `shared/model-resolution.ts` | Resolve ModelDef from config | `claude/plan.ts`, `claude/adapter.ts` |
| `shared/validation.ts` | Agent capability + tier validation | `registry.ts`, pipeline stages |
| `shared/version-detection.ts` | Binary version detection | `cli/agents.ts`, `precheck/checks-agents.ts` |
| `shared/types-extended.ts` | Plan/decompose/interactive types | `claude/plan.ts`, `acp/adapter.ts`, `types.ts` |

### ACP Cost Alignment

ACP sessions emit exact USD cost via `usage_update` (`cost.amount`). The adapter prefers this over token-based estimation:

```ts
// Prefer exact cost from acpx usage_update; fall back to token-based estimation
const estimatedCost =
  totalExactCostUsd ??
  (totalTokenUsage.input_tokens > 0 || totalTokenUsage.output_tokens > 0
    ? estimateCostFromTokenUsage(totalTokenUsage, options.modelDef.model)
    : 0);
```

Token fields from acpx are **camelCase** in the final JSON-RPC `result.usage`:
- `inputTokens`, `outputTokens`, `cachedReadTokens`, `cachedWriteTokens`

The parser (`acp/parser.ts`) handles both the JSON-RPC envelope format (acpx v0.3+) and legacy flat NDJSON for backward compatibility.

---

*Created: 2026-03-10. Last updated: 2026-03-16. Maintained by nax-dev.*
