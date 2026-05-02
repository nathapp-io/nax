/**
 * Unit tests for src/prompts/builders/adversarial-review-builder.ts
 *
 * Covers:
 * - ref mode: story block, git diff command with storyGitRef, stat block
 * - embedded mode: full diff code block, testInventory untested files, diff without inventory
 * - custom rules: included in prompt when present
 * - prior failures: escalation attempt context included
 * - output schema: passed field and severity values present
 * - role section: adversarial cognitive stance ("find what is WRONG")
 * - no diff available: fallback message when neither diff nor storyGitRef provided
 */

import { describe, expect, test } from "bun:test";
import { AdversarialReviewPromptBuilder } from "../../../src/prompts/builders/adversarial-review-builder";
import type { AdversarialReviewConfig } from "../../../src/review/types";
import type { SemanticStory } from "../../../src/review/types";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const STORY: SemanticStory = {
  id: "STORY-001",
  title: "Add user auth",
  description: "Implements authentication",
  acceptanceCriteria: ["Users can log in", "Sessions expire after 24h"],
};

const CONFIG: AdversarialReviewConfig = {
  model: "balanced",
  diffMode: "ref",
  rules: [],
  timeoutMs: 180_000,
  excludePatterns: [],
  parallel: false,
  maxConcurrentSessions: 2,
};

const STORY_GIT_REF = "abc1234def";

const DIFF = `diff --git a/src/auth/login.ts b/src/auth/login.ts
+export async function login(user: string, pass: string) {}`;

// ─── Helpers ───────────────────────────────────────────────────────────────────

const builder = new AdversarialReviewPromptBuilder();

// ─── ref mode ─────────────────────────────────────────────────────────────────

describe("AdversarialReviewPromptBuilder — ref mode", () => {
  test("prompt contains story title", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });

    expect(result).toContain(STORY.title);
  });

  test("prompt contains story id", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });

    expect(result).toContain(STORY.id);
  });

  test("prompt contains acceptance criteria", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });

    expect(result).toContain("Users can log in");
    expect(result).toContain("Sessions expire after 24h");
  });

  test("prompt contains the ref-based diff section with git diff command", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });

    expect(result).toContain(`git diff --unified=3 ${STORY_GIT_REF}..HEAD`);
  });

  test("prompt contains the storyGitRef as baseline ref label", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });

    expect(result).toContain(STORY_GIT_REF);
  });

  test("prompt contains stat block when stat is provided", () => {
    const stat = "src/auth/login.ts | 10 ++++++++++\n 1 file changed";
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
      stat,
    });

    expect(result).toContain(stat);
    expect(result).toContain("Changed Files Summary");
  });

  test("stat block is omitted when stat is not provided", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });

    expect(result).not.toContain("Changed Files Summary");
  });

  test("ref mode uses resolver-provided test patterns in test-audit workflow", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
      testGlobs: ["**/*_test.go", "tests/test_*.py"],
      refExcludePatterns: [":!*_test.go", ":!tests/test_*.py"],
    });

    expect(result).toContain("**/*_test.go");
    expect(result).toContain("tests/test_*.py");
    expect(result).toContain(":!*_test.go");
  });

  test("ref mode does not include hardcoded TypeScript test layout literals", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
      testGlobs: ["**/*_test.go"],
      refExcludePatterns: [":!*_test.go"],
    });

    expect(result).not.toContain("src/**.ts");
    expect(result).not.toContain("test/**/**.test.ts");
  });
});

// ─── embedded mode ────────────────────────────────────────────────────────────

describe("AdversarialReviewPromptBuilder — embedded mode", () => {
  test("prompt contains the full diff in a diff code block", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "embedded",
      diff: DIFF,
    });

    expect(result).toContain("```diff\n" + DIFF);
  });

  test("prompt includes untested source files from testInventory", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "embedded",
      diff: DIFF,
      testInventory: {
        addedTestFiles: [],
        newSourceFilesWithoutTests: ["src/auth/login.ts", "src/auth/session.ts"],
      },
    });

    expect(result).toContain("src/auth/login.ts");
    expect(result).toContain("src/auth/session.ts");
    expect(result).toContain("## Test Audit");
  });

  test("prompt still contains diff when testInventory is not provided", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "embedded",
      diff: DIFF,
    });

    expect(result).toContain(DIFF);
  });

  test("test audit block is omitted when all source files have matching tests", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "embedded",
      diff: DIFF,
      testInventory: {
        addedTestFiles: ["test/unit/auth/login.test.ts"],
        newSourceFilesWithoutTests: [],
      },
    });

    // The dynamic "## Test Audit" section (from TestInventory) should not appear
    // when newSourceFilesWithoutTests is empty. Note: the static heuristics block
    // contains "Test Audit Gap" — we check for the dynamic section header specifically.
    expect(result).not.toContain("## Test Audit");
  });
});

// ─── custom rules ─────────────────────────────────────────────────────────────

