/**
 * The stored session meta's optional `web` field: a chat session's exposure snapshot
 * survives resume and compaction, meta written before the field existed stays readable
 * and unexposed, and a malformed value fails closed -- the session stays exposed --
 * instead of making the whole meta unreadable.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import type { SessionMeta, SessionStorage } from "#src/index";
import { createSessionStorage } from "#src/index";
import { WEB_SEEN_URL_CAP } from "#src/web/index";
import { makeLogger } from "#test/helpers/agent-logger";

const CREATED_AT = "2026-11-26T09:00:00.000Z";
const UPDATED_AT = "2026-11-26T11:00:00.000Z";
const EXPOSED_AT = "2026-11-26T10:00:00.000Z";
const FILE = "a.session.json";

/** The meta every case starts from: no `web`, and a `createdAt`/`updatedAt` pair that differ. */
const base: SessionMeta = {
  schemaVersion: 1,
  sessionId: "a",
  cwd: "/w",
  mode: "ask",
  model: "anthropic/claude-sonnet-5-5",
  bashApproval: "gated",
  title: null,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
};

/** The exact snapshot AC-2 spells out; AC-8 writes the same value through the store. */
const web = {
  exposedAt: EXPOSED_AT,
  seenUrls: ["https://a.example/"],
  searches: 3,
};

const closed = (exposedAt: string) => ({ exposedAt, seenUrls: [], searches: 0 });

let dir: string;
let store: SessionStorage;

beforeEach(() => {
  dir = makeTempDir("agent-meta-web-");
  store = createSessionStorage({ dir, pid: 1000, now: () => new Date(CREATED_AT), logger: makeLogger() });
});
afterEach(() => cleanupTempDir(dir));

/**
 * Store a meta file by hand and read it back, so a case can persist a shape the
 * `SessionMeta` type itself forbids without casting one into existence.
 */
async function readStored(extra: Record<string, unknown> = {}): Promise<SessionMeta> {
  await writeFile(join(dir, FILE), JSON.stringify({ ...base, ...extra }));
  const meta = await store.readMeta("a");
  if (meta === null) throw new Error("stored session meta read back null");
  return meta;
}

describe("metadata web field", () => {
  test("metadata stored without web reads back with web undefined", async () => {
    expect((await readStored()).web).toBeUndefined();
  });

  test("a stored web snapshot reads back unchanged", async () => {
    expect((await readStored({ web })).web).toEqual(web);
  });

  test("an unexposed snapshot with no URLs and no searches reads back unchanged", async () => {
    const never = { exposedAt: null, seenUrls: [], searches: 0 };
    expect((await readStored({ web: never })).web).toEqual(never);
  });

  test("a non-object web falls back to updatedAt with no URLs and no searches", async () => {
    expect((await readStored({ web: "bad" })).web).toEqual(closed(UPDATED_AT));
  });

  test("the fail-closed web value leaves every other field unchanged", async () => {
    expect(await readStored({ web: "bad" })).toEqual({ ...base, web: closed(UPDATED_AT) });
  });

  test("a negative search count falls back to createdAt when updatedAt is null", async () => {
    const meta = await readStored({ updatedAt: null, web: { exposedAt: EXPOSED_AT, seenUrls: [], searches: -1 } });
    expect(meta.web).toEqual(closed(CREATED_AT));
  });

  test("more seen URLs than the cap fall back to no URLs and no searches", async () => {
    const seenUrls = Array.from({ length: WEB_SEEN_URL_CAP + 1 }, (_, index) => `https://a.example/${index}`);
    const meta = await readStored({ web: { exposedAt: EXPOSED_AT, seenUrls, searches: 1 } });
    expect(meta.web).toEqual(closed(UPDATED_AT));
  });

  test("a web value written through the store reads back unchanged", async () => {
    await store.writeMeta({ ...base, web });
    expect((await store.readMeta("a"))?.web).toEqual(web);
  });

  test("a meta written with a web value keeps schemaVersion 1 on disk and on read", async () => {
    await store.writeMeta({ ...base, web });
    expect(JSON.parse(await readFile(join(dir, FILE), "utf8"))).toMatchObject({ schemaVersion: 1, web });
    expect(await store.readMeta("a")).toEqual({ ...base, web });
  });
});
