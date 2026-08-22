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
import { _acpAdapterDeps, ensureAcpSession, runSessionPrompt } from "@/agents/acp/adapter";
import type { AcpClient, AcpSession, AcpSessionResponse } from "@/agents/acp/adapter";
import { withDepsRestore } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// ensureAcpSession — cwd existence guard
// ─────────────────────────────────────────────────────────────────────────────

describe("ensureAcpSession — cwd guard", () => {
  withDepsRestore(_acpAdapterDeps, ["cwdExists"]);

  function makeClient(cwd: string | undefined, opts?: { onCreate?: () => void }): AcpClient {
    const session: AcpSession = {
      prompt: async () => ({ stopReason: "end_turn", messages: [] }),
      cancelActivePrompt: async () => {},
      close: async () => {},
    };
    return {
      cwd,
      start: async () => {},
      createSession: async () => {
        opts?.onCreate?.();
        return session;
      },
      close: async () => {},
    } as AcpClient;
  }

  test("throws an actionable error when the session cwd does not exist", async () => {
    _acpAdapterDeps.cwdExists = () => Promise.resolve(false);
    let created = false;
    const client = makeClient("/repo/packages/portfolio", { onCreate: () => (created = true) });

    await expect(ensureAcpSession(client, "sess-1", "claude", "approve-reads")).rejects.toThrow(
      /Session cwd does not exist: \/repo\/packages\/portfolio/,
    );
    expect(created).toBe(false);
  });

  test("creates the session when the cwd exists", async () => {
    _acpAdapterDeps.cwdExists = () => Promise.resolve(true);
    const client = makeClient("/repo/packages/core");

    const { session, resumed } = await ensureAcpSession(client, "sess-1", "claude", "approve-reads");
    expect(session).toBeDefined();
    expect(resumed).toBe(false);
  });

  test("skips the guard when the client does not expose a cwd", async () => {
    let checked = false;
    _acpAdapterDeps.cwdExists = () => {
      checked = true;
      return Promise.resolve(false);
    };
    const client = makeClient(undefined);

    await expect(ensureAcpSession(client, "sess-1", "claude", "approve-reads")).resolves.toBeDefined();
    expect(checked).toBe(false);
  });
});

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
