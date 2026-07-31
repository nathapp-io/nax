import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addSink, getLogger, initLogger, resetLogger } from "@/logger";
import type { LogEntry } from "@/logger";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

describe("logger sink registration", () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resetLogger();
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    initLogger({ level: "debug" });
  });

  afterEach(() => {
    resetLogger();
    consoleSpy.mockRestore();
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
    const iso = new Date(calls[0].timestamp).toISOString();
    expect(iso.startsWith(String(new Date().getFullYear()))).toBe(true);
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
});
