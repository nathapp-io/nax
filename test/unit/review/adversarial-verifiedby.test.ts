/**
 * Unit tests for verifiedBy.observed substantiation in runAdversarialReview (Issue #987).
 *
 * Split from adversarial-pass-fail.test.ts to keep that file within the 600-line limit.
 * Covers: downgrade on phantom quote, downgrade on missing verifiedBy, preservation on
 * verbatim match, info-severity bypass, and downgrade event emission.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IAgentManager } from "@/agents";
import { substantiateAdversarialFindings } from "@/review";
import { _adversarialDeps, _diffUtilsDeps, _evidenceDeps, runAdversarialReview } from "@/review";
import type { AdversarialLLMFinding } from "@/review/adversarial-helpers";
import type { AdversarialReviewConfig, SemanticStory } from "@/review/types";
import { makeAgentAdapter, makeLogger, makeMockAgentManager, makeMockRuntime, withTempDir } from "@test/helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STORY: SemanticStory = {
  id: "STORY-001",
  title: "Add auth",
  description: "Auth feature",
  acceptanceCriteria: ["Users can log in"],
};

const ADVERSARIAL_CONFIG: AdversarialReviewConfig = {
  model: "balanced",
  diffMode: "ref",
  rules: [],
  timeoutMs: 180_000,
  excludePatterns: [],
  parallel: false,
  maxConcurrentSessions: 2,
};

const STAT_OUTPUT = "src/foo.ts | 5 +++++\n 1 file changed, 5 insertions(+)";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgentManager(llmResponse: string, cost = 0.001): IAgentManager {
  return makeMockAgentManager({
    getDefaultAgent: "claude",
    completeFn: async () => ({ output: llmResponse, costUsd: cost, source: "mock" as const }),
    runWithFallbackFn: async (req) => {
      if (!req.executeHop) throw new Error("executeHop not available");
      const hopResult = await req.executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
      return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
    },
    runAsSessionFn: async () => ({
      output: llmResponse,
      tokenUsage: { inputTokens: 10, outputTokens: 20 },
      estimatedCostUsd: cost,
      internalRoundTrips: 0,
    }),
    completeWithFallbackFn: async () => ({
      result: { output: llmResponse, costUsd: cost, source: "mock" },
      fallbacks: [],
    }),
    completeAsFn: async () => ({ output: llmResponse, costUsd: cost, source: "mock" }),
    getAgentFn: () => makeAgentAdapter(),
  });
}

function makeSpawnMock(stdout: string, exitCode = 0) {
  return mock((_opts: unknown) => ({
    exited: Promise.resolve(exitCode),
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stdout));
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    kill: () => {},
  })) as unknown as typeof _diffUtilsDeps.spawn;
}

// ---------------------------------------------------------------------------
// Shared dep save/restore
// ---------------------------------------------------------------------------

let origSpawn: typeof _diffUtilsDeps.spawn;
let origIsGitRefValid: typeof _diffUtilsDeps.isGitRefValid;
let origGetMergeBase: typeof _diffUtilsDeps.getMergeBase;
let origWriteReviewAudit: typeof _adversarialDeps.writeReviewAudit;

function saveAllDeps() {
  origSpawn = _diffUtilsDeps.spawn;
  origIsGitRefValid = _diffUtilsDeps.isGitRefValid;
  origGetMergeBase = _diffUtilsDeps.getMergeBase;
  origWriteReviewAudit = _adversarialDeps.writeReviewAudit;
}

function restoreAllDeps() {
  _diffUtilsDeps.spawn = origSpawn;
  _diffUtilsDeps.isGitRefValid = origIsGitRefValid;
  _diffUtilsDeps.getMergeBase = origGetMergeBase;
  _adversarialDeps.writeReviewAudit = origWriteReviewAudit;
}

function setupHappyPathDeps(statContent = STAT_OUTPUT) {
  _diffUtilsDeps.isGitRefValid = mock(async () => true);
  _diffUtilsDeps.getMergeBase = mock(async () => undefined);
  _diffUtilsDeps.spawn = makeSpawnMock(statContent);
  _adversarialDeps.writeReviewAudit = mock(async () => {});
}

// ---------------------------------------------------------------------------
// AC-5 (Issue #987): Implementation-axis grounding — verifiedBy.observed
// ---------------------------------------------------------------------------

describe("runAdversarialReview — verifiedBy.observed substantiation (#987)", () => {
  let origGetLogger: typeof _evidenceDeps.getLogger;

  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
    origGetLogger = _evidenceDeps.getLogger;
  });

  afterEach(() => {
    _evidenceDeps.getLogger = origGetLogger;
    restoreAllDeps();
  });

  test("downgrades blocking finding when verifiedBy.observed is not in source", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/auth.ts"), "export function login() {}\n");

      const llmResponse = JSON.stringify({
        passed: false,
        findings: [
          {
            severity: "error",
            category: "abandonment",
            file: "src/auth.ts",
            line: 1,
            issue: "login is broken",
            suggestion: "Fix it",
            acQuote: "can log in",
            acIndex: 1,
            verifiedBy: {
              command: "cat src/auth.ts",
              file: "src/auth.ts",
              line: 1,
              observed: "this string is not in the file",
            },
          },
        ],
      });

      const agentManager = makeAgentManager(llmResponse);
      const runtime = makeMockRuntime({ agentManager });
      const result = await runAdversarialReview({
        workdir,
        storyGitRef: "abc123",
        story: STORY,
        adversarialConfig: ADVERSARIAL_CONFIG,
        agentManager,
        runtime,
      });

      // Downgraded to "unverifiable" → not blocking → review passes
      expect(result.success).toBe(true);
      expect(result.findings).toBeUndefined();
      expect(result.advisoryFindings).toBeDefined();
      expect(result.advisoryFindings?.[0]?.severity).toBe("unverifiable");
    });
  });

  test("downgrades blocking finding when verifiedBy.observed is missing", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/auth.ts"), "export function login() {}\n");

      const llmResponse = JSON.stringify({
        passed: false,
        findings: [
          {
            severity: "error",
            category: "abandonment",
            file: "src/auth.ts",
            line: 1,
            issue: "login is broken",
            suggestion: "Fix it",
            acQuote: "can log in",
            acIndex: 1,
            // verifiedBy intentionally omitted
          },
        ],
      });

      const agentManager = makeAgentManager(llmResponse);
      const runtime = makeMockRuntime({ agentManager });
      const result = await runAdversarialReview({
        workdir,
        storyGitRef: "abc123",
        story: STORY,
        adversarialConfig: ADVERSARIAL_CONFIG,
        agentManager,
        runtime,
      });

      expect(result.success).toBe(true);
      expect(result.advisoryFindings).toBeDefined();
      expect(result.advisoryFindings?.[0]?.severity).toBe("unverifiable");
    });
  });

  test("downgrades blocking finding with phantom evidence in embedded diff mode", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/auth.ts"), "export function login() {}\n");

      const llmResponse = JSON.stringify({
        passed: false,
        findings: [
          {
            severity: "error",
            category: "abandonment",
            file: "src/auth.ts",
            line: 1,
            issue: "login is broken",
            suggestion: "Fix it",
            acQuote: "can log in",
            acIndex: 1,
            verifiedBy: {
              command: "cat src/auth.ts",
              file: "src/auth.ts",
              line: 1,
              observed: "this embedded-mode quote is not in the file",
            },
          },
        ],
      });

      const agentManager = makeAgentManager(llmResponse);
      const runtime = makeMockRuntime({ agentManager });
      const result = await runAdversarialReview({
        workdir,
        storyGitRef: "abc123",
        story: STORY,
        adversarialConfig: { ...ADVERSARIAL_CONFIG, diffMode: "embedded" },
        agentManager,
        runtime,
      });

      expect(result.success).toBe(true);
      expect(result.findings).toBeUndefined();
      expect(result.advisoryFindings?.[0]?.severity).toBe("unverifiable");
    });
  });

  test("downgrades warning finding without verifiedBy when warning threshold blocks", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/auth.ts"), "export function login() {}\n");

      const llmResponse = JSON.stringify({
        passed: false,
        findings: [
          {
            severity: "warning",
            category: "input",
            file: "src/auth.ts",
            line: 1,
            issue: "login mishandles empty input",
            suggestion: "Validate input",
          },
        ],
      });

      const agentManager = makeAgentManager(llmResponse);
      const runtime = makeMockRuntime({ agentManager });
      const result = await runAdversarialReview({
        workdir,
        storyGitRef: "abc123",
        story: STORY,
        adversarialConfig: ADVERSARIAL_CONFIG,
        agentManager,
        runtime,
        blockingThreshold: "warning",
      });

      expect(result.success).toBe(true);
      expect(result.findings).toBeUndefined();
      expect(result.advisoryFindings?.[0]?.severity).toBe("unverifiable");
    });
  });

  test("preserves blocking finding when verifiedBy.observed matches source verbatim", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      // file "log.ts" → keyword "log" → appears in acQuote "can log in"
      writeFileSync(join(workdir, "src/log.ts"), "export function login() { return null; }\n");

      const llmResponse = JSON.stringify({
        passed: false,
        findings: [
          {
            severity: "error",
            category: "abandonment",
            file: "src/log.ts",
            line: 1,
            issue: "login returns null",
            suggestion: "Return a session",
            acQuote: "can log in",
            acIndex: 1,
            verifiedBy: {
              command: "cat src/log.ts",
              file: "src/log.ts",
              line: 1,
              observed: "export function login() { return null; }",
            },
          },
        ],
      });

      const agentManager = makeAgentManager(llmResponse);
      const runtime = makeMockRuntime({ agentManager });
      const result = await runAdversarialReview({
        workdir,
        storyGitRef: "abc123",
        story: STORY,
        adversarialConfig: ADVERSARIAL_CONFIG,
        agentManager,
        runtime,
      });

      expect(result.success).toBe(false);
      expect(result.findings).toBeDefined();
      expect(result.findings?.length).toBe(1);
      expect(result.findings?.[0]?.severity).toBe("error");
    });
  });

  test("non-blocking finding (info) skips substantiation entirely", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/auth.ts"), "export function login() {}\n");

      // info severity — substantiation must NOT run; finding passes through
      const llmResponse = JSON.stringify({
        passed: false,
        findings: [
          {
            severity: "info",
            category: "convention",
            file: "src/auth.ts",
            line: 1,
            issue: "Could add docstring",
            suggestion: "Add JSDoc",
            // No verifiedBy — info doesn't require it
          },
        ],
      });

      const agentManager = makeAgentManager(llmResponse);
      const runtime = makeMockRuntime({ agentManager });
      const result = await runAdversarialReview({
        workdir,
        storyGitRef: "abc123",
        story: STORY,
        adversarialConfig: ADVERSARIAL_CONFIG,
        agentManager,
        runtime,
      });

      expect(result.success).toBe(true);
      expect(result.advisoryFindings).toBeDefined();
      expect(result.advisoryFindings?.[0]?.severity).toBe("info");
    });
  });

  test("preserves blocking finding when source file is unreadable (fail-open)", async () => {
    await withTempDir(async (workdir) => {
      // Deliberately do NOT write src/log.ts — readSafeFile returns null → "unreadable" → fail-open.
      // file stem "log" appears in acQuote "can log in" so filterByAcQuote passes.
      const llmResponse = JSON.stringify({
        passed: false,
        findings: [
          {
            severity: "error",
            category: "abandonment",
            file: "src/log.ts",
            line: 1,
            issue: "login handler stub",
            suggestion: "Fix it",
            acQuote: "can log in",
            acIndex: 1,
            verifiedBy: {
              file: "src/log.ts",
              line: 1,
              observed: "some excerpt from the file",
            },
          },
        ],
      });

      const agentManager = makeAgentManager(llmResponse);
      const runtime = makeMockRuntime({ agentManager });
      const result = await runAdversarialReview({
        workdir,
        storyGitRef: "abc123",
        story: STORY,
        adversarialConfig: ADVERSARIAL_CONFIG,
        agentManager,
        runtime,
      });

      // "unreadable" = tool failure, not fabrication → finding preserved as blocking
      expect(result.success).toBe(false);
      expect(result.findings).toBeDefined();
      expect(result.findings?.[0]?.severity).toBe("error");
    });
  });

  test("emits a downgrade log event on fabricated observation", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/auth.ts"), "export function login() {}\n");

      const logger = makeLogger();
      _evidenceDeps.getLogger = () => logger;

      const llmResponse = JSON.stringify({
        passed: false,
        findings: [
          {
            severity: "error",
            category: "abandonment",
            file: "src/auth.ts",
            line: 1,
            issue: "fabricated issue",
            suggestion: "Fix",
            acQuote: "can log in",
            acIndex: 1,
            verifiedBy: {
              command: "cat",
              file: "src/auth.ts",
              line: 1,
              observed: "phantom code that is not in the file",
            },
          },
        ],
      });

      const agentManager = makeAgentManager(llmResponse);
      const runtime = makeMockRuntime({ agentManager });
      await runAdversarialReview({
        workdir,
        storyGitRef: "abc123",
        story: STORY,
        adversarialConfig: ADVERSARIAL_CONFIG,
        agentManager,
        runtime,
      });

      // With hopBody enabled: when evidence is unmatched, same-session requote fires.
      // The mock always returns the original review JSON (not a valid requote response),
      // so parseRequoteResponse fails → downgradeUnsubstantiatedFinding emits requote_failed.
      // Without hopBody: verify() substantiation emits the direct downgraded event.
      // Either event confirms the fabricated observation was caught and finding downgraded.
      const downgradeEvent = logger.calls.find((c) => {
        const event = (c.data as Record<string, unknown> | undefined)?.event;
        return (
          event === "review.adversarial.finding.downgraded" || event === "review.adversarial.finding.requote_failed"
        );
      });
      expect(downgradeEvent).toBeDefined();
    });
  });
});

describe("substantiateAdversarialFindings — monorepo repoRoot resolution", () => {
  function makeAdvFinding(overrides: Partial<AdversarialLLMFinding> = {}): AdversarialLLMFinding {
    return {
      severity: "error",
      file: "apps/api/src/x.ts",
      line: 0,
      issue: "AC not implemented",
      suggestion: "Implement it",
      verifiedBy: {
        file: "apps/api/src/x.ts",
        line: 0,
        observed: "no x.ts in the changeset",
      },
      ...overrides,
    } as AdversarialLLMFinding;
  }

  test("downgrades monorepo finding whose observed is absent once repoRoot resolves the path", async () => {
    await withTempDir(async (repoRoot) => {
      mkdirSync(join(repoRoot, "apps/api/src"), { recursive: true });
      writeFileSync(join(repoRoot, "apps/api/src/x.ts"), "export const handler = () => 1;\n");
      const packageDir = join(repoRoot, "apps/api");

      const result = await substantiateAdversarialFindings({
        findings: [makeAdvFinding()],
        workdir: packageDir,
        storyId: "STORY-001",
        blockingThreshold: "error",
        repoRoot,
      });

      expect(result[0].severity).toBe("unverifiable");
    });
  });

  test("preserves monorepo finding whose observed matches the file", async () => {
    await withTempDir(async (repoRoot) => {
      mkdirSync(join(repoRoot, "apps/api/src"), { recursive: true });
      writeFileSync(join(repoRoot, "apps/api/src/x.ts"), "export const handler = () => 1;\n");
      const packageDir = join(repoRoot, "apps/api");

      const finding = makeAdvFinding({
        line: 1,
        verifiedBy: { file: "apps/api/src/x.ts", line: 1, observed: "export const handler = () => 1;" },
      });

      const result = await substantiateAdversarialFindings({
        findings: [finding],
        workdir: packageDir,
        storyId: "STORY-001",
        blockingThreshold: "error",
        repoRoot,
      });

      expect(result[0].severity).toBe("error");
    });
  });
});
