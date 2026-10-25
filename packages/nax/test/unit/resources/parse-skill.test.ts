import { describe, expect, test } from "bun:test";
import { parseSkillFile } from "@/resources/parse-skill";
import type { ResourceOrigin } from "@/resources/types";

const origin: ResourceOrigin = { kind: "claude-user" };
const path = "/skills/my-skill/SKILL.md";
const file = (metadata: string) => `---\n${metadata}\n---\n# Body`;

describe("parseSkillFile", () => {
  test("AC-1 parses skill metadata and body", () => {
    expect(parseSkillFile(path, file("name: brainstorming\ndescription: Explore intent"), origin)).toMatchObject({
      resource: { name: "brainstorming", description: "Explore intent", body: "# Body", modelInvocable: true },
    });
  });
  test("AC-2 falls back to the parent directory", () => {
    expect(parseSkillFile(path, file("description: d"), origin)).toMatchObject({
      resource: { name: "my-skill", baseDir: "/skills/my-skill" },
    });
  });
  test("AC-3 disables model invocation", () => {
    expect(parseSkillFile(path, file("description: d\ndisable-model-invocation: true"), origin)).toMatchObject({
      resource: { modelInvocable: false },
    });
  });
  test.each(["name: valid", 'name: "bad name!"\ndescription: d'])("AC-4 rejects invalid skill: %s", (metadata) => {
    expect(parseSkillFile(path, file(metadata), origin)).toEqual({
      diagnostic: { severity: "error", path, origin, message: expect.any(String) },
    });
  });
  test("AC-5 accepts permissive descriptions", () => {
    expect(parseSkillFile(path, file('description: Use when needed. Triggers: "a"'), origin)).toMatchObject({
      resource: { description: 'Use when needed. Triggers: "a"' },
    });
  });
  test.each([
    [{ kind: "claude-plugin", plugin: "superpowers", marketplace: "m" }, "superpowers:brainstorming"],
    [{ kind: "claude-user" }, "brainstorming"],
    [{ kind: "nax-plugin", plugin: "custom" }, "custom:brainstorming"],
  ] satisfies [ResourceOrigin, string][])("AC-6 qualifies %j", (source, qualifiedName) => {
    expect(parseSkillFile(path, file("name: brainstorming\ndescription: d"), source)).toMatchObject({
      resource: { qualifiedName },
    });
  });
  test("AC-15 rejects unclosed frontmatter", () => {
    expect(parseSkillFile(path, "---\ndescription: d", origin)).toEqual({
      diagnostic: { severity: "error", path, origin, message: expect.any(String) },
    });
  });
  test.each([
    "description: '   '",
    "description: 123",
    "description: d\nname: 123",
    `description: d\nname: ${"a".repeat(65)}`,
  ])("rejects invalid metadata %s", (metadata) => {
    expect(parseSkillFile(path, file(metadata), origin)).toHaveProperty("diagnostic.severity", "error");
  });
  test("ignores model and tool overrides", () => {
    const result = parseSkillFile(
      path,
      file("description: d\nmodel: other\nallowed-tools: Bash\nlicense: MIT"),
      origin,
    );
    expect(result).toHaveProperty("resource");
    expect(result).not.toHaveProperty("resource.model");
    expect(result).not.toHaveProperty("resource.allowedTools");
  });
});
