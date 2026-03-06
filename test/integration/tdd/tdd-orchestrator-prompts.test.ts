import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentAdapter, AgentResult } from "../../../src/agents";
import { DEFAULT_CONFIG } from "../../../src/config";
import type { UserStory } from "../../../src/prd";
import { runThreeSessionTdd } from "../../../src/tdd/orchestrator";
import {
  buildTestWriterLitePrompt,
  buildImplementerLitePrompt,
  buildVerifierPrompt,
  buildSingleSessionPrompt,
  buildTestWriterPrompt,
  buildImplementerPrompt,
} from "../../../src/tdd/prompts";
import { VERDICT_FILE } from "../../../src/tdd/verdict";

let originalSpawn: typeof Bun.spawn;

beforeEach(() => {
  originalSpawn = Bun.spawn;
});

afterEach(() => {
  Bun.spawn = originalSpawn;
});

/** Create a mock agent that returns sequential results */
function createMockAgent(results: Partial<AgentResult>[]): AgentAdapter {
  let callCount = 0;
  return {
    name: "mock",
    displayName: "Mock Agent",
    binary: "mock",
    isInstalled: async () => true,
    buildCommand: () => ["mock"],
    run: mock(async () => {
      const r = results[callCount] || {};
      callCount++;
      return {
        success: r.success ?? true,
        exitCode: r.exitCode ?? 0,
        output: r.output ?? "",
        rateLimited: r.rateLimited ?? false,
        durationMs: r.durationMs ?? 100,
        estimatedCost: r.estimatedCost ?? 0.01,
      };
    }),
  };
}

/** Mock Bun.spawn to intercept git commands */
function mockGitSpawn(opts: {
  /** Files returned by git diff for each session (indexed by git-diff call number) */
  diffFiles: string[][];
  /** Optional: mock test command success (default: true) */
  testCommandSuccess?: boolean;
}) {
  let revParseCount = 0;
  let diffCount = 0;
  const testSuccess = opts.testCommandSuccess ?? true;

  // @ts-ignore — mocking global
  Bun.spawn = mock((cmd: string[], spawnOpts?: any) => {
    // Intercept test commands (bun test, npm test, etc.)
    if ((cmd[0] === "/bin/sh" || cmd[0] === "/bin/bash" || cmd[0] === "/bin/zsh") && cmd[1] === "-c") {
      return {
        pid: 9999,
        exited: Promise.resolve(testSuccess ? 0 : 1),
        stdout: new Response(testSuccess ? "tests pass\n" : "tests fail\n").body,
        stderr: new Response("").body,
      };
    }
    if (cmd[0] === "git" && cmd[1] === "rev-parse") {
      revParseCount++;
      return {
        exited: Promise.resolve(0),
        stdout: new Response(`ref-${revParseCount}\n`).body,
        stderr: new Response("").body,
      };
    }
    if (cmd[0] === "git" && cmd[1] === "checkout") {
      // Intercept git checkout (used in zero-file fallback) — silently succeed
      return {
        exited: Promise.resolve(0),
        stdout: new Response("").body,
        stderr: new Response("").body,
      };
    }
    if (cmd[0] === "git" && cmd[1] === "diff") {
      const files = opts.diffFiles[diffCount] || [];
      diffCount++;
      return {
        exited: Promise.resolve(0),
        stdout: new Response(files.join("\n") + "\n").body,
        stderr: new Response("").body,
      };
    }
    return originalSpawn(cmd, spawnOpts);
  });
}

const story: UserStory = {
  id: "US-001",
  title: "Add user validation",
  description: "Add validation to user input",
  acceptanceCriteria: ["Validation works", "Errors are clear"],
  dependencies: [],
  tags: [],
  status: "pending",
  passes: false,
  escalations: [],
  attempts: 0,
};


