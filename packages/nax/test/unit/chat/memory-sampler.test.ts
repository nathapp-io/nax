/**
 * #2846: the opt-in chat memory sampler.
 *
 * `NAX_CHAT_MEMLOG` turns it on. Each sample is one JSONL line carrying the process memory
 * and the JS heap's own numbers, so a long session can tell JS retention (heap grows with
 * rss) from native or allocator growth (rss grows, heap flat). SIGUSR2 writes a V8 heap
 * snapshot beside the log. Off, nothing is armed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertDefined, cleanupTempDir, makeTempDir } from "@test/helpers";
import {
  _chatMemorySamplerDeps,
  DEFAULT_MEMLOG_INTERVAL_SECONDS,
  MAX_MEMLOG_INTERVAL_SECONDS,
  MEMLOG_SNAPSHOT_MAX_HEAP_BYTES,
  MIN_MEMLOG_INTERVAL_SECONDS,
  parseMemlogInterval,
  startChatMemorySampler,
} from "@/chat/memory-sampler";

const original = { ..._chatMemorySamplerDeps };
let root: string;
let dir: string;
let timers: { callback: () => void; ms: number; cleared: boolean }[];
let signalHandler: (() => void) | undefined;
let signalRemoved: boolean;

const MEMORY = { rss: 4000, heapUsed: 1000, heapTotal: 2000, external: 300, arrayBuffers: 50 };
const HEAP = {
  heapSize: 900,
  heapCapacity: 1800,
  extraMemorySize: 70,
  objectCount: 42,
  protectedObjectCount: 3,
  globalObjectCount: 1,
  protectedGlobalObjectCount: 0,
  protectedObjectTypeCounts: {},
  objectTypeCounts: { Object: 20, Array: 12, string: 7, Function: 3 },
};

beforeEach(() => {
  root = makeTempDir();
  dir = join(root, "chat-diagnostics");
  timers = [];
  signalHandler = undefined;
  signalRemoved = false;
  _chatMemorySamplerDeps.memoryUsage = () => ({ ...MEMORY });
  _chatMemorySamplerDeps.heapStats = () => ({ ...HEAP, objectTypeCounts: { ...HEAP.objectTypeCounts } });
  _chatMemorySamplerDeps.uptime = () => 12.5;
  _chatMemorySamplerDeps.heapSnapshot = () => '{"snapshot":{}}';
  _chatMemorySamplerDeps.setTimeout = (callback, ms) => {
    const timer = { callback, ms, cleared: false };
    timers.push(timer);
    return timer;
  };
  _chatMemorySamplerDeps.clearTimeout = (handle) => {
    const timer = timers.find((candidate) => candidate === handle);
    if (timer !== undefined) timer.cleared = true;
  };
  _chatMemorySamplerDeps.onSnapshotSignal = (handler) => {
    signalHandler = handler;
    return () => {
      signalRemoved = true;
    };
  };
});

afterEach(() => {
  Object.assign(_chatMemorySamplerDeps, original);
  cleanupTempDir(root);
});

function lines(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line): Record<string, unknown> => JSON.parse(line));
}

function start() {
  return startChatMemorySampler({
    dir,
    pid: 4242,
    intervalSeconds: 30,
    now: () => new Date("2026-11-09T12:00:00.000Z"),
  });
}

describe("parseMemlogInterval", () => {
  test.each([undefined, "", "0", "off", "false"])("%p leaves the sampler off", (value) => {
    expect(parseMemlogInterval(value)).toBeUndefined();
  });

  test.each(["1", "on", "true"])("%p enables the default interval", (value) => {
    expect(parseMemlogInterval(value)).toBe(DEFAULT_MEMLOG_INTERVAL_SECONDS);
  });

  test("a number of seconds at or above the floor is the interval", () => {
    expect(parseMemlogInterval("15")).toBe(15);
    expect(parseMemlogInterval(String(MIN_MEMLOG_INTERVAL_SECONDS))).toBe(MIN_MEMLOG_INTERVAL_SECONDS);
  });

  test("the ceiling is accepted and one past it is rejected: a longer delay would clamp to 1 ms", () => {
    expect(parseMemlogInterval(String(MAX_MEMLOG_INTERVAL_SECONDS))).toBe(MAX_MEMLOG_INTERVAL_SECONDS);
    expect(() => parseMemlogInterval(String(MAX_MEMLOG_INTERVAL_SECONDS + 1))).toThrow(/NAX_CHAT_MEMLOG/);
  });

  test.each(["2", "-5", "1.5", "abc", "0x10", "1e1", "3000000"])("%p is rejected with a NaxError", (value) => {
    expect(() => parseMemlogInterval(value)).toThrow(/NAX_CHAT_MEMLOG/);
  });
});

describe("startChatMemorySampler", () => {
  test("writes a start sample at once and names the log by pid", () => {
    const sampler = start();
    expect(sampler.logPath).toBe(join(dir, "memory-4242.jsonl"));
    const [first] = lines(sampler.logPath);
    expect(first).toMatchObject({
      kind: "start",
      ts: "2026-11-09T12:00:00.000Z",
      pid: 4242,
      intervalSeconds: 30,
      uptimeSec: 12.5,
      rss: 4000,
      heapUsed: 1000,
      heapTotal: 2000,
      external: 300,
      arrayBuffers: 50,
      jsc: { heapSize: 900, heapCapacity: 1800, extraMemorySize: 70, objectCount: 42, protectedObjectCount: 3 },
    });
  });

  test("records the heap's most numerous object types, largest first", () => {
    const sampler = start();
    expect(lines(sampler.logPath)[0]).toMatchObject({
      jsc: {
        topTypes: [
          ["Object", 20],
          ["Array", 12],
          ["string", 7],
          ["Function", 3],
        ],
      },
    });
  });

  test("samples on each interval and re-arms the timer", () => {
    const sampler = start();
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(30_000);
    timers[0]?.callback();
    timers[1]?.callback();
    expect(lines(sampler.logPath).map((line) => line.kind)).toEqual(["start", "sample", "sample"]);
    expect(timers).toHaveLength(3);
  });

  test("the snapshot signal writes a private heap snapshot, bracketed by begin and done lines", async () => {
    const sampler = start();
    signalHandler?.();
    await sampler.idle();
    const [name] = readdirSync(dir).filter((file) => file.endsWith(".heapsnapshot"));
    assertDefined(name, "snapshot file");
    expect(name).toBe("heap-4242-2026-11-09T12-00-00-000Z.heapsnapshot");
    const path = join(dir, name);
    expect(readFileSync(path, "utf8")).toBe('{"snapshot":{}}');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(sampler.logPath).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const tail = lines(sampler.logPath).slice(-2);
    expect(tail).toMatchObject([
      { kind: "snapshot-begin", path },
      { kind: "snapshot", path },
    ]);
  });

  test("a heap above the snapshot limit is refused with a skipped line, never generated", async () => {
    let generated = 0;
    _chatMemorySamplerDeps.heapSnapshot = () => {
      generated += 1;
      return "{}";
    };
    _chatMemorySamplerDeps.heapStats = () => ({ ...HEAP, heapSize: MEMLOG_SNAPSHOT_MAX_HEAP_BYTES + 1 });
    const sampler = start();
    signalHandler?.();
    await sampler.idle();
    expect(generated).toBe(0);
    expect(lines(sampler.logPath).at(-1)).toMatchObject({
      kind: "snapshot-skipped",
      limitBytes: MEMLOG_SNAPSHOT_MAX_HEAP_BYTES,
    });
  });

  test("a second signal while a snapshot is being written is ignored", async () => {
    const write = Promise.withResolvers<void>();
    let writes = 0;
    _chatMemorySamplerDeps.writePrivateFile = async () => {
      writes += 1;
      await write.promise;
    };
    const sampler = start();
    signalHandler?.();
    signalHandler?.();
    write.resolve();
    await sampler.idle();
    expect(writes).toBe(1);
  });

  test("stop waits for a snapshot in progress, so its line precedes the stop line", async () => {
    const write = Promise.withResolvers<void>();
    _chatMemorySamplerDeps.writePrivateFile = () => write.promise;
    const sampler = start();
    signalHandler?.();
    const stopping = sampler.stop();
    write.resolve();
    await stopping;
    expect(lines(sampler.logPath).map((line) => line.kind)).toEqual(["start", "snapshot-begin", "snapshot", "stop"]);
  });

  test("a failed snapshot is handed back by stop, not written to the terminal", async () => {
    _chatMemorySamplerDeps.heapSnapshot = () => {
      throw new Error("string too long");
    };
    const sampler = start();
    signalHandler?.();
    await sampler.idle();
    const warnings = await sampler.stop();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("heap snapshot failed");
    expect(warnings[0]).toContain("string too long");
  });

  test("stop records a final sample, clears the timer and removes the signal handler", async () => {
    const sampler = start();
    expect(await sampler.stop()).toEqual([]);
    expect(lines(sampler.logPath).at(-1)?.kind).toBe("stop");
    expect(timers[0]?.cleared).toBe(true);
    expect(signalRemoved).toBe(true);
    await sampler.stop();
    expect(lines(sampler.logPath).filter((line) => line.kind === "stop")).toHaveLength(1);
  });

  test("failing writes are queued once per kind and never throw into the chat", async () => {
    _chatMemorySamplerDeps.appendLine = () => {
      throw new Error("disk full");
    };
    const sampler = startChatMemorySampler({ dir, pid: 1, intervalSeconds: 30, now: () => new Date() });
    timers[0]?.callback();
    signalHandler?.();
    await sampler.idle();
    const warnings = await sampler.stop();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("memory log write failed");
    expect(warnings[0]).toContain("disk full");
    expect(existsSync(sampler.logPath)).toBe(false);
  });
});
