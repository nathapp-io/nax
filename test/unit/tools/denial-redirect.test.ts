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
// nax#1999: `intendedTool` (argv) and `VERB_TOOLS` (bare verb) covered
// DISJOINT command sets, and `redirectForVerb` routes a multi-token verb slot
// into the argv table -- so which table answered depended on whether the model
// typed a flag. Coverage came out inverted: `ls -la` redirected, `ls` did not;
// `grep` redirected, `grep -n x y` did not. 20 of 34 post-#1971 denials carried
// no redirect at all.
describe("one table answers both entry points", () => {
  const AVAILABLE = new Set(["Glob", "Git", "GitCommit", "Delete", "Grep", "Read", "RunCommand"]);

  // The invariant the split could not express: for every head token either
  // table knows, the bare verb and the same verb with an argument must name
  // the same tool. This is what would have caught the drift.
  // `rm` and `git` are excluded on purpose: their intent is decided by the
  // SECOND token (`rm a.ts` is Delete but `rm -r dir` is nothing; `git log` is
  // Git but `git add` is GitCommit), so they are shape-dependent by design and
  // are pinned separately below.
  test.each(["ls", "find", "cat", "wc", "grep", "diff", "log", "show", "status", "blame", "add", "commit"])(
    "verb slot and argv slot agree on %s",
    (head) => {
      const bare = redirectForVerb("RunCommand", head, AVAILABLE, CMDS);
      const withArg = redirectForVerb("RunCommand", `${head} a.ts`, AVAILABLE, CMDS);
      // Agreement alone passes vacuously if a row is deleted and both sides go
      // undefined. This test carries the whole point of #1999, so it pins
      // coverage too.
      expect(toolNamed(bare)).toBeDefined();
      expect(toolNamed(bare)).toEqual(toolNamed(withArg));
    },
  );

  function toolNamed(redirect: string | undefined): string | undefined {
    if (redirect === undefined) return undefined;
    const backticked = redirect.match(/`([A-Za-z:]+)`/);
    if (backticked !== null) return backticked[1];
    return redirect.includes("testScoped") ? "RunCommand:testScoped" : redirect;
  }

  test("a bare ls names Glob, as `ls -la` already did", () => {
    expect(redirectForVerb("RunCommand", "ls", AVAILABLE, CMDS)).toContain("Glob");
  });

  test("grep with arguments names Grep, as a bare `grep` already did", () => {
    expect(redirectForVerb("RunCommand", 'grep -n "foo" src/a.ts', AVAILABLE, CMDS)).toContain("Grep");
    expect(redirectForArgv(["grep", "-n", "foo", "src/a.ts"], AVAILABLE, CMDS)).toContain("Grep");
  });

  test("cat names Read", () => {
    expect(redirectForVerb("RunCommand", "cat src/a.ts", AVAILABLE, CMDS)).toContain("Read");
    expect(redirectForArgv(["cat", "src/a.ts"], AVAILABLE, CMDS)).toContain("Read");
  });

  test("wc names Read, the nearest tool that can answer it", () => {
    expect(redirectForVerb("RunCommand", "wc -l src/a.ts", AVAILABLE, CMDS)).toContain("Read");
  });

  test("a git write verb names GitCommit, not the package-manager install forms", () => {
    expect(redirectForArgv(["git", "add", "src/a.ts"], AVAILABLE, CMDS)).toContain("GitCommit");
    expect(redirectForArgv(["git", "commit", "-m", "wip"], AVAILABLE, CMDS)).toContain("GitCommit");
  });

  test("a git write verb says nothing when GitCommit was never advertised", () => {
    expect(redirectForArgv(["git", "add", "src/a.ts"], new Set(["Glob"]), CMDS)).toBeUndefined();
  });

  // `git.ts` sets `allowedVerbs: GIT_READ_VERBS`, so EVERY Git verb-slot denial
  // carries a write verb, arriving bare -- `commit`, not `git commit`. A
  // GitCommit row reachable only via the `git ` prefix would never fire in the
  // one slot Git denials actually come through, which is the same "depends on
  // how the model typed it" inversion #1999 exists to kill.
  test("a bare write verb in Git's own slot names GitCommit", () => {
    expect(redirectForVerb("Git", "commit", AVAILABLE, CMDS)).toContain("GitCommit");
    expect(redirectForVerb("Git", "add", AVAILABLE, CMDS)).toContain("GitCommit");
  });

  test("GitCommit's description names the arguments it requires", () => {
    // buildCommitArgvs rejects a call without `message` AND a non-empty
    // `paths`; "commits the working tree" would send the model into that error.
    const redirect = redirectForVerb("Git", "commit", AVAILABLE, CMDS) ?? "";
    expect(redirect).toContain("message");
    expect(redirect).toContain("paths");
    expect(redirect).not.toContain("working tree");
  });

  test("the wc redirect admits Read cannot actually count lines", () => {
    // Read with no offset/limit returns a byte-bounded PREFIX, so counting the
    // lines it returns under-reports exactly the large files the question is
    // asked about. Naming Read beats a bare refusal only if the limit is said.
    const redirect = redirectForVerb("RunCommand", "wc -l src/big.ts", AVAILABLE, CMDS) ?? "";
    expect(redirect).toContain("truncated");
  });

  test("rm stays shape-dependent: one file is Delete, a recursive directory is nothing", () => {
    expect(redirectForArgv(["rm", "a.ts"], AVAILABLE, CMDS)).toContain("Delete");
    expect(redirectForArgv(["rm", "-r", "dir"], AVAILABLE, CMDS)).toBeUndefined();
  });

  test("git stays shape-dependent: a read verb is Git, a write verb is GitCommit", () => {
    expect(redirectForArgv(["git", "log"], AVAILABLE, CMDS)).toContain("`Git`");
    expect(redirectForArgv(["git", "add", "a.ts"], AVAILABLE, CMDS)).toContain("GitCommit");
    expect(redirectForArgv(["git", "rm", "a.ts"], AVAILABLE, CMDS)).toContain("Delete");
  });

  test("still says nothing for a shape no tool serves", () => {
    // Naming a tool that does not serve the intent is the defect this module
    // exists to fix, so bash/mv/git restore stay unanswered on purpose.
    expect(redirectForVerb("RunCommand", "bash", AVAILABLE, CMDS)).toBeUndefined();
    expect(redirectForArgv(["mv", "a.ts", "b.ts"], AVAILABLE, CMDS)).toBeUndefined();
    expect(redirectForVerb("Git", "restore", AVAILABLE, CMDS)).toBeUndefined();
  });

  test("still never names a tool the session does not hold", () => {
    expect(redirectForVerb("RunCommand", "cat src/a.ts", new Set(["Glob"]), CMDS)).toBeUndefined();
    expect(redirectForArgv(["grep", "-n", "x", "a.ts"], new Set(["Glob"]), CMDS)).toBeUndefined();
  });

  test("still does not tell Git it already has Git", () => {
    expect(redirectForVerb("Git", "diff", AVAILABLE, CMDS)).toBeUndefined();
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

  // Used to assert that `Git` denying "git diff" answers "this session already
  // has `Git`" -- the contradiction the same-tool guard exists to prevent. It
  // survived only because the multi-token path bypassed that guard on its way
  // to the argv table, while a bare "diff" in the same slot was correctly
  // silent. That inconsistency IS nax#1999; the guard now applies uniformly.
  test("a git command line in Git's own slot stays silent rather than naming Git", () => {
    expect(redirectForVerb("Git", "git diff", ALL, CMDS)).toBeUndefined();
    expect(redirectForVerb("Git", "git status", ALL, CMDS)).toBeUndefined();
    expect(redirectForVerb("Git", "diff", ALL, CMDS)).toBeUndefined();
  });

  test("a RunCommand multi-token git verb still redirects to Git", () => {
    expect(redirectForVerb("RunCommand", "git diff", ALL, CMDS)).toContain("Git");
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
