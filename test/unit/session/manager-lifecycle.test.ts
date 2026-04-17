/**
 * Tests for SessionManager lifecycle methods added in Phase 3 (Issue #477):
 *   - resume(storyId, role) — look up non-terminal session by storyId+role
 *   - closeStory(storyId)   — force-close all non-terminal sessions for a story
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { SessionManager, _sessionManagerDeps } from "../../../src/session/manager";

// ─────────────────────────────────────────────────────────────────────────────
// Test setup
// ─────────────────────────────────────────────────────────────────────────────

let _uuidSeq = 0;
let _timeSeq = 0;

beforeEach(() => {
  _uuidSeq = 0;
  _timeSeq = 0;
  _sessionManagerDeps.uuid = () =>
    `00000000-0000-0000-0000-${String(++_uuidSeq).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`;
  _sessionManagerDeps.now = () =>
    `2025-01-01T00:${String(_timeSeq++).padStart(2, "0")}:00.000Z`;
  // Suppress disk writes during unit tests
  _sessionManagerDeps.writeDescriptor = async () => {};
});

// ─────────────────────────────────────────────────────────────────────────────
// resume()
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionManager.resume()", () => {
  test("returns null when no sessions exist", () => {
    const mgr = new SessionManager();
    expect(mgr.resume("US-001", "implementer")).toBeNull();
  });

  test("returns null when storyId doesn't match", () => {
    const mgr = new SessionManager();
    mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-002" });
    expect(mgr.resume("US-001", "implementer")).toBeNull();
  });

  test("returns null when role doesn't match", () => {
    const mgr = new SessionManager();
    mgr.create({ role: "test-writer", agent: "claude", workdir: "/p", storyId: "US-001" });
    expect(mgr.resume("US-001", "implementer")).toBeNull();
  });

  test("returns null for COMPLETED sessions", () => {
    const mgr = new SessionManager();
    const desc = mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
    mgr.transition(desc.id, "RUNNING");
    mgr.closeStory("US-001"); // force to COMPLETED
    expect(mgr.resume("US-001", "implementer")).toBeNull();
  });

  test("returns null for FAILED sessions", () => {
    const mgr = new SessionManager();
    const desc = mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
    mgr.transition(desc.id, "RUNNING");
    mgr.transition(desc.id, "FAILED");
    expect(mgr.resume("US-001", "implementer")).toBeNull();
  });

  test("returns the descriptor for a CREATED session", () => {
    const mgr = new SessionManager();
    const created = mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
    const found = mgr.resume("US-001", "implementer");
    expect(found).not.toBeNull();
    expect(found?.id).toBe(created.id);
    expect(found?.state).toBe("CREATED");
  });

  test("returns the descriptor for a RUNNING session", () => {
    const mgr = new SessionManager();
    const desc = mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
    mgr.transition(desc.id, "RUNNING");
    const found = mgr.resume("US-001", "implementer");
    expect(found?.state).toBe("RUNNING");
  });

  test("returns an immutable copy — mutations don't affect registry", () => {
    const mgr = new SessionManager();
    mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
    const found = mgr.resume("US-001", "implementer")!;
    (found as { agent: string }).agent = "mutated";
    const again = mgr.resume("US-001", "implementer")!;
    expect(again.agent).toBe("claude");
  });

  test("returns first matching non-terminal when multiple sessions exist for same storyId+role", () => {
    const mgr = new SessionManager();
    const a = mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
    mgr.transition(a.id, "RUNNING");
    mgr.transition(a.id, "FAILED"); // terminal
    mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
    const found = mgr.resume("US-001", "implementer");
    expect(found).not.toBeNull();
    expect(found?.state).not.toBe("FAILED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// closeStory()
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionManager.closeStory()", () => {
  test("returns empty array when no sessions exist for the story", () => {
    const mgr = new SessionManager();
    const closed = mgr.closeStory("US-001");
    expect(closed).toHaveLength(0);
  });

  test("returns empty array when all sessions are already terminal", () => {
    const mgr = new SessionManager();
    const desc = mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
    mgr.transition(desc.id, "RUNNING");
    mgr.transition(desc.id, "FAILED");
    const closed = mgr.closeStory("US-001");
    expect(closed).toHaveLength(0);
  });

  test("transitions a CREATED session to COMPLETED", () => {
    const mgr = new SessionManager();
    const desc = mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
    const closed = mgr.closeStory("US-001");
    expect(closed).toHaveLength(1);
    expect(closed[0].state).toBe("COMPLETED");
    expect(mgr.get(desc.id)?.state).toBe("COMPLETED");
  });

  test("transitions a RUNNING session to COMPLETED", () => {
    const mgr = new SessionManager();
    const desc = mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
    mgr.transition(desc.id, "RUNNING");
    const closed = mgr.closeStory("US-001");
    expect(closed[0].state).toBe("COMPLETED");
    expect(mgr.get(desc.id)?.state).toBe("COMPLETED");
  });

  test("transitions multiple sessions for the same story", () => {
    const mgr = new SessionManager();
    mgr.create({ role: "test-writer", agent: "claude", workdir: "/p", storyId: "US-001" });
    mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
    const closed = mgr.closeStory("US-001");
    expect(closed).toHaveLength(2);
    expect(closed.every((s) => s.state === "COMPLETED")).toBe(true);
  });

  test("does not affect sessions for other stories", () => {
    const mgr = new SessionManager();
    mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
    const other = mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-002" });
    mgr.closeStory("US-001");
    expect(mgr.get(other.id)?.state).toBe("CREATED");
  });

  test("updates lastActivityAt on closed sessions", () => {
    const mgr = new SessionManager();
    const desc = mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
    const priorActivity = desc.lastActivityAt;
    mgr.closeStory("US-001");
    const updated = mgr.get(desc.id)!;
    expect(updated.lastActivityAt).not.toBe(priorActivity);
  });

  test("skips already-COMPLETED sessions", () => {
    const mgr = new SessionManager();
    const desc = mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
    mgr.transition(desc.id, "RUNNING");
    mgr.transition(desc.id, "COMPLETED");
    const firstActivity = mgr.get(desc.id)!.lastActivityAt;
    mgr.closeStory("US-001"); // second call — should no-op
    expect(mgr.get(desc.id)!.lastActivityAt).toBe(firstActivity);
  });

  test("resume() returns null after closeStory()", () => {
    const mgr = new SessionManager();
    mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
    mgr.closeStory("US-001");
    expect(mgr.resume("US-001", "implementer")).toBeNull();
  });
});
