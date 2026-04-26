/**
 * Tests for ACP session lifecycle.
 *
 * Covers:
 * - runSessionPrompt timer cleanup (timer cleared when prompt wins the race)
 *
 * Note: run() conditional-close tests removed in ADR-019 Phase D —
 * AgentAdapter.run() was deleted from the interface.
 * Note: sidecar tests (saveAcpSession, sweepFeatureSessions, clearAcpSession, readAcpSession,
 * readAcpSessionEntry, crash-orphaned guard) were removed in Phase 3 (#477) when the sidecar
 * persistence layer was deleted from adapter.ts.
 */

import { describe, expect, test } from "bun:test";
import {
  runSessionPrompt,
} from "../../../../src/agents/acp/adapter";
import type { AcpSession, AcpSessionResponse } from "../../../../src/agents/acp/adapter";

// ─────────────────────────────────────────────────────────────────────────────
// runSessionPrompt — timer cleanup
// ─────────────────────────────────────────────────────────────────────────────

describe("runSessionPrompt — timer cleanup", () => {
  test("returns response when prompt resolves before timeout", async () => {
    const fakeResponse: AcpSessionResponse = {
      stopReason: "end_turn",
      messages: [],
    };
    const mockSession: AcpSession = {
      prompt: async () => fakeResponse,
      cancelActivePrompt: async () => {},
      close: async () => {},
    };
    const result = await runSessionPrompt(mockSession, "hello", 30_000);
    expect(result.timedOut).toBe(false);
    expect(result.response).toEqual(fakeResponse);
  });

  test("returns timedOut=true when timeout fires first", async () => {
    const mockSession: AcpSession = {
      prompt: () => new Promise(() => {}), // never resolves
      cancelActivePrompt: async () => {},
      close: async () => {},
    };
    const result = await runSessionPrompt(mockSession, "hello", 1); // 1ms timeout
    expect(result.timedOut).toBe(true);
    expect(result.response).toBeNull();
  });
});
