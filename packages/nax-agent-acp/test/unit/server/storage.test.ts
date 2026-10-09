import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { createSessionStorage, LIST_PAGE_SIZE, processAlive, type SessionMeta } from "#src/server/storage";
import { recordingLogger } from "#test/helpers/recording-logger";

let dir: string;
beforeEach(() => {
  dir = makeTempDir("acp-storage-");
});
afterEach(() => cleanupTempDir(dir));

function storage(isAlive: (pid: number) => boolean = () => false, pid = 1000) {
  const { logger, lines } = recordingLogger();
  return {
    store: createSessionStorage({ dir, pid, now: () => new Date("2026-10-09T00:00:00.000Z"), logger, isAlive }),
    lines,
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
  test("writes and reads back; a missing session reads null", async () => {
    const { store } = storage();
    await store.writeMeta(meta("a"));
    expect(await store.readMeta("a")).toEqual(meta("a"));
    expect(await store.readMeta("missing")).toBeNull();
    expect(await store.hasMeta("a")).toBe(true);
    expect(JSON.parse(await readFile(join(dir, "a.session.json"), "utf8"))).toEqual(meta("a"));
  });

  test("unreadable JSON, a bad shape and an unknown schemaVersion throw SESSION_META_UNREADABLE and leave the file", async () => {
    const { store } = storage();
    for (const [id, body] of [
      ["j", "{nope"],
      ["s", JSON.stringify({ schemaVersion: 1 })],
      ["v", JSON.stringify({ ...meta("v"), schemaVersion: 2 })],
    ] as const) {
      await writeFile(join(dir, `${id}.session.json`), body);
      await expect(store.readMeta(id)).rejects.toMatchObject({ code: "SESSION_META_UNREADABLE" });
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
      startedAt: "2026-10-09T00:00:00.000Z",
    });
    await release();
    await release();
    const again = await store.acquireLock("a");
    await again();
  });

  test("a live lock held by another process refuses with its pid", async () => {
    await writeFile(join(dir, "a.lock"), JSON.stringify({ pid: 4242, startedAt: "x" }));
    const { store } = storage((pid) => pid === 4242);
    const caught = await store.acquireLock("a").catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(RequestError);
    expect(caught instanceof RequestError ? caught.message : "").toContain("session in use by pid 4242");
  });

  test("a dead pid's lock and an unreadable lock are taken over", async () => {
    await writeFile(join(dir, "a.lock"), JSON.stringify({ pid: 4242, startedAt: "x" }));
    await writeFile(join(dir, "b.lock"), "garbage");
    const { store, lines } = storage(() => false);
    await (await store.acquireLock("a"))();
    await (await store.acquireLock("b"))();
    expect(lines.filter((l) => l.message.includes("stale")).length).toBe(2);
  });

  test("processAlive: this process is alive; an impossible pid is not", () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(2 ** 30)).toBe(false);
  });
});

describe("list (spec §5.3 session/list)", () => {
  test("filters by cwd, sorts by updatedAt (createdAt when null) newest first, skips unreadable files", async () => {
    const { store, lines } = storage();
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
    expect(lines.some((l) => l.level === "warn" && l.data?.file === "bad.session.json")).toBe(true);
    expect((await store.list({})).sessions).toHaveLength(3);
  });

  test("pages of 50 with an opaque cursor; a bad cursor is invalid_params; a missing dir lists nothing", async () => {
    const { store } = storage();
    for (let i = 0; i < LIST_PAGE_SIZE + 3; i += 1) {
      await store.writeMeta(
        meta(`s${String(i).padStart(3, "0")}`, {
          createdAt: `2026-10-09T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
        }),
      );
    }
    const first = await store.list({});
    expect(first.sessions).toHaveLength(LIST_PAGE_SIZE);
    const second = await store.list({ cursor: first.nextCursor ?? null });
    expect(second.sessions).toHaveLength(3);
    expect(second.nextCursor).toBeUndefined();
    expect(await store.list({ cursor: "!!" }).catch((e: unknown) => (e instanceof RequestError ? e.code : 0))).toBe(
      -32602,
    );
    const empty = createSessionStorage({
      dir: join(dir, "nope"),
      pid: 1,
      now: () => new Date(),
      logger: recordingLogger().logger,
    });
    expect(await empty.list({})).toEqual({ sessions: [] });
  });
});
