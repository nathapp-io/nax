import { describe, expect, test } from "bun:test";
import { auditGaps, validateDispositions } from "@flows/nax-finish/steps/review-audit";
import type { ReviewVerdict } from "@flows/nax-finish/types";

const REPO = process.cwd();
const base = (over: Partial<ReviewVerdict> = {}): ReviewVerdict => ({
  route: "proceed",
  findings: [],
  sawTouchpointsSection: true,
  sawWalkSection: true,
  touchpoints: [{ path: "package.json", note: "the scripts block" }],
  walk: ["AC-1 Covered — yes"],
  ...over,
});

describe("auditGaps", () => {
  test("a complete review has no gaps", async () => {
    expect(await auditGaps(base(), REPO)).toEqual([]);
  });

  test("a missing TOUCHPOINTS section is a gap", async () => {
    const gaps = await auditGaps(base({ sawTouchpointsSection: false, touchpoints: [] }), REPO);
    expect(gaps.join(" ")).toContain("TOUCHPOINTS");
  });

  test("an empty TOUCHPOINTS section is a gap", async () => {
    const gaps = await auditGaps(base({ touchpoints: [] }), REPO);
    expect(gaps.join(" ")).toContain("TOUCHPOINTS");
  });

  test("the explicit none sentinel discharges the touchpoint obligation", async () => {
    expect(await auditGaps(base({ touchpoints: [{ path: "none", note: "one-line docstring" }] }), REPO)).toEqual([]);
  });

  test("touchpoint paths that do not exist are a gap", async () => {
    const gaps = await auditGaps(base({ touchpoints: [{ path: "src/does-not-exist.ts", note: "n" }] }), REPO);
    expect(gaps.join(" ")).toContain("does not exist");
  });

  test("one real path among fabricated ones is enough to pass", async () => {
    const gaps = await auditGaps(
      base({ touchpoints: [{ path: "src/nope.ts", note: "n" }, { path: "package.json", note: "n" }] }),
      REPO,
    );
    expect(gaps).toEqual([]);
  });

  test("a missing or empty WALK is a gap", async () => {
    expect((await auditGaps(base({ walk: [] }), REPO)).join(" ")).toContain("WALK");
    expect((await auditGaps(base({ sawWalkSection: false, walk: [] }), REPO)).join(" ")).toContain("WALK");
  });

  test("a touchpoint path escaping workdir via `../` is treated as not existing", async () => {
    const gaps = await auditGaps(
      base({ touchpoints: [{ path: "../../../../../../etc/passwd", note: "n" }] }),
      REPO,
    );
    expect(gaps.join(" ")).toContain("does not exist");
  });
});

describe("validateDispositions", () => {
  test("a rejection whose evidence path exists is left untouched", async () => {
    const d = await validateDispositions(REPO, [{ index: 1, disposition: "rejected", evidence: "package.json:1" }]);
    expect(d[0].evidenceMissing).toBeUndefined();
  });

  test("a rejection whose evidence escapes workdir via `../` is marked evidenceMissing", async () => {
    const d = await validateDispositions(REPO, [
      { index: 1, disposition: "rejected", evidence: "../../../../../../etc/passwd:1" },
    ]);
    expect(d[0].evidenceMissing).toBe(true);
  });
});
