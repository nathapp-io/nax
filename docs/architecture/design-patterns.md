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
| Domain-specific prompt construction (composable) | **Prompt Builder** | `TddPromptBuilder`, `ReviewPromptBuilder`, `AcceptancePromptBuilder`, etc. |
| Multi-step construction with optional config | **Builder** | `TddPromptBuilder.for(role)`, `OneShotPromptBuilder.for(role)` |
| Multiple backends sharing a contract | **Adapter** | `AgentAdapter` → `AcpAgentAdapter` (claude, codex, …), `NativeAgentAdapter`; `SandboxBackend` → srt |
| Collection with typed lookup/lifecycle | **Registry** | `PluginRegistry`, agent registry |
| Interchangeable algorithms for same task | **Strategy** | Verification strategies, routing strategies |
| Ordered handler dispatch with fallback | **Chain** | `InteractionChain`, ask-resolver chain (`chainAskLinks`) |
| Global service with init-once semantics | **Singleton** | Logger |
| Stateful object managing resources (PIDs, connections) | **Class** | `PidRegistry`, `StatusWriter` |

**Rule: prefer plain functions.** Only introduce a class/pattern when you need state, multiple implementations, or complex construction. Never wrap a simple function in a class just to "follow patterns."

### Prompt Builders (Composition over Inheritance)

Domain-specific prompt construction using composable section functions. Replaces the former monolithic `PromptBuilder` class (deleted).

```typescript
// ✅ Each domain has its own builder — composed from reusable sections
const prompt = await TddPromptBuilder.for("implementer", options)
  .story(story)
  .constitution(constitution)
  .context(contextMd)
  .build();

// ✅ One-shot prompts for routing, decomposition
const oneShot = OneShotPromptBuilder.for("router")
  .instructions(routingInstruction)
  .jsonSchema(routingSchema)
  .build();
```

**8 domain-specific builder classes** (`src/prompts/builders/`):

| Builder | Roles | Purpose |
|:--------|:------|:--------|
| `TddPromptBuilder` | implementer, test-writer, verifier, single-session, tdd-simple, batch | TDD execution pipeline |
| `ReviewPromptBuilder` | semantic | Semantic review, AC verification, JSON-retry / re-grounding prompts |
| `AcceptancePromptBuilder` | generator, diagnoser, fix-executor | Acceptance test generation/diagnosis |
| `RectifierPromptBuilder` | static factories (`firstAttemptDelta`, `continuation`, `escalated`, `reviewRectification`, `testWriterRectification`, `regressionFailure`, …) | Fix prompts with escalation preambles; the old `for(trigger)` builder form was removed (ADR-018) |
| `OneShotPromptBuilder` | router, decomposer | Trivial instruction + schema combos |
| `PlanPromptBuilder` | planner | Planning prompt construction (story decomposition, complexity classification, AC generation) |
| `AdversarialReviewPromptBuilder` | adversarial | Adversarial heuristics + findings schema |
| `SetupPromptBuilder` | setup | `nax setup` config generation |

Plain-function builders sit alongside them: `buildDecomposePromptSync` (`decompose-builder.ts`), `buildPriorIterationsBlock`, `buildSourceRootsSection`, `timeoutRetry`.

**Core engine** (`src/prompts/core/`):

- `SectionAccumulator` — shared engine for joining sections, separator loading, override resolution
- `universal-sections.ts` — null-guarded section constructors used by all builders
- `core/sections/` — pure section functions (findings, instructions, json-schema, prior-failures, routing-candidates)

**Rules:**
- **Composition only** — builders wrap `SectionAccumulator`, never inherit from each other
- **Section delegation** — builder methods are one-line delegations to section functions in `core/sections/`
- **Call-order = section order** — fluent chain in callsite determines prompt structure
- **Override loading** — disk overrides loaded per-role via `loader.ts`
- **File size limits** — section files ≤80 lines, builder files ≤200 lines

**Reference:** `src/prompts/builders/`, `src/prompts/core/`, `src/prompts/README.md`

### Builder (Fluent API)

For multi-step object construction with optional configuration:

```typescript
const prompt = await TddPromptBuilder.for(role, options)
  .constitution(constitution)
  .context(contextMd)
  .build(); // async for TddPromptBuilder; sync for OneShotPromptBuilder
```

