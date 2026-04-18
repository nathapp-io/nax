import { describe, expect, mock, test } from "bun:test";
import { closeAllRunSessions, closeStorySessions, failAndClose } from "../../../src/execution/session-manager-runtime";
import type { SessionDescriptor, SessionState } from "../../../src/session/types";

type SessionManagerLike = {
  closeStory(storyId: string): SessionDescriptor[];
  listActive(): SessionDescriptor[];
  transition?(id: string, to: SessionState): SessionDescriptor;
  get?(id: string): SessionDescriptor | null;
};

const makeSessionDescriptor = (overrides: Partial<SessionDescriptor> = {}): SessionDescriptor =>
  ({
    id: "sess-1",
    role: "implementer",
    state: "RUNNING",
    agent: "claude",
    workdir: "/workdir",
    protocolIds: { recordId: null, sessionId: null },
    completedStages: [],
    createdAt: "2025-01-01T00:00:00.000Z",
    lastActivityAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  }) satisfies SessionDescriptor;

describe("closeStorySessions()", () => {
  test("closes physical handles returned by closeStory() only when handle exists", async () => {
    const withHandle = makeSessionDescriptor({ id: "sess-1", handle: "nax-story-1", workdir: "/workdir/a" });
    const withoutHandle = makeSessionDescriptor({ id: "sess-2" });
    const sessionManager: SessionManagerLike = {
      closeStory: mock(() => [withHandle, withoutHandle]),
      listActive: mock(() => []),
    };
    const closePhysicalSession = mock(async () => {});
    const agentGetFn = mock(() => ({ closePhysicalSession }));

    const closed = await closeStorySessions(sessionManager, "US-001", agentGetFn);

    expect(closed).toBe(2);
    expect(sessionManager.closeStory).toHaveBeenCalledTimes(1);
    expect(sessionManager.closeStory).toHaveBeenCalledWith("US-001");
    expect(agentGetFn).toHaveBeenCalledTimes(1);
    expect(closePhysicalSession).toHaveBeenCalledTimes(1);
    expect(closePhysicalSession).toHaveBeenCalledWith("nax-story-1", "/workdir/a", undefined);
  });

  test("does not close a physical session when the handle is missing", async () => {
    const withoutHandle = makeSessionDescriptor({ id: "sess-1" });
    const sessionManager: SessionManagerLike = {
      closeStory: mock(() => [withoutHandle]),
      listActive: mock(() => []),
    };
    const closePhysicalSession = mock(async () => {});
    const agentGetFn = mock(() => ({ closePhysicalSession }));

    const closed = await closeStorySessions(sessionManager, "US-001", agentGetFn);

    expect(closed).toBe(1);
    expect(agentGetFn).not.toHaveBeenCalled();
    expect(closePhysicalSession).not.toHaveBeenCalled();
  });

  test("swallows adapter.closePhysicalSession rejections", async () => {
    const withHandle = makeSessionDescriptor({ id: "sess-1", handle: "nax-story-1", workdir: "/workdir/a" });
    const sessionManager: SessionManagerLike = {
      closeStory: mock(() => [withHandle]),
      listActive: mock(() => []),
    };
    const closePhysicalSession = mock(async () => {
      throw new Error("boom");
    });
    const agentGetFn = mock(() => ({ closePhysicalSession }));

    await expect(closeStorySessions(sessionManager, "US-001", agentGetFn)).resolves.toBe(1);
    expect(closePhysicalSession).toHaveBeenCalledTimes(1);
  });
});

describe("closeStorySessions() — AC-83 force-terminate", () => {
  test("passes force=true to closePhysicalSession when descriptor was FAILED", async () => {
    const failedDescriptor = makeSessionDescriptor({ id: "sess-1", state: "FAILED", handle: "nax-1", workdir: "/workdir/a" });
    const sessionManager: SessionManagerLike = {
      closeStory: mock(() => [failedDescriptor]),
      listActive: mock(() => []),
    };
    const closePhysicalSession = mock(async () => {});
    const agentGetFn = mock(() => ({ closePhysicalSession }));

    await closeStorySessions(sessionManager, "US-001", agentGetFn);

    expect(closePhysicalSession).toHaveBeenCalledWith("nax-1", "/workdir/a", { force: true });
  });

  test("does not pass force when descriptor was not FAILED", async () => {
    const runningDescriptor = makeSessionDescriptor({ id: "sess-1", state: "RUNNING", handle: "nax-1", workdir: "/workdir/a" });
    const sessionManager: SessionManagerLike = {
      closeStory: mock(() => [runningDescriptor]),
      listActive: mock(() => []),
    };
    const closePhysicalSession = mock(async () => {});
    const agentGetFn = mock(() => ({ closePhysicalSession }));

    await closeStorySessions(sessionManager, "US-001", agentGetFn);

    expect(closePhysicalSession).toHaveBeenCalledWith("nax-1", "/workdir/a", undefined);
  });
});

