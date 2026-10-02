import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Baseline } from "@nathapp/nax-repo-tooling/scripts/check-test-satellites";

const REPO = join(import.meta.dir, "..", "..", "..");

/**
 * The gate's two anchors, only observable through a spawned process.
 *
 * Both used to resolve to packages/nax regardless of `--package`, so the gate
 * scanned nax while nax-agent's three ticket-named files sat ungated, and
 * `--update-baseline` from nax-agent would have overwritten nax's baseline with
 * nax-agent's list. The pure-function tests above cannot see either defect: they
 * are handed their paths.
 */
describe("the gate anchors to the package --package names", () => {
  const SCRIPT = join(REPO, "..", "repo-tooling", "scripts", "check-test-satellites.ts");
  const NAX_BASELINE = join(REPO, "scripts", "baselines", "test-satellites-baseline.json");
  const BASELINE_REL = "scripts/baselines/test-satellites-baseline.json";
  const FIRST = "test/unit/tools/us-501-first.test.ts";
  const SECOND = "test/unit/tools/us-502-second.test.ts";

  let root = "";

  afterEach(() => {
    if (root !== "") rmSync(root, { recursive: true, force: true });
    root = "";
  });

  /** Materialise a fixture package and return its root. */
  function tree(files: Record<string, string>): string {
    root = mkdtempSync(join(tmpdir(), "nax-satellites-gate-"));
    for (const [rel, body] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, body, "utf8");
    }
    return root;
  }

  function runGate(...args: string[]): { code: number; out: string } {
    const proc = Bun.spawnSync(["bun", "run", SCRIPT, `--package=${root}`, ...args]);
    return { code: proc.exitCode ?? 0, out: proc.stdout.toString() + proc.stderr.toString() };
  }

  test("--update-baseline writes into the scanned package and leaves the gate's own package untouched", () => {
    const before = readFileSync(NAX_BASELINE, "utf8");
    tree({ [FIRST]: 'describe("first", () => {});\n' });

    const { code, out } = runGate("--update-baseline");

    // nax's baseline is the one corruption that reads as success: the gate
    // would report [OK] while having recorded nax-agent's files as nax's.
    expect(code).toBe(0);
    expect(out).toContain("Baseline saved: 1 ticket-named test file(s).");
    expect(readFileSync(NAX_BASELINE, "utf8")).toBe(before);

    const seeded: Baseline = JSON.parse(readFileSync(join(root, BASELINE_REL), "utf8"));
    expect(Object.keys(seeded.byFile)).toEqual([FIRST]);
  });

  test("the ratchet is live in the scanned package, not merely reachable", () => {
    tree({ [FIRST]: 'describe("first", () => {});\n' });
    expect(runGate("--update-baseline").code).toBe(0);

    // A gate that seeded the fixture and then never compared against it would
    // pass the test above. Growth is the thing it exists to stop.
    writeFileSync(join(root, SECOND), 'describe("second", () => {});\n', "utf8");
    const { code, out } = runGate();

    expect(code).not.toBe(0);
    expect(out).toContain(SECOND);
  });
});
