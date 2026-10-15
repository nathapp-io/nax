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
