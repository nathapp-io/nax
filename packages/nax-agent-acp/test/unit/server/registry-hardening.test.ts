import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSessionStorage, type SessionMeta } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { waitForCondition, withTimeout } from "@nathapp/nax-test-kit/bun/timeout";
import { connectNothing } from "#src/server/mcp/connect";
import { type Script, turnEnd } from "#test/helpers/fake-agent-session";
import { recordingLogger } from "#test/helpers/recording-logger";
import { OPTIONS, type RegistrySetupExtra, setupRegistry } from "#test/helpers/registry-setup";

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
/** One visible update, then a priced turn_end: the text is the write a held client blocks. */
const chatted = (costUsd: number): Script =>
  async function* () {
    yield { type: "text_delta", round: 1, text: "hi" };
    yield { type: "usage", round: 1, inputTokens: 1, outputTokens: 1, costUsd };
    yield turnEnd("completed");
  };
const prompt = [{ type: "text" as const, text: "go" }];

/** The pin the fixed clock keeps every test within, so a rival read still sees a fresh lock. */
const NOW = () => new Date("2026-10-09T00:00:00.000Z");
const lockPath = (s: ReturnType<typeof setupRegistry>, sessionId: string): string => join(s.dir, `${sessionId}.lock`);
const lockHeld = (path: string): Promise<boolean> =>
  readFile(path).then(
    () => true,
    () => false,
  );

interface Held {
  readonly s: ReturnType<typeof setupRegistry>;
  readonly sessionId: string;
  /** The turn whose first update the client has not answered. */
  readonly turn: Promise<unknown>;
  readonly release: () => void;
}

/** A registry whose client holds every write (finding 7), with one turn blocked on it. */
async function writeInFlight(extra: RegistrySetupExtra = {}): Promise<Held> {
  const gate = Promise.withResolvers<void>();
  const s = setupRegistry(dir(), OPTIONS, {
    ...extra,
    scripts: [chatted(0.5)],
    holdUpdates: gate.promise,
    // Short unless the test asks for the production wait.
    closeWaitMs: extra.closeWaitMs ?? 40,
  });
  const { sessionId } = await s.registry.create(s.input());
  const turn = s.registry.get(sessionId).prompt(prompt);
  await waitForCondition(() => s.port.updates.length > 0);
  return { s, sessionId, turn, release: () => gate.resolve() };
}

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

test("close retains cleanup ownership while waiting for a competing lock guard", async () => {
  const s = setupRegistry(dir(), OPTIONS);
  const { sessionId } = await s.registry.create(s.input());
  const path = join(s.dir, `${sessionId}.lock`);
  const guard = `${path}.guard`;
  await mkdir(guard);
  await writeFile(join(guard, `${process.pid}.00000000-0000-0000-0000-000000000000`), "");
  const closing = s.registry.close(sessionId);
  // Observe rejection as well as resolution so the pre-fix failure is not unhandled.
  const outcome = closing.then(
    () => "closed",
    () => "rejected",
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await Promise.race([outcome, Promise.resolve("pending")])).toBe("pending");
    expect(s.registry.find(sessionId)).toBeDefined();
    expect(await readFile(path, "utf8")).toContain("nonce");
  } finally {
    await rm(guard, { recursive: true, force: true });
    await outcome;
  }
  await expect(closing).resolves.toBeUndefined();
  expect(s.registry.find(sessionId)).toBeUndefined();
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  await s.registry.load(sessionId, s.input());
  await s.registry.closeAll();
});

