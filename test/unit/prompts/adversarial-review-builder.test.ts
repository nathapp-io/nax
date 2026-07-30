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
  test.each([
    ["story title", () => STORY.title],
    ["story id", () => STORY.id],
    ["storyGitRef", () => STORY_GIT_REF],
    ["git diff command", () => `git diff --unified=3 ${STORY_GIT_REF}..HEAD`],
  ])("prompt contains %s", (_label, getValue) => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, { mode: "ref", storyGitRef: STORY_GIT_REF });
    expect(result).toContain(getValue());
  });

  test("prompt contains acceptance criteria", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, { mode: "ref", storyGitRef: STORY_GIT_REF });
    expect(result).toContain("Users can log in");
    expect(result).toContain("Sessions expire after 24h");
  });

  test("stat block included when stat provided, omitted when not", () => {
    const stat = "src/auth/login.ts | 10 ++++++++++\n 1 file changed";
    const withStat = builder.buildAdversarialReviewPrompt(STORY, CONFIG, { mode: "ref", storyGitRef: STORY_GIT_REF, stat });
    expect(withStat).toContain(stat);
    expect(withStat).toContain("Changed Files Summary");

    const withoutStat = builder.buildAdversarialReviewPrompt(STORY, CONFIG, { mode: "ref", storyGitRef: STORY_GIT_REF });
    expect(withoutStat).not.toContain("Changed Files Summary");
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

describe("AdversarialReviewPromptBuilder — placeholder-test carve-out (#2) and inspection trail (#3A)", () => {
  test("instructs emitting placeholder/tautological tests as error/test-gap", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, { mode: "ref", storyGitRef: STORY_GIT_REF });
    expect(result).toContain("expect(true).toBe(true)");
    expect(result).toContain('`category:"test-gap"`');
    // The carve-out must override the "AC names the file but not the symbol" trap.
    expect(result).toContain("The symbol-naming requirement is waived for this category.");
  });

  test("output schema requires an inspectedFiles trail and forbids rubber-stamping", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, { mode: "ref", storyGitRef: STORY_GIT_REF });
    expect(result).toContain('"inspectedFiles"');
    expect(result).toContain("No rubber-stamping");
  });

  test("forbids reporting compliance as a finding, and offers actionRequired instead (#1359)", () => {
    // The reviewer emitted "correct per Out of Scope #10 … No action needed" AS a
    // finding, and nbf then paid an implementer to fix it. The prompt is the primary
    // guard; the actionability filter is the backstop.
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, { mode: "ref", storyGitRef: STORY_GIT_REF });
    expect(result).toContain("Do not report compliance as a finding");
    expect(result).toContain('"actionRequired"');
    expect(result).toContain("actionRequired: false");
  });

  test("demandInspection re-prompt names inspectedFiles and demands tool use", () => {
    const reprompt = AdversarialReviewPromptBuilder.demandInspection();
    expect(reprompt).toContain("inspectedFiles");
    expect(reprompt).toContain("did not open any of the changed files");
  });
});

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
    expect(result).toContain('"warning"');
    expect(result).toContain('"info"');
    expect(result).toContain('"unverifiable"');
  });
});

// ─── role section ─────────────────────────────────────────────────────────────

describe("AdversarialReviewPromptBuilder — role section", () => {
  test.each([
    ["adversarial role description", "find what is WRONG"],
    ["adversarial reviewer identity", "adversarial code reviewer"],
  ])("prompt contains %s", (_label, expected) => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });
    expect(result).toContain(expected);
  });
});

// ─── no diff available ────────────────────────────────────────────────────────

describe("AdversarialReviewPromptBuilder — no diff available", () => {
  test.each<[string, Parameters<typeof builder.buildAdversarialReviewPrompt>[2]]>([
    ["embedded mode without diff", { mode: "embedded" }],
    ["ref mode without storyGitRef", { mode: "ref" }],
  ])("fallback message appears for %s", (_label, diffContext) => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, diffContext);
    expect(result).toContain("No diff available");
  });
});

// ─── prior adversarial iterations (ADR-022 phase 5) ──────────────────────────

describe("AdversarialReviewPromptBuilder — priorAdversarialIterations", () => {
  const PRIOR_ITERATIONS = [
    {
      iterationNum: 1,
      findingsBefore: [],
      fixesApplied: [{ strategyName: "source-fix", op: "source-fix", targetFiles: ["src/auth/login.ts"], summary: "", costUsd: 0 }],
      findingsAfter: [
        {
          source: "adversarial-review" as const,
          severity: "error" as const,
          category: "error-path",
          file: "src/auth/login.ts",
          line: 42,
          message: "Null pointer dereference on empty input",
        },
        {
          source: "adversarial-review" as const,
          severity: "warning" as const,
          category: "convention",
          file: "src/auth/session.ts",
          message: "Missing storyId in logger call",
        },
      ],
      outcome: "partial" as const,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
    },
  ];

  test("prior iterations block: header, round, outcome, finding, file:line, count, ordering", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
      priorAdversarialIterations: PRIOR_ITERATIONS,
    });
    expect(result).toContain("## Prior Iterations — verdict required before new analysis");
    expect(result).toContain("### Round 1");
    expect(result).toContain("partial");
    expect(result).toContain("Null pointer dereference on empty input");
    expect(result).toContain("(0 → 2)");
    expect(result).toContain("src/auth/login.ts:42");
    const priorIdx = result.indexOf("## Prior Iterations");
    expect(priorIdx).toBeLessThan(result.indexOf("## Story Under Review"));
  });

  test("no prior iterations block when undefined or empty array", () => {
    const undef = builder.buildAdversarialReviewPrompt(STORY, CONFIG, { mode: "ref", storyGitRef: STORY_GIT_REF });
    expect(undef).not.toContain("## Prior Iterations");

    const empty = builder.buildAdversarialReviewPrompt(STORY, CONFIG, { mode: "ref", storyGitRef: STORY_GIT_REF, priorAdversarialIterations: [] });
    expect(empty).not.toContain("## Prior Iterations");
  });

  test("unchanged outcome note appears when an iteration outcome is unchanged", () => {
    const unchangedIteration = {
      ...PRIOR_ITERATIONS[0],
      outcome: "unchanged" as const,
    };
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
      priorAdversarialIterations: [unchangedIteration],
    });
    expect(result).toContain("FALSIFIED");
  });
});

