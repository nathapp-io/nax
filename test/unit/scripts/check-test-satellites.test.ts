import { describe, expect, test } from "bun:test";
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