test("closeAll stays bounded while lock cleanup waits on a live guard, then releases later", async () => {
  const s = setupRegistry(dir(), OPTIONS);
  const { sessionId } = await s.registry.create(s.input());
  const path = join(s.dir, `${sessionId}.lock`);
  const guard = `${path}.guard`;
  await mkdir(guard);
  await writeFile(join(guard, `${process.pid}.00000000-0000-0000-0000-000000000000`), "");
  try {
    const closing = s.registry.closeAll().then(
      () => "closed",
      () => "rejected",
    );
    let sentinel: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<string>((resolve) => {
      sentinel = setTimeout(() => resolve("pending"), 300);
    });
    // shutdownWaitMs is 50: the deadline must cover lock cleanup, not only server.close().
    expect(await Promise.race([closing, late])).toBe("closed");
    clearTimeout(sentinel);
    expect(s.lines.some((line) => line.message.includes("cleanup did not finish in time"))).toBe(true);
    expect(await readFile(path, "utf8")).toContain("nonce");
  } finally {
    await rm(guard, { recursive: true, force: true });
  }
  // Ownership cleanup is deferred, not abandoned: the lock goes once the guard clears.
  for (let i = 0; i < 100; i++) {
    const gone = await readFile(path).then(
      () => false,
      () => true,
    );
    if (gone) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("closeAll still rejects when lock cleanup fails before the deadline", async () => {
  const s = setupRegistry(dir(), OPTIONS);
  const acquire = s.storage.acquireLock;
  s.storage.acquireLock = async (id) => {
    const release = await acquire(id);
    return async () => {
      await release();
      throw new Error("release failed");
    };
  };
  const { sessionId } = await s.registry.create(s.input());
  await expect(s.registry.closeAll()).rejects.toThrow("release failed");
  expect(s.registry.find(sessionId)).toBeUndefined();
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

/** A competitor outside the registry: another process wanting the same live session. */
function rivalStorage(dir: string) {
  return createSessionStorage({ dir, pid: 2000, now: NOW, logger: recordingLogger().logger, isAlive: () => true });
}

test("AC-2: a pending write keeps a competing owner out until it settles", async () => {
  const { s, sessionId, turn, release } = await writeInFlight({ isAlive: () => true });
  await s.registry.close(sessionId);
  // The bounded close returned, so ownership is still ours: no one else may take the session.
  const rival = rivalStorage(s.dir);
  await expect(rival.acquireLock(sessionId)).rejects.toThrow("in use");
  release();
  await turn;
  await waitForCondition(() => s.registry.find(sessionId) === undefined);
  await waitForCondition(() => !existsSync(lockPath(s, sessionId)));
  await (await rival.acquireLock(sessionId))();
  expect(s.releases()).toBe(1);
});

test("AC-3: a released write runs final accounting and ownership cleanup once", async () => {
  const { s, sessionId, turn, release } = await writeInFlight();
  const writes: SessionMeta[] = [];
  const write = s.storage.writeMeta;
  s.storage.writeMeta = async (meta) => {
    writes.push(meta);
    await write(meta);
  };
  await s.registry.close(sessionId);
  // A repeated close shares the first one's completion instead of starting a second.
  await s.registry.close(sessionId);
  expect(s.releases()).toBe(0);
  expect(await lockHeld(lockPath(s, sessionId))).toBe(true);
  expect(s.registry.find(sessionId)).toBeDefined();
  release();
  await turn;
  await waitForCondition(() => s.registry.find(sessionId) === undefined);
  await waitForCondition(() => !existsSync(lockPath(s, sessionId)));
  expect(s.releases()).toBe(1);
  expect(writes.map((meta) => meta.costUsd)).toEqual([0.5]);
  expect((await s.storage.readMeta(sessionId))?.costUsd).toBe(0.5);
});

test("AC-4: the close wait bounds a pending write, not a held lock guard", async () => {
  const { s, sessionId, turn, release } = await writeInFlight({ isAlive: () => true });
  const path = lockPath(s, sessionId);
  const guard = `${path}.guard`;
  await mkdir(guard);
  await writeFile(join(guard, `${process.pid}.00000000-0000-0000-0000-000000000000`), "");
  try {
    await expect(withTimeout(s.registry.close(sessionId), 1_000, "close did not return")).resolves.toBeUndefined();
    expect(s.releases()).toBe(0);
    release();
    await turn;
    // Ownership is the guard's, not the close wait's: the lock survives until it clears.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await lockHeld(path)).toBe(true);
  } finally {
    await rm(guard, { recursive: true, force: true });
  }
  await waitForCondition(() => !existsSync(path));
  expect(s.releases()).toBe(1);
});

test("AC-6: an ordinary close and shutdown share one cleanup completion", async () => {
  const { s, sessionId, turn, release } = await writeInFlight();
  await s.registry.close(sessionId);
  await withTimeout(s.registry.closeAll(), 1_000, "closeAll did not resolve");
  expect(s.lines.some((line) => line.message.includes("did not close in time"))).toBe(true);
  expect(s.releases()).toBe(0);
  release();
  await turn;
  await waitForCondition(() => s.registry.find(sessionId) === undefined);
  await waitForCondition(() => !existsSync(lockPath(s, sessionId)));
  // Neither owner gives up ownership a second time.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(s.releases()).toBe(1);
  expect(s.fakes[0]?.closed()).toBe(true);
});

test("AC-7: delete waits for the session's disposal before removing its storage", async () => {
  const { s, sessionId, turn, release } = await writeInFlight();
  const deleting = s.registry.delete(sessionId).then(
    () => "deleted",
    () => "failed",
  );
  // Well past the close wait: the deadline must not let delete race the pending write.
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(await Promise.race([deleting, Promise.resolve("pending")])).toBe("pending");
  expect(await s.storage.readMeta(sessionId)).not.toBeNull();
  release();
  await turn;
  expect(await withTimeout(deleting, 2_000, "delete did not finish")).toBe("deleted");
  expect(await s.storage.readMeta(sessionId)).toBeNull();
  expect(s.registry.find(sessionId)).toBeUndefined();
  // Two releases: the entry's ownership cleanup, then delete's own storage lock — not
  // a second ownership cleanup.
  expect(s.releases()).toBe(2);
});

test("AC-8: closeAll stays bounded while an output write is pending, then gives up ownership", async () => {
  // The production five-second close wait: shutdown's own bound must hold regardless.
  const { s, sessionId, turn, release } = await writeInFlight({ closeWaitMs: 5_000 });
  await withTimeout(s.registry.closeAll(), 1_000, "closeAll did not resolve");
  expect(s.lines.some((line) => line.message.includes("did not close in time"))).toBe(true);
  expect(await lockHeld(lockPath(s, sessionId))).toBe(true);
  release();
  await turn;
  await waitForCondition(() => !existsSync(lockPath(s, sessionId)));
  expect(s.releases()).toBe(1);
});

test("a failed session close still gives up ownership and reaches the caller", async () => {
  const s = setupRegistry(dir(), OPTIONS, { closeFails: true });
  const { sessionId } = await s.registry.create(s.input());
  const path = lockPath(s, sessionId);
  expect(await lockHeld(path)).toBe(true);
  await expect(s.registry.close(sessionId)).rejects.toThrow("close failed");
  expect(s.registry.find(sessionId)).toBeUndefined();
  expect(await lockHeld(path)).toBe(false);
  expect(s.releases()).toBe(1);
});