describe("closeAllRunSessions() — idempotency (H-5)", () => {
  test("second call is a no-op when sessionManager returns no active sessions", async () => {
    const session = makeSessionDescriptor({ id: "sess-1", storyId: "US-001", handle: "nax-1" });
    const closeStory = mock(() => [session]);
    const listActive = mock()
      .mockImplementationOnce(() => [session]) // first call — one active session
      .mockImplementationOnce(() => []); // second call — already closed
    const sessionManager: SessionManagerLike = { closeStory, listActive };
    const agentGetFn = mock(() => ({ closePhysicalSession: mock(async () => {}) }));

    const first = await closeAllRunSessions(sessionManager, agentGetFn);
    const second = await closeAllRunSessions(sessionManager, agentGetFn);

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(closeStory).toHaveBeenCalledTimes(1); // only called on first run
  });
});

describe("failAndClose() — H-1", () => {
  test("transitions session to FAILED and force-closes physical handle", async () => {
    const runningSession = makeSessionDescriptor({ id: "sess-1", state: "RUNNING", handle: "nax-1", workdir: "/workdir/a" });
    const failedSession = { ...runningSession, state: "FAILED" as SessionState };
    const get = mock()
      .mockImplementationOnce(() => runningSession) // initial guard check
      .mockImplementationOnce(() => failedSession); // after transition
    const transition = mock(() => failedSession);
    const closePhysicalSession = mock(async () => {});
    const agentGetFn = mock(() => ({ closePhysicalSession }));

    await failAndClose({ get, transition }, "sess-1", agentGetFn);

    expect(transition).toHaveBeenCalledWith("sess-1", "FAILED");
    expect(closePhysicalSession).toHaveBeenCalledWith("nax-1", "/workdir/a", { force: true });
  });

  test("is a no-op when session is already in a terminal state", async () => {
    const terminalSession = makeSessionDescriptor({ id: "sess-1", state: "COMPLETED" });
    const get = mock(() => terminalSession);
    const transition = mock(() => terminalSession);
    const closePhysicalSession = mock(async () => {});
    const agentGetFn = mock(() => ({ closePhysicalSession }));

    await failAndClose({ get, transition }, "sess-1", agentGetFn);

    expect(transition).not.toHaveBeenCalled();
    expect(closePhysicalSession).not.toHaveBeenCalled();
  });

  test("is a no-op when session is unknown", async () => {
    const get = mock(() => null);
    const transition = mock();
    const closePhysicalSession = mock(async () => {});
    const agentGetFn = mock(() => ({ closePhysicalSession }));

    await failAndClose({ get, transition }, "sess-missing", agentGetFn);

    expect(transition).not.toHaveBeenCalled();
    expect(closePhysicalSession).not.toHaveBeenCalled();
  });

  test("swallows transition errors and skips physical close", async () => {
    const runningSession = makeSessionDescriptor({ id: "sess-1", state: "RUNNING", handle: "nax-1" });
    const get = mock(() => runningSession);
    const transition = mock(() => {
      throw new Error("invalid transition");
    });
    const closePhysicalSession = mock(async () => {});
    const agentGetFn = mock(() => ({ closePhysicalSession }));

    await expect(failAndClose({ get, transition }, "sess-1", agentGetFn)).resolves.toBeUndefined();
    expect(closePhysicalSession).not.toHaveBeenCalled();
  });

  test("skips physical close when the session has no handle", async () => {
    const runningSession = makeSessionDescriptor({ id: "sess-1", state: "RUNNING", handle: undefined });
    const failedSession = { ...runningSession, state: "FAILED" as SessionState };
    const get = mock()
      .mockImplementationOnce(() => runningSession)
      .mockImplementationOnce(() => failedSession);
    const transition = mock(() => failedSession);
    const closePhysicalSession = mock(async () => {});
    const agentGetFn = mock(() => ({ closePhysicalSession }));

    await failAndClose({ get, transition }, "sess-1", agentGetFn);

    expect(transition).toHaveBeenCalledTimes(1);
    expect(agentGetFn).not.toHaveBeenCalled();
    expect(closePhysicalSession).not.toHaveBeenCalled();
  });
});