describe("buildTestWriterLitePrompt", () => {
  test("tells agent it CAN read source files", () => {
    const prompt = buildTestWriterLitePrompt(story);
    expect(prompt).toContain("MAY read source files");
  });

  test("tells agent it CAN import from source files", () => {
    const prompt = buildTestWriterLitePrompt(story);
    expect(prompt).toContain("MAY import from source files");
  });

  test("still instructs agent to only CREATE test files", () => {
    const prompt = buildTestWriterLitePrompt(story);
    expect(prompt).toMatch(/[Oo]nly\s+[Cc][Rr][Ee][Aa][Tt][Ee]\s+test files|CREATE test files/);
  });

  test("does NOT say DO NOT create or modify any source files (strict isolation rule)", () => {
    const prompt = buildTestWriterLitePrompt(story);
    expect(prompt).not.toContain("DO NOT create or modify any source files");
  });

  test("does NOT say ONLY create/modify test files (strict isolation rule)", () => {
    const prompt = buildTestWriterLitePrompt(story);
    expect(prompt).not.toContain("ONLY create/modify test files");
  });

  test("includes story title and acceptance criteria", () => {
    const prompt = buildTestWriterLitePrompt(story);
    expect(prompt).toContain(story.title);
    expect(prompt).toContain("Validation works");
    expect(prompt).toContain("Errors are clear");
  });

  test("includes context markdown when provided", () => {
    const ctx = "## Relevant Files\n- src/user.ts";
    const prompt = buildTestWriterLitePrompt(story, ctx);
    expect(prompt).toContain("## Relevant Files");
    expect(prompt).toContain("src/user.ts");
  });

  test("does not include context separator when no context provided", () => {
    const prompt = buildTestWriterLitePrompt(story);
    // Should still have content but no trailing separator
    expect(prompt).not.toMatch(/---\s*$/);
  });

  test("uses lite mode label in heading", () => {
    const prompt = buildTestWriterLitePrompt(story);
    expect(prompt.toLowerCase()).toContain("lite");
  });
});

describe("buildImplementerLitePrompt", () => {
  test("has no file restriction rules (does not say Only create or modify files in the test/ directory)", () => {
    const prompt = buildImplementerLitePrompt(story);
    expect(prompt).not.toContain("Only create or modify files in the test/ directory");
  });

  test("has no file restriction rules (does not say Implement source code in src/ to make tests pass)", () => {
    const prompt = buildImplementerLitePrompt(story);
    expect(prompt).not.toContain("Implement source code in src/ to make tests pass");
  });

  test("allows writing tests and implementing", () => {
    const prompt = buildImplementerLitePrompt(story);
    expect(prompt).toContain("Write tests AND implement");
  });

  test("includes story title and acceptance criteria", () => {
    const prompt = buildImplementerLitePrompt(story);
    expect(prompt).toContain(story.title);
    expect(prompt).toContain("Validation works");
    expect(prompt).toContain("Errors are clear");
  });

  test("includes context markdown when provided", () => {
    const ctx = "## Context\n- Use existing patterns";
    const prompt = buildImplementerLitePrompt(story, ctx);
    expect(prompt).toContain("## Context");
    expect(prompt).toContain("Use existing patterns");
  });

  test("uses lite mode label in heading", () => {
    const prompt = buildImplementerLitePrompt(story);
    expect(prompt.toLowerCase()).toContain("lite");
  });

  test("still instructs to make tests pass", () => {
    const prompt = buildImplementerLitePrompt(story);
    expect(prompt.toLowerCase()).toContain("all tests must pass");
  });
});

describe("buildVerifierPrompt (unchanged)", () => {
  test("is unchanged — still has isolation-focused verification rules", () => {
    const prompt = buildVerifierPrompt(story);
    expect(prompt).toContain("Session 3: Verify");
    expect(prompt).toContain("Check if test files were modified by the implementer");
    expect(prompt).toContain(story.title);
  });

  test("does NOT mention lite mode", () => {
    const prompt = buildVerifierPrompt(story);
    expect(prompt.toLowerCase()).not.toContain("lite");
  });

  test("still verifies acceptance criteria", () => {
    const prompt = buildVerifierPrompt(story);
    expect(prompt).toContain("Validation works");
    expect(prompt).toContain("Errors are clear");
  });
});

describe("strict vs lite prompt comparison", () => {
  test("strict test-writer has harder isolation rules than lite", () => {
    const strict = buildTestWriterPrompt(story);
    const lite = buildTestWriterLitePrompt(story);

    // Strict has hard NO rule on source files
    expect(strict).toContain("Only create or modify files in the test/ directory");
    expect(lite).not.toContain("Only create or modify files in the test/ directory");

    // Lite explicitly allows reading source files
    expect(lite).toContain("You may create minimal stubs in src/");
    expect(strict).not.toContain("You may create minimal stubs in src/");
  });

  test("strict implementer has harder isolation rules than lite", () => {
    const strict = buildImplementerPrompt(story);
    const lite = buildImplementerLitePrompt(story);

    // Strict bans test file modifications
    expect(strict).toContain("Do NOT modify test files");
    expect(lite).not.toContain("Do NOT modify test files");

    // Lite allows adjusting test files
    expect(lite).toContain("Write tests AND implement");
    expect(strict).not.toContain("Write tests AND implement");
  });
});

// ─── T4: Lite mode orchestration tests ───────────────────────────────────────

