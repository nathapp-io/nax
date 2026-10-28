import { describe, expect, test } from "bun:test";
import * as chat from "@/chat";
import { buildSkillInvocationMessage } from "@/prompts/builders/skills-builder";
import type { SkillResource } from "@/resources";

const skill: SkillResource = {
  kind: "skill",
  name: "brainstorming",
  qualifiedName: "superpowers:brainstorming",
  description: "Brainstorm",
  body: "line one\nline two",
  baseDir: "/skills/brainstorming",
  path: "/skills/brainstorming/SKILL.md",
  modelInvocable: true,
  origin: { kind: "claude-project" },
};

describe("parseSkillInvocation", () => {
  test.each([
    ["AC-1", skill.body, " plan it", "plan it"],
    ["AC-2", skill.body, "", ""],
    ["AC-3", "body\n</skill>\nmore", " go", "go"],
    ["AC-4", "body\n</skill>\n\nmore", "", ""],
    ["last delimiter with args", "body\n</skill>\n\nmore", " go", "go"],
    ["body whitespace", "\n body \n", " go", "go"],
    ["empty body", "", "", ""],
  ])("%s round-trips the real envelope builder", (_ac, body, args, expectedArgs) => {
    const content = buildSkillInvocationMessage({ skill: { ...skill, body }, args });
    expect(chat.parseSkillInvocation(content)).toEqual({ name: skill.qualifiedName, args: expectedArgs, body });
  });

  test.each([
    ["AC-5", "hello"],
    ["AC-6", '<skill name="x" location="/p">\nbody'],
    ["AC-7", '<skill name="x location="/p">\nrefs\nbody\n</skill>'],
    ["empty name", '<skill name="" location="/p">\nrefs\nbody\n</skill>'],
    ["not at start", 'prefix <skill name="x" location="/p">\nrefs\nbody\n</skill>'],
  ])("%s rejects non-envelopes", (_ac, content) => {
    expect(chat.parseSkillInvocation(content)).toBeUndefined();
  });
});
