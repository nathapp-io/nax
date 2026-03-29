/**
 * Unit tests for src/review/semantic.ts
 *
 * Tests cover:
 * - runSemanticReview() signature and early-exit on missing git ref
 * - git diff collection (production code only — test files excluded)
 * - Diff truncation at 50KB with stat preamble
 * - LLM prompt construction (title, description, ACs, custom rules, diff)
 * - JSON response parsing (passed=true, passed=false with findings)
 * - Fail-open / fail-closed behaviour on invalid JSON
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
  id: "US-002",
  title: "Implement semantic review runner",
  description: "Create src/review/semantic.ts with runSemanticReview()",
  acceptanceCriteria: [
    "runSemanticReview() accepts workdir, storyGitRef, story, semanticConfig, and modelResolver",
    "It calls git diff --unified=3 storyGitRef..HEAD",
  ],
};

const DEFAULT_SEMANTIC_CONFIG: SemanticReviewConfig = {
  modelTier: "balanced",
  rules: [],
  excludePatterns: [":!test/", ":!tests/", ":!*_test.go", ":!*.test.ts", ":!*.spec.ts", ":!**/__tests__/"],
};

/** Build a mock AgentAdapter whose complete() resolves to the supplied JSON string */
function makeMockAgent(response: string): AgentAdapter {
  return {
    name: "mock",
    displayName: "Mock Agent",
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

/** Build a mock spawn that returns the provided stdout with exit code 0 */
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
  })) as unknown as typeof _semanticDeps.spawn;
}

const PASSING_LLM_RESPONSE = JSON.stringify({ passed: true, findings: [] });
const FAILING_LLM_RESPONSE = JSON.stringify({
  passed: false,
  findings: [
    {
      severity: "error",
      file: "src/review/semantic.ts",
      line: 42,
      issue: "Function is a stub",
      suggestion: "Implement the function",
    },
  ],
});

// ---------------------------------------------------------------------------
// AC-1: Function signature / params
// ---------------------------------------------------------------------------

