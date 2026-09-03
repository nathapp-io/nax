import { describe, expect, test } from "bun:test";
import { createRunCommandTool, substituteCommand } from "@/tools/run-command";

describe("substituteCommand", () => {
  test("substitutes a declared placeholder", () => {
    expect(substituteCommand("bun test {{files}}", { files: "a.test.ts" })).toBe("bun test 'a.test.ts'");
  });

  test("quotes the substituted value so a metacharacter cannot escape", () => {
    const out = substituteCommand("bun test {{files}}", { files: "a.ts; rm -rf /" });
    expect(out).toBe("bun test 'a.ts; rm -rf /'");
  });

  test("quotes an embedded single quote rather than closing the string", () => {
    const out = substituteCommand("bun test {{files}}", { files: "a'; id; '.ts" });
    expect(out).toBe(`bun test 'a'\\''; id; '\\''.ts'`);
  });

  test("preserves an env-assignment prefix, which is why this is a shell string", () => {
    expect(substituteCommand("CI=1 bun test {{files}}", { files: "a.ts" })).toBe("CI=1 bun test 'a.ts'");
  });

  test("refuses a placeholder the template does not declare", () => {
    expect(substituteCommand("bun test {{files}}", { nope: "x" })).toEqual({
      error: 'value "nope" is not a placeholder in this command',
    });
  });

  test("refuses when a declared placeholder is left unfilled", () => {
    expect(substituteCommand("bun test {{files}}", {})).toEqual({
      error: "placeholder {{files}} has no value",
    });
  });
});

test("a metacharacter in a value cannot run a second command", async () => {
  const tool = createRunCommandTool(new Map([["echoFiles", "echo {{files}}"]]));
  const result = await tool.run(
    { command: "echoFiles", values: { files: "a.ts; echo PWNED" } },
    { root: process.cwd(), resolvedPaths: [], maxBytes: 4096, maxFileBytes: 1024 },
  );
  expect(result.content).toContain("a.ts; echo PWNED");
  expect(result.content).not.toContain("\nPWNED");
  expect(result.content.match(/PWNED/g)?.length).toBe(1);
});
