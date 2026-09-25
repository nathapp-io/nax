import { describe, expect, test } from "bun:test";
import { findGitSpawnViolations } from "../../../scripts/check-git-spawn-env";

const WHY = "git spawn without env: gitSpawnEnv(...)";

describe("AC-1: findGitSpawnViolations flags an unhardened direct git spawn", () => {
  test("AC-1: a direct spawn of a git argv literal with no env hardening yields exactly one violation", () => {
    // A non-status/diff verb (`rev-parse`) so the argv-hardening rule does not
    // add a second violation — this isolates the env rule under test.
    const source = 'const p = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd });';

    const violations = findGitSpawnViolations(source);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.why).toBe(WHY);
    // The `spawn` callee sits on line 1 of this source.
    expect(violations[0]?.line).toBe(1);
  });

  test("AC-1: the same rule fires for spawnSync", () => {
    const source = 'Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd });';

    const violations = findGitSpawnViolations(source);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.why).toBe(WHY);
    expect(violations[0]?.line).toBe(1);
  });

  test("AC-1: `line` is the 1-based line of the spawn callee, not a constant", () => {
    // The spawn callee opens on line 3 of this source.
    const source = [
      "const argv = undefined;",
      "// unrelated leading line",
      'const p = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd });',
    ].join("\n");

    const violations = findGitSpawnViolations(source);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.why).toBe(WHY);
    expect(violations[0]?.line).toBe(3);
  });
});