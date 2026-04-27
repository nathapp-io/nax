import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getLogger, initLogger, resetLogger } from "../../../../src/logger";
import type { LogEntry } from "../../../../src/logger/types";
import type { MiddlewareContext } from "../../../../src/runtime/agent-middleware";
import { loggingMiddleware } from "../../../../src/runtime/middleware/logging";

function makeCtx(overrides: Partial<MiddlewareContext> = {}): MiddlewareContext {
  return {
    runId: "r-001",
    agentName: "claude",
    kind: "run",
    request: null,
    prompt: null,
    resolvedPermissions: { mode: "approve-reads", skipPermissions: false },
    ...overrides,
  };
}

async function parseLastEntry(logFile: string): Promise<LogEntry> {
  const content = await Bun.file(logFile).text();
  const lines = content.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]) as LogEntry;
}

describe("loggingMiddleware", () => {
  let logFile: string;

  beforeEach(() => {
    logFile = `${import.meta.dir}/test-logging-mw-${Date.now()}.jsonl`;
    initLogger({ level: "debug", filePath: logFile, useChalk: false, headless: true });
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

  describe("before()", () => {
    test("is no-op when logger is not initialized", async () => {
      resetLogger();
      const mw = loggingMiddleware();
      const ctx = makeCtx();
      await expect(mw.before?.(ctx)).resolves.toBeUndefined();
    });

    test("logs structured entry with agentName, stage, kind, runId, storyId", async () => {
      const mw = loggingMiddleware();
      const ctx = makeCtx({
        agentName: "codex",
        kind: "complete",
        stage: "run",
        storyId: "s-42",
        runId: "r-001",
      });

      await mw.before?.(ctx);
      await getLogger().flush();

      const entry = await parseLastEntry(logFile);
      expect(entry.level).toBe("info");
      expect(entry.stage).toBe("middleware");
      expect(entry.message).toBe("Agent call start");
      expect(entry.data).toMatchObject({
        agentName: "codex",
        kind: "complete",
        stage: "run",
        storyId: "s-42",
        runId: "r-001",
      });
    });

    test("receives correct context fields for a run call", async () => {
      const mw = loggingMiddleware();
      const ctx = makeCtx({
        agentName: "claude",
        kind: "run",
        stage: "verify",
        storyId: "s-99",
      });

      await mw.before?.(ctx);
      await getLogger().flush();

      const entry = await parseLastEntry(logFile);
      expect(entry.data).toMatchObject({
        agentName: "claude",
        kind: "run",
        stage: "verify",
        storyId: "s-99",
      });
    });
  });

  describe("after()", () => {
    test("is no-op when logger is not initialized", async () => {
      resetLogger();
      const mw = loggingMiddleware();
      const ctx = makeCtx();
      await expect(mw.after?.(ctx, { success: true }, 100)).resolves.toBeUndefined();
    });

    test("logs structured entry with agentName, durationMs, stage, kind", async () => {
      const mw = loggingMiddleware();
      const ctx = makeCtx({
        agentName: "codex",
        kind: "run",
        stage: "verify",
      });

      await mw.after?.(ctx, { output: "result" }, 350);
      await getLogger().flush();

      const entry = await parseLastEntry(logFile);
      expect(entry.level).toBe("info");
      expect(entry.message).toBe("Agent call complete");
      expect(entry.data).toMatchObject({
        agentName: "codex",
        durationMs: 350,
        kind: "run",
        stage: "verify",
      });
    });

    test("handles empty result object", async () => {
      const mw = loggingMiddleware();
      const ctx = makeCtx();

      await mw.after?.(ctx, {}, 0);
      await getLogger().flush();

      const entry = await parseLastEntry(logFile);
      expect(entry.message).toBe("Agent call complete");
    });
  });

  describe("onError()", () => {
    test("is no-op when logger is not initialized", async () => {
      resetLogger();
      const mw = loggingMiddleware();
      const ctx = makeCtx();
      await expect(mw.onError?.(ctx, new Error("boom"), 25)).resolves.toBeUndefined();
    });

    test("logs warn-level entry with error message", async () => {
      const mw = loggingMiddleware();
      const ctx = makeCtx({
        agentName: "claude",
        kind: "complete",
        stage: "run",
      });
      const err = new Error("boom");

      await mw.onError?.(ctx, err, 100);
      await getLogger().flush();

      const entry = await parseLastEntry(logFile);
      expect(entry.level).toBe("warn");
      expect(entry.message).toBe("Agent call failed");
      expect(entry.data).toMatchObject({
        error: "boom",
        agentName: "claude",
        durationMs: 100,
        kind: "complete",
        stage: "run",
      });
    });

    test("handles string error", async () => {
      const mw = loggingMiddleware();
      const ctx = makeCtx({ agentName: "claude" });

      await mw.onError?.(ctx, "plain string" as unknown, 5);
      await getLogger().flush();

      const entry = await parseLastEntry(logFile);
      expect(entry.data?.error).toBe("plain string");
    });

    test("handles unknown error shape", async () => {
      const mw = loggingMiddleware();
      const ctx = makeCtx({ agentName: "claude" });

      await mw.onError?.(ctx, { code: "ERR_X" }, 15);
      await getLogger().flush();

      const entry = await parseLastEntry(logFile);
      expect(entry.data?.error).toEqual("[object Object]");
    });

    test("handles null error", async () => {
      const mw = loggingMiddleware();
      const ctx = makeCtx();

      await mw.onError?.(ctx, null, 0);
      await getLogger().flush();

      const entry = await parseLastEntry(logFile);
      expect(entry.data?.error).toBe("null");
    });

    test("handles Error subclass with message extraction", async () => {
      const mw = loggingMiddleware();
      const ctx = makeCtx({ agentName: "claude" });

      class CustomError extends Error {
        constructor(message: string) {
          super(message);
          this.name = "CustomError";
        }
      }

      await mw.onError?.(ctx, new CustomError("something went wrong"), 75);
      await getLogger().flush();

      const entry = await parseLastEntry(logFile);
      expect(entry.data?.error).toBe("something went wrong");
    });
  });

  describe("middleware interface", () => {
    test("has name field set to 'logging'", () => {
      const mw = loggingMiddleware();
      expect(mw.name).toBe("logging");
    });

    test("has before, after, and onError hooks", () => {
      const mw = loggingMiddleware();
      expect(typeof mw.before).toBe("function");
      expect(typeof mw.after).toBe("function");
      expect(typeof mw.onError).toBe("function");
    });
  });
});
