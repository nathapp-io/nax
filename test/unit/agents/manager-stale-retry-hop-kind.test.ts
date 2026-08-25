/**
 * Unit tests — runWithFallback passes correct HopKind to executeHop.
 *
 * Verifies that:
 * - Primary hop receives { kind: "primary" }
 * - Stale-retry hop receives { kind: "stale-retry", attempt: N }
 * - Swap hop receives { kind: "swap", failure }
 *
 * Does not exercise the real session stack — executeHop is a stub.
 */

import { describe, expect, test } from "bun:test";
import { makeContextBundle, makeNaxConfig } from "@test/helpers";
import type { AgentResult, HopKind } from "@/agents";
import { AgentManager } from "@/agents";
import type { AdapterFailure } from "@/context/engine";

const STALE_FAILURE: AdapterFailure = {
  category: "availability",
  outcome: "fail-stale",
  retriable: true,
  message: "idle timeout",
};

const AUTH_FAILURE: AdapterFailure = {
  category: "availability",
  outcome: "fail-auth",
  retriable: false,
  message: "401",
};

const STUB_BUNDLE = makeContextBundle({
  pullTools: [],
  digest: "",
  chunks: [],
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const STUB_RUN_OPTIONS = { prompt: "do it", workdir: "/tmp", storyId: "US-001" } as any;

function makeSuccessResult(): AgentResult {
  return { success: true, exitCode: 0, output: "ok", rateLimited: false, durationMs: 0, estimatedCostUsd: 0 };
}

function makeFailResult(failure: AdapterFailure): AgentResult {
  return {
    success: false,
    exitCode: 1,
    output: failure.message,
    rateLimited: false,
    durationMs: 0,
    estimatedCostUsd: 0,
    adapterFailure: failure,
  };
}

describe("runWithFallback — HopKind routing", () => {
  test("primary hop receives { kind: 'primary' }", async () => {
    const config = makeNaxConfig({ agent: { default: "claude" } });
    const manager = new AgentManager(config);

    const hopKinds: HopKind[] = [];
    const outcome = await manager.runWithFallback({
      runOptions: STUB_RUN_OPTIONS,
      bundle: STUB_BUNDLE,
      executeHop: async (_agent, _bundle, hopKind, _opts) => {
        hopKinds.push(hopKind);
        return { result: makeSuccessResult(), bundle: _bundle };
      },
    });

    expect(outcome.result.success).toBe(true);
    expect(hopKinds).toHaveLength(1);
    expect(hopKinds[0]).toEqual({ kind: "primary" });
  });

  test("stale-retry hop receives { kind: 'stale-retry', attempt: 1 }", async () => {
    const config = makeNaxConfig({
      agent: {
        default: "claude",
        idleWatchdog: { enabled: true, maxRetryAttempts: 1 },
      },
    });
    const manager = new AgentManager(config);

    const hopKinds: HopKind[] = [];
    let calls = 0;
    const outcome = await manager.runWithFallback({
      runOptions: STUB_RUN_OPTIONS,
      bundle: STUB_BUNDLE,
      executeHop: async (_agent, _bundle, hopKind, _opts) => {
        hopKinds.push(hopKind);
        calls++;
        // First call → stale; second call → success
        const result = calls === 1 ? makeFailResult(STALE_FAILURE) : makeSuccessResult();
        return { result, bundle: _bundle };
      },
    });

    expect(outcome.result.success).toBe(true);
    expect(hopKinds).toHaveLength(2);
    expect(hopKinds[0]).toEqual({ kind: "primary" });
    expect(hopKinds[1]).toEqual({ kind: "stale-retry", attempt: 1 });
  });

  test("multiple stale retries increment attempt counter", async () => {
    const config = makeNaxConfig({
      agent: {
        default: "claude",
        idleWatchdog: { enabled: true, maxRetryAttempts: 2 },
      },
    });
    const manager = new AgentManager(config);

    const hopKinds: HopKind[] = [];
    let calls = 0;
    await manager.runWithFallback({
      runOptions: STUB_RUN_OPTIONS,
      bundle: STUB_BUNDLE,
      executeHop: async (_agent, _bundle, hopKind, _opts) => {
        hopKinds.push(hopKind);
        calls++;
        // All three calls fail stale; third exhausts maxRetryAttempts
        return { result: makeFailResult(STALE_FAILURE), bundle: _bundle };
      },
    });

    expect(hopKinds).toHaveLength(3);
    expect(hopKinds[0]).toEqual({ kind: "primary" });
    expect(hopKinds[1]).toEqual({ kind: "stale-retry", attempt: 1 });
    expect(hopKinds[2]).toEqual({ kind: "stale-retry", attempt: 2 });
  });

  test("swap hop after auth failure receives { kind: 'swap', failure }", async () => {
    const config = makeNaxConfig({
      agent: {
        default: "claude",
        fallback: {
          enabled: true,
          map: { claude: ["codex"] },
          maxHopsPerStory: 2,
          onQualityFailure: false,
          rebuildContext: false,
        },
      },
    });
    const manager = new AgentManager(config);

    const hopKinds: HopKind[] = [];
    const agents: string[] = [];
    await manager.runWithFallback({
      runOptions: STUB_RUN_OPTIONS,
      bundle: STUB_BUNDLE,
      executeHop: async (agentName, _bundle, hopKind, _opts) => {
        hopKinds.push(hopKind);
        agents.push(agentName);
        // claude fails with auth → should swap to codex
        const result = agentName === "claude" ? makeFailResult(AUTH_FAILURE) : makeSuccessResult();
        return { result, bundle: _bundle };
      },
    });

    expect(agents).toEqual(["claude", "codex"]);
    expect(hopKinds[0]).toEqual({ kind: "primary" });
    expect(hopKinds[1]).toMatchObject({ kind: "swap", failure: AUTH_FAILURE });
  });

  test("stale-retry then swap: stale-retry gets stale kind, swap gets swap kind", async () => {
    const config = makeNaxConfig({
      agent: {
        default: "claude",
        idleWatchdog: { enabled: true, maxRetryAttempts: 1 },
        fallback: {
          enabled: true,
          map: { claude: ["codex"] },
          maxHopsPerStory: 3,
          onQualityFailure: false,
          rebuildContext: false,
        },
      },
    });
    const manager = new AgentManager(config);

    const hopKinds: HopKind[] = [];
    const agents: string[] = [];
    let calls = 0;
    const outcome = await manager.runWithFallback({
      runOptions: STUB_RUN_OPTIONS,
      bundle: STUB_BUNDLE,
      executeHop: async (agentName, _bundle, hopKind, _opts) => {
        hopKinds.push(hopKind);
        agents.push(agentName);
        calls++;
        let result: AgentResult;
        if (calls === 1)
          result = makeFailResult(STALE_FAILURE); // primary → stale
        else if (calls === 2)
          result = makeFailResult(STALE_FAILURE); // stale-retry → stale again (exhausted)
        else result = makeSuccessResult(); // swap → success
        return { result, bundle: _bundle };
      },
    });

    expect(outcome.result.success).toBe(true);
    expect(agents).toEqual(["claude", "claude", "codex"]);
    expect(hopKinds[0]).toEqual({ kind: "primary" });
    expect(hopKinds[1]).toEqual({ kind: "stale-retry", attempt: 1 });
    expect(hopKinds[2]).toMatchObject({ kind: "swap" });
  });
});
