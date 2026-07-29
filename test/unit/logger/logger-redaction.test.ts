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

  test("redacts token-shaped substrings in the message itself", async () => {
    const logPath = join(tempDir, "run.jsonl");
    const logger = new Logger({ level: "info", filePath: logPath });

    logger.info("quality", "command failed: NPM_TOKEN=npm_ABCDEFGH12345678 bun publish", {
      storyId: "story-005",
    });
    logger.info("quality", "auth failed with ghp_ABCDEFGHIJKLMNOP1234567890", {
      storyId: "story-006",
    });
    await logger.flush();

    const content = readFileSync(logPath, "utf8");

    expect(content).not.toContain("npm_ABCDEFGH12345678");
    expect(content).not.toContain("ghp_ABCDEFGHIJKLMNOP1234567890");

    const [first, second] = content.trim().split("\n").map((l) => JSON.parse(l));
    expect(first.message).toContain("[REDACTED]");
    expect(first.message).toContain("command failed:");
    expect(second.message).toContain("[REDACTED]");
  });

  test("leaves a secret-free message byte-identical", async () => {
    const logPath = join(tempDir, "run.jsonl");
    const logger = new Logger({ level: "info", filePath: logPath });

    logger.info("quality", "typecheck completed in 4200ms", { storyId: "story-007" });
    await logger.flush();

    const entry = JSON.parse(readFileSync(logPath, "utf8").trim());
    expect(entry.message).toBe("typecheck completed in 4200ms");
  });

  test("redacts the message on the console path too", () => {
    const logger = new Logger({ level: "info", useChalk: false });
    const captured: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };

    try {
      logger.info("quality", "auth failed with ghp_ABCDEFGHIJKLMNOP1234567890");
    } finally {
      console.log = originalLog;
    }

    expect(captured.join("\n")).not.toContain("ghp_ABCDEFGHIJKLMNOP1234567890");
    expect(captured.join("\n")).toContain("[REDACTED]");
  });

  test("preserves write ordering across many entries", async () => {
    const logPath = join(tempDir, "run.jsonl");
    const logger = new Logger({ level: "info", filePath: logPath });

    for (let i = 0; i < 200; i++) {
      logger.info("bulk", `entry-${i}`, { storyId: "story-008", i });
    }
    await logger.flush();

    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(200);
    expect(lines.map((l) => JSON.parse(l).message)).toEqual(
      Array.from({ length: 200 }, (_, i) => `entry-${i}`),
    );
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
