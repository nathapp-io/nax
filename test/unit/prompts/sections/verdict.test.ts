import { describe, expect, test } from "bun:test";
import type { UserStory } from "../../../../src/prd/types";
import { buildVerdictSection } from "../../../../src/prompts/sections/verdict";

describe("buildVerdictSection", () => {
  const mockStory: UserStory = {
    id: "STORY-001",
    title: "Verify Feature",
    description: "A feature to verify",
    acceptanceCriteria: ["Criterion 1", "Criterion 2"],
    status: "pending",
    passes: false,
    dependencies: [],
    tags: [],
  };

  test("includes JSON schema example", () => {
    const result = buildVerdictSection(mockStory);
    expect(result).toContain("```json");
    expect(result).toContain("version");
    expect(result).toContain("approved");
  });

  test("includes verdict file instructions", () => {
    const result = buildVerdictSection(mockStory);
    expect(result).toContain(".nax-verifier-verdict.json");
  });

  test("includes all required verdict fields", () => {
    const result = buildVerdictSection(mockStory);
    expect(result).toContain("version");
    expect(result).toContain("approved");
    expect(result).toContain("tests");
    expect(result).toContain("testModifications");
    expect(result).toContain("acceptanceCriteria");
    expect(result).toContain("quality");
    expect(result).toContain("fixes");
    expect(result).toContain("reasoning");
  });

  test("includes rating options", () => {
    const result = buildVerdictSection(mockStory);
    expect(result).toContain("good");
    expect(result).toContain("acceptable");
    expect(result).toContain("poor");
  });

  test("includes approval conditions", () => {
    const result = buildVerdictSection(mockStory);
    expect(result).toContain("Set `approved: true`");
    expect(result).toContain("Set `approved: false`");
  });

  test("marks acceptance criteria and quality fields advisory", () => {
    const result = buildVerdictSection(mockStory);
    expect(result).toContain("advisory");
    expect(result).toContain("do not use them to reject semantic correctness");
  });
});