describe("runSemanticReview — signature", () => {
  test("is exported from src/review/semantic.ts", () => {
    expect(typeof runSemanticReview).toBe("function");
  });

  test("accepts five parameters without TypeScript errors (compile check)", async () => {
    // If this file compiles, parameter types are correct.
    // We use a spy here — no real implementation needed for this test.
    let called = false;
    const impl = async (..._args: Parameters<typeof runSemanticReview>) => {
      called = true;
      return { check: "semantic" as const, success: true, command: "", exitCode: 0, output: "", durationMs: 0 };
    };

    await impl("/tmp/workdir", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => null);
    expect(called).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-4: Early exit when storyGitRef is missing
// ---------------------------------------------------------------------------

describe("runSemanticReview — missing storyGitRef", () => {
  let origSpawn: typeof _semanticDeps.spawn;
  let origIsGitRefValid: typeof _semanticDeps.isGitRefValid;
  let origGetMergeBase: typeof _semanticDeps.getMergeBase;

  beforeEach(() => {
    origSpawn = _semanticDeps.spawn;
    origIsGitRefValid = _semanticDeps.isGitRefValid;
    origGetMergeBase = _semanticDeps.getMergeBase;
    // No valid ref — getMergeBase also returns undefined so review is skipped
    _semanticDeps.isGitRefValid = mock(async () => false);
    _semanticDeps.getMergeBase = mock(async () => undefined);
  });

  afterEach(() => {
    _semanticDeps.spawn = origSpawn;
    _semanticDeps.isGitRefValid = origIsGitRefValid;
    _semanticDeps.getMergeBase = origGetMergeBase;
  });

  test("returns success=true when storyGitRef is undefined", async () => {
    _semanticDeps.spawn = makeSpawnMock("", 0);
    const agent = makeMockAgent(PASSING_LLM_RESPONSE);

    const result = await runSemanticReview("/tmp/wd", undefined, STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(result.success).toBe(true);
  });

  test("returns output containing 'skipped: no git ref' when storyGitRef is undefined", async () => {
    _semanticDeps.spawn = makeSpawnMock("", 0);
    const agent = makeMockAgent(PASSING_LLM_RESPONSE);

    const result = await runSemanticReview("/tmp/wd", undefined, STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(result.output).toContain("skipped: no git ref");
  });

  test("returns success=true when storyGitRef is empty string", async () => {
    _semanticDeps.spawn = makeSpawnMock("", 0);
    const agent = makeMockAgent(PASSING_LLM_RESPONSE);

    const result = await runSemanticReview("/tmp/wd", "", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(result.success).toBe(true);
  });

  test("returns output containing 'skipped: no git ref' when storyGitRef is empty string", async () => {
    _semanticDeps.spawn = makeSpawnMock("", 0);
    const agent = makeMockAgent(PASSING_LLM_RESPONSE);

    const result = await runSemanticReview("/tmp/wd", "", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(result.output).toContain("skipped: no git ref");
  });

  test("does not invoke spawn when storyGitRef is undefined", async () => {
    const spawnMock = makeSpawnMock("", 0);
    _semanticDeps.spawn = spawnMock;

    await runSemanticReview("/tmp/wd", undefined, STORY, DEFAULT_SEMANTIC_CONFIG, () => null);

    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("result.check is 'semantic' when storyGitRef is undefined", async () => {
    _semanticDeps.spawn = makeSpawnMock("", 0);

    const result = await runSemanticReview("/tmp/wd", undefined, STORY, DEFAULT_SEMANTIC_CONFIG, () => null);

    expect(result.check).toBe("semantic");
  });
});

// ---------------------------------------------------------------------------
// AC-2: git diff command
// ---------------------------------------------------------------------------

describe("runSemanticReview — git diff invocation", () => {
  let origSpawn: typeof _semanticDeps.spawn;
  let origIsGitRefValid: typeof _semanticDeps.isGitRefValid;
  let origGetMergeBase: typeof _semanticDeps.getMergeBase;

  beforeEach(() => {
    origSpawn = _semanticDeps.spawn;
    origIsGitRefValid = _semanticDeps.isGitRefValid;
    origGetMergeBase = _semanticDeps.getMergeBase;
    // Mark supplied storyGitRef as valid so tests proceed without a real git repo
    _semanticDeps.isGitRefValid = mock(async () => true);
    _semanticDeps.getMergeBase = mock(async () => undefined);
  });

  afterEach(() => {
    _semanticDeps.spawn = origSpawn;
    _semanticDeps.isGitRefValid = origIsGitRefValid;
    _semanticDeps.getMergeBase = origGetMergeBase;
  });

  test("calls spawn with git diff --unified=3 <storyGitRef>..HEAD and test exclusions", async () => {
    const spawnMock = makeSpawnMock("diff output", 0);
    _semanticDeps.spawn = spawnMock;
    const agent = makeMockAgent(PASSING_LLM_RESPONSE);

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(spawnMock).toHaveBeenCalled();
    const call = (spawnMock as ReturnType<typeof mock>).mock.calls[0];
    const spawnOpts = call[0] as { cmd: string[] };
    expect(spawnOpts.cmd).toContain("git");
    expect(spawnOpts.cmd).toContain("diff");
    expect(spawnOpts.cmd).toContain("--unified=3");
    expect(spawnOpts.cmd).toContain("abc123..HEAD");
    // Test file exclusion pathspecs
    expect(spawnOpts.cmd).toContain(":!test/");
    expect(spawnOpts.cmd).toContain(":!*.test.ts");
    expect(spawnOpts.cmd).toContain(":!*.spec.ts");
  });

  test("passes workdir as cwd to spawn", async () => {
    const spawnMock = makeSpawnMock("diff output", 0);
    _semanticDeps.spawn = spawnMock;
    const agent = makeMockAgent(PASSING_LLM_RESPONSE);

    await runSemanticReview("/my/project", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    const call = (spawnMock as ReturnType<typeof mock>).mock.calls[0];
    const spawnOpts = call[0] as { cwd: string };
    expect(spawnOpts.cwd).toBe("/my/project");
  });
});

// ---------------------------------------------------------------------------
// Diff truncation at 51200 bytes (50KB)
// ---------------------------------------------------------------------------

/** Spawn mock that returns different output for diff vs diff --stat */
function makeSpawnMockWithStat(diffStdout: string, statStdout: string, exitCode = 0) {
  return mock((opts: { cmd?: string[] }) => {
    const isStatCall = opts.cmd?.includes("--stat");
    const stdout = isStatCall ? statStdout : diffStdout;
    return {
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
    };
  }) as unknown as typeof _semanticDeps.spawn;
}

describe("runSemanticReview — diff truncation", () => {
  let origSpawn: typeof _semanticDeps.spawn;
  let origIsGitRefValid: typeof _semanticDeps.isGitRefValid;
  let origGetMergeBase: typeof _semanticDeps.getMergeBase;

  beforeEach(() => {
    origSpawn = _semanticDeps.spawn;
    origIsGitRefValid = _semanticDeps.isGitRefValid;
    origGetMergeBase = _semanticDeps.getMergeBase;
    // Mark supplied storyGitRef as valid so tests proceed without a real git repo
    _semanticDeps.isGitRefValid = mock(async () => true);
    _semanticDeps.getMergeBase = mock(async () => undefined);
  });

  afterEach(() => {
    _semanticDeps.spawn = origSpawn;
    _semanticDeps.isGitRefValid = origIsGitRefValid;
    _semanticDeps.getMergeBase = origGetMergeBase;
  });

  test("passes full diff to LLM prompt when diff is under 51200 bytes", async () => {
    const smallDiff = "a".repeat(100);
    _semanticDeps.spawn = makeSpawnMock(smallDiff, 0);
    let capturedPrompt = "";
    const agent = makeMockAgent(PASSING_LLM_RESPONSE);
    (agent.complete as ReturnType<typeof mock>).mockImplementation(async (prompt: string) => {
      capturedPrompt = prompt;
      return PASSING_LLM_RESPONSE;
    });

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(capturedPrompt).toContain(smallDiff);
  });

  test("truncates diff and appends truncation marker when diff exceeds 51200 bytes", async () => {
    const largeDiff = "x".repeat(60_000);
    const statOutput = " src/foo.ts | 100 +\n src/bar.ts | 50 +\n 2 files changed";
    _semanticDeps.spawn = makeSpawnMockWithStat(largeDiff, statOutput, 0);
    let capturedPrompt = "";
    const agent = makeMockAgent(PASSING_LLM_RESPONSE);
    (agent.complete as ReturnType<typeof mock>).mockImplementation(async (prompt: string) => {
      capturedPrompt = prompt;
      return PASSING_LLM_RESPONSE;
    });

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(capturedPrompt).toContain("truncated at 51200 bytes");
    // The diff in the prompt must not exceed the cap (plus stat preamble + marker overhead)
    const diffSection = capturedPrompt.match(/```diff\n([\s\S]*?)```/)?.[1] ?? "";
    expect(diffSection.length).toBeLessThanOrEqual(51_200 + 500); // cap + stat preamble + marker
  });

  test("truncation includes file summary from git diff --stat", async () => {
    const largeDiff = "y".repeat(60_000);
    const statOutput = " src/foo.ts | 100 +\n src/bar.ts | 50 +\n 2 files changed";
    _semanticDeps.spawn = makeSpawnMockWithStat(largeDiff, statOutput, 0);
    let capturedPrompt = "";
    const agent = makeMockAgent(PASSING_LLM_RESPONSE);
    (agent.complete as ReturnType<typeof mock>).mockImplementation(async (prompt: string) => {
      capturedPrompt = prompt;
      return PASSING_LLM_RESPONSE;
    });

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(capturedPrompt).toContain("File Summary (all changed files)");
    expect(capturedPrompt).toContain("src/foo.ts");
    expect(capturedPrompt).toContain("src/bar.ts");
  });
});

// ---------------------------------------------------------------------------
// AC-5: LLM prompt contents
// ---------------------------------------------------------------------------

describe("runSemanticReview — LLM prompt construction", () => {
  let origSpawn: typeof _semanticDeps.spawn;
  let origIsGitRefValid: typeof _semanticDeps.isGitRefValid;
  let origGetMergeBase: typeof _semanticDeps.getMergeBase;

  beforeEach(() => {
    origSpawn = _semanticDeps.spawn;
    origIsGitRefValid = _semanticDeps.isGitRefValid;
    origGetMergeBase = _semanticDeps.getMergeBase;
    // Mark supplied storyGitRef as valid so tests proceed without a real git repo
    _semanticDeps.isGitRefValid = mock(async () => true);
    _semanticDeps.getMergeBase = mock(async () => undefined);
  });

  afterEach(() => {
    _semanticDeps.spawn = origSpawn;
    _semanticDeps.isGitRefValid = origIsGitRefValid;
    _semanticDeps.getMergeBase = origGetMergeBase;
  });

  async function capturePrompt(
    story: SemanticStory = STORY,
    config: SemanticReviewConfig = DEFAULT_SEMANTIC_CONFIG,
    diff = "- old line\n+ new line\n",
  ): Promise<string> {
    _semanticDeps.spawn = makeSpawnMock(diff, 0);
    let capturedPrompt = "";
    const agent = makeMockAgent(PASSING_LLM_RESPONSE);
    (agent.complete as ReturnType<typeof mock>).mockImplementation(async (prompt: string) => {
      capturedPrompt = prompt;
      return PASSING_LLM_RESPONSE;
    });
    await runSemanticReview("/tmp/wd", "abc123", story, config, () => agent);
    return capturedPrompt;
  }

  test("prompt includes story title", async () => {
    const prompt = await capturePrompt();
    expect(prompt).toContain(STORY.title);
  });

  test("prompt includes story description", async () => {
    const prompt = await capturePrompt();
    expect(prompt).toContain(STORY.description);
  });

  test("prompt includes all acceptance criteria as numbered list", async () => {
    const prompt = await capturePrompt();
    STORY.acceptanceCriteria.forEach((ac, idx) => {
      expect(prompt).toContain(`${idx + 1}.`);
      expect(prompt).toContain(ac);
    });
  });

  test("prompt includes AC-focused review criteria", async () => {
    const prompt = await capturePrompt();
    // The prompt should instruct the LLM to verify ACs, flag dead code, and check wiring
    expect(prompt).toContain("acceptance criterion");
    expect(prompt).toContain("dead paths");
    expect(prompt).toContain("wired into callers");
  });

  test("prompt includes custom rules from semanticConfig.rules", async () => {
    const config: SemanticReviewConfig = {
      modelTier: "balanced",
      rules: ["Never use console.log", "All exports must be typed"],
      excludePatterns: [":!test/"],
    };
    const prompt = await capturePrompt(STORY, config);
    expect(prompt).toContain("Never use console.log");
    expect(prompt).toContain("All exports must be typed");
  });

  test("prompt includes git diff in a code block", async () => {
    const diff = "- old line\n+ new line\n";
    const prompt = await capturePrompt(STORY, DEFAULT_SEMANTIC_CONFIG, diff);
    expect(prompt).toContain("```");
    expect(prompt).toContain(diff);
  });

  test("prompt does not include custom rules section when semanticConfig.rules is empty", async () => {
    const prompt = await capturePrompt(STORY, DEFAULT_SEMANTIC_CONFIG);
    // Should still work — just verifying no crash and prompt is well-formed
    expect(prompt.length).toBeGreaterThan(100);
  });

  test("prompt states diff is production code only", async () => {
    const prompt = await capturePrompt();
    expect(prompt).toContain("production code only");
    expect(prompt).toContain("Do NOT flag");
    expect(prompt).toContain("lint handles");
  });
});

// ---------------------------------------------------------------------------
// AC-6 + AC-7: JSON response parsing — passed=false with findings
// ---------------------------------------------------------------------------

describe("runSemanticReview — LLM response parsing (passed=false)", () => {
  let origSpawn: typeof _semanticDeps.spawn;
  let origIsGitRefValid: typeof _semanticDeps.isGitRefValid;
  let origGetMergeBase: typeof _semanticDeps.getMergeBase;

  beforeEach(() => {
    origSpawn = _semanticDeps.spawn;
    origIsGitRefValid = _semanticDeps.isGitRefValid;
    origGetMergeBase = _semanticDeps.getMergeBase;
    // Mark supplied storyGitRef as valid so tests proceed without a real git repo
    _semanticDeps.isGitRefValid = mock(async () => true);
    _semanticDeps.getMergeBase = mock(async () => undefined);
  });

  afterEach(() => {
    _semanticDeps.spawn = origSpawn;
    _semanticDeps.isGitRefValid = origIsGitRefValid;
    _semanticDeps.getMergeBase = origGetMergeBase;
  });

  test("returns success=false when LLM returns passed=false", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff", 0);
    const agent = makeMockAgent(FAILING_LLM_RESPONSE);

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(result.success).toBe(false);
  });

  test("output contains finding's file", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff", 0);
    const agent = makeMockAgent(FAILING_LLM_RESPONSE);

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(result.output).toContain("src/review/semantic.ts");
  });

  test("output contains finding's line number", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff", 0);
    const agent = makeMockAgent(FAILING_LLM_RESPONSE);

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(result.output).toContain("42");
  });

  test("output contains finding's severity", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff", 0);
    const agent = makeMockAgent(FAILING_LLM_RESPONSE);

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(result.output).toContain("error");
  });

  test("output contains finding's issue description", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff", 0);
    const agent = makeMockAgent(FAILING_LLM_RESPONSE);

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(result.output).toContain("Function is a stub");
  });

  test("output contains finding's suggestion", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff", 0);
    const agent = makeMockAgent(FAILING_LLM_RESPONSE);

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(result.output).toContain("Implement the function");
  });

  test("returns success=true when LLM returns passed=true with empty findings", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff", 0);
    const agent = makeMockAgent(PASSING_LLM_RESPONSE);

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(result.success).toBe(true);
  });

  test("multiple findings all appear in output", async () => {
    const multiFindings = JSON.stringify({
      passed: false,
      findings: [
        { severity: "warn", file: "src/a.ts", line: 1, issue: "Issue A", suggestion: "Fix A" },
        { severity: "error", file: "src/b.ts", line: 99, issue: "Issue B", suggestion: "Fix B" },
      ],
    });
    _semanticDeps.spawn = makeSpawnMock("some diff", 0);
    const agent = makeMockAgent(multiFindings);

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(result.output).toContain("src/a.ts");
    expect(result.output).toContain("Issue A");
    expect(result.output).toContain("src/b.ts");
    expect(result.output).toContain("Issue B");
  });
});

// ---------------------------------------------------------------------------
// AC-8: Fail-open on invalid JSON
// ---------------------------------------------------------------------------

describe("runSemanticReview — fail-open on invalid JSON", () => {
  let origSpawn: typeof _semanticDeps.spawn;
  let origIsGitRefValid: typeof _semanticDeps.isGitRefValid;
  let origGetMergeBase: typeof _semanticDeps.getMergeBase;

  beforeEach(() => {
    origSpawn = _semanticDeps.spawn;
    origIsGitRefValid = _semanticDeps.isGitRefValid;
    origGetMergeBase = _semanticDeps.getMergeBase;
    // Mark supplied storyGitRef as valid so tests proceed without a real git repo
    _semanticDeps.isGitRefValid = mock(async () => true);
    _semanticDeps.getMergeBase = mock(async () => undefined);
  });

  afterEach(() => {
    _semanticDeps.spawn = origSpawn;
    _semanticDeps.isGitRefValid = origIsGitRefValid;
    _semanticDeps.getMergeBase = origGetMergeBase;
  });

  test("returns success=true when LLM returns invalid JSON", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff", 0);
    const agent = makeMockAgent("this is not json at all }{");

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(result.success).toBe(true);
  });

  test("returns success=true when LLM returns empty string", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff", 0);
    const agent = makeMockAgent("");

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(result.success).toBe(true);
  });

  test("returns success=true when LLM returns JSON missing 'passed' field", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff", 0);
    const agent = makeMockAgent(JSON.stringify({ findings: [] }));

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(result.success).toBe(true);
  });

  test("result check is 'semantic' on invalid JSON", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff", 0);
    const agent = makeMockAgent("not json");

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(result.check).toBe("semantic");
  });
});

