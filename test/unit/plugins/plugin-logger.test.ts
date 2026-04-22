/**
 * Tests for PluginLogger — write-only, stage-prefixed logger for plugins.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getLogger, initLogger, resetLogger } from "../../../src/logger";
import { createPluginLogger } from "../../../src/plugins/plugin-logger";
import type { PluginLogger } from "../../../src/plugins/types";

describe("createPluginLogger", () => {
  let logFile: string;
  let logger: PluginLogger;

  beforeEach(() => {
    logFile = `${import.meta.dir}/test-plugin-logger-${Date.now()}.jsonl`;
    initLogger({ level: "debug", filePath: logFile });
    logger = createPluginLogger("test-plugin");
  });

  afterEach(async () => {
    resetLogger();
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(logFile);
    } catch {
      // ignore cleanup errors
    }
  });

  test("logs info with plugin:<name> stage prefix", async () => {
    logger.info("Scanning files", { count: 5 });
    await getLogger().flush();

    // Read the JSONL log file
    const content = await Bun.file(logFile).text();
    const entry = JSON.parse(content.trim().split("\n").pop()!);

    expect(entry.stage).toBe("plugin:test-plugin");
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("Scanning files");
    expect(entry.data).toEqual({ count: 5 });
  });

  test("logs error with correct level", async () => {
    logger.error("Something broke");
    await getLogger().flush();

    const content = await Bun.file(logFile).text();
    const entry = JSON.parse(content.trim().split("\n").pop()!);

    expect(entry.stage).toBe("plugin:test-plugin");
    expect(entry.level).toBe("error");
    expect(entry.message).toBe("Something broke");
  });

  test("logs warn with correct level", async () => {
    logger.warn("Deprecated API usage");
    await getLogger().flush();

    const content = await Bun.file(logFile).text();
    const entry = JSON.parse(content.trim().split("\n").pop()!);

    expect(entry.level).toBe("warn");
    expect(entry.stage).toBe("plugin:test-plugin");
  });

  test("logs debug with correct level", async () => {
    logger.debug("Internal state", { phase: "init" });
    await getLogger().flush();

    const content = await Bun.file(logFile).text();
    const entry = JSON.parse(content.trim().split("\n").pop()!);

    expect(entry.level).toBe("debug");
    expect(entry.data).toEqual({ phase: "init" });
  });

  test("different plugins get different stage prefixes", async () => {
    const logger2 = createPluginLogger("semgrep-security");

    logger.info("From test-plugin");
    logger2.info("From semgrep");
    await getLogger().flush();

    const content = await Bun.file(logFile).text();
    const lines = content.trim().split("\n").map((l) => JSON.parse(l));

    expect(lines.some((l) => l.stage === "plugin:test-plugin")).toBe(true);
    expect(lines.some((l) => l.stage === "plugin:semgrep-security")).toBe(true);
  });

  test("works without data parameter", async () => {
    logger.info("No data");
    await getLogger().flush();

    const content = await Bun.file(logFile).text();
    const entry = JSON.parse(content.trim().split("\n").pop()!);

    expect(entry.message).toBe("No data");
    expect(entry.data).toBeUndefined();
  });

  test("silently drops calls when global logger is not initialized", () => {
    resetLogger();
    const orphanLogger = createPluginLogger("orphan");

    // Should not throw
    expect(() => {
      orphanLogger.info("This goes nowhere");
      orphanLogger.error("This too");
      orphanLogger.warn("And this");
      orphanLogger.debug("Silent");
    }).not.toThrow();
  });
});
