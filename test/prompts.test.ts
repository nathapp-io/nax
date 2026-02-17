/**
 * Prompt builder tests
 */

import { describe, test, expect } from "bun:test";
import { buildSingleSessionPrompt, buildBatchPrompt } from "../src/execution/prompts";
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
