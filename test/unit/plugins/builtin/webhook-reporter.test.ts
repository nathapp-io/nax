import { describe, expect, test } from "bun:test";
import { mockFetch } from "@test/helpers";
import type { ReporterEvent, WebhookReporterConfig } from "@/config/schemas-reporters";
import { createWebhookReporterPlugin, type PostJsonDeps } from "@/plugins";
import type { PhaseCompleteEvent, PhaseStartEvent } from "@/plugins/extensions";

const baseCfg: WebhookReporterConfig = {
  enabled: true,
  url: "https://hook.example.com",
  headers: { "X-Token": "${WH_TOKEN}" },
  timeoutMs: 1000,
};

type WebhookEnvelope = { type: ReporterEvent; emittedAt: string; data: Record<string, unknown> };

function capturing() {
  const calls: Array<{ url: string; body: WebhookEnvelope; headers: Headers }> = [];
  const deps: PostJsonDeps = {
    fetch: mockFetch(async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        headers: new Headers(init?.headers),
      });
      return new Response(null, { status: 200 });
    }),
  };
  return { calls, deps };
}

describe("webhook-reporter", () => {
  test("declares the reporter extension point", () => {
    const plugin = createWebhookReporterPlugin(baseCfg);
    expect(plugin.name).toBe("webhook-reporter");
    expect(plugin.provides).toContain("reporter");
    expect(plugin.extensions.reporter?.name).toBe("webhook-reporter");
  });

  test("POSTs an envelope with type, emittedAt, and data on onRunStart", async () => {
    const { calls, deps } = capturing();
    process.env.WH_TOKEN = "secret";
    const plugin = createWebhookReporterPlugin(baseCfg, deps);
    await plugin.extensions.reporter?.onRunStart?.({
      runId: "r1",
      feature: "f",
      totalStories: 3,
      startTime: "2026-07-18T00:00:00.000Z",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://hook.example.com");
    expect(calls[0].body.type).toBe("onRunStart");
    expect(typeof calls[0].body.emittedAt).toBe("string");
    expect(calls[0].body.data.feature).toBe("f");
    expect(calls[0].headers.get("x-token")).toBe("secret");
    delete process.env.WH_TOKEN;
  });

  test("respects the events filter — filtered event does not POST", async () => {
    const { calls, deps } = capturing();
    const plugin = createWebhookReporterPlugin({ ...baseCfg, headers: {}, events: ["onRunEnd"] }, deps);
    await plugin.extensions.reporter?.onRunStart?.({
      runId: "r1",
      feature: "f",
      totalStories: 1,
      startTime: "2026-07-18T00:00:00.000Z",
    });
    expect(calls).toHaveLength(0);
    await plugin.extensions.reporter?.onRunEnd?.({
      runId: "r1",
      totalDurationMs: 10,
      totalCost: 0,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.type).toBe("onRunEnd");
  });

  test("skips POST when a required env var is missing", async () => {
    const { calls, deps } = capturing();
    delete process.env.WH_TOKEN;
    const plugin = createWebhookReporterPlugin(baseCfg, deps);
    await plugin.extensions.reporter?.onRunStart?.({
      runId: "r1",
      feature: "f",
      totalStories: 1,
      startTime: "2026-07-18T00:00:00.000Z",
    });
    expect(calls).toHaveLength(0);
  });

  test("does nothing when url is unset", async () => {
    const { calls, deps } = capturing();
    const plugin = createWebhookReporterPlugin({ enabled: true, headers: {}, timeoutMs: 1000 }, deps);
    await plugin.extensions.reporter?.onStoryComplete?.({
      runId: "r1",
      storyId: "s1",
      status: "completed",
      runElapsedMs: 5,
      cost: 0.1,
      tier: "fast",
      testStrategy: "tdd-simple",
    });
    expect(calls).toHaveLength(0);
  });

  test("AC14: onPhaseComplete posts an onPhaseComplete envelope", async () => {
    const { calls, deps } = capturing();
    const plugin = createWebhookReporterPlugin({ ...baseCfg, headers: {}, events: ["onPhaseComplete"] }, deps);
    const event: PhaseCompleteEvent = {
      runId: "r1",
      scope: "story",
      storyId: "s1",
      phase: "implementer",
      outcome: "passed",
      durationMs: 10,
      costUsd: 0.1,
    };

    await plugin.extensions.reporter?.onPhaseComplete?.(event);

    expect(calls).toHaveLength(1);
    expect(calls[0].body.type).toBe("onPhaseComplete");
  });

  test("AC15: onPhaseComplete filter performs no request for onPhaseStart", async () => {
    const { calls, deps } = capturing();
    const plugin = createWebhookReporterPlugin({ ...baseCfg, headers: {}, events: ["onPhaseComplete"] }, deps);
    const event: PhaseStartEvent = {
      runId: "r1",
      scope: "story",
      storyId: "s1",
      phase: "implementer",
      startTime: "2026-07-18T00:00:00.000Z",
    };

    await plugin.extensions.reporter?.onPhaseStart?.(event);

    expect(calls).toHaveLength(0);
  });
});
