import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redirectForArgv } from "@/tools/denial-redirect";
import { compileToolPolicy } from "@/tools/policy";
import { createRunCommandTool } from "@/tools/run-command";
import { createCodingToolRuntime } from "@/tools/runtime";

const ALL = new Set(["Glob", "Git", "Delete", "RunCommand"]);
const CMDS = new Set(["test", "testScoped", "lint"]);

describe("redirectForArgv", () => {
  test("points ls at Glob when Glob is advertised", () => {
    expect(redirectForArgv(["ls", "-la", "src"], ALL, CMDS)).toContain("Glob");
  });

  test("points find at Glob", () => {
    expect(redirectForArgv(["find", ".", "-type", "f"], ALL, CMDS)).toContain("Glob");
  });

  test("says nothing when the tool is not advertised", () => {
    expect(redirectForArgv(["ls"], new Set(["Read"]), CMDS)).toBeUndefined();
  });

  test("points a read-only git verb at Git", () => {
    expect(redirectForArgv(["git", "status", "--porcelain"], ALL, CMDS)).toContain("Git");
  });

  test("points git rm and rm at Delete", () => {
    expect(redirectForArgv(["git", "rm", "a.ts"], ALL, CMDS)).toContain("Delete");
    expect(redirectForArgv(["rm", "a.ts"], ALL, CMDS)).toContain("Delete");
  });

  test("points a scoped test run at testScoped only when the project declares it", () => {
    expect(redirectForArgv(["bun", "test", "a.test.ts"], ALL, CMDS)).toContain("testScoped");
    expect(redirectForArgv(["bun", "test", "a.test.ts"], ALL, new Set(["test"]))).toBeUndefined();
  });

  test("sees through a timeout prefix", () => {
    expect(redirectForArgv(["timeout", "30", "bun", "test", "a.test.ts"], ALL, CMDS)).toContain("testScoped");
  });

  test("says nothing about an install form, which is already granted", () => {
    expect(redirectForArgv(["bun", "add", "left-pad"], ALL, CMDS)).toBeUndefined();
  });
});
describe("runtime appends the redirect to a denial", () => {
  const root = mkdtempSync(join(tmpdir(), "nax-redirect-"));

  test("a denied ls names Glob once Glob has been advertised", async () => {
    const policy = compileToolPolicy(
      [
        { tool: "Glob", patterns: ["*"] },
        { tool: "RunCommand", patterns: ["*"] },
        { tool: "Exec", patterns: ["bun install"] },
      ],
      root,
    );
    const runtime = createCodingToolRuntime({
      policy,
      extraTools: [
        createRunCommandTool(new Map(), {
          exec: { repoRoot: root, packageWorkdir: root, allowScripts: false, patterns: ["bun add*"] },
        }),
      ],
    });
    runtime.advertised(["Glob", "RunCommand"]);

    const outcome = await runtime.callTool("RunCommand", { argv: ["ls", "-la"] });
    expect(outcome.kind).toBe("denied");
    if (outcome.kind !== "denied") throw new Error("expected a denial");
    expect(outcome.reason).toContain("is not granted for argv");
    expect(outcome.reason).toContain("Glob");
  });

  test("the same denial stays silent when Glob was never advertised", async () => {
    const policy = compileToolPolicy(
      [
        { tool: "RunCommand", patterns: ["*"] },
        { tool: "Exec", patterns: ["bun install"] },
      ],
      root,
    );
    const runtime = createCodingToolRuntime({
      policy,
      extraTools: [
        createRunCommandTool(new Map(), {
          exec: { repoRoot: root, packageWorkdir: root, allowScripts: false, patterns: ["bun add*"] },
        }),
      ],
    });
    runtime.advertised(["RunCommand"]);

    const outcome = await runtime.callTool("RunCommand", { argv: ["ls", "-la"] });
    expect(outcome.kind).toBe("denied");
    if (outcome.kind !== "denied") throw new Error("expected a denial");
    expect(outcome.reason).not.toContain("Glob");
  });
});
