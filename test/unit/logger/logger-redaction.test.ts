import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Logger, resetLogger } from "../../../src/logger/logger";
import { makeTempDir, cleanupTempDir } from "../../helpers/temp";

describe("logger redaction in JSONL output", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-logger-redact-");
    resetLogger();
  });

  afterEach(() => {
    resetLogger();
    cleanupTempDir(tempDir);
  });

  test("redacts secret key values from persisted log file", async () => {
    const logPath = join(tempDir, "run.jsonl");
    const logger = new Logger({ level: "info", filePath: logPath });

    logger.info("test", "Running with credentials", {
      storyId: "story-001",
      GITHUB_TOKEN: "ghp_supersecrettoken1234567890",
      note: "safe value",
    });
    await logger.flush();

    const content = readFileSync(logPath, "utf8");
    const entry = JSON.parse(content.trim());

    expect(JSON.stringify(entry)).not.toContain("ghp_supersecrettoken1234567890");
    expect(entry.data.GITHUB_TOKEN).toBe("[REDACTED]");
    expect(entry.data.note).toBe("safe value");
  });

  test("redacts token-shaped substrings in free-text values", async () => {
    const logPath = join(tempDir, "run.jsonl");
    const logger = new Logger({ level: "info", filePath: logPath });

    logger.info("test", "Output logged", {
      storyId: "story-002",
      output: "agent used sk-ant-aaaaaaaaaaaaaaaaaaa for the call",
    });
    await logger.flush();

    const content = readFileSync(logPath, "utf8");
    const entry = JSON.parse(content.trim());

    expect(JSON.stringify(entry)).not.toContain("sk-ant-aaaaaaaaaaaaaaaaaaa");
    expect(entry.data.output).toContain("[REDACTED]");
  });

  test("leaves non-secret fields intact", async () => {
    const logPath = join(tempDir, "run.jsonl");
    const logger = new Logger({ level: "info", filePath: logPath });

    logger.info("test", "Normal log", {
      storyId: "story-003",
      count: 42,
      message: "no secrets here",
    });
    await logger.flush();

    const content = readFileSync(logPath, "utf8");
    const entry = JSON.parse(content.trim());

    expect(entry.data.count).toBe(42);
    expect(entry.data.message).toBe("no secrets here");
  });

  test("redacts nested secret keys", async () => {
    const logPath = join(tempDir, "run.jsonl");
    const logger = new Logger({ level: "info", filePath: logPath });

    logger.info("test", "Nested secrets", {
      storyId: "story-004",
      env: { AWS_SECRET_ACCESS_KEY: "AKIAsecret0000000000" },
    });
    await logger.flush();

    const content = readFileSync(logPath, "utf8");
    const entry = JSON.parse(content.trim());

    expect(JSON.stringify(entry)).not.toContain("AKIAsecret0000000000");
    expect(entry.data.env.AWS_SECRET_ACCESS_KEY).toBe("[REDACTED]");
  });
});
