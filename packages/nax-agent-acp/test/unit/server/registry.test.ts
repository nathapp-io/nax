import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import type { TranscriptDoc } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { createSessionRegistry, INTERRUPTED_NOTICE, NO_MODEL_MESSAGE } from "#src/server/registry";
import { TURN_TIMEOUT_SECONDS } from "#src/server/server-session";
import { recordingLogger } from "#test/helpers/recording-logger";
import { OPTIONS, type RegistrySetupExtra, setupRegistry } from "#test/helpers/registry-setup";

let dir: string;
beforeEach(() => {
  dir = makeTempDir("acp-registry-");
});
afterEach(() => cleanupTempDir(dir));

const setup = (options = OPTIONS, extra: RegistrySetupExtra = {}) => setupRegistry(dir, options, extra);

async function failure(promise: Promise<unknown>): Promise<RequestError> {
  const caught = await promise.catch((e: unknown) => e);
  if (caught instanceof RequestError) return caught;
  throw new Error(`expected a RequestError, got ${String(caught)}`);
}

const metaOf = async (id: string) => JSON.parse(await readFile(join(dir, `${id}.session.json`), "utf8"));

describe("create (session/new)", () => {
  test("opens with the defaults, takes the lock, writes metadata, returns modes and config options", async () => {
    const s = setup();
    const created = await s.registry.create(s.input());
    expect(created.sessionId).toBe("id-1");
    expect(created.modes.currentModeId).toBe("ask");
    expect(created.configOptions.map((o) => o.id)).toEqual(["mode", "model", "bashApproval"]);
    expect(s.opened[0]).toEqual({
      sessionId: "id-1",
      cwd: "/w",
      model: "anthropic/claude-sonnet-5-5",
      profile: "ask",
      bashApproval: "gated",
      tools: [],
    });
    expect(await metaOf("id-1")).toMatchObject({
      schemaVersion: 1,
      cwd: "/w",
      mode: "ask",
      title: null,
      updatedAt: null,
    });
    expect(JSON.parse(await readFile(join(dir, "id-1.lock"), "utf8"))).toMatchObject({ pid: 1000 });
  });

  test("a relative cwd is invalid_params; nothing is written", async () => {
    const s = setup();
    expect((await failure(s.registry.create(s.input("w")))).code).toBe(-32602);
    expect(await s.storage.hasMeta("id-1")).toBe(false);
  });

  test("no model is auth_required with the login steps; nothing is written", async () => {
    const { defaultModel: _unused, ...noModel } = OPTIONS;
    const n = setup(noModel);
    const error = await failure(n.registry.create(n.input()));
    expect(error.code).toBe(-32000);
    expect(error.message).toContain(NO_MODEL_MESSAGE);
    expect(error.message).toContain("nax-agent login");
    expect(await n.storage.hasMeta("id-1")).toBe(false);
    expect(n.opened).toEqual([]);
  });

  test("the first prompt sets the title (80 chars, one line) and every prompt sets updatedAt", async () => {
    const s = setup();
    const { sessionId } = await s.registry.create(s.input());
    const long = `fix the\nparser ${"x".repeat(120)}`;
    await s.registry.get(sessionId).prompt([{ type: "text", text: long }]);
    const meta = await metaOf(sessionId);
    expect(meta.title).toBe(`fix the parser ${"x".repeat(65)}`);
    expect(meta.updatedAt).toBe("2026-10-09T01:00:00.000Z");
    await s.registry.get(sessionId).prompt([{ type: "text", text: "second" }]);
    expect((await metaOf(sessionId)).title).toBe(meta.title);
  });

  test("without a connector, mcpServers are ignored silently", async () => {
    const s = setup();
    const { sessionId } = await s.registry.create(s.input("/w", [{ name: "fs", command: "srv" }]));
    await s.registry.get(sessionId).prompt([{ type: "text", text: "go" }]);
    expect(s.port.updates.filter((u) => u.sessionUpdate === "notice")).toEqual([]);
  });

  test("a failed open releases the lock and writes no metadata", async () => {
    const s = setup();
    const broken = createSessionRegistry({
      options: OPTIONS,
      openSession: async () => Promise.reject(new Error("sandbox unavailable")),
      storage: s.storage,
      transcripts: s.transcripts,
      newId: () => "x",
      now: () => new Date(),
      readOldText: async () => ({ kind: "missing" }),
      logger: recordingLogger().logger,
      turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
    });
    await expect(broken.create(s.input())).rejects.toThrow("sandbox unavailable");
    expect(await s.storage.hasMeta("x")).toBe(false);
    await (await s.storage.acquireLock("x"))();
  });
});

