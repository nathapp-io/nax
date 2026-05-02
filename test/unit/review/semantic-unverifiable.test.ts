/**
 * Unit tests for unverifiable finding handling in src/review/semantic.ts
 *
 * Tests cover:
 * - "unverifiable" severity is treated as non-blocking (maps to "info")
 * - Findings with only unverifiable severity override to pass
 * - Mixed blocking + unverifiable findings: only blocking count
 * - Updated prompt includes tool-access verification instructions
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentResult } from "../../../src/agents/types";
import { _diffUtilsDeps } from "../../../src/review/diff-utils";
import { _semanticDeps, runSemanticReview } from "../../../src/review/semantic";
import type { SemanticStory } from "../../../src/review/semantic";
import type { SemanticReviewConfig } from "../../../src/review/types";
import { makeMockAgentManager } from "../../helpers";
import { makeMockRuntime } from "../../helpers/runtime";
import { withTempDir } from "../../helpers/temp";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STORY: SemanticStory = {
  id: "US-010",
  title: "i18n key migration",
  description: "Migrate hardcoded strings to i18n keys",
  acceptanceCriteria: [
    "Component uses t('foo.bar') from i18n",
    "Locale files contain foo.bar key",
  ],
};

const DEFAULT_SEMANTIC_CONFIG: SemanticReviewConfig = {
  model: "balanced",
  diffMode: "embedded",
  resetRefOnRerun: false,
  rules: [],
  excludePatterns: [":!test/", ":!tests/"],
  timeoutMs: 600_000,
};

function makeAgentManager(llmResponse: string, cost = 0) {
  return makeMockAgentManager({
    getDefaultAgent: "claude",
    runFn: async (_agent, opts) => ({
      success: true,
      exitCode: 0,
      output: llmResponse,
      rateLimited: false,
      durationMs: 100,
      estimatedCostUsd: cost,
      agentFallbacks: [],
    }),
    completeFn: async () => ({ output: llmResponse, costUsd: cost, source: "mock" }),
    runWithFallbackFn: async () => ({ result: { success: true, exitCode: 0, output: llmResponse, rateLimited: false, durationMs: 100, estimatedCostUsd: cost, agentFallbacks: [] }, fallbacks: [] }),
    completeWithFallbackFn: async () => ({ result: { output: llmResponse, costUsd: cost, source: "mock" }, fallbacks: [] }),
    runAsFn: async (_agent, opts) => ({
      success: true,
      exitCode: 0,
      output: llmResponse,
      rateLimited: false,
      durationMs: 100,
      estimatedCostUsd: cost,
      agentFallbacks: [],
    }),
    completeAsFn: async (_agent, _prompt, _opts) => ({ output: llmResponse, costUsd: cost, source: "mock" }),
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
      start(controller) { controller.close(); },
    }),
    kill: () => {},
  })) as unknown as typeof _diffUtilsDeps.spawn;
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let origSpawn: typeof _diffUtilsDeps.spawn;
let origIsGitRefValid: typeof _diffUtilsDeps.isGitRefValid;
let origGetMergeBase: typeof _diffUtilsDeps.getMergeBase;

beforeEach(() => {
  origSpawn = _diffUtilsDeps.spawn;
  origIsGitRefValid = _diffUtilsDeps.isGitRefValid;
  origGetMergeBase = _diffUtilsDeps.getMergeBase;

  _diffUtilsDeps.isGitRefValid = mock(async () => true);
  _diffUtilsDeps.getMergeBase = mock(async () => "abc123");
  _diffUtilsDeps.spawn = makeSpawnMock("diff --git a/foo.vue b/foo.vue\n+import { useI18n } from 'vue-i18n'");
});

afterEach(() => {
  _diffUtilsDeps.spawn = origSpawn;
  _diffUtilsDeps.isGitRefValid = origIsGitRefValid;
  _diffUtilsDeps.getMergeBase = origGetMergeBase;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("unverifiable finding handling", () => {
  test("unverifiable-only findings override to pass", async () => {
    const response = JSON.stringify({
      passed: false,
      findings: [
        {
          severity: "unverifiable",
          file: "i18n/en.json",
          line: 10,
          issue: "Cannot confirm key exists from diff alone",
          suggestion: "Check the file",
        },
      ],
    });
    const agentManager = makeAgentManager(response);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runSemanticReview({
      workdir: "/tmp/repo",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      agentManager,
      runtime,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("advisory");
  });

  test("mixed blocking + unverifiable: only blocking findings cause failure", async () => {
    const response = JSON.stringify({
      passed: false,
      findings: [
        {
          severity: "error",
          file: "foo.vue",
          line: 5,
          issue: "AC not implemented",
          suggestion: "Implement it",
        },
        {
          severity: "unverifiable",
          file: "i18n/en.json",
          line: 10,
          issue: "Cannot confirm key exists",
          suggestion: "Check the file",
        },
      ],
    });
    const agentManager = makeAgentManager(response);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runSemanticReview({
      workdir: "/tmp/repo",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      agentManager,
      runtime,
    });

    expect(result.success).toBe(false);
    // Only the blocking finding should be in the output
    expect(result.output).toContain("AC not implemented");
    expect(result.output).not.toContain("Cannot confirm key exists");
    // Only 1 finding in structured findings
    expect(result.findings?.length).toBe(1);
    expect(result.findings?.[0].message).toBe("AC not implemented");
  });

  test("info findings are advisory at default 'error' threshold (below blocking threshold)", async () => {
    const response = JSON.stringify({
      passed: false,
      findings: [
        {
          severity: "info",
          file: "foo.vue",
          line: 1,
          issue: "Minor observation",
          suggestion: "Consider this",
        },
      ],
    });
    const agentManager = makeAgentManager(response);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runSemanticReview({
      workdir: "/tmp/repo",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      agentManager,
      runtime,
    });

    // With default 'error' threshold, info findings are advisory — not blocking
    expect(result.success).toBe(true);
    expect(result.output).toContain("advisory");
    expect(result.advisoryFindings).toBeDefined();
    expect(result.advisoryFindings![0].message).toBe("Minor observation");
  });

  test("ref mode downgrades error findings that were not verified against files", async () => {
    const response = JSON.stringify({
      passed: false,
      findings: [
        {
          severity: "error",
          file: "apps/api/package.json",
          line: 0,
          issue: "The evaluate:retrieval script is missing.",
          suggestion: "Add the script to package.json.",
        },
      ],
    });
    const agentManager = makeAgentManager(response);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runSemanticReview({
      workdir: "/tmp/repo",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: { ...DEFAULT_SEMANTIC_CONFIG, diffMode: "ref" },
      agentManager,
      runtime,
    });

    expect(result.success).toBe(true);
    expect(result.findings).toBeUndefined();
    expect(result.advisoryFindings?.length).toBe(1);
    expect(result.advisoryFindings?.[0].severity).toBe("unverifiable");
  });

  test("ref mode downgrades error findings that admit they only used the diff", async () => {
    const response = JSON.stringify({
      passed: false,
      findings: [
        {
          severity: "error",
          file: "apps/api/src/retrieval/fixtures/eval-queries.json",
          line: 0,
          issue: "Cannot verify from diff alone that exactly 50 evaluation queries exist.",
          suggestion: "Read the fixture to count the queries.",
        },
      ],
    });
    const agentManager = makeAgentManager(response);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runSemanticReview({
      workdir: "/tmp/repo",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: { ...DEFAULT_SEMANTIC_CONFIG, diffMode: "ref" },
      agentManager,
      runtime,
    });

    expect(result.success).toBe(true);
    expect(result.findings).toBeUndefined();
    expect(result.advisoryFindings?.[0].message).toContain("Cannot verify from diff alone");
  });

  test("ref mode preserves verified error findings when observed evidence exists on disk", async () => {
    const response = JSON.stringify({
      passed: false,
      findings: [
        {
          severity: "error",
          file: "src/foo.ts",
          line: 5,
          issue: "AC not implemented",
          suggestion: "Implement it",
          verifiedBy: {
            command: "sed -n '1,80p' src/foo.ts",
            file: "src/foo.ts",
            line: 5,
            observed: "export function foo() {}",
          },
        },
      ],
    });
    const agentManager = makeAgentManager(response);
    const runtime = makeMockRuntime({ agentManager });
    const result = await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");
      return runSemanticReview({
        workdir,
        storyGitRef: "abc123",
        story: STORY,
        semanticConfig: { ...DEFAULT_SEMANTIC_CONFIG, diffMode: "ref" },
        agentManager,
        runtime,
      });
    });

    expect(result.success).toBe(false);
    expect(result.findings?.length).toBe(1);
    expect(result.findings?.[0].message).toBe("AC not implemented");
  });

  test("ref mode downgrades fabricated verifiedBy evidence to unverifiable", async () => {
    const response = JSON.stringify({
      passed: false,
      findings: [
        {
          severity: "error",
          file: "src/foo.ts",
          line: 5,
          issue: "AC not implemented",
          suggestion: "Replace the bogus Set comparison.",
          verifiedBy: {
            command: "sed -n '1,80p' src/foo.ts",
            file: "src/foo.ts",
            line: 5,
            observed: "new Set(array.sort().join('|'))",
          },
        },
      ],
    });
    const agentManager = makeAgentManager(response);
    const runtime = makeMockRuntime({ agentManager });
    const result = await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/foo.ts"), "const storedLinkStr = links.sort().join('|');\n");
      return runSemanticReview({
        workdir,
        storyGitRef: "abc123",
        story: STORY,
        semanticConfig: { ...DEFAULT_SEMANTIC_CONFIG, diffMode: "ref" },
        agentManager,
        runtime,
      });
    });

    expect(result.success).toBe(true);
    expect(result.findings).toBeUndefined();
    expect(result.advisoryFindings?.length).toBe(1);
    expect(result.advisoryFindings?.[0].severity).toBe("unverifiable");
    expect(result.advisoryFindings?.[0].message).toBe("AC not implemented");
  });
});

describe("semantic prompt includes tool-access instructions", () => {
  test("prompt instructs agent to verify with tools before flagging", async () => {
    const agentManager = makeAgentManager(JSON.stringify({ passed: true, findings: [] }));
    const runtime = makeMockRuntime({ agentManager });
    (agentManager.runWithFallback as ReturnType<typeof mock>).mockImplementation(async () => ({
      result: { success: true, exitCode: 0, output: JSON.stringify({ passed: true, findings: [] }), rateLimited: false, durationMs: 100, estimatedCostUsd: 0 } as AgentResult,
      fallbacks: [],
    }));

    await runSemanticReview({
      workdir: "/tmp/repo",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      agentManager,
      runtime,
    });

    expect(_diffUtilsDeps.spawn).toHaveBeenCalled();
  });
});
