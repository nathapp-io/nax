/**
 * Tests for SessionManager.bindHandle()
 * Extracted from manager.test.ts to keep file under the 400-line limit.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { NaxError } from "../../../src/errors";
import { SessionManager, _sessionManagerDeps } from "../../../src/session/manager";

let _timeSeq = 0;

beforeEach(() => {
  _timeSeq = 0;
  _sessionManagerDeps.now = () => `2025-01-01T00:${String(_timeSeq++).padStart(2, "0")}:00.000Z`;
  _sessionManagerDeps.writeDescriptor = async () => {};
});

describe("SessionManager.bindHandle()", () => {
  test("sets handle and protocolIds on the descriptor", () => {
    const mgr = new SessionManager();
    const sess = mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });

    mgr.bindHandle(sess.id, "nax-abc12345-feat-US-001-implementer", {
      recordId: "rec-aaa",
      sessionId: "sid-bbb",
    });

    const updated = mgr.get(sess.id);
    expect(updated?.handle).toBe("nax-abc12345-feat-US-001-implementer");
    expect(updated?.protocolIds.recordId).toBe("rec-aaa");
    expect(updated?.protocolIds.sessionId).toBe("sid-bbb");
  });

  test("does not change state", () => {
    const mgr = new SessionManager();
    const sess = mgr.create({ role: "implementer", agent: "claude", workdir: "/p" });
    mgr.bindHandle(sess.id, "nax-handle", { recordId: null, sessionId: null });
    expect(mgr.get(sess.id)?.state).toBe("CREATED");
  });

  test("null protocolIds are stored as-is", () => {
    const mgr = new SessionManager();
    const sess = mgr.create({ role: "implementer", agent: "claude", workdir: "/p" });
    mgr.bindHandle(sess.id, "nax-handle", { recordId: null, sessionId: null });
    const updated = mgr.get(sess.id);
    expect(updated?.protocolIds.recordId).toBeNull();
    expect(updated?.protocolIds.sessionId).toBeNull();
  });

  test("overwrites previous handle and protocolIds on re-bind", () => {
    const mgr = new SessionManager();
    const sess = mgr.create({ role: "implementer", agent: "claude", workdir: "/p" });
    mgr.bindHandle(sess.id, "nax-first", { recordId: "r1", sessionId: "s1" });
    mgr.bindHandle(sess.id, "nax-second", { recordId: "r2", sessionId: "s2" });
    const updated = mgr.get(sess.id);
    expect(updated?.handle).toBe("nax-second");
    expect(updated?.protocolIds.recordId).toBe("r2");
  });

  test("throws NaxError for unknown session id", () => {
    const mgr = new SessionManager();
    expect(() => mgr.bindHandle("sess-unknown", "nax-handle", { recordId: null, sessionId: null })).toThrow(NaxError);
  });

  test("returns an immutable copy (mutations don't affect registry)", () => {
    const mgr = new SessionManager();
    const sess = mgr.create({ role: "implementer", agent: "claude", workdir: "/p" });
    const result = mgr.bindHandle(sess.id, "nax-handle", { recordId: "r1", sessionId: null });
    (result as { handle: string }).handle = "mutated";
    expect(mgr.get(sess.id)?.handle).toBe("nax-handle");
  });

  test("updates lastActivityAt", () => {
    const mgr = new SessionManager();
    const sess = mgr.create({ role: "implementer", agent: "claude", workdir: "/p" });
    const before = sess.lastActivityAt;
    mgr.bindHandle(sess.id, "nax-handle", { recordId: null, sessionId: null });
    expect(mgr.get(sess.id)?.lastActivityAt).not.toBe(before);
  });
});
