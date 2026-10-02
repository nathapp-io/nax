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
  aggregateFailures,
  buildUpdatedBaseline,
  extractTestSummary,
  findMissingBaselined,
  findUnreportedFiles,
  gatedSuites,
  hasExecutableCode,
  parseLcov,
  parsePerFileLines,
  UNMEASURABLE,
} from "#scripts/check-coverage";

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

  test("counts src/ only: a sibling package's records, as lcov names them, are out of scope", () => {
    const totals = parseLcov(
      lcovWithFns([
        ["src/a.ts", 9, 10, 4, 5],
        ["../nax-agent/src/b.ts", 10, 10, 5, 5],
        ["../nax-agent/test/helpers/temp.ts", 0, 40, 0, 8],
      ]),
    );

    expect(totals).toEqual({ linesFound: 10, linesHit: 9, fnFound: 5, fnHit: 4 });
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

  test("leaves a sibling package's files out of the per-file map", () => {
    const perFile = parsePerFileLines(
      lcov([
        ["../nax-agent/src/tools/git.ts", 9, 10],
        ["src/a.ts", 1, 2],
      ]),
    );
    expect([...perFile.keys()]).toEqual(["src/a.ts"]);
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

describe("extractTestSummary", () => {
  const noise = "[logger] Failed to write\n\n❌ PRECHECK FAILED\n✗ working-tree-clean: dirty.txt\n";
  const summary =
    " 19554 pass\n 45 skip\n 0 fail\n 22 snapshots, 45295 expect() calls\nRan 19599 tests across 1539 files. [50.51s]";

  test("keeps the pass/fail block and drops the test noise around it", () => {
    const out = extractTestSummary(`bun test v1.4.2\n${noise}\n${summary}\n`);

    expect(out).toBe(`${summary}\n`);
    expect(out).not.toContain("PRECHECK FAILED");
  });

  test("returns an empty string when bun printed no summary", () => {
    expect(extractTestSummary(noise)).toBe("");
  });
});

describe("gatedSuites", () => {
  test("runs every candidate suite directory the package has, in order", () => {
    const present = new Set(["/pkg/test/unit/", "/pkg/test/integration/", "/pkg/test/ui/"]);
    expect(gatedSuites("/pkg", (p) => present.has(`${p}/`) || present.has(p))).toEqual([
      "test/unit/",
      "test/integration/",
      "test/ui/",
    ]);
  });

  test("skips a suite directory the package does not have", () => {
    const present = new Set(["/pkg/test/unit/", "/pkg/test/integration/"]);
    expect(gatedSuites("/pkg", (p) => present.has(`${p}/`) || present.has(p))).toEqual([
      "test/unit/",
      "test/integration/",
    ]);
  });
});

describe("hasExecutableCode", () => {
  test("a file of interfaces and type aliases has none", () => {
    expect(hasExecutableCode("export interface A { x: number }\nexport type B = A | string;\n")).toBe(false);
  });

  test("type-only imports and re-exports have none", () => {
    expect(hasExecutableCode('import type { A } from "./a";\nexport type { B } from "./b";\n')).toBe(false);
  });

  test("a barrel of value re-exports has none", () => {
    expect(hasExecutableCode('export * from "./a";\nexport { b } from "./b";\nexport * as c from "./c";\n')).toBe(
      false,
    );
  });

  test("comments alone have none", () => {
    expect(hasExecutableCode("/** doc */\n// note\n")).toBe(false);
  });

  test("a const declaration is code", () => {
    expect(hasExecutableCode("export const LIMIT = 3;\n")).toBe(true);
  });

  test("a function declaration is code", () => {
    expect(hasExecutableCode("export function f(): number { return 1; }\n")).toBe(true);
  });

  test("an enum is code (TypeScript emits an object for it)", () => {
    expect(hasExecutableCode("export enum Mode { A, B }\n")).toBe(true);
  });
});

describe("findUnreportedFiles", () => {
  const perFile = new Map([["src/reported.ts", 0.9]]);
  const allCode = () => true;

  test("a file the report names is not unreported", () => {
    expect(findUnreportedFiles(["src/reported.ts"], perFile, allCode, {})).toEqual([]);
  });

  test("an executable file the report omits is unreported, sorted", () => {
    expect(findUnreportedFiles(["src/z.ts", "src/a.ts", "src/reported.ts"], perFile, allCode, {})).toEqual([
      "src/a.ts",
      "src/z.ts",
    ]);
  });

  test("a file with no executable code is exempt", () => {
    expect(findUnreportedFiles(["src/types.ts"], perFile, () => false, {})).toEqual([]);
  });

  test("a file listed in UNMEASURABLE is exempt", () => {
    expect(findUnreportedFiles(["src/hole.ts"], perFile, allCode, { "src/hole.ts": "#1779 repro" })).toEqual([]);
  });
});

describe("hasExecutableCode on .ts-only syntax", () => {
  test("a generic arrow in a .ts file is code, not a transpile crash", () => {
    expect(hasExecutableCode("export const id = <T>(x: T): T => x;\n", "src/id.ts")).toBe(true);
  });

  test("source the transpiler rejects counts as code (fail loud, never exempt)", () => {
    expect(hasExecutableCode("export const = ;\n", "src/broken.ts")).toBe(true);
  });
});

describe("aggregateFailures", () => {
  test("a report that measured no src/ lines fails instead of reading as 100%", () => {
    expect(aggregateFailures({ linesFound: 0, linesHit: 0, fnFound: 0, fnHit: 0 })).toEqual([
      "the report measured no src/ lines (empty or mis-scoped lcov)",
    ]);
  });

  test("totals at the floor pass, and each floor below it is named", () => {
    expect(aggregateFailures({ linesFound: 10, linesHit: 8, fnFound: 10, fnHit: 8 })).toEqual([]);
    expect(aggregateFailures({ linesFound: 10, linesHit: 7, fnFound: 10, fnHit: 7 })).toEqual([
      "line coverage 70.00% < floor 80.00%",
      "function coverage 70.00% < floor 80.00%",
    ]);
  });
});
