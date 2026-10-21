import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { _botLogDeps, openBotLog } from "@/bot/log";
import { NaxError } from "@/errors";
import { getLogger, initLogger, resetLogger } from "@/logger";

const original = { ..._botLogDeps };
let lines: string[];
beforeEach(() => {
  resetLogger();
  initLogger({ level: "silent", useChalk: false });
  lines = [];
  _botLogDeps.appendFile = async (path, text) => {
    lines.push(`${path}:${text}`);
  };
});
afterEach(() => {
  Object.assign(_botLogDeps, original);
  resetLogger();
});
describe("openBotLog", () => {
  test("propagates unexpected sink registration failures", () => {
    const error = new NaxError("sink", "TEST_SINK", { stage: "test" });
    _botLogDeps.addSink = () => {
      throw error;
    };
    expect(() => openBotLog("/log")).toThrow(error);
  });
  test("creates the run directory and persists a real redacted line", async () => {
    await withTempDir(async (dir) => {
      _botLogDeps.appendFile = original.appendFile;
      const path = join(dir, "new-run", "bot.jsonl");
      const log = openBotLog(path);
      getLogger().warn("bot", "x", { token: "private-token" });
      await log.close();
      const text = await Bun.file(path).text();
      expect(JSON.parse(text)).toMatchObject({ stage: "bot", message: "x" });
      expect(text).not.toContain("private-token");
    });
  });
  test("US-016 AC-1/2/3/5 writes warn and info JSONL while silent, then unsubscribes", async () => {
    const log = openBotLog("/log");
    getLogger().warn("bot", "x");
    getLogger().info("bot", "info");
    await log.close();
    expect(log.path).toBe("/log");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith("/log:");
    expect(lines[0]).toEndWith("\n");
    expect(JSON.parse(lines[0]?.slice(5) ?? "")).toMatchObject({ level: "warn", stage: "bot", message: "x" });
    expect(JSON.parse(lines[1]?.slice(5) ?? "")).toMatchObject({ level: "info", message: "info" });
    getLogger().warn("bot", "later");
    await log.close();
    expect(lines).toHaveLength(2);
  });
  test("US-016 AC-4/6 serializes appends and drains every pending write", async () => {
    const started: string[] = [];
    const releases: (() => void)[] = [];
    _botLogDeps.appendFile = async (_path, text) => {
      started.push(JSON.parse(text).message);
      await new Promise<void>((resolve) => releases.push(resolve));
    };
    const log = openBotLog("/log");
    getLogger().warn("bot", "first");
    getLogger().warn("bot", "second");
    let closed = false;
    const closing = log.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(started).toEqual(["first"]);
    expect(closed).toBe(false);
    releases[0]?.();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(started).toEqual(["first", "second"]);
    expect(closed).toBe(false);
    releases[1]?.();
    await closing;
    expect(closed).toBe(true);
  });
  test("US-016 AC-7 tolerates an uninitialized logger", async () => {
    _botLogDeps.addSink = () => {
      throw new NaxError("missing", "LOGGER_NOT_INITIALIZED", { stage: "logger" });
    };
    const log = openBotLog("/log");
    expect(log.path).toBeUndefined();
    await log.close();
    expect(lines).toEqual([]);
  });
  test("US-016 AC-8 drops failed appends and continues", async () => {
    let attempts = 0;
    _botLogDeps.appendFile = async () => {
      attempts++;
      throw new NaxError("disk", "TEST_DISK", { stage: "test" });
    };
    const log = openBotLog("/log");
    expect(() => getLogger().warn("bot", "x")).not.toThrow();
    getLogger().warn("bot", "y");
    await log.close();
    expect(attempts).toBe(2);
  });
});
