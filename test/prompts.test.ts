/**
 * Prompt builder tests
 */

import { describe, test, expect } from "bun:test";
import { buildSingleSessionPrompt, buildBatchPrompt } from "../src/execution/prompts";
import { buildVerifierPrompt } from "../src/tdd/prompts";
import type { UserStory } from "../src/prd";
import type { ConstitutionResult } from "../src/constitution";

const mockStory: UserStory = {
  id: "US-001",
  title: "Add login endpoint",
  description: "Implement POST /api/login endpoint",
  acceptanceCriteria: [
    "Accepts username and password",
    "Returns JWT token on success",
    "Returns 401 on invalid credentials",
  ],
  tags: [],
  dependencies: [],
  status: "pending",
  passes: false,
  escalations: [],
  attempts: 0,
};

const mockConstitution: ConstitutionResult = {
  content: "# Constitution\n\n- Use TypeScript\n- Write tests\n- No console.log",
  tokens: 15,
  truncated: false,
};

describe("buildSingleSessionPrompt", () => {
  test("builds basic prompt without context or constitution", () => {
    const prompt = buildSingleSessionPrompt(mockStory);

    expect(prompt).toContain("# Task: Add login endpoint");
    expect(prompt).toContain("Implement POST /api/login endpoint");
    expect(prompt).toContain("Accepts username and password");
    expect(prompt).toContain("Returns JWT token on success");
    expect(prompt).toContain("test-after approach");
  });

  test("includes context when provided", () => {
    const context = "## Relevant Files\n\n- src/auth.ts\n- src/jwt.ts";
    const prompt = buildSingleSessionPrompt(mockStory, context);

    expect(prompt).toContain("# Task: Add login endpoint");
    expect(prompt).toContain("## Relevant Files");
    expect(prompt).toContain("src/auth.ts");
  });

  test("includes constitution when provided", () => {
    const prompt = buildSingleSessionPrompt(mockStory, undefined, mockConstitution);

    expect(prompt).toContain("# CONSTITUTION (follow these rules strictly)");
    expect(prompt).toContain("Use TypeScript");
    expect(prompt).toContain("Write tests");
    expect(prompt).toContain("No console.log");
    expect(prompt).toContain("# Task: Add login endpoint");
  });

  test("includes both constitution and context", () => {
    const context = "## Relevant Files\n\n- src/auth.ts";
    const prompt = buildSingleSessionPrompt(mockStory, context, mockConstitution);

    expect(prompt).toContain("# CONSTITUTION");
    expect(prompt).toContain("# Task: Add login endpoint");
    expect(prompt).toContain("## Relevant Files");

    // Constitution should come before context
    const constitutionPos = prompt.indexOf("# CONSTITUTION");
    const contextPos = prompt.indexOf("## Relevant Files");
    expect(constitutionPos).toBeLessThan(contextPos);
  });

  test("uses separator between sections", () => {
    const context = "## Context";
    const prompt = buildSingleSessionPrompt(mockStory, context, mockConstitution);

    expect(prompt).toContain("---");
  });
});

