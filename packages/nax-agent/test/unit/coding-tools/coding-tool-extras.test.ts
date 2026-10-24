/**
 * `buildDeclaredCommandTools` assembles the session-local RunCommand and Bash
 * tools. US-003 adds one option it must forward to Bash and nowhere else:
 * `unsandboxedCommands` shapes the Bash advertisement only, and RunCommand's own
 * `unsandboxed` argument is a later story's (US-008).
 */
import { describe, expect, test } from "bun:test";
import { buildDeclaredCommandTools, type DeclaredCommandToolsArgs } from "#src/coding-tools/coding-tool-extras";
import type { QualityCommandSpec } from "#src/internal/command-spec/index";
import type { CodingTool } from "#src/tools/index";

const args = (extra: Partial<DeclaredCommandToolsArgs> = {}): DeclaredCommandToolsArgs => ({
  declaredCommands: new Map<string, QualityCommandSpec>(),
  allowExec: false,
  execGrant: undefined,
  allowBash: true,
  bashDescriptionPatterns: ["*"],
  bashApproval: "gated",
  root: "/work",
  ...extra,
});

function bashTool(tools: readonly CodingTool[]): CodingTool {
  const tool = tools.find((candidate) => candidate.name === "Bash");
  if (tool === undefined) throw new Error(`no Bash tool in ${tools.map((t) => t.name).join(", ")}`);
  return tool;
}

/** `schema.properties` keys, without casting to a Capitalised type. */
function propertyKeys(tool: CodingTool): string[] {
  const properties: unknown = tool.inputSchema.properties;
  if (typeof properties !== "object" || properties === null) {
    throw new Error("expected the Bash tool's inputSchema.properties to be an object");
  }
  return Object.keys(properties).sort();
}

describe("buildDeclaredCommandTools — unsandboxedCommands", () => {
  test("AC-13: the flag reaches the Bash tool's schema", () => {
    const tools = buildDeclaredCommandTools(args({ unsandboxedCommands: true }));
    expect(propertyKeys(bashTool(tools))).toContain("unsandboxed");
  });

  test("without the flag the Bash schema advertises neither argument", () => {
    const tools = buildDeclaredCommandTools(args());
    expect(propertyKeys(bashTool(tools))).not.toContain("unsandboxed");
    expect(propertyKeys(bashTool(tools))).not.toContain("unsandboxedReason");
  });

  test("the flag never reaches RunCommand: no declared command tool gains the argument", () => {
    const tools = buildDeclaredCommandTools(
      args({ declaredCommands: new Map([["test", "bun test"]]), unsandboxedCommands: true }),
    );
    const runCommand = tools.find((tool) => tool.name === "RunCommand");
    if (runCommand === undefined) throw new Error("expected a RunCommand tool");
    expect(propertyKeys(runCommand)).not.toContain("unsandboxed");
  });
});
