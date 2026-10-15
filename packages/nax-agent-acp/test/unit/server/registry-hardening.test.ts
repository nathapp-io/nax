import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { connectNothing } from "#src/server/mcp/connect";
import { type Script, turnEnd } from "#test/helpers/fake-agent-session";
import { OPTIONS, setupRegistry } from "#test/helpers/registry-setup";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});
function dir() {
  const d = makeTempDir("registry-hardening-");
  dirs.push(d);
  return d;
}
const priced = (costUsd: number): Script =>
  async function* () {
    yield { type: "usage", round: 1, inputTokens: 1, outputTokens: 1, costUsd };
    yield turnEnd("completed");
  };
const prompt = [{ type: "text" as const, text: "go" }];

test("retires dead switched entry, releases its lock, and load reopens storage", async () => {
  const s = setupRegistry(dir(), OPTIONS, { failOpens: [2, 3] });
  const { sessionId } = await s.registry.create(s.input());
  const previous = s.registry.get(sessionId);
  await expect(s.registry.setMode(sessionId, "full")).rejects.toThrow("open 2 failed");
  expect(s.registry.find(sessionId)).toBeUndefined();
  await expect(readFile(join(s.dir, `${sessionId}.lock`))).rejects.toMatchObject({ code: "ENOENT" });
  await s.registry.load(sessionId, s.input());
  expect(s.registry.get(sessionId)).not.toBe(previous);
  expect(s.opened).toHaveLength(4);
  await s.registry.closeAll();
});

test.each(["load", "resume"] as const)("cost survives a new registry and %s", async (method) => {
  const d = dir();
  const first = setupRegistry(d, OPTIONS, { scripts: [priced(0.5)] });
  const { sessionId } = await first.registry.create(first.input());
  await first.registry.get(sessionId).prompt(prompt);
  expect((await first.storage.readMeta(sessionId))?.costUsd).toBe(0.5);
  await first.registry.closeAll();
  const second = setupRegistry(d, OPTIONS, { scripts: [priced(0.25)] });
  await second.registry[method](sessionId, second.input());
  await second.registry.get(sessionId).prompt(prompt);
  expect(second.port.updates.filter((u) => u.sessionUpdate === "usage_update")).toContainEqual(
    expect.objectContaining({ cost: { amount: 0.75, currency: "USD" } }),
  );
  expect((await second.storage.readMeta(sessionId))?.costUsd).toBe(0.75);
  await second.registry.closeAll();
});

test.each(["close", "closeAll"] as const)(
  "%s drains cancelled-turn cost persistence before releasing ownership",
  async (method) => {
    const started = Promise.withResolvers<void>();
    const persist = Promise.withResolvers<void>();
    const writing = Promise.withResolvers<void>();
    const script: Script = async function* (control) {
      yield { type: "usage", round: 1, inputTokens: 1, outputTokens: 1, costUsd: 0.5 };
      started.resolve();
      await control.cancelled;
      yield turnEnd("cancelled");
    };
    const s = setupRegistry(dir(), OPTIONS, { scripts: [script] });
    const { sessionId } = await s.registry.create(s.input());
    const write = s.storage.writeMeta;
    s.storage.writeMeta = async (meta) => {
      writing.resolve();
      await persist.promise;
      await write(meta);
    };
    const server = s.registry.get(sessionId);
    const turn = server.prompt(prompt);
    await started.promise;
    let closed = false;
    const closing = (method === "close" ? s.registry.close(sessionId) : s.registry.closeAll()).then(() => {
      closed = true;
    });
    // The old implementation has already removed the entry, so never invokes writeMeta.
    await Promise.race([writing.promise, closing]);
    expect(closed).toBe(false);
    expect(server.isClosed()).toBe(true);
    await expect(server.prompt(prompt)).rejects.toThrow();
    expect(await readFile(join(s.dir, `${sessionId}.lock`), "utf8")).toContain("nonce");
    persist.resolve();
    await Promise.all([turn, closing]);
    expect((await s.storage.readMeta(sessionId))?.costUsd).toBe(0.5);
    expect(s.registry.find(sessionId)).toBeUndefined();
    await expect(readFile(join(s.dir, `${sessionId}.lock`))).rejects.toMatchObject({ code: "ENOENT" });
    const second = setupRegistry(s.dir, OPTIONS, { scripts: [priced(0.25)] });
    await second.registry.resume(sessionId, second.input());
    await second.registry.get(sessionId).prompt(prompt);
    expect((await second.storage.readMeta(sessionId))?.costUsd).toBe(0.75);
    await second.registry.closeAll();
  },
);

test("bounded shutdown retains ownership until a slow cancelled turn finishes bookkeeping", async () => {
  const started = Promise.withResolvers<void>();
  const drain = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const script: Script = async function* (control) {
    yield { type: "usage", round: 1, inputTokens: 1, outputTokens: 1, costUsd: 0.5 };
    started.resolve();
    await control.cancelled;
    await drain.promise;
    yield turnEnd("cancelled");
  };
  const s = setupRegistry(dir(), OPTIONS, { scripts: [script] });
  const acquire = s.storage.acquireLock;
  s.storage.acquireLock = async (id) => {
    const release = await acquire(id);
    return async () => {
      expect((await s.storage.readMeta(id))?.costUsd).toBe(0.5);
      await release();
      released.resolve();
    };
  };
  const { sessionId } = await s.registry.create(s.input());
  const turn = s.registry.get(sessionId).prompt(prompt);
  await started.promise;
  await s.registry.closeAll();
  expect(s.lines.some((line) => line.message.includes("did not close"))).toBe(true);
  expect(await readFile(join(s.dir, `${sessionId}.lock`), "utf8")).toContain("nonce");
  await expect(s.registry.resume(sessionId, s.input())).rejects.toThrow();
  drain.resolve();
  await turn;
  await released.promise;
  expect(s.registry.find(sessionId)).toBeUndefined();
});

test("cost write failure warns once without changing turn result", async () => {
  const s = setupRegistry(dir(), OPTIONS, { scripts: [priced(0.5)] });
  const { sessionId } = await s.registry.create(s.input());
  s.storage.writeMeta = async () => {
    throw new Error("disk full");
  };
  expect(await s.registry.get(sessionId).prompt(prompt)).toMatchObject({ stopReason: "end_turn" });
  expect(s.lines.filter((l) => l.level === "warn")).toHaveLength(1);
  await s.registry.closeAll();
});

test("dead entry cleanup attempts MCP and release even when both throw, preserving open error", async () => {
  let mcpClosed = false;
  let released = false;
  const s = setupRegistry(dir(), OPTIONS, {
    failOpens: [2, 3],
    connectMcp: async (input) => {
      const mcp = await connectNothing(input);
      return {
        ...mcp,
        tools: {
          ...mcp.tools,
          closeAll: async () => {
            mcpClosed = true;
            throw new Error("MCP close");
          },
        },
      };
    },
  });
  const acquire = s.storage.acquireLock;
  s.storage.acquireLock = async (id) => {
    const release = await acquire(id);
    return async () => {
      released = true;
      await release();
      throw new Error("release");
    };
  };
  const { sessionId } = await s.registry.create(s.input());
  await expect(s.registry.setMode(sessionId, "full")).rejects.toThrow("open 2 failed");
  expect(mcpClosed).toBe(true);
  expect(released).toBe(true);
  expect(s.registry.find(sessionId)).toBeUndefined();
  expect(s.lines.filter((l) => l.message === "dead session cleanup failed")).toHaveLength(1);
});