describe("closeAllRunSessions()", () => {
  test("dedupes story IDs from listActive() before calling closeStory()", async () => {
    const storyOneA = makeSessionDescriptor({ id: "sess-1", storyId: "US-001", handle: "nax-1" });
    const storyOneB = makeSessionDescriptor({ id: "sess-2", storyId: "US-001", handle: "nax-2" });
    const storyTwo = makeSessionDescriptor({ id: "sess-3", storyId: "US-002", handle: "nax-3" });
    const sessionManager: SessionManagerLike = {
      closeStory: mock(() => [storyOneA]),
      listActive: mock(() => [storyOneA, storyOneB, storyTwo]),
    };
    const agentGetFn = mock(() => ({ closePhysicalSession: mock(async () => {}) }));

    const closed = await closeAllRunSessions(sessionManager, agentGetFn);

    expect(closed).toBe(2);
    expect(sessionManager.closeStory).toHaveBeenCalledTimes(2);
    expect(sessionManager.closeStory).toHaveBeenNthCalledWith(1, "US-001");
    expect(sessionManager.closeStory).toHaveBeenNthCalledWith(2, "US-002");
  });

  test("closes storyless active sessions via transition and physical close", async () => {
    const storyBound = makeSessionDescriptor({ id: "sess-1", storyId: "US-001", handle: "nax-1" });
    const storyless = makeSessionDescriptor({ id: "sess-2", handle: "nax-2", workdir: "/workdir/b" });
    const sessionManager: SessionManagerLike = {
      closeStory: mock(() => [storyBound]),
      listActive: mock(() => [storyBound, storyless]),
      transition: mock(() => storyless),
    };
    const closePhysicalSession = mock(async () => {});
    const agentGetFn = mock(() => ({ closePhysicalSession }));

    const closed = await closeAllRunSessions(sessionManager, agentGetFn);

    expect(closed).toBe(2);
    expect(sessionManager.closeStory).toHaveBeenCalledTimes(1);
    expect(sessionManager.transition).toHaveBeenCalledTimes(1);
    expect(sessionManager.transition).toHaveBeenCalledWith("sess-2", "COMPLETED");
    expect(closePhysicalSession).toHaveBeenCalledTimes(2);
    // RUNNING sessions are not force-terminated (undefined third arg)
    expect(closePhysicalSession).toHaveBeenNthCalledWith(1, "nax-1", "/workdir", undefined);
    expect(closePhysicalSession).toHaveBeenNthCalledWith(2, "nax-2", "/workdir/b", undefined);
  });

  test("walks a valid transition chain for a storyless PAUSED session", async () => {
    const storyless = makeSessionDescriptor({ id: "sess-2", state: "PAUSED", handle: "nax-2", workdir: "/workdir/b" });
    const sessionManager: SessionManagerLike = {
      closeStory: mock(() => []),
      listActive: mock(() => [storyless]),
      transition: mock(() => storyless),
    };
    const closePhysicalSession = mock(async () => {});
    const agentGetFn = mock(() => ({ closePhysicalSession }));

    const closed = await closeAllRunSessions(sessionManager, agentGetFn);

    expect(closed).toBe(1);
    expect(sessionManager.transition).toHaveBeenNthCalledWith(1, "sess-2", "RESUMING");
    expect(sessionManager.transition).toHaveBeenNthCalledWith(2, "sess-2", "RUNNING");
    expect(sessionManager.transition).toHaveBeenNthCalledWith(3, "sess-2", "COMPLETED");
    expect(closePhysicalSession).toHaveBeenCalledTimes(1);
    // PAUSED sessions are not force-terminated (undefined third arg)
    expect(closePhysicalSession).toHaveBeenCalledWith("nax-2", "/workdir/b", undefined);
  });
});
