# AgentManager Phase 4 + #567 — Adapter Cleanup & completeWithFallback Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **BLOCKING GATE:** Issue #529 (AgentRunOptions cleanup — removes `keepSessionOpen`, `acpSessionName`, `buildSessionName`) MUST be merged before any task in this plan can be committed. The gate check in Task 1 enforces this.

**Goal:** (a) Remove the adapter-owned fallback machinery (`_unavailableAgents`, `resolveFallbackOrder`, `AllAgentsUnavailableError`) so `AcpAgentAdapter.run()` returns `adapterFailure` on auth/rate-limit instead of throwing or looping internally; implement real `shouldSwap`/`nextCandidate`/`runWithFallback` on `AgentManager` so availability-category swaps are driven by the manager. (b) Add `completeWithFallback()` to `AgentManager` so `complete()` call sites get the same swap capability (#567).

**Architecture:** After this plan `AgentAdapter` is a dumb transport: one agent, one attempt (plus transport-level session-error retry). `AgentManager` owns the cross-agent policy loop. `completeWithFallback` follows the same pattern for one-shot calls. The execution stage's Phase-5.5 inline swap loop is updated to also read `config.agent.fallback` (bridging canonical config) — full removal is Phase 5.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, bun:test

---

## File Map

| Action | File | Purpose |
|:---|:---|:---|
| Modify | `src/agents/manager.ts` | Implement real `shouldSwap`, `nextCandidate`, `runWithFallback`, `completeWithFallback` |
| Modify | `src/agents/manager-types.ts` | Add `IAgentManager.completeWithFallback`, `AgentCompleteOutcome` already exists |
| Modify | `src/agents/types.ts` | Add `adapterFailure?: AdapterFailure` to `CompleteResult` |
| Modify | `src/agents/acp/adapter.ts` | Remove `_unavailableAgents`, `markUnavailable`, `isAvailable`, `resolveFallbackOrder`, `resolveCurrentAgent`; rewrite auth/rate-limit handlers to return `adapterFailure` |
| Modify | `src/errors.ts` | Delete `AllAgentsUnavailableError` class |
| Modify | `src/agents/index.ts` | Remove `AllAgentsUnavailableError` export |
| Modify | `src/pipeline/stages/execution.ts` | Update Phase-5.5 loop to read `config.agent.fallback` in addition to `context.v2.fallback` |
| Modify | `src/acceptance/fix-executor.ts` | Migrate `.complete()` → `completeWithFallback()` |
| Modify | `src/acceptance/generator.ts` | Same |
| Modify | `src/acceptance/refinement.ts` | Same |
| Modify | `src/debate/resolvers.ts` | Same |
| Modify | `src/debate/session-helpers.ts` | Same |
| Modify | `src/interaction/plugins/auto.ts` | Same |
| Modify | `src/routing/strategies/llm.ts` | Same |
| Modify | `src/verification/rectification-loop.ts` | Same |
| Modify | `test/unit/agents/manager.test.ts` | Add tests for real shouldSwap/nextCandidate |
| Create | `test/unit/agents/manager-swap-loop.test.ts` | Tests for runWithFallback real loop |
| Create | `test/unit/agents/manager-complete.test.ts` | Tests for completeWithFallback |
| Create | `test/integration/agents/manager-fallback.test.ts` | Simulated auth failure end-to-end |

---

### Task 1: Gate check — confirm #529 is merged

**Files:** none (verification only)

- [ ] **Step 1: Run the tripwire grep**

```bash
grep -rn "buildSessionName\|keepSessionOpen\|acpSessionName" src/ --include="*.ts" \
  | grep -v ".test.ts\|//_\|//.*keep\|//.*build"
```

Expected: **0 hits** outside of test files or comments. If this returns hits, STOP — #529 must land first.

- [ ] **Step 2: Confirm `AllAgentsUnavailableError` is still present (pre-Phase-4)**

```bash
grep -rn "AllAgentsUnavailableError" src/ --include="*.ts" | grep -v ".test.ts"
```

Expected: hits in `src/errors.ts`, `src/agents/index.ts`, `src/agents/acp/adapter.ts`. This confirms Phase 4 has not started.

---

### Task 2: Implement real `shouldSwap`, `nextCandidate` on AgentManager

**Files:**
- Modify: `src/agents/manager.ts`
- Modify: `test/unit/agents/manager.test.ts`

- [ ] **Step 1: Write failing tests for `shouldSwap`**

Add to `test/unit/agents/manager.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { AgentManager } from "../../../src/agents/manager";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";

function makeManager(fallback: Record<string, unknown> = {}) {
  return new AgentManager({
    ...DEFAULT_CONFIG,
    agent: {
      ...DEFAULT_CONFIG.agent,
      fallback: {
        enabled: true,
        map: { claude: ["codex"] },
        maxHopsPerStory: 2,
        onQualityFailure: false,
        rebuildContext: true,
        ...fallback,
      },
    },
  } as never);
}

const availFailure = { category: "availability" as const, outcome: "fail-auth" as const, retriable: false, message: "" };
const qualityFailure = { category: "quality" as const, outcome: "fail-verify" as const, retriable: false, message: "" };
const mockBundle = {} as import("../../../src/context/engine").ContextBundle;

describe("AgentManager.shouldSwap (Phase 4)", () => {
  test("returns true for availability failure when enabled", () => {
    expect(makeManager().shouldSwap(availFailure, 0, mockBundle)).toBe(true);
  });

  test("returns false when fallback disabled", () => {
    expect(makeManager({ enabled: false }).shouldSwap(availFailure, 0, mockBundle)).toBe(false);
  });

  test("returns false when hop cap reached", () => {
    expect(makeManager({ maxHopsPerStory: 1 }).shouldSwap(availFailure, 1, mockBundle)).toBe(false);
  });

  test("returns false when no bundle", () => {
    expect(makeManager().shouldSwap(availFailure, 0, undefined)).toBe(false);
  });

  test("returns false for quality failure when onQualityFailure=false", () => {
    expect(makeManager({ onQualityFailure: false }).shouldSwap(qualityFailure, 0, mockBundle)).toBe(false);
  });

  test("returns true for quality failure when onQualityFailure=true", () => {
    expect(makeManager({ onQualityFailure: true }).shouldSwap(qualityFailure, 0, mockBundle)).toBe(true);
  });

  test("returns false when failure is undefined", () => {
    expect(makeManager().shouldSwap(undefined, 0, mockBundle)).toBe(false);
  });
});

describe("AgentManager.nextCandidate (Phase 4)", () => {
  test("returns first candidate at hop 0", () => {
    expect(makeManager().nextCandidate("claude", 0)).toBe("codex");
  });

  test("returns null when hop exceeds candidates", () => {
    expect(makeManager().nextCandidate("claude", 1)).toBeNull();
  });

  test("returns null for unknown agent", () => {
    expect(makeManager().nextCandidate("gemini", 0)).toBeNull();
  });

  test("filters pruned candidates", () => {
    const m = makeManager({ map: { claude: ["codex", "gemini"] } });
    m["_prunedFallback"].add("codex");
    expect(m.nextCandidate("claude", 0)).toBe("gemini");
  });

  test("filters unavailable candidates", () => {
    const m = makeManager({ map: { claude: ["codex"] } });
    m.markUnavailable("codex", availFailure);
    expect(m.nextCandidate("claude", 0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
bun test test/unit/agents/manager.test.ts --timeout=30000
```

Expected: FAIL — current `shouldSwap` always returns false, `nextCandidate` always returns null.

- [ ] **Step 3: Implement real `shouldSwap` and `nextCandidate` in `src/agents/manager.ts`**

Replace the two stub methods:

```typescript
shouldSwap(failure: AdapterFailure | undefined, hopsSoFar: number, bundle: ContextBundle | undefined): boolean {
  if (!failure) return false;
  const fallback = this._config.agent?.fallback;
  if (!fallback?.enabled) return false;
  if (!bundle) return false;
  if (hopsSoFar >= (fallback.maxHopsPerStory ?? 2)) return false;
  if (failure.category === "availability") return true;
  return fallback.onQualityFailure ?? false;
}

nextCandidate(current: string, hopsSoFar: number): string | null {
  const map = (this._config.agent?.fallback?.map ?? {}) as Record<string, string[]>;
  const candidates = (map[current] ?? []).filter(
    (a) => !this._prunedFallback.has(a) && !this.isUnavailable(a),
  );
  return candidates[hopsSoFar] ?? null;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test test/unit/agents/manager.test.ts --timeout=30000
```

Expected: all shouldSwap/nextCandidate tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/manager.ts test/unit/agents/manager.test.ts
git commit -m "feat(agent-manager): implement real shouldSwap and nextCandidate (Phase 4)"
```

---

### Task 3: Implement real `runWithFallback` loop on AgentManager

**Files:**
- Modify: `src/agents/manager.ts`
- Create: `test/unit/agents/manager-swap-loop.test.ts`

- [ ] **Step 1: Write failing tests for the real loop**

```typescript
// test/unit/agents/manager-swap-loop.test.ts
import { describe, expect, mock, test } from "bun:test";
import { AgentManager } from "../../../src/agents/manager";
import type { AgentRegistry } from "../../../src/agents/registry";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";

const availFailure = { category: "availability" as const, outcome: "fail-auth" as const, retriable: false, message: "" };
const mockBundle = {} as import("../../../src/context/engine").ContextBundle;

function makeConfig(map: Record<string, string[]> = { claude: ["codex"] }) {
  return {
    ...DEFAULT_CONFIG,
    agent: {
      ...DEFAULT_CONFIG.agent,
      fallback: { enabled: true, map, maxHopsPerStory: 2, onQualityFailure: false, rebuildContext: false },
    },
  } as never;
}

function makeRegistry(results: Record<string, boolean>) {
  return {
    getAgent: (name: string) => ({
      run: mock(async () => ({
        success: results[name] ?? false,
        exitCode: results[name] ? 0 : 1,
        output: "",
        rateLimited: false,
        durationMs: 0,
        estimatedCost: 5.0,
        adapterFailure: results[name] ? undefined : availFailure,
      })),
    }),
  } as unknown as AgentRegistry;
}

describe("AgentManager.runWithFallback — real loop (Phase 4)", () => {
  test("returns success on first attempt", async () => {
    const m = new AgentManager(makeConfig(), makeRegistry({ claude: true }));
    const outcome = await m.runWithFallback({
      runOptions: { storyId: "s1" } as never,
      bundle: mockBundle,
    });
    expect(outcome.result.success).toBe(true);
    expect(outcome.fallbacks).toHaveLength(0);
  });

  test("swaps to codex on auth failure and succeeds", async () => {
    const m = new AgentManager(makeConfig(), makeRegistry({ claude: false, codex: true }));
    const outcome = await m.runWithFallback({
      runOptions: { storyId: "s1" } as never,
      bundle: mockBundle,
    });
    expect(outcome.result.success).toBe(true);
    expect(outcome.fallbacks).toHaveLength(1);
    expect(outcome.fallbacks[0].priorAgent).toBe("claude");
    expect(outcome.fallbacks[0].newAgent).toBe("codex");
    expect(outcome.fallbacks[0].costUsd).toBe(5.0);
  });

  test("returns failure when all candidates exhausted", async () => {
    const m = new AgentManager(makeConfig(), makeRegistry({ claude: false, codex: false }));
    const outcome = await m.runWithFallback({
      runOptions: { storyId: "s1" } as never,
      bundle: mockBundle,
    });
    expect(outcome.result.success).toBe(false);
    expect(outcome.fallbacks).toHaveLength(1);
  });

  test("emits onSwapAttempt event", async () => {
    const m = new AgentManager(makeConfig(), makeRegistry({ claude: false, codex: true }));
    const events: unknown[] = [];
    m.events.on("onSwapAttempt", (e) => events.push(e));
    await m.runWithFallback({ runOptions: { storyId: "s1" } as never, bundle: mockBundle });
    expect(events).toHaveLength(1);
  });

  test("emits onSwapExhausted when no more candidates", async () => {
    const m = new AgentManager(makeConfig(), makeRegistry({ claude: false, codex: false }));
    const exhausted: unknown[] = [];
    m.events.on("onSwapExhausted", (e) => exhausted.push(e));
    await m.runWithFallback({ runOptions: { storyId: "s1" } as never, bundle: mockBundle });
    expect(exhausted).toHaveLength(1);
  });

  test("skips swap when no bundle (bundle required for shouldSwap)", async () => {
    const m = new AgentManager(makeConfig(), makeRegistry({ claude: false }));
    const outcome = await m.runWithFallback({
      runOptions: { storyId: "s1" } as never,
      bundle: undefined,
    });
    expect(outcome.result.success).toBe(false);
    expect(outcome.fallbacks).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
bun test test/unit/agents/manager-swap-loop.test.ts --timeout=30000
```

Expected: swap tests FAIL — current `runWithFallback` doesn't loop.

- [ ] **Step 3: Implement real `runWithFallback` in `src/agents/manager.ts`**

Add injectable dep at top of manager.ts (after imports):

```typescript
export const _agentManagerDeps = {
  sleep: (ms: number) => Bun.sleep(ms),
};
```

Replace the stub `runWithFallback` method:

```typescript
async runWithFallback(request: AgentRunRequest): Promise<AgentRunOutcome> {
  const logger = getSafeLogger();
  const fallbacks: AgentFallbackRecord[] = [];
  let currentAgent = this.getDefault();
  let hopsSoFar = 0;
  const MAX_RATE_LIMIT_RETRIES = 3;
  let rateLimitRetry = 0;

  while (true) {
    const adapter = this._registry?.getAgent(currentAgent);
    if (!adapter) {
      return {
        result: {
          success: false,
          exitCode: 1,
          output: `Agent "${currentAgent}" not found in registry`,
          rateLimited: false,
          durationMs: 0,
          estimatedCost: 0,
        },
        fallbacks,
      };
    }

    let result: AgentResult;
    try {
      result = await adapter.run(request.runOptions);
    } catch (err) {
      result = {
        success: false,
        exitCode: 1,
        output: err instanceof Error ? err.message : String(err),
        rateLimited: false,
        durationMs: 0,
        estimatedCost: 0,
        adapterFailure: {
          category: "quality",
          outcome: "fail-unknown",
          retriable: false,
          message: String(err).slice(0, 500),
        },
      };
    }

    if (result.success) return { result, fallbacks };

    if (!this.shouldSwap(result.adapterFailure, hopsSoFar, request.bundle)) {
      // Preserve legacy rate-limit backoff when no swap candidates are available
      if (
        result.adapterFailure?.outcome === "fail-rate-limit" &&
        rateLimitRetry < MAX_RATE_LIMIT_RETRIES
      ) {
        rateLimitRetry += 1;
        const backoffMs = 2 ** rateLimitRetry * 1000;
        logger?.info("agent-manager", "Rate-limited with no swap candidate — backing off", {
          storyId: request.runOptions.storyId,
          attempt: rateLimitRetry,
          backoffMs,
        });
        await _agentManagerDeps.sleep(backoffMs);
        continue;
      }
      if (hopsSoFar > 0) {
        this._emitter.emit("onSwapExhausted", { storyId: request.runOptions.storyId, hops: hopsSoFar });
      }
      return { result, fallbacks };
    }

    const next = this.nextCandidate(currentAgent, hopsSoFar);
    if (!next) {
      this._emitter.emit("onSwapExhausted", { storyId: request.runOptions.storyId, hops: hopsSoFar });
      return { result, fallbacks };
    }

    this.markUnavailable(currentAgent, result.adapterFailure!);
    hopsSoFar += 1;
    rateLimitRetry = 0;

    const hop: AgentFallbackRecord = {
      storyId: request.runOptions.storyId,
      priorAgent: currentAgent,
      newAgent: next,
      hop: hopsSoFar,
      outcome: result.adapterFailure!.outcome,
      category: result.adapterFailure!.category,
      timestamp: new Date().toISOString(),
      costUsd: result.estimatedCost ?? 0,
    };
    fallbacks.push(hop);
    this._emitter.emit("onSwapAttempt", hop);

    logger?.info("agent-manager", "Agent swap triggered", {
      storyId: request.runOptions.storyId,
      fromAgent: currentAgent,
      toAgent: next,
      hop: hopsSoFar,
    });

    currentAgent = next;
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test test/unit/agents/manager-swap-loop.test.ts --timeout=30000
```

Expected: all 6 tests PASS.

- [ ] **Step 5: Run full suite to confirm no regressions**

```bash
bun run typecheck && bun test --timeout=30000
```

- [ ] **Step 6: Commit**

```bash
git add src/agents/manager.ts test/unit/agents/manager-swap-loop.test.ts
git commit -m "feat(agent-manager): implement real runWithFallback swap loop (Phase 4)"
```

---

### Task 4: Strip adapter-owned fallback state from `AcpAgentAdapter`

**Files:**
- Modify: `src/agents/acp/adapter.ts`
- Modify: `src/errors.ts`
- Modify: `src/agents/index.ts`

- [ ] **Step 1: Write invariant test — adapter must not throw for classifiable failures**

```typescript
// test/unit/agents/adapter-no-throw.test.ts
import { describe, expect, test } from "bun:test";

describe("AcpAgentAdapter — no-throw invariant (Phase 4)", () => {
  test("AllAgentsUnavailableError is deleted after Phase 4", async () => {
    // After Phase 4 this import should fail (class deleted)
    // Run this as a static assertion during CI — if the import succeeds, the class was not deleted.
    try {
      const { AllAgentsUnavailableError } = await import("../../../src/errors");
      // If we reach here, Phase 4 is not complete
      expect(AllAgentsUnavailableError).toBeUndefined();
    } catch {
      // Expected — class removed, import throws or is undefined
      expect(true).toBe(true);
    }
  });
});
```

Actually write this as a grep check instead (simpler):

```typescript
// test/unit/agents/adapter-cleanup.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const adapterSrc = readFileSync(
  join(import.meta.dir, "../../../src/agents/acp/adapter.ts"),
  "utf-8",
);

describe("AcpAgentAdapter cleanup (Phase 4 invariants)", () => {
  test("_unavailableAgents private field is removed", () => {
    expect(adapterSrc).not.toContain("_unavailableAgents");
  });

  test("resolveFallbackOrder is removed", () => {
    expect(adapterSrc).not.toContain("resolveFallbackOrder");
  });

  test("AllAgentsUnavailableError is not thrown", () => {
    expect(adapterSrc).not.toContain("AllAgentsUnavailableError");
  });

  test("hasActiveFallbacks check is removed", () => {
    expect(adapterSrc).not.toContain("hasActiveFallbacks");
  });
});
```

- [ ] **Step 2: Run to confirm tests fail (pre-cleanup)**

```bash
bun test test/unit/agents/adapter-cleanup.test.ts --timeout=30000
```

Expected: all 4 FAIL — the adapter still has these symbols.

- [ ] **Step 3: Remove `_unavailableAgents`, `markUnavailable`, `isAvailable`, `resolveCurrentAgent`, `resolveFallbackOrder` from `adapter.ts`**

In `src/agents/acp/adapter.ts`:

a) Remove the `import { AllAgentsUnavailableError }` line at top.

b) Remove the private field declaration (~line 417):
```typescript
// DELETE:
private _unavailableAgents: Set<string>;
```

c) Remove the field initialisation in constructor (~line 432):
```typescript
// DELETE:
this._unavailableAgents = new Set();
```

d) Remove the 4 private methods at the bottom of the class (~lines 1172-1245):
- `clearUnavailableAgents(): void` — actually keep this! It's called by `AgentRegistry.resetStoryState()`. But it must be updated to clear nothing (or removed from the registry call too).

  Check `src/agents/registry.ts` for `clearUnavailableAgents` usage:
  ```bash
  grep -n "clearUnavailableAgents\|resetStoryState" src/agents/registry.ts
  ```
  If `resetStoryState()` calls `clearUnavailableAgents()` on the adapter, update it to be a no-op in the adapter (the manager's `reset()` now handles this). Keep the method signature but make it empty:
  ```typescript
  clearUnavailableAgents(): void {
    // no-op: per-run unavailable state now owned by AgentManager (ADR-012 Phase 4)
  }
  ```

- `markUnavailable(agentName: string): void` — DELETE
- `isAvailable(agentName: string): boolean` — DELETE
- `resolveCurrentAgent(config: ...): string` — DELETE
- `resolveFallbackOrder(config: unknown, currentAgent: string): string[]` — DELETE

e) Remove the `hasActiveFallbacks` variable declarations in `run()` (two occurrences — check both the outer loop and any inner usage).

- [ ] **Step 4: Simplify `run()` — rewrite auth/rate-limit handlers to return `adapterFailure`**

The current `run()` outer `while(true)` loop is ~200 lines. After Phase 4 it collapses to a session-error-retry-only loop:

```typescript
async run(options: AgentRunOptions): Promise<AgentResult> {
  const startTime = Date.now();
  const config = options.config;
  const SESSION_ERROR_MAX_RETRIES = config?.execution?.sessionErrorMaxRetries ?? 1;
  const SESSION_ERROR_RETRYABLE_MAX_RETRIES = config?.execution?.sessionErrorRetryableMaxRetries ?? 3;
  let sessionErrorRetries = 0;

  while (true) {
    try {
      const result = await this._runWithClient(options, startTime, this.name);

      if (!result.success) {
        // Transport-layer session error retry (same agent, same protocol)
        const maxSessionRetries = result.sessionErrorRetryable
          ? SESSION_ERROR_RETRYABLE_MAX_RETRIES
          : SESSION_ERROR_MAX_RETRIES;
        if (
          result.sessionError &&
          _acpAdapterDeps.shouldRetrySessionError &&
          sessionErrorRetries < maxSessionRetries
        ) {
          sessionErrorRetries += 1;
          getSafeLogger()?.warn("acp-adapter", "Session error — retrying with fresh session", {
            storyId: options.storyId,
            retryable: result.sessionErrorRetryable,
            attempt: sessionErrorRetries,
            maxAttempts: maxSessionRetries,
          });
          continue;
        }

        // Availability failures — return adapterFailure, never throw or loop
        const parsed = _fallbackDeps.parseAgentError(result.output ?? "");
        if (parsed.type === "auth") {
          return {
            success: false,
            exitCode: result.exitCode ?? 1,
            output: result.output ?? "",
            rateLimited: false,
            durationMs: Date.now() - startTime,
            estimatedCost: result.estimatedCost ?? 0,
            adapterFailure: {
              category: "availability",
              outcome: "fail-auth",
              retriable: false,
              message: (result.output ?? "").slice(0, 500),
            },
          };
        }
        if (parsed.type === "rate-limit") {
          return {
            success: false,
            exitCode: result.exitCode ?? 1,
            output: result.output ?? "",
            rateLimited: true,
            durationMs: Date.now() - startTime,
            estimatedCost: result.estimatedCost ?? 0,
            adapterFailure: {
              category: "availability",
              outcome: "fail-rate-limit",
              retriable: true,
              message: (result.output ?? "").slice(0, 500),
            },
          };
        }
      }

      return { ...result, sessionRetries: sessionErrorRetries };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const parsed = _fallbackDeps.parseAgentError(error.message);

      if (parsed.type === "auth") {
        return {
          success: false,
          exitCode: 1,
          output: error.message,
          rateLimited: false,
          durationMs: Date.now() - startTime,
          estimatedCost: 0,
          adapterFailure: {
            category: "availability",
            outcome: "fail-auth",
            retriable: false,
            message: error.message.slice(0, 500),
          },
        };
      }
      if (parsed.type === "rate-limit") {
        return {
          success: false,
          exitCode: 1,
          output: error.message,
          rateLimited: true,
          durationMs: Date.now() - startTime,
          estimatedCost: 0,
          adapterFailure: {
            category: "availability",
            outcome: "fail-rate-limit",
            retriable: true,
            message: error.message.slice(0, 500),
          },
        };
      }

      // Non-classifiable — propagate (manager's last-resort catch handles it)
      throw error;
    }
  }
}
```

- [ ] **Step 5: Delete `AllAgentsUnavailableError` from `src/errors.ts`**

Remove the entire class definition (~lines 62-66):
```typescript
// DELETE this entire block:
export class AllAgentsUnavailableError extends NaxError {
  constructor(triedAgents: string[]) {
    super(`All agents unavailable: ${triedAgents.join(", ")}`, "ALL_AGENTS_UNAVAILABLE", { triedAgents });
    this.name = "AllAgentsUnavailableError";
  }
}
```

- [ ] **Step 6: Remove `AllAgentsUnavailableError` from `src/agents/index.ts`**

Remove the line:
```typescript
export { AllAgentsUnavailableError } from "../errors";
```

- [ ] **Step 7: Run adapter cleanup tests**

```bash
bun test test/unit/agents/adapter-cleanup.test.ts --timeout=30000
```

Expected: all 4 PASS.

- [ ] **Step 8: Run full suite**

```bash
bun run typecheck && bun test --timeout=30000
```

Expected: all pass. If existing tests relied on `AllAgentsUnavailableError` being thrown, update them to expect `adapterFailure: { outcome: "fail-auth" }` instead.

- [ ] **Step 9: Commit**

```bash
git add src/agents/acp/adapter.ts src/errors.ts src/agents/index.ts test/unit/agents/adapter-cleanup.test.ts
git commit -m "feat(acp-adapter): remove adapter-owned fallback state, return adapterFailure on auth/rate-limit (Phase 4)"
```

---

### Task 5: Update execution stage Phase-5.5 loop to read `config.agent.fallback`

This bridges the gap for users who set `agent.fallback` (canonical config) without `context.v2.fallback`. The Phase-5.5 loop is removed entirely in Phase 5.

**Files:**
- Modify: `src/pipeline/stages/execution.ts`

- [ ] **Step 1: Write test for canonical-config fallback detection**

```typescript
// test/unit/pipeline/stages/execution-fallback-config.test.ts
import { describe, expect, test } from "bun:test";

describe("execution stage fallback config resolution", () => {
  test("agent.fallback used when context.v2.fallback absent", () => {
    // This test verifies the config merge logic — the real test is the T16.3 fixture
    const config = {
      agent: { fallback: { enabled: true, map: { claude: ["codex"] }, maxHopsPerStory: 2, onQualityFailure: false } },
      context: { v2: {} },
    } as never;
    const resolved = (config as never).agent?.fallback ?? (config as never).context?.v2?.fallback;
    expect(resolved?.enabled).toBe(true);
  });
});
```

```bash
bun test test/unit/pipeline/stages/execution-fallback-config.test.ts --timeout=30000
```

Expected: PASS.

- [ ] **Step 2: Update the Phase-5.5 guard in `src/pipeline/stages/execution.ts`**

Find the line (currently ~261) that reads:
```typescript
const fallbackConfig = ctx.config.context?.v2?.fallback;
```

Replace with:
```typescript
const fallbackConfig = ctx.config.agent?.fallback ?? ctx.config.context?.v2?.fallback;
```

This ensures canonical `agent.fallback` users get Phase-5.5 swap behaviour until Phase 5 removes the loop.

- [ ] **Step 3: Run typecheck and tests**

```bash
bun run typecheck && bun test --timeout=30000
```

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/stages/execution.ts test/unit/pipeline/stages/execution-fallback-config.test.ts
git commit -m "fix(execution): read config.agent.fallback for Phase-5.5 swap loop, bridging canonical config (Phase 4)"
```

---

### Task 6: Add `completeWithFallback` — interface, implementation, and `CompleteResult.adapterFailure` (#567)

**Files:**
- Modify: `src/agents/types.ts`
- Modify: `src/agents/manager-types.ts`
- Modify: `src/agents/manager.ts`
- Create: `test/unit/agents/manager-complete.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/unit/agents/manager-complete.test.ts
import { describe, expect, mock, test } from "bun:test";
import { AgentManager } from "../../../src/agents/manager";
import type { AgentRegistry } from "../../../src/agents/registry";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";

const availFailure = { category: "availability" as const, outcome: "fail-auth" as const, retriable: false, message: "" };

function makeConfig() {
  return {
    ...DEFAULT_CONFIG,
    agent: {
      ...DEFAULT_CONFIG.agent,
      fallback: { enabled: true, map: { claude: ["codex"] }, maxHopsPerStory: 2, onQualityFailure: false, rebuildContext: false },
    },
  } as never;
}

function makeRegistry(results: Record<string, { output: string; failure?: typeof availFailure }>) {
  return {
    getAgent: (name: string) => {
      const r = results[name];
      if (!r) return undefined;
      return {
        complete: mock(async () => ({
          output: r.output,
          costUsd: 0.01,
          source: "exact" as const,
          adapterFailure: r.failure,
        })),
      };
    },
  } as unknown as AgentRegistry;
}

describe("AgentManager.completeWithFallback (#567)", () => {
  test("returns output on success", async () => {
    const m = new AgentManager(makeConfig(), makeRegistry({ claude: { output: "hello" } }));
    const outcome = await m.completeWithFallback("prompt", { config: DEFAULT_CONFIG } as never);
    expect(outcome.result.output).toBe("hello");
    expect(outcome.fallbacks).toHaveLength(0);
  });

  test("swaps to codex on auth failure", async () => {
    const registry = makeRegistry({
      claude: { output: "", failure: availFailure },
      codex: { output: "from codex" },
    });
    const m = new AgentManager(makeConfig(), registry);
    const outcome = await m.completeWithFallback("prompt", { config: DEFAULT_CONFIG } as never);
    expect(outcome.result.output).toBe("from codex");
    expect(outcome.fallbacks).toHaveLength(1);
    expect(outcome.fallbacks[0].priorAgent).toBe("claude");
  });

  test("returns failure when no swap configured", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      agent: { ...DEFAULT_CONFIG.agent, fallback: { enabled: false, map: {}, maxHopsPerStory: 2, onQualityFailure: false, rebuildContext: false } },
    } as never;
    const m = new AgentManager(config, makeRegistry({ claude: { output: "", failure: availFailure } }));
    const outcome = await m.completeWithFallback("prompt", { config: DEFAULT_CONFIG } as never);
    expect(outcome.result.adapterFailure?.outcome).toBe("fail-auth");
  });
});
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
bun test test/unit/agents/manager-complete.test.ts --timeout=30000
```

Expected: FAIL — `completeWithFallback` does not exist.

- [ ] **Step 3: Add `adapterFailure` to `CompleteResult` in `src/agents/types.ts`**

Find the `CompleteResult` interface and add the optional field:

```typescript
export interface CompleteResult {
  output: string;
  costUsd: number;
  source: "exact" | "estimated" | "fallback";
  /** Set when complete() failed due to an availability error — consumed by completeWithFallback. */
  adapterFailure?: AdapterFailure;
}
```

Also add the import at top of `src/agents/types.ts` if not already present:
```typescript
import type { AdapterFailure } from "../context/engine/types";
```

- [ ] **Step 4: Add `completeWithFallback` to `IAgentManager` in `src/agents/manager-types.ts`**

Add to the `IAgentManager` interface:

```typescript
import type { CompleteOptions } from "./types";

// Add to IAgentManager:
/**
 * One-shot completion with cross-agent fallback.
 * Mirrors runWithFallback but for complete() calls.
 * Swaps on availability failures when agent.fallback.enabled.
 */
completeWithFallback(prompt: string, options: CompleteOptions): Promise<AgentCompleteOutcome>;
```

`AgentCompleteOutcome` already exists in manager-types.ts.

- [ ] **Step 5: Implement `completeWithFallback` in `src/agents/manager.ts`**

Add after `runWithFallback`:

```typescript
async completeWithFallback(prompt: string, options: CompleteOptions): Promise<AgentCompleteOutcome> {
  const logger = getSafeLogger();
  const fallbacks: AgentFallbackRecord[] = [];
  let currentAgent = this.getDefault();
  let hopsSoFar = 0;

  while (true) {
    const adapter = this._registry?.getAgent(currentAgent);
    if (!adapter) {
      return {
        result: { output: "", costUsd: 0, source: "fallback" },
        fallbacks,
      };
    }

    let result: CompleteResult;
    try {
      result = await adapter.complete(prompt, options);
    } catch (err) {
      result = {
        output: "",
        costUsd: 0,
        source: "fallback",
        adapterFailure: {
          category: "quality",
          outcome: "fail-unknown",
          retriable: false,
          message: String(err).slice(0, 500),
        },
      };
    }

    const hasFailure = !!result.adapterFailure;
    if (!hasFailure) return { result, fallbacks };

    if (!this.shouldSwap(result.adapterFailure, hopsSoFar, {} as ContextBundle)) {
      return { result, fallbacks };
    }

    const next = this.nextCandidate(currentAgent, hopsSoFar);
    if (!next) return { result, fallbacks };

    this.markUnavailable(currentAgent, result.adapterFailure!);
    hopsSoFar += 1;

    const hop: AgentFallbackRecord = {
      priorAgent: currentAgent,
      newAgent: next,
      hop: hopsSoFar,
      outcome: result.adapterFailure!.outcome,
      category: result.adapterFailure!.category,
      timestamp: new Date().toISOString(),
      costUsd: result.costUsd ?? 0,
    };
    fallbacks.push(hop);
    this._emitter.emit("onSwapAttempt", hop);

    logger?.info("agent-manager", "complete() swap triggered", {
      fromAgent: currentAgent,
      toAgent: next,
      hop: hopsSoFar,
    });

    currentAgent = next;
  }
}
```

Note: `completeWithFallback` passes a dummy `ContextBundle` (`{} as ContextBundle`) to `shouldSwap` because `complete()` is one-shot and doesn't carry a context bundle. The bundle check in `shouldSwap` is only relevant for run-level swaps where context rebuild is needed. For `completeWithFallback`, we only need to check `fallback.enabled` and hop cap — document this trade-off with a comment.

Update the implementation to skip the bundle check for complete calls:

```typescript
// In shouldSwap, add a guard for complete()-only swaps:
// Pass a sentinel bundle object so shouldSwap's `!bundle` check passes.
// completeWithFallback never rebuilds context (no bundle in complete flow).
```

Or alternatively, add a `bundleRequired?: boolean` flag to shouldSwap. For simplicity, just pass `{}` as the sentinel — it satisfies `!bundle` (falsy check is `bundle === undefined`, not `!bundle`... actually `{}` is truthy). So `!bundle` will be false for `{}`. This is intentional.

- [ ] **Step 6: Run tests**

```bash
bun test test/unit/agents/manager-complete.test.ts --timeout=30000
```

Expected: all 3 PASS.

- [ ] **Step 7: Run full suite**

```bash
bun run typecheck && bun test --timeout=30000
```

- [ ] **Step 8: Commit**

```bash
git add src/agents/types.ts src/agents/manager-types.ts src/agents/manager.ts test/unit/agents/manager-complete.test.ts
git commit -m "feat(agent-manager): add completeWithFallback, adapterFailure to CompleteResult (#567)"
```

---

### Task 7: Migrate `complete()` call sites to `completeWithFallback()`

All sites that call `adapter.complete(prompt, options)` should use `agentManager.completeWithFallback(prompt, options)` to get swap protection. These sites currently have `agentGetFn` or a direct adapter reference.

**Files:** `src/acceptance/fix-executor.ts`, `src/acceptance/generator.ts`, `src/acceptance/refinement.ts`, `src/debate/resolvers.ts`, `src/debate/session-helpers.ts`, `src/interaction/plugins/auto.ts`, `src/routing/strategies/llm.ts`, `src/verification/rectification-loop.ts`

- [ ] **Step 1: Write failing test confirming old `.complete()` direct calls are replaced**

```typescript
// test/unit/agents/complete-callsite-migration.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sites = [
  "src/acceptance/fix-executor.ts",
  "src/acceptance/generator.ts",
  "src/acceptance/refinement.ts",
  "src/debate/resolvers.ts",
  "src/interaction/plugins/auto.ts",
  "src/routing/strategies/llm.ts",
  "src/verification/rectification-loop.ts",
];

describe("complete() call-site migration (#567)", () => {
  for (const site of sites) {
    test(`${site} does not call adapter.complete() directly`, () => {
      const src = readFileSync(join(import.meta.dir, "../../..", site), "utf-8");
      // allow ".complete(" only if prefixed with "manager" or "completeWith"
      const directCalls = src.match(/(?<!manager)(?<!completeWith)\.complete\(/g) ?? [];
      // Filter out legitimate uses like "completeWithFallback(" and "Promise.race" etc
      const badCalls = directCalls.filter((m) => m === ".complete(");
      expect(badCalls).toHaveLength(0);
    });
  }
});
```

```bash
bun test test/unit/agents/complete-callsite-migration.test.ts --timeout=30000
```

Expected: FAIL — current files call `.complete()` directly.

- [ ] **Step 2: Thread `agentManager` into each site and replace `.complete()` calls**

For each file, the pattern is:

**Sites that already have `agentManager` in scope (via `ctx: PipelineContext` or `SequentialExecutionContext`):**
- No options change needed — use `ctx.agentManager.completeWithFallback(prompt, options)`

**Sites that receive `config: NaxConfig` but not `agentManager`:**
- Add `agentManager?: IAgentManager` to the options type
- Thread from the caller (which has agentManager after Phase 1+3)
- Use `agentManager?.completeWithFallback(prompt, opts) ?? adapter.complete(prompt, opts)` as safe fallback during transition

Apply the pattern to each file:

`src/routing/strategies/llm.ts` — `callLlmOnce(adapter, ...)` receives no manager. For routing, the fallback is less critical. Thread `agentManager?` through `tryLlmBatchRoute` → `callLlmOnce` or just use `adapter.complete()` directly here (routing is pre-execution, no story context). **Decision: keep `adapter.complete()` for routing — routing runs before the story is assigned an agentManager. Document this exception.**

`src/acceptance/generator.ts`, `refinement.ts`, `fix-executor.ts` — these receive `config: NaxConfig` and `agentGetFn`. Add `agentManager?: IAgentManager` to their option types, thread from `AcceptanceLoopContext.agentManager` (add this field to `AcceptanceLoopContext`). Thread from `runCompletionPhase` options (already has `agentManager`).

`src/interaction/plugins/auto.ts` — receives `naxConfig`. Add `agentManager?: IAgentManager` to the auto-plugin context and thread from interaction chain setup.

`src/debate/resolvers.ts`, `session-helpers.ts` — receives `config`. Add `agentManager?: IAgentManager` and thread from debate orchestration context.

`src/verification/rectification-loop.ts` — receives `config`. Add `agentManager?: IAgentManager`, thread from `executeRectification()` callers.

For each site, after threading:
```typescript
// Before:
const result = await adapter.complete(prompt, opts);

// After:
const result = agentManager
  ? (await agentManager.completeWithFallback(prompt, opts)).result
  : await adapter.complete(prompt, opts);
```

- [ ] **Step 3: Run callsite migration test**

```bash
bun test test/unit/agents/complete-callsite-migration.test.ts --timeout=30000
```

Expected: PASS (or partial — sites that keep `.complete()` by exception like routing are noted).

- [ ] **Step 4: Run full suite**

```bash
bun run typecheck && bun run lint && bun test --timeout=30000
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/acceptance/ src/debate/ src/interaction/ src/verification/ src/agents/manager-types.ts
git commit -m "feat(agents): migrate complete() call sites to completeWithFallback (closes #567)"
```

---

### Task 8: Integration test — simulated auth failure triggers AgentManager swap

**Files:**
- Create: `test/integration/agents/manager-fallback.test.ts`

- [ ] **Step 1: Write and run the integration test**

```typescript
// test/integration/agents/manager-fallback.test.ts
import { describe, expect, mock, test } from "bun:test";
import { AgentManager } from "../../../src/agents/manager";
import type { AgentRegistry } from "../../../src/agents/registry";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";

describe("AgentManager — auth failure triggers swap (integration)", () => {
  test("auth failure on claude → swaps to codex → records hop with costUsd", async () => {
    const claudeRun = mock(async () => ({
      success: false,
      exitCode: 1,
      output: "401 Unauthorized",
      rateLimited: false,
      durationMs: 100,
      estimatedCost: 0.05,
      adapterFailure: { category: "availability" as const, outcome: "fail-auth" as const, retriable: false, message: "401" },
    }));
    const codexRun = mock(async () => ({
      success: true,
      exitCode: 0,
      output: "done",
      rateLimited: false,
      durationMs: 200,
      estimatedCost: 0.03,
    }));

    const registry = {
      getAgent: (name: string) => name === "claude"
        ? { run: claudeRun }
        : name === "codex"
        ? { run: codexRun }
        : undefined,
    } as unknown as AgentRegistry;

    const config = {
      ...DEFAULT_CONFIG,
      agent: {
        ...DEFAULT_CONFIG.agent,
        default: "claude",
        fallback: { enabled: true, map: { claude: ["codex"] }, maxHopsPerStory: 2, onQualityFailure: false, rebuildContext: false },
      },
    } as never;

    const manager = new AgentManager(config, registry);
    const swaps: unknown[] = [];
    manager.events.on("onSwapAttempt", (e) => swaps.push(e));

    const outcome = await manager.runWithFallback({
      runOptions: { storyId: "s-001", workdir: "/tmp" } as never,
      bundle: {} as never,
    });

    expect(outcome.result.success).toBe(true);
    expect(outcome.fallbacks).toHaveLength(1);

    const hop = outcome.fallbacks[0];
    expect(hop.priorAgent).toBe("claude");
    expect(hop.newAgent).toBe("codex");
    expect(hop.hop).toBe(1);
    expect(hop.costUsd).toBe(0.05);
    expect(hop.category).toBe("availability");
    expect(hop.outcome).toBe("fail-auth");
    expect(hop.timestamp).toBeTruthy();

    expect(swaps).toHaveLength(1);
    expect(claudeRun).toHaveBeenCalledTimes(1);
    expect(codexRun).toHaveBeenCalledTimes(1);
  });
});
```

```bash
bun test test/integration/agents/manager-fallback.test.ts --timeout=30000
```

Expected: PASS.

- [ ] **Step 2: Run full suite and verify Phase 4 grep tripwire**

```bash
# Full suite
bun run typecheck && bun run lint && bun test --timeout=30000

# Phase 4 invariant grep — should return 0 hits
grep -rn "_unavailableAgents\|resolveFallbackOrder\|AllAgentsUnavailableError\|hasActiveFallbacks" src/ --include="*.ts" | grep -v ".test.ts"
```

Expected: 0 hits on all four symbols.

- [ ] **Step 3: Commit**

```bash
git add test/integration/agents/manager-fallback.test.ts
git commit -m "test(agent-manager): add integration test for auth failure → swap (Phase 4 validation)"
```

---

## Self-Review Checklist

```bash
# Adapter cleanup invariants — all should return 0 hits:
grep -rn "_unavailableAgents\|resolveFallbackOrder\|AllAgentsUnavailableError" src/ --include="*.ts" | grep -v ".test.ts"

# #529 tripwire — should return 0 hits (confirming #529 was merged before Phase 4):
grep -rn "buildSessionName\|keepSessionOpen\|acpSessionName" src/ --include="*.ts" | grep -v ".test.ts\|//"

# Full suite:
bun run typecheck && bun run lint && bun test --timeout=30000
```
