import { describe, test, expect, beforeEach } from "bun:test";
import { SessionManager, _sessionManagerDeps } from "../../../src/session/manager";
import { NaxError } from "../../../src/errors";
import type { SessionState } from "../../../src/session/types";

// ─────────────────────────────────────────────────────────────────────────────
// Test setup
// ─────────────────────────────────────────────────────────────────────────────

let _uuidSeq = 0;
let _timeSeq = 0;

beforeEach(() => {
  _uuidSeq = 0;
  _timeSeq = 0;
  _sessionManagerDeps.uuid = () => `00000000-0000-0000-0000-${String(++_uuidSeq).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`;
  _sessionManagerDeps.now = () => `2025-01-01T00:${String(_timeSeq++).padStart(2, "0")}:00.000Z`;
});

// ─────────────────────────────────────────────────────────────────────────────
// create()
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionManager.create()", () => {
  test("returns a descriptor with CREATED state", () => {
    const mgr = new SessionManager();
    const desc = mgr.create({ role: "main", agent: "claude", workdir: "/project" });
    expect(desc.state).toBe("CREATED");
    expect(desc.role).toBe("main");
    expect(desc.agent).toBe("claude");
    expect(desc.id).toMatch(/^sess-[0-9a-f-]{36}$/);
  });

  test("initialises protocolIds as null", () => {
    const mgr = new SessionManager();
    const desc = mgr.create({ role: "main", agent: "claude", workdir: "/project" });
    expect(desc.protocolIds.recordId).toBeNull();
    expect(desc.protocolIds.sessionId).toBeNull();
  });

  test("completedStages starts empty", () => {
    const mgr = new SessionManager();
    const desc = mgr.create({ role: "main", agent: "claude", workdir: "/project" });
    expect(desc.completedStages).toHaveLength(0);
  });

  test("returns an immutable copy (mutations don't affect registry)", () => {
    const mgr = new SessionManager();
    const desc = mgr.create({ role: "main", agent: "claude", workdir: "/project" });
    (desc as { state: SessionState }).state = "RUNNING";
    const fetched = mgr.get(desc.id);
    expect(fetched?.state).toBe("CREATED");
  });

  test("storyId and featureName are optional", () => {
    const mgr = new SessionManager();
    const desc = mgr.create({ role: "decompose", agent: "claude", workdir: "/p", storyId: "US-001", featureName: "auth" });
    expect(desc.storyId).toBe("US-001");
    expect(desc.featureName).toBe("auth");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// get()
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionManager.get()", () => {
  test("returns null for unknown id", () => {
    const mgr = new SessionManager();
    expect(mgr.get("sess-unknown")).toBeNull();
  });

  test("returns descriptor after create", () => {
    const mgr = new SessionManager();
    const created = mgr.create({ role: "main", agent: "claude", workdir: "/project" });
    const fetched = mgr.get(created.id);
    expect(fetched?.id).toBe(created.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// transition()
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionManager.transition()", () => {
  test("CREATED → RUNNING succeeds", () => {
    const mgr = new SessionManager();
    const sess = mgr.create({ role: "main", agent: "claude", workdir: "/p" });
    const updated = mgr.transition(sess.id, "RUNNING");
    expect(updated.state).toBe("RUNNING");
  });

  test("updates lastActivityAt on transition", () => {
    const mgr = new SessionManager();
    const sess = mgr.create({ role: "main", agent: "claude", workdir: "/p" });
    const before = sess.lastActivityAt;
    const updated = mgr.transition(sess.id, "RUNNING");
    expect(updated.lastActivityAt).not.toBe(before);
  });

  test("invalid transition throws NaxError", () => {
    const mgr = new SessionManager();
    const sess = mgr.create({ role: "main", agent: "claude", workdir: "/p" });
    expect(() => mgr.transition(sess.id, "COMPLETED")).toThrow(NaxError);
  });

  test("transition on unknown ID throws NaxError", () => {
    const mgr = new SessionManager();
    expect(() => mgr.transition("sess-fake", "RUNNING")).toThrow(NaxError);
  });

  test("protocolIds updated via options", () => {
    const mgr = new SessionManager();
    const sess = mgr.create({ role: "main", agent: "claude", workdir: "/p" });
    mgr.transition(sess.id, "RUNNING");
    const updated = mgr.transition(sess.id, "COMPLETED", {
      protocolIds: { recordId: "rec-123", sessionId: "sid-456" },
    });
    expect(updated.protocolIds.recordId).toBe("rec-123");
    expect(updated.protocolIds.sessionId).toBe("sid-456");
  });

  test("completedStage appended via options", () => {
    const mgr = new SessionManager();
    const sess = mgr.create({ role: "main", agent: "claude", workdir: "/p" });
    mgr.transition(sess.id, "RUNNING");
    const updated = mgr.transition(sess.id, "PAUSED", { completedStage: "verify" });
    expect(updated.completedStages).toContain("verify");
  });

  test("terminal states cannot be transitioned further", () => {
    const mgr = new SessionManager();
    const sess = mgr.create({ role: "main", agent: "claude", workdir: "/p" });
    mgr.transition(sess.id, "RUNNING");
    mgr.transition(sess.id, "COMPLETED");
    expect(() => mgr.transition(sess.id, "RUNNING")).toThrow(NaxError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listActive()
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionManager.listActive()", () => {
  test("empty manager: returns empty array", () => {
    const mgr = new SessionManager();
    expect(mgr.listActive()).toHaveLength(0);
  });

  test("excludes COMPLETED and FAILED sessions", () => {
    const mgr = new SessionManager();
    const s1 = mgr.create({ role: "main", agent: "claude", workdir: "/p" });
    const s2 = mgr.create({ role: "main", agent: "claude", workdir: "/p" });
    mgr.transition(s1.id, "RUNNING");
    mgr.transition(s1.id, "COMPLETED");
    const active = mgr.listActive();
    const ids = active.map((s) => s.id);
    expect(ids).not.toContain(s1.id);
    expect(ids).toContain(s2.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sweepOrphans()
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionManager.sweepOrphans()", () => {
  test("returns 0 when no terminal sessions exist", () => {
    const mgr = new SessionManager();
    mgr.create({ role: "main", agent: "claude", workdir: "/p" });
    expect(mgr.sweepOrphans(0)).toBe(0);
  });

  test("removes terminal sessions older than ttl", () => {
    const mgr = new SessionManager();
    // Set time to old timestamp
    _sessionManagerDeps.now = () => new Date(Date.now() - 10_000).toISOString();
    const sess = mgr.create({ role: "main", agent: "claude", workdir: "/p" });
    mgr.transition(sess.id, "RUNNING");
    mgr.transition(sess.id, "COMPLETED");

    // Sweep with ttl=1ms (anything older than 1ms is an orphan)
    const removed = mgr.sweepOrphans(1);
    expect(removed).toBe(1);
    expect(mgr.get(sess.id)).toBeNull();
  });

  test("keeps terminal sessions newer than ttl", () => {
    // Reset mock to current time so lastActivityAt is "now"
    _sessionManagerDeps.now = () => new Date().toISOString();
    const mgr = new SessionManager();
    const sess = mgr.create({ role: "main", agent: "claude", workdir: "/p" });
    mgr.transition(sess.id, "RUNNING");
    mgr.transition(sess.id, "COMPLETED");
    // Use max safe integer TTL — the session was just completed so it can't be older
    const removed = mgr.sweepOrphans(Number.MAX_SAFE_INTEGER);
    expect(removed).toBe(0);
  });
});
