import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SessionManager, _sessionManagerDeps } from "@/session/manager";
import { NaxError } from "@/errors";
import type { SessionState } from "@/session/types";

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
  test("returns a descriptor with CREATED state, correct fields, empty protocolIds/completedStages; copy is immutable", () => {
    const mgr = new SessionManager();
    const desc = mgr.create({ role: "main", agent: "claude", workdir: "/project" });
    expect(desc.state).toBe("CREATED");
    expect(desc.role).toBe("main");
    expect(desc.agent).toBe("claude");
    expect(desc.id).toMatch(/^sess-[0-9a-f-]{36}$/);
    expect(desc.protocolIds.recordId).toBeNull();
    expect(desc.protocolIds.sessionId).toBeNull();
    expect(desc.completedStages).toHaveLength(0);
    (desc as { state: SessionState }).state = "RUNNING";
    expect(mgr.get(desc.id)?.state).toBe("CREATED");
  });

  test("storyId and featureName stored; derives scratch dir when projectDir and featureName provided", () => {
    const mgr = new SessionManager();
    const desc = mgr.create({ role: "test-writer", agent: "claude", workdir: "/repo", projectDir: "/repo", featureName: "auth", storyId: "US-001" });
    expect(desc.storyId).toBe("US-001");
    expect(desc.featureName).toBe("auth");
    expect(desc.scratchDir).toBe("/repo/.nax/features/auth/sessions/sess-00000000-0000-0000-0000-000000000001");
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
    const writes: Array<{ scratchDir: string; descriptor: unknown; projectDir?: string }> = [];
    _sessionManagerDeps.writeDescriptor = async (scratchDir, descriptor, projectDir) => {
      writes.push({ scratchDir, descriptor, projectDir });
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
    expect(writes[0]?.projectDir).toBe("/repo");

    _sessionManagerDeps.writeDescriptor = originalWriteDescriptor;
  });

  test("skips descriptor write when scratchDir unresolved; write failure does not throw from create()", async () => {
    const writes: Array<unknown> = [];
    _sessionManagerDeps.writeDescriptor = async (scratchDir) => { writes.push(scratchDir); };
    const mgr = new SessionManager();
    mgr.create({ role: "main", agent: "claude", workdir: "/repo" });
    await Promise.resolve();
    await Promise.resolve();
    expect(writes).toHaveLength(0);

    _sessionManagerDeps.writeDescriptor = async () => { throw new Error("disk full"); };
    const mgr2 = new SessionManager();
    expect(() => mgr2.create({ role: "main", agent: "claude", workdir: "/repo", projectDir: "/repo", featureName: "auth", storyId: "US-001" })).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    _sessionManagerDeps.writeDescriptor = originalWriteDescriptor;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// descriptor re-persistence on mutation (Finding from hello-lint dogfood)
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionManager — descriptor re-persistence on mutation", () => {
  let originalWriteDescriptor: typeof _sessionManagerDeps.writeDescriptor;
  let writes: Array<{ state: string; protocolIds: { recordId: string | null; sessionId: string | null }; agent: string; handle?: string }>;

  beforeEach(() => {
    originalWriteDescriptor = _sessionManagerDeps.writeDescriptor;
    writes = [];
    _sessionManagerDeps.writeDescriptor = async (_scratchDir, descriptor) => {
      writes.push({
        state: descriptor.state,
        protocolIds: descriptor.protocolIds,
        agent: descriptor.agent,
        handle: descriptor.handle,
      });
    };
  });

  const drainMicrotasks = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  test("transition() re-persists the descriptor with the new state", async () => {
    const mgr = new SessionManager();
    const s = mgr.create({
      role: "main",
      agent: "claude",
      workdir: "/repo",
      projectDir: "/repo",
      featureName: "auth",
      storyId: "US-001",
    });
    await drainMicrotasks();
    writes.length = 0; // drop the create() write

    mgr.transition(s.id, "RUNNING");
    await drainMicrotasks();

    expect(writes).toHaveLength(1);
    expect(writes[0]?.state).toBe("RUNNING");
  });

  test("bindHandle() re-persists the descriptor with protocolIds + handle", async () => {
    const mgr = new SessionManager();
    const s = mgr.create({
      role: "main",
      agent: "claude",
      workdir: "/repo",
      projectDir: "/repo",
      featureName: "auth",
      storyId: "US-001",
    });
    await drainMicrotasks();
    writes.length = 0;

    mgr.bindHandle(s.id, "nax-abcd-auth-US-001", { recordId: "rec-1", sessionId: "sid-1" });
    await drainMicrotasks();

    expect(writes).toHaveLength(1);
    expect(writes[0]?.handle).toBe("nax-abcd-auth-US-001");
    expect(writes[0]?.protocolIds).toEqual({ recordId: "rec-1", sessionId: "sid-1" });
  });

  test("closeStory() re-persists the descriptor with state=COMPLETED", async () => {
    const mgr = new SessionManager();
    const s = mgr.create({
      role: "main",
      agent: "claude",
      workdir: "/repo",
      projectDir: "/repo",
      featureName: "auth",
      storyId: "US-001",
    });
    mgr.transition(s.id, "RUNNING");
    await drainMicrotasks();
    writes.length = 0;

    const closed = mgr.closeStory("US-001");
    await drainMicrotasks();

    expect(closed).toHaveLength(1);
    expect(closed[0]?.state).toBe("COMPLETED");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.state).toBe("COMPLETED");
  });

  test("handoff() re-persists the descriptor with the new agent", async () => {
    const mgr = new SessionManager();
    const s = mgr.create({
      role: "main",
      agent: "claude",
      workdir: "/repo",
      projectDir: "/repo",
      featureName: "auth",
      storyId: "US-001",
    });
    await drainMicrotasks();
    writes.length = 0;

    mgr.handoff?.(s.id, "codex", "fail-auth");
    await drainMicrotasks();

    expect(writes).toHaveLength(1);
    expect(writes[0]?.agent).toBe("codex");
  });

  test("re-persistence is skipped when the session has no scratchDir", async () => {
    const mgr = new SessionManager();
    const s = mgr.create({ role: "main", agent: "claude", workdir: "/repo" });
    await drainMicrotasks();
    writes.length = 0;

    mgr.transition(s.id, "RUNNING");
    mgr.bindHandle(s.id, "nax-x", { recordId: "r", sessionId: "s" });
    mgr.handoff?.(s.id, "codex");
    await drainMicrotasks();

    expect(writes).toHaveLength(0);
  });

  test("a write failure during re-persistence does not throw from the mutation call", async () => {
    const mgr = new SessionManager();
    const s = mgr.create({
      role: "main",
      agent: "claude",
      workdir: "/repo",
      projectDir: "/repo",
      featureName: "auth",
      storyId: "US-001",
    });
    await drainMicrotasks();
    _sessionManagerDeps.writeDescriptor = async () => {
      throw new Error("disk full");
    };

    expect(() => mgr.transition(s.id, "RUNNING")).not.toThrow();
    expect(() => mgr.bindHandle(s.id, "nax-x", { recordId: "r", sessionId: "s" })).not.toThrow();
    expect(() => mgr.handoff?.(s.id, "codex")).not.toThrow();

    await drainMicrotasks();

    _sessionManagerDeps.writeDescriptor = originalWriteDescriptor;
  });

  afterEach(() => {
    _sessionManagerDeps.writeDescriptor = originalWriteDescriptor;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// get()
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionManager.get()", () => {
  test("returns null for unknown id; returns descriptor after create", () => {
    const mgr = new SessionManager();
    expect(mgr.get("sess-unknown")).toBeNull();
    const created = mgr.create({ role: "main", agent: "claude", workdir: "/project" });
    expect(mgr.get(created.id)?.id).toBe(created.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// transition()
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionManager.transition()", () => {
  test("CREATED → RUNNING succeeds and updates lastActivityAt", () => {
    const mgr = new SessionManager();
    const sess = mgr.create({ role: "main", agent: "claude", workdir: "/p" });
    const before = sess.lastActivityAt;
    const updated = mgr.transition(sess.id, "RUNNING");
    expect(updated.state).toBe("RUNNING");
    expect(updated.lastActivityAt).not.toBe(before);
  });

  test.each([
    ["invalid transition (CREATED → COMPLETED)", (mgr: SessionManager, id: string) => () => mgr.transition(id, "COMPLETED")],
    ["unknown session ID", (mgr: SessionManager) => () => mgr.transition("sess-fake", "RUNNING")],
  ] as const)("%s throws NaxError", (_label, makeCall) => {
    const mgr = new SessionManager();
    const sess = mgr.create({ role: "main", agent: "claude", workdir: "/p" });
    expect(makeCall(mgr, sess.id)).toThrow(NaxError);
  });

  test("protocolIds and completedStage updated via transition options", () => {
    const mgr = new SessionManager();
    const sess = mgr.create({ role: "main", agent: "claude", workdir: "/p" });
    mgr.transition(sess.id, "RUNNING");
    const updated = mgr.transition(sess.id, "PAUSED", {
      protocolIds: { recordId: "rec-123", sessionId: "sid-456" },
      completedStage: "verify",
    });
    expect(updated.protocolIds.recordId).toBe("rec-123");
    expect(updated.protocolIds.sessionId).toBe("sid-456");
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
  test("returns empty array when empty; excludes COMPLETED and FAILED sessions", () => {
    const mgr = new SessionManager();
    expect(mgr.listActive()).toHaveLength(0);
    const s1 = mgr.create({ role: "main", agent: "claude", workdir: "/p" });
    const s2 = mgr.create({ role: "main", agent: "claude", workdir: "/p" });
    mgr.transition(s1.id, "RUNNING");
    mgr.transition(s1.id, "COMPLETED");
    const ids = mgr.listActive().map((s) => s.id);
    expect(ids).not.toContain(s1.id);
    expect(ids).toContain(s2.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sweepOrphans()
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionManager.sweepOrphans()", () => {
  test("returns 0 when no terminal sessions; removes old terminal sessions, keeps recent ones", () => {
    // MEM-1: post-fix the sweep evicts both terminal AND non-terminal sessions
    // older than TTL. The beforeEach pins `now` to a frozen 2025 clock but
    // leaves `nowMs` as Date.now() (real wall-clock, 2026). Pin nowMs to
    // the same fixed epoch so a freshly-created session isn't judged
    // years-old and evicted on the first sweep call.
    const origNowMs = _sessionManagerDeps.nowMs;
    const FAKE_NOW_MS = new Date("2025-01-01T00:00:00.000Z").getTime();
    _sessionManagerDeps.nowMs = () => FAKE_NOW_MS;

    const mgr = new SessionManager();
    mgr.create({ role: "main", agent: "claude", workdir: "/p" });
    expect(mgr.sweepOrphans(1_000)).toBe(0);

    _sessionManagerDeps.nowMs = origNowMs;
    const mgr2 = new SessionManager();
    _sessionManagerDeps.now = () => new Date(Date.now() - 10_000).toISOString();
    const oldSess = mgr2.create({ role: "main", agent: "claude", workdir: "/p" });
    mgr2.transition(oldSess.id, "RUNNING");
    mgr2.transition(oldSess.id, "COMPLETED");

    _sessionManagerDeps.now = () => new Date().toISOString();
    const newSess = mgr2.create({ role: "main", agent: "claude", workdir: "/p" });
    mgr2.transition(newSess.id, "RUNNING");
    mgr2.transition(newSess.id, "COMPLETED");

    expect(mgr2.sweepOrphans(1)).toBe(1);
    expect(mgr2.get(oldSess.id)).toBeNull();
    expect(mgr2.get(newSess.id)).not.toBeNull();
  });

  test("sweeps a terminal session with an unparseable lastActivityAt instead of retaining it forever (BUG-43)", () => {
    const mgr = new SessionManager();
    const sess = mgr.create({ role: "main", agent: "claude", workdir: "/p" });
    mgr.transition(sess.id, "RUNNING");
    mgr.transition(sess.id, "COMPLETED");
    // Corrupt the timestamp after the fact — `new Date("not-a-date").getTime()`
    // is NaN, and `NaN < cutoff` is always false, which previously meant this
    // branch fell through and retained the session forever.
    const descriptor = mgr.get(sess.id);
    if (descriptor) descriptor.lastActivityAt = "not-a-date";

    expect(mgr.sweepOrphans(0)).toBe(1);
    expect(mgr.get(sess.id)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getForStory()
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionManager.getForStory()", () => {
  test("returns matching sessions and empty when no match; immutable copies; includes all states", () => {
    const mgr = new SessionManager();
    const s1 = mgr.create({ role: "main", agent: "claude", workdir: "/p", storyId: "US-001" });
    const s2 = mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
    const s3 = mgr.create({ role: "main", agent: "claude", workdir: "/p", storyId: "US-001" });
    mgr.create({ role: "main", agent: "claude", workdir: "/p", storyId: "US-002" });
    mgr.transition(s3.id, "RUNNING");
    mgr.transition(s3.id, "COMPLETED");

    const results = mgr.getForStory("US-001");
    expect(results).toHaveLength(3);
    expect(results.map((s) => s.id).sort()).toEqual([s1.id, s2.id, s3.id].sort());
    expect(results.some((s) => s.state === "COMPLETED")).toBe(true);
    expect(mgr.getForStory("US-999")).toHaveLength(0);

    // Immutable: mutation does not affect registry
    (results[0] as { state: string }).state = "FAILED";
    expect(mgr.getForStory("US-001")[0].state).not.toBe("FAILED");
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
  test("updates agent owner; throws NaxError for unknown session", () => {
    const mgr = new SessionManager();
    const sess = mgr.create({ role: "main", agent: "claude", workdir: "/p", storyId: "US-001" });
    const updated = mgr.handoff(sess.id, "codex", "fail-quota");
    expect(updated.agent).toBe("codex");
    expect(mgr.get(sess.id)?.agent).toBe("codex");
    expect(() => mgr.handoff("sess-unknown", "codex", "fail-quota")).toThrow(NaxError);
  });
});
