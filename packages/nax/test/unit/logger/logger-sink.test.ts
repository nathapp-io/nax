import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import type { LogEntry } from "@/logger";
import { addSink, getLogger, initLogger, resetLogger } from "@/logger";

describe("logger sink registration", () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resetLogger();
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    // `SinkRegistry` writes `[logger] Sink threw: …` to stderr when a sink
    // throws — that's the production contract under test, but the deliberate
    // fault-isolation tests below don't need the stderr noise in their output.
    stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    initLogger({ level: "debug" });
  });

  afterEach(() => {
    resetLogger();
    consoleSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  test("AC-1: addSink returns a function when called with a no-op sink", () => {
    const unsub = addSink(() => {});
    expect(typeof unsub).toBe("function");
  });

  test("AC-2: sink receives entry.message equal to the logged message", () => {
    const calls: LogEntry[] = [];
    addSink((entry) => calls.push(entry));
    getLogger().info("verify", "no test command");
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toBe("no test command");
  });

  test("AC-3: sink receives entry.stage equal to the stage passed to the log call", () => {
    const calls: LogEntry[] = [];
    addSink((entry) => calls.push(entry));
    getLogger().info("verify", "test");
    expect(calls[0].stage).toBe("verify");
  });

  test("AC-4: sink receives entry.level equal to the severity of the invoked method", () => {
    const calls: LogEntry[] = [];
    addSink((entry) => calls.push(entry));
    getLogger().warn("some-stage", "test");
    expect(calls[0].level).toBe("warn");
  });

  test("AC-5: sink receives a valid ISO-8601 timestamp", () => {
    const calls: LogEntry[] = [];
    addSink((entry) => calls.push(entry));
    getLogger().info("some-stage", "test");
    expect(calls[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(calls[0].timestamp).toISOString()).toBe(calls[0].timestamp);
  });

  test("AC-6: story-scoped log call delivers storyId to the sink", () => {
    const calls: LogEntry[] = [];
    addSink((entry) => calls.push(entry));
    getLogger().withStory("story-abc").info("some-stage", "test");
    expect(calls[0].storyId).toBe("story-abc");
  });

  test("AC-7: apiKey value is redacted before reaching the sink", () => {
    const calls: LogEntry[] = [];
    addSink((entry) => calls.push(entry));
    getLogger().info("some-stage", "test", { apiKey: "sk-live-abc123" });
    expect(calls[0].data?.apiKey).toBe("[REDACTED]");
  });

  test("AC-8: token-shaped substring in message is redacted before reaching the sink", () => {
    const calls: LogEntry[] = [];
    addSink((entry) => calls.push(entry));
    getLogger().info("some-stage", "token ghp_0123456789abcdefghij failed");
    expect(calls[0].message).toBe("token [REDACTED] failed");
  });

  test("AC-9: invoking the unsubscribe function stops further delivery", () => {
    const calls: LogEntry[] = [];
    const unsub = addSink((entry) => calls.push(entry));
    unsub();
    getLogger().info("some-stage", "test");
    expect(calls).toHaveLength(0);
  });

  test("AC-10: two registered sinks each receive the entry from one log call", () => {
    const calls1: LogEntry[] = [];
    const calls2: LogEntry[] = [];
    addSink((entry) => calls1.push(entry));
    addSink((entry) => calls2.push(entry));
    getLogger().info("some-stage", "test");
    expect(calls1).toHaveLength(1);
    expect(calls2).toHaveLength(1);
    expect(calls1[0]).toEqual(calls2[0]);
  });

  test("AC-11: a throwing sink does not prevent delivery to a subsequently registered sink", () => {
    const calls2: LogEntry[] = [];
    addSink(() => {
      throw new Error("sink error");
    });
    addSink((entry) => calls2.push(entry));
    getLogger().info("some-stage", "test");
    expect(calls2).toHaveLength(1);
    expect(calls2[0].message).toBe("test");
  });

  test("AC-12: the JSONL file still receives the entry when a registered sink throws", async () => {
    const tempDir = makeTempDir("nax-logger-sink-");
    try {
      resetLogger();
      const logPath = join(tempDir, "run.jsonl");
      const fileLogger = initLogger({ level: "info", filePath: logPath });
      addSink(() => {
        throw new Error("sink error");
      });
      fileLogger.info("some-stage", "test");
      await fileLogger.flush();
      const content = readFileSync(logPath, "utf8");
      const entry = JSON.parse(content.trim());
      expect(entry.message).toBe("test");
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  test("AC-13: a log call does not throw when a registered sink throws", () => {
    addSink(() => {
      throw new Error("sink error");
    });
    expect(() => getLogger().info("some-stage", "test")).not.toThrow();
  });

  // BUG-22: SinkRegistry shallow-clones only the top-level entry; a sink
  // mutating entry.data leaks the change to later sinks and to the JSONL
  // file written after dispatch. The dispatcher's docstring claims
  // mutation isolation — make it true for the data field at least.
  describe("BUG-22: mutation isolation between sinks and JSONL writer", () => {
    test("a sink mutating entry.data does not affect a later sink", () => {
      const observed: Array<LogEntry["data"]> = [];
      addSink((entry) => {
        if (entry.data) entry.data.corrupted = true;
      });
      addSink((entry) => observed.push(entry.data));
      getLogger().info("stage", "msg", { original: "value" });
      expect(observed[0]?.corrupted).toBeUndefined();
      expect(observed[0]?.original).toBe("value");
    });

    test("a sink mutating entry.data does not affect the JSONL writer", async () => {
      const tempDir = makeTempDir("nax-logger-sink-bug22-");
      try {
        resetLogger();
        const logPath = join(tempDir, "run.jsonl");
        const fileLogger = initLogger({ level: "info", filePath: logPath });
        addSink((entry) => {
          if (entry.data) entry.data.injected = "later";
        });
        fileLogger.info("stage", "msg", { original: "value" });
        await fileLogger.flush();
        const content = readFileSync(logPath, "utf8");
        const parsed = JSON.parse(content.trim());
        expect(parsed.data.injected).toBeUndefined();
        expect(parsed.data.original).toBe("value");
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  });
});
