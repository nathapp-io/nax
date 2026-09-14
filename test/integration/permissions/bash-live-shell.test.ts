/**
 * The live-shell fixture — the deny suite's companion, asserting SIDE EFFECTS.
 *
 * `bash-deny-suite.test.ts` asserts the verdict: the policy said "denied". This
 * file asserts what the verdict was for: the file is still on disk, and nothing
 * was written outside the root. The two are not the same evidence, and the gap
 * between them is exactly where a gate defect hides — a reviewer reading a
 * green verdict suite cannot tell a refusal from a refusal that arrived after
 * `/bin/sh` had already run the command.
 *
 * So every row here spawns a REAL shell through the real tool. The canary rows
 * are mutation-proof by construction: run them against a build without the
 * lexer's subshell and negation refusals and three of them report
 * `canary=DESTROYED`, because `( rm -rf canary.txt )` presents a first token of
 * `(rm` that no `Bash(rm *)` deny rule matches.
 *
 * The positive rows matter as much: a gate that denies everything would pass
 * every negative row in this file, so the allowed commands must be observed to
 * actually run and actually write.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";

const DECLARED = ["Read", "Glob", "Grep", "Bash"] as const;
const STRUCTURED_GRANTS = [
  { tool: "Read", patterns: ["*"] },
  { tool: "Glob", patterns: ["*"] },
  { tool: "Grep", patterns: ["*"] },
] as const;

let root: string;
let outside: string;

/** The file every destructive row aims at. Rewritten per test, never shared. */
const CANARY = "canary.txt";

beforeEach(() => {
  root = makeTempDir("bash-live-shell-");
  outside = makeTempDir("bash-live-shell-outside-");
  writeFileSync(join(root, CANARY), "ALIVE");
  writeFileSync(join(outside, "secret.txt"), "OUTSIDE-THE-ROOT");
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "config"), "[core]\n");
});

afterEach(() => {
  cleanupTempDir(root);
  cleanupTempDir(outside);
});

function session(allow: readonly string[], deny?: readonly string[]) {
  return buildCodingToolSupport({
    root,
    declared: [...DECLARED],
    grants: [...STRUCTURED_GRANTS, { tool: "Bash", patterns: allow }],
    ...(deny !== undefined ? { denyRules: [{ tool: "Bash", patterns: deny }] } : {}),
    // Pinned rather than left to default: these rows assert POSIX `sh`
    // behaviour, and a machine whose default shell differed would change what
    // the fixture is evidence of.
    shell: "/bin/sh",
  });
}

const call = async (allow: readonly string[], command: string, deny?: readonly string[]) => {
  const support = session(allow, deny);
  support?.runtime.advertised([...DECLARED]);
  return (await support?.runtime.callTool("Bash", { command })) ?? { kind: "error" as const, content: "no support" };
};

const canaryAlive = () => existsSync(join(root, CANARY));

/** Anywhere an escaping redirect in these rows could plausibly land. */
const escaped = () => existsSync(join(outside, "escape.txt")) || existsSync(join(root, "..", "escape.txt"));

describe("live shell: a denied command never reaches /bin/sh", () => {
  test.each([
    ["a subshell", "(rm -rf canary.txt)"],
    ["a negation", "! rm -rf canary.txt"],
    ["a subshell after an allowed segment", "echo hi && ( rm -rf canary.txt )"],
    ["a brace group", "{ rm -rf canary.txt; }"],
    ["a trailing comment", "echo hi # rm -rf canary.txt"],
    ["the plain form the deny rule names", "rm -rf canary.txt"],
  ])("%s cannot delete the canary past a deny rule", async (_label, command) => {
    const outcome = await call(["*"], command, ["rm *"]);
    expect(outcome.kind).toBe("denied");
    expect(canaryAlive()).toBe(true);
  });

  test.each([
    ["a redirect out of the root", ["echo *"], "echo pwned > ../escape.txt"],
    ["a flag-embedded `..` carrying no slash", ["sh *"], "sh -c 'true' --output-dir=.."],
    ["an option-shaped cd target", ["cd *", "echo *"], "cd - && echo x"],
    ["a cd escaping the root", ["cd *", "echo *"], "cd .. && echo x"],
  ])("%s is refused and writes nothing outside the root", async (_label, allow, command) => {
    const outcome = await call(allow as readonly string[], command);
    expect(outcome.kind).toBe("denied");
    expect(escaped()).toBe(false);
  });

  test("an absolute path outside the root never reaches the shell", async () => {
    const outcome = await call(["cat *"], `cat ${join(outside, "secret.txt")}`);
    expect(outcome.kind).toBe("denied");
    // The point of asserting on content: a leak would surface HERE, in the
    // tool result the model reads, not in the verdict.
    if (outcome.kind === "denied") expect(outcome.reason).not.toContain("OUTSIDE-THE-ROOT");
  });
});

describe("live shell: a granted command really runs", () => {
  // Without these, a gate that denied everything would pass every row above.
  test("an allowed command's stdout comes back from the shell", async () => {
    const outcome = await call(["echo *"], "echo hello-from-the-shell");
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") expect(outcome.content).toContain("hello-from-the-shell");
  });

  test("an allowed redirect inside the root actually writes", async () => {
    const outcome = await call(["echo *"], "echo written-for-real > out.txt");
    expect(outcome.kind).toBe("ok");
    expect(readFileSync(join(root, "out.txt"), "utf8")).toContain("written-for-real");
  });

  test("a trailing `*` grant admits the bare form", async () => {
    expect((await call(["echo *"], "echo")).kind).toBe("ok");
  });

  test("an allowed cd runs the following segment", async () => {
    const outcome = await call(["cd *", "echo *"], "cd . && echo nested");
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") expect(outcome.content).toContain("nested");
  });
});
