/**
 * Unit Tests: InteractionChain.prompt() — choose response normalization
 *
 * When a plugin returns { action: "choose", value: "<key>" } for a "choose"
 * type interaction, chain.prompt() must remap action to the selected option key
 * so all consumers can switch on action directly.
 *
 * BUG FIX: promptForFlaggedStories crashed with "Unknown action choose" because
 * it switched on response.action instead of the selected key in response.value.
 * Fix is in chain.ts prompt() — normalize once, fix everywhere.
 */

import { describe, expect, mock, test } from "bun:test";
import { InteractionChain } from "../../../src/interaction/chain";
import type { InteractionPlugin, InteractionRequest, InteractionResponse } from "../../../src/interaction/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<InteractionRequest> = {}): InteractionRequest {
  return {
    id: "test-req-001",
    type: "choose",
    featureName: "test-feature",
    stage: "pre-flight",
    summary: "Test prompt",
    options: [
      { key: "approve", label: "Approve" },
      { key: "skip", label: "Skip" },
      { key: "abort", label: "Abort" },
    ],
    timeout: 5000,
    fallback: "abort",
    createdAt: Date.now(),
    ...overrides,
  };
}

function makePlugin(response: Partial<InteractionResponse>): InteractionPlugin {
  const full: InteractionResponse = {
    requestId: "test-req-001",
    action: "approve",
    respondedBy: "user",
    respondedAt: Date.now(),
    ...response,
  };
  return {
    name: "test-plugin",
    send: mock(async () => {}),
    receive: mock(async (): Promise<InteractionResponse> => full),
  };
}

function makeChain(plugin: InteractionPlugin): InteractionChain {
  const chain = new InteractionChain({ defaultTimeout: 5000, defaultFallback: "abort" });
  chain.register(plugin, 10);
  return chain;
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalization: action="choose" + value="<key>" → action="<key>"
// ─────────────────────────────────────────────────────────────────────────────

describe("InteractionChain.prompt() — choose normalization", () => {
  test("remaps action='choose' + value='approve' → action='approve'", async () => {
    const plugin = makePlugin({ action: "choose", value: "approve" });
    const chain = makeChain(plugin);
    const response = await chain.prompt(makeRequest());
    expect(response.action).toBe("approve");
    expect(response.value).toBe("approve"); // value preserved
  });

  test("remaps action='choose' + value='skip' → action='skip'", async () => {
    const plugin = makePlugin({ action: "choose", value: "skip" });
    const chain = makeChain(plugin);
    const response = await chain.prompt(makeRequest());
    expect(response.action).toBe("skip");
  });

  test("remaps action='choose' + value='abort' → action='abort'", async () => {
    const plugin = makePlugin({ action: "choose", value: "abort" });
    const chain = makeChain(plugin);
    const response = await chain.prompt(makeRequest());
    expect(response.action).toBe("abort");
  });

  test("does NOT remap when value is not in declared options", async () => {
    const plugin = makePlugin({ action: "choose", value: "unknown-key" });
    const chain = makeChain(plugin);
    const response = await chain.prompt(makeRequest());
    // Not in options — should return as-is (action stays "choose")
    expect(response.action).toBe("choose");
    expect(response.value).toBe("unknown-key");
  });

  test("does NOT remap when no options declared on request", async () => {
    const plugin = makePlugin({ action: "choose", value: "approve" });
    const chain = makeChain(plugin);
    const req = makeRequest({ options: undefined });
    const response = await chain.prompt(req);
    expect(response.action).toBe("choose");
  });

  test("does NOT remap when value is missing", async () => {
    const plugin = makePlugin({ action: "choose", value: undefined });
    const chain = makeChain(plugin);
    const response = await chain.prompt(makeRequest());
    expect(response.action).toBe("choose");
  });

  test("does not affect non-choose responses", async () => {
    const plugin = makePlugin({ action: "approve", value: undefined });
    const chain = makeChain(plugin);
    const response = await chain.prompt(makeRequest());
    expect(response.action).toBe("approve");
  });

  test("does not affect reject responses", async () => {
    const plugin = makePlugin({ action: "reject" });
    const chain = makeChain(plugin);
    const response = await chain.prompt(makeRequest());
    expect(response.action).toBe("reject");
  });
});
