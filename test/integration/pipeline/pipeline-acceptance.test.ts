// RE-ARCH: keep
/**
 * Tests for acceptance pipeline stage
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import type { NaxConfig } from "../../../src/config/schema";
import { DEFAULT_CONFIG } from "../../../src/config/schema";
import { initLogger, resetLogger } from "../../../src/logger";
import { acceptanceStage } from "../../../src/pipeline/stages/acceptance";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { PRD } from "../../../src/prd/types";

const testDir = `/tmp/nax-acceptance-test-${Date.now()}`;
const featureDir = path.join(testDir, ".nax/features/test-feature");

beforeEach(async () => {
  // Initialize logger for tests
  initLogger({ level: "error", useChalk: false });
  // Create test directory structure
  await fs.mkdir(featureDir, { recursive: true });
});

afterEach(async () => {
  // Clean up test directory
  await fs.rm(testDir, { recursive: true, force: true });
  // Reset logger
  resetLogger();
});

function createTestContext(prd: PRD, config: Partial<NaxConfig> = {}): PipelineContext {
  return {
    config: {
      ...DEFAULT_CONFIG,
      ...config,
    } as NaxConfig,
    prd,
    story: prd.userStories[0],
    stories: [prd.userStories[0]],
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "test",
    },
    workdir: testDir,
    featureDir,
    hooks: { hooks: {} },
  };
}

function createTestPRD(stories: Array<{ id: string; status: string }>): PRD {
  return {
    project: "test",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories.map((s) => ({
      id: s.id,
      title: `Story ${s.id}`,
      description: "Test story",
      acceptanceCriteria: [],
      tags: [],
      dependencies: [],
      status: s.status as any,
      passes: s.status === "passed",
      escalations: [],
      attempts: 0,
    })),
  };
}

describe("acceptanceStage.enabled", () => {
  test("disabled when acceptance validation is disabled in config", () => {
    const prd = createTestPRD([{ id: "US-001", status: "passed" }]);
    const ctx = createTestContext(prd, {
      acceptance: {
        enabled: false,
        maxRetries: 2,
        generateTests: true,
        testPath: "acceptance.test.ts",
      },
    });

    expect(acceptanceStage.enabled(ctx)).toBe(false);
  });

  test("disabled when stories are still pending", () => {
    const prd = createTestPRD([
      { id: "US-001", status: "passed" },
      { id: "US-002", status: "pending" },
    ]);
    const ctx = createTestContext(prd);

    expect(acceptanceStage.enabled(ctx)).toBe(false);
  });

  test("disabled when stories are in-progress", () => {
    const prd = createTestPRD([
      { id: "US-001", status: "passed" },
      { id: "US-002", status: "in-progress" },
    ]);
    const ctx = createTestContext(prd);

    expect(acceptanceStage.enabled(ctx)).toBe(false);
  });

  test("enabled when all stories are complete (passed/failed/skipped)", () => {
    const prd = createTestPRD([
      { id: "US-001", status: "passed" },
      { id: "US-002", status: "failed" },
      { id: "US-003", status: "skipped" },
    ]);
    const ctx = createTestContext(prd);

    expect(acceptanceStage.enabled(ctx)).toBe(true);
  });

  test("enabled when all stories passed", () => {
    const prd = createTestPRD([
      { id: "US-001", status: "passed" },
      { id: "US-002", status: "passed" },
    ]);
    const ctx = createTestContext(prd);

    expect(acceptanceStage.enabled(ctx)).toBe(true);
  });
});

describe("acceptanceStage.execute", () => {
  test("continues when acceptance tests pass", async () => {
    const prd = createTestPRD([{ id: "US-001", status: "passed" }]);
    const ctx = createTestContext(prd);

    // Create passing acceptance test
    const testPath = path.join(featureDir, ".nax-acceptance.test.ts");
    await Bun.write(
      testPath,
      `
import { describe, test, expect } from "bun:test";

describe("test-feature - Acceptance Tests", () => {
  test("AC-1: feature works", () => {
    expect(true).toBe(true);
  });
});
`,
    );

    const result = await acceptanceStage.execute(ctx);

    expect(result.action).toBe("continue");
  });

  test("fails when acceptance tests fail", async () => {
    const prd = createTestPRD([{ id: "US-001", status: "passed" }]);
    const ctx = createTestContext(prd);

    // Create failing acceptance test
    const testPath = path.join(featureDir, ".nax-acceptance.test.ts");
    await Bun.write(
      testPath,
      `
import { describe, test, expect } from "bun:test";

describe("test-feature - Acceptance Tests", () => {
  test("AC-1: feature works", () => {
    expect(true).toBe(false);
  });
});
`,
    );

    const result = await acceptanceStage.execute(ctx);

    expect(result.action).toBe("fail");
    if (result.action === "fail") {
      expect(result.reason).toContain("AC-1");
    }
  });

  test("continues when test file does not exist", async () => {
    const prd = createTestPRD([{ id: "US-001", status: "passed" }]);
    const ctx = createTestContext(prd);

    const result = await acceptanceStage.execute(ctx);

    expect(result.action).toBe("continue");
  });

  test("continues when no feature directory", async () => {
    const prd = createTestPRD([{ id: "US-001", status: "passed" }]);
    const ctx = createTestContext(prd);
    ctx.featureDir = undefined;

    const result = await acceptanceStage.execute(ctx);

    expect(result.action).toBe("continue");
  });

  test("skips overridden ACs", async () => {
    const prd = createTestPRD([{ id: "US-001", status: "passed" }]);
    prd.acceptanceOverrides = {
      "AC-1": "intentional: lazy expiry instead of exact timing",
    };
    const ctx = createTestContext(prd);

    // Create failing acceptance test for AC-1
    const testPath = path.join(featureDir, ".nax-acceptance.test.ts");
    await Bun.write(
      testPath,
      `
import { describe, test, expect } from "bun:test";

describe("test-feature - Acceptance Tests", () => {
  test("AC-1: feature works", () => {
    expect(true).toBe(false); // This will fail
  });
});
`,
    );

    const result = await acceptanceStage.execute(ctx);

    // Should continue because AC-1 is overridden
    expect(result.action).toBe("continue");
  });

  test("fails only on non-overridden ACs", async () => {
    const prd = createTestPRD([{ id: "US-001", status: "passed" }]);
    prd.acceptanceOverrides = {
      "AC-1": "intentional override",
    };
    const ctx = createTestContext(prd);

    // Create tests: AC-1 and AC-2 fail, but AC-1 is overridden
    const testPath = path.join(featureDir, ".nax-acceptance.test.ts");
    await Bun.write(
      testPath,
      `
import { describe, test, expect } from "bun:test";

describe("test-feature - Acceptance Tests", () => {
  test("AC-1: overridden feature", () => {
    expect(true).toBe(false);
  });

  test("AC-2: not overridden", () => {
    expect(true).toBe(false);
  });
});
`,
    );

    const result = await acceptanceStage.execute(ctx);

    expect(result.action).toBe("fail");
    if (result.action === "fail") {
      expect(result.reason).toContain("AC-2");
      expect(result.reason).not.toContain("AC-1");
    }
  });

  test("reports multiple failed ACs", async () => {
    const prd = createTestPRD([{ id: "US-001", status: "passed" }]);
    const ctx = createTestContext(prd);

    // Create multiple failing tests
    const testPath = path.join(featureDir, ".nax-acceptance.test.ts");
    await Bun.write(
      testPath,
      `
import { describe, test, expect } from "bun:test";

describe("test-feature - Acceptance Tests", () => {
  test("AC-1: first feature", () => {
    expect(true).toBe(false);
  });

  test("AC-2: second feature", () => {
    expect(true).toBe(false);
  });

  test("AC-3: third feature", () => {
    expect(true).toBe(false);
  });
});
`,
    );

    const result = await acceptanceStage.execute(ctx);

    expect(result.action).toBe("fail");
    if (result.action === "fail") {
      expect(result.reason).toContain("AC-1");
      expect(result.reason).toContain("AC-2");
      expect(result.reason).toContain("AC-3");
    }
  });

  test("fails when test file has syntax error (exit != 0, no AC failures parsed)", async () => {
    const prd = createTestPRD([{ id: "US-001", status: "passed" }]);
    const ctx = createTestContext(prd);

    // Create a test file with a syntax error — bun exits non-zero but no (fail) AC-N lines
    const testPath = path.join(featureDir, ".nax-acceptance.test.ts");
    await Bun.write(
      testPath,
      `
import { describe, test, expect } from "bun:test";

describe("broken", () => {
  test("AC-1: should work", () => {
# This is invalid TypeScript — causes syntax error
    expect(true).toBe(true);
  });
});
`,
    );

    const result = await acceptanceStage.execute(ctx);

    // Must fail — syntax errors are not a pass
    expect(result.action).toBe("fail");
    if (result.action === "fail") {
      expect(result.reason).toContain("errored");
    }

    // Should populate acceptanceFailures for fix generation
    expect(ctx.acceptanceFailures).toBeDefined();
    expect(ctx.acceptanceFailures!.failedACs).toContain("AC-ERROR");
  });
});

// BUG-083: Acceptance test scoping — runs only acceptance.test.ts, not full project suite
describe("BUG-083: acceptance command scoping", () => {
  test("AC-1: runs bun test <acceptance-file> --timeout=60000 by default (not quality.commands.test)", async () => {
    const prd = createTestPRD([{ id: "US-001", status: "passed" }]);
    const ctx = createTestContext(prd, {
      quality: {
        ...DEFAULT_CONFIG.quality,
        commands: { test: "echo 'full-suite-ran'" }, // This must NOT be used
      },
    });

    const testPath = path.join(featureDir, ".nax-acceptance.test.ts");
    await Bun.write(
      testPath,
      `import { describe, test, expect } from "bun:test";
describe("test-feature", () => {
  test("AC-1: passes", () => { expect(true).toBe(true); });
});`,
    );

    const result = await acceptanceStage.execute(ctx);

    // Must pass (the acceptance test itself passes)
    expect(result.action).toBe("continue");
    // ctx.acceptanceFailures must not be set (no failures)
    expect(ctx.acceptanceFailures).toBeUndefined();
  });

  test("AC-3: acceptance.command with {{FILE}} is substituted and executed", async () => {
    const prd = createTestPRD([{ id: "US-001", status: "passed" }]);
    const ctx = createTestContext(prd, {
      acceptance: {
        ...DEFAULT_CONFIG.acceptance,
        command: "bun test {{FILE}} --timeout=60000",
      },
    });

    const testPath = path.join(featureDir, ".nax-acceptance.test.ts");
    await Bun.write(
      testPath,
      `import { describe, test, expect } from "bun:test";
describe("test-feature", () => {
  test("AC-1: passes", () => { expect(true).toBe(true); });
});`,
    );

    const result = await acceptanceStage.execute(ctx);
    expect(result.action).toBe("continue");
  });

  test("AC-4: acceptance.command without {{FILE}} is executed verbatim", async () => {
    const prd = createTestPRD([{ id: "US-001", status: "passed" }]);

    // Point to the real acceptance test file using absolute path in command
    const testPath = path.join(featureDir, ".nax-acceptance.test.ts");
    await Bun.write(
      testPath,
      `import { describe, test, expect } from "bun:test";
describe("test-feature", () => {
  test("AC-1: passes", () => { expect(true).toBe(true); });
});`,
    );

    const ctx = createTestContext(prd, {
      acceptance: {
        ...DEFAULT_CONFIG.acceptance,
        command: `bun test ${testPath} --timeout=60000`,
      },
    });

    const result = await acceptanceStage.execute(ctx);
    expect(result.action).toBe("continue");
  });

  test("AC-6: quality.commands.test has no effect on acceptance runner", async () => {
    const prd = createTestPRD([{ id: "US-001", status: "passed" }]);
    const ctx = createTestContext(prd, {
      quality: {
        ...DEFAULT_CONFIG.quality,
        commands: { test: "exit 1" }, // Would fail if used — must be ignored
      },
    });

    const testPath = path.join(featureDir, ".nax-acceptance.test.ts");
    await Bun.write(
      testPath,
      `import { describe, test, expect } from "bun:test";
describe("test-feature", () => {
  test("AC-1: passes", () => { expect(true).toBe(true); });
});`,
    );

    const result = await acceptanceStage.execute(ctx);

    // Would be "fail" if quality.commands.test ("exit 1") was used instead of bun test
    expect(result.action).toBe("continue");
  });
});