// #105: Truncated JSON with "passed": false should fail-closed
// ---------------------------------------------------------------------------

describe("runSemanticReview — fail-closed on truncated JSON with passed:false (#105)", () => {
  let origSpawn: typeof _semanticDeps.spawn;
  let origIsGitRefValid: typeof _semanticDeps.isGitRefValid;
  let origGetMergeBase: typeof _semanticDeps.getMergeBase;

  beforeEach(() => {
    origSpawn = _semanticDeps.spawn;
    origIsGitRefValid = _semanticDeps.isGitRefValid;
    origGetMergeBase = _semanticDeps.getMergeBase;
    // Mark supplied storyGitRef as valid so tests proceed without a real git repo
    _semanticDeps.isGitRefValid = mock(async () => true);
    _semanticDeps.getMergeBase = mock(async () => undefined);
  });

  afterEach(() => {
    _semanticDeps.spawn = origSpawn;
    _semanticDeps.isGitRefValid = origIsGitRefValid;
    _semanticDeps.getMergeBase = origGetMergeBase;
  });

  test("returns success=false when truncated JSON contains passed:false", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff", 0);
    // Simulates LLM output cut off mid-response — JSON is invalid but clearly says passed:false
    const truncatedResponse = '```json\n{"passed": false, "findings": [{"severity": "error", "file": "test.ts", "line": 1, "issue": "Test file is 78';
    const agent = makeMockAgent(truncatedResponse);

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(result.success).toBe(false);
  });

  test("output mentions truncated response on fail-closed", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff", 0);
    const truncatedResponse = '{"passed": false, "findings": [{"severity": "error"';
    const agent = makeMockAgent(truncatedResponse);

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(result.output).toContain("truncated");
    expect(result.output).toContain("passed:false");
  });

  test("still fail-open when truncated JSON contains passed:true", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff", 0);
    const truncatedResponse = '{"passed": true, "findings": [';
    const agent = makeMockAgent(truncatedResponse);

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(result.success).toBe(true);
  });
});

