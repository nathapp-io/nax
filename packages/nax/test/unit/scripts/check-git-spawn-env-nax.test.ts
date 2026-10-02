import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const SCRIPT = join(REPO, "..", "repo-tooling", "scripts", "check-git-spawn-env.ts");

describe("check-git-spawn-env CLI", () => {
  test("AC12: exits 0 and reports clean on this repository", () => {
    const proc = Bun.spawnSync(["bun", "run", SCRIPT, REPO]);
    const out = proc.stdout.toString() + proc.stderr.toString();
    expect(out).toContain("check-git-spawn-env: clean");
    expect(proc.exitCode).toBe(0);
  });
});
