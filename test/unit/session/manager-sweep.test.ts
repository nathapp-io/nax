/**
 * Tests for src/session/manager-sweep.ts
 *
 * MEM-1 (Round 2 review): session registry grew unbounded. Sessions stuck
 * in non-terminal states (e.g. RUNNING after a crash) were never evicted
 * by sweepOrphansImpl because it skipped every non-terminal entry.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_ORPHAN_TTL_MS, sweepOrphansImpl } from "@/session/manager-sweep";
import { _sessionManagerDeps } from "@/session/manager-deps";
import type { SessionDescriptor, SessionState } from "@/session/types";

function makeSession(overrides: Partial<SessionDescriptor> & { id: string; state: SessionState }): SessionDescriptor {
  return {
    storyId: "US-001",
    role: "main",
    lastActivityAt: new Date().toISOString(),
    handle: `handle-${overrides.id}`,
    ...overrides,
  };
}

const originalNowMs = _sessionManagerDeps.nowMs;
afterEach(() => {
  _sessionManagerDeps.nowMs = originalNowMs;
  mock.restore();
});

describe("sweepOrphansImpl — terminal sessions", () => {
  test("removes terminal session older than TTL", () => {
    const oldSession = makeSession({
      id: "term-old",
      state: "COMPLETED",
      lastActivityAt: new Date(Date.now() - (DEFAULT_ORPHAN_TTL_MS + 1000)).toISOString(),
    });
    const sessions = new Map([[oldSession.id, oldSession]]);

    const removed = sweepOrphansImpl(sessions, DEFAULT_ORPHAN_TTL_MS);
    expect(removed).toBe(1);
    expect(sessions.has("term-old")).toBe(false);
  });

  test("preserves terminal session newer than TTL", () => {
    const newSession = makeSession({
      id: "term-new",
      state: "COMPLETED",
      lastActivityAt: new Date().toISOString(),
    });
    const sessions = new Map([[newSession.id, newSession]]);

    const removed = sweepOrphansImpl(sessions, DEFAULT_ORPHAN_TTL_MS);
    expect(removed).toBe(0);
    expect(sessions.has("term-new")).toBe(true);
  });
});

describe("sweepOrphansImpl — MEM-1 non-terminal (stuck) sessions", () => {
  test("removes RUNNING session older than TTL (regression: pre-fix left forever)", () => {
    // Pre-fix sweepOrphansImpl skipped every non-terminal entry — a session
    // stuck RUNNING after a crash was never evicted until process restart.
    const stuckSession = makeSession({
      id: "stuck-running",
      state: "RUNNING",
      lastActivityAt: new Date(Date.now() - (DEFAULT_ORPHAN_TTL_MS + 1000)).toISOString(),
    });
    const sessions = new Map([[stuckSession.id, stuckSession]]);

    const removed = sweepOrphansImpl(sessions, DEFAULT_ORPHAN_TTL_MS);
    expect(removed).toBe(1);
    expect(sessions.has("stuck-running")).toBe(false);
  });

  test("preserves RUNNING session newer than TTL", () => {
    const recent = makeSession({
      id: "running-recent",
      state: "RUNNING",
      lastActivityAt: new Date().toISOString(),
    });
    const sessions = new Map([[recent.id, recent]]);

    const removed = sweepOrphansImpl(sessions, DEFAULT_ORPHAN_TTL_MS);
    expect(removed).toBe(0);
    expect(sessions.has("running-recent")).toBe(true);
  });

  test("preserves CREATED session newer than TTL", () => {
    const recent = makeSession({
      id: "created-recent",
      state: "CREATED",
      lastActivityAt: new Date().toISOString(),
    });
    const sessions = new Map([[recent.id, recent]]);

    const removed = sweepOrphansImpl(sessions, DEFAULT_ORPHAN_TTL_MS);
    expect(removed).toBe(0);
    expect(sessions.has("created-recent")).toBe(true);
  });

  test("removes stale non-terminal session with no usable lastActivityAt (NaN guard)", () => {
    const stuck = makeSession({
      id: "stuck-no-ts",
      state: "RUNNING",
      lastActivityAt: undefined,
    });
    const sessions = new Map([[stuck.id, stuck]]);

    const removed = sweepOrphansImpl(sessions, DEFAULT_ORPHAN_TTL_MS);
    expect(removed).toBe(1);
    expect(sessions.has("stuck-no-ts")).toBe(false);
  });

  test("sweeps a mixed batch: only stuck-old and terminal-old are evicted", () => {
    const now = Date.now();
    const sessions = new Map<string, SessionDescriptor>([
      ["running-old", makeSession({ id: "running-old", state: "RUNNING", lastActivityAt: new Date(now - (DEFAULT_ORPHAN_TTL_MS + 1000)).toISOString() })],
      ["running-recent", makeSession({ id: "running-recent", state: "RUNNING", lastActivityAt: new Date(now).toISOString() })],
      ["term-old", makeSession({ id: "term-old", state: "FAILED", lastActivityAt: new Date(now - (DEFAULT_ORPHAN_TTL_MS + 1000)).toISOString() })],
      ["term-recent", makeSession({ id: "term-recent", state: "COMPLETED", lastActivityAt: new Date(now).toISOString() })],
    ]);

    const removed = sweepOrphansImpl(sessions, DEFAULT_ORPHAN_TTL_MS);
    expect(removed).toBe(2);
    expect(sessions.has("running-old")).toBe(false);
    expect(sessions.has("term-old")).toBe(false);
    expect(sessions.has("running-recent")).toBe(true);
    expect(sessions.has("term-recent")).toBe(true);
  });
});