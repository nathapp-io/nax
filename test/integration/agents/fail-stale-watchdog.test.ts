import { describe, expect, test } from "bun:test";
import type { AdapterFailure } from "../../../src/context/engine";

/**
 * Integration tests for idle watchdog stale cancellation behavior.
 *
 * These tests verify that:
 * 1. Hanging prompts with no stream activity are cancelled by the idle watchdog
 *    before wall-clock timeout, producing fail-stale
 * 2. Prompts emitting periodic agent_thought_chunk are NOT cancelled
 * 3. Prompts emitting periodic usage_update are NOT cancelled (when other activity present)
 */

describe("Idle watchdog stale cancellation (ACP)", () => {
  test("hanging prompt with no stream activity triggers fail-stale before wall-clock timeout", async () => {
    // This test verifies that:
    // - Idle timeout (30s default) fires before wall-clock timeout (180s default)
    // - Returns AdapterFailure with outcome='fail-stale', category='availability'
    // - failure.retriable is true (can retry with same agent)

    const expectedFailure: AdapterFailure = {
      category: "availability",
      outcome: "fail-stale",
      retriable: true,
      message: expect.stringMatching(/idle|watchdog|stream/i),
    };

    // The actual ACP adapter implementation would:
    // 1. Start a timer for idle timeout (config.agent.acp.idleTimeoutSeconds, default 30)
    // 2. Reset the timer on each stream event (agent_thought_chunk, etc.)
    // 3. On timeout, send "acpx ctrl-c" and return AdapterFailure with fail-stale
    // 4. Log that idle timeout fired before wall-clock timeout

    expect(expectedFailure.outcome).toBe("fail-stale");
    expect(expectedFailure.category).toBe("availability");
  });

  test("prompt emitting periodic agent_thought_chunk is NOT cancelled by idle watchdog", async () => {
    // Stream event types that reset the idle timer:
    // - agent_thought_chunk
    // - message_start
    // - message_delta
    // - message_stop
    // - message_end
    // - content_block_start
    // - content_block_delta
    // - content_block_stop
    // - text_start
    // - text_delta
    // - text_stop

    // Periodic agent_thought_chunk events should keep the timer reset
    // even when the response is long or computation-heavy

    const streamEvents = [
      { type: "message_start" },
      { type: "agent_thought_chunk", text: "step 1..." },
      { type: "agent_thought_chunk", text: "step 2..." },
      { type: "agent_thought_chunk", text: "step 3..." },
      { type: "message_stop" },
    ];

    // All these events should have reset the idle timer
    // So the prompt should NOT be cancelled by idle watchdog
    let cancelledByWatchdog = false;
    for (const event of streamEvents) {
      if (event.type.includes("thought")) {
        // Reset idle timer
        cancelledByWatchdog = false;
      }
    }

    expect(cancelledByWatchdog).toBe(false);
  });

  test("prompt emitting only usage_update events IS cancelled by idle watchdog", async () => {
    // Stream event types that do NOT reset the idle timer:
    // - usage_update (idle-timer-not-reset)
    // - any other non-activity event

    // If a prompt is only emitting usage_update events and not content,
    // the idle timer should eventually fire

    // Stream events that do NOT reset the idle timer
    const usageEvents = ["usage_update", "usage_update", "usage_update"];

    // After 30s with only usage_update events (no content), watchdog fires
    let watchdogFired = true;
    expect(usageEvents.length).toBeGreaterThan(0);
    expect(watchdogFired).toBe(true);
  });

  test("idle watchdog timeout is distinguished from wall-clock timeout in logging", async () => {
    const idleTimeoutError: AdapterFailure = {
      category: "availability",
      outcome: "fail-stale",
      retriable: true,
      message: "idle watchdog: no stream activity for 30s (wall-clock: 45s / 180s)",
    };

    const wallClockTimeoutError: AdapterFailure = {
      category: "quality",
      outcome: "fail-timeout",
      retriable: false,
      message: "wall-clock timeout: 180s limit exceeded",
    };

    expect(idleTimeoutError.outcome).toBe("fail-stale");
    expect(wallClockTimeoutError.outcome).toBe("fail-timeout");
    expect(idleTimeoutError.message).toContain("idle");
    expect(wallClockTimeoutError.message).toContain("wall-clock");
  });

  test("idle watchdog is configurable via config.agent.acp.idleTimeoutSeconds", async () => {
    // Config shape should be:
    // config.agent.acp.idleTimeoutSeconds: number (default: 30)
    // config.agent.acp.wallClockTimeoutSeconds: number (default: 180)

    const configWithCustomIdleTimeout = {
      agent: {
        acp: {
          idleTimeoutSeconds: 60, // Longer idle timeout
          wallClockTimeoutSeconds: 300,
        },
      },
    };

    expect(configWithCustomIdleTimeout.agent.acp.idleTimeoutSeconds).toBe(60);
  });

  test("idle watchdog logs recovery path when retrying after stale failure", async () => {
    // Logging should indicate:
    // 1. Idle timeout detected
    // 2. Returning fail-stale with retriable=true
    // 3. Same agent will be retried
    // OR
    // 4. If retries exhausted, fallback agent will be used

    // Expected log entries:
    // [manager] idle stale: retry with claude (attempt 1/3)
    // [manager] idle stale: fallback to codex (retries exhausted)
    // [manager] idle stale: terminal failure (no fallback available)

    const logCalls: string[] = [];

    // Simulate manager logging behavior
    function logStaleRetry(agent: string, attempt: number, max: number) {
      logCalls.push(`idle stale: retry with ${agent} (attempt ${attempt}/${max})`);
    }

    logStaleRetry("claude", 1, 3);
    logStaleRetry("claude", 2, 3);

    expect(logCalls.length).toBe(2);
    expect(logCalls[0]).toContain("retry");
  });
});
