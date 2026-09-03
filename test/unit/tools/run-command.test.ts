import { describe, expect, test } from "bun:test";
import { compileToolPolicy } from "@/tools/policy";
import { createRunCommandTool, substituteCommand } from "@/tools/run-command";
import { createCodingToolRuntime } from "@/tools/runtime";

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

  test("refuses a placeholder inside double quotes, where single-quote escaping is unsafe", () => {
    expect(substituteCommand('printf "%s\\n" "{{files}}"', { files: "$(printf PWNED)" })).toEqual({
      error: "placeholder {{files}} may not appear inside shell quotes",
    });
  });

  test("refuses a placeholder inside command substitution", () => {
    expect(substituteCommand("printf '%s\\n' $({{files}})", { files: "printf PWNED" })).toEqual({
      error: "placeholder {{files}} may not appear in a shell expansion",
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

test("refuses a files path outside the repository root before running the command", async () => {
  const tool = createRunCommandTool(new Map([["echoFiles", "echo {{files}}"]]));
  const runtime = createCodingToolRuntime({
    policy: compileToolPolicy([{ tool: "RunCommand", patterns: ["*"] }], process.cwd()),
    extraTools: [tool],
  });

  const result = await runtime.callTool("RunCommand", {
    command: "echoFiles",
    values: { files: "/etc/passwd" },
  });

  expect(result.kind).toBe("denied");
  if (result.kind !== "denied") throw new Error("expected denial");
  expect(result.breach).toBe(true);
});

test("strips configured secrets from agent-invoked commands", async () => {
  const secretName = "NAX_C2_RUN_COMMAND_SECRET";
  const previous = process.env[secretName];
  process.env[secretName] = "must-not-reach-the-model";
  try {
    const tool = createRunCommandTool(new Map([["printEnv", `printf '%s' "$${secretName}"`]]), {
      stripEnvVars: [secretName],
    });
    const result = await tool.run(
      { command: "printEnv" },
      { root: process.cwd(), resolvedPaths: [], maxBytes: 4096, maxFileBytes: 1024 },
    );
    expect(result.content).not.toContain("must-not-reach-the-model");
  } finally {
    if (previous === undefined) delete process.env[secretName];
    else process.env[secretName] = previous;
  }
});
