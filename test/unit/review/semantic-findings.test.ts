/**
 * Unit tests for structured ReviewFinding output in runSemanticReview (US-003)
 *
 * Covers the new AC-2 mapping behavior:
 * - runSemanticReview() populates result.findings with ReviewFinding[] when LLM returns findings
 * - Each LLMFinding maps to ReviewFinding with source='semantic-review', ruleId='semantic'
 * - finding.issue maps to ReviewFinding.message
 * - finding.severity is normalised ("warn" -> "warning")
 * - result.findings is empty/absent when LLM returns passed=true
 * - result.findings is empty/absent on fail-open (invalid JSON)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _semanticDeps, runSemanticReview } from "../../../src/review/semantic";
import type { SemanticStory } from "../../../src/review/semantic";
import type { SemanticReviewConfig } from "../../../src/review/types";
import type { AgentAdapter } from "../../../src/agents/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STORY: SemanticStory = {
  id: "US-003",
  title: "Wire semantic findings",
  description: "Wire findings into autofix context",
  acceptanceCriteria: ["ctx.reviewFindings is populated when semantic fails"],
};

const CFG: SemanticReviewConfig = { modelTier: "balanced", rules: [], excludePatterns: [":!test/"] };

function makeMockAgent(response: string): AgentAdapter {
  return {
    name: "mock",
    displayName: "Mock",
    binary: "mock",
    capabilities: { supportedTiers: [], supportedTestStrategies: [], features: {} } as unknown as AgentAdapter["capabilities"],
    isInstalled: mock(async () => true),
    run: mock(async () => { throw new Error("not used"); }),
    buildCommand: mock(() => []),
    plan: mock(async () => { throw new Error("not used"); }),
    decompose: mock(async () => { throw new Error("not used"); }),
    complete: mock(async (_prompt: string) => response),
  } as unknown as AgentAdapter;
}

function makeSpawnMock(stdout = "diff output", exitCode = 0) {
  return mock((_opts: unknown) => ({
    exited: Promise.resolve(exitCode),
    stdout: new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(stdout)); c.close(); },
    }),
    stderr: new ReadableStream({ start(c) { c.close(); } }),
    kill: () => {},
  })) as unknown as typeof _semanticDeps.spawn;
}

// ---------------------------------------------------------------------------
// AC-2: structured ReviewFinding[] in result.findings when LLM returns findings
// ---------------------------------------------------------------------------

describe("runSemanticReview — structured findings in result (US-003 AC-2)", () => {
  let origSpawn: typeof _semanticDeps.spawn;

  beforeEach(() => { origSpawn = _semanticDeps.spawn; });
  afterEach(() => { _semanticDeps.spawn = origSpawn; });

  test("result.findings is defined and non-empty when LLM returns passed=false with findings", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff");
    const llmResponse = JSON.stringify({
      passed: false,
      findings: [
        { severity: "error", file: "src/foo.ts", line: 10, issue: "Stub left in code", suggestion: "Remove stub" },
      ],
    });
    const agent = makeMockAgent(llmResponse);

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, CFG, () => agent);

    expect(result.findings).toBeDefined();
    expect(result.findings!.length).toBe(1);
  });

  test("maps finding.issue to ReviewFinding.message", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff");
    const llmResponse = JSON.stringify({
      passed: false,
      findings: [
        { severity: "error", file: "src/foo.ts", line: 5, issue: "Missing wiring in runner", suggestion: "Fix it" },
      ],
    });
    const agent = makeMockAgent(llmResponse);

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, CFG, () => agent);

    expect(result.findings![0].message).toBe("Missing wiring in runner");
  });

  test("sets source='semantic-review' on each ReviewFinding", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff");
    const llmResponse = JSON.stringify({
      passed: false,
      findings: [
        { severity: "error", file: "src/a.ts", line: 1, issue: "An issue", suggestion: "Fix" },
        { severity: "warn", file: "src/b.ts", line: 2, issue: "Another issue", suggestion: "Fix" },
      ],
    });
    const agent = makeMockAgent(llmResponse);

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, CFG, () => agent);

    for (const finding of result.findings!) {
      expect(finding.source).toBe("semantic-review");
    }
  });

  test("sets ruleId='semantic' on each ReviewFinding", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff");
    const llmResponse = JSON.stringify({
      passed: false,
      findings: [
        { severity: "info", file: "src/x.ts", line: 3, issue: "Info issue", suggestion: "Fix" },
      ],
    });
    const agent = makeMockAgent(llmResponse);

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, CFG, () => agent);

    expect(result.findings![0].ruleId).toBe("semantic");
  });

  test("maps finding.file to ReviewFinding.file", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff");
    const llmResponse = JSON.stringify({
      passed: false,
      findings: [
        { severity: "error", file: "src/review/runner.ts", line: 42, issue: "Issue", suggestion: "Fix" },
      ],
    });
    const agent = makeMockAgent(llmResponse);

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, CFG, () => agent);

    expect(result.findings![0].file).toBe("src/review/runner.ts");
  });

  test("maps finding.line to ReviewFinding.line", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff");
    const llmResponse = JSON.stringify({
      passed: false,
      findings: [
        { severity: "error", file: "src/foo.ts", line: 99, issue: "Issue", suggestion: "Fix" },
      ],
    });
    const agent = makeMockAgent(llmResponse);

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, CFG, () => agent);

    expect(result.findings![0].line).toBe(99);
  });

  test("maps finding.severity 'error' directly to ReviewFinding.severity", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff");
    const llmResponse = JSON.stringify({
      passed: false,
      findings: [
        { severity: "error", file: "src/foo.ts", line: 1, issue: "Issue", suggestion: "Fix" },
      ],
    });
    const agent = makeMockAgent(llmResponse);

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, CFG, () => agent);

    expect(result.findings![0].severity).toBe("error");
  });

  test("normalises severity 'warn' to 'warning' in ReviewFinding", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff");
    const llmResponse = JSON.stringify({
      passed: false,
      findings: [
        { severity: "warn", file: "src/foo.ts", line: 1, issue: "Warn issue", suggestion: "Fix" },
      ],
    });
    const agent = makeMockAgent(llmResponse);

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, CFG, () => agent);

    expect(result.findings![0].severity).toBe("warning");
  });

  test("maps 'info' severity as-is to ReviewFinding.severity", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff");
    const llmResponse = JSON.stringify({
      passed: false,
      findings: [
        { severity: "info", file: "src/foo.ts", line: 1, issue: "Info issue", suggestion: "Fix" },
      ],
    });
    const agent = makeMockAgent(llmResponse);

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, CFG, () => agent);

    expect(result.findings![0].severity).toBe("info");
  });

  test("populates findings for all LLM findings when multiple are returned", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff");
    const llmResponse = JSON.stringify({
      passed: false,
      findings: [
        { severity: "error", file: "src/a.ts", line: 1, issue: "Issue A", suggestion: "Fix A" },
        { severity: "warn", file: "src/b.ts", line: 20, issue: "Issue B", suggestion: "Fix B" },
        { severity: "info", file: "src/c.ts", line: 5, issue: "Issue C", suggestion: "Fix C" },
      ],
    });
    const agent = makeMockAgent(llmResponse);

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, CFG, () => agent);

    expect(result.findings!.length).toBe(3);
    expect(result.findings![1].message).toBe("Issue B");
    expect(result.findings![1].file).toBe("src/b.ts");
    expect(result.findings![1].severity).toBe("warning");
  });

  test("result.findings is empty or absent when LLM returns passed=true", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff");
    const agent = makeMockAgent(JSON.stringify({ passed: true, findings: [] }));

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, CFG, () => agent);

    expect(!result.findings || result.findings.length === 0).toBe(true);
  });

  test("result.findings is empty or absent on fail-open (invalid JSON)", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff");
    const agent = makeMockAgent("not valid json {{");

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, CFG, () => agent);

    expect(!result.findings || result.findings.length === 0).toBe(true);
  });

  test("result.findings is empty or absent when storyGitRef is missing (skipped)", async () => {
    _semanticDeps.spawn = makeSpawnMock("", 0);

    const result = await runSemanticReview("/tmp/wd", undefined, STORY, CFG, () => null);

    expect(!result.findings || result.findings.length === 0).toBe(true);
  });
});