**Rules:**
- Entry point: `static for(...)` — returns new instance
- Each setter returns `this` for chaining
- Terminal method (`.build()`) produces the result
- Setters are optional — builder has sensible defaults

**Reference:** `src/prompts/builders/tdd-builder.ts`, `src/prompts/builders/one-shot-builder.ts`

### Adapter (Interface + Implementations)

For extensible subsystems where multiple backends share a common contract:

```typescript
// ✅ Interface defines the contract — 4 primitives (ADR-019) plus descriptive members
export interface AgentAdapter {
  readonly name: string;
  readonly capabilities: AgentCapabilities;
  // ...displayName, binary, isInstalled(), buildCommand(), hasCredentials?(), closePhysicalSession?()
  openSession(name: string, opts: OpenSessionOpts): Promise<SessionHandle>;
  sendTurn(handle: SessionHandle, prompt: string, opts: SendTurnOpts): Promise<TurnResult>;
  closeSession(handle: SessionHandle): Promise<void>;
  complete(prompt: string, opts: ResolvedCompleteOptions): Promise<CompleteResult>;
}

// ✅ Two production implementations, selected by agent name (ADR-027)
export class AcpAgentAdapter implements AgentAdapter { ... }    // JSON-RPC over stdio via acpx
export class NativeAgentAdapter implements AgentAdapter { ... } // in-process over @nathapp/nax-ai
```

`adapter.run` / `plan` / `decompose` were deleted in ADR-019 — `run` is now `SessionManager.runInSession` (composes the three session primitives), and `plan`/`decompose` are `kind:"complete"` Operations dispatched via `callOp` (§37, `.claude/rules/adapter-wiring.md`).

**Rules:**
- Interface in `types.ts`, implementations in `src/agents/acp/adapter.ts` and `src/agents/native/adapter.ts`
- Implementations are classes (stateful — may hold config, PID registries, etc.)
- Capabilities declared as data, not methods — enables routing decisions without instantiation

