/**
 * Guards for the per-file coverage ratchet's missing-file handling (GitHub #1779).
 *
 * A file can be executed by a passing test and still have no `SF:` record in the lcov
 * report. Before these guards it silently left the below-floor list and
 * `--update-baseline` deleted its entry, so the ratchet read a disappearance as a
 * graduation. The two pure functions below are what stops that.
 */

import { describe, expect, test } from "bun:test";
import {
  buildUpdatedBaseline,
  findMissingBaselined,
  parseLcov,
  parsePerFileLines,
  UNMEASURABLE,
} from "@scripts/check-coverage";

/** Builds an lcov body for the given files, each as a `covered/found` line pair. */
function lcov(records: Array<[file: string, hit: number, found: number]>): string {
  return records.map(([file, lh, lf]) => `SF:${file}\nLF:${lf}\nLH:${lh}\nend_of_record`).join("\n");
}

const everythingExists = () => true;

/** Builds an lcov body carrying function counters as well as line counters. */
function lcovWithFns(records: Array<[file: string, lh: number, lf: number, fnh: number, fnf: number]>): string {
  return records
    .map(([file, lh, lf, fnh, fnf]) => `SF:${file}\nFNF:${fnf}\nFNH:${fnh}\nLF:${lf}\nLH:${lh}\nend_of_record`)
    .join("\n");
}

describe("parseLcov", () => {
  test("sums only records under src/", () => {
    // `coverageSkipTestFiles` drops *.test.ts but not test/helpers/** or
    // test/preload.ts, so an unscoped sum folds test scaffolding into the aggregate.
    const totals = parseLcov(
      lcovWithFns([
        ["src/a.ts", 9, 10, 4, 5],
        ["test/helpers/temp.ts", 1, 100, 0, 20],
        ["test/preload.ts", 2, 50, 1, 10],
      ]),
    );

    expect(totals).toEqual({ linesFound: 10, linesHit: 9, fnFound: 5, fnHit: 4 });
  });

  test("sums every src record, not just the first", () => {
    const totals = parseLcov(
      lcovWithFns([
        ["src/a.ts", 9, 10, 4, 5],
        ["src/b.ts", 1, 10, 1, 5],
      ]),
    );

    expect(totals).toEqual({ linesFound: 20, linesHit: 10, fnFound: 10, fnHit: 5 });
  });

  test("the scope prefix is injectable", () => {
    const body = lcovWithFns([
      ["src/a.ts", 9, 10, 4, 5],
      ["test/helpers/temp.ts", 1, 100, 0, 20],
    ]);

    expect(parseLcov(body, "test/").linesFound).toBe(100);
  });
});

describe("parsePerFileLines", () => {
  test("reports each src file's line ratio and ignores paths outside src/", () => {
    const perFile = parsePerFileLines(
      lcov([
        ["src/a.ts", 8, 10],
        ["test/unit/a.test.ts", 1, 1],
        ["../tmp/plugin.ts", 1, 1],
      ]),
    );

    expect([...perFile.keys()]).toEqual(["src/a.ts"]);
    expect(perFile.get("src/a.ts")).toBeCloseTo(0.8, 5);
  });

  test("a file with no findable lines counts as fully covered rather than dividing by zero", () => {
    expect(parsePerFileLines(lcov([["src/empty.ts", 0, 0]])).get("src/empty.ts")).toBe(1);
  });
});

describe("findMissingBaselined", () => {
  test("reports a baselined file the report omitted while it still exists on disk", () => {
    const missing = findMissingBaselined({ "src/gone.ts": 0.42 }, new Map(), everythingExists);

    expect(missing).toEqual([{ file: "src/gone.ts", recorded: 0.42 }]);
  });

  test("says nothing about a baselined file the report did mention", () => {
    const perFile = new Map([["src/gone.ts", 0.42]]);

    expect(findMissingBaselined({ "src/gone.ts": 0.42 }, perFile, everythingExists)).toEqual([]);
  });

  test("says nothing about a baselined file that was deleted from the tree", () => {
    expect(findMissingBaselined({ "src/deleted.ts": 0.42 }, new Map(), () => false)).toEqual([]);
  });

  test("says nothing about a file the caller declared unmeasurable", () => {
    const unmeasurable = { "src/unmeasurable.ts": "reason, see #1779" };

    expect(findMissingBaselined({ "src/unmeasurable.ts": 0.42 }, new Map(), everythingExists, unmeasurable)).toEqual(
      [],
    );
  });

  // These two used to iterate UNMEASURABLE's entries, which passes vacuously now that
  // the shipped map is empty. Pin the emptiness directly, and keep the shape guard
  // meaningful by running it over whatever the map holds plus a synthetic entry.
  test("the shipped UNMEASURABLE map is empty", () => {
    expect(UNMEASURABLE).toEqual({});
  });

  test("an unmeasurable entry must carry a reason naming its issue", () => {
    const entries = { ...UNMEASURABLE, "src/synthetic.ts": "kept honest, see #1779" };

    for (const reason of Object.values(entries)) {
      expect(reason).toMatch(/#\d+/);
    }
  });
});

describe("buildUpdatedBaseline", () => {
  test("records every below-floor file the report measured", () => {
    const perFile = new Map([
      ["src/low.ts", 0.5],
      ["src/high.ts", 0.95],
    ]);

    expect(buildUpdatedBaseline({}, perFile, everythingExists).byFile).toEqual({ "src/low.ts": 0.5 });
  });

  test("carries a vanished entry forward at its recorded number instead of dropping it", () => {
    const { byFile, carried } = buildUpdatedBaseline({ "src/vanished.ts": 0.77 }, new Map(), everythingExists);

    expect(byFile).toEqual({ "src/vanished.ts": 0.77 });
    expect(carried).toEqual(["src/vanished.ts"]);
  });

  test("drops an entry whose file no longer exists", () => {
    const { byFile, carried } = buildUpdatedBaseline({ "src/deleted.ts": 0.77 }, new Map(), () => false);

    expect(byFile).toEqual({});
    expect(carried).toEqual([]);
  });

  test("drops an entry the report now shows at or above the floor", () => {
    const perFile = new Map([["src/graduated.ts", 0.81]]);

    const { byFile, carried } = buildUpdatedBaseline({ "src/graduated.ts": 0.6 }, perFile, everythingExists);

    expect(byFile).toEqual({});
    expect(carried).toEqual([]);
  });

  test("a measured number wins over the carried one when the report has both", () => {
    const perFile = new Map([["src/measured.ts", 0.4]]);

    const { byFile } = buildUpdatedBaseline({ "src/measured.ts": 0.6 }, perFile, everythingExists);

    expect(byFile).toEqual({ "src/measured.ts": 0.4 });
  });
});
