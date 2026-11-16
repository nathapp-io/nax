import { describe, expect, test } from "bun:test";
import type { TestBaseline } from "@/verification";
import { baselineForPackage } from "@/verification";

/** A captured run-start baseline scoped to two packages. */
function capturedTwoPackages(): TestBaseline & { kind: "captured" } {
  return {
    kind: "captured",
    source: "preflight",
    capturedAt: "2026-01-15T00:00:00.000Z",
    packageDirs: ["packages/a", "packages/b"],
    entries: [
      { file: "packages/a/x.test.ts", testName: "t", packageDir: "packages/a" },
      { file: "x.test.ts", testName: "t", packageDir: "packages/b" },
    ],
  };
}

describe("baselineForPackage", () => {
  test("AC-9: narrows the entries to the requested package", () => {
    const narrowed = baselineForPackage(capturedTwoPackages(), "packages/a");

    expect(narrowed?.kind).toBe("captured");
    if (narrowed?.kind !== "captured") throw new Error("expected a captured baseline");
    expect(narrowed.entries).toEqual([{ file: "packages/a/x.test.ts", testName: "t", packageDir: "packages/a" }]);
  });

  test("AC-10: an entry with no packageDir belongs to the repo root", () => {
    const baseline: TestBaseline = {
      kind: "captured",
      source: "preflight",
      capturedAt: "2026-01-15T00:00:00.000Z",
      packageDirs: [".", "packages/a"],
      entries: [
        { file: "root.test.ts", testName: "root" },
        { file: "packages/a/x.test.ts", testName: "t", packageDir: "packages/a" },
      ],
    };

    const narrowed = baselineForPackage(baseline, ".");

    expect(narrowed?.kind).toBe("captured");
    if (narrowed?.kind !== "captured") throw new Error("expected a captured baseline");
    expect(narrowed.entries).toEqual([{ file: "root.test.ts", testName: "root" }]);
  });

  test("AC-11: a package the baseline never captured yields undefined", () => {
    const baseline: TestBaseline = {
      kind: "captured",
      source: "preflight",
      capturedAt: "2026-01-15T00:00:00.000Z",
      packageDirs: ["packages/a"],
      entries: [{ file: "packages/a/x.test.ts", testName: "t", packageDir: "packages/a" }],
    };

    expect(baselineForPackage(baseline, "packages/b")).toBeUndefined();
  });

  test("AC-12: a baseline with no packageDirs is returned unchanged", () => {
    const baseline: TestBaseline = {
      kind: "captured",
      source: "preflight",
      capturedAt: "2026-01-15T00:00:00.000Z",
      entries: [{ file: "x.test.ts", testName: "t", packageDir: "packages/a" }],
    };

    const narrowed = baselineForPackage(baseline, "packages/b");

    expect(narrowed?.kind).toBe("captured");
    if (narrowed?.kind !== "captured") throw new Error("expected a captured baseline");
    expect(narrowed.entries).toEqual(baseline.entries);
  });

  test("AC-13: a no-baseline marker is returned unchanged", () => {
    const marker: TestBaseline = { kind: "no-baseline", reason: "timeout", capturedAt: "t" };

    expect(baselineForPackage(marker, "packages/a")).toEqual({
      kind: "no-baseline",
      reason: "timeout",
      capturedAt: "t",
    });
  });

  test("AC-13b: an absent baseline stays absent", () => {
    expect(baselineForPackage(undefined, "packages/a")).toBeUndefined();
  });
});
