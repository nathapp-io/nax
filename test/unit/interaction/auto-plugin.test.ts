/**
 * AutoInteractionPlugin unit tests (TC-006)
 *
 * Tests LLM decision path via _deps.callLlm mock.
 * No real claude CLI is invoked.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _autoPluginDeps as _deps, AutoInteractionPlugin } from "../../../src/interaction/plugins/auto";
import type { InteractionRequest } from "../../../src/interaction/types";

// Save original so we can restore in afterEach
const originalCallLlm = _deps.callLlm;

function makeRequest(id: string, overrides: Partial<InteractionRequest> = {}): InteractionRequest {
  return {
    id,
    type: "confirm",
    featureName: "test-feature",
    stage: "review",
    summary: "Should we proceed?",
    fallback: "continue",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("AutoInteractionPlugin._deps.callLlm", () => {
  let plugin: AutoInteractionPlugin;

  beforeEach(async () => {
    plugin = new AutoInteractionPlugin();
    await plugin.init({ confidenceThreshold: 0.7 });
  });

  afterEach(() => {
    mock.restore();
    _deps.callLlm = originalCallLlm;
  });

  test("LLM returns approve → response.action is approve", async () => {
    _deps.callLlm = mock(async () => ({
      action: "approve" as const,
      confidence: 0.9,
      reasoning: "safe to proceed",
    }));

    const response = await plugin.decide(makeRequest("req-approve"));

    expect(response).not.toBeUndefined();
    expect(response?.action).toBe("approve");
    expect(response?.respondedBy).toBe("auto-ai");
    expect(response?.requestId).toBe("req-approve");
  });

  test("LLM returns reject → response.action is reject", async () => {
    _deps.callLlm = mock(async () => ({
      action: "reject" as const,
      confidence: 0.85,
      reasoning: "potential issue",
    }));

    const response = await plugin.decide(makeRequest("req-reject"));

    expect(response).not.toBeUndefined();
    expect(response?.action).toBe("reject");
  });

  test("confidence < threshold → returns undefined (escalates to human)", async () => {
    _deps.callLlm = mock(async () => ({
      action: "approve" as const,
      confidence: 0.5, // below default threshold of 0.7
      reasoning: "not confident",
    }));

    const response = await plugin.decide(makeRequest("req-low-conf"));

    expect(response).toBeUndefined();
  });

  test("custom threshold: confidence exactly at threshold → response returned", async () => {
    const highThresholdPlugin = new AutoInteractionPlugin();
    await highThresholdPlugin.init({ confidenceThreshold: 0.8 });

    _deps.callLlm = mock(async () => ({
      action: "approve" as const,
      confidence: 0.8, // exactly at threshold
      reasoning: "borderline",
    }));

    const response = await highThresholdPlugin.decide(makeRequest("req-threshold"));

    // Confidence (0.8) is NOT less than threshold (0.8), so response is returned
    expect(response).not.toBeUndefined();
    expect(response?.action).toBe("approve");
  });

  test("custom threshold: confidence below threshold → returns undefined", async () => {
    const highThresholdPlugin = new AutoInteractionPlugin();
    await highThresholdPlugin.init({ confidenceThreshold: 0.9 });

    _deps.callLlm = mock(async () => ({
      action: "approve" as const,
      confidence: 0.8, // below 0.9 threshold
      reasoning: "not confident enough",
    }));

    const response = await highThresholdPlugin.decide(makeRequest("req-below-threshold"));

    expect(response).toBeUndefined();
  });

  test("security-review trigger → always returns undefined (hardcoded block)", async () => {
    // _deps.callLlm is NOT set — if it were called, it would throw (null)
    // This verifies the security-review check runs before any LLM call
    _deps.callLlm = mock(async () => {
      throw new Error("callLlm should not be invoked for security-review");
    });

    const request = makeRequest("req-sec", {
      metadata: { trigger: "security-review", safety: "red" },
    });

    const response = await plugin.decide(request);

    expect(response).toBeUndefined();
    // Verify LLM was never called
    expect((_deps.callLlm as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  test("LLM throws → returns undefined (error escalates to human)", async () => {
    _deps.callLlm = mock(async () => {
      throw new Error("LLM unavailable");
    });

    const response = await plugin.decide(makeRequest("req-error"));

    expect(response).toBeUndefined();
  });

  test("LLM returns choose with value → value is propagated", async () => {
    _deps.callLlm = mock(async () => ({
      action: "choose" as const,
      value: "option-b",
      confidence: 0.95,
      reasoning: "best option",
    }));

    const response = await plugin.decide(
      makeRequest("req-choose", {
        type: "choose",
        options: [
          { key: "a", label: "Option A" },
          { key: "b", label: "Option B" },
        ],
      }),
    );

    expect(response?.action).toBe("choose");
    expect(response?.value).toBe("option-b");
  });
});
