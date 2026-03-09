/**
 * Unit Tests: story-oversized trigger (SD-003)
 *
 * Verifies that:
 * - 'story-oversized' is added to TriggerName union
 * - TRIGGER_METADATA contains 'story-oversized' with correct metadata
 * - checkStoryOversized() fires the trigger and returns decompose/skip/continue action
 *
 * These tests FAIL until SD-003 is implemented.
 */

import { describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../src/config";
import { InteractionChain } from "../../../src/interaction/chain";
import type { InteractionPlugin, InteractionResponse, TriggerName } from "../../../src/interaction/types";
import { TRIGGER_METADATA } from "../../../src/interaction/types";
import { createTriggerRequest } from "../../../src/interaction/triggers";
import * as triggers from "../../../src/interaction/triggers";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const minimalConfig = {
  interaction: {
    triggers: {
      "story-oversized": { enabled: true },
    },
    defaults: {
      timeout: 30000,
      fallback: "continue" as const,
    },
  },
} as unknown as NaxConfig;

function makePlugin(action: "approve" | "skip" | "choose", value?: string): InteractionPlugin {
  return {
    name: "test-plugin",
    send: mock(async () => {}),
    receive: mock(async (id: string): Promise<InteractionResponse> => ({
      requestId: id,
      action,
      value,
      respondedBy: "user",
      respondedAt: Date.now(),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TRIGGER_METADATA — must include 'story-oversized'
// ─────────────────────────────────────────────────────────────────────────────

describe("TRIGGER_METADATA — story-oversized", () => {
  test("TRIGGER_METADATA contains 'story-oversized' key", () => {
    // FAILS until SD-003 adds 'story-oversized' to TRIGGER_METADATA
    const allTriggers = Object.keys(TRIGGER_METADATA);
    expect(allTriggers).toContain("story-oversized");
  });

  test("story-oversized metadata has defaultFallback of 'continue'", () => {
    // FAILS until SD-003 adds 'story-oversized' with correct fallback
    const meta = (TRIGGER_METADATA as Record<string, (typeof TRIGGER_METADATA)[TriggerName]>)["story-oversized"];
    expect(meta).toBeDefined();
    expect(meta?.defaultFallback).toBe("continue");
  });

  test("story-oversized metadata has safety tier of 'yellow'", () => {
    // FAILS until SD-003 adds 'story-oversized' with correct safety
    const meta = (TRIGGER_METADATA as Record<string, (typeof TRIGGER_METADATA)[TriggerName]>)["story-oversized"];
    expect(meta).toBeDefined();
    expect(meta?.safety).toBe("yellow");
  });

  test("story-oversized metadata has a non-empty defaultSummary", () => {
    // FAILS until SD-003 adds 'story-oversized' with defaultSummary
    const meta = (TRIGGER_METADATA as Record<string, (typeof TRIGGER_METADATA)[TriggerName]>)["story-oversized"];
    expect(meta).toBeDefined();
    expect(typeof meta?.defaultSummary).toBe("string");
    expect((meta?.defaultSummary ?? "").length).toBeGreaterThan(0);
  });

  test("story-oversized defaultSummary references {{storyId}} and {{criteriaCount}}", () => {
    // FAILS until SD-003 adds correct summary template
    const meta = (TRIGGER_METADATA as Record<string, (typeof TRIGGER_METADATA)[TriggerName]>)["story-oversized"];
    expect(meta?.defaultSummary).toContain("{{storyId}}");
    expect(meta?.defaultSummary).toContain("{{criteriaCount}}");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createTriggerRequest — accepts 'story-oversized'
// ─────────────────────────────────────────────────────────────────────────────

describe("createTriggerRequest — story-oversized", () => {
  test("creates a valid request for story-oversized trigger", () => {
    // FAILS until SD-003 adds 'story-oversized' to TriggerName and TRIGGER_METADATA
    const request = createTriggerRequest(
      "story-oversized" as TriggerName,
      { featureName: "my-feature", storyId: "US-001", criteriaCount: 9 },
      minimalConfig,
    );

    expect(request.id).toContain("story-oversized");
    expect(request.featureName).toBe("my-feature");
    expect(request.storyId).toBe("US-001");
    expect(request.type).toBe("confirm");
    expect(request.fallback).toBe("continue");
  });

  test("story-oversized request summary contains storyId and criteriaCount", () => {
    // FAILS until SD-003 adds 'story-oversized' to TRIGGER_METADATA with template substitution
    const request = createTriggerRequest(
      "story-oversized" as TriggerName,
      { featureName: "my-feature", storyId: "US-042", criteriaCount: 9 },
      minimalConfig,
    );

    expect(request.summary).toContain("US-042");
    expect(request.summary).toContain("9");
  });

  test("story-oversized request metadata includes safety 'yellow'", () => {
    // FAILS until SD-003 adds 'story-oversized' to TRIGGER_METADATA
    const request = createTriggerRequest(
      "story-oversized" as TriggerName,
      { featureName: "my-feature", storyId: "US-001", criteriaCount: 8 },
      minimalConfig,
    );

    expect(request.metadata?.safety).toBe("yellow");
    expect(request.metadata?.trigger).toBe("story-oversized");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkStoryOversized — function exists and returns correct action
// ─────────────────────────────────────────────────────────────────────────────

describe("checkStoryOversized — function signature", () => {
  test("checkStoryOversized is exported from triggers module", () => {
    // FAILS until SD-003 exports checkStoryOversized from src/interaction/triggers.ts
    const fn = (triggers as Record<string, unknown>).checkStoryOversized;
    expect(typeof fn).toBe("function");
  });
});

describe("checkStoryOversized — disabled trigger returns 'continue'", () => {
  test("returns 'continue' when trigger is disabled", async () => {
    // FAILS until SD-003 implements checkStoryOversized
    const checkStoryOversized = (triggers as Record<string, unknown>).checkStoryOversized as
      | ((ctx: unknown, cfg: unknown, chain: unknown) => Promise<string>)
      | undefined;

    if (!checkStoryOversized) {
      throw new Error("checkStoryOversized not exported from triggers module");
    }

    const disabledConfig = {
      interaction: {
        triggers: { "story-oversized": { enabled: false } },
        defaults: { timeout: 30000, fallback: "continue" as const },
      },
    } as unknown as NaxConfig;

    const chain = new InteractionChain({ defaultTimeout: 5000, defaultFallback: "continue" });
    const result = await checkStoryOversized(
      { featureName: "f", storyId: "US-001", criteriaCount: 9 },
      disabledConfig,
      chain,
    );
    expect(result).toBe("continue");
  });
});

describe("checkStoryOversized — user selects 'decompose'", () => {
  test("returns 'decompose' when user approves decomposition", async () => {
    // FAILS until SD-003 implements checkStoryOversized
    const checkStoryOversized = (triggers as Record<string, unknown>).checkStoryOversized as
      | ((ctx: unknown, cfg: unknown, chain: unknown) => Promise<string>)
      | undefined;

    if (!checkStoryOversized) {
      throw new Error("checkStoryOversized not exported from triggers module");
    }

    const chain = new InteractionChain({ defaultTimeout: 5000, defaultFallback: "continue" });
    const plugin = makePlugin("approve");
    chain.register(plugin, 10);

    const result = await checkStoryOversized(
      { featureName: "my-feature", storyId: "US-001", criteriaCount: 9 },
      minimalConfig,
      chain,
    );
    expect(result).toBe("decompose");
  });
});

describe("checkStoryOversized — user selects 'skip'", () => {
  test("returns 'skip' when user skips the story", async () => {
    // FAILS until SD-003 implements checkStoryOversized
    const checkStoryOversized = (triggers as Record<string, unknown>).checkStoryOversized as
      | ((ctx: unknown, cfg: unknown, chain: unknown) => Promise<string>)
      | undefined;

    if (!checkStoryOversized) {
      throw new Error("checkStoryOversized not exported from triggers module");
    }

    const chain = new InteractionChain({ defaultTimeout: 5000, defaultFallback: "continue" });
    const plugin = makePlugin("skip");
    chain.register(plugin, 10);

    const result = await checkStoryOversized(
      { featureName: "my-feature", storyId: "US-001", criteriaCount: 9 },
      minimalConfig,
      chain,
    );
    expect(result).toBe("skip");
  });
});

describe("checkStoryOversized — timeout fallback", () => {
  test("returns 'continue' on timeout (default fallback)", async () => {
    // FAILS until SD-003 implements checkStoryOversized
    const checkStoryOversized = (triggers as Record<string, unknown>).checkStoryOversized as
      | ((ctx: unknown, cfg: unknown, chain: unknown) => Promise<string>)
      | undefined;

    if (!checkStoryOversized) {
      throw new Error("checkStoryOversized not exported from triggers module");
    }

    // Chain with no plugins → defaults to fallback behavior
    const chain = new InteractionChain({ defaultTimeout: 1, defaultFallback: "continue" });

    const result = await checkStoryOversized(
      { featureName: "my-feature", storyId: "US-001", criteriaCount: 9 },
      minimalConfig,
      chain,
    );
    expect(result).toBe("continue");
  });
});
