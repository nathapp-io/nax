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

  test("derives a scratch dir when projectDir and featureName are provided", () => {
    const mgr = new SessionManager();
    const desc = mgr.create({
      role: "test-writer",
      agent: "claude",
      workdir: "/repo",
      projectDir: "/repo",
      featureName: "auth",
      storyId: "US-001",
    });
    expect(desc.scratchDir).toBe(
      "/repo/.nax/features/auth/sessions/sess-00000000-0000-0000-0000-000000000001",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// descriptor persistence (Finding 2)
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionManager.create() — descriptor persistence", () => {
  let originalWriteDescriptor: typeof _sessionManagerDeps.writeDescriptor;

  beforeEach(() => {
    originalWriteDescriptor = _sessionManagerDeps.writeDescriptor;
  });

  test("writes descriptor.json when scratchDir is resolved", async () => {
    const writes: Array<{ scratchDir: string; descriptor: unknown }> = [];
    _sessionManagerDeps.writeDescriptor = async (scratchDir, descriptor) => {
      writes.push({ scratchDir, descriptor });
    };

    const mgr = new SessionManager();
    mgr.create({
      role: "test-writer",
      agent: "claude",
      workdir: "/repo",
      projectDir: "/repo",
      featureName: "auth",
      storyId: "US-001",
    });

    // Fire-and-forget — give the microtask queue a chance to drain
    await Promise.resolve();
    await Promise.resolve();

    expect(writes).toHaveLength(1);
    expect(writes[0]?.scratchDir).toBe(
      "/repo/.nax/features/auth/sessions/sess-00000000-0000-0000-0000-000000000001",
    );
    const persisted = writes[0]?.descriptor as { storyId?: string; role?: string };
    expect(persisted.storyId).toBe("US-001");
    expect(persisted.role).toBe("test-writer");

    _sessionManagerDeps.writeDescriptor = originalWriteDescriptor;
  });

  test("skips descriptor write when scratchDir cannot be resolved", async () => {
    const writes: Array<unknown> = [];
    _sessionManagerDeps.writeDescriptor = async (scratchDir) => {
      writes.push(scratchDir);
    };

    const mgr = new SessionManager();
    mgr.create({ role: "main", agent: "claude", workdir: "/repo" });

    await Promise.resolve();
    await Promise.resolve();

    expect(writes).toHaveLength(0);

    _sessionManagerDeps.writeDescriptor = originalWriteDescriptor;
  });

  test("descriptor write failure does not throw from create()", async () => {
    _sessionManagerDeps.writeDescriptor = async () => {
      throw new Error("disk full");
    };

    const mgr = new SessionManager();
    expect(() =>
      mgr.create({
        role: "main",
        agent: "claude",
        workdir: "/repo",
        projectDir: "/repo",
        featureName: "auth",
        storyId: "US-001",
      }),
    ).not.toThrow();

    // Let the rejected promise settle so the logger.warn branch runs.
    await Promise.resolve();
    await Promise.resolve();

    _sessionManagerDeps.writeDescriptor = originalWriteDescriptor;
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

// ─────────────────────────────────────────────────────────────────────────────
// getForStory()
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionManager.getForStory()", () => {
  test("returns all sessions matching the given storyId", () => {
    const mgr = new SessionManager();
    const s1 = mgr.create({ role: "main", agent: "claude", workdir: "/p", storyId: "US-001" });
    const s2 = mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
    mgr.create({ role: "main", agent: "claude", workdir: "/p", storyId: "US-002" });

    const results = mgr.getForStory("US-001");
    expect(results).toHaveLength(2);
    expect(results.map((s) => s.id).sort()).toEqual([s1.id, s2.id].sort());
  });

  test("returns empty array when no sessions match", () => {
    const mgr = new SessionManager();
    mgr.create({ role: "main", agent: "claude", workdir: "/p", storyId: "US-001" });
    expect(mgr.getForStory("US-999")).toHaveLength(0);
  });

  test("returns immutable copies (mutations don't affect registry)", () => {
    const mgr = new SessionManager();
    mgr.create({ role: "main", agent: "claude", workdir: "/p", storyId: "US-001" });
    const results = mgr.getForStory("US-001");
    (results[0] as { state: string }).state = "FAILED";
    expect(mgr.getForStory("US-001")[0].state).toBe("CREATED");
  });

  test("includes sessions regardless of state", () => {
    const mgr = new SessionManager();
    const sess = mgr.create({ role: "main", agent: "claude", workdir: "/p", storyId: "US-001" });
    mgr.transition(sess.id, "RUNNING");
    mgr.transition(sess.id, "COMPLETED");
    const results = mgr.getForStory("US-001");
    expect(results).toHaveLength(1);
    expect(results[0].state).toBe("COMPLETED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// bindHandle() — Phase 1 plumbing
// ─────────────────────────────────────────────────────────────────────────────

// bindHandle() tests extracted to manager-bind-handle.test.ts to keep file under 400 lines.

// ─────────────────────────────────────────────────────────────────────────────
// handoff() — fallback agent ownership
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionManager.handoff()", () => {
  test("updates the session's agent owner", () => {
    const mgr = new SessionManager();
    const sess = mgr.create({ role: "main", agent: "claude", workdir: "/p", storyId: "US-001" });
    const updated = mgr.handoff(sess.id, "codex", "fail-quota");
    expect(updated.agent).toBe("codex");
    expect(mgr.get(sess.id)?.agent).toBe("codex");
  });

  test("handoff on unknown session throws NaxError", () => {
    const mgr = new SessionManager();
    expect(() => mgr.handoff("sess-unknown", "codex", "fail-quota")).toThrow(NaxError);
  });
});
