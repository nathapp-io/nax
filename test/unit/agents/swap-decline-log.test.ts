/**
 * nax#1713: runWithFallback must report a declined swap.
 *
 * These drive the real decline gate rather than decideSwap directly, so they pin
 * that the reporter is wired at the gate and does not displace either neighbouring
 * signal — the fail-stale no-candidate warning, or onSwapExhausted.
 */

import { describe, expect, test } from "bun:test";
import { makeAgentAdapter, makeAgentRegistry, makeContextBundle, makeNaxConfig } from "@test/helpers";
import { AgentManager } from "@/agents/manager";
import type { AgentFallbackRecord, AgentRunRequest } from "@/agents/manager-types";

interface Logged {
  scope: string;
  message: string;
  fields: Record<string, unknown> | undefined;
}

function capturingLogger(sink: Logged[]) {
  return {
    warn: (scope: string, message: string, fields?: Record<string, unknown>) => sink.push({ scope, message, fields }),
    info: (scope: string, message: string, fields?: Record<string, unknown>) => sink.push({ scope, message, fields }),
  };
}

function config(fallback: { enabled: boolean; maxHopsPerStory: number }) {
  return makeNaxConfig({
    agent: {
      default: "claude",
      fallback: {
        enabled: fallback.enabled,
        map: { claude: ["codex"] },
        maxHopsPerStory: fallback.maxHopsPerStory,
        onQualityFailure: false,
        rebuildContext: true,
      },
    },
  });
}

/** A hop that always reports an availability failure, so the decline gate is reached. */
function failingManager(sink: Logged[], fallback: { enabled: boolean; maxHopsPerStory: number }) {
  return new AgentManager(config(fallback), undefined, {
    logger: capturingLogger(sink),
    runHop: async () => ({
      prompt: "test",
      result: {
        success: false,
        exitCode: 1,
        output: "",
        rateLimited: false,
        durationMs: 1,
        estimatedCostUsd: 0,
        adapterFailure: {
          outcome: "fail-quota" as const,
          category: "availability" as const,
          retriable: false,
          message: "quota",
        },
      },
    }),
  });
}

function request(): AgentRunRequest {
  return {
    runOptions: {
      prompt: "test",
      workdir: "/tmp",
      modelTier: "fast",
      modelDef: { provider: "anthropic", model: "m", env: {} },
      timeoutSeconds: 30,
      storyId: "US-001",
      config: config({ enabled: false, maxHopsPerStory: 2 }),
    },
    bundle: undefined,
  };
}

const declines = (sink: Logged[]) => sink.filter((l) => l.message === "Fallback swap declined");

describe("runWithFallback reports a declined swap (#1713)", () => {
  test("AC-6: the log carries storyId, the deciding gate, and the failure", async () => {
    const sink: Logged[] = [];
    await failingManager(sink, { enabled: false, maxHopsPerStory: 2 }).runWithFallback(request());

    expect(declines(sink)).toHaveLength(1);
    expect(declines(sink)[0].fields).toMatchObject({
      storyId: "US-001",
      reason: "fallback-disabled",
      outcome: "fail-quota",
      category: "availability",
    });
  });

  test("AC-7: the fail-stale no-candidate warning is not displaced", async () => {
    const sink: Logged[] = [];
    await failingManager(sink, { enabled: false, maxHopsPerStory: 2 }).runWithFallback(request());

    expect(sink.some((l) => l.message.includes("fail-stale"))).toBe(false);
  });

  test("AC-8: the hop cap declines with its own reason", async () => {
    const sink: Logged[] = [];
    const swaps: AgentFallbackRecord[] = [];
    const mgr = failingManager(sink, { enabled: true, maxHopsPerStory: 1 });
    mgr.events.on("onSwapAttempt", (r) => swaps.push(r));

    const req = request();
    req.runOptions.config = config({ enabled: true, maxHopsPerStory: 1 });
    req.bundle = makeContextBundle();
    await mgr.runWithFallback(req);

    expect(swaps.length).toBeGreaterThan(0);
    expect(declines(sink).map((l) => l.fields?.reason)).toContain("hop-cap-reached");
  });
});

describe("completeWithFallback reports a declined swap too (#1713)", () => {
  test("the complete() path's decline gate is not silent either", async () => {
    const sink: Logged[] = [];
    const adapter = makeAgentAdapter({
      complete: async () => ({
        output: "",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
        adapterFailure: {
          outcome: "fail-quota" as const,
          category: "availability" as const,
          retriable: false,
          message: "quota",
        },
      }),
    });
    const mgr = new AgentManager(
      config({ enabled: false, maxHopsPerStory: 2 }),
      makeAgentRegistry({
        getAgent: () => adapter,
      }),
      { logger: capturingLogger(sink) },
    );

    await mgr.completeWithFallback("hi", {
      modelDef: { provider: "anthropic", model: "m", env: {} },
      workdir: "/tmp",
      storyId: "US-001",
      resolvedPermissions: { mode: "default" as const },
    });

    expect(declines(sink)).toHaveLength(1);
    expect(declines(sink)[0].fields).toMatchObject({ storyId: "US-001", reason: "fallback-disabled" });
  });
});