describe("load and resume (spec §5.3, §5.4)", () => {
  async function stored(s: ReturnType<typeof setup>, doc?: TranscriptDoc): Promise<string> {
    const { sessionId } = await s.registry.create(s.input());
    await s.registry.setMode(sessionId, "full");
    if (doc !== undefined) await s.transcripts.save(sessionId, doc);
    await s.registry.close(sessionId);
    return sessionId;
  }

  test("load restores the stored settings and replays the transcript before responding", async () => {
    const s = setup();
    const id = await stored(s, {
      savedAt: "x",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ],
    });
    s.port.updates.length = 0;
    const state = await s.registry.load(id, s.input("/elsewhere"));
    expect(state.modes.currentModeId).toBe("full");
    expect(s.opened.at(-1)).toMatchObject({ sessionId: id, cwd: "/w", profile: "full" });
    expect(s.port.updates.map((u) => u.sessionUpdate)).toEqual(["user_message_chunk", "agent_message_chunk"]);
  });

  test("an interrupted last turn ends the replay with a warning", async () => {
    const s = setup(OPTIONS, { lastTurn: { turnId: "t9", status: "interrupted" } });
    const id = await stored(s, { savedAt: "x", messages: [{ role: "user", content: "hello" }] });
    s.port.updates.length = 0;
    await s.registry.load(id, s.input());
    expect(s.port.updates.at(-1)).toMatchObject({
      sessionUpdate: "notice",
      severity: "warning",
      title: INTERRUPTED_NOTICE,
    });
  });

  test("resume reopens without replay; a never-prompted session reopens too", async () => {
    const s = setup();
    const id = await stored(s);
    s.port.updates.length = 0;
    const state = await s.registry.resume(id, s.input());
    expect(state.modes.currentModeId).toBe("full");
    expect(s.port.updates).toEqual([]);
  });

  test("an unknown id is resource_not_found; unreadable metadata is internal and the file is kept", async () => {
    const s = setup();
    expect((await failure(s.registry.load("nope", s.input()))).code).toBe(-32002);
    await writeFile(join(dir, "bad.session.json"), "{");
    await expect(s.registry.resume("bad", s.input())).rejects.toMatchObject({ code: "SESSION_META_UNREADABLE" });
    expect(await readFile(join(dir, "bad.session.json"), "utf8")).toBe("{");
  });

  test("a session held by another live process is refused with the pid", async () => {
    const s = setup(OPTIONS, { isAlive: (pid) => pid === 4242 });
    const id = await stored(s);
    await writeFile(join(dir, `${id}.lock`), JSON.stringify({ pid: 4242, startedAt: "x" }));
    expect((await failure(s.registry.load(id, s.input()))).message).toContain("session in use by pid 4242");
  });

  test("loading an already-open session replays from the store and keeps the open session", async () => {
    const s = setup();
    const { sessionId } = await s.registry.create(s.input());
    await s.transcripts.save(sessionId, { savedAt: "x", messages: [{ role: "user", content: "hello" }] });
    const before = s.registry.get(sessionId);
    s.port.updates.length = 0;
    await s.registry.load(sessionId, s.input());
    expect(s.registry.get(sessionId)).toBe(before);
    expect(s.port.updates.map((u) => u.sessionUpdate)).toEqual(["user_message_chunk"]);
  });
});

describe("list, close, delete", () => {
  test("list returns stored sessions for the cwd", async () => {
    const s = setup();
    await s.registry.create(s.input());
    await s.registry.create(s.input("/other"));
    expect((await s.registry.list({ cwd: "/w" })).sessions.map((i) => i.sessionId)).toEqual(["id-1"]);
  });

  test("close cancels, closes, releases the lock and keeps the files; unknown is resource_not_found", async () => {
    const s = setup();
    const { sessionId } = await s.registry.create(s.input());
    await s.registry.close(sessionId);
    expect(s.fakes[0]?.closed()).toBe(true);
    expect(s.registry.find(sessionId)).toBeUndefined();
    expect(await s.storage.hasMeta(sessionId)).toBe(true);
    await (await s.storage.acquireLock(sessionId))();
    expect((await failure(s.registry.close(sessionId))).code).toBe(-32002);
  });

  test("delete closes an open session and removes metadata, lock and transcript", async () => {
    const s = setup();
    const { sessionId } = await s.registry.create(s.input());
    await s.transcripts.save(sessionId, { savedAt: "x", messages: [] });
    await s.registry.delete(sessionId);
    expect(await s.storage.hasMeta(sessionId)).toBe(false);
    expect(await s.transcripts.load(sessionId)).toBeNull();
    expect((await failure(s.registry.delete(sessionId))).code).toBe(-32002);
  });
});
