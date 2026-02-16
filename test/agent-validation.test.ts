import { describe, test, expect, mock } from "bun:test";
import { ClaudeCodeAdapter } from "../src/agents/claude";
import type { AgentRunOptions } from "../src/agents";

describe("Agent Validation and Retry Logic", () => {
  describe("ClaudeCodeAdapter.isInstalled", () => {
    test("returns true when binary exists in PATH", async () => {
      const adapter = new ClaudeCodeAdapter();
      // Mock successful which command
      const originalSpawn = Bun.spawn;
      (Bun as any).spawn = mock((cmd: string[]) => {
        if (cmd[0] === "which" && cmd[1] === "claude") {
          return {
            exited: Promise.resolve(0),
            stdout: { getReader: () => ({ read: () => Promise.resolve({ done: true }) }) },
            stderr: { getReader: () => ({ read: () => Promise.resolve({ done: true }) }) },
          };
        }
        return originalSpawn(cmd);
      });

      const installed = await adapter.isInstalled();
      expect(installed).toBe(true);

      Bun.spawn = originalSpawn;
    });

    test("returns false when binary does not exist", async () => {
      const adapter = new ClaudeCodeAdapter();
      // Mock failed which command
      const originalSpawn = Bun.spawn;
      (Bun as any).spawn = mock((cmd: string[]) => {
        if (cmd[0] === "which" && cmd[1] === "claude") {
          return {
            exited: Promise.resolve(1),
            stdout: { getReader: () => ({ read: () => Promise.resolve({ done: true }) }) },
            stderr: { getReader: () => ({ read: () => Promise.resolve({ done: true }) }) },
          };
        }
        return originalSpawn(cmd);
      });

      const installed = await adapter.isInstalled();
      expect(installed).toBe(false);

      Bun.spawn = originalSpawn;
    });

    test("returns false on exception", async () => {
      const adapter = new ClaudeCodeAdapter();
      const originalSpawn = Bun.spawn;
      (Bun as any).spawn = mock(() => {
        throw new Error("Command not found");
      });

      const installed = await adapter.isInstalled();
      expect(installed).toBe(false);

      Bun.spawn = originalSpawn;
    });
  });

  describe("ClaudeCodeAdapter timeout handling", () => {
    test("distinguishes timeout from normal failure", async () => {
      const adapter = new ClaudeCodeAdapter();
      const originalSpawn = Bun.spawn;

      // Mock process that times out
      (Bun as any).spawn = mock(() => {
        let killed = false;
        return {
          exited: new Promise((resolve) => {
            setTimeout(() => resolve(killed ? 143 : 0), 100);
          }),
          kill: (signal: string) => {
            if (signal === "SIGTERM") killed = true;
          },
          stdout: new Response("").body,
          stderr: new Response("").body,
        };
      });

      const options: AgentRunOptions = {
        prompt: "test",
        workdir: "/tmp",
        modelTier: "balanced",
        modelDef: { provider: "anthropic", model: "claude-sonnet-4.5", env: {} },
        timeoutSeconds: 0.05, // 50ms timeout
      };

      const result = await adapter.run(options);

      // Should be marked as timeout (exit code 124)
      expect(result.exitCode).toBe(124);
      expect(result.success).toBe(false);

      Bun.spawn = originalSpawn;
    });
  });

  describe("ClaudeCodeAdapter retry logic", () => {
    test("retries on rate limit with exponential backoff", async () => {
      const adapter = new ClaudeCodeAdapter();
      const originalSpawn = Bun.spawn;
      let attemptCount = 0;

      // Mock rate-limited response that succeeds on 3rd try
      (Bun as any).spawn = mock(() => {
        attemptCount++;
        const isRateLimited = attemptCount < 3;

        return {
          exited: Promise.resolve(isRateLimited ? 1 : 0),
          kill: () => {},
          stdout: new Response(isRateLimited ? "" : "success").body,
          stderr: new Response(isRateLimited ? "rate limit exceeded" : "").body,
        };
      });

      const options: AgentRunOptions = {
        prompt: "test",
        workdir: "/tmp",
        modelTier: "balanced",
        modelDef: { provider: "anthropic", model: "claude-sonnet-4.5", env: {} },
        timeoutSeconds: 60,
      };

      const startTime = Date.now();
      const result = await adapter.run(options);
      const duration = Date.now() - startTime;

      // Should succeed after retries
      expect(result.success).toBe(true);
      expect(attemptCount).toBe(3);

      // Should have backoff delays (2s + 4s = 6s, but we'll check for at least 3s)
      // Note: In real implementation, backoff is 2^attempt * 1000 = 2s, 4s
      expect(duration).toBeGreaterThanOrEqual(3000);

      Bun.spawn = originalSpawn;
    }, { timeout: 15000 });

    test("fails after max retries on persistent errors", async () => {
      const adapter = new ClaudeCodeAdapter();
      const originalSpawn = Bun.spawn;
      let attemptCount = 0;

      // Mock persistent failure
      (Bun as any).spawn = mock(() => {
        attemptCount++;
        return {
          exited: Promise.resolve(1),
          kill: () => {},
          stdout: new Response("").body,
          stderr: new Response("persistent error").body,
        };
      });

      const options: AgentRunOptions = {
        prompt: "test",
        workdir: "/tmp",
        modelTier: "balanced",
        modelDef: { provider: "anthropic", model: "claude-sonnet-4.5", env: {} },
        timeoutSeconds: 60,
      };

      const result = await adapter.run(options);

      // Should fail after 3 attempts
      expect(result.success).toBe(false);
      expect(attemptCount).toBe(3);

      Bun.spawn = originalSpawn;
    }, { timeout: 15000 });

    test("succeeds immediately on first attempt if no error", async () => {
      const adapter = new ClaudeCodeAdapter();
      const originalSpawn = Bun.spawn;
      let attemptCount = 0;

      // Mock successful execution
      (Bun as any).spawn = mock(() => {
        attemptCount++;
        return {
          exited: Promise.resolve(0),
          kill: () => {},
          stdout: new Response("success").body,
          stderr: new Response("").body,
        };
      });

      const options: AgentRunOptions = {
        prompt: "test",
        workdir: "/tmp",
        modelTier: "balanced",
        modelDef: { provider: "anthropic", model: "claude-sonnet-4.5", env: {} },
        timeoutSeconds: 60,
      };

      const result = await adapter.run(options);

      // Should succeed on first try
      expect(result.success).toBe(true);
      expect(attemptCount).toBe(1);

      Bun.spawn = originalSpawn;
    });

    test("does not retry on timeout (exit code 124)", async () => {
      const adapter = new ClaudeCodeAdapter();
      const originalSpawn = Bun.spawn;
      let attemptCount = 0;

      // Mock timeout
      (Bun as any).spawn = mock(() => {
        attemptCount++;
        let killed = false;
        return {
          exited: new Promise((resolve) => {
            setTimeout(() => resolve(killed ? 143 : 0), 100);
          }),
          kill: (signal: string) => {
            if (signal === "SIGTERM") killed = true;
          },
          stdout: new Response("").body,
          stderr: new Response("").body,
        };
      });

      const options: AgentRunOptions = {
        prompt: "test",
        workdir: "/tmp",
        modelTier: "balanced",
        modelDef: { provider: "anthropic", model: "claude-sonnet-4.5", env: {} },
        timeoutSeconds: 0.05, // 50ms timeout
      };

      const result = await adapter.run(options);

      // Should not retry on timeout
      expect(result.exitCode).toBe(124);
      expect(attemptCount).toBe(1);

      Bun.spawn = originalSpawn;
    });
  });

  describe("ClaudeCodeAdapter command building", () => {
    test("builds correct command with model and prompt", () => {
      const adapter = new ClaudeCodeAdapter();
      const options: AgentRunOptions = {
        prompt: "test prompt",
        workdir: "/tmp",
        modelTier: "balanced",
        modelDef: { provider: "anthropic", model: "claude-sonnet-4.5", env: {} },
        timeoutSeconds: 60,
      };

      const cmd = adapter.buildCommand(options);

      expect(cmd).toEqual([
        "claude",
        "--model",
        "claude-sonnet-4.5",
        "--dangerously-skip-permissions",
        "-p",
        "test prompt",
      ]);
    });
  });
});
