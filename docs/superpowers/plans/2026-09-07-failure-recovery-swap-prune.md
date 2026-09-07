# Failure recovery — decouple swap from prune — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a transient agent failure from costing an agent it did not need to cost, by splitting `markUnavailable`'s two meanings into three separate mechanisms.

**Architecture:** One outcome-keyed policy table (`failurePolicyFor`) becomes the SSOT for the four things a failure decides — same-agent retry lane, swap eligibility, cooldown duration, terminal backoff. `AdapterFailure.category` stops being read by any decision and survives as an observability tag. A cooldown store with an expiry replaces the permanent `_unavailable` map, an explicit `exclude` argument replaces the state-write that made hop selection work, and one `resolveExhaustion` routine gives both the run and complete paths the backoff and exhaustion signal they lack.

**Tech Stack:** Bun 1.4, TypeScript strict, `bun:test`, Biome.

**Spec:** `.nax/specs/failure-recovery-swap-prune.md` (design rationale and rejected alternatives: `docs/superpowers/specs/2026-09-07-failure-recovery-swap-prune-design.md`)

## Global Constraints

- **Branch:** `feat/native-failure-recovery-spec-2`, already created, already carrying the baseline headroom commit `750599feb` and both spec commits. Do not branch again.
- **File-size gate:** `src/agents/manager.ts` may grow to **830** lines and `src/execution/post-run.ts` to **640** — headroom granted by `750599feb` and tracked by #1914. Never run `bun scripts/check-file-sizes.ts --update-baseline`; it regenerates from a scan and silently discards both values.
- **Retry SSOT:** `.nax/rules/retry-strategy.md` forbids inline retry loops and hardcoded delay constants. All retry timing goes through `RetryStrategy`. Cooldown durations are an *availability expiry*, not a retry delay — no cooldown value may ever be passed to `_agentManagerDeps.sleep`.
- **Test placement:** tests mirror `src/`. `src/agents/retry/failure-policy.ts` → `test/unit/agents/retry/failure-policy.test.ts`. Never create files in `test/` root.
- **Test command:** `AGENT=1 timeout 60 bun test <path> --timeout=15000` while iterating. Full suite is `bun run test`. Never bare `bun test` for the full suite.
- **Turbo cache:** a `Cached: N cached` line means the result was replayed, not recomputed. Final verification uses `bun run test --force`.
- **Rules are generated one way:** edit `.nax/rules/`, never `.claude/rules/`. `bun run check:rules-drift` fails if they diverge.
- **Commits:** conventional commits, one concern per commit. Attribution is disabled globally — do not add co-author trailers.

---

### Task 1: The failure policy table

The leaf everything else consumes. No caller yet.

**Files:**
- Create: `src/agents/retry/failure-policy.ts`
- Test: `test/unit/agents/retry/failure-policy.test.ts`

**Interfaces:**
- Consumes: `AdapterFailure` from `@/context/engine`.
- Produces: `export interface FailurePolicy { readonly sameAgentRetry: "none" | "stale" | "timeout" | "adapter-error"; readonly swap: "never" | "immediate" | "after-retry-lane" | "quality-gated"; readonly cooldown: "none" | "run" | { readonly ms: number }; readonly terminalBackoff: boolean }` and `export function failurePolicyFor(outcome: AdapterFailure["outcome"]): FailurePolicy`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/agents/retry/failure-policy.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { failurePolicyFor } from "@/agents/retry/failure-policy";
import type { AdapterFailure } from "@/context/engine";

const ALL_OUTCOMES: ReadonlyArray<AdapterFailure["outcome"]> = [
  "fail-quota",
  "fail-service-down",
  "fail-auth",
  "fail-rate-limit",
  "fail-aborted",
  "fail-stale",
  "fail-timeout",
  "fail-adapter-error",
  "fail-quality",
  "fail-unknown",
];

