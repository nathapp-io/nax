/**
 * Unit Tests: initInteractionChain headless behaviour
 *
 * Verifies:
 * - CLI plugin returns null in headless mode (stdin unavailable)
 * - Telegram plugin initialises in headless mode (HTTP-based, no TTY needed)
 * - No interaction config always returns null regardless of headless flag
 */

import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "../../helpers";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(plugin: string) {
  return makeNaxConfig({
    interaction: {
      plugin,
      config: { botToken: "test-token", chatId: "123456789" },
      defaults: { timeout: 30000, fallback: "escalate" as const },
      triggers: {},
    },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("initInteractionChain — headless mode", () => {
  test("returns null when no interaction config (headless=true)", async () => {
    const { initInteractionChain } = await import("../../../src/interaction/init");
    const result = await initInteractionChain({} as NaxConfig, true);
    expect(result).toBeNull();
  });

  test("returns null when no interaction config (headless=false)", async () => {
    const { initInteractionChain } = await import("../../../src/interaction/init");
    const result = await initInteractionChain({} as NaxConfig, false);
    expect(result).toBeNull();
  });

  test("CLI plugin returns null in headless mode", async () => {
    const { initInteractionChain } = await import("../../../src/interaction/init");
    const result = await initInteractionChain(makeConfig("cli"), true);
    expect(result).toBeNull();
  });

  test("CLI plugin initialises normally when not headless (non-TTY: rl skipped)", async () => {
    const { initInteractionChain } = await import("../../../src/interaction/init");
    // In non-TTY environments (test runners, CI) stdin.isTTY is false so the
    // readline init is skipped. The chain still initialises successfully.
    const result = await initInteractionChain(makeConfig("cli"), false);
    expect(result).not.toBeNull();
  });

  test("Telegram plugin initialises in headless mode (not blocked by headless guard)", async () => {
    const { initInteractionChain } = await import("../../../src/interaction/init");
    // With valid botToken + chatId, Telegram plugin should init successfully even in headless
    const result = await initInteractionChain(makeConfig("telegram"), true);
    expect(result).not.toBeNull();
  });

  test("Telegram plugin initialises in non-headless mode", async () => {
    const { initInteractionChain } = await import("../../../src/interaction/init");
    const result = await initInteractionChain(makeConfig("telegram"), false);
    expect(result).not.toBeNull();
  });
});
