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

  test.each([{ argv: ["rm", "-r", "directory"] }, { argv: ["git", "rm", "--cached", "a.ts"] }])(
    "does not redirect an unsupported delete form: $argv",
    ({ argv }) => {
      expect(redirectForArgv(argv, ALL, CMDS)).toBeUndefined();
    },
  );

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

  test("a denied RunCommand verb names the tool the session already has (#1971)", async () => {
    const policy = compileToolPolicy(
      [
        { tool: "Glob", patterns: ["*"] },
        { tool: "RunCommand", patterns: ["lint"] },
      ],
      root,
    );
    const runtime = createCodingToolRuntime({
      policy,
      extraTools: [createRunCommandTool(new Map([["lint", "echo lint"]]))],
      declaredCommands: new Set(["lint"]),
    });
    runtime.advertised(["Glob", "RunCommand"]);

    const outcome = await runtime.callTool("RunCommand", { command: "ls -la" });
    expect(outcome.kind).toBe("denied");
    if (outcome.kind !== "denied") throw new Error("expected a denial");
    expect(outcome.reason).toContain("Glob");
  });
});

import { redirectForVerb } from "@/tools/denial-redirect";

const WITH_GREP = new Set(["Glob", "Git", "Delete", "RunCommand", "Grep"]);

describe("redirectForVerb (#1971)", () => {
  test("a command line stuffed into the verb slot reuses the argv table", () => {
    expect(redirectForVerb("RunCommand", "ls -la", ALL, CMDS)).toContain("Glob");
    expect(redirectForVerb("RunCommand", "ls -la src", ALL, CMDS)).toContain("Glob");
  });

  test("a bare read-only git verb points at Git", () => {
    expect(redirectForVerb("RunCommand", "diff", ALL, CMDS)).toContain("Git");
    expect(redirectForVerb("RunCommand", "status", ALL, CMDS)).toContain("Git");
  });

  test("a bare git points at Git", () => {
    expect(redirectForVerb("RunCommand", "git", ALL, CMDS)).toContain("Git");
  });

  test("grep points at Grep", () => {
    expect(redirectForVerb("Git", "grep", WITH_GREP, CMDS)).toContain("Grep");
  });

  test("never redirects a tool back at itself", () => {
    // Git {subcommand:"diff"} denied by a narrow grant: "you already have Git"
    // is useless, and would read as a contradiction of the denial.
    expect(redirectForVerb("Git", "diff", ALL, CMDS)).toBeUndefined();
  });

  test("says nothing when the target tool is not advertised", () => {
    expect(redirectForVerb("Git", "grep", ALL, CMDS)).toBeUndefined();
    expect(redirectForVerb("RunCommand", "ls -la", new Set(["Read"]), CMDS)).toBeUndefined();
  });

  test("says nothing for a verb that maps to no tool", () => {
    expect(redirectForVerb("RunCommand", "test:coverage", WITH_GREP, CMDS)).toBeUndefined();
    expect(redirectForVerb("RunCommand", "", WITH_GREP, CMDS)).toBeUndefined();
  });
});

describe("declared-commands fallback (#1971)", () => {
  test("a runner invoking an unknown script is told what the project declares", () => {
    const r = redirectForArgv(["bun", "run", "check:all"], ALL, CMDS);
    expect(r).toContain("RunCommand");
    expect(r).toContain("test, testScoped, lint");
  });

  test("works for any runner, not just bun", () => {
    expect(redirectForArgv(["npm", "run", "lint:ci"], ALL, CMDS)).toContain("RunCommand");
    expect(redirectForArgv(["make", "check"], ALL, CMDS)).toContain("RunCommand");
    expect(redirectForArgv(["uv", "run", "pytest"], ALL, CMDS)).toContain("RunCommand");
  });

  test("a specific row still wins over the fallback", () => {
    // `bun test <file>` must stay pointed at testScoped, not the generic list.
    expect(redirectForArgv(["bun", "test", "a.test.ts"], ALL, CMDS)).toContain("testScoped");
  });

  test("says nothing when the project declared no commands", () => {
    expect(redirectForArgv(["bun", "run", "check:all"], ALL, new Set())).toBeUndefined();
  });

  test("says nothing when RunCommand is not advertised", () => {
    expect(redirectForArgv(["bun", "run", "check:all"], new Set(["Read"]), CMDS)).toBeUndefined();
  });

  test("does not fire on non-runner argv", () => {
    // Guards the existing unsupported-delete-form tests from silently changing.
    expect(redirectForArgv(["rm", "-r", "directory"], ALL, CMDS)).toBeUndefined();
    expect(redirectForArgv(["wc", "-l", "a.ts"], ALL, CMDS)).toBeUndefined();
  });

  test("does not fire on an install form, which wants the granted forms instead", () => {
    expect(redirectForArgv(["bun", "add", "left-pad"], ALL, CMDS)).toBeUndefined();
    expect(redirectForArgv(["pnpm", "install"], ALL, CMDS)).toBeUndefined();
    expect(redirectForArgv(["go", "mod", "download"], ALL, CMDS)).toBeUndefined();
  });
});

describe("the #1971 denial shapes each name an affordance", () => {
  const WITH_GREP = new Set(["Glob", "Git", "Delete", "RunCommand", "Grep"]);

  test.each([
    { tool: "RunCommand", verb: "ls -la", want: "Glob" },
    { tool: "RunCommand", verb: "diff", want: "Git" },
    { tool: "RunCommand", verb: "git", want: "Git" },
    { tool: "Git", verb: "grep", want: "Grep" },
  ])("$tool {$verb} names $want", ({ tool, verb, want }) => {
    expect(redirectForVerb(tool, verb, WITH_GREP, CMDS)).toContain(want);
  });

  test.each([
    [["bun", "run", "check:all"]],
    [["bun", "run", "check:test-mocks"]],
    [["npm", "run", "lint:ci"]],
    [["make", "check"]],
  ])("a project gate names the declared commands: %s", (argv: string[]) => {
    expect(redirectForArgv(argv, WITH_GREP, CMDS)).toContain("RunCommand with declared commands");
  });

  test("a specific row still beats the generic fallback", () => {
    expect(redirectForVerb("RunCommand", "bun test a.test.ts", WITH_GREP, CMDS)).toContain("testScoped");
  });

  test("shapes nothing serves stay unredirected", () => {
    // No tool provides a line count, and `test:coverage` is a verb the project
    // never declared -- Task 1's `permitted:` list is what serves these.
    expect(redirectForVerb("RunCommand", "wc -l a.ts", WITH_GREP, CMDS)).toBeUndefined();
    expect(redirectForVerb("RunCommand", "test:coverage", WITH_GREP, CMDS)).toBeUndefined();
  });

  test("never contradicts its own denial", () => {
    expect(redirectForVerb("Git", "diff", WITH_GREP, CMDS)).toBeUndefined();
  });
});