// ─── Issue #987: Implementation-axis grounding ─────────────────────────────────

describe("AdversarialReviewPromptBuilder — verifiedBy implementation-axis grounding (#987)", () => {
  test("OUTPUT_SCHEMA includes verifiedBy field in JSON template", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });
    expect(result).toContain("verifiedBy");
    expect(result).toContain("observed");
  });

  test("instructions require verifiedBy.observed for every error finding", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });
    expect(result).toContain("verifiedBy.observed");
    expect(result.toLowerCase()).toContain("verbatim");
    expect(result).toContain('blocking threshold is `"error"`');
  });

  test("instructions align verifiedBy requirement with warning blocking threshold", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
      blockingThreshold: "warning",
    });
    expect(result).toContain('blocking threshold is `"warning"`');
    expect(result).toContain('`"error"` and `"warning"`');
    expect(result).toContain("MUST include `verifiedBy.observed`");
  });

  test("passed guidance aligns with info blocking threshold", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
      blockingThreshold: "info",
    });
    expect(result).toContain('blocking threshold is `"info"`');
    expect(result).toContain('`"error"`, `"warning"`, and `"info"`');
    expect(result).toContain("`passed` must be `false` if any finding has blocking severity");
    expect(result).toContain('advisory (`"unverifiable"`)');
    expect(result).not.toContain('all findings are `"info"` or `"unverifiable"`');
  });

  test("instructions tell LLM to downgrade rather than fabricate quotes", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });
    expect(result.toLowerCase()).toContain("downgrade");
  });
});

// ─── AC-grounding prohibition text (#1033 Obs 1) ──────────────────────────────

describe("AdversarialReviewPromptBuilder — AC-grounding explicit prohibition", () => {
  test("prompt contains explicit Do NOT write acQuote prohibition", () => {
    const prompt = builder.buildAdversarialReviewPrompt(STORY, CONFIG, { mode: "ref", storyGitRef: STORY_GIT_REF });
    expect(prompt).toContain("Do NOT write an `acQuote` that does not appear verbatim");
  });

  test("prompt instructs to set severity to warning rather than fabricating", () => {
    const prompt = builder.buildAdversarialReviewPrompt(STORY, CONFIG, { mode: "ref", storyGitRef: STORY_GIT_REF });
    expect(prompt).toContain("never approximate, paraphrase, or synthesise a quote");
  });
});

// ─── Feature-level out-of-scope rendering ─────────────────────────────────────
// Reviewers hand-render their own story block (not via buildStorySection), so
// this is the only path by which the propagated story.outOfScope list reaches
// them. The numbering is load-bearing: scopeIndex is a 1-based index into it.

const OUT_OF_SCOPE = ["An interactive Ink TUI", "Per-story diffs or checkpoints"];

function makeScopeStory(outOfScope?: string[]): SemanticStory {
  return {
    id: "US-001",
    title: "Reconstruct the run timeline",
    description: "Build the replay core.",
    acceptanceCriteria: ["When a run id is given, then a RunTimeline is returned"],
    ...(outOfScope ? { outOfScope } : {}),
  };
}

function adversarialPrompt(story: SemanticStory): string {
  return new AdversarialReviewPromptBuilder().buildAdversarialReviewPrompt(
    story,
    { model: "balanced", diffMode: "ref", rules: [] } as unknown as AdversarialReviewConfig,
    { mode: "ref", storyGitRef: "abc123", stat: " src/a.ts | 2 +-" },
  );
}

describe("adversarial review prompt", () => {
  test("includes the numbered out-of-scope list", () => {
    const prompt = adversarialPrompt(makeScopeStory(OUT_OF_SCOPE));
    expect(prompt).toContain("Out of Scope (feature-level — NOT acceptance criteria)");
    expect(prompt).toContain("2. Per-story diffs or checkpoints");
  });

  test("instructs scope findings to cite scopeQuote and stay at warning severity", () => {
    const prompt = adversarialPrompt(makeScopeStory(OUT_OF_SCOPE));
    expect(prompt).toContain('"out-of-scope"');
    expect(prompt).toContain("scopeQuote");
    expect(prompt).toContain('Emit scope-violation findings as `"warning"` — never `"error"`');
  });

  test("advertises scopeQuote / scopeIndex in the output schema", () => {
    const prompt = adversarialPrompt(makeScopeStory(OUT_OF_SCOPE));
    expect(prompt).toContain('"scopeQuote"');
    expect(prompt).toContain('"scopeIndex"');
  });

  test("omits the block when the story declares no exclusions", () => {
    expect(adversarialPrompt(makeScopeStory())).not.toContain("Out of Scope (feature-level");
  });
});
