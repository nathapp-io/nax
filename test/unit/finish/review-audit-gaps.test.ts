import { describe, expect, test } from "bun:test";
/**
 * The obligation gate: a review report only counts once it proves the
 * touchpoints it lists are real paths in the repo, and once it enumerated its
 * per-AC/per-function walk. See `src/finish/review/audit-gaps.ts` for why the
 * disk check exists and why `../`-confinement matters here.
 */
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import type { FindingDisposition, ReviewReport } from "@/finish";
import { auditGaps, validateDispositions } from "@/finish";

function makeReport(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    findings: [],
    touchpoints: [],
    walk: [],
    sawNoFindings: false,
    sawTouchpointsSection: false,
    sawWalkSection: false,
    ...overrides,
  };
}

describe("auditGaps", () => {
  test("reports the touchpoints gap when the section is absent", async () => {
    await withTempDir(async (dir) => {
      const report = makeReport({ sawTouchpointsSection: false, sawWalkSection: true, walk: ["AC-1 Covered"] });
      const gaps = await auditGaps(report, dir, { base: "main", head: "HEAD" }, "spec");
      expect(gaps).toContain(
        "no `## TOUCHPOINTS` section: list every external definition you opened, or `- none — <justification>`",
      );
    });
  });

  test("reports the touchpoints gap when the section is present but empty", async () => {
    await withTempDir(async (dir) => {
      const report = makeReport({
        sawTouchpointsSection: true,
        touchpoints: [],
        sawWalkSection: true,
        walk: ["AC-1 Covered"],
      });
      const gaps = await auditGaps(report, dir, { base: "main", head: "HEAD" }, "spec");
      expect(gaps).toContain(
        "no `## TOUCHPOINTS` section: list every external definition you opened, or `- none — <justification>`",
      );
    });
  });

  test("- none sentinel discharges the touchpoints gap without stat-ing anything", async () => {
    await withTempDir(async (dir) => {
      const report = makeReport({
        sawTouchpointsSection: true,
        touchpoints: [{ path: "none", note: "no external definitions touched" }],
        sawWalkSection: true,
        walk: ["AC-1 Covered"],
      });
      const gaps = await auditGaps(report, dir, { base: "main", head: "HEAD" }, "spec");
      expect(gaps).toEqual([]);
    });
  });

  test("reports the touchpoints gap when no listed path exists", async () => {
    await withTempDir(async (dir) => {
      const report = makeReport({
        sawTouchpointsSection: true,
        touchpoints: [
          { path: "src/does-not-exist-a.ts", note: "fake" },
          { path: "src/does-not-exist-b.ts", note: "also fake" },
        ],
        sawWalkSection: true,
        walk: ["AC-1 Covered"],
      });
      const gaps = await auditGaps(report, dir, { base: "main", head: "HEAD" }, "spec");
      expect(gaps.some((g) => g.includes("touchpoint path does not exist"))).toBe(true);
    });
  });

  test("a path escaping workdir via ../ reads as non-existent even when it exists on disk", async () => {
    await withTempDir(async (outerDir) => {
      // A real file that sits just outside `workdir` (a subdirectory of outerDir).
      await Bun.write(join(outerDir, "secret.ts"), "export const secret = 1;\n");
      const workdir = join(outerDir, "workdir");
      await Bun.write(join(workdir, "placeholder.txt"), "");

      const report = makeReport({
        sawTouchpointsSection: true,
        touchpoints: [{ path: "../secret.ts", note: "tries to escape workdir" }],
        sawWalkSection: true,
        walk: ["AC-1 Covered"],
      });
      const gaps = await auditGaps(report, workdir, { base: "main", head: "HEAD" }, "spec");
      expect(gaps.some((g) => g.includes("touchpoint path does not exist"))).toBe(true);
    });
  });

  test("reports the walk gap when the section is absent", async () => {
    await withTempDir(async (dir) => {
      const report = makeReport({
        sawTouchpointsSection: true,
        touchpoints: [{ path: "none", note: "n/a" }],
        sawWalkSection: false,
        walk: [],
      });
      const gaps = await auditGaps(report, dir, { base: "main", head: "HEAD" }, "spec");
      expect(gaps).toContain(
        "no `## WALK` section: the per-AC (spec) or per-function (quality) enumeration is required",
      );
    });
  });

  test("reports the walk gap when the section is present but empty", async () => {
    await withTempDir(async (dir) => {
      const report = makeReport({
        sawTouchpointsSection: true,
        touchpoints: [{ path: "none", note: "n/a" }],
        sawWalkSection: true,
        walk: [],
      });
      const gaps = await auditGaps(report, dir, { base: "main", head: "HEAD" }, "spec");
      expect(gaps).toContain(
        "no `## WALK` section: the per-AC (spec) or per-function (quality) enumeration is required",
      );
    });
  });

  test("a fully compliant report yields no gaps", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "real.ts"), "export const x = 1;\n");
      const report = makeReport({
        sawTouchpointsSection: true,
        touchpoints: [{ path: "real.ts", note: "real one" }],
        sawWalkSection: true,
        walk: ["AC-1 Covered"],
      });
      const gaps = await auditGaps(report, dir, { base: "main", head: "HEAD" }, "spec");
      expect(gaps).toEqual([]);
    });
  });
});

describe("validateDispositions", () => {
  test("marks evidenceMissing only on a rejected disposition whose cited file is absent", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "real.ts"), "export const x = 1;\n");
      const dispositions: FindingDisposition[] = [
        { index: 1, disposition: "rejected", evidence: "real.ts:12" },
        { index: 2, disposition: "rejected", evidence: "missing.ts:3" },
      ];
      const out = await validateDispositions(dir, dispositions);
      expect(out[0].evidenceMissing).toBeUndefined();
      expect(out[1].evidenceMissing).toBe(true);
    });
  });

  test("leaves fixed dispositions untouched regardless of their evidence field", async () => {
    await withTempDir(async (dir) => {
      const dispositions: FindingDisposition[] = [
        { index: 1, disposition: "fixed", evidence: "missing.ts:3" },
        { index: 2, disposition: "fixed" },
      ];
      const out = await validateDispositions(dir, dispositions);
      expect(out).toEqual(dispositions);
      expect(out[0].evidenceMissing).toBeUndefined();
      expect(out[1].evidenceMissing).toBeUndefined();
    });
  });

  test("leaves a rejected disposition without evidence untouched", async () => {
    await withTempDir(async (dir) => {
      const dispositions: FindingDisposition[] = [{ index: 1, disposition: "rejected" }];
      const out = await validateDispositions(dir, dispositions);
      expect(out[0].evidenceMissing).toBeUndefined();
    });
  });
});
