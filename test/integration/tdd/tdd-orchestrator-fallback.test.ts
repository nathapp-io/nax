import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentAdapter, AgentResult } from "../../../src/agents";
import { DEFAULT_CONFIG } from "../../../src/config";
import type { UserStory } from "../../../src/prd";
import { runThreeSessionTdd } from "../../../src/tdd/orchestrator";
import { VERDICT_FILE } from "../../../src/tdd/verdict";
import { type SavedDeps, createMockAgent, mockAllSpawn, mockGitSpawn, restoreDeps, saveDeps } from "./_tdd-test-helpers";

let saved: SavedDeps;

beforeEach(() => {
  saved = saveDeps();
});

afterEach(() => {
  restoreDeps(saved);
});

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


describe("runThreeSessionTdd — zero-file fallback", () => {
  /** Extended git mock that also handles `git checkout .` */
  function mockGitSpawnWithCheckout(opts: {
    diffFiles: string[][];
    onCheckout?: () => void;
    testCommandSuccess?: boolean;
  }) {
    let revParseCount = 0;
    let diffCount = 0;
    const testSuccess = opts.testCommandSuccess ?? true;


    mockAllSpawn(mock((cmd: string[], spawnOpts?: any) => {
      // Intercept test commands
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
        opts.onCheckout?.();
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
      return { exited: Promise.resolve(0), stdout: new Response("").body, stderr: new Response("").body };
    }));
  }

  test("fallback NO LONGER triggers when strategy='auto' and 0 test files (BUG-010 removed auto-fallback)", async () => {
    let checkoutCalled = false;

    // BUG-010: Zero-file scenarios now return greenfield-no-tests immediately
    // No fallback to lite mode occurs
    mockGitSpawnWithCheckout({
      diffFiles: [
        ["requirements.md"], // s1 isolation (strict) — no source violations
        ["requirements.md"], // s1 getChangedFiles (strict) — 0 test files → return greenfield-no-tests
      ],
      onCheckout: () => {
        checkoutCalled = true;
      },
    });

    const agent = createMockAgent([
      { success: true, estimatedCostUsd: 0.01 }, // s1 strict test-writer
    ]);

    const configWithAutoStrategy = {
      ...DEFAULT_CONFIG,
      tdd: { ...DEFAULT_CONFIG.tdd, strategy: "auto" as const },
    };

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: configWithAutoStrategy,
      workdir: "/tmp/test",
      modelTier: "balanced",
    });

    expect(checkoutCalled).toBe(false); // git checkout NOT called (no fallback)
    expect(result.lite).toBe(false); // not in lite mode
    expect(result.success).toBe(false); // fails with greenfield-no-tests
    expect(result.failureCategory).toBe("greenfield-no-tests");
  });

  test("zero-file scenario returns greenfield-no-tests (BUG-010 removed lite fallback)", async () => {
    // BUG-010: No more auto-fallback to lite mode
    mockGitSpawn({
      diffFiles: [
        ["docs/plan.md"], // s1 isolation (strict)
        ["docs/plan.md"], // s1 getChangedFiles (strict) → 0 test files
      ],
    });

    const agent = createMockAgent([{ success: true, estimatedCostUsd: 0.01 }]);

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: "/tmp/test",
      modelTier: "balanced",
    });

    expect(result.lite).toBe(false);
    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("greenfield-no-tests");
  });

  test("fallback does NOT trigger when strategy='strict' (explicit strict mode)", async () => {
    // In strategy='strict', no fallback — should return failure
    mockGitSpawn({
      diffFiles: [
        ["requirements.md"], // s1 isolation — no source violations
        ["requirements.md"], // s1 getChangedFiles — 0 test files
      ],
    });

    const agent = createMockAgent([{ success: true, estimatedCostUsd: 0.01 }]);

    const configWithStrictStrategy = {
      ...DEFAULT_CONFIG,
      tdd: { ...DEFAULT_CONFIG.tdd, strategy: "strict" as const },
    };

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: configWithStrictStrategy,
      workdir: "/tmp/test",
      modelTier: "balanced",
    });

    // Should fail (no fallback in strict mode)
    expect(result.success).toBe(false);
    expect(result.needsHumanReview).toBe(true);
    expect(result.reviewReason).toBe("Test writer session created no test files (greenfield project)");
    expect(result.lite).toBe(false); // Was called in strict mode, no fallback
  });

  test("fallback does NOT trigger when already in lite mode", async () => {
    // Calling with lite=true — if 0 test files, should return failure (not recurse again)
    mockGitSpawn({
      diffFiles: [
        ["requirements.md"], // s1 getChangedFiles (lite, no isolation) — 0 test files
      ],
    });

    const agent = createMockAgent([{ success: true, estimatedCostUsd: 0.01 }]);

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: "/tmp/test",
      modelTier: "balanced",
      lite: true,
    });

    // Should fail — no further fallback from lite mode
    expect(result.success).toBe(false);
    expect(result.needsHumanReview).toBe(true);
    expect(result.reviewReason).toBe("Test writer session created no test files (greenfield project)");
    expect(result.lite).toBe(true);
  });

  test("fallback does NOT trigger when strategy='lite' config", async () => {
    // When strategy='lite', runThreeSessionTdd is called with lite=true (from execution stage)
    // So !lite = false → no fallback
    mockGitSpawn({
      diffFiles: [
        [], // s1 getChangedFiles (lite, no isolation) — 0 test files
      ],
    });

    const agent = createMockAgent([{ success: true, estimatedCostUsd: 0.01 }]);

    const configWithLiteStrategy = {
      ...DEFAULT_CONFIG,
      tdd: { ...DEFAULT_CONFIG.tdd, strategy: "lite" as const },
    };

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: configWithLiteStrategy,
      workdir: "/tmp/test",
      modelTier: "balanced",
      lite: true, // router sets this for lite strategy
    });

    expect(result.success).toBe(false);
    expect(result.lite).toBe(true);
  });
});

// ─── T4: failureCategory tests ────────────────────────────────────────────────

