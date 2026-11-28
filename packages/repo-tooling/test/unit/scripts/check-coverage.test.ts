/**
 * Guards for the per-file coverage ratchet's missing-file handling (GitHub #1779).
 *
 * A file can be executed by a passing test and still have no `SF:` record in the lcov
 * report. Before these guards it silently left the below-floor list and
 * `--update-baseline` deleted its entry, so the ratchet read a disappearance as a
 * graduation. The two pure functions below are what stops that.
 *
 * The last two blocks cover the quiet (`AGENT=1`) capture path: a child whose leader
 * exits before its pipes close must not hang the run past its deadline, and the
 * diagnostics kept for a failure must stay bounded.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _coverageDeps,
  aggregateFailures,
  buildUpdatedBaseline,
  coverageTestArgs,
  evaluateCoverageGate,
  extractTestSummary,
  findMissingBaselined,
  findUnreportedFiles,
  gatedSuites,
  hasExecutableCode,
  main,
  parseLcov,
  parsePerFileLines,
  RUN_TIMEOUT_MS,
  type RunCoverageOptions,
  runCoverage,
  type SpawnOptions,
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

describe("evaluateCoverageGate", () => {
  test.each([
    ["AC-21", { NAX_SANDBOXED: "1" }, 0],
    ["AC-22", {}, 1],
  ] as const)("%s evaluates real per-file failures with above-floor totals", (_ac, env, expected) => {
    const logs: string[] = [];
    const baseline = spyOn(_coverageDeps, "loadPerFileBaseline").mockReturnValue({ byFile: {}, updatedAt: "test" });
    const details = spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = evaluateCoverageGate({
        totals: { linesFound: 100, linesHit: 90, fnFound: 100, fnHit: 90 },
        perFile: new Map([["src/__coverage_gate_new_file__.ts", 0.1]]),
        unreported: [],
        env,
        log: (message) => logs.push(message),
        error: () => {},
      });
      expect(code).toBe(expected);
      expect(baseline).toHaveBeenCalled();
      expect(details).toHaveBeenCalledWith("  src/__coverage_gate_new_file__.ts: 10.00% (floor 80%)");
      expect(logs.some((message) => message.includes("OK (sandboxed)"))).toBe(expected === 0);
    } finally {
      baseline.mockRestore();
      details.mockRestore();
    }
  });
});

describe("coverageTestArgs", () => {
  const paths = ["test/unit/", "test/integration/"];

  test("runs the given paths serially with lcov coverage and the CI per-test budget", () => {
    expect(coverageTestArgs(paths, [])).toEqual([
      "test",
      "test/unit/",
      "test/integration/",
      "--coverage",
      "--coverage-reporter=lcov",
      "--timeout=60000",
    ]);
  });

  test.each([["--parallel"], ["--parallel=4"]])("forwards %s to bun test with --no-isolate", (flag) => {
    const args = coverageTestArgs(paths, ["--require-all-files", flag]);
    expect(args.filter((arg) => arg.startsWith("--parallel") || arg.endsWith("isolate"))).toEqual([
      flag,
      "--no-isolate",
    ]);
  });

  test("adds no --no-isolate to a serial run", () => {
    expect(coverageTestArgs(paths, [])).not.toContain("--no-isolate");
  });

  test.each([["--parallel=0"], ["--parallel=-2"], ["--parallel=abc"], ["--parallel="]])(
    "rejects an invalid worker count in %s",
    (flag) => {
      expect(() => coverageTestArgs(paths, [flag])).toThrow("positive integer");
    },
  );
});

/** Deadline the test wrapper allows a run, so a hung runner fails in seconds, not in bun's --timeout. */
const WRAPPER_DEADLINE_MS = 5_000;
/** How long a run may take to settle after its injected deadline; beyond this it was not the deadline that returned. */
const SETTLE_BUDGET_MS = 2_500;
/** Returned by the wrapper when the runner never settles: no AC may return this. */
const WRAPPER_EXPIRED = "wrapper deadline expired";

/**
 * Races a runner promise against the test wrapper's own deadline.
 *
 * The ACs are about the runner finishing *on its injected deadline*; if the runner hangs
 * instead, the wrapper hands back a sentinel and the assertion fails loudly rather than
 * stalling the suite.
 */
async function underWrapperDeadline<T>(promise: Promise<T>): Promise<T | typeof WRAPPER_EXPIRED> {
  const expired = Bun.sleep(WRAPPER_DEADLINE_MS).then((): typeof WRAPPER_EXPIRED => WRAPPER_EXPIRED);
  return Promise.race<T | typeof WRAPPER_EXPIRED>([promise, expired]);
}

/** One `_coverageDeps.spawn` call, recorded so a fixture can be cleaned up whatever the outcome. */
interface SpawnCall {
  command: string[];
  options: SpawnOptions;
  child: Bun.Subprocess;
}

