/**
 * The git-spawn hardening gate (#2198): every git nax spawns carries
 * `gitSpawnEnv` / `hardenedGitEnv`, or is marked as handed to a runner that
 * hardens it. Proven by violating it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findGitSpawnViolations } from "@scripts/check-git-spawn-env";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

const SCRIPT = join(import.meta.dir, "../../../scripts/check-git-spawn-env.ts");

describe("findGitSpawnViolations", () => {
  test.each([
    ["an inline spawn carrying gitSpawnEnv", 'Bun.spawn(["git", "status"], { cwd, env: gitSpawnEnv() });'],
    [
      "a deps spawn with an overlay",
      '_deps.spawn(["git", ...args], {\n  cwd,\n  env: gitSpawnEnv({ GIT_DIR: d }),\n});',
    ],
    ["a cmd-object spawn", 'deps.spawn({\n  cmd: ["git", ...args],\n  cwd,\n  env: gitSpawnEnv(),\n});'],
    ["a spawnSync spreading shared options", 'Bun.spawnSync(["git", "config"], { ...opts, env: gitSpawnEnv() });'],
    [
      "an argv inside a grouping paren",
      'deps.spawn([...(over ?? ["git", ...args])], { env: hardenedGitEnv(process.env) });',
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
    const { code } = runGate({ "src/a.ts": 'Bun.spawn(["git", "status"], { env: gitSpawnEnv() });\n' });
    expect(code).toBe(0);
  });

  test("exits non-zero and names file:line on a violation", () => {
    const { code, out } = runGate({ "src/tdd/x.ts": '\nBun.spawn(["git", "status"], { cwd });\n' });
    expect(code).toBe(1);
    expect(out).toContain(join("src", "tdd", "x.ts:2"));
  });
});
