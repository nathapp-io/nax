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
import { cleanupTempDir, makeTempDir } from "../../helpers/temp";

let testDir: string;
let featureDir: string;

beforeEach(async () => {
  initLogger({ level: "silent" });
  testDir = makeTempDir("nax-acceptance-test-");
  featureDir = path.join(testDir, ".nax/features/test-feature");
  await fs.mkdir(featureDir, { recursive: true });
});

afterEach(async () => {
  cleanupTempDir(testDir);
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
  test("disabled when acceptance disabled in config, or any story is pending/in-progress", () => {
    const ctxDisabled = createTestContext(createTestPRD([{ id: "US-001", status: "passed" }]), {
      acceptance: { enabled: false, maxRetries: 2, generateTests: true, testPath: "acceptance.test.ts" },
    });
    expect(acceptanceStage.enabled(ctxDisabled)).toBe(false);

    const ctxPending = createTestContext(createTestPRD([{ id: "US-001", status: "passed" }, { id: "US-002", status: "pending" }]));
    expect(acceptanceStage.enabled(ctxPending)).toBe(false);

    const ctxInProgress = createTestContext(createTestPRD([{ id: "US-001", status: "passed" }, { id: "US-002", status: "in-progress" }]));
    expect(acceptanceStage.enabled(ctxInProgress)).toBe(false);
  });

  test("enabled when all stories are terminal (passed/failed/skipped)", () => {
    const ctxMixed = createTestContext(createTestPRD([{ id: "US-001", status: "passed" }, { id: "US-002", status: "failed" }, { id: "US-003", status: "skipped" }]));
    expect(acceptanceStage.enabled(ctxMixed)).toBe(true);

    const ctxAllPassed = createTestContext(createTestPRD([{ id: "US-001", status: "passed" }, { id: "US-002", status: "passed" }]));
    expect(acceptanceStage.enabled(ctxAllPassed)).toBe(true);
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

  test("continues when test file does not exist or no feature directory", async () => {
    const ctx1 = createTestContext(createTestPRD([{ id: "US-001", status: "passed" }]));
    expect((await acceptanceStage.execute(ctx1)).action).toBe("continue");

    const ctx2 = createTestContext(createTestPRD([{ id: "US-001", status: "passed" }]));
    ctx2.featureDir = undefined;
    expect((await acceptanceStage.execute(ctx2)).action).toBe("continue");
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
  test("AC-1+AC-6: quality.commands.test is not used for acceptance runner", async () => {
    const testPath = path.join(featureDir, ".nax-acceptance.test.ts");
    await Bun.write(
      testPath,
      `import { describe, test, expect } from "bun:test";
describe("test-feature", () => {
  test("AC-1: passes", () => { expect(true).toBe(true); });
});`,
    );

    // AC-1: echo command (would run differently if used, but result must be "continue")
    const ctx1 = createTestContext(createTestPRD([{ id: "US-001", status: "passed" }]), {
      quality: { ...DEFAULT_CONFIG.quality, commands: { test: "echo 'full-suite-ran'" } },
    });
    expect((await acceptanceStage.execute(ctx1)).action).toBe("continue");
    expect(ctx1.acceptanceFailures).toBeUndefined();

    // AC-6: "exit 1" would fail if used — must be ignored
    const ctx6 = createTestContext(createTestPRD([{ id: "US-001", status: "passed" }]), {
      quality: { ...DEFAULT_CONFIG.quality, commands: { test: "exit 1" } },
    });
    expect((await acceptanceStage.execute(ctx6)).action).toBe("continue");
  });

  test("AC-3+AC-4: custom acceptance.command with and without {{FILE}} substitution", async () => {
    const prd = createTestPRD([{ id: "US-001", status: "passed" }]);
    const testPath = path.join(featureDir, ".nax-acceptance.test.ts");
    await Bun.write(
      testPath,
      `import { describe, test, expect } from "bun:test";
describe("test-feature", () => {
  test("AC-1: passes", () => { expect(true).toBe(true); });
});`,
    );

    // AC-3: {{FILE}} is substituted
    const ctx3 = createTestContext(prd, { acceptance: { ...DEFAULT_CONFIG.acceptance, command: "bun test {{FILE}} --timeout=60000" } });
    expect((await acceptanceStage.execute(ctx3)).action).toBe("continue");

    // AC-4: no {{FILE}} — executed verbatim with absolute path
    const ctx4 = createTestContext(prd, { acceptance: { ...DEFAULT_CONFIG.acceptance, command: `bun test ${testPath} --timeout=60000` } });
    expect((await acceptanceStage.execute(ctx4)).action).toBe("continue");
  });
});