describe("AdversarialReviewPromptBuilder — custom rules", () => {
  test("prompt contains custom rule text when rules are set in config", () => {
    const configWithRules: AdversarialReviewConfig = {
      ...CONFIG,
      rules: ["Always check for missing storyId in logger calls", "Flag any direct spawn() without _deps"],
    };

    const result = builder.buildAdversarialReviewPrompt(STORY, configWithRules, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });

    expect(result).toContain("Always check for missing storyId in logger calls");
    expect(result).toContain("Flag any direct spawn() without _deps");
  });

  test("custom rules section is omitted when rules array is empty", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });

    expect(result).not.toContain("Project-Specific Adversarial Rules");
  });
});

// ─── prior failures ───────────────────────────────────────────────────────────

describe("AdversarialReviewPromptBuilder — prior failures", () => {
  test("prompt contains escalation attempt text when priorFailures are provided", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
      priorFailures: [
        {
          attempt: 1,
          tier: "fast",
          findings: [{ severity: "error", description: "Missing null check" }],
        },
      ],
    });

    expect(result).toContain("escalation attempt");
  });

  test("no escalation block when priorFailures is empty", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
      priorFailures: [],
    });

    expect(result).not.toContain("escalation attempt");
  });
});

// ─── output schema ────────────────────────────────────────────────────────────

describe("AdversarialReviewPromptBuilder — output schema", () => {
  test('prompt contains "passed" field in output schema', () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });

    expect(result).toContain('"passed"');
  });

  test("prompt contains severity values in output schema", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });

    expect(result).toContain('"error"');
    expect(result).toContain('"warn"');
    expect(result).toContain('"info"');
    expect(result).toContain('"unverifiable"');
  });
});

// ─── role section ─────────────────────────────────────────────────────────────

describe("AdversarialReviewPromptBuilder — role section", () => {
  test('prompt contains adversarial role description ("find what is WRONG")', () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });

    expect(result).toContain("find what is WRONG");
  });

  test("prompt contains adversarial reviewer identity declaration", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });

    expect(result).toContain("adversarial code reviewer");
  });
});

// ─── no diff available ────────────────────────────────────────────────────────

describe("AdversarialReviewPromptBuilder — no diff available", () => {
  test("fallback message appears when neither diff nor storyGitRef are provided", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "embedded",
      // no diff, no storyGitRef
    });

    expect(result).toContain("No diff available");
  });

  test("fallback message present when mode is ref but no storyGitRef provided", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      // storyGitRef intentionally omitted
    });

    expect(result).toContain("No diff available");
  });
});

// ─── prior adversarial findings (issue #736) ──────────────────────────────────

describe("AdversarialReviewPromptBuilder — priorAdversarialFindings", () => {
  const PRIOR_FINDINGS = {
    round: 1,
    findings: [
      {
        severity: "error",
        category: "error-path",
        file: "src/auth/login.ts",
        line: 42,
        issue: "Null pointer dereference on empty input",
      },
      {
        severity: "warn",
        category: "convention",
        file: "src/auth/session.ts",
        issue: "Missing storyId in logger call",
      },
    ],
  };

  test("prior findings block appears when priorAdversarialFindings is set", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
      priorAdversarialFindings: PRIOR_FINDINGS,
    });
    expect(result).toContain("Prior Adversarial Findings — Round 1");
  });

  test("prior findings block contains the correct round number", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
      priorAdversarialFindings: { round: 3, findings: PRIOR_FINDINGS.findings },
    });
    expect(result).toContain("Round 3");
  });

  test("prior findings block contains finding severity, file:line, category, and issue", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
      priorAdversarialFindings: PRIOR_FINDINGS,
    });
    expect(result).toContain("src/auth/login.ts:42");
    expect(result).toContain("Null pointer dereference on empty input");
    expect(result).toContain("error-path");
    expect(result).toContain("src/auth/session.ts");
    expect(result).toContain("Missing storyId in logger call");
  });

  test("prior findings block appears before the story block (verdict-first)", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
      priorAdversarialFindings: PRIOR_FINDINGS,
    });
    const priorFindingsIdx = result.indexOf("Prior Adversarial Findings");
    const storyIdx = result.indexOf("## Story Under Review");
    expect(priorFindingsIdx).toBeGreaterThanOrEqual(0);
    expect(priorFindingsIdx).toBeLessThan(storyIdx);
  });

  test("prior findings block instructs reviewer to verdict prior issues first", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
      priorAdversarialFindings: PRIOR_FINDINGS,
    });
    expect(result).toContain("Verdict on each of these first");
  });

  test("finding with no line number renders file path without colon-line suffix", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
      priorAdversarialFindings: {
        round: 1,
        findings: [{ severity: "warn", file: "src/utils.ts", issue: "Unhandled promise rejection" }],
      },
    });
    expect(result).toContain("src/utils.ts");
    // Location cell should be "src/utils.ts" without a trailing colon+line
    const tableRowIdx = result.indexOf("Unhandled promise rejection");
    const rowText = result.slice(result.lastIndexOf("|", tableRowIdx), tableRowIdx + 30);
    expect(rowText).not.toMatch(/src\/utils\.ts:\d/);
  });

  test("no prior findings block when priorAdversarialFindings is undefined", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });
    expect(result).not.toContain("Prior Adversarial Findings");
  });

  test("no prior findings block when findings array is empty", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
      priorAdversarialFindings: { round: 1, findings: [] },
    });
    expect(result).not.toContain("Prior Adversarial Findings");
  });
});
