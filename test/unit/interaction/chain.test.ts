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

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AutoInteractionPlugin, _autoPluginDeps } from "../../../src/interaction/plugins/auto";
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

/**
 * Creates an AutoInteractionPlugin pre-configured with a mock callLlm that
 * returns an approve response with confidence above the default threshold.
 */
async function makeAutoPlugin(): Promise<AutoInteractionPlugin> {
  const plugin = new AutoInteractionPlugin();
  await plugin.init({ confidenceThreshold: 0.7 });
  _autoPluginDeps.callLlm = mock(async () => ({
    action: "approve" as const,
    confidence: 0.95,
    reasoning: "human-review is safe to auto-approve",
  }));
  return plugin;
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

// ─────────────────────────────────────────────────────────────────────────────
// US-003 Regression: in-process human-review path requestId preservation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Regression guard: InteractionChain.prompt() with AutoInteractionPlugin
 * returns an InteractionResponse whose requestId matches the submitted
 * request.id.
 *
 * After deleting src/interaction/state.ts, the in-process interaction path
 * (InteractionChain → AutoInteractionPlugin → decide()) must continue to
 * correctly preserve requestId for human-review triggers.  The path is:
 *   chain.prompt(request) → plugin.send(request) [stores it]
 *                         → plugin.receive(request.id) [retrieves & decides]
 */
describe("InteractionChain + AutoInteractionPlugin — in-process human-review path (US-003)", () => {
  let origCallLlm: typeof _autoPluginDeps.callLlm;

  beforeEach(() => {
    origCallLlm = _autoPluginDeps.callLlm;
  });

  afterEach(() => {
    _autoPluginDeps.callLlm = origCallLlm;
    mock.restore();
  });

  test(
    "AC1: InteractionChain+AutoPlugin resolves human-review request " +
      "→ response.requestId matches submitted request.id",
    async () => {
      const requestId = "ix-US003-review-001";
      const plugin = await makeAutoPlugin();
      const chain = makeChain(plugin);

      // Production path: chain.prompt() calls send() (stores request) then
      // receive() (retrieves request and calls decide() internally).
      const request = makeRequest({ id: requestId, type: "confirm", metadata: { trigger: "human-review" } });
      const response = await chain.prompt(request);

      expect(response.requestId).toBe(requestId);
    },
  );
});
