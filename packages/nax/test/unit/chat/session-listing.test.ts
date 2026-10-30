import { describe, expect, mock, test } from "bun:test";
import type { SessionListEntry, SessionListPage, SessionLockHolder, SessionMeta } from "@nathapp/nax-agent";
import { makeLogger } from "@test/helpers";
import { latestResumableId, listCwdSessions } from "@/chat/session-listing";
import { NaxError } from "@/errors";

const CWD = "/repo";
const AT = "2026-10-01T00:00:00.000Z";

function entry(sessionId: string): SessionListEntry {
  return { sessionId, cwd: CWD, title: null, updatedAt: AT };
}

function metaFor(sessionId: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    schemaVersion: 1,
    sessionId,
    cwd: CWD,
    mode: "ask",
    model: "p/m",
    bashApproval: "gated",
    title: null,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

function holder(state: SessionLockHolder["state"]): SessionLockHolder {
  return { pid: 4242, startedAt: AT, heartbeatAt: AT, state };
}

type Fixture = {
  readonly metas?: Readonly<Record<string, SessionMeta | null | Error>>;
  readonly holders?: Readonly<Record<string, SessionLockHolder | null>>;
};

function storageOf(ids: readonly string[], fixture: Fixture = {}) {
  const list = mock(async (_query: { readonly cwd?: string | null; readonly cursor?: string | null }) => ({
    sessions: ids.map(entry),
  }));
  const readMeta = mock(async (sessionId: string) => {
    const found = fixture.metas?.[sessionId];
    if (found instanceof Error) throw found;
    return found === undefined ? metaFor(sessionId) : found;
  });
  const readLockHolder = mock(async (sessionId: string) => fixture.holders?.[sessionId] ?? null);
  return { list, readMeta, readLockHolder };
}

function unreadable(): NaxError {
  return new NaxError("bad meta", "SESSION_META_UNREADABLE", { stage: "test" });
}

describe("listCwdSessions", () => {
  function paged() {
    const pages: SessionListPage[] = [
      { sessions: [entry("a"), entry("b")], nextCursor: "cursor-2" },
      { sessions: [entry("c")] },
    ];
    const list = mock(async (query: { readonly cwd?: string | null; readonly cursor?: string | null }) => {
      const page = pages[query.cursor ? 1 : 0];
      if (!page) throw new Error("unexpected page");
      return page;
    });
    return { list };
  }

  test("AC-1 returns the sessions of both pages in page order", async () => {
    const sessions = await listCwdSessions(paged(), CWD);
    expect(sessions.map((s) => s.sessionId)).toEqual(["a", "b", "c"]);
  });

  test("AC-2 passes only the cwd on the first list call", async () => {
    const storage = paged();
    await listCwdSessions(storage, CWD);
    expect(storage.list.mock.calls[0]).toEqual([{ cwd: CWD }]);
  });

  test("AC-3 passes the cwd and the cursor on the second list call", async () => {
    const storage = paged();
    await listCwdSessions(storage, CWD);
    expect(storage.list.mock.calls).toHaveLength(2);
    expect(storage.list.mock.calls[1]).toEqual([{ cwd: CWD, cursor: "cursor-2" }]);
  });
});

describe("latestResumableId", () => {
  const logger = () => makeLogger();

  test("AC-4 returns the first session with a turn, an ask or full mode and no live holder", async () => {
    const storage = storageOf(["x", "y", "z"], {
      metas: {
        x: metaFor("x", { mode: "read" }),
        y: metaFor("y", { mode: "full" }),
        z: metaFor("z"),
      },
    });
    expect(await latestResumableId({ storage, cwd: CWD, logger: logger() })).toBe("y");
  });

  test("AC-5 skips a session whose lock holder is live", async () => {
    const storage = storageOf(["a", "b"], { holders: { a: holder("live"), b: holder("stale") } });
    expect(await latestResumableId({ storage, cwd: CWD, logger: logger() })).toBe("b");
  });

  test("AC-6 skips a session whose metadata updatedAt is null", async () => {
    const storage = storageOf(["a", "b"], { metas: { a: metaFor("a", { updatedAt: null }) } });
    expect(await latestResumableId({ storage, cwd: CWD, logger: logger() })).toBe("b");
  });

  test("AC-7 skips a session whose readMeta returns null", async () => {
    const storage = storageOf(["a", "b"], { metas: { a: null } });
    expect(await latestResumableId({ storage, cwd: CWD, logger: logger() })).toBe("b");
  });

  test("AC-8 skips a session whose metadata sessionId differs from the listed id", async () => {
    const storage = storageOf(["a", "b"], { metas: { a: metaFor("other") } });
    expect(await latestResumableId({ storage, cwd: CWD, logger: logger() })).toBe("b");
  });

  test("AC-9 skips a session whose readMeta throws SESSION_META_UNREADABLE", async () => {
    const storage = storageOf(["a", "b"], { metas: { a: unreadable() } });
    expect(await latestResumableId({ storage, cwd: CWD, logger: logger() })).toBe("b");
  });

  test("AC-10 warns with chat and the skip message when metadata is unreadable", async () => {
    const error = unreadable();
    const log = logger();
    const storage = storageOf(["a", "b"], { metas: { a: error } });
    await latestResumableId({ storage, cwd: CWD, logger: log });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith("chat", "skipping unreadable session metadata", {
      sessionId: "a",
      cause: error,
    });
  });

  test("AC-11 rethrows a readMeta error whose code is not SESSION_META_UNREADABLE", async () => {
    const failure = new NaxError("disk gone", "TEST_FAILURE", { stage: "test" });
    const storage = storageOf(["a", "b"], { metas: { a: failure } });
    await expect(latestResumableId({ storage, cwd: CWD, logger: logger() })).rejects.toBe(failure);
  });

  test("AC-12 throws CHAT_SESSION_NOT_FOUND naming the cwd when nothing is resumable", async () => {
    const storage = storageOf(["a"], { metas: { a: metaFor("a", { mode: "none" }) } });
    await expect(latestResumableId({ storage, cwd: CWD, logger: logger() })).rejects.toMatchObject({
      code: "CHAT_SESSION_NOT_FOUND",
      message: `no resumable session for ${CWD}`,
    });
  });
});
