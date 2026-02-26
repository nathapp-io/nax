import { describe, test, expect, mock } from "bun:test";
import { ClaudeCodeAdapter } from "../../src/agents/claude";
import { validateAgentForTier, validateAgentFeature, describeAgentCapabilities } from "../../src/agents/validation";
import type { AgentAdapter, AgentRunOptions } from "../../src/agents";

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

  describe("Agent Capability Metadata", () => {
    const claudeAdapter = new ClaudeCodeAdapter();

    describe("ClaudeCodeAdapter capabilities", () => {
      test("declares all expected tiers", () => {
        const caps = claudeAdapter.capabilities;
        expect(caps.supportedTiers).toContain("fast");
        expect(caps.supportedTiers).toContain("balanced");
        expect(caps.supportedTiers).toContain("powerful");
        expect(caps.supportedTiers.length).toBe(3);
      });

      test("declares all expected features", () => {
        const caps = claudeAdapter.capabilities;
        expect(caps.features.has("tdd")).toBe(true);
        expect(caps.features.has("review")).toBe(true);
        expect(caps.features.has("refactor")).toBe(true);
        expect(caps.features.has("batch")).toBe(true);
        expect(caps.features.size).toBe(4);
      });

      test("declares 200k token context window", () => {
        expect(claudeAdapter.capabilities.maxContextTokens).toBe(200_000);
      });
    });

    describe("validateAgentForTier", () => {
      test("returns true for supported tiers", () => {
        expect(validateAgentForTier(claudeAdapter, "fast")).toBe(true);
        expect(validateAgentForTier(claudeAdapter, "balanced")).toBe(true);
        expect(validateAgentForTier(claudeAdapter, "powerful")).toBe(true);
      });

      test("returns false for unsupported tiers (custom agent)", () => {
        // Create a mock agent that only supports fast tier
        const limitedAgent: AgentAdapter = {
          name: "limited",
          displayName: "Limited Agent",
          binary: "limited",
          capabilities: {
            supportedTiers: ["fast"],
            maxContextTokens: 50_000,
            features: new Set(["review"]),
          },
          async isInstalled() { return true; },
          async run() {
            return {
              success: true,
              exitCode: 0,
              output: "",
              rateLimited: false,
              durationMs: 1000,
              estimatedCost: 0.01
            };
          },
          buildCommand() { return ["limited"]; },
        };

        expect(validateAgentForTier(limitedAgent, "fast")).toBe(true);
        expect(validateAgentForTier(limitedAgent, "balanced")).toBe(false);
        expect(validateAgentForTier(limitedAgent, "powerful")).toBe(false);
      });
    });

    describe("validateAgentFeature", () => {
      test("returns true for supported features", () => {
        expect(validateAgentFeature(claudeAdapter, "tdd")).toBe(true);
        expect(validateAgentFeature(claudeAdapter, "review")).toBe(true);
        expect(validateAgentFeature(claudeAdapter, "refactor")).toBe(true);
        expect(validateAgentFeature(claudeAdapter, "batch")).toBe(true);
      });

      test("returns false for unsupported features (custom agent)", () => {
        const reviewOnlyAgent: AgentAdapter = {
          name: "reviewer",
          displayName: "Review Agent",
          binary: "reviewer",
          capabilities: {
            supportedTiers: ["fast", "balanced"],
            maxContextTokens: 100_000,
            features: new Set(["review"]),
          },
          async isInstalled() { return true; },
          async run() {
            return {
              success: true,
              exitCode: 0,
              output: "",
              rateLimited: false,
              durationMs: 1000,
              estimatedCost: 0.01
            };
          },
          buildCommand() { return ["reviewer"]; },
        };

        expect(validateAgentFeature(reviewOnlyAgent, "review")).toBe(true);
        expect(validateAgentFeature(reviewOnlyAgent, "tdd")).toBe(false);
        expect(validateAgentFeature(reviewOnlyAgent, "refactor")).toBe(false);
        expect(validateAgentFeature(reviewOnlyAgent, "batch")).toBe(false);
      });
    });

    describe("describeAgentCapabilities", () => {
      test("formats Claude Code capabilities correctly", () => {
        const description = describeAgentCapabilities(claudeAdapter);
        expect(description).toContain("claude:");
        expect(description).toContain("tiers=[fast,balanced,powerful]");
        expect(description).toContain("maxTokens=200000");
        expect(description).toContain("features=");
        expect(description).toContain("tdd");
        expect(description).toContain("review");
        expect(description).toContain("refactor");
        expect(description).toContain("batch");
      });

      test("formats limited agent capabilities correctly", () => {
        const limitedAgent: AgentAdapter = {
          name: "tiny",
          displayName: "Tiny Agent",
          binary: "tiny",
          capabilities: {
            supportedTiers: ["fast"],
            maxContextTokens: 10_000,
            features: new Set(["review"]),
          },
          async isInstalled() { return true; },
          async run() {
            return {
              success: true,
              exitCode: 0,
              output: "",
              rateLimited: false,
              durationMs: 1000,
              estimatedCost: 0.01
            };
          },
          buildCommand() { return ["tiny"]; },
        };

        const description = describeAgentCapabilities(limitedAgent);
        expect(description).toBe("tiny: tiers=[fast], maxTokens=10000, features=[review]");
      });
    });
  });
});
