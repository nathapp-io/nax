import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import type { SessionMeta } from "#src/index";
import * as agent from "#src/index";
import { NaxError } from "#src/index";

import { makeLogger } from "#test/helpers/agent-logger";

const { createSessionStorage, LIST_PAGE_SIZE, processAlive } = agent;

let dir: string;
beforeEach(() => {
  dir = makeTempDir("agent-storage-");
});
afterEach(() => cleanupTempDir(dir));

function storage(isAlive: (pid: number) => boolean = () => false, pid = 1000) {
  const logger = makeLogger();
  return {
    store: createSessionStorage({ dir, pid, now: () => new Date("2026-10-09T00:00:00.000Z"), logger, isAlive }),
    logger,
  };
}

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta => ({
  schemaVersion: 1,
  sessionId: id,
  cwd: "/w",
  mode: "ask",
  model: "anthropic/claude-sonnet-5-5",
  bashApproval: "gated",
  title: null,
  createdAt: "2026-10-09T00:00:00.000Z",
  updatedAt: null,
  ...extra,
});

describe("metadata (spec §5.1)", () => {
  test("package entry exports the shared factory and default directory", () => {
    expect(typeof agent.createSessionStorage).toBe("function");
    expect(agent.defaultSessionsDir("/h/.nax")).toBe("/h/.nax/.agent-server/sessions");
  });

  test.each(["bad", ...["-1", "1.5", "abc", "9007199254740992"].map((text) => Buffer.from(text).toString("base64"))])(
    "invalid decoded cursor %s",
    async (cursor) => {
      const error = await storage()
        .store.list({ cursor })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NaxError);
      expect(error).toMatchObject({ code: "SESSION_LIST_CURSOR_INVALID", message: "invalid cursor" });
    },
  );

  test.each([undefined, null, "", "MA", "MDA="])("absent or permissive zero cursor %s", async (cursor) => {
    const { store } = storage();
    await store.writeMeta(meta("a"));
    expect((await store.list({ cursor })).sessions).toHaveLength(1);
  });
  test("writes and reads back; a missing session reads null", async () => {
    const { store } = storage();
    await store.writeMeta(meta("a"));
    expect(await store.readMeta("a")).toEqual(meta("a"));
    expect(await store.readMeta("missing")).toBeNull();
    expect(await store.hasMeta("a")).toBe(true);
    expect(JSON.parse(await readFile(join(dir, "a.session.json"), "utf8"))).toEqual(meta("a"));
  });

  test("hasMeta propagates stat failures other than a missing file", async () => {
    const path = join(dir, "not-a-directory");
    await writeFile(path, "file");
    const store = createSessionStorage({
      dir: path,
      pid: 1000,
      now: () => new Date("2026-10-09T00:00:00.000Z"),
      logger: makeLogger(),
    });
    await expect(store.hasMeta("a")).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  test("concurrent writes for one session all succeed with a complete final record and no temporary files", async () => {
    const { store } = storage();
    const records = Array.from({ length: 24 }, (_, index) =>
      meta("a", { title: `${index}:${"x".repeat(index * 1000)}` }),
    );
    const results = await Promise.allSettled(records.map((record) => store.writeMeta(record)));
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const final = await store.readMeta("a");
    expect(records.map((record) => JSON.stringify(record))).toContain(JSON.stringify(final));
    expect(await readFile(join(dir, "a.session.json"), "utf8")).toBe(`${JSON.stringify(final, null, 2)}\n`);
    expect(await readdir(dir)).toEqual(["a.session.json"]);
  });

  test("a failed metadata rename cleans up only its own temporary files", async () => {
    const { store } = storage();
    await mkdir(join(dir, "a.session.json"));
    await writeFile(join(dir, "unrelated.tmp"), "keep");
    await expect(store.writeMeta(meta("a"))).rejects.toBeDefined();
    expect((await readdir(dir)).sort()).toEqual(["a.session.json", "unrelated.tmp"]);
    expect(await readFile(join(dir, "unrelated.tmp"), "utf8")).toBe("keep");
  });

  test("unreadable JSON, a bad shape and an unknown schemaVersion throw SESSION_META_UNREADABLE and leave the file", async () => {
    const { store } = storage();
    for (const [id, body] of [
      ["j", "{nope"],
      ["s", JSON.stringify({ schemaVersion: 1 })],
      ["r", JSON.stringify({ ...meta("r"), mode: "review" })],
      ["v", JSON.stringify({ ...meta("v"), schemaVersion: 2 })],
    ] as const) {
      await writeFile(join(dir, `${id}.session.json`), body);
      const error = await store.readMeta(id).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NaxError);
      expect(error).toMatchObject({ code: "SESSION_META_UNREADABLE", context: { stage: "session-store" } });
      if (id === "v")
        expect(error).toMatchObject({ message: expect.stringContaining("schemaVersion 2; this build reads 1") });
      expect(await readFile(join(dir, `${id}.session.json`), "utf8")).toBe(body);
    }
  });

  test("removeMeta deletes; a missing file is fine", async () => {
    const { store } = storage();
    await store.writeMeta(meta("a"));
    await store.removeMeta("a");
    await store.removeMeta("a");
    expect(await store.hasMeta("a")).toBe(false);
  });
});

