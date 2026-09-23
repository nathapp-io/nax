/**
 * US-002: Record the build commit on remembered approvals
 *
 * Tests that the `onRemember` callback captured from `_executionDeps.createHumanAskLink`
 * during `executionStage.execute` writes `naxCommit: NAX_COMMIT` (from `@/version`)
 * instead of reading `process.env.NAX_COMMIT`.
 *
 * Acceptance Criteria:
 * 1. Given `process.env.NAX_COMMIT` is unset, when the captured `onRemember` is invoked,
 *    it appends an entry whose `naxCommit` equals `NAX_COMMIT` from `@/version`.
 * 2. Given `NAX_COMMIT` is not `"unknown"`, the appended entry's `naxCommit` is not `"unknown"`.
 * 3. When the captured `onRemember` receives an `AskRequest`, the entry carries
 *    `origin: "escalate"` and the request's `command`.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeAgentAdapter,
  makeNaxConfig,
  makeTempDir,
  makeTestContext,
  makeTestStory,
  withExecutionDeps,
} from "@test/helpers";
import type { ConfigSelector } from "@/config";
import { ExecutionPlan } from "@/execution";
import type { CallContext } from "@/operations/types";
import type { AskRequest } from "@/permissions";
import { readApprovals } from "@/permissions";
import { executionStage } from "@/pipeline";
import type { PipelineContext } from "@/pipeline/types";
import { NAX_COMMIT } from "@/version";

const BASE_ROUTING = {
  complexity: "simple" as const,
  modelTier: "fast" as const,
  testStrategy: "test-after" as const,
  reasoning: "",
  agent: "claude",
};

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const config = makeNaxConfig();
  return makeTestContext({
    config,
    rootConfig: config,
    routing: BASE_ROUTING,
    packageView: {
      packageDir: "/tmp/test",
      relativeFromRoot: "",
      repoRoot: "/tmp/test",
      hasOverride: false,
      config,
      select: <C>(selector: ConfigSelector<C>) => selector.select(config),
    },
    ...overrides,
  });
}

describe("US-002: remembered approval commit", () => {
  let capturedOnRemember: ((req: AskRequest) => Promise<void>) | undefined;

  beforeEach(() => {
    capturedOnRemember = undefined;
  });

  test("AC1: onRemember writes NAX_COMMIT from @/version even when process.env.NAX_COMMIT is unset", async () => {
    // Arrange: save and clear process.env.NAX_COMMIT
    const savedNaxCommit = process.env.NAX_COMMIT;
    delete process.env.NAX_COMMIT;

    const tmpDir = makeTempDir("approval-commit-");
    const testOutputDir = join(tmpDir, "output");

    const ctx = makeCtx({
      workdir: "/tmp/test-us002",
    });

    // Override runtime with our temp output dir
    Object.defineProperty(ctx, "runtime", {
      value: {
        ...ctx.runtime,
        outputDir: testOutputDir,
      },
    });

    try {
      // Act: stub createHumanAskLink to capture the onRemember callback
      const restore = withExecutionDeps({
        createHumanAskLink: (opts) => {
          capturedOnRemember = opts.onRemember;
          // Return a no-op link
          return {
            name: "human",
            resolve: async () => ({ decision: "deny" as const, decidedBy: "unavailable" as const }),
            pending: () => undefined,
            cancel: async () => {},
            dispose: () => {},
          };
        },
        getAgent: () => makeAgentAdapter({ name: "claude" }),
        validateAgentForTier: () => true,
        captureGitRef: async () => "HEAD",
        getUntrackedPaths: async () => [],
        assemblePlanInputsFromCtx: async () => ({ story: makeTestStory(), config: makeNaxConfig() }),
        buildPlanForStrategy: async (callCtx: CallContext) => new ExecutionPlan(callCtx, {}, false),
        applyPostRunInspection: async () => ({
          agentResult: {
            success: true,
            exitCode: 0,
            output: "",
            rateLimited: false,
            durationMs: 0,
            estimatedCostUsd: 0,
          },
          selfVerificationFailed: false,
          needsHumanReview: false,
          providerUnavailable: false,
          combinedOutput: "",
        }),
        decideStageAction: async () => ({ action: "continue" as const }),
        resolveScopeFiles: async () => [],
      });

      try {
        await executionStage.execute(ctx);

        // Assert: onRemember was captured
        expect(capturedOnRemember).toBeDefined();

        // Act: invoke onRemember with a sample AskRequest
        const req: AskRequest = {
          tool: "Bash",
          stage: "implementer",
          rule: "ask",
          command: "echo test",
          summary: "test command",
          reason: "testing",
          root: "/tmp/test",
        };

        await capturedOnRemember?.(req);

        // Assert: the entry was written with NAX_COMMIT from @/version
        const entries = await readApprovals(join(testOutputDir, "approvals.json"));
        expect(entries).toHaveLength(1);
        expect(entries[0]?.naxCommit).toBe(NAX_COMMIT);
      } finally {
        restore();
      }
    } finally {
      // Restore process.env.NAX_COMMIT
      if (savedNaxCommit !== undefined) {
        process.env.NAX_COMMIT = savedNaxCommit;
      } else {
        delete process.env.NAX_COMMIT;
      }
      // cleanup temp dir
      cleanupTempDir(tmpDir);
    }
  });

  test("AC2: when NAX_COMMIT is not 'unknown', the entry's naxCommit is not 'unknown'", async () => {
    // This test verifies that the commit is a real git hash, not the fallback "unknown"
    // NAX_COMMIT is resolved at module load from @/version - it will be "dev" in dev
    // or a real hash in production builds

    const tmpDir = makeTempDir("approval-commit-");
    const testOutputDir = join(tmpDir, "output");

    const ctx = makeCtx({
      workdir: "/tmp/test-us002",
    });

    Object.defineProperty(ctx, "runtime", {
      value: {
        ...ctx.runtime,
        outputDir: testOutputDir,
      },
    });

    // `dev` is the documented source fallback and must be covered too.
    const hasKnownCommit = NAX_COMMIT !== "unknown";

    const restore = withExecutionDeps({
      createHumanAskLink: (opts) => {
        capturedOnRemember = opts.onRemember;
        return {
          name: "human",
          resolve: async () => ({ decision: "deny" as const, decidedBy: "unavailable" as const }),
          pending: () => undefined,
          cancel: async () => {},
          dispose: () => {},
        };
      },
      getAgent: () => makeAgentAdapter({ name: "claude" }),
      validateAgentForTier: () => true,
      captureGitRef: async () => "HEAD",
      getUntrackedPaths: async () => [],
      assemblePlanInputsFromCtx: async () => ({ story: makeTestStory(), config: makeNaxConfig() }),
      buildPlanForStrategy: async (callCtx: CallContext) => new ExecutionPlan(callCtx, {}, false),
      applyPostRunInspection: async () => ({
        agentResult: {
          success: true,
          exitCode: 0,
          output: "",
          rateLimited: false,
          durationMs: 0,
          estimatedCostUsd: 0,
        },
        selfVerificationFailed: false,
        needsHumanReview: false,
        providerUnavailable: false,
        combinedOutput: "",
      }),
      decideStageAction: async () => ({ action: "continue" as const }),
      resolveScopeFiles: async () => [],
    });

    try {
      await executionStage.execute(ctx);

      expect(capturedOnRemember).toBeDefined();

      const req: AskRequest = {
        tool: "Bash",
        stage: "implementer",
        rule: "ask",
        command: "git log --oneline -1",
        summary: "test command",
        reason: "testing",
        root: "/tmp/test",
      };

      await capturedOnRemember?.(req);

      const entries = await readApprovals(join(testOutputDir, "approvals.json"));
      expect(entries).toHaveLength(1);

      // Any known build identifier, including the source fallback `dev`, must not become "unknown".
      if (hasKnownCommit) {
        expect(entries[0]?.naxCommit).not.toBe("unknown");
      }
    } finally {
      restore();
      cleanupTempDir(tmpDir);
    }
  });

  test("AC3: the onRemember callback writes origin: 'escalate' and the request's command", async () => {
    const tmpDir = makeTempDir("approval-commit-");
    const testOutputDir = join(tmpDir, "output");

    const ctx = makeCtx({
      workdir: "/tmp/test-us002",
    });

    Object.defineProperty(ctx, "runtime", {
      value: {
        ...ctx.runtime,
        outputDir: testOutputDir,
      },
    });

    const testCommand = "bun run test --reporter=dot";

    const restore = withExecutionDeps({
      createHumanAskLink: (opts) => {
        capturedOnRemember = opts.onRemember;
        return {
          name: "human",
          resolve: async () => ({ decision: "deny" as const, decidedBy: "unavailable" as const }),
          pending: () => undefined,
          cancel: async () => {},
          dispose: () => {},
        };
      },
      getAgent: () => makeAgentAdapter({ name: "claude" }),
      validateAgentForTier: () => true,
      captureGitRef: async () => "HEAD",
      getUntrackedPaths: async () => [],
      assemblePlanInputsFromCtx: async () => ({ story: makeTestStory(), config: makeNaxConfig() }),
      buildPlanForStrategy: async (callCtx: CallContext) => new ExecutionPlan(callCtx, {}, false),
      applyPostRunInspection: async () => ({
        agentResult: {
          success: true,
          exitCode: 0,
          output: "",
          rateLimited: false,
          durationMs: 0,
          estimatedCostUsd: 0,
        },
        selfVerificationFailed: false,
        needsHumanReview: false,
        providerUnavailable: false,
        combinedOutput: "",
      }),
      decideStageAction: async () => ({ action: "continue" as const }),
      resolveScopeFiles: async () => [],
    });

    try {
      await executionStage.execute(ctx);

      expect(capturedOnRemember).toBeDefined();

      const req: AskRequest = {
        tool: "Bash",
        stage: "implementer",
        rule: "ask",
        command: testCommand,
        summary: "run tests",
        reason: "testing",
        root: "/tmp/test",
      };

      await capturedOnRemember?.(req);

      const entries = await readApprovals(join(testOutputDir, "approvals.json"));
      expect(entries).toHaveLength(1);
      expect(entries[0]?.origin).toBe("escalate");
      expect(entries[0]?.command).toBe(testCommand);
    } finally {
      restore();
      cleanupTempDir(tmpDir);
    }
  });
});