describe("failurePolicyFor", () => {
  test("returns a fully populated policy for every outcome", () => {
    for (const outcome of ALL_OUTCOMES) {
      const policy = failurePolicyFor(outcome);
      expect(policy.sameAgentRetry).toBeDefined();
      expect(policy.swap).toBeDefined();
      expect(policy.cooldown).toBeDefined();
      expect(typeof policy.terminalBackoff).toBe("boolean");
    }
  });

  test("fail-timeout swaps after its retry lane and never prunes", () => {
    const policy = failurePolicyFor("fail-timeout");
    expect(policy.swap).toBe("after-retry-lane");
    expect(policy.cooldown).toBe("none");
    expect(policy.sameAgentRetry).toBe("timeout");
  });

  test("fail-service-down gets the adapter-error lane and a terminal backoff", () => {
    const policy = failurePolicyFor("fail-service-down");
    expect(policy.sameAgentRetry).toBe("adapter-error");
    expect(policy.terminalBackoff).toBe(true);
  });

  test.each(["fail-auth", "fail-quota"] as const)("%s cools down for the whole run", (outcome) => {
    expect(failurePolicyFor(outcome).cooldown).toBe("run");
  });

  test("fail-aborted never swaps", () => {
    expect(failurePolicyFor("fail-aborted").swap).toBe("never");
  });

  test.each(["fail-quality", "fail-unknown"] as const)("%s stays quality-gated", (outcome) => {
    expect(failurePolicyFor(outcome).swap).toBe("quality-gated");
  });

  test("fail-rate-limit cools down for a finite positive duration", () => {
    const cooldown = failurePolicyFor("fail-rate-limit").cooldown;
    expect(typeof cooldown).toBe("object");
    const ms = (cooldown as { ms: number }).ms;
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `AGENT=1 timeout 60 bun test test/unit/agents/retry/failure-policy.test.ts --timeout=15000`
Expected: FAIL — cannot resolve module `@/agents/retry/failure-policy`.

- [ ] **Step 3: Write minimal implementation**

Create `src/agents/retry/failure-policy.ts`:

```typescript
/**
 * The single source of truth for what an AdapterFailure decides.
 *
 * Before this table, four decisions were spread across four modules and keyed
 * on `AdapterFailure.category` — a two-value field asked to carry more cases
 * than it has values. Two rows were therefore written to steer behaviour
 * rather than describe the fault: `fail-timeout` filed `quality` purely to
 * dodge pruning (nax#1371), and a context overflow filed `availability` though
 * nothing was down. Keying on `outcome` removes the motive for both.
 *
 * `category` is now an observability tag only. Nothing here reads it.
 */

import type { AdapterFailure } from "@/context/engine";

/** How long an agent stays excluded after a failure. */
export type FailureCooldown = "none" | "run" | { readonly ms: number };

export interface FailurePolicy {
  /** Which same-agent retry lane in `trySameAgentRetry` admits this failure. */
  readonly sameAgentRetry: "none" | "stale" | "timeout" | "adapter-error";
  /**
   * Swap eligibility. `after-retry-lane` documents an invariant rather than
   * adding a check: `trySameAgentRetry` runs before `decideSwap` and returns
   * null once its lane is spent, so the lane is spent by construction by the
   * time the swap decision sees the failure. Do not add a second flag.
   */
  readonly swap: "never" | "immediate" | "after-retry-lane" | "quality-gated";
  readonly cooldown: FailureCooldown;
  /** Whether `resolveExhaustion` consults the retry strategy on a terminal exit. */
  readonly terminalBackoff: boolean;
}

/**
 * Default cooldown for a transient availability failure. Not a retry delay --
 * nothing sleeps on it, so it is not a `RetryStrategy` concern and must never
 * be passed to `_agentManagerDeps.sleep`.
 */
const TRANSIENT_COOLDOWN_MS = 60_000;

/**
 * Exhaustive over the outcome union — the compiler rejects a new outcome that
 * forgets a row here, which is the point of the Record type.
 */
const POLICIES: Readonly<Record<AdapterFailure["outcome"], FailurePolicy>> = Object.freeze({
  "fail-auth": { sameAgentRetry: "none", swap: "immediate", cooldown: "run", terminalBackoff: false },
  "fail-quota": { sameAgentRetry: "none", swap: "immediate", cooldown: "run", terminalBackoff: false },
  "fail-rate-limit": {
    sameAgentRetry: "none",
    swap: "immediate",
    cooldown: { ms: TRANSIENT_COOLDOWN_MS },
    terminalBackoff: true,
  },
  "fail-service-down": {
    sameAgentRetry: "adapter-error",
    swap: "immediate",
    cooldown: { ms: TRANSIENT_COOLDOWN_MS },
    terminalBackoff: true,
  },
  "fail-stale": {
    sameAgentRetry: "stale",
    swap: "immediate",
    cooldown: { ms: TRANSIENT_COOLDOWN_MS },
    terminalBackoff: true,
  },
  "fail-timeout": { sameAgentRetry: "timeout", swap: "after-retry-lane", cooldown: "none", terminalBackoff: false },
  "fail-adapter-error": {
    sameAgentRetry: "adapter-error",
    swap: "quality-gated",
    cooldown: "none",
    terminalBackoff: false,
  },
  "fail-quality": { sameAgentRetry: "none", swap: "quality-gated", cooldown: "none", terminalBackoff: false },
  "fail-unknown": { sameAgentRetry: "none", swap: "quality-gated", cooldown: "none", terminalBackoff: false },
  "fail-aborted": { sameAgentRetry: "none", swap: "never", cooldown: "none", terminalBackoff: false },
});

export function failurePolicyFor(outcome: AdapterFailure["outcome"]): FailurePolicy {
  return POLICIES[outcome];
}

/**
 * Resolve a cooldown to an absolute expiry, honouring the provider's own
 * recovery time when it supplied one. A provider asking for 300s parks the
 * agent for 300s rather than the table constant.
 *
 * Invalid provider values (negative, NaN, Infinity) fall back to the constant,
 * mirroring the guard `defaultRetryStrategy` already applies.
 */
export function resolveCooldownExpiry(failure: AdapterFailure, now: number): number | "run" | null {
  const { cooldown } = failurePolicyFor(failure.outcome);
  if (cooldown === "none") return null;
  if (cooldown === "run") return "run";
  const retryAfter = failure.retryAfterSeconds;
  const fromProvider =
    retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : undefined;
  return now + (fromProvider ?? cooldown.ms);
}
```

- [ ] **Step 4: Add the expiry-resolution tests**

Append to `test/unit/agents/retry/failure-policy.test.ts`:

```typescript
import { resolveCooldownExpiry } from "@/agents/retry/failure-policy";

const failure = (
  outcome: AdapterFailure["outcome"],
  retryAfterSeconds?: number,
): AdapterFailure => ({
  category: "availability",
  outcome,
  retriable: true,
  message: "",
  ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
});

describe("resolveCooldownExpiry", () => {
  test("returns null when the policy says never prune", () => {
    expect(resolveCooldownExpiry(failure("fail-timeout"), 1_000)).toBeNull();
  });

  test("returns the run sentinel for a permanent failure", () => {
    expect(resolveCooldownExpiry(failure("fail-auth"), 1_000)).toBe("run");
  });

  test("uses the table constant when the provider said nothing", () => {
    expect(resolveCooldownExpiry(failure("fail-rate-limit"), 1_000)).toBe(61_000);
  });

  test("prefers the provider's retryAfterSeconds over the constant", () => {
    expect(resolveCooldownExpiry(failure("fail-rate-limit", 300), 1_000)).toBe(301_000);
  });

  test.each([-5, Number.NaN, Number.POSITIVE_INFINITY])(
    "falls back to the constant for an invalid retryAfterSeconds (%p)",
    (bad) => {
      expect(resolveCooldownExpiry(failure("fail-rate-limit", bad), 1_000)).toBe(61_000);
    },
  );
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `AGENT=1 timeout 60 bun test test/unit/agents/retry/failure-policy.test.ts --timeout=15000`
Expected: PASS, all cases.

- [ ] **Step 6: Commit**

```bash
git add src/agents/retry/failure-policy.ts test/unit/agents/retry/failure-policy.test.ts
git commit -m "feat(retry): add the outcome-keyed failure policy table"
```

---

### Task 2: The cooldown store

An expiring replacement for the permanent `_unavailable` map, with an injectable clock so no test sleeps.

**Files:**
- Create: `src/agents/cooldown-store.ts`
- Test: `test/unit/agents/cooldown-store.test.ts`

**Interfaces:**
- Consumes: `failurePolicyFor` and `resolveCooldownExpiry` from Task 1.
- Produces: `export class CooldownStore` with `mark(agent: string, failure: AdapterFailure): void`, `isCooling(agent: string): boolean`, `failureFor(agent: string): AdapterFailure | undefined`, `sweepTransient(): void`, `clear(): void`. Constructor takes `now: () => number`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/agents/cooldown-store.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { CooldownStore } from "@/agents/cooldown-store";
import type { AdapterFailure } from "@/context/engine";

const failure = (
  outcome: AdapterFailure["outcome"],
  retryAfterSeconds?: number,
): AdapterFailure => ({
  category: "availability",
  outcome,
  retriable: true,
  message: "",
  ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
});

/** A clock the test advances by hand, so nothing waits in real time. */
function fakeClock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe("CooldownStore", () => {
  test("a rate-limited agent cools down and recovers when the clock passes the expiry", () => {
    const clock = fakeClock();
    const store = new CooldownStore(clock.now);
    store.mark("claude", failure("fail-rate-limit"));

    expect(store.isCooling("claude")).toBe(true);
    clock.advance(30_000);
    expect(store.isCooling("claude")).toBe(true);
    clock.advance(31_000);
    expect(store.isCooling("claude")).toBe(false);
  });

  test("a fail-auth cooldown never expires", () => {
    const clock = fakeClock();
    const store = new CooldownStore(clock.now);
    store.mark("claude", failure("fail-auth"));

    clock.advance(3_600_000);
    expect(store.isCooling("claude")).toBe(true);
  });

  test("the provider's retryAfterSeconds overrides the table constant", () => {
    const clock = fakeClock();
    const store = new CooldownStore(clock.now);
    store.mark("claude", failure("fail-rate-limit", 300));

    clock.advance(120_000);
    expect(store.isCooling("claude")).toBe(true);
    clock.advance(181_000);
    expect(store.isCooling("claude")).toBe(false);
  });

  test("a negative retryAfterSeconds falls back to the table constant", () => {
    const clock = fakeClock();
    const store = new CooldownStore(clock.now);
    store.mark("claude", failure("fail-rate-limit", -5));

    clock.advance(30_000);
    expect(store.isCooling("claude")).toBe(true);
    clock.advance(31_000);
    expect(store.isCooling("claude")).toBe(false);
  });

  test("a fail-timeout never cools the agent down at all", () => {
    const store = new CooldownStore(fakeClock().now);
    store.mark("claude", failure("fail-timeout"));
    expect(store.isCooling("claude")).toBe(false);
  });

  test("sweepTransient clears expiring entries and keeps run-long ones", () => {
    const store = new CooldownStore(fakeClock().now);
    store.mark("claude", failure("fail-rate-limit"));
    store.mark("codex", failure("fail-auth"));

    store.sweepTransient();

    expect(store.isCooling("claude")).toBe(false);
    expect(store.isCooling("codex")).toBe(true);
  });

  test("failureFor returns the recorded failure while the agent is cooling", () => {
    const store = new CooldownStore(fakeClock().now);
    store.mark("claude", failure("fail-rate-limit"));
    expect(store.failureFor("claude")?.outcome).toBe("fail-rate-limit");
  });

  test("clear removes everything, including run-long entries", () => {
    const store = new CooldownStore(fakeClock().now);
    store.mark("claude", failure("fail-auth"));
    store.clear();
    expect(store.isCooling("claude")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `AGENT=1 timeout 60 bun test test/unit/agents/cooldown-store.test.ts --timeout=15000`
Expected: FAIL — cannot resolve module `@/agents/cooldown-store`.

- [ ] **Step 3: Write minimal implementation**

Create `src/agents/cooldown-store.ts`:

```typescript
/**
 * Agent availability with an expiry.
 *
 * Replaces the permanent `Map<string, AdapterFailure>` that `markUnavailable`
 * used to write. That map conflated two meanings — "skip this agent for this
 * hop selection" and "retire this agent" — which is why nax#1371 could not let
 * a wall-clock timeout swap without poisoning the pool. Hop-local exclusion is
 * now an explicit argument to `nextCandidate`; this store owns only retirement,
 * and retirement has a duration.
 *
 * Cooldowns are advisory and evaluated on read, so no sweep is required for
 * correctness. `sweepTransient` exists for the story boundary, where the old
 * `resetTransientUnavailable` contract has to be preserved.
 */

import { resolveCooldownExpiry } from "./retry/failure-policy";
import type { AdapterFailure } from "@/context/engine";

/** `"run"` means no expiry — cleared only by a story-boundary sweep or `clear()`. */
interface CooldownEntry {
  readonly failure: AdapterFailure;
  readonly expiresAt: number | "run";
}

export class CooldownStore {
  private readonly _entries = new Map<string, CooldownEntry>();

  constructor(private readonly _now: () => number) {}

  /** Records a cooldown. A policy cooldown of `none` records nothing. */
  mark(agent: string, failure: AdapterFailure): void {
    const expiresAt = resolveCooldownExpiry(failure, this._now());
    if (expiresAt === null) return;
    this._entries.set(agent, { failure, expiresAt });
  }

  isCooling(agent: string): boolean {
    return this._live(agent) !== undefined;
  }

  failureFor(agent: string): AdapterFailure | undefined {
    return this._live(agent)?.failure;
  }

  /**
   * Story-boundary sweep: drops every expiring entry, keeps run-long ones.
   * Preserves the contract `resetTransientUnavailable` had when it compared
   * outcomes by hand, but sources the distinction from the policy table.
   */
  sweepTransient(): void {
    for (const [agent, entry] of this._entries) {
      if (entry.expiresAt !== "run") this._entries.delete(agent);
    }
  }

  clear(): void {
    this._entries.clear();
  }

  /** Returns the entry only while it is still in force; expires it lazily. */
  private _live(agent: string): CooldownEntry | undefined {
    const entry = this._entries.get(agent);
    if (!entry) return undefined;
    if (entry.expiresAt === "run") return entry;
    if (entry.expiresAt > this._now()) return entry;
    this._entries.delete(agent);
    return undefined;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `AGENT=1 timeout 60 bun test test/unit/agents/cooldown-store.test.ts --timeout=15000`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/agents/cooldown-store.ts test/unit/agents/cooldown-store.test.ts
git commit -m "feat(agents): add an expiring cooldown store for agent availability"
```

---

### Task 3: Wire the manager to the cooldown store, and make exclusion explicit

Replaces `_unavailable` and adds the `exclude` argument. Behaviour visible through the manager's public API is deliberately unchanged for every existing test.

**Files:**
- Modify: `src/agents/manager.ts` — `_agentManagerDeps` (line 70), `_unavailable` field (line 82), `isUnavailable` (154), `markUnavailable` (157), `reset` (162), `resetTransientUnavailable` (167), `_isExcluded` (193), `nextCandidate` (203), and the two `nextCandidate` call sites (402, 563)
- Modify: `src/agents/manager-types.ts` — the `nextCandidate` declaration on the manager interface
- Test: `test/unit/agents/cooldown-integration.test.ts` (create)

**Interfaces:**
- Consumes: `CooldownStore` from Task 2.
- Produces: `nextCandidate(current: string, hopsSoFar: number, exclude?: string): FallbackTarget | null`. `markUnavailable` and `isUnavailable` keep their signatures. `_agentManagerDeps` gains `now: () => number`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/agents/cooldown-integration.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { AgentManager, _agentManagerDeps } from "@/agents/manager";
import type { AdapterFailure } from "@/context/engine";

const failure = (outcome: AdapterFailure["outcome"]): AdapterFailure => ({
  category: "availability",
  outcome,
  retriable: true,
  message: "",
});

const config = () =>
  makeNaxConfig({
    agent: {
      fallback: {
        enabled: true,
        map: { claude: ["codex", "gemini"] },
        maxHopsPerStory: 2,
        onQualityFailure: false,
        rebuildContext: true,
      },
    },
  });

/** Swaps the module-level clock for the duration of one test. */
function withClock<T>(now: () => number, fn: () => T): T {
  const original = _agentManagerDeps.now;
  _agentManagerDeps.now = now;
  try {
    return fn();
  } finally {
    _agentManagerDeps.now = original;
  }
}

describe("AgentManager availability is a cooldown, not a retirement", () => {
  test("a rate-limited agent becomes available again once its cooldown expires", () => {
    let now = 1_000;
    withClock(() => now, () => {
      const manager = new AgentManager(config());
      manager.markUnavailable("codex", failure("fail-rate-limit"));

      expect(manager.isUnavailable("codex")).toBe(true);
      now += 61_000;
      expect(manager.isUnavailable("codex")).toBe(false);
    });
  });

  test("a fail-auth agent stays unavailable no matter how far the clock advances", () => {
    let now = 1_000;
    withClock(() => now, () => {
      const manager = new AgentManager(config());
      manager.markUnavailable("codex", failure("fail-auth"));

      now += 3_600_000;
      expect(manager.isUnavailable("codex")).toBe(true);
    });
  });

  test("a timed-out agent is never marked unavailable at all", () => {
    const manager = new AgentManager(config());
    manager.markUnavailable("codex", failure("fail-timeout"));
    expect(manager.isUnavailable("codex")).toBe(false);
  });
});

describe("AgentManager.nextCandidate explicit exclusion", () => {
  test("skips the excluded agent and returns the next one", () => {
    const manager = new AgentManager(config());
    expect(manager.nextCandidate("claude", 0, "codex")).toEqual({ agent: "gemini" });
  });

  test("returns null when the excluded agent was the only candidate left", () => {
    const manager = new AgentManager(config());
    manager.markUnavailable("gemini", failure("fail-auth"));
    expect(manager.nextCandidate("claude", 0, "codex")).toBeNull();
  });

  test("without an exclude argument it returns what it returns today", () => {
    const manager = new AgentManager(config());
    expect(manager.nextCandidate("claude", 0)).toEqual({ agent: "codex" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `AGENT=1 timeout 60 bun test test/unit/agents/cooldown-integration.test.ts --timeout=15000`
Expected: FAIL — `_agentManagerDeps.now` is undefined, and `nextCandidate` ignores the third argument.

- [ ] **Step 3: Add the clock to the injectable deps**

In `src/agents/manager.ts`, extend the existing `_agentManagerDeps` object (line 70) with a clock, keeping `sleep` exactly as it is:

```typescript
export const _agentManagerDeps = {
  /**
   * Cancellable backoff delay. Delegates to the canonical helper in
   * `src/utils/bun-deps.ts` — see there for the rationale and the
   * coding-standards §6 reference. Exposed on `_deps` so tests can mock it.
   */
  sleep: (ms: number, signal?: AbortSignal) => cancellableDelay(ms, signal),
  /**
   * Clock for cooldown expiry. Exposed so tests can advance time by hand
   * instead of waiting — a cooldown test that slept would take a minute.
   */
  now: () => Date.now(),
};
```

- [ ] **Step 4: Replace the `_unavailable` map with the store**

In `src/agents/manager.ts`, delete the `_unavailable` field (line 82) and add:

```typescript
  private readonly _cooldowns = new CooldownStore(() => _agentManagerDeps.now());
```

Add the import beside the other leaf imports:

```typescript
import { CooldownStore } from "./cooldown-store";
```

Replace the four methods that used the map:

```typescript
  isUnavailable(agent: string): boolean {
    return this._cooldowns.isCooling(agent);
  }

  markUnavailable(agent: string, reason: AdapterFailure): void {
    this._cooldowns.mark(agent, reason);
    this._emitter.emit("onAgentUnavailable", { agent, failure: reason });
  }

  reset(): void {
    this._cooldowns.clear();
    this._prunedFallback.clear();
    this._budget.clear();
  }

  resetTransientUnavailable(): void {
    this._cooldowns.sweepTransient();
  }
```

The `onAgentUnavailable` emit stays unconditional: an observer should still see that the failure happened even when the policy declines to cool the agent down.

- [ ] **Step 5: Make exclusion an argument**

In `src/agents/manager.ts`, change `nextCandidate` (line 203):

```typescript
  nextCandidate(current: string, _hopsSoFar: number, exclude?: string): import("./swap-decision").FallbackTarget | null {
    const excluded = (candidate: string): boolean => candidate === exclude || this._isExcluded(candidate);
    return availableCandidates(this._config.agent?.fallback?.map, current, excluded)[0] ?? null;
  }
```

Update the declaration in `src/agents/manager-types.ts` to match, keeping the third parameter optional so every existing caller compiles unchanged.

- [ ] **Step 6: Pass the just-failed agent at both call sites**

In `src/agents/manager.ts`, the run path (line 396-402) currently marks unavailable *in order to* filter. Make the filtering explicit and let the mark be a pure policy action:

```typescript
        // Cooldown is a policy decision (may be "none"); hop-local exclusion is not.
        // Passing `currentAgent` to nextCandidate is what guarantees we do not
        // re-select the agent that just failed, regardless of its cooldown.
        this.markUnavailable(currentAgent, adapterFailure);

        // Look up the fallback chain by the primary agent so flat maps like
        // { claude: ["codex", "gemini"] } work correctly across multiple hops.
        const next = this.nextCandidate(primaryAgent, hopsSoFar, currentAgent);
```

Apply the identical change on the complete path (line 562-563), replacing its `// Mark unavailable before nextCandidate so the filter excludes the just-failed agent.` comment with the same reasoning:

```typescript
        this.markUnavailable(currentAgent, result.adapterFailure);
        const next = this.nextCandidate(primaryAgent, hopsSoFar, currentAgent);
```

- [ ] **Step 7: Run the new test and the existing manager suites**

Run: `AGENT=1 timeout 90 bun test test/unit/agents/ --timeout=15000`
Expected: PASS. `agent-manager-reset.test.ts`, `manager.test.ts` and `manager-swap-loop.test.ts` must pass **unchanged** — they assert behaviour this task preserves (no clock advance, and `availFailure` is `fail-auth`, whose cooldown is run-long). If any of them fails, the cooldown wiring is wrong; fix the source, not the test.

- [ ] **Step 8: Commit**

```bash
git add src/agents/manager.ts src/agents/manager-types.ts test/unit/agents/cooldown-integration.test.ts
git commit -m "refactor(agents): make availability a cooldown and hop exclusion explicit"
```

---

### Task 4: A timeout swaps without pruning (#1883)

**Files:**
- Modify: `src/agents/swap-decision.ts:57-72` (`decideSwap`)
- Modify: `test/unit/agents/fail-timeout-should-swap.test.ts` — inverts, see Step 4
- Test: `test/unit/agents/swap-decision.test.ts` (extend)

**Interfaces:**
- Consumes: `failurePolicyFor` from Task 1; the cooldown store from Tasks 2-3 is what makes this safe.
- Produces: no signature change. `decideSwap` keeps `(failure, hopsSoFar, fallback) => SwapDecision`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/agents/swap-decision.test.ts`:

```typescript
describe("decideSwap reads the policy table, not the category", () => {
  const ON = { enabled: true, maxHopsPerStory: 2, onQualityFailure: false };

  const failure = (
    outcome: AdapterFailure["outcome"],
    category: "availability" | "quality",
  ): AdapterFailure => ({ category, outcome, retriable: true, message: "" });

  test("a spent-lane fail-timeout now swaps", () => {
    expect(decideSwap(failure("fail-timeout", "quality"), 0, ON)).toEqual({ swap: true });
  });

  test("fail-aborted still refuses at the outcome gate", () => {
    expect(decideSwap(failure("fail-aborted", "availability"), 0, ON)).toEqual({
      swap: false,
      reason: "outcome-refused",
    });
  });

  test("a rate limit mislabelled as quality still swaps", () => {
    // The proof that `category` is no longer a decision input.
    expect(decideSwap(failure("fail-rate-limit", "quality"), 0, ON)).toEqual({ swap: true });
  });

  test("quality outcomes still honour onQualityFailure in both directions", () => {
    expect(decideSwap(failure("fail-quality", "quality"), 0, ON)).toEqual({
      swap: false,
      reason: "quality-failure-declined",
    });
    expect(decideSwap(failure("fail-quality", "quality"), 0, { ...ON, onQualityFailure: true })).toEqual({
      swap: true,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `AGENT=1 timeout 60 bun test test/unit/agents/swap-decision.test.ts --timeout=15000`
Expected: FAIL — "a spent-lane fail-timeout now swaps" gets `{swap: false, reason: "outcome-refused"}`.

- [ ] **Step 3: Write minimal implementation**

In `src/agents/swap-decision.ts`, replace the body of `decideSwap` (keeping the existing doc comment above it, and updating its `fail-timeout` sentence):

```typescript
export function decideSwap(
  failure: AdapterFailure | undefined,
  hopsSoFar: number,
  fallback: SwapFallbackConfig | undefined,
): SwapDecision {
  if (!failure) return { swap: false, reason: "no-failure" };
  const policy = failurePolicyFor(failure.outcome);
  // `fail-aborted` is teardown and must never swap. `fail-timeout` used to share
  // this gate because swapping implied pruning (nax#1371); it no longer does —
  // its policy cooldown is "none", so the agent survives the swap.
  if (policy.swap === "never") return { swap: false, reason: "outcome-refused" };
  if (!fallback?.enabled) return { swap: false, reason: "fallback-disabled" };
  if (hopsSoFar >= (fallback.maxHopsPerStory ?? DEFAULT_MAX_HOPS)) {
    return { swap: false, reason: "hop-cap-reached" };
  }
  if (policy.swap === "quality-gated") {
    return fallback.onQualityFailure ? { swap: true } : { swap: false, reason: "quality-failure-declined" };
  }
  return { swap: true };
}
```

Add the import at the top of the file:

```typescript
import { failurePolicyFor } from "./retry/failure-policy";
```

- [ ] **Step 4: Invert the #1371 regression test**

`test/unit/agents/fail-timeout-should-swap.test.ts` asserts the opposite of the new contract in all three tests, so it must be rewritten — not deleted. The invariant #1371 was defending is *don't poison the pool*, and that invariant still holds; only its mechanism changed. Replace the file's body with:

```typescript
import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { AgentManager } from "@/agents";
import { DEFAULT_CONFIG } from "@/config";
import type { AdapterFailure } from "@/context/engine";

const failTimeoutRetryable: AdapterFailure = {
  category: "quality",
  outcome: "fail-timeout",
  retriable: true,
  message: "wall-clock timeout exceeded",
};

const withFallback = (onQualityFailure: boolean) =>
  makeNaxConfig({
    agent: {
      fallback: {
        enabled: true,
        map: { claude: ["codex"] },
        maxHopsPerStory: 2,
        onQualityFailure,
        rebuildContext: true,
      },
    },
  });

/**
 * nax#1883, superseding nax#1371's US-001 AC10.
 *
 * #1371 made fail-timeout refuse to swap because swapping *was* pruning: the
 * swap branch called markUnavailable and retired the timed-out agent for the
 * rest of the story, so one slow story poisoned the pool. That coupling is
 * gone — fail-timeout's policy cooldown is "none" — so the swap is now safe and
 * the original invariant is asserted directly instead of by proxy.
 */
describe("fail-timeout swaps but never prunes (nax#1883)", () => {
  test("shouldSwap is true once the timeout retry lane is spent", () => {
    expect(new AgentManager(withFallback(false)).shouldSwap(failTimeoutRetryable, 0)).toBe(true);
  });

  test("onQualityFailure does not change the answer in either direction", () => {
    expect(new AgentManager(withFallback(true)).shouldSwap(failTimeoutRetryable, 0)).toBe(true);
    expect(new AgentManager(withFallback(false)).shouldSwap(failTimeoutRetryable, 0)).toBe(true);
  });

  test("still refuses when fallback is disabled entirely", () => {
    expect(new AgentManager(DEFAULT_CONFIG).shouldSwap(failTimeoutRetryable, 0)).toBe(false);
  });

  test("THE #1371 INVARIANT: a timed-out agent is not pruned", () => {
    const manager = new AgentManager(withFallback(false));
    manager.markUnavailable("claude", failTimeoutRetryable);
    expect(manager.isUnavailable("claude")).toBe(false);
  });
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `AGENT=1 timeout 90 bun test test/unit/agents/ --timeout=15000`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agents/swap-decision.ts test/unit/agents/swap-decision.test.ts test/unit/agents/fail-timeout-should-swap.test.ts
git commit -m "fix(agents): let a spent-lane timeout swap without pruning the agent

Closes #1883."
```

---

### Task 5: A stalled stream retries on the same agent (#1884)

**Files:**
- Modify: `src/agents/retry/hop-retry-policy.ts:80-155` (`trySameAgentRetry`)
- Test: `test/unit/agents/retry/hop-retry-policy.test.ts` (extend, or create if absent)

**Interfaces:**
- Consumes: `failurePolicyFor` from Task 1.
- Produces: no signature change. Lane caps and returned shapes are untouched.

- [ ] **Step 1: Write the failing test**

Append to the hop-retry-policy test file (create it at `test/unit/agents/retry/hop-retry-policy.test.ts` if it does not exist, importing `trySameAgentRetry` from `@/agents/retry/hop-retry-policy`):

```typescript
describe("trySameAgentRetry admits fail-service-down (nax#1884)", () => {
  const serviceDown = {
    output: "",
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
    estimatedCostUsd: 0,
    adapterFailure: {
      category: "availability" as const,
      outcome: "fail-service-down" as const,
      retriable: true,
      message: "provider stalled",
    },
  };

  const state = (adapterErrorRetries: number) => ({
    staleRetryAttempts: 0,
    timeoutRetryAttempts: 0,
    adapterErrorRetries,
    currentRunOptions: makeRunOptions(),
    tier: undefined,
  });

  const deps = () => ({
    config: makeNaxConfig({ execution: { sessionErrorRetryableMaxRetries: 3 } }),
    requestRunOptions: makeRunOptions(),
  });

  test("retries on the same agent while under the cap", () => {
    const result = trySameAgentRetry(serviceDown, state(0), deps());
    expect(result).not.toBeNull();
    expect(result?.outcome).toBe("adapter-error");
  });

  test("returns null once the cap is reached, so the swap path is reached", () => {
    expect(trySameAgentRetry(serviceDown, state(3), deps())).toBeNull();
  });

  test("a fail-stale still takes the stale lane, unchanged", () => {
    const stale = {
      ...serviceDown,
      adapterFailure: { ...serviceDown.adapterFailure, outcome: "fail-stale" as const },
    };
    expect(trySameAgentRetry(stale, state(0), deps())?.outcome).toBe("stale-retry");
  });
});
```

Import the helpers this file needs from `@test/helpers` (`makeNaxConfig`, and a `makeRunOptions` local factory matching the one in `test/unit/agents/manager-swap-loop.test.ts` if the shared helper does not export one).

- [ ] **Step 2: Run test to verify it fails**

Run: `AGENT=1 timeout 60 bun test test/unit/agents/retry/hop-retry-policy.test.ts --timeout=15000`
Expected: FAIL — "retries on the same agent while under the cap" gets `null`.

- [ ] **Step 3: Write minimal implementation**

In `src/agents/retry/hop-retry-policy.ts`, replace the three literal outcome comparisons with lane lookups from the table. The stale branch becomes:

```typescript
  const outcome = result.adapterFailure?.outcome;
  const lane = outcome ? failurePolicyFor(outcome).sameAgentRetry : "none";

  // fail-stale: same-agent retries up to maxRetryAttempts before swap or terminal failure.
  const isFailStale = lane === "stale";
```

the timeout branch becomes:

```typescript
  // fail-timeout: same-agent retry with reduced budget and fresh session.
  const isFailTimeout = lane === "timeout";
```

and the adapter-error branch becomes:

```typescript
  // adapter-error lane: acpx session errors, and (nax#1884) a stalled provider
  // stream, which classifies fail-service-down since nax#1869. Before that fix
  // the same fault synthesised fail-adapter-error and got these retries; the
  // classification got more accurate and the retry was lost.
  const isFailAdapterError = lane === "adapter-error";
```

Leave every cap, option and returned shape exactly as they are — only lane admission changes. Add the import:

```typescript
import { failurePolicyFor } from "./failure-policy";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `AGENT=1 timeout 90 bun test test/unit/agents/ --timeout=15000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/retry/hop-retry-policy.ts test/unit/agents/retry/hop-retry-policy.test.ts
git commit -m "fix(retry): admit fail-service-down to the same-agent retry lane

Closes #1884."
```

---

### Task 6: The shared exhaustion routine

**Files:**
- Create: `src/agents/retry/resolve-exhaustion.ts`
- Test: `test/unit/agents/retry/resolve-exhaustion.test.ts`

**Interfaces:**
- Consumes: `failurePolicyFor` (Task 1), `RetryStrategy` / `RetryContext` / `RetryDecision` from `./types`.
- Produces:

```typescript
export type ExhaustionOutcome = "retry" | "exhausted" | "cancelled";
export interface ResolveExhaustionInput {
  readonly failure: AdapterFailure | undefined;
  readonly attempt: number;
  readonly hopsSoFar: number;
  /** True only when a swap was possible and had nowhere to go, or the hop cap was hit. */
  readonly swapWasPossible: boolean;
  readonly retryStrategy: RetryStrategy;
  readonly retryCtx: RetryContext;
  readonly signal?: AbortSignal;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly onExhausted: (hops: number) => void;
}
export function resolveExhaustion(input: ResolveExhaustionInput): Promise<ExhaustionOutcome>;
```

- [ ] **Step 1: Write the failing test**

Create `test/unit/agents/retry/resolve-exhaustion.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { resolveExhaustion } from "@/agents/retry/resolve-exhaustion";
import type { RetryContext, RetryStrategy } from "@/agents/retry/types";
import type { AdapterFailure } from "@/context/engine";

const failure = (
  outcome: AdapterFailure["outcome"],
  retryAfterSeconds?: number,
): AdapterFailure => ({
  category: "availability",
  outcome,
  retriable: true,
  message: "",
  ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
});

const retryCtx: RetryContext = { site: "run", agentName: "claude", stage: "run", storyId: "us-001" };

const alwaysRetry: RetryStrategy = { shouldRetry: () => ({ retry: true, delayMs: 45_000 }) };
const neverRetry: RetryStrategy = { shouldRetry: () => ({ retry: false }) };

function harness(overrides: Partial<Parameters<typeof resolveExhaustion>[0]> = {}) {
  const slept: number[] = [];
  const exhausted: number[] = [];
  const input = {
    failure: failure("fail-rate-limit"),
    attempt: 0,
    hopsSoFar: 0,
    swapWasPossible: true,
    retryStrategy: alwaysRetry,
    retryCtx,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
    onExhausted: (hops: number) => {
      exhausted.push(hops);
    },
    ...overrides,
  };
  return { input, slept, exhausted };
}

describe("resolveExhaustion", () => {
  test("backs off for the granted delay and reports retry", async () => {
    const { input, slept, exhausted } = harness();
    expect(await resolveExhaustion(input)).toBe("retry");
    expect(slept).toEqual([45_000]);
    expect(exhausted).toEqual([]);
  });

  test("does not consult the strategy when the policy sets terminalBackoff false", async () => {
    let consulted = false;
    const spy: RetryStrategy = {
      shouldRetry: () => {
        consulted = true;
        return { retry: true, delayMs: 1 };
      },
    };
    const { input, slept } = harness({ failure: failure("fail-quality"), retryStrategy: spy });
    expect(await resolveExhaustion(input)).toBe("exhausted");
    expect(consulted).toBe(false);
    expect(slept).toEqual([]);
  });

  test("with no failure it neither backs off nor emits", async () => {
    const { input, slept, exhausted } = harness({ failure: undefined, swapWasPossible: false });
    expect(await resolveExhaustion(input)).toBe("exhausted");
    expect(slept).toEqual([]);
    expect(exhausted).toEqual([]);
  });

  test("an aborted signal cancels without emitting", async () => {
    const controller = new AbortController();
    controller.abort();
    const { input, exhausted } = harness({ signal: controller.signal });
    expect(await resolveExhaustion(input)).toBe("cancelled");
    expect(exhausted).toEqual([]);
  });

  test("emits onExhausted with the hop count when a swap was possible", async () => {
    const { input, exhausted } = harness({ retryStrategy: neverRetry, hopsSoFar: 2 });
    expect(await resolveExhaustion(input)).toBe("exhausted");
    expect(exhausted).toEqual([2]);
  });

  test("emits at hops 0 — the cliff that previously reported nothing", async () => {
    const { input, exhausted } = harness({ retryStrategy: neverRetry, hopsSoFar: 0 });
    expect(await resolveExhaustion(input)).toBe("exhausted");
    expect(exhausted).toEqual([0]);
  });

  test("a policy decline backs off but does not emit — it is not exhaustion", async () => {
    const { input, slept, exhausted } = harness({ retryStrategy: neverRetry, swapWasPossible: false });
    expect(await resolveExhaustion(input)).toBe("exhausted");
    expect(exhausted).toEqual([]);
    expect(slept).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `AGENT=1 timeout 60 bun test test/unit/agents/retry/resolve-exhaustion.test.ts --timeout=15000`
Expected: FAIL — cannot resolve module `@/agents/retry/resolve-exhaustion`.

- [ ] **Step 3: Write minimal implementation**

Create `src/agents/retry/resolve-exhaustion.ts`:

```typescript
/**
 * The single terminal exit for a dispatch that cannot proceed.
 *
 * Before this module the rate-limit backoff lived *inside* the declined-swap
 * branch of `runWithFallback`, so a 429 that `decideSwap` accepted and then
 * found no candidate for died instantly — strictly worse than the same failure
 * being declined one branch away. `completeWithFallback` had no backoff at all
 * and never emitted `onSwapExhausted`.
 *
 * Backoff and the exhaustion event are separate concerns and do not fire
 * together. Backoff follows the failure's policy. The event fires only when a
 * swap was genuinely possible and had nowhere to go — a policy decline
 * (fallback disabled, quality declined, teardown) is not exhaustion, and
 * emitting there would displace the decline log as a distinct signal.
 */

import { failurePolicyFor } from "./failure-policy";
import type { RetryContext, RetryStrategy } from "./types";
import type { AdapterFailure } from "@/context/engine";

export type ExhaustionOutcome = "retry" | "exhausted" | "cancelled";

export interface ResolveExhaustionInput {
  readonly failure: AdapterFailure | undefined;
  readonly attempt: number;
  readonly hopsSoFar: number;
  /** True only when a swap was possible and had nowhere to go, or the hop cap was hit. */
  readonly swapWasPossible: boolean;
  readonly retryStrategy: RetryStrategy;
  readonly retryCtx: RetryContext;
  readonly signal?: AbortSignal;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly onExhausted: (hops: number) => void;
}

export async function resolveExhaustion(input: ResolveExhaustionInput): Promise<ExhaustionOutcome> {
  const { failure, retryStrategy, retryCtx, signal, sleep, onExhausted } = input;
  if (signal?.aborted) return "cancelled";

  if (failure && failurePolicyFor(failure.outcome).terminalBackoff) {
    const decision = retryStrategy.shouldRetry(failure, input.attempt, retryCtx);
    if (decision.retry) {
      await sleep(decision.delayMs, signal);
      return signal?.aborted ? "cancelled" : "retry";
    }
  }

  if (input.swapWasPossible) onExhausted(input.hopsSoFar);
  return "exhausted";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `AGENT=1 timeout 60 bun test test/unit/agents/retry/resolve-exhaustion.test.ts --timeout=15000`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/agents/retry/resolve-exhaustion.ts test/unit/agents/retry/resolve-exhaustion.test.ts
git commit -m "feat(retry): add one terminal exhaustion routine for both dispatch paths"
```

---

### Task 7: Wire the exhaustion routine into both paths

The manager change. Watch the file-size ceiling: this task must remove the inline backoff block it replaces.

**Files:**
- Modify: `src/agents/manager.ts` — the run path's inline backoff (roughly lines 349-386) and the complete path's terminal exits (roughly lines 553-566)
- Modify: `src/agents/retry/default-strategy.ts` — accept the outcomes the table marks `terminalBackoff`
- Test: `test/unit/agents/retry/default-strategy.test.ts` (extend), `test/unit/agents/manager-exhaustion.test.ts` (create)

**Interfaces:**
- Consumes: `resolveExhaustion` (Task 6), `failurePolicyFor` (Task 1).
- Produces: no public signature change on `AgentManager`.

- [ ] **Step 1: Write the failing test for the strategy**

Append to `test/unit/agents/retry/default-strategy.test.ts`:

```typescript
describe("defaultRetryStrategy follows the policy table", () => {
  const ctx = { site: "run", agentName: "claude", stage: "run", storyId: "us-001" } as const;

  const failure = (outcome: AdapterFailure["outcome"]): AdapterFailure => ({
    category: "availability",
    outcome,
    retriable: true,
    message: "",
  });

  test("retries fail-service-down, which it used to decline", () => {
    expect(defaultRetryStrategy.shouldRetry(failure("fail-service-down"), 0, ctx)).toEqual({
      retry: true,
      delayMs: 2_000,
    });
  });

  test("still declines a quality failure", () => {
    expect(defaultRetryStrategy.shouldRetry(failure("fail-quality"), 0, ctx)).toEqual({ retry: false });
  });

  test("still honours the provider's retryAfterSeconds over the computed backoff", () => {
    const withRetryAfter = { ...failure("fail-rate-limit"), retryAfterSeconds: 45 };
    expect(defaultRetryStrategy.shouldRetry(withRetryAfter, 0, ctx)).toEqual({ retry: true, delayMs: 45_000 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `AGENT=1 timeout 60 bun test test/unit/agents/retry/default-strategy.test.ts --timeout=15000`
Expected: FAIL — `fail-service-down` returns `{retry: false}`.

- [ ] **Step 3: Make the strategy read the table**

In `src/agents/retry/default-strategy.ts`, replace the outcome check:

```typescript
    if (!failurePolicyFor(af.outcome).terminalBackoff) return { retry: false };
```

replacing the line `if (af.outcome !== "fail-rate-limit" && af.outcome !== "fail-stale") return { retry: false };`. Add the import, and update the doc comment above the export so it no longer claims the strategy fires "only on `fail-rate-limit`" — it already accepted `fail-stale` before this change, so the comment was stale on arrival.

- [ ] **Step 4: Write the failing integration test**

Create `test/unit/agents/manager-exhaustion.test.ts`. The harness below mirrors
`test/unit/agents/manager-swap-loop.test.ts`, which is the reference for this file's setup.

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import type { AdapterFailure, ContextBundle } from "@/context/engine";
import type { AgentRunOptions } from "@/agents";
import { _agentManagerDeps, AgentManager } from "@/agents";
import { DEFAULT_CONFIG } from "@/config";
import { agentManagerConfigSelector } from "@/config/selectors";

const mockBundle = {} as ContextBundle;

const rateLimit: AdapterFailure = {
  category: "availability",
  outcome: "fail-rate-limit",
  retriable: true,
  message: "429",
  retryAfterSeconds: 45,
};

function makeRunOptions(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    prompt: "p",
    workdir: "/tmp",
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
    timeoutSeconds: 60,
    config: agentManagerConfigSelector.select(DEFAULT_CONFIG),
    storyId: "s1",
    ...overrides,
  };
}

/** `map: {}` is the cliff: decideSwap accepts, nextCandidate finds nobody. */
function makeConfig(opts: { enabled: boolean; map?: Record<string, string[]> }) {
  return makeNaxConfig({
    agent: {
      fallback: {
        enabled: opts.enabled,
        map: opts.map ?? {},
        maxHopsPerStory: 2,
        onQualityFailure: false,
        rebuildContext: false,
      },
    },
  });
}

/** Every hop fails with the same rate limit. */
const alwaysRateLimited = async (name: string) => ({
  prompt: `prompt-${name}`,
  result: {
    success: false,
    exitCode: 1,
    output: "rate limited",
    rateLimited: true,
    durationMs: 1,
    estimatedCostUsd: 0,
    adapterFailure: rateLimit,
  },
});

const originalSleep = _agentManagerDeps.sleep;
afterEach(() => {
  _agentManagerDeps.sleep = originalSleep;
});

/** Captures the delays handed to the injected sleep; nothing waits in real time. */
function captureSleeps(): number[] {
  const slept: number[] = [];
  _agentManagerDeps.sleep = async (ms: number) => {
    slept.push(ms);
  };
  return slept;
}

describe("exhaustion on the run path", () => {
  test("a rate limit with no candidate backs off on the provider's delay and emits at hops 0", async () => {
    const slept = captureSleeps();
    const manager = new AgentManager(makeConfig({ enabled: true }), undefined, {
      runHop: alwaysRateLimited,
    });
    const exhausted: Array<{ hops: number }> = [];
    manager.events.on("onSwapExhausted", (e) => exhausted.push(e as { hops: number }));

    await manager.runWithFallback({ runOptions: makeRunOptions(), bundle: mockBundle });

    expect(slept).toContain(45_000);
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.hops).toBe(0);
  });

  test("a policy decline backs off but does not emit — it is not exhaustion", async () => {
    const slept = captureSleeps();
    const manager = new AgentManager(makeConfig({ enabled: false }), undefined, {
      runHop: alwaysRateLimited,
    });
    const exhausted: unknown[] = [];
    manager.events.on("onSwapExhausted", (e) => exhausted.push(e));

    await manager.runWithFallback({ runOptions: makeRunOptions(), bundle: mockBundle });

    expect(slept).toContain(45_000);
    expect(exhausted).toEqual([]);
  });
});
```

The complete path needs an adapter stub rather than a `runHop`, so it takes a registry.
Mirror `test/unit/agents/manager-complete.test.ts` for the registry helper and append:

```typescript
describe("exhaustion on the complete path", () => {
  test("a rate limit with no candidate now backs off and emits, where it previously did neither", async () => {
    const slept = captureSleeps();
    const registry = makeAgentRegistry({
      claude: makeAgentAdapter({
        complete: async () => ({
          output: "",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
          adapterFailure: rateLimit,
        }),
      }),
    });
    const manager = new AgentManager(makeConfig({ enabled: true }), registry);
    const exhausted: unknown[] = [];
    manager.events.on("onSwapExhausted", (e) => exhausted.push(e));

    await manager.completeWithFallback("prompt", { storyId: "s1" });

    expect(slept).toContain(45_000);
    expect(exhausted).toHaveLength(1);
  });
});
```

Import `makeAgentAdapter` and `makeAgentRegistry` from `@test/helpers` — the same
two helpers `test/unit/agents/swap-decline-log.test.ts` imports. Match
`completeWithFallback`'s real argument shape from `manager-complete.test.ts`
rather than guessing it.

- [ ] **Step 5: Run it to verify it fails**

Run: `AGENT=1 timeout 60 bun test test/unit/agents/manager-exhaustion.test.ts --timeout=15000`
Expected: FAIL — the run-path test sees no `onSwapExhausted` at hops 0, and the complete-path test sees neither a sleep nor an event.

- [ ] **Step 6: Replace the run path's inline backoff**

In `src/agents/manager.ts`, the declined-swap branch currently inlines the whole retry-strategy consultation, the abort checks and the sleep (roughly lines 349-379), and the accepted-but-no-candidate exit below it emits with no backoff. Replace both with one call. The declined branch becomes:

```typescript
        if (!swapDecision.swap) {
          // #1713: the neighbouring terminal exits below emit; this one was silent.
          logSwapDecline(logger, swapDecision.reason, {
            storyId: request.runOptions.storyId,
            agent: currentAgent,
            hopsSoFar,
            failure: result.adapterFailure,
          });
          // For fail-stale with no swap available: exit immediately without backoff.
          // The session was stale — retrying with backoff won't help if no fallback exists.
          if (isFailStale) {
            logger?.warn("agent-manager", "fail-stale: no swap candidate, returning terminal failure", {
              storyId: request.runOptions.storyId,
            });
            _finalStatus = "error";
            return { result, fallbacks, finalBundle: updatedBundle, finalPrompt, finalAgent: currentAgent };
          }
          const outcome = await this._resolveExhaustion(request, result.adapterFailure, {
            hopsSoFar,
            attempt: rateLimitRetry,
            swapWasPossible: false,
            agent: currentAgent,
            site: "run",
          });
          if (outcome === "cancelled") {
            _finalStatus = "cancelled";
            return { result, fallbacks, finalBundle: updatedBundle, finalPrompt, finalAgent: currentAgent };
          }
          if (outcome === "retry") {
            rateLimitRetry += 1;
            continue;
          }
          _finalStatus = hopsSoFar > 0 ? "exhausted" : "error";
          return { result, fallbacks, finalBundle: updatedBundle, finalPrompt, finalAgent: currentAgent };
        }
```

and the no-candidate exit becomes:

```typescript
        const next = this.nextCandidate(primaryAgent, hopsSoFar, currentAgent);
        if (!next) {
          const outcome = await this._resolveExhaustion(request, adapterFailure, {
            hopsSoFar,
            attempt: rateLimitRetry,
            swapWasPossible: true,
            agent: currentAgent,
            site: "run",
          });
          if (outcome === "cancelled") {
            _finalStatus = "cancelled";
            return { result, fallbacks, finalBundle: updatedBundle, finalPrompt, finalAgent: currentAgent };
          }
          if (outcome === "retry") {
            rateLimitRetry += 1;
            continue;
          }
          _finalStatus = "exhausted";
          return { result, fallbacks, finalBundle: updatedBundle, finalPrompt, finalAgent: currentAgent };
        }
```

Add one private helper so both paths and the complete path share the wiring, and so `manager.ts` shrinks rather than grows:

```typescript
  /** Adapts the manager's state to `resolveExhaustion`'s pure input. */
  private _resolveExhaustion(
    request: { runOptions: { storyId?: string; pipelineStage?: PipelineStage }; signal?: AbortSignal },
    failure: AdapterFailure | undefined,
    opts: { hopsSoFar: number; attempt: number; swapWasPossible: boolean; agent: string; site: "run" | "complete" },
  ): Promise<ExhaustionOutcome> {
    return resolveExhaustion({
      failure,
      attempt: opts.attempt,
      hopsSoFar: opts.hopsSoFar,
      swapWasPossible: opts.swapWasPossible,
      retryStrategy: this._retryStrategy,
      retryCtx: {
        site: opts.site,
        agentName: opts.agent,
        stage: request.runOptions.pipelineStage ?? "run",
        storyId: request.runOptions.storyId,
      },
      signal: request.signal,
      sleep: (ms, signal) => _agentManagerDeps.sleep(ms, signal),
      onExhausted: (hops) => {
        this._emitter.emit("onSwapExhausted", { storyId: request.runOptions.storyId, hops });
      },
    });
  }
```

Delete the now-dead `hopsSoFar > 0 ? emit : silent` block that previously sat below the declined branch — `resolveExhaustion` owns that emission now.

- [ ] **Step 7: Wire the complete path**

In `completeWithFallback`, replace both terminal exits (the declined-swap return and the null-candidate return) with the same helper, passing `site: "complete"` and `swapWasPossible: false` / `true` respectively. The complete path has no `rateLimitRetry` counter today; add one initialised to `0` beside `staleRetryAttempts` and increment it on a `"retry"` outcome, mirroring the run path.

- [ ] **Step 8: Run the tests**

Run: `AGENT=1 timeout 120 bun test test/unit/agents/ --timeout=15000`
Expected: PASS, including `manager-swap-loop.test.ts` unchanged — it asserts exactly one `onSwapExhausted` when both agents fail, which this change preserves.

- [ ] **Step 9: Check the file-size gate before committing**

Run: `bun run check:file-sizes`
Expected: OK. `src/agents/manager.ts` must be at or under **830**. If it is over, the inline block from Step 6 was not fully removed.

- [ ] **Step 10: Commit**

```bash
git add src/agents/manager.ts src/agents/retry/default-strategy.ts test/unit/agents/manager-exhaustion.test.ts test/unit/agents/retry/default-strategy.test.ts
git commit -m "fix(agents): give both dispatch paths one exhaustion routine with backoff"
```

---

### Task 8: A rate-limited story escalates instead of parking (#1892)

**Files:**
- Modify: `src/execution/post-run.ts` — the inspection result around line 146, `needsHumanReview` at line 298, and the pause branch at 507-531
- Modify: `test/unit/execution/execution-stage.test.ts` — rewire the bypassing test
- Modify: `test/integration/pipeline/pipeline.test.ts` — rewire the bypassing tests
- Test: `test/unit/execution/post-run-decide-action.test.ts` (extend)

**Interfaces:**
- Consumes: nothing from earlier tasks — this task is independent and may be done in any order.
- Produces: `PostRunInspectionResult` gains `readonly providerUnavailable: boolean`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/execution/post-run-decide-action.test.ts`, mirroring the fixture style of the existing `session-failure` tests at lines 108-132:

```typescript
describe("session-failure caused by the provider escalates (nax#1892)", () => {
  test.each(["fail-rate-limit", "fail-quota", "fail-service-down"] as const)(
    "%s escalates rather than pausing",
    async (outcome) => {
      const result = await decideStageAction(
        makeCtx(),
        makePlanResult(),
        makeInspection({ failureCategory: "session-failure", providerUnavailable: true, outcome }),
        makeOpts(),
      );
      expect(result.action).toBe("escalate");
    },
  );

  test("a genuine session failure still pauses with the unchanged reason", async () => {
    const result = await decideStageAction(
      makeCtx(),
      makePlanResult(),
      makeInspection({ failureCategory: "session-failure", providerUnavailable: false }),
      makeOpts(),
    );
    expect(result).toEqual({ action: "pause", reason: "Human review needed: session-failure" });
  });
});
```

Extend the file's existing inspection factory to accept `providerUnavailable`, defaulting it to `false` so every existing test keeps its current meaning.

- [ ] **Step 2: Run it to verify it fails**

Run: `AGENT=1 timeout 60 bun test test/unit/execution/post-run-decide-action.test.ts --timeout=15000`
Expected: FAIL — the escalate cases return `{action: "pause"}`.

- [ ] **Step 3: Compute the flag at the seam spec 1 already built**

In `src/execution/post-run.ts`, the inspection already reads the story's last adapter failure at line 141 and derives `rateLimited` from it at line 146 (spec 1's #1897 fix). Widen that same read rather than adding a second source of truth:

```typescript
  const lastFailure = ctx.runtime.lastAdapterFailure.get(ctx.story.id);
  /**
   * A session failure the provider caused, not one a human must look at.
   * nax#1892: `needsHumanReview` fired on the category alone, so a rate limit
   * parked the story at attempt 1 while an identically-caused story on a
   * different test strategy escalated and passed.
   */
  const providerUnavailable =
    lastFailure?.outcome === "fail-rate-limit" ||
    lastFailure?.outcome === "fail-quota" ||
    lastFailure?.outcome === "fail-service-down";
```

Add `providerUnavailable` to the `PostRunInspectionResult` interface (line 56) and to the object the function returns.

- [ ] **Step 4: Gate the pause on it**

At line 298, narrow the flag:

```typescript
  const needsHumanReview = failureCategory === "session-failure" && !providerUnavailable;
```

Destructure `providerUnavailable` alongside the other inspection fields in `decideStageAction` (line 342). The pause branch and its reason string are otherwise untouched, so a genuine session failure behaves exactly as before, and a provider-caused one now falls through to `routeTddFailure`, whose `session-failure` arm becomes reachable for the first time.

- [ ] **Step 5: Rewire the two tests that assert an unreachable path**

`test/unit/execution/execution-stage.test.ts:57` and `test/integration/pipeline/pipeline.test.ts:474-476` assert `escalate` by calling `routeTddFailure` directly, bypassing `decideStageAction`. They pass today and would keep passing, while pinning a path that never ran — which is why the suite encoded both answers. Drive each through `decideStageAction` with `providerUnavailable: true`, keeping the same expectation. Leave the `tests-failing` cases in those files alone.

- [ ] **Step 6: Run the tests**

Run: `AGENT=1 timeout 90 bun test test/unit/execution/ test/integration/pipeline/ --timeout=15000`
Expected: PASS.

- [ ] **Step 7: Check the file-size gate**

Run: `bun run check:file-sizes`
Expected: OK, with `src/execution/post-run.ts` at or under **640**.

- [ ] **Step 8: Commit**

```bash
git add src/execution/post-run.ts test/unit/execution/post-run-decide-action.test.ts test/unit/execution/execution-stage.test.ts test/integration/pipeline/pipeline.test.ts
git commit -m "fix(execution): let a provider-caused session failure escalate

Closes #1892."
```

---

### Task 9: Terminal cleanup — the rules SSOT and two stale comments

Documentation only. Must land after Tasks 4-7, because it documents behaviour they create.

**Files:**
- Modify: `.nax/rules/retry-strategy.md`
- Modify: `src/agents/native/errors.ts` — the header comment
- Regenerate: `.claude/rules/retry-strategy.md`

**Interfaces:**
- Consumes: the behaviour from Tasks 4-7. Produces nothing code-facing.

- [ ] **Step 1: Correct the manager-tier claims in the canonical rule store**

In `.nax/rules/retry-strategy.md`:

- The two-tier table says `defaultRetryStrategy` is "rate-limit only, 3 retries". It already accepted `fail-stale` before this spec, and now also accepts `fail-service-down`. State that the accepted set is whatever `failurePolicyFor(outcome).terminalBackoff` marks, and name the three current members.
- The `defaultRetryStrategy` section repeats "Fires **only** on `fail-rate-limit` outcome" — same correction.
- The "Manager-tier concerns" paragraph names `fail-rate-limit` and `fail-stale` as the outcomes op-tier strategies must not handle. Add `fail-service-down`, since Task 5 promoted it.
- Add a short subsection recording that cooldown durations are an availability expiry rather than a retry delay, so a future reader does not mistake the policy table's constants for a violation of the no-hardcoded-delays rule.

- [ ] **Step 2: Correct the stale header in the native error table**

`src/agents/native/errors.ts`'s header still says *"The category split is load-bearing: shouldSwap's fallback branch only accepts 'availability', so a kind filed under 'quality' is terminal for the op."* Task 4 made that false — `decideSwap` reads the policy table and never reads `category`. Replace those two sentences with a note that `category` is an observability tag and that swap behaviour comes from `failurePolicyFor`.

- [ ] **Step 3: Regenerate the Claude-side mirror**

Run: `nax generate`
Then: `bun run check:rules-drift`
Expected: OK. If `nax generate` is unavailable in the environment, copy `.nax/rules/retry-strategy.md` to `.claude/rules/retry-strategy.md` verbatim and re-run the check — the drift check compares content, and `.claude/rules/` is generated output that is never hand-authored.

- [ ] **Step 4: Close #1900 rather than fixing it**

#1900 reports that the header claims the failure table "does not govern a session turn". That sentence no longer exists — spec 1 rewrote the header in `c9d360ca7`. Do not hunt for it. Close the issue as already-fixed:

```bash
gh issue close 1900 --comment "Fixed by #1913 (\`c9d360ca7\`), which rewrote this header — the \"does not govern a session turn\" sentence no longer exists in \`src/agents/native/errors.ts\`. The remaining stale claim in that header (the category split being load-bearing for shouldSwap) is corrected by the failure-recovery spec 2 branch, which makes \`decideSwap\` read the policy table instead of \`category\`."
```

- [ ] **Step 5: Commit**

```bash
git add .nax/rules/retry-strategy.md .claude/rules/retry-strategy.md src/agents/native/errors.ts
git commit -m "docs(retry): record the manager tier's real accepted outcomes"
```

---

### Task 10: Full verification and PR

**Files:** none modified.

**Interfaces:**
- Consumes: Tasks 1-9. Produces a green tree and an open PR.

- [ ] **Step 1: Run the full suite, forcing past the turbo cache**

```bash
bun run test --force
```

`--force` is required. A `Cached: N cached` line means the result was replayed and is not evidence of anything.

- [ ] **Step 2: Run the gates**

```bash
bun run typecheck && bun run lint && bun run check:rules-drift
```

Expected: all green, including `check:file-sizes` with `manager.ts` ≤ 830 and `post-run.ts` ≤ 640. `check:rules-drift` is in `check:all`, not `lint`, which is why it is named separately here.

- [ ] **Step 3: Confirm every spec verification anchor has a home**

Walk the six AC blocks in `.nax/specs/failure-recovery-swap-prune.md` and confirm each numbered criterion is covered by a test written in Tasks 1-8. Report any criterion with no covering test rather than quietly skipping it. US-006 has no ACs by design — its verification is the gate run in Step 2.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin feat/native-failure-recovery-spec-2
gh pr create --fill
```

State in the body that this is spec 2 of the failure-recovery arc, that it closes #1883, #1884 and #1892, that #1900 was closed as already-fixed by #1913, and that #1914 tracks removing the temporary file-size headroom this PR relies on.

- [ ] **Step 5: Report what spec 3 now needs**

Spec 3 (the binding lattice and peer map) was deliberately deferred so it could be designed on measurements. Two of the three now become collectable from ordinary runs, because this spec makes them observable:

1. **Cliff frequency** — count `onSwapExhausted` events carrying `hops: 0`. These were emitted by nothing before Task 7.
2. **Real unavailability** — how long agents actually spend cooling down, from the cooldown store's expiries.
3. **The `retryAfter` distribution** — still owed by spec 1, and still needs one real run on the native profile.

Do **not** launch a `nax run` to collect these. That needs explicit approval from the user at the launch moment.