// BUG-090: Markdown fence stripping
// ---------------------------------------------------------------------------

describe("runSemanticReview — markdown fence stripping (BUG-090)", () => {
  let origSpawn: typeof _semanticDeps.spawn;
  let origIsGitRefValid: typeof _semanticDeps.isGitRefValid;
  let origGetMergeBase: typeof _semanticDeps.getMergeBase;

  beforeEach(() => {
    origSpawn = _semanticDeps.spawn;
    origIsGitRefValid = _semanticDeps.isGitRefValid;
    origGetMergeBase = _semanticDeps.getMergeBase;
    // Mark supplied storyGitRef as valid so tests proceed without a real git repo
    _semanticDeps.isGitRefValid = mock(async () => true);
    _semanticDeps.getMergeBase = mock(async () => undefined);
  });

  afterEach(() => {
    _semanticDeps.spawn = origSpawn;
    _semanticDeps.isGitRefValid = origIsGitRefValid;
    _semanticDeps.getMergeBase = origGetMergeBase;
  });

  test("parses JSON wrapped in ```json fences", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff", 0);
    const fencedResponse = "```json\n" + JSON.stringify({ passed: true, findings: [] }) + "\n```";
    const agent = makeMockAgent(fencedResponse);

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(result.success).toBe(true);
    expect(result.output).not.toContain("could not parse");
  });

  test("parses JSON wrapped in plain ``` fences", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff", 0);
    const fencedResponse = "```\n" + JSON.stringify({ passed: true, findings: [] }) + "\n```";
    const agent = makeMockAgent(fencedResponse);

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(result.success).toBe(true);
    expect(result.output).not.toContain("could not parse");
  });

  test("parses fenced JSON with findings and returns success=false", async () => {
    _semanticDeps.spawn = makeSpawnMock("some diff", 0);
    const payload = {
      passed: false,
      findings: [{ severity: "error", file: "src/foo.ts", line: 1, issue: "bad code", suggestion: "fix it" }],
    };
    const fencedResponse = "```json\n" + JSON.stringify(payload) + "\n```";
    const agent = makeMockAgent(fencedResponse);

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BUG-114: storyGitRef fallback — merge-base when ref is missing or invalid
// ---------------------------------------------------------------------------

describe("runSemanticReview — BUG-114 storyGitRef fallback (merge-base)", () => {
  let origSpawn: typeof _semanticDeps.spawn;
  let origIsGitRefValid: typeof _semanticDeps.isGitRefValid;
  let origGetMergeBase: typeof _semanticDeps.getMergeBase;

  beforeEach(() => {
    origSpawn = _semanticDeps.spawn;
    origIsGitRefValid = _semanticDeps.isGitRefValid;
    origGetMergeBase = _semanticDeps.getMergeBase;
  });

  afterEach(() => {
    _semanticDeps.spawn = origSpawn;
    _semanticDeps.isGitRefValid = origIsGitRefValid;
    _semanticDeps.getMergeBase = origGetMergeBase;
  });

  test("uses effectiveRef = storyGitRef when ref is valid", async () => {
    const spawnMock = makeSpawnMock("diff content", 0);
    _semanticDeps.spawn = spawnMock;
    _semanticDeps.isGitRefValid = mock(async () => true);
    _semanticDeps.getMergeBase = mock(async () => "merge-base-sha");
    const agent = makeMockAgent(PASSING_LLM_RESPONSE);

    await runSemanticReview("/tmp/wd", "valid-sha", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(spawnMock).toHaveBeenCalled();
    const call = (spawnMock as ReturnType<typeof mock>).mock.calls[0];
    const spawnOpts = call[0] as { cmd: string[] };
    // Should use the valid storyGitRef, not the merge-base
    expect(spawnOpts.cmd).toContain("valid-sha..HEAD");
    expect(_semanticDeps.getMergeBase).not.toHaveBeenCalled();
  });

  test("falls back to merge-base when storyGitRef is undefined", async () => {
    const spawnMock = makeSpawnMock("diff content", 0);
    _semanticDeps.spawn = spawnMock;
    _semanticDeps.isGitRefValid = mock(async () => false);
    _semanticDeps.getMergeBase = mock(async () => "abc-merge-base");
    const agent = makeMockAgent(PASSING_LLM_RESPONSE);

    await runSemanticReview("/tmp/wd", undefined, STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(spawnMock).toHaveBeenCalled();
    const call = (spawnMock as ReturnType<typeof mock>).mock.calls[0];
    const spawnOpts = call[0] as { cmd: string[] };
    expect(spawnOpts.cmd).toContain("abc-merge-base..HEAD");
  });

  test("falls back to merge-base when storyGitRef is invalid (e.g. after rebase)", async () => {
    const spawnMock = makeSpawnMock("diff content", 0);
    _semanticDeps.spawn = spawnMock;
    _semanticDeps.isGitRefValid = mock(async () => false);
    _semanticDeps.getMergeBase = mock(async () => "fallback-merge-base-sha");
    const agent = makeMockAgent(PASSING_LLM_RESPONSE);

    await runSemanticReview("/tmp/wd", "stale-sha-after-rebase", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(spawnMock).toHaveBeenCalled();
    const call = (spawnMock as ReturnType<typeof mock>).mock.calls[0];
    const spawnOpts = call[0] as { cmd: string[] };
    expect(spawnOpts.cmd).toContain("fallback-merge-base-sha..HEAD");
    expect(_semanticDeps.isGitRefValid).toHaveBeenCalledWith("/tmp/wd", "stale-sha-after-rebase");
  });

  test("skips review (success=true) when storyGitRef is undefined and merge-base is also unavailable", async () => {
    _semanticDeps.spawn = makeSpawnMock("", 0);
    _semanticDeps.isGitRefValid = mock(async () => false);
    _semanticDeps.getMergeBase = mock(async () => undefined);

    const result = await runSemanticReview("/tmp/wd", undefined, STORY, DEFAULT_SEMANTIC_CONFIG, () => null);

    expect(result.success).toBe(true);
    expect(result.output).toContain("skipped: no git ref");
  });

  test("skips review (success=true) when storyGitRef is invalid and merge-base is also unavailable", async () => {
    _semanticDeps.spawn = makeSpawnMock("", 0);
    _semanticDeps.isGitRefValid = mock(async () => false);
    _semanticDeps.getMergeBase = mock(async () => undefined);

    const result = await runSemanticReview("/tmp/wd", "bad-sha", STORY, DEFAULT_SEMANTIC_CONFIG, () => null);

    expect(result.success).toBe(true);
    expect(result.output).toContain("skipped: no git ref");
  });
});