/** A child command under test, plus everything needed to leave no process behind. */
interface Fixture {
  /** What runCoverage is asked to launch. */
  command: string[];
  /** Pid file the fixture leader writes its descendant's pid to. */
  pidFile: string;
  /** Every spawn the run made; filled while the run is in flight. */
  spawned: SpawnCall[];
  /** The descendant the leader left holding the pipes, once it has written its pid. */
  descendant(): number | undefined;
  /** Kills whatever this fixture started. Safe after a failed assertion. */
  clean(): void;
}

function pidFilePath(): string {
  return join(tmpdir(), `nax-coverage-fixture-${crypto.randomUUID()}.pid`);
}

/** Wraps a command in a fixture, giving it a pid file and a cleanup that always runs. */
function fixtureOf(commandFor: (pidFile: string) => string[]): Fixture {
  const pidFile = pidFilePath();
  const spawned: SpawnCall[] = [];
  const descendant = (): number | undefined => {
    try {
      const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
      return Number.isNaN(pid) ? undefined : pid;
    } catch {
      // The leader has not written it (or never will: the run was killed first).
      return undefined;
    }
  };
  return {
    command: commandFor(pidFile),
    pidFile,
    spawned,
    descendant,
    clean(): void {
      for (const { child } of spawned) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The leader is already gone; only its descendant was left.
        }
      }
      const pid = descendant();
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already reaped by the runner's own group kill.
        }
      }
      rmSync(pidFile, { force: true });
    },
  };
}

/**
 * A fixture whose leader exits immediately while a descendant inherits and keeps both
 * pipes open — the shape that hung the quiet capture. `banner`, when given, is echoed to
 * stdout first, so a test can tell "output arrived, then the pipe stayed open" from
 * "nothing was ever written".
 */
function holdsPipesOpen(banner?: string): Fixture {
  const lead = banner === undefined ? "" : `echo ${banner}; `;
  return fixtureOf((pidFile) => ["sh", "-c", `${lead}sleep 30 & echo $! > ${pidFile}`]);
}

/** A fixture running an inline script under bun (no shell quoting, no temp source file). */
function bunScript(script: string): Fixture {
  return fixtureOf(() => ["bun", "-e", script]);
}

/** Whether a pid is still running. */
function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH: the process is gone.
    return false;
  }
}

/** Whether the fixture's descendant is gone within the budget, allowing for reap latency. */
async function goneWithin(pid: number | undefined, budgetMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await Bun.sleep(20);
  }
  return !isAlive(pid);
}

/** Waits for the fixture leader to publish the pid of the descendant it left behind. */
async function descendantPid(fixture: Fixture, budgetMs = 2_000): Promise<number | undefined> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const pid = fixture.descendant();
    if (pid !== undefined) return pid;
    await Bun.sleep(20);
  }
  return undefined;
}

/**
 * Runs the fixture through the real `runCoverage` capture path with `AGENT=1` (quiet),
 * collecting what the run prints through its output seams.
 */
async function runCaptured(
  fixture: Fixture,
  options: RunCoverageOptions = {},
): Promise<{ status: number | typeof WRAPPER_EXPIRED; printed: { out: string; err: string } }> {
  const printed = { out: "", err: "" };
  const realSpawn = _coverageDeps.spawn;
  const spy = spyOn(_coverageDeps, "spawn").mockImplementation((command, spawnOptions) => {
    const child = realSpawn(command, spawnOptions);
    fixture.spawned.push({ command, options: spawnOptions, child });
    return child;
  });
  try {
    const status = await underWrapperDeadline(
      runCoverage({
        command: fixture.command,
        quiet: true,
        timeoutMs: 2_000,
        out: (text) => {
          printed.out += text;
        },
        err: (text) => {
          printed.err += text;
        },
        ...options,
      }),
    );
    return { status, printed };
  } finally {
    spy.mockRestore();
  }
}

/** A child that writes far past the capture cap to both streams, then fails with a marker. */
const OVERFLOW_SCRIPT = [
  'for (let i = 0; i < 8000; i++) process.stdout.write("stdout-" + String(i).padStart(5, "0") + "\\n");',
  'for (let i = 0; i < 8000; i++) process.stderr.write("stderr-" + String(i).padStart(5, "0") + "\\n");',
  'process.stdout.write("STDOUT-TERMINAL\\n");',
  'process.stderr.write("STDERR-TERMINAL\\n");',
  "process.exit(3);",
].join("\n");

/** The `N pass`/`Ran N tests` block bun prints last, behind unrelated noise. */
const SUMMARY_BLOCK = " 4 pass\n 1 skip\n 0 fail\nRan 5 tests across 2 files. [1.00s]";
const SUMMARY_SCRIPT = `process.stderr.write(${JSON.stringify(`noise before the summary\n\n${SUMMARY_BLOCK}\n`)});`;

