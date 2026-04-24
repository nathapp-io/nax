import { describe, test, expect } from "bun:test";
import { composeSections, join } from "../../../src/prompts/compose";
import type { ComposeInput } from "../../../src/prompts/compose";
import type { PromptSection } from "../../../src/prompts";

function makeSection(
  id: string,
  content: string,
  slot?: "constitution" | "instructions" | "input",
): PromptSection {
  return { id, content, overridable: false, slot };
}

describe("composeSections", () => {
  test("returns sections in SLOT_ORDER (constitution before instructions)", () => {
    const input: ComposeInput = {
      role: makeSection("role", "You are an expert."),
      task: makeSection("task", "Classify complexity."),
      constitution: "# Standards\nBe concise.",
    };
    const sections = composeSections(input);
    const ids = sections.map((s) => s.id);
    const constitutionIdx = ids.indexOf("constitution");
    const roleIdx = ids.indexOf("role");
    expect(constitutionIdx).toBeLessThan(roleIdx);
  });

  test("filters out empty-content sections", () => {
    const input: ComposeInput = {
      role: makeSection("role", "You are an expert."),
      task: makeSection("task", ""),
    };
    const sections = composeSections(input);
    expect(sections.find((s) => s.id === "task")).toBeUndefined();
  });

  test("includes constitution section when constitution string provided", () => {
    const input: ComposeInput = {
      role: makeSection("role", "You are an expert."),
      task: makeSection("task", "Classify."),
      constitution: "# Standards",
    };
    const sections = composeSections(input);
    expect(sections.find((s) => s.id === "constitution")).toBeDefined();
  });

  test("does not include constitution section when constitution not provided", () => {
    const input: ComposeInput = {
      role: makeSection("role", "You are an expert."),
      task: makeSection("task", "Classify."),
    };
    const sections = composeSections(input);
    expect(sections.find((s) => s.id === "constitution")).toBeUndefined();
  });

  test("includes instructions section when provided", () => {
    const input: ComposeInput = {
      role: makeSection("role", "You are an expert."),
      task: makeSection("task", "Classify."),
      instructions: makeSection("instructions", "Follow these steps."),
    };
    const sections = composeSections(input);
    expect(sections.find((s) => s.id === "instructions")).toBeDefined();
  });

  test("slot is set on slotted sections", () => {
    const input: ComposeInput = {
      role: makeSection("role", "You are an expert."),
      task: makeSection("task", "Classify."),
      constitution: "# Standards",
    };
    const sections = composeSections(input);
    const constitutionSection = sections.find((s) => s.id === "constitution");
    expect(constitutionSection?.slot).toBe("constitution");
  });

  test("returns empty array when all sections have empty content", () => {
    const input: ComposeInput = {
      role: makeSection("role", ""),
      task: makeSection("task", ""),
    };
    const sections = composeSections(input);
    expect(sections).toHaveLength(0);
  });

  test("preserves role and task in output when non-empty", () => {
    const input: ComposeInput = {
      role: makeSection("role", "You are an expert."),
      task: makeSection("task", "Do the thing."),
    };
    const sections = composeSections(input);
    expect(sections.find((s) => s.id === "role")).toBeDefined();
    expect(sections.find((s) => s.id === "task")).toBeDefined();
  });
});

describe("join", () => {
  test("joins sections with SECTION_SEP", () => {
    const sections: PromptSection[] = [
      { id: "a", content: "hello", overridable: false },
      { id: "b", content: "world", overridable: false },
    ];
    const result = join(sections);
    expect(result).toContain("\n\n---\n\n");
    expect(result).toContain("hello");
    expect(result).toContain("world");
  });

  test("returns single section content with no separator", () => {
    const sections: PromptSection[] = [{ id: "a", content: "only one", overridable: false }];
    const result = join(sections);
    expect(result).toBe("only one");
    expect(result).not.toContain("---");
  });

  test("returns empty string for empty sections array", () => {
    const result = join([]);
    expect(result).toBe("");
  });
});
