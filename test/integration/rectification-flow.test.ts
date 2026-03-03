/**
 * Integration tests for rectification flow (v0.11)
 *
 * Tests the E2E rectification flow:
 * - Scoped tests pass -> Full suite fails -> Rectification prompt sent -> Fix applied -> Full suite passes
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Skip rectification flow integration tests in CI: these tests spawn real agent
// subprocesses via runPostAgentVerification which invokes bun test internally.
// In CI the subprocess environment differs (no claude binary, different PATH,
// container file system limits), causing hangs or unexpected failures unrelated
// to the rectification logic itself. Run these locally or on a full-env runner.
const skipInCI = process.env.CI ? test.skip : test;
import { ALL_AGENTS } from "../../src/agents/registry";
import { DEFAULT_CONFIG } from "../../src/config";
import { runPostAgentVerification } from "../../src/execution/post-verify";
import type { PostVerifyOptions } from "../../src/execution/post-verify";
import { initLogger, resetLogger } from "../../src/logger";
import type { StoryMetrics } from "../../src/metrics";
import type { PRD, UserStory } from "../../src/prd";

// Mock agent adapter for testing
const createMockAgent = () => ({
  name: "mock-agent",
  displayName: "Mock Agent",
  binary: "mock",
  capabilities: {
    supportedTiers: ["fast", "balanced", "powerful"],
    maxContextTokens: 100000,
    features: new Set(["tdd", "review", "refactor"]),
  },
  isInstalled: async () => true,
  run: mock(async () => ({
    success: true,
    estimatedCost: 0.01,
    pid: undefined,
  })),
  buildCommand: () => ["mock", "command"],
});

// Create test PRD
const createTestPRD = (story: Partial<UserStory>): PRD => ({
  project: "test-project",
  feature: "test-feature",
  branchName: "test-branch",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  userStories: [
    {
      id: story.id || "US-001",
      title: story.title || "Test Story",
      description: story.description || "Test description",
      acceptanceCriteria: story.acceptanceCriteria || ["AC1"],
      dependencies: story.dependencies || [],
      tags: story.tags || [],
      status: story.status || "pending",
      passes: story.passes ?? false,
      escalations: story.escalations || [],
      attempts: story.attempts || 0,
      routing: story.routing,
    },
  ],
});

describe("rectification flow (integration)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    initLogger({ level: "error", useChalk: false });
    tmpDir = `/tmp/nax-rectify-test-${Date.now()}`;
    await Bun.spawn(["mkdir", "-p", tmpDir], { stdout: "pipe" }).exited;
  });

  afterEach(async () => {
    resetLogger();
    await Bun.spawn(["rm", "-rf", tmpDir], { stdout: "pipe" }).exited;
  });

  test("should skip rectification when disabled in config", async () => {
    const story: UserStory = {
      id: "US-001",
      title: "Test Story",
      description: "Test",
      acceptanceCriteria: ["AC1"],
      dependencies: [],
      tags: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const prd = createTestPRD(story);
    const prdPath = `${tmpDir}/prd.json`;
    await Bun.write(prdPath, JSON.stringify(prd, null, 2));

    const config = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        rectification: {
          enabled: false, // Disabled
          maxRetries: 2,
          fullSuiteTimeoutSeconds: 120,
          maxFailureSummaryChars: 2000,
          abortOnIncreasingFailures: true,
        },
      },
      quality: {
        ...DEFAULT_CONFIG.quality,
        commands: {
          test: "exit 1", // Fail immediately
        },
      },
    };

    const opts: PostVerifyOptions = {
      config,
      prd,
      prdPath,
      workdir: tmpDir,
      story,
      storiesToExecute: [story],
      allStoryMetrics: [] as StoryMetrics[],
      timeoutRetryCountMap: new Map(),
    };

    // Register mock agent
    const mockAgent = createMockAgent();
    ALL_AGENTS.push(mockAgent);
    const cleanup = () => {
      const idx = ALL_AGENTS.findIndex((a) => a.name === "mock-agent");
      if (idx !== -1) ALL_AGENTS.splice(idx, 1);
    };

    try {
      const result = await runPostAgentVerification(opts);

      // Should fail without attempting rectification
      expect(result.passed).toBe(false);
      expect(mockAgent.run).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  skipInCI("should attempt rectification when enabled and tests fail", async () => {
    const story: UserStory = {
      id: "US-001",
      title: "Test Story",
      description: "Test",
      acceptanceCriteria: ["AC1"],
      dependencies: [],
      tags: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
      routing: {
        complexity: "simple",
        modelTier: "fast",
        testStrategy: "test-after",
        reasoning: "Test",
      },
    };

    const prd = createTestPRD(story);
    const prdPath = `${tmpDir}/prd.json`;
    await Bun.write(prdPath, JSON.stringify(prd, null, 2));

    // Create a fake test output with failures
    const failedTestOutput = `
test/example.test.ts:
✗ failing test [1.2ms]

(fail) should work correctly [1.2ms]
Error: Expected 1 to equal 2
  at test/example.test.ts:10:15
  at Object.test (test/example.test.ts:8:3)

1 test passed
1 test failed
`;

    // Create a script that returns failed output first, then success
    const callCount = 0;
    const testScript = `${tmpDir}/test.sh`;
    await Bun.write(
      testScript,
      `#!/bin/bash
if [ -f ${tmpDir}/.rectify-attempt ]; then
  echo "✓ all tests passed"
  exit 0
else
  cat <<'EOF'
${failedTestOutput}
EOF
  exit 1
fi
`,
    );
    await Bun.spawn(["chmod", "+x", testScript], { stdout: "pipe" }).exited;

    const config = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        rectification: {
          enabled: true,
          maxRetries: 2,
          fullSuiteTimeoutSeconds: 120,
          maxFailureSummaryChars: 2000,
          abortOnIncreasingFailures: true,
        },
      },
      quality: {
        ...DEFAULT_CONFIG.quality,
        commands: {
          test: testScript,
        },
      },
      autoMode: {
        ...DEFAULT_CONFIG.autoMode,
        defaultAgent: "mock-agent",
      },
    };

    const opts: PostVerifyOptions = {
      config,
      prd,
      prdPath,
      workdir: tmpDir,
      story,
      storiesToExecute: [story],
      allStoryMetrics: [] as StoryMetrics[],
      timeoutRetryCountMap: new Map(),
    };

    // Register mock agent that creates the marker file when called
    const mockAgent = createMockAgent();
    mockAgent.run = mock(async () => {
      // Simulate agent fixing the issue
      await Bun.write(`${tmpDir}/.rectify-attempt`, "1");
      return {
        success: true,
        estimatedCost: 0.01,
        pid: undefined,
      };
    });
    ALL_AGENTS.push(mockAgent);
    const cleanup = () => {
      const idx = ALL_AGENTS.findIndex((a) => a.name === "mock-agent");
      if (idx !== -1) ALL_AGENTS.splice(idx, 1);
    };

    try {
      const result = await runPostAgentVerification(opts);

      // Should pass after rectification
      expect(result.passed).toBe(true);
      expect(mockAgent.run).toHaveBeenCalled();
      expect(mockAgent.run).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  skipInCI("should abort rectification if failures increase", async () => {
    const story: UserStory = {
      id: "US-001",
      title: "Test Story",
      description: "Test",
      acceptanceCriteria: ["AC1"],
      dependencies: [],
      tags: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
      routing: {
        complexity: "simple",
        modelTier: "fast",
        testStrategy: "test-after",
        reasoning: "Test",
      },
    };

    const prd = createTestPRD(story);
    const prdPath = `${tmpDir}/prd.json`;
    await Bun.write(prdPath, JSON.stringify(prd, null, 2));

    // First failure: 2 tests fail
    const initialFailures = `
test/example.test.ts:
✗ test 1 [1ms]
✗ test 2 [1ms]

(fail) test 1 [1ms]
Error: Failed

(fail) test 2 [1ms]
Error: Failed

2 tests failed
`;

    // After rectification: 3 tests fail (regression!)
    const regressedFailures = `
test/example.test.ts:
✗ test 1 [1ms]
✗ test 2 [1ms]
✗ test 3 [1ms]

(fail) test 1 [1ms]
Error: Failed

(fail) test 2 [1ms]
Error: Failed

(fail) test 3 [1ms]
Error: Failed

3 tests failed
`;

    const callCount = 0;
    const testScript = `${tmpDir}/test.sh`;
    await Bun.write(
      testScript,
      `#!/bin/bash
if [ -f ${tmpDir}/.rectify-attempt ]; then
  cat <<'EOF'
${regressedFailures}
EOF
  exit 1
else
  cat <<'EOF'
${initialFailures}
EOF
  exit 1
fi
`,
    );
    await Bun.spawn(["chmod", "+x", testScript], { stdout: "pipe" }).exited;

    const config = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        rectification: {
          enabled: true,
          maxRetries: 2,
          fullSuiteTimeoutSeconds: 120,
          maxFailureSummaryChars: 2000,
          abortOnIncreasingFailures: true, // Abort on regression
        },
      },
      quality: {
        ...DEFAULT_CONFIG.quality,
        commands: {
          test: testScript,
        },
      },
      autoMode: {
        ...DEFAULT_CONFIG.autoMode,
        defaultAgent: "mock-agent",
      },
    };

    const opts: PostVerifyOptions = {
      config,
      prd,
      prdPath,
      workdir: tmpDir,
      story,
      storiesToExecute: [story],
      allStoryMetrics: [] as StoryMetrics[],
      timeoutRetryCountMap: new Map(),
    };

    // Register mock agent that creates marker file
    const mockAgent = createMockAgent();
    mockAgent.run = mock(async () => {
      await Bun.write(`${tmpDir}/.rectify-attempt`, "1");
      return {
        success: true,
        estimatedCost: 0.01,
        pid: undefined,
      };
    });
    ALL_AGENTS.push(mockAgent);
    const cleanup = () => {
      const idx = ALL_AGENTS.findIndex((a) => a.name === "mock-agent");
      if (idx !== -1) ALL_AGENTS.splice(idx, 1);
    };

    try {
      const result = await runPostAgentVerification(opts);

      // Should fail after aborting due to regression
      expect(result.passed).toBe(false);
      // Should only attempt once before detecting regression
      expect(mockAgent.run).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  skipInCI("should respect maxRetries limit", async () => {
    const story: UserStory = {
      id: "US-001",
      title: "Test Story",
      description: "Test",
      acceptanceCriteria: ["AC1"],
      dependencies: [],
      tags: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
      routing: {
        complexity: "simple",
        modelTier: "fast",
        testStrategy: "test-after",
        reasoning: "Test",
      },
    };

    const prd = createTestPRD(story);
    const prdPath = `${tmpDir}/prd.json`;
    await Bun.write(prdPath, JSON.stringify(prd, null, 2));

    const failedTestOutput = `
test/example.test.ts:
✗ failing test [1ms]

(fail) failing test [1ms]
Error: Failed

1 test failed
`;

    // Always fail
    const testScript = `${tmpDir}/test.sh`;
    await Bun.write(
      testScript,
      `#!/bin/bash
cat <<'EOF'
${failedTestOutput}
EOF
exit 1
`,
    );
    await Bun.spawn(["chmod", "+x", testScript], { stdout: "pipe" }).exited;

    const config = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        rectification: {
          enabled: true,
          maxRetries: 2, // Only 2 retries
          fullSuiteTimeoutSeconds: 120,
          maxFailureSummaryChars: 2000,
          abortOnIncreasingFailures: false, // Don't abort on regression
        },
      },
      quality: {
        ...DEFAULT_CONFIG.quality,
        commands: {
          test: testScript,
        },
      },
      autoMode: {
        ...DEFAULT_CONFIG.autoMode,
        defaultAgent: "mock-agent",
      },
    };

    const opts: PostVerifyOptions = {
      config,
      prd,
      prdPath,
      workdir: tmpDir,
      story,
      storiesToExecute: [story],
      allStoryMetrics: [] as StoryMetrics[],
      timeoutRetryCountMap: new Map(),
    };

    // Register mock agent
    const mockAgent = createMockAgent();
    ALL_AGENTS.push(mockAgent);
    const cleanup = () => {
      const idx = ALL_AGENTS.findIndex((a) => a.name === "mock-agent");
      if (idx !== -1) ALL_AGENTS.splice(idx, 1);
    };

    try {
      const result = await runPostAgentVerification(opts);

      // Should fail after exhausting retries
      expect(result.passed).toBe(false);
      // Should call agent exactly maxRetries times
      expect(mockAgent.run).toHaveBeenCalledTimes(2);
    } finally {
      cleanup();
    }
  });
});
