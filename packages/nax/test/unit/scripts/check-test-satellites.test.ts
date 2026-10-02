import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Baseline, findTicketSatellites, formatReport, isTicketNamed } from "@scripts/check-test-satellites";

describe("isTicketNamed", () => {
  test("matches a ticket in the basename", () => {
    // TICKET_RE covers nax#123 / #1234 (a bare numeric suffix does NOT match),
    // US-001, AC5, ADR-019, BUG-30, "issue 12", "Task 4".
    expect(isTicketNamed("test/unit/tools/us-005.test.ts")).toBe(true);
    expect(isTicketNamed("test/unit/prompts/plan-adr-019.test.ts")).toBe(true);
    expect(isTicketNamed("test/unit/x/thing-bug-12.test.ts")).toBe(true);
    expect(isTicketNamed("test/unit/x/foo-ac5.test.ts")).toBe(true);
  });

  test("does not match a concern-named file", () => {
    expect(isTicketNamed("test/unit/execution/pid-registry.test.ts")).toBe(false);
    expect(isTicketNamed("test/unit/config/schemas-model.test.ts")).toBe(false);
    expect(isTicketNamed("test/unit/context/engine/stage-assembler-scope-files.test.ts")).toBe(false);
    // A bare numeric suffix is not a ticket reference.
    expect(isTicketNamed("test/unit/a/other-1234.test.ts")).toBe(false);
  });

  test("matches the basename only, not directory segments", () => {
    // A ticket-ish directory name must not flag a concern-named file inside it.
    expect(isTicketNamed("test/unit/us-001/pid-registry.test.ts")).toBe(false);
  });
});

describe("findTicketSatellites", () => {
  test("keeps ticket-named files and drops concern-named ones", () => {
    const paths = [
      "test/unit/a/clean.test.ts",
      "test/unit/a/clean-us-001.test.ts",
      "test/unit/a/other-adr-019.test.ts",
    ];
    expect(findTicketSatellites(paths, () => false)).toEqual([
      "test/unit/a/clean-us-001.test.ts",
      "test/unit/a/other-adr-019.test.ts",
    ]);
  });

  test("excludes mirrors so it never fails on a rule-compliant per-source file", () => {
    const paths = ["test/unit/a/clean-us-001.test.ts", "test/unit/a/other-adr-019.test.ts"];
    const isMirror = (p: string) => p === "test/unit/a/clean-us-001.test.ts";
    expect(findTicketSatellites(paths, isMirror)).toEqual(["test/unit/a/other-adr-019.test.ts"]);
  });

  test("returns a sorted empty list when nothing offends", () => {
    expect(findTicketSatellites(["test/unit/a/clean.test.ts"], () => false)).toEqual([]);
  });
});

describe("formatReport", () => {
  const baselineOf = (files: string[]): Baseline => ({
    updatedAt: "",
    byFile: Object.fromEntries(files.map((f) => [f, true as const])),
  });

  test("returns OK when the current set matches the baseline", () => {
    const { ok, message } = formatReport(["test/unit/a/us-001.test.ts"], baselineOf(["test/unit/a/us-001.test.ts"]));
    expect(ok).toBe(true);
    expect(message).toContain("[OK]");
    expect(message).toContain("baseline: 1");
  });

  test("returns OK with a lower-the-baseline hint when a grandfathered file is gone", () => {
    const { ok, message } = formatReport(
      ["test/unit/a/us-001.test.ts"],
      baselineOf(["test/unit/a/us-001.test.ts", "test/unit/a/us-002.test.ts"]),
    );
    expect(ok).toBe(true);
    expect(message).toContain("can be lowered");
  });

  test("returns FAIL and names a new ticket-named file", () => {
    const { ok, message, newViolations } = formatReport(
      ["test/unit/a/us-001.test.ts", "test/unit/a/new-bug-30.test.ts"],
      baselineOf(["test/unit/a/us-001.test.ts"]),
    );
    expect(ok).toBe(false);
    expect(message).toContain("[FAIL]");
    expect(message).toContain("new-bug-30.test.ts");
    expect(newViolations).toEqual(["test/unit/a/new-bug-30.test.ts"]);
  });

  test("returns FAIL when no baseline exists", () => {
    const { ok, message } = formatReport(["test/unit/a/us-001.test.ts"], null);
    expect(ok).toBe(false);
    expect(message).toContain("--update-baseline");
  });
});

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
  const SCRIPT = join(import.meta.dir, "../../../scripts/check-test-satellites.ts");
  const NAX_BASELINE = join(import.meta.dir, "../../../scripts/baselines/test-satellites-baseline.json");
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
