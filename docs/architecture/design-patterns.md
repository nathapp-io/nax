# Design Patterns — nax

> §11–§13: Design patterns, security standards, test performance.
> Part of the [Architecture Documentation](ARCHITECTURE.md).

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

**Reference:** `src/agents/types.ts`, `src/agents/claude/adapter.ts`, `src/agents/acp/adapter.ts`

#### Agent Protocol Modes

nax supports two agent communication protocols, configured via `agent.protocol` in config:

| Mode | Config value | Adapter | Communication |
|:-----|:-------------|:--------|:--------------|
| ACP (default) | `"acp"` | `AcpAgentAdapter` | JSON-RPC over stdio via `AcpClient` from `acpx` |
| CLI (legacy) | `"cli"` | `ClaudeCodeAdapter` | `Bun.spawn(["claude", "-p", ...])` → parse stdout |

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
| **Never hardcode permission modes anywhere** | All permission decisions go through `resolvePermissions(config, stage)` — see [agent-adapters.md §14](agent-adapters.md#14-permission-resolution). No `?? true`, `?? false`, or literal `"approve-all"` (SEC-3 fix, PERM-001) |
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
