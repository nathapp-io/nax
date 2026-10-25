import { describe, expect, test } from "bun:test";
import { parseCommandFile } from "@/resources/parse-command";

const origin = { kind: "claude-user" } as const;
const path = "/commands/commit.md";

describe("parseCommandFile", () => {
  test("AC-7 preserves an unquoted bracketed argument hint", () => {
    expect(
      parseCommandFile(path, "---\ndescription: Create a git commit\nargument-hint: [msg]\n---\nCommit", origin),
    ).toMatchObject({
      resource: { name: "commit", description: "Create a git commit", argumentHint: "[msg]", template: "Commit" },
    });
  });
  test("AC-8 preserves the whole template without frontmatter, including @file", () => {
    const text = "Commit @file\n$ARGUMENTS\n";
    expect(parseCommandFile(path, text, origin)).toEqual({
      resource: { kind: "command", name: "commit", qualifiedName: "commit", template: text, path, origin },
    });
  });
  test.each(["---\nname: a", "---\n- a\n---\nBody"])("rejects invalid frontmatter %s", (text) => {
    expect(parseCommandFile(path, text, origin)).toHaveProperty("diagnostic.severity", "error");
  });
  test("rejects an invalid filename", () => {
    expect(parseCommandFile("/commands/bad name.md", "body", origin)).toHaveProperty("diagnostic.severity", "error");
  });
  test("ignores non-string optional fields and qualifies plugin names", () => {
    expect(
      parseCommandFile(path, "---\ndescription: 12\nargument-hint: true\n---\nBody", {
        kind: "nax-plugin",
        plugin: "p",
      }),
    ).toEqual({
      resource: {
        kind: "command",
        name: "commit",
        qualifiedName: "p:commit",
        template: "Body",
        path,
        origin: { kind: "nax-plugin", plugin: "p" },
      },
    });
  });
  test.each(['"[msg]"', "'[msg]'", "[msg, other]"])("reads hint %s", (hint) => {
    expect(parseCommandFile(path, `---\nargument-hint: ${hint}\n---\n`, origin)).toHaveProperty(
      "resource.argumentHint",
      hint.replace(/^['"]|['"]$/g, ""),
    );
  });
});
