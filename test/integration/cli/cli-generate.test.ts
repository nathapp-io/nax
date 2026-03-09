/**
 * Generate Command Integration Tests
 *
 * Tests for `nax generate` command with support for new context generators.
 * Verifies AgentType union includes new agents and generators work correctly.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCommand } from "../../../src/cli/generate";
import type { AgentType } from "../../../src/context/types";
import { generateFor, generateAll } from "../../../src/context/generator";
import { loadConfig } from "../../../src/config/loader";

describe("nax generate command", () => {
  let tempDir: string;
  let originalCwd: string;
  let consoleOutput: string[];
  let consoleErrors: string[];
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    // Create temp directory
    tempDir = mkdtempSync(join(tmpdir(), "nax-generate-test-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);

    // Create nax directory with context.md
    mkdirSync(join(tempDir, "nax"), { recursive: true });
    writeFileSync(
      join(tempDir, "nax/context.md"),
      `# Project Context

## Architecture
- Multi-agent system
- TypeScript + Bun

## Requirements
- 80% test coverage
- TDD methodology
`,
    );

    // Capture console output
    consoleOutput = [];
    consoleErrors = [];
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.map((a) => String(a)).join(" "));
    };
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map((a) => String(a)).join(" "));
    };
  });

  afterEach(() => {
    // Restore console
    console.log = originalConsoleLog;
    console.error = originalConsoleError;

    // Cleanup
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("AgentType union type", () => {
    test("AgentType includes 'codex'", () => {
      const validAgents: AgentType[] = ["codex"];
      expect(validAgents[0]).toBe("codex");
    });

    test("AgentType includes 'opencode'", () => {
      const validAgents: AgentType[] = ["opencode"];
      expect(validAgents[0]).toBe("opencode");
    });

    test("AgentType includes 'gemini'", () => {
      const validAgents: AgentType[] = ["gemini"];
      expect(validAgents[0]).toBe("gemini");
    });

    test("AgentType includes 'aider'", () => {
      const validAgents: AgentType[] = ["aider"];
      expect(validAgents[0]).toBe("aider");
    });

    test("AgentType includes 'claude'", () => {
      const validAgents: AgentType[] = ["claude"];
      expect(validAgents[0]).toBe("claude");
    });

    test("AgentType supports all required agents", () => {
      const requiredAgents: AgentType[] = ["claude", "codex", "opencode", "cursor", "windsurf", "aider", "gemini"];
      expect(requiredAgents.length).toBe(7);
      expect(requiredAgents).toContain("codex");
      expect(requiredAgents).toContain("opencode");
      expect(requiredAgents).toContain("gemini");
      expect(requiredAgents).toContain("aider");
    });
  });

  describe("Generate command with agent option", () => {
    test("generates claude config successfully", async () => {
      await generateCommand({
        context: "nax/context.md",
        output: tempDir,
        agent: "claude",
        dryRun: false,
      });

      const outputLines = consoleOutput.join("\n");
      expect(outputLines).toContain("claude");
      expect(outputLines).toContain("CLAUDE.md");
    });

    test("generates codex config successfully", async () => {
      await generateCommand({
        context: "nax/context.md",
        output: tempDir,
        agent: "codex",
        dryRun: false,
      });

      const outputLines = consoleOutput.join("\n");
      expect(outputLines).toContain("codex");
      expect(outputLines).toContain("codex.md");
    });

    test("generates opencode config successfully", async () => {
      await generateCommand({
        context: "nax/context.md",
        output: tempDir,
        agent: "opencode",
        dryRun: false,
      });

      const outputLines = consoleOutput.join("\n");
      expect(outputLines).toContain("opencode");
      expect(outputLines).toContain("AGENTS.md");
    });

    test("generates gemini config successfully", async () => {
      await generateCommand({
        context: "nax/context.md",
        output: tempDir,
        agent: "gemini",
        dryRun: false,
      });

      const outputLines = consoleOutput.join("\n");
      expect(outputLines).toContain("gemini");
      expect(outputLines).toContain("GEMINI.md");
    });

    test("generates aider config successfully", async () => {
      await generateCommand({
        context: "nax/context.md",
        output: tempDir,
        agent: "aider",
        dryRun: false,
      });

      const outputLines = consoleOutput.join("\n");
      expect(outputLines).toContain("aider");
      expect(outputLines).toContain(".aider.conf.yml");
    });
  });

  describe("Generate all agents", () => {
    test("generates all agent configs when no specific agent specified", async () => {
      await generateCommand({
        context: "nax/context.md",
        output: tempDir,
        dryRun: false,
      });

      const outputLines = consoleOutput.join("\n");
      expect(outputLines).toContain("claude");
      expect(outputLines).toContain("codex");
      expect(outputLines).toContain("opencode");
      expect(outputLines).toContain("aider");
      expect(outputLines).toContain("gemini");
    });

    test("includes cursor and windsurf in comprehensive generation", async () => {
      await generateCommand({
        context: "nax/context.md",
        output: tempDir,
        dryRun: false,
      });

      const outputLines = consoleOutput.join("\n");
      expect(outputLines).toContain("cursor");
      expect(outputLines).toContain("windsurf");
    });
  });

  describe("Existing generators still work", () => {
    test("Claude generator produces valid output", async () => {
      const config = await loadConfig(tempDir);
      const result = await generateFor("claude", {
        contextPath: join(tempDir, "nax/context.md"),
        outputDir: tempDir,
        workdir: tempDir,
        dryRun: false,
      }, config);

      expect(result.agent).toBe("claude");
      expect(result.error).toBeUndefined();
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.outputFile).toBe("CLAUDE.md");
    });

    test("Aider generator produces valid output", async () => {
      const config = await loadConfig(tempDir);
      const result = await generateFor("aider", {
        contextPath: join(tempDir, "nax/context.md"),
        outputDir: tempDir,
        workdir: tempDir,
        dryRun: false,
      }, config);

      expect(result.agent).toBe("aider");
      expect(result.error).toBeUndefined();
      expect(result.content.length).toBeGreaterThan(0);
    });

    test("All generators produce output", async () => {
      const config = await loadConfig(tempDir);
      const results = await generateAll({
        contextPath: join(tempDir, "nax/context.md"),
        outputDir: tempDir,
        workdir: tempDir,
        dryRun: false,
      }, config);

      expect(results.length).toBeGreaterThan(0);

      // Verify each result has expected fields
      for (const result of results) {
        expect(result.agent).toBeDefined();
        expect(result.outputFile).toBeDefined();
        expect(result.content.length).toBeGreaterThan(0);
        expect(result.error).toBeUndefined();
      }
    });
  });

  describe("New generators included in manifest", () => {
    test("codex generator is available", async () => {
      const config = await loadConfig(tempDir);
      const result = await generateFor("codex", {
        contextPath: join(tempDir, "nax/context.md"),
        outputDir: tempDir,
        workdir: tempDir,
        dryRun: false,
      }, config);

      expect(result.agent).toBe("codex");
      expect(result.error).toBeUndefined();
      expect(result.outputFile).toBe("codex.md");
    });

    test("opencode generator is available", async () => {
      const config = await loadConfig(tempDir);
      const result = await generateFor("opencode", {
        contextPath: join(tempDir, "nax/context.md"),
        outputDir: tempDir,
        workdir: tempDir,
        dryRun: false,
      }, config);

      expect(result.agent).toBe("opencode");
      expect(result.error).toBeUndefined();
      expect(result.outputFile).toBe("AGENTS.md");
    });

    test("gemini generator is available", async () => {
      const config = await loadConfig(tempDir);
      const result = await generateFor("gemini", {
        contextPath: join(tempDir, "nax/context.md"),
        outputDir: tempDir,
        workdir: tempDir,
        dryRun: false,
      }, config);

      expect(result.agent).toBe("gemini");
      expect(result.error).toBeUndefined();
      expect(result.outputFile).toBe("GEMINI.md");
    });
  });

  describe("Invalid agent handling", () => {
    test("rejects unknown agent types", async () => {
      let exitCode = 0;
      const originalExit = process.exit;
      process.exit = ((code?: number) => {
        exitCode = code ?? 1;
      }) as never;

      try {
        await generateCommand({
          context: "nax/context.md",
          output: tempDir,
          agent: "unknown",
          dryRun: false,
        });
      } finally {
        process.exit = originalExit;
      }

      expect(exitCode).toBe(1);
      const errorLines = consoleErrors.join("\n");
      expect(errorLines).toContain("Unknown agent");
    });
  });

  describe("Dry run mode", () => {
    test("dry run does not write files for new agents", async () => {
      await generateCommand({
        context: "nax/context.md",
        output: tempDir,
        agent: "codex",
        dryRun: true,
      });

      const outputLines = consoleOutput.join("\n");
      expect(outputLines).toContain("Dry run");
      expect(outputLines).toContain("codex");
    });
  });
});
