/**
 * The git-spawn hardening gate (#2198): every git nax spawns carries
 * `gitSpawnEnv` / `hardenedGitEnv`, or is marked as handed to a runner that
 * hardens it; a status / diff argv also goes through `hardenedGitArgv` (#2210).
 * Proven by violating it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findGitSpawnViolations } from "@scripts/check-git-spawn-env";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

const SCRIPT = join(import.meta.dir, "../../../scripts/check-git-spawn-env.ts");

describe("findGitSpawnViolations", () => {
  test.each([
    [
      "an inline spawn carrying gitSpawnEnv and hardenedGitArgv",
      'Bun.spawn(hardenedGitArgv(["git", "status"]), { cwd, env: gitSpawnEnv() });',
    ],
    ["a non-status/diff literal with no argv wrapper", 'Bun.spawn(["git", "log"], { cwd, env: gitSpawnEnv() });'],
    [
      "a deps spawn with an overlay",
      '_deps.spawn(hardenedGitArgv(["git", ...args]), {\n  cwd,\n  env: gitSpawnEnv({ GIT_DIR: d }),\n});',
    ],
    [
      "a cmd-object spawn",
      'deps.spawn({\n  cmd: hardenedGitArgv(["git", ...args]),\n  cwd,\n  env: gitSpawnEnv(),\n});',
    ],
    ["a spawnSync spreading shared options", 'Bun.spawnSync(["git", "config"], { ...opts, env: gitSpawnEnv() });'],
    [
      "an argv inside a grouping paren",
      'deps.spawn(hardenedGitArgv([...(over ?? ["git", ...args])]), { env: hardenedGitEnv(process.env) });',
    ],
    ["a marked runner hand-off", '// nax-git-env-allow: defaultRun hardens\nawait deps.run(["git", "push"], { cwd });'],
    ["a git literal in a comment", '// Bun.spawn(["git", "status"])\n/* spawn(["git"]) */'],
  ])("accepts %s", (_label, source) => {
    expect(findGitSpawnViolations(source)).toEqual([]);
  });

  test("flags a direct spawn without the hardened env", () => {
    const violations = findGitSpawnViolations('const p = Bun.spawn(["git", "diff"], { cwd: dir });');
    expect(violations).toEqual([
      {
        line: 1,
        text: 'const p = Bun.spawn(["git", "diff"], { cwd: dir });',
        why: "git spawn without env: gitSpawnEnv(...)",
      },
      {
        line: 1,
        text: 'const p = Bun.spawn(["git", "diff"], { cwd: dir });',
        why: "git status/diff argv not wrapped in hardenedGitArgv(...)",
      },
    ]);
  });

  test.each([
    ["a status literal", 'Bun.spawn(["git", "status", "--porcelain"], { env: gitSpawnEnv() });'],
    ["a diff literal", "Bun.spawn(['git', 'diff', 'HEAD'], { env: gitSpawnEnv() });"],
    ["a spread argv, whose verb is unknown", '_deps.spawn(["git", ...args], { env: gitSpawnEnv() });'],
    ["a cmd-object spread", 'deps.spawn({ cmd: ["git", ...args], env: gitSpawnEnv() });'],
  ])("#2210: flags %s without hardenedGitArgv", (_label, source) => {
    expect(findGitSpawnViolations(source).map((v) => v.why)).toEqual([
      "git status/diff argv not wrapped in hardenedGitArgv(...)",
    ]);
  });

  test("flags a spawn whose shared options variable is the only env source", () => {
    expect(findGitSpawnViolations('Bun.spawn(["git", "config", "user.name"], spawnOptions);')).toHaveLength(1);
  });

  test("does not credit a gitSpawnEnv call that only appears in a comment", () => {
    const source = 'Bun.spawn(["git", "log"], {\n  cwd,\n  // env: gitSpawnEnv(),\n});';
    expect(findGitSpawnViolations(source)).toHaveLength(1);
  });

  test("flags a git argv built in a variable, a multi-line one included", () => {
    const violations = findGitSpawnViolations(
      'const cmd = [\n  "git",\n  "grep",\n];\nBun.spawn(cmd, { env: gitSpawnEnv() });',
    );
    expect(violations.map((v) => [v.line, v.why])).toEqual([
      [1, "git argv not passed straight to spawn(...) — spawn it inline, or mark the runner"],
    ]);
  });

  test("flags a git argv passed to a non-spawn wrapper", () => {
    expect(findGitSpawnViolations('await runGit(["git", "rev-parse", "HEAD"], workdir);')).toHaveLength(1);
  });

  test("an empty allow marker does not exempt the site", () => {
    expect(findGitSpawnViolations('// nax-git-env-allow:\nBun.spawn(["git"], { cwd });')).toHaveLength(1);
  });

  test("brackets inside string literals do not unbalance the scan", () => {
    const source = 'Bun.spawn(["git", "log", "--format=(%h]"], { cwd, env: gitSpawnEnv() });';
    expect(findGitSpawnViolations(source)).toEqual([]);
  });
});

