/**
 * Unit tests for acceptance.ts — US-002 per-package runner.
 *
 * Tests the per-package acceptance runner that uses ctx.acceptanceTestPaths
 * and the backward-compatible fallback for pre-ACC-002 runs.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { acceptanceStage, parseTestFailures } from "../../../../src/pipeline/stages/acceptance";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { DEFAULT_CONFIG } from "../../../../src/config";
import { addSink, initLogger, resetLogger } from "@/logger";
import { makeStory } from "../../../helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const stories = [makeStory({ id: "US-001", status: "passed", passes: true, attempts: 0, acceptanceCriteria: ["AC-1: criterion"] })];
  return {
    config: {
      ...DEFAULT_CONFIG,
      acceptance: {
        ...DEFAULT_CONFIG.acceptance,
        enabled: true,
        testPath: "acceptance.test.ts",
      },
    } as any,
    rootConfig: DEFAULT_CONFIG,
    prd: {
      project: "test-project",
      feature: "test-feature",
      branchName: "feat/test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: stories,
    } as any,
    story: stories[0],
    stories,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    workdir: "/tmp/test-workdir",
    featureDir: "/tmp/test-workdir/.nax/features/test-feature",
    hooks: {} as any,
    ...overrides,
  };
}

afterEach(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// US-002 AC-1: per-package test files run from their package directory
// ---------------------------------------------------------------------------

describe("US-002: per-package acceptance runner", () => {
  test("AC-1: runs each test file from its package directory when acceptanceTestPaths is set", async () => {
    const spawnCalls: Array<{ cwd: string; cmd: string[] }> = [];

    // Patch Bun.spawn for this test
    const origSpawn = Bun.spawn;
    (Bun as any).spawn = (cmd: string[], opts: any) => {
      spawnCalls.push({ cwd: opts.cwd, cmd });
      const mockProc = {
        exited: Promise.resolve(0),
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("1 pass\n"));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      };
      return mockProc;
    };

    const ctx = makeCtx({
      acceptanceTestPaths: [
        { testPath: "/tmp/test-workdir/apps/api/.nax-acceptance.test.ts", packageDir: "/tmp/test-workdir/apps/api" },
        { testPath: "/tmp/test-workdir/apps/cli/.nax-acceptance.test.ts", packageDir: "/tmp/test-workdir/apps/cli" },
      ],
    });

    // Mock Bun.file().exists() to return true for test files
    const origFile = Bun.file;
    (Bun as any).file = (p: string) => ({
      exists: () => Promise.resolve(true),
      text: () => Promise.resolve(""),
    });

    try {
      await acceptanceStage.execute(ctx);
      expect(spawnCalls.some((c) => c.cwd === "/tmp/test-workdir/apps/api")).toBe(true);
      expect(spawnCalls.some((c) => c.cwd === "/tmp/test-workdir/apps/cli")).toBe(true);
    } finally {
      (Bun as any).spawn = origSpawn;
      (Bun as any).file = origFile;
    }
  });

  test("AC-3: falls back to single-file behavior when acceptanceTestPaths is not set", async () => {
    // When acceptanceTestPaths is absent, should use featureDir + testPath from config
    const ctx = makeCtx(); // no acceptanceTestPaths
    // US-003: the synthesized fallback group has storyCount derived from the PRD
    // (1 story at the repo root) and acceptanceEnabled defaults to true, so a
    // missing test file is now a hard fail — the pre-ACC-002 "skip missing" path
    // was the bug this story closes. The fallback path itself is still reached
    // (verified by the resulting action = "fail" with the synthesized testPath).
    const result = await acceptanceStage.execute(ctx);
    expect(result.action).toBe("fail");
    if (result.action === "fail") {
      expect(result.reason).toContain("/tmp/test-workdir");
    }
  });

  test("AC-4: all packages passing returns continue", async () => {
    const origSpawn = Bun.spawn;
    (Bun as any).spawn = (_cmd: string[], _opts: any) => ({
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("1 pass\n"));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    });

    const origFile = Bun.file;
    (Bun as any).file = (_p: string) => ({
      exists: () => Promise.resolve(true),
      text: () => Promise.resolve(""),
    });

    const ctx = makeCtx({
      acceptanceTestPaths: [
        { testPath: "/tmp/apps/api/.nax-acceptance.test.ts", packageDir: "/tmp/apps/api" },
        { testPath: "/tmp/apps/cli/.nax-acceptance.test.ts", packageDir: "/tmp/apps/cli" },
      ],
    });

    try {
      const result = await acceptanceStage.execute(ctx);
      expect(result.action).toBe("continue");
    } finally {
      (Bun as any).spawn = origSpawn;
      (Bun as any).file = origFile;
    }
  });

  test("AC-5: per-package testFramework is used when building run command", async () => {
    const spawnCalls: Array<{ cmd: string[]; cwd: string }> = [];

    const origSpawn = Bun.spawn;
    (Bun as any).spawn = (cmd: string[], opts: any) => {
      spawnCalls.push({ cmd, cwd: opts.cwd });
      return {
        exited: Promise.resolve(0),
        stdout: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("1 pass\n")); c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
      };
    };

    const origFile = Bun.file;
    (Bun as any).file = (_p: string) => ({
      exists: () => Promise.resolve(true),
      text: () => Promise.resolve(""),
    });

    // apps/api has jest, apps/web has bun (undefined = default)
    const ctx = makeCtx({
      acceptanceTestPaths: [
        {
          testPath: "/tmp/test-workdir/apps/api/.nax-acceptance.test.ts",
          packageDir: "/tmp/test-workdir/apps/api",
          testFramework: "jest",
          commandOverride: undefined,
        },
        {
          testPath: "/tmp/test-workdir/apps/web/.nax-acceptance.test.ts",
          packageDir: "/tmp/test-workdir/apps/web",
          testFramework: undefined,
          commandOverride: undefined,
        },
      ],
    });

    try {
      await acceptanceStage.execute(ctx);

      const apiCall = spawnCalls.find((c) => c.cwd === "/tmp/test-workdir/apps/api");
      const webCall = spawnCalls.find((c) => c.cwd === "/tmp/test-workdir/apps/web");

      // apps/api should use npx jest
      expect(apiCall?.cmd[0]).toBe("npx");
      expect(apiCall?.cmd[1]).toBe("jest");

      // apps/web should fall back to bun test (no testFramework)
      expect(webCall?.cmd[0]).toBe("bun");
      expect(webCall?.cmd[1]).toBe("test");
    } finally {
      (Bun as any).spawn = origSpawn;
      (Bun as any).file = origFile;
    }
  });

  test("records failed package metadata in acceptanceFailures for downstream fix routing", async () => {
    const origSpawn = Bun.spawn;
    (Bun as any).spawn = (cmd: string[], opts: any) => {
      const isApi = opts.cwd === "/tmp/test-workdir/apps/api";
      const output = isApi ? "FAIL AC-2" : "1 pass\n";
      const exitCode = isApi ? 1 : 0;
      return {
        exited: Promise.resolve(exitCode),
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(output));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      };
    };

    const origFile = Bun.file;
    (Bun as any).file = (_p: string) => ({
      exists: () => Promise.resolve(true),
      text: () => Promise.resolve(""),
    });

    const ctx = makeCtx({
      acceptanceTestPaths: [
        {
          testPath: "/tmp/test-workdir/apps/api/.nax-acceptance.test.ts",
          packageDir: "/tmp/test-workdir/apps/api",
          testFramework: "jest",
          commandOverride: "npx jest --config jest.nax.config.js {{FILE}}",
        },
        {
          testPath: "/tmp/test-workdir/apps/web/.nax-acceptance.test.ts",
          packageDir: "/tmp/test-workdir/apps/web",
          testFramework: "vitest",
          commandOverride: "pnpm vitest run {{FILE}}",
        },
      ],
    });

    try {
      const result = await acceptanceStage.execute(ctx);
      expect(result.action).toBe("fail");
      expect(ctx.acceptanceFailures?.failedPackages).toEqual([
        {
          testPath: "/tmp/test-workdir/apps/api/.nax-acceptance.test.ts",
          packageDir: "/tmp/test-workdir/apps/api",
          testFramework: "jest",
          commandOverride: "npx jest --config jest.nax.config.js {{FILE}}",
          output: expect.stringContaining("AC-2"),
          failedACs: ["AC-2"],
        },
      ]);
    } finally {
      (Bun as any).spawn = origSpawn;
      (Bun as any).file = origFile;
    }
  });

  test("records per-package output and failedACs on each failed package entry", async () => {
    const origSpawn = Bun.spawn;
    (Bun as any).spawn = (_cmd: string[], opts: any) => {
      const isApi = opts.cwd === "/tmp/test-workdir/apps/api";
      const output = isApi ? "FAIL AC-1 api boom\n" : "FAIL AC-2 web boom\n";
      return {
        exited: Promise.resolve(1),
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(output));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      };
    };

    const origFile = Bun.file;
    (Bun as any).file = (_p: string) => ({
      exists: () => Promise.resolve(true),
      text: () => Promise.resolve(""),
    });

    const ctx = makeCtx({
      acceptanceTestPaths: [
        {
          testPath: "/tmp/test-workdir/apps/api/.nax-acceptance.test.ts",
          packageDir: "/tmp/test-workdir/apps/api",
          testFramework: "jest",
          commandOverride: "npx jest {{FILE}}",
        },
        {
          testPath: "/tmp/test-workdir/apps/web/.nax-acceptance.test.ts",
          packageDir: "/tmp/test-workdir/apps/web",
          testFramework: "vitest",
          commandOverride: "pnpm vitest run {{FILE}}",
        },
      ],
    });

    try {
      const result = await acceptanceStage.execute(ctx);
      expect(result.action).toBe("fail");
      const pkgs = ctx.acceptanceFailures?.failedPackages ?? [];
      const api = pkgs.find((p) => p.packageDir === "/tmp/test-workdir/apps/api");
      const web = pkgs.find((p) => p.packageDir === "/tmp/test-workdir/apps/web");
      expect(api?.output).toContain("api");
      expect(web?.output).toContain("web");
      expect(api?.failedACs).toEqual(["AC-1"]);
      expect(web?.failedACs).toEqual(["AC-2"]);
      expect(ctx.acceptanceFailures?.failedACs).toEqual(["AC-1", "AC-2"]);
    } finally {
      (Bun as any).spawn = origSpawn;
      (Bun as any).file = origFile;
    }
  });
});

// ---------------------------------------------------------------------------
// Stage interface: enabled()
// ---------------------------------------------------------------------------

describe("acceptanceStage.enabled()", () => {
  test("enabled when acceptance is on and all stories complete", () => {
    const ctx = makeCtx();
    expect(acceptanceStage.enabled(ctx)).toBe(true);
  });

  test("disabled when not all stories complete", () => {
    const stories = [makeStory({ id: "US-001", status: "pending", passes: false, attempts: 0, acceptanceCriteria: ["AC-1: criterion"] })];
    const ctx = makeCtx({
      prd: {
        project: "test",
        feature: "test",
        branchName: "feat/test",
        createdAt: "",
        updatedAt: "",
        userStories: stories,
      } as any,
      story: stories[0],
      stories,
    });
    expect(acceptanceStage.enabled(ctx)).toBe(false);
  });

  test("disabled when acceptance.enabled is false", () => {
    const ctx = makeCtx({
      config: {
        ...DEFAULT_CONFIG,
        acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: false },
      } as any,
    });
    expect(acceptanceStage.enabled(ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseTestFailures — multi-framework failure marker support (#336 gap 2)
// ---------------------------------------------------------------------------

describe("parseTestFailures()", () => {
  test("Bun/Jest: extracts AC IDs from (fail) lines", () => {
    const output = [
      "  ✓ AC-1: TTL expiry",
      "  (fail) AC-2: handles empty input",
      "  ✓ AC-3: validates format",
      "  (fail) AC-4: rejects null",
    ].join("\n");

    expect(parseTestFailures(output)).toEqual(["AC-2", "AC-4"]);
  });

  test("Go: extracts AC IDs from --- FAIL: lines", () => {
    const output = [
      "--- PASS: TestAC1TTLExpiry (0.00s)",
      "--- FAIL: TestAC-2_handles_empty (0.01s)",
      "--- PASS: TestAC3ValidatesFormat (0.00s)",
      "--- FAIL: TestAC_4_rejects_null (0.00s)",
    ].join("\n");

    expect(parseTestFailures(output)).toEqual(["AC-2", "AC-4"]);
  });

  test("pytest: extracts AC IDs from FAILED lines", () => {
    const output = [
      "tests/test_feature.py::test_AC_1_ttl_expiry PASSED",
      "FAILED tests/test_feature.py::test_AC_2_empty_input - AssertionError",
      "tests/test_feature.py::test_AC_3_validates PASSED",
      "FAILED tests/test_feature.py::test_AC_4_null",
    ].join("\n");

    expect(parseTestFailures(output)).toEqual(["AC-2", "AC-4"]);
  });

  test("deduplicates AC IDs across multiple matching lines", () => {
    const output = [
      "  (fail) AC-1: first failure",
      "--- FAIL: TestAC_1_something (0.00s)",
      "FAILED tests::test_AC_1_other",
    ].join("\n");

    expect(parseTestFailures(output)).toEqual(["AC-1"]);
  });

  test("returns empty array when no failures", () => {
    const output = [
      "  ✓ AC-1: passes",
      "--- PASS: TestAC1Something (0.00s)",
      "tests::test_AC_1_thing PASSED",
    ].join("\n");

    expect(parseTestFailures(output)).toEqual([]);
  });

  test("vitest default reporter: extracts AC IDs from FAIL block headers", () => {
    const output = [
      " ❯ .nax/features/x/.nax-acceptance.test.tsx (5 tests | 2 failed) 120ms",
      "",
      "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯",
      "",
      " FAIL  .nax/features/x/.nax-acceptance.test.tsx > Watchlist > AC-9: updates the watchlist",
      'AssertionError: expected undefined to be "w1"',
      " ❯ .nax/features/x/.nax-acceptance.test.tsx:649:26",
      "",
      " FAIL  .nax/features/x/.nax-acceptance.test.tsx > AC-12: removes a ticker",
      "AssertionError: expected 2 to be 1",
      "",
      " Test Files  1 failed (1)",
      "      Tests  2 failed | 3 passed (5)",
    ].join("\n");

    expect(parseTestFailures(output)).toEqual(["AC-9", "AC-12"]);
  });

  test("vitest: extracts AC IDs from ANSI-colored FAIL headers", () => {
    const esc = String.fromCharCode(27); // ANSI escape (vitest colorizes the FAIL marker)
    const output = [
      " Test Files  1 failed (1)",
      `${esc}[31m${esc}[7m FAIL ${esc}[27m${esc}[39m .nax/x.test.tsx > ${esc}[1mAC-3: does the thing${esc}[22m`,
    ].join("\n");

    expect(parseTestFailures(output)).toEqual(["AC-3"]);
  });

  test("vitest: does NOT match a passing test whose title contains the word FAIL", () => {
    const output = [
      " Test Files  1 passed (1)",
      "   ✓ AC-7: handles FAIL responses gracefully 5ms",
    ].join("\n");

    expect(parseTestFailures(output)).toEqual([]);
  });

  test("vitest: strips leading erase-line codes before the FAIL anchor", () => {
    const esc = String.fromCharCode(27);
    const output = [
      " Test Files  1 failed (1)",
      `${esc}[2K${esc}[1G FAIL  .nax/x.test.tsx > AC-4: still detected`,
    ].join("\n");

    expect(parseTestFailures(output)).toEqual(["AC-4"]);
  });

  test("pytest FAILED lines are not double-handled by the vitest FAIL branch (unknown framework)", () => {
    // No framework summary line → detector returns "unknown" → all branches run.
    const output = "FAILED tests/test_feature.py::test_AC_2_empty_input - AssertionError";

    expect(parseTestFailures(output)).toEqual(["AC-2"]);
  });
});

// ---------------------------------------------------------------------------
// Acceptance verdict logger emit
// ---------------------------------------------------------------------------

describe("acceptance verdict logger emit", () => {
  const TEST_PATHS = [
    { testPath: "/tmp/test-workdir/apps/api/.nax-acceptance.test.ts", packageDir: "/tmp/test-workdir/apps/api" },
  ];

  let origSpawn: typeof Bun.spawn;
  let origFile: typeof Bun.file;
  let unsubscribe: (() => void) | null = null;
  let verdicts: Array<Record<string, unknown>> = [];

  /** Capture every `acceptance`/`verdict` payload the stage emits. */
  function captureVerdicts(): void {
    resetLogger();
    initLogger({ level: "info", headless: true, useChalk: false });
    unsubscribe = addSink((entry) => {
      if (entry.stage === "acceptance" && entry.message === "verdict") {
        verdicts.push((entry.data ?? {}) as Record<string, unknown>);
      }
    });
  }

  /** Stub the test command to pass (exit 0) or fail on AC-2 (exit 1). */
  function stubRun(pass: boolean): void {
    origSpawn = Bun.spawn;
    origFile = Bun.file;
    const out = pass ? "1 pass\n" : "  (fail) AC-2: handles empty input\n";
    (Bun as any).spawn = (_cmd: string[], _opts: any) => ({
      exited: Promise.resolve(pass ? 0 : 1),
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(out));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    });
    (Bun as any).file = (_p: string) => ({
      exists: () => Promise.resolve(true),
      text: () => Promise.resolve(""),
    });
  }

  beforeEach(() => {
    verdicts = [];
    captureVerdicts();
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    resetLogger();
    if (origSpawn) (Bun as any).spawn = origSpawn;
    if (origFile) (Bun as any).file = origFile;
  });

  test("AC-1: pass verdict carries passed:true and no failed ACs", async () => {
    stubRun(true);
    const result = await acceptanceStage.execute(makeCtx({ acceptanceTestPaths: TEST_PATHS }));

    expect(result.action).toBe("continue");
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ passed: true, failedACs: [], storyId: "US-001" });
  });

  test("AC-2: fail verdict carries passed:false and the failed AC", async () => {
    stubRun(false);
    const result = await acceptanceStage.execute(makeCtx({ acceptanceTestPaths: TEST_PATHS }));

    expect(result.action).toBe("fail");
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ passed: false, failedACs: ["AC-2"] });
  });

  test("AC-3: verdict's packageDir is the run workdir", async () => {
    stubRun(true);
    await acceptanceStage.execute(makeCtx({ acceptanceTestPaths: TEST_PATHS }));

    // One verdict covers every package group in the run, so the field carries the
    // repo root rather than any single group's directory. Pinned to stop the name
    // being read as per-package attribution (the misreading behind #1424).
    // (`packageDir` is not a PipelineContext field — the prior version of this
    // test passed one via makeCtx and asserted on its own input.)
    expect(verdicts[0]?.packageDir).toBe("/tmp/test-workdir");
  });

  // ── #1424: `retries` reported the hardening promotion count, not retries ────

  test("#1424: retries reflects ctx.acceptanceRetries, not the hardening count", async () => {
    stubRun(true);
    await acceptanceStage.execute(makeCtx({ acceptanceRetries: 2, acceptanceTestPaths: TEST_PATHS }));

    expect(verdicts[0]?.retries).toBe(2);
  });

  test("#1424: retries defaults to 0 when the loop supplied no attempt index", async () => {
    stubRun(true);
    await acceptanceStage.execute(makeCtx({ acceptanceTestPaths: TEST_PATHS }));

    expect(verdicts[0]?.retries).toBe(0);
  });

  test("#1424: the fail path reports its retry index (previously always 0)", async () => {
    stubRun(false);
    await acceptanceStage.execute(makeCtx({ acceptanceRetries: 1, acceptanceTestPaths: TEST_PATHS }));

    expect(verdicts[0]).toMatchObject({ passed: false, retries: 1 });
  });

  test("#1424: hardening promotions are reported under their own key", async () => {
    stubRun(true);
    await acceptanceStage.execute(makeCtx({ acceptanceTestPaths: TEST_PATHS }));

    // No suggestedCriteria on the fixture story, so the hardening pass cannot run.
    expect(verdicts[0]?.hardeningPromoted).toBe(0);
    expect(verdicts[0]?.retries).toBe(0);
  });
});
