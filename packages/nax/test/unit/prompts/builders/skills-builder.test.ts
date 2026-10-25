import { describe, expect, test } from "bun:test";
import * as prompts from "@/prompts";
import type { SkillResource } from "@/resources/types";

const skill: SkillResource = {
  kind: "skill",
  name: "brainstorm",
  qualifiedName: "sp:brainstorm",
  description: "Explore ideas",
  body: "Ask questions before proposing a design.",
  baseDir: "/skills/brainstorm",
  path: "/skills/brainstorm/SKILL.md",
  modelInvocable: true,
  origin: { kind: "claude-project" },
};
const entries = [{ qualifiedName: "sp:b", description: "d" }];

describe("buildSkillsInstructions", () => {
  test("collapses spaces made adjacent by control removal", () => {
    const message = prompts.buildSkillsInstructions([{ qualifiedName: "clean", description: "a \u0007 b\u0080" }]);
    expect(message.split("\n").at(-1)).toBe("- clean: a b");
  });
  test("handles an empty index and the exact entry limit without an overflow line", () => {
    expect(prompts.buildSkillsInstructions([])).not.toContain("- ");
    const limit = Array.from({ length: 150 }, () => ({ qualifiedName: "sp:b", description: "d" }));
    expect(
      prompts
        .buildSkillsInstructions(limit)
        .split("\n")
        .filter((line) => line.startsWith("- ")),
    ).toHaveLength(150);
    expect(prompts.buildSkillsInstructions(limit)).not.toContain("more");
  });
  test("AC-1: is exported from the prompts barrel", () => {
    expect(typeof prompts.buildSkillsInstructions).toBe("function");
  });
  test("AC-2: instructs loading matching skills before acting and reading references", () => {
    const message = prompts.buildSkillsInstructions(entries);
    expect(message).toContain("nax-skills__load");
    expect(message).toContain("before acting");
    expect(message).toContain("skill name");
    expect(message).toContain("references");
    expect(message).toContain("file");
  });
  test("AC-3: renders a qualified skill and its description", () => {
    expect(prompts.buildSkillsInstructions(entries).split("\n")).toContain("- sp:b: d");
  });
  test("AC-4: caps the index at 150 entries and reports the remainder", () => {
    const many = Array.from({ length: 151 }, (_, index) => ({ qualifiedName: `sp:${index}`, description: "d" }));
    const lines = prompts
      .buildSkillsInstructions(many)
      .split("\n")
      .filter((line) => line.startsWith("- "));
    expect(lines).toHaveLength(151);
    expect(lines.slice(0, 150)).toEqual(many.slice(0, 150).map((entry) => `- ${entry.qualifiedName}: d`));
    expect(lines.at(-1)).toBe("- ... and 1 more");
  });
  test("AC-5: truncates descriptions to 200 characters", () => {
    const message = prompts.buildSkillsInstructions([{ qualifiedName: "long", description: "x".repeat(300) }]);
    expect(message.split("\n").at(-1)).toBe(`- long: ${"x".repeat(200)}`);
  });
  test("AC-6: preserves whitespace separators before removing controls", () => {
    const message = prompts.buildSkillsInstructions([{ qualifiedName: "clean", description: "a\nb\t\tc\u0007" }]);
    expect(message.split("\n").at(-1)).toBe("- clean: a b c");
  });
});

describe("buildSkillInvocationMessage", () => {
  test("AC-7: opens a skill block with its qualified name and source path", () => {
    expect(prompts.buildSkillInvocationMessage({ skill, args: "idea" })).toContain(
      `<skill name="${skill.qualifiedName}" location="${skill.path}">`,
    );
  });
  test("AC-8: explains relative references and how to load them", () => {
    expect(prompts.buildSkillInvocationMessage({ skill, args: "idea" })).toContain(
      `References are relative to ${skill.baseDir}; load them with nax-skills__load and file.`,
    );
  });
  test("AC-9: includes the unchanged skill body inside the block", () => {
    expect(prompts.buildSkillInvocationMessage({ skill, args: "idea" })).toContain(`\n${skill.body}\n</skill>`);
  });
  test("AC-10: places arguments after the closed block and a blank line", () => {
    expect(prompts.buildSkillInvocationMessage({ skill, args: "idea" })).toEndWith("</skill>\n\nidea");
  });
  test("AC-11: ends at the closing tag when arguments are empty", () => {
    expect(prompts.buildSkillInvocationMessage({ skill, args: "" })).toEndWith("</skill>");
  });
});

describe("buildCommandMessage", () => {
  test.each([
    ["AC-12: trims the argument string", "Fix $ARGUMENTS now", "  the bug ", "Fix the bug now"],
    ["AC-13: substitutes positional arguments", "$1 then $2", "a b c", "a then b"],
    ["AC-14: replaces missing positions with empty text", "$1-$3", "a", "a-"],
    ["AC-15: appends arguments without placeholders", "Review", "this file", "Review\n\nARGUMENTS: this file"],
    ["AC-16: leaves an argument-free template alone", "Review", "", "Review"],
    ["splits whitespace through the ninth position", "$1/$9/$2", " a\tb\nc d e f g h i ", "a/i/b"],
    ["does not recursively substitute argument text", "$1 $ARGUMENTS", "$2 $$", "$2 $2 $$"],
    ["replaces repeated and empty placeholders", "$1:$1:$9:$ARGUMENTS", "", ":::"],
    ["trims appended arguments", "Review", "  this file  ", "Review\n\nARGUMENTS: this file"],
    ["does not execute shell syntax", "!`echo $1`", "hello", "!`echo hello`"],
    ["does not append blank arguments", "Review", " \n\t", "Review"],
  ])("%s", (_name, template, rest, expected) => {
    expect(prompts.buildCommandMessage(template, rest)).toBe(expected);
  });
});