describe("buildBatchPrompt", () => {
  const mockStories: UserStory[] = [
    {
      id: "US-001",
      title: "Add login endpoint",
      description: "Implement POST /api/login",
      acceptanceCriteria: ["Returns JWT token"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    },
    {
      id: "US-002",
      title: "Add logout endpoint",
      description: "Implement POST /api/logout",
      acceptanceCriteria: ["Invalidates JWT token"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    },
  ];

  test("builds batch prompt for multiple stories", () => {
    const prompt = buildBatchPrompt(mockStories);

    expect(prompt).toContain("# Batch Task: 2 Stories");
    expect(prompt).toContain("Story 1: US-001 — Add login endpoint");
    expect(prompt).toContain("Story 2: US-002 — Add logout endpoint");
    expect(prompt).toContain("Implement POST /api/login");
    expect(prompt).toContain("Implement POST /api/logout");
    expect(prompt).toContain("Commit each story separately");
  });

  test("includes context when provided", () => {
    const context = "## Auth Module\n\nUse JWT lib";
    const prompt = buildBatchPrompt(mockStories, context);

    expect(prompt).toContain("# Batch Task: 2 Stories");
    expect(prompt).toContain("## Auth Module");
    expect(prompt).toContain("Use JWT lib");
  });

  test("includes constitution when provided", () => {
    const prompt = buildBatchPrompt(mockStories, undefined, mockConstitution);

    expect(prompt).toContain("# CONSTITUTION (follow these rules strictly)");
    expect(prompt).toContain("Use TypeScript");
    expect(prompt).toContain("# Batch Task: 2 Stories");
  });

  test("includes both constitution and context", () => {
    const context = "## Context";
    const prompt = buildBatchPrompt(mockStories, context, mockConstitution);

    expect(prompt).toContain("# CONSTITUTION");
    expect(prompt).toContain("# Batch Task");
    expect(prompt).toContain("## Context");

    // Constitution should come before context
    const constitutionPos = prompt.indexOf("# CONSTITUTION");
    const contextPos = prompt.indexOf("## Context");
    expect(constitutionPos).toBeLessThan(contextPos);
  });

  test("lists all acceptance criteria for each story", () => {
    const prompt = buildBatchPrompt(mockStories);

    expect(prompt).toContain("Returns JWT token");
    expect(prompt).toContain("Invalidates JWT token");
  });
});

describe("ASSET_CHECK Error Formatting (BUG-18) - Context Integration", () => {
  test("context markdown with ASSET_CHECK errors should be included in prompt", () => {
    const story: UserStory = {
      id: "US-001",
      title: "Add finder module",
      description: "Implement finder functionality",
      acceptanceCriteria: ["Finder works", "Tests pass"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 3,
    };

    // Simulate context markdown with ASSET_CHECK formatting (from context builder)
    const contextMarkdown = `## ⚠️ MANDATORY: Missing Files from Previous Attempts

**CRITICAL:** Previous attempts failed because these files were not created.
You MUST create these exact files. Do NOT use alternative filenames.

**Required files:**
- \`src/finder.ts\`
- \`test/finder.test.ts\``;

    const prompt = buildSingleSessionPrompt(story, contextMarkdown);

    // Should contain mandatory file creation instructions from context
    expect(prompt).toContain("MANDATORY");
    expect(prompt).toContain("MUST create these exact files");
    expect(prompt).toContain("src/finder.ts");
    expect(prompt).toContain("test/finder.test.ts");
    expect(prompt).toContain("Do NOT use alternative filenames");
  });

  test("ASSET_CHECK context should appear BEFORE story description in final prompt", () => {
    const story: UserStory = {
      id: "US-001",
      title: "Add finder module",
      description: "Implement finder functionality",
      acceptanceCriteria: ["Finder works"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 2,
    };

    const contextMarkdown = `## ⚠️ MANDATORY: Missing Files from Previous Attempts

**Required files:**
- \`src/finder.ts\``;

    const prompt = buildSingleSessionPrompt(story, contextMarkdown);

    const mandatoryPos = prompt.indexOf("MANDATORY");
    const descriptionPos = prompt.indexOf("Implement finder functionality");

    expect(mandatoryPos).toBeGreaterThan(0);
    expect(descriptionPos).toBeGreaterThan(0);
    // Context comes after task in the prompt builder
    expect(descriptionPos).toBeLessThan(mandatoryPos);
  });

  test("context with normal prior errors should not have MANDATORY formatting", () => {
    const story: UserStory = {
      id: "US-001",
      title: "Add feature",
      description: "Add new feature",
      acceptanceCriteria: ["Feature works"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 1,
    };

    const contextMarkdown = `## Prior Errors

\`\`\`
TypeError: Cannot read property 'foo' of undefined
Test failed: expected 42, got 41
\`\`\``;

    const prompt = buildSingleSessionPrompt(story, contextMarkdown);

    // Should contain normal error formatting
    expect(prompt).toContain("Prior Errors");
    expect(prompt).toContain("TypeError: Cannot read property 'foo' of undefined");

    // Should NOT contain mandatory file creation instructions
    expect(prompt).not.toContain("MANDATORY");
  });

  test("context with mixed ASSET_CHECK and normal errors", () => {
    const story: UserStory = {
      id: "US-001",
      title: "Add module",
      description: "Add new module",
      acceptanceCriteria: ["Module works"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 2,
    };

    const contextMarkdown = `## ⚠️ MANDATORY: Missing Files from Previous Attempts

**Required files:**
- \`src/module.ts\`
- \`test/module.test.ts\`

## Prior Errors

\`\`\`
TypeError: Module not found
Test failed: module.foo is not a function
\`\`\``;

    const prompt = buildSingleSessionPrompt(story, contextMarkdown);

    // Should contain both ASSET_CHECK and normal errors
    expect(prompt).toContain("MANDATORY");
    expect(prompt).toContain("src/module.ts");
    expect(prompt).toContain("test/module.test.ts");
    expect(prompt).toContain("Prior Errors");
    expect(prompt).toContain("TypeError: Module not found");
  });

  test("story without context should not include error sections", () => {
    const story: UserStory = {
      id: "US-001",
      title: "Add feature",
      description: "Add new feature",
      acceptanceCriteria: ["Feature works"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const prompt = buildSingleSessionPrompt(story);

    expect(prompt).not.toContain("MANDATORY");
    expect(prompt).not.toContain("Prior Errors");
    expect(prompt).not.toContain("ASSET_CHECK");
  });

  test("batch prompt with ASSET_CHECK context", () => {
    const stories: UserStory[] = [
      {
        id: "US-001",
        title: "Story 1",
        description: "First story",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 1,
      },
      {
        id: "US-002",
        title: "Story 2",
        description: "Second story",
        acceptanceCriteria: ["AC2"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
      },
    ];

    const contextMarkdown = `## ⚠️ MANDATORY: Missing Files from Previous Attempts

**Required files:**
- \`src/story1.ts\``;

    const prompt = buildBatchPrompt(stories, contextMarkdown);

    // Should contain ASSET_CHECK instructions
    expect(prompt).toContain("MANDATORY");
    expect(prompt).toContain("src/story1.ts");

    // Should still contain both stories
    expect(prompt).toContain("Story 1: US-001");
    expect(prompt).toContain("Story 2: US-002");
  });
});

describe("buildVerifierPrompt", () => {
  const verifierStory: UserStory = {
    id: "US-003",
    title: "Add payment processing",
    description: "Implement Stripe payment integration",
    acceptanceCriteria: [
      "Accepts credit card payments",
      "Returns payment confirmation",
      "Handles payment failures gracefully",
    ],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
  };

  test("includes session 3 header", () => {
    const prompt = buildVerifierPrompt(verifierStory);
    expect(prompt).toContain("Session 3: Verify");
  });

  test("includes story title", () => {
    const prompt = buildVerifierPrompt(verifierStory);
    expect(prompt).toContain("Add payment processing");
  });

  test("includes all 5 tasks", () => {
    const prompt = buildVerifierPrompt(verifierStory);
    expect(prompt).toContain("1. Run all tests and verify they pass");
    expect(prompt).toContain("2. Review the implementation for quality and correctness");
    expect(prompt).toContain("3. Check that the implementation meets all acceptance criteria");
    expect(prompt).toContain("4. Check if test files were modified by the implementer");
    expect(prompt).toContain("5. If any issues exist, fix them minimally");
  });

  test("includes acceptance criteria", () => {
    const prompt = buildVerifierPrompt(verifierStory);
    expect(prompt).toContain("1. Accepts credit card payments");
    expect(prompt).toContain("2. Returns payment confirmation");
    expect(prompt).toContain("3. Handles payment failures gracefully");
  });

  test("includes verdict file instructions", () => {
    const prompt = buildVerifierPrompt(verifierStory);
    expect(prompt).toContain(".nax-verifier-verdict.json");
    expect(prompt).toContain("IMPORTANT — Write Verdict File");
  });

  test("includes full JSON schema example", () => {
    const prompt = buildVerifierPrompt(verifierStory);
    expect(prompt).toContain('"version": 1');
    expect(prompt).toContain('"approved": true');
    expect(prompt).toContain('"tests"');
    expect(prompt).toContain('"allPassing"');
    expect(prompt).toContain('"passCount"');
    expect(prompt).toContain('"failCount"');
    expect(prompt).toContain('"testModifications"');
    expect(prompt).toContain('"detected"');
    expect(prompt).toContain('"legitimate"');
    expect(prompt).toContain('"reasoning"');
    expect(prompt).toContain('"acceptanceCriteria"');
    expect(prompt).toContain('"allMet"');
    expect(prompt).toContain('"criteria"');
    expect(prompt).toContain('"quality"');
    expect(prompt).toContain('"rating"');
    expect(prompt).toContain('"issues"');
    expect(prompt).toContain('"fixes"');
  });

  test("specifies when to set approved=false", () => {
    const prompt = buildVerifierPrompt(verifierStory);
    expect(prompt).toContain("approved: false");
    expect(prompt).toContain("Tests are failing and you cannot fix them");
    expect(prompt).toContain("loosened test assertions to mask bugs");
    expect(prompt).toContain("Critical acceptance criteria are not met");
    expect(prompt).toContain("Code quality is poor");
  });

  test("specifies when to set approved=true", () => {
    const prompt = buildVerifierPrompt(verifierStory);
    expect(prompt).toContain("approved: true");
    expect(prompt).toContain("All tests pass");
    expect(prompt).toContain("Implementation is clean and follows conventions");
    expect(prompt).toContain("All acceptance criteria met");
    expect(prompt).toContain("Any test modifications by implementer are legitimate fixes");
  });

  test("includes commit message instruction with story title", () => {
    const prompt = buildVerifierPrompt(verifierStory);
    expect(prompt).toContain("fix: verify and adjust Add payment processing");
  });

  test("existing prompt content preserved — tasks 1-5 all present", () => {
    const prompt = buildVerifierPrompt(verifierStory);
    // Task 1
    expect(prompt).toContain("Run all tests and verify they pass");
    // Task 2
    expect(prompt).toContain("Review the implementation for quality and correctness");
    // Task 3
    expect(prompt).toContain("Check that the implementation meets all acceptance criteria");
    // Task 4
    expect(prompt).toContain("NOT just loosening assertions to mask bugs");
    // Task 5
    expect(prompt).toContain("fix them minimally");
  });

  test("includes write location instruction for verdict file", () => {
    const prompt = buildVerifierPrompt(verifierStory);
    expect(prompt).toContain("project root");
  });
});