describe("lock (spec §5.1 lock rule)", () => {
  test("takes the lock, writes pid and startedAt; release removes it", async () => {
    const { store } = storage();
    const release = await store.acquireLock("a");
    expect(JSON.parse(await readFile(join(dir, "a.lock"), "utf8"))).toEqual({
      pid: 1000,
      nonce: expect.any(String),
      heartbeatAt: "2026-10-09T00:00:00.000Z",
      startedAt: "2026-10-09T00:00:00.000Z",
    });
    await release();
    await release();
    const again = await store.acquireLock("a");
    await again();
  });

  test("a live lock held by another process refuses with its pid", async () => {
    await writeFile(
      join(dir, "a.lock"),
      JSON.stringify({ pid: 4242, startedAt: "x", nonce: "owner", heartbeatAt: "2026-10-09T00:00:00.000Z" }),
    );
    const { store } = storage((pid) => pid === 4242);
    const caught = await store.acquireLock("a").catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(NaxError);
    expect(caught).toMatchObject({ code: "SESSION_LOCKED" });
    expect(caught instanceof NaxError ? caught.message : "").toContain("session in use by pid 4242");
  });

  test("a dead pid's lock and an unreadable lock are taken over", async () => {
    await writeFile(join(dir, "a.lock"), JSON.stringify({ pid: 4242, startedAt: "x" }));
    await writeFile(join(dir, "b.lock"), "garbage");
    const { store, logger } = storage(() => false);
    await (await store.acquireLock("a"))();
    await (await store.acquireLock("b"))();
    expect(logger.calls.filter((l) => l.message.includes("stale")).length).toBe(2);
  });

  test("processAlive: this process is alive; an impossible pid is not", () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(2 ** 30)).toBe(false);
  });
});

describe("list (spec §5.3 session/list)", () => {
  test("filters by cwd, sorts by updatedAt (createdAt when null) newest first, skips unreadable files", async () => {
    const { store, logger } = storage();
    await store.writeMeta(meta("old", { createdAt: "2026-10-01T00:00:00.000Z" }));
    await store.writeMeta(
      meta("new", { createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z", title: "fix it" }),
    );
    await store.writeMeta(meta("elsewhere", { cwd: "/other" }));
    await writeFile(join(dir, "bad.session.json"), "{");
    await writeFile(join(dir, "x.transcript.json"), "{}");
    const page = await store.list({ cwd: "/w" });
    expect(page.sessions).toEqual([
      { sessionId: "new", cwd: "/w", title: "fix it", updatedAt: "2026-10-08T00:00:00.000Z" },
      { sessionId: "old", cwd: "/w", title: null, updatedAt: "2026-10-01T00:00:00.000Z" },
    ]);
    expect(page.nextCursor).toBeUndefined();
    expect(
      logger.calls.some(
        (l) =>
          l.level === "warn" &&
          l.message === "skipping unreadable session metadata" &&
          l.data?.file === "bad.session.json",
      ),
    ).toBe(true);
    expect((await store.list({})).sessions).toEqual([
      { sessionId: "elsewhere", cwd: "/other", title: null, updatedAt: "2026-10-09T00:00:00.000Z" },
      { sessionId: "new", cwd: "/w", title: "fix it", updatedAt: "2026-10-08T00:00:00.000Z" },
      { sessionId: "old", cwd: "/w", title: null, updatedAt: "2026-10-01T00:00:00.000Z" },
    ]);
  });

  test("pages of 50 with an opaque cursor; a bad cursor is SESSION_LIST_CURSOR_INVALID; a missing dir lists nothing", async () => {
    const { store } = storage();
    for (let i = 0; i < LIST_PAGE_SIZE + 1; i += 1) {
      await store.writeMeta(
        meta(`s${String(i).padStart(3, "0")}`, {
          createdAt: `2026-10-09T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
        }),
      );
    }
    const first = await store.list({});
    expect(first.sessions).toHaveLength(50);
    expect(first.nextCursor).toBeString();
    const second = await store.list({ cursor: first.nextCursor ?? null });
    expect(second.sessions).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    expect(await store.list({ cursor: "bad" }).catch((e: unknown) => (e instanceof NaxError ? e.code : 0))).toBe(
      "SESSION_LIST_CURSOR_INVALID",
    );
    const empty = createSessionStorage({
      dir: join(dir, "nope"),
      pid: 1,
      now: () => new Date(),
      logger: makeLogger(),
    });
    expect(await empty.list({})).toEqual({ sessions: [] });
  });
});