**Reference:** `src/agents/types.ts`, `src/agents/acp/adapter.ts`, `src/agents/native/adapter.ts`, [agent-adapters.md §16](agent-adapters.md#16-agent-adapter-conventions)

#### Agent Protocol

nax has two transports, selected by **agent name** (ADR-027): every named CLI agent (`claude`, `codex`, `opencode`, `gemini`, `aider`, `pi`) is driven over **ACP** (Agent Client Protocol) — JSON-RPC over stdio via [acpx](https://github.com/openclaw/acpx) — and the `native` agent runs in-process over `@nathapp/nax-ai`, with nax owning the conversation and tool loop (ADR-028/029). There is no CLI protocol mode.

`agent.protocol` (`acp` | `native` | `hybrid`, default `hybrid`) is a capability gate deciding which transports are permitted, not a router. `agent.default` defaults to `native` (`src/config/agent-defaults.ts`).

All pipeline stages, routing, TDD, and acceptance generators dispatch through the manager/session/operation layers (never the adapter directly — see `.claude/rules/adapter-wiring.md`). The default agent is read via `resolveDefaultAgent(config)`.

#### LLM Fallback Rule

**Any code that needs LLM capabilities MUST resolve the default agent adapter — never use inline stubs.**

```typescript
// ✅ Correct: dispatch a one-shot through the manager (resolves the default agent)
const agentName = ctx.agentManager?.getDefault() ?? "claude"; // or resolveDefaultAgent(config) in standalone modules
const result = await ctx.runtime.agentManager.completeAs(agentName, prompt, {
  pipelineStage: "decompose",
  config,
});

// ✅ Better still — wrap it as an Operation and dispatch via callOp
await callOp(ctx, decomposeOp, input);

// ❌ Wrong: inline stub that throws
const adapter = {
  async complete(_prompt: string): Promise<string> {
    throw new Error("No LLM adapter configured");
  },
};
```

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
  getReporters(): IReporter[] { ... }
  getOptimizers(): IPromptOptimizer[] { ... }
}

// ✅ Factory-based registry for the agent collection
export function createAgentRegistry(config: AgentManagerConfig): AgentRegistry { ... }
const registry = createAgentRegistry(config);
const agent = registry.getAgent(name); // AgentAdapter | undefined
```

**Rules:**
- Class registry when it needs lifecycle (setup/teardown) — `PluginRegistry`
- Factory registry when it's pure lookup with per-instance caching — agent registry (`createAgentRegistry`)
- Never use Map/object directly in consumer code — wrap in typed accessor

**Reference:** `src/plugins/registry.ts`, `src/agents/registry.ts`

### Strategy (Pluggable Algorithms)

For subsystems with multiple interchangeable algorithms:

```typescript
// ✅ Interface defines the strategy contract
export interface RoutingStrategy {
  readonly name: string;
  route(story: UserStory, context: RoutingContext): RoutingDecision | null | Promise<RoutingDecision | null>;
}

// ✅ Each strategy implements the interface; the Router walks them in order
// (keyword, LLM, plugin-provided), first non-null decision wins.
```

**Rules:**
- Strategy interface lives with the subsystem (`src/routing/router.ts`); plugin-provided strategies arrive via `IRoutingStrategy`
- Selection logic outside the strategies (the Router walks them, or config-driven)
- Strategies are stateless when possible — receive all context via method params

**Reference:** `src/routing/router.ts`, `src/routing/strategies/`

> Verification no longer uses a strategy-class hierarchy — scoped/regression/acceptance verification are now `callOp` Operations (`verifyScopedOp`, `fullSuiteGateOp`, acceptance ops). See §37 and `.claude/rules/adapter-wiring.md`.

### Chain (Priority-Ordered Pipeline)

For processing requests through prioritized handlers:

```typescript
// ✅ Register handlers with priority, first response wins
const chain = new InteractionChain({ defaultTimeout: 30_000, defaultFallback: "abort" });
chain.register(telegramPlugin, 50);  // higher number = earlier in chain
chain.register(autoPlugin, 10);      // fallback
const response = await chain.prompt(request);
```

**Rules:**
- Higher priority number = higher precedence (chain sorts descending)
- Chain handles timeout and fallback — consumers don't
- Used for interaction (human-in-the-loop). Routing uses the analogous "first non-null wins" walk inside `Router` (plugin routers → LLM → keyword), not a separate chain class.
- The permission ask tier is a chain too: `chainAskLinks([approvalsCacheLink, humanLink])` (`src/permissions/ask-chain.ts`) — each link may `allow`, `deny` or `abstain`, and the chain appends a terminal deny so an exhausted chain fails closed.

**Reference:** `src/interaction/chain.ts`, `src/routing/router.ts`, `src/permissions/ask-chain.ts`

### Singleton (Module-Level Instance)

For global services with one-time initialization:

```typescript
// ✅ Module-scoped instance with getter
let _instance: Logger | null = null;

export function initLogger(options: LoggerOptions): Logger {
  if (_instance) throw new NaxError("Logger already initialized", "LOGGER_ALREADY_INITIALIZED", { stage: "logger" });
  _instance = new Logger(options);
  return _instance;
}

export function getLogger(): Logger {
  return _instance ?? noopLogger; // silent no-op logger before init
}

// ✅ Safe variant — null only if getLogger() itself throws
export function getSafeLogger(): Logger | null {
  try {
    return getLogger();
  } catch {
    return null;
  }
}
```

**Rules:**
- Use `getX()` / `getSafeX()` pattern — never export the instance directly
- `getSafeLogger()` preferred in library code (call as `getSafeLogger()?.info(...)`)
- Init once during startup (`run-setup.ts`), use everywhere via getter

**Reference:** `src/logger/logger.ts`

---

## 12. Security Standards

> Codified from code reviews on 2026-03-11 (security-review) and 2026-03-15 (deep code review).

### 12.1 Path & File Security

| Rule | Rationale |
|:-----|:----------|
| **Always `realpathSync()` before path containment checks** | Lexical `normalize()` does not follow symlinks — a symlink inside an allowed root can point anywhere (SEC-1 fix, 2026-03-15) |
| **Use `realOrRaw()` (`src/utils/realpath.ts`) for paths that may not exist** | Walks up to the nearest existing ancestor, resolves it, and re-attaches the missing segments — a half-resolved path compares unequal to a resolved root and silently fails containment |
| **`O_CREAT \| O_EXCL` for atomic lock creation** | Prevents TOCTOU race between check-and-create (BUG-2 fix) |
| **Use `fs.unlink()` for file deletion, never `Bun.spawn(["rm", ...])`** | Subprocess for a single syscall is ~1000x slower and adds unnecessary complexity (BUG-3 fix) |

### 12.2 Command Construction

| Rule | Rationale |
|:-----|:----------|
| **Always use argv arrays for subprocess spawning** | String interpolation enables argument injection |
| **Validate user-editable config values before interpolating into command strings** | Model names, paths, hook commands from config.json are user-controlled (SEC-2) |
| **Use `buildAllowedEnv()` for all spawned processes** | Never pass full `process.env` — prevents credential leakage to agent subprocesses |
| **Agent-authored commands go through the tool policy, once** | Model-authored Bash/`Exec` is adjudicated only in `src/tools/policy*.ts` under the stage's resolved `bashApproval` (ADR-030); the OS sandbox launcher (`src/sandbox/`) changes *how* a command runs, never *whether*. Never add a second gate or wrap nax's own declared commands |

### 12.3 Process & Handler Lifecycle

| Rule | Rationale |
|:-----|:----------|
| **Store named references for all `process.on()` handlers** | `removeListener` compares by reference — anonymous arrows create a new ref each time, making cleanup a silent no-op (BUG-1 fix) |
| **Track spawned PIDs via `PidRegistry`** | Enables cleanup on crash; register in `prompt()`, unregister on exit (v0.42.6 PidRegistry pattern) |
| **Never hardcode permission modes anywhere** | All permission decisions go through `resolvePermissions(config, stage)` — see [agent-adapters.md §14](agent-adapters.md#14-permission-resolution). No `?? true`, `?? false`, or literal `"approve-all"` (SEC-3 fix, PERM-001) |
| **Kill active subprocess before graceful close** | `close()` and `cancelActivePrompt()` must kill `activeProc` first, then close the session |

### 12.4 Agent-Facing Paths & Writes

| Rule | Rationale |
|:-----|:----------|
| **Keep agents off nax-owned files** | `src/tools/nax-owned-writes.ts` refuses coding tools on `.nax/config.json` (and package configs), feature `prd.json` and the queue-control files — a writable config hands the agent an ungated `quality.commands` shell |
| **Sandbox policy paths are literal** | srt on Linux silently drops glob entries, so `execution.sandbox` paths reject `* ? [ ] { }` at config load and the policy builder resolves every path with `realOrRaw()` |
| **Security knobs are root-scoped** | `bashApproval`, `approvalTimeout`, `sandbox`, `commandSafety` are pinned to the root config (ADR-031, `src/config/root-only-keys.ts`); a package cannot loosen them |
| **Audit every tool call** | `src/tools/tool-audit.ts` persists one row per coding-tool call (outcome incl. `denied` / `denied:ask`, reason, approval verdict, sandbox record, Bash `exitCode`, and `callId` / `scopeId` / `turnId` for correlation); logger calls are for operators and never replace the durable row |

### 12.5 Type Safety for Security

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

**Applied in:** the TDD session runner (CI-flaky mock → reliable injectable, commit `e41e076`; the module has since been folded into the Operations layer)

### 13.6 Security & Regression Test Patterns

| Pattern | When | Example |
|:--------|:-----|:--------|
| **Listener count assertion** | Any `process.on`/`removeListener` code | `expect(process.listenerCount("unhandledRejection")).toBe(originalCount)` after cleanup |
| **Symlink rejection test** | Any path validation code | Create temp symlink pointing outside root → assert validation rejects |
| **Permission inheritance test** | Session resume/reconnect | Assert resumed session uses caller's permission, not hardcoded default |
| **Null-safety parse test** | Any JSON parse with fallback | Feed corrupt input → assert `null` result, not unsafe cast |
| **Crash-produces-failure test** | Any stage that parses external output | Feed exit code ≠ 0 with no parseable output → assert `fail`, not `continue` (v0.42.1 acceptance fix) |