/**
 * US-003: a spawn whose argv is not a literal array headed by a string literal
 * is invisible to the `["git", ...]` rule above. The gate must flag those call
 * sites too — unless the call hardens its own env, or carries a reasoned marker.
 */
const NON_LITERAL_WHY =
  "spawn argv is not a literal: pass env: gitSpawnEnv(...) or mark // nax-git-env-allow: <reason>";

describe("findGitSpawnViolations — non-literal spawn argv (US-003)", () => {
  test("AC1: flags an argv variable at the spawn line", () => {
    const violations = findGitSpawnViolations("Bun.spawn(argv, { cwd });");
    expect(violations.map((v) => [v.line, v.why])).toEqual([[1, NON_LITERAL_WHY]]);
  });

  test("AC2: flags a non-literal argv handed to spawnSync", () => {
    const violations = findGitSpawnViolations("Bun.spawnSync(cmd, opts);");
    expect(violations.map((v) => [v.line, v.why])).toEqual([[1, NON_LITERAL_WHY]]);
  });

  test("AC3: flags an array literal headed by an identifier, not a string literal", () => {
    const violations = findGitSpawnViolations('Bun.spawn([gitBin, "status"], { cwd });');
    expect(violations.map((v) => [v.line, v.why])).toEqual([[1, NON_LITERAL_WHY]]);
  });

  test("AC4: accepts a non-literal argv when the call passes gitSpawnEnv(...)", () => {
    expect(findGitSpawnViolations("deps.spawn(cmd, { cwd, env: gitSpawnEnv() });")).toEqual([]);
  });

  test("AC5: accepts a non-literal argv when the call passes hardenedGitEnv(...)", () => {
    expect(findGitSpawnViolations("Bun.spawn(argv, { env: hardenedGitEnv(process.env) });")).toEqual([]);
  });

  test("AC6: accepts a non-literal argv marked on the line above", () => {
    expect(findGitSpawnViolations("// nax-git-env-allow: not git: hook argv\nBun.spawn(argv, { cwd });")).toEqual([]);
  });

  test("AC7: accepts a non-literal argv marked on its own line", () => {
    expect(findGitSpawnViolations("Bun.spawn(argv, { cwd }); // nax-git-env-allow: not git: acpx client")).toEqual([]);
  });

  test("AC8: an empty allow marker does not exempt a non-literal argv", () => {
    const violations = findGitSpawnViolations("// nax-git-env-allow:\nBun.spawn(argv, { cwd });");
    expect(violations.map((v) => [v.line, v.why])).toEqual([[2, NON_LITERAL_WHY]]);
  });

  test('AC9: accepts an argv literal headed by a non-"git" string literal', () => {
    expect(findGitSpawnViolations('Bun.spawn(["bun", "test"], { cwd });')).toEqual([]);
  });

  test("AC10: reports the spawn callee line for a multi-line call", () => {
    const violations = findGitSpawnViolations("const p = Bun.spawn(\n  argv,\n  { cwd },\n);");
    expect(violations.map((v) => [v.line, v.why])).toEqual([[1, NON_LITERAL_WHY]]);
  });

  test("AC11: does not flag a spawn mention inside a comment or a string", () => {
    expect(findGitSpawnViolations('// Bun.spawn(argv)\nconst s = "Bun.spawn(argv)";')).toEqual([]);
  });
});

describe("check-git-spawn-env CLI", () => {
  let root: string | undefined;

  afterEach(() => {
    cleanupTempDir(root);
    root = undefined;
  });

  function runGate(files: Record<string, string>): { code: number; out: string } {
    root = makeTempDir("nax-git-spawn-env-");
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), body, "utf8");
    }
    const proc = Bun.spawnSync(["bun", "run", SCRIPT, root]);
    return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
  }

  test("exits 0 on a clean tree", () => {
    const { code } = runGate({
      "src/a.ts": 'Bun.spawn(hardenedGitArgv(["git", "status"]), { env: gitSpawnEnv() });\n',
    });
    expect(code).toBe(0);
  });

  test("exits non-zero and names file:line on a violation", () => {
    const { code, out } = runGate({ "src/tdd/x.ts": '\nBun.spawn(["git", "status"], { cwd });\n' });
    expect(code).toBe(1);
    expect(out).toContain(join("src", "tdd", "x.ts:2"));
  });

  test("AC12: exits 0 and reports clean on this repository", () => {
    const repoRoot = join(import.meta.dir, "../../..");
    const proc = Bun.spawnSync(["bun", "run", SCRIPT, repoRoot]);
    const out = proc.stdout.toString() + proc.stderr.toString();
    expect(out).toContain("check-git-spawn-env: clean");
    expect(proc.exitCode).toBe(0);
  });
});
