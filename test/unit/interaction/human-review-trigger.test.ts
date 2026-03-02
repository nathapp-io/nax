/**
 * Unit Tests: human-review trigger (BUG-025)
 *
 * Verifies that 'human-review' is added to TriggerName and TRIGGER_METADATA,
 * and that createTriggerRequest/executeTrigger work with this new trigger.
 *
 * These tests FAIL until BUG-025 is implemented.
 */

import { describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../src/config";
import { InteractionChain } from "../../../src/interaction/chain";
import type { InteractionPlugin, InteractionResponse, TriggerName } from "../../../src/interaction/types";
import { TRIGGER_METADATA } from "../../../src/interaction/types";
import { createTriggerRequest, executeTrigger } from "../../../src/interaction/triggers";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const minimalConfig = {
  interaction: {
    triggers: {
      "human-review": { enabled: true },
    },
    defaults: {
      timeout: 30000,
      fallback: "skip" as const,
    },
  },
} as unknown as NaxConfig;

function makeSkipPlugin(requestId: string): InteractionPlugin {
  return {
    name: "test-skip",
    send: mock(async () => {}),
    receive: mock(async (_id: string): Promise<InteractionResponse> => ({
      requestId,
      action: "skip",
      respondedBy: "user",
      respondedAt: Date.now(),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TRIGGER_METADATA — must include 'human-review'
// ─────────────────────────────────────────────────────────────────────────────

describe("TRIGGER_METADATA — human-review", () => {
  test("TRIGGER_METADATA contains 'human-review' key", () => {
    // FAILS until BUG-025 adds 'human-review' to TRIGGER_METADATA
    const allTriggers = Object.keys(TRIGGER_METADATA);
    expect(allTriggers).toContain("human-review");
  });

  test("human-review metadata has defaultFallback of 'skip'", () => {
    // FAILS until BUG-025 adds 'human-review' to TRIGGER_METADATA
    const meta = (TRIGGER_METADATA as Record<string, (typeof TRIGGER_METADATA)[TriggerName]>)["human-review"];
    expect(meta).toBeDefined();
    expect(meta?.defaultFallback).toBe("skip");
  });

  test("human-review metadata has safety tier of 'yellow'", () => {
    // FAILS until BUG-025 adds 'human-review' to TRIGGER_METADATA
    const meta = (TRIGGER_METADATA as Record<string, (typeof TRIGGER_METADATA)[TriggerName]>)["human-review"];
    expect(meta).toBeDefined();
    expect(meta?.safety).toBe("yellow");
  });

  test("human-review metadata has a non-empty defaultSummary", () => {
    // FAILS until BUG-025 adds 'human-review' to TRIGGER_METADATA
    const meta = (TRIGGER_METADATA as Record<string, (typeof TRIGGER_METADATA)[TriggerName]>)["human-review"];
    expect(meta).toBeDefined();
    expect(typeof meta?.defaultSummary).toBe("string");
    expect(meta?.defaultSummary.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createTriggerRequest — accepts 'human-review'
// ─────────────────────────────────────────────────────────────────────────────

describe("createTriggerRequest — human-review", () => {
  test("creates a valid request for human-review trigger", () => {
    // FAILS until BUG-025 adds 'human-review' to TriggerName and TRIGGER_METADATA
    const request = createTriggerRequest(
      "human-review" as TriggerName,
      { featureName: "my-feature", storyId: "US-001", iteration: 3 },
      minimalConfig,
    );

    expect(request.id).toContain("human-review");
    expect(request.featureName).toBe("my-feature");
    expect(request.storyId).toBe("US-001");
    expect(request.type).toBe("confirm");
    expect(request.fallback).toBe("skip");
  });

  test("human-review request summary contains storyId when provided", () => {
    // FAILS until BUG-025 adds 'human-review' to TRIGGER_METADATA with {{storyId}} in summary
    const request = createTriggerRequest(
      "human-review" as TriggerName,
      { featureName: "my-feature", storyId: "US-042" },
      minimalConfig,
    );

    // Summary should contain the story ID for human readability
    expect(request.summary).toContain("US-042");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeTrigger — 'human-review' flows through chain
// ─────────────────────────────────────────────────────────────────────────────

describe("executeTrigger — human-review", () => {
  test("executeTrigger sends human-review request through chain and returns response", async () => {
    // FAILS until BUG-025 adds 'human-review' to TriggerName + TRIGGER_METADATA
    const chain = new InteractionChain({ defaultTimeout: 5000, defaultFallback: "skip" });
    const plugin = makeSkipPlugin("trigger-human-review-test");
    chain.register(plugin, 10);

    const response = await executeTrigger(
      "human-review" as TriggerName,
      { featureName: "my-feature", storyId: "US-001" },
      minimalConfig,
      chain,
    );

    expect(response).toBeDefined();
    expect(response.action).toBe("skip");
    expect(plugin.send).toHaveBeenCalledTimes(1);
    expect(plugin.receive).toHaveBeenCalledTimes(1);
  });

  test("executeTrigger request metadata includes trigger name and safety", async () => {
    // FAILS until BUG-025 adds 'human-review' to TriggerName + TRIGGER_METADATA
    const sentRequests: unknown[] = [];
    const chain = new InteractionChain({ defaultTimeout: 5000, defaultFallback: "skip" });
    const plugin: InteractionPlugin = {
      name: "capture",
      send: mock(async (req) => { sentRequests.push(req); }),
      receive: mock(async (_id: string): Promise<InteractionResponse> => ({
        requestId: _id,
        action: "skip",
        respondedAt: Date.now(),
      })),
    };
    chain.register(plugin, 10);

    await executeTrigger(
      "human-review" as TriggerName,
      { featureName: "my-feature", storyId: "US-007" },
      minimalConfig,
      chain,
    );

    expect(sentRequests.length).toBe(1);
    const req = sentRequests[0] as { metadata?: { trigger?: string; safety?: string } };
    expect(req.metadata?.trigger).toBe("human-review");
    expect(req.metadata?.safety).toBe("yellow");
  });
});
