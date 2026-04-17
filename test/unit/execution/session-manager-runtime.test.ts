import { describe, expect, mock, test } from "bun:test";
import type { SessionDescriptor } from "../../../src/session/types";
import { closeAllRunSessions, closeStorySessions } from "../../../src/execution/session-manager-runtime";

type SessionManagerLike = {
  closeStory(storyId: string): SessionDescriptor[];
  listActive(): SessionDescriptor[];
  transition?(id: string, to: "COMPLETED"): SessionDescriptor;
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
    expect(closePhysicalSession).toHaveBeenCalledWith("nax-story-1", "/workdir/a");
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
    expect(closePhysicalSession).toHaveBeenNthCalledWith(1, "nax-1", "/workdir");
    expect(closePhysicalSession).toHaveBeenNthCalledWith(2, "nax-2", "/workdir/b");
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
    expect(closePhysicalSession).toHaveBeenCalledWith("nax-2", "/workdir/b");
  });
});