describe("runCoverage quiet capture", () => {
  test("AC-1: returns 124 on its injected deadline when a descendant holds the pipe open past the leader's exit", async () => {
    const fixture = holdsPipesOpen("leader-exiting");
    try {
      const started = Date.now();
      const { status, printed } = await runCaptured(fixture, { timeoutMs: 500 });
      const elapsed = Date.now() - started;
      const descendant = await descendantPid(fixture);

      expect(status).toBe(124);
      expect(elapsed).toBeGreaterThanOrEqual(500);
      expect(elapsed).toBeLessThan(SETTLE_BUDGET_MS);
      expect(printed.err).toContain("[coverage] unit suite exceeded 0.5s");
      expect(printed.out).toContain("leader-exiting");
      expect(descendant).toBeDefined();
      expect(await goneWithin(descendant)).toBe(true);
    } finally {
      fixture.clean();
    }
  });

  test("AC-7: returns 124 instead of waiting for EOF when both streams stay silent past the deadline", async () => {
    const fixture = holdsPipesOpen();
    try {
      const started = Date.now();
      const { status, printed } = await runCaptured(fixture, { timeoutMs: 300 });
      const elapsed = Date.now() - started;

      expect(status).toBe(124);
      expect(elapsed).toBeGreaterThanOrEqual(300);
      expect(elapsed).toBeLessThan(SETTLE_BUDGET_MS);
      expect(printed.out).toBe("");
      expect(printed.err).toContain("[coverage] unit suite exceeded 0.3s");
    } finally {
      fixture.clean();
    }
  });

  test("AC-3: keeps at most 64 KiB of diagnostics per stream, including the terminal failure text", async () => {
    const fixture = bunScript(OVERFLOW_SCRIPT);
    const cap = 64 * 1024;
    try {
      const { status, printed } = await runCaptured(fixture);

      expect(status).toBe(3);
      expect(Buffer.byteLength(printed.out)).toBeLessThanOrEqual(cap);
      expect(Buffer.byteLength(printed.err)).toBeLessThanOrEqual(cap);
      expect(printed.out.length).toBeGreaterThan(cap / 2);
      expect(printed.err.length).toBeGreaterThan(cap / 2);
      expect(printed.out).toContain("STDOUT-TERMINAL");
      expect(printed.err).toContain("STDERR-TERMINAL");
      expect(printed.out).not.toContain("stdout-00000");
      expect(printed.err).not.toContain("stderr-00000");
    } finally {
      fixture.clean();
    }
  });

  test("AC-4: a quiet success keeps the test summary and dumps none of the child's output", async () => {
    const fixture = bunScript(SUMMARY_SCRIPT);
    try {
      const { status, printed } = await runCaptured(fixture);

      expect(status).toBe(0);
      expect(printed.out).toBe(`${SUMMARY_BLOCK}\n`);
      expect(printed.err).toBe("");
      expect(printed.out).not.toContain("noise before the summary");
    } finally {
      fixture.clean();
    }
  });

  test("AC-5: honors the child's own status when EOF arrives within the deadline", async () => {
    const fixture = bunScript(
      'process.stdout.write("partial stdout\\n"); process.stderr.write("partial stderr\\n"); process.exit(7);',
    );
    try {
      const { status, printed } = await runCaptured(fixture);

      expect(status).toBe(7);
      expect(printed.out).toContain("partial stdout");
      expect(printed.err).toContain("partial stderr");
    } finally {
      fixture.clean();
    }
  });

  test("AC-6: a non-quiet run leaves both streams inherited and captures nothing", async () => {
    const fixture = fixtureOf(() => ["sh", "-c", "exit 0"]);
    try {
      const { status, printed } = await runCaptured(fixture, { quiet: false });

      expect(status).toBe(0);
      expect(fixture.spawned).toHaveLength(1);
      expect(fixture.spawned[0]?.options.stdout).toBe("inherit");
      expect(fixture.spawned[0]?.options.stderr).toBe("inherit");
      expect(printed).toEqual({ out: "", err: "" });
    } finally {
      fixture.clean();
    }
  });

  test("the default deadline stays 480 seconds", () => {
    expect(RUN_TIMEOUT_MS).toBe(480_000);
  });
});

describe("main", () => {
  test("AC-2: maps a deadline failure to CLI status 1 without waiting for the descendant", async () => {
    const fixture = holdsPipesOpen();
    const exits: number[] = [];
    const errors: string[] = [];
    const realSpawn = _coverageDeps.spawn;
    const spy = spyOn(_coverageDeps, "spawn").mockImplementation((command, spawnOptions) => {
      const child = realSpawn(command, spawnOptions);
      fixture.spawned.push({ command, options: spawnOptions, child });
      return child;
    });
    try {
      const started = Date.now();
      const returned = await underWrapperDeadline(
        main({
          runOptions: {
            command: fixture.command,
            quiet: true,
            timeoutMs: 300,
            out: () => {},
            err: () => {},
          },
          exit: (code) => {
            exits.push(code);
          },
          error: (message) => {
            errors.push(message);
          },
        }),
      );
      const elapsed = Date.now() - started;
      const descendant = await descendantPid(fixture);

      expect(returned).toBeUndefined();
      expect(elapsed).toBeLessThan(SETTLE_BUDGET_MS);
      expect(exits).toEqual([1]);
      expect(errors.join("\n")).toContain("test run failed (exit 124)");
      expect(descendant).toBeDefined();
      expect(await goneWithin(descendant)).toBe(true);
    } finally {
      spy.mockRestore();
      fixture.clean();
    }
  });
});
