/**
 * US-005 — `nax cost` (`src/cli/cost.ts`), driven through its `CostCliDeps` seam.
 *
 * The report is stubbed, so every assertion here is about the command's own
 * contract: what it prints, what it reports when a read fails, and the exit code
 * it returns for the registered action to pass to `deps.exit` (the exit-code
 * half of each pair is pinned through `program.parseAsync` in
 * `test/integration/cli/cli-cost.test.ts`). AC-17 is the one case that reads a
 * real file — it exercises the US-004 core the command consumes.
 */
import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { assertDefined, withTempDir } from "@test/helpers";
import {
  _costCliDeps,
  type CostCliDeps,
  type CostGroupRow,
  type CostLedgerReport,
  type CostQuery,
  type CostTotals,
  costCommand,
  queryCostLedger,
} from "@/cli";
import { projectOutputDir } from "@/runtime";

// ─── fixtures ────────────────────────────────────────────────────────────────

/** 2026-10-10T12:00Z — a fixed clock, so the `--today` window is deterministic. */
const NOW = Date.UTC(2026, 9, 10, 12);
const GLOBAL_DIR = "/global";
/** What `--here` resolves a project to in the stubs (the real derivation is asserted below). */
const HERE_DIR = "/global/here";

interface LedgerCall {
  readonly files: readonly string[];
  readonly query: CostQuery;
}

/** Zeroed totals with the fields a test cares about overridden. */
function totals(over: Partial<CostTotals> = {}): CostTotals {
  return {
    calls: 0,
    errorCalls: 0,
    runs: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
    exactUsd: 0,
    estimatedUsd: 0,
    ...over,
  };
}

/** One group row: a group key plus its totals. */
function group(key: Record<string, string>, over: Partial<CostTotals> = {}): CostGroupRow {
  return { ...totals(over), key };
}

/** A schemaVersion-1 report; only the fields under assertion are overridden. */
function report(over: Partial<CostLedgerReport> = {}): CostLedgerReport {
  return {
    schemaVersion: 1,
    sinceMs: null,
    untilMs: null,
    groups: [],
    total: totals(),
    skippedRows: 0,
    filesScanned: 1,
    ...over,
  };
}

interface Harness {
  readonly deps: CostCliDeps;
  readonly out: string[];
  readonly err: string[];
  readonly calls: LedgerCall[];
}

/**
 * The deps seam with every call stubbed and recorded. `over` replaces one
 * dependency at a time — the shape the `_deps` convention asks for.
 */
function harness(over: Partial<CostCliDeps> = {}, result: CostLedgerReport = report()): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const calls: LedgerCall[] = [];
  const deps: CostCliDeps = {
    log: (msg) => out.push(msg),
    logErr: (msg) => err.push(msg),
    exit: () => {},
    now: () => NOW,
    globalConfigDir: () => GLOBAL_DIR,
    resolveProjectOutputDir: async () => HERE_DIR,
    listProjectOutputDirs: async () => [join(GLOBAL_DIR, "koda")],
    listCostLedgerFiles: async () => [join(GLOBAL_DIR, "koda", "cost", "r1.jsonl")],
    queryCostLedger: async (files, query) => {
      calls.push({ files, query });
      return result;
    },
    ...over,
  };
  return { deps, out, err, calls };
}

/** The single line at `index`, failing loudly rather than asserting on `undefined`. */
function lineAt(lines: readonly string[], index: number, label: string): string {
  const line = lines[index];
  assertDefined(line, label);
  return line;
}

/** The table's `TOTAL` line, wherever the group rows above it end. */
function totalLine(lines: readonly string[]): string {
  const total = lines.find((line) => line.startsWith("TOTAL"));
  assertDefined(total, "the TOTAL line");
  return total;
}

/** `err.code` without a cast — the fs error code is the observable AC-17 asserts. */
function codeOf(err: unknown): unknown {
  return typeof err === "object" && err !== null ? Reflect.get(err, "code") : undefined;
}

/** Resolve with the rejection reason of `promise`; fail the test if it resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to reject");
}

// ─── stdout ──────────────────────────────────────────────────────────────────

describe("costCommand stdout", () => {
  test("AC-6: --json writes exactly one line that parses as the CostLedgerReport", async () => {
    const result = report({
      groups: [group({ stage: "run" }, { calls: 2, costUsd: 1.5 })],
      total: totals({ calls: 2, costUsd: 1.5, exactUsd: 1.5 }),
      skippedRows: 4,
    });
    const h = harness({}, result);

    expect(await costCommand({ dir: "/proj", json: true }, h.deps)).toBe(0);

    expect(h.out).toHaveLength(1);
    const parsed: CostLedgerReport = JSON.parse(lineAt(h.out, 0, "the single stdout line"));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed).toEqual(result);
  });

  test("AC-7: --today --by stage prints one table line per group, then a line starting with TOTAL", async () => {
    const h = harness(
      {},
      report({
        groups: [
          group({ stage: "run" }, { calls: 240, costUsd: 45.1, exactUsd: 18.74, estimatedUsd: 26.36 }),
          group({ stage: "review" }, { calls: 50, costUsd: 12.2, estimatedUsd: 12.2 }),
        ],
        total: totals({ calls: 290, costUsd: 57.3, exactUsd: 18.74, estimatedUsd: 38.56 }),
      }),
    );

    expect(await costCommand({ dir: "/proj", today: true, by: "stage" }, h.deps)).toBe(0);

    expect(lineAt(h.out, 0, "the header line")).toStartWith("stage");
    expect(lineAt(h.out, 1, "the first group line")).toStartWith("run");
    expect(lineAt(h.out, 2, "the second group line")).toStartWith("review");
    expect(lineAt(h.out, 3, "the TOTAL line")).toStartWith("TOTAL");
    expect(h.out).toHaveLength(5); // header + 2 groups + TOTAL + the exact/estimated line
  });

  test("AC-8: prints exact $<n> / estimated $<n> with both amounts to two decimals", async () => {
    const h = harness({}, report({ total: totals({ costUsd: 60.4, exactUsd: 18.744, estimatedUsd: 41.6559 }) }));

    await costCommand({ dir: "/proj" }, h.deps);

    expect(h.out).toContain("exact $18.74 / estimated $41.66");
  });

  test("AC-9: prints the skipped-row line when skippedRows > 0", async () => {
    const h = harness({}, report({ skippedRows: 3 }));

    await costCommand({ dir: "/proj" }, h.deps);

    expect(h.out).toContain("skipped 3 unparseable row(s)");
  });

  test("AC-10: prints no skipped-row line when skippedRows is 0", async () => {
    const h = harness({}, report({ skippedRows: 0 }));

    await costCommand({ dir: "/proj" }, h.deps);

    expect(h.out.filter((line) => line.startsWith("skipped"))).toEqual([]);
  });

  test("AC-19: prints a TOTAL line with zero counts when no ledger rows match", async () => {
    const h = harness();

    expect(await costCommand({ dir: "/proj" }, h.deps)).toBe(0);

    const total = totalLine(h.out);
    expect(total.trim().split(/\s+/)).toEqual(["TOTAL", "0", "0", "0", "0", "0", "0", "0.00"]);
  });

  test("without --by the report is total-only, and --json stays one document when rows were skipped", async () => {
    const h = harness({}, report({ skippedRows: 7 }));

    expect(await costCommand({ dir: "/proj", json: true }, h.deps)).toBe(0);

    expect(h.out).toHaveLength(1);
    expect(h.out.filter((line) => line.startsWith("skipped"))).toEqual([]);

    const plain = harness({}, report({ skippedRows: 7 }));
    await costCommand({ dir: "/proj" }, plain.deps);
    const call = plain.calls[0];
    assertDefined(call, "the queryCostLedger call");
    expect(call.query.groupBy).toEqual([]);
    expect(plain.out.filter((line) => line.startsWith("TOTAL"))).toHaveLength(1);
  });

  test("B2: without --by every counter still sits under its own header name", async () => {
    // Distinct non-zero counters: with the label column missing from the header,
    // the TOTAL row's cells shift one column left and every number is mislabelled.
    const h = harness(
      {},
      report({
        total: totals({
          calls: 2,
          runs: 1,
          input: 30,
          output: 40,
          cacheRead: 50,
          cacheWrite: 60,
          costUsd: 1.25,
          exactUsd: 1,
          estimatedUsd: 0.25,
        }),
      }),
    );

    expect(await costCommand({ dir: "/proj" }, h.deps)).toBe(0);

    const header = lineAt(h.out, 0, "the header line");
    const total = totalLine(h.out);
    const expected: Readonly<Record<string, string>> = {
      calls: "2",
      runs: "1",
      input: "30",
      output: "40",
      cacheRead: "50",
      cacheWrite: "60",
      costUsd: "1.25",
    };
    for (const [name, value] of Object.entries(expected)) {
      const columnEnd = header.indexOf(name) + name.length;
      expect(header.indexOf(name)).toBeGreaterThan(-1);
      // Every counter column is right-aligned, so the value must end exactly
      // where its header cell ends. Without the reserved label column, the
      // `calls` header ends where `TOTAL` does, not where `2` does.
      expect(total.slice(0, columnEnd)).toEndWith(value);
    }
  });
});

// ─── stderr and the returned code ────────────────────────────────────────────

describe("costCommand failures", () => {
  test("AC-11: --by colour writes Error: and the unknown key to stderr", async () => {
    const h = harness();

    await costCommand({ dir: "/proj", by: "colour" }, h.deps);

    expect(h.err).toHaveLength(1);
    expect(lineAt(h.err, 0, "the stderr line")).toStartWith("Error:");
    expect(h.err.join("\n")).toContain("colour");
    expect(h.calls).toEqual([]); // a usage error never reaches the ledger
  });

  test("AC-13: --today --since 2026-10-10 writes Error: to stderr", async () => {
    const h = harness();

    await costCommand({ dir: "/proj", today: true, since: "2026-10-10" }, h.deps);

    expect(h.err).toHaveLength(1);
    expect(lineAt(h.err, 0, "the stderr line")).toStartWith("Error:");
    expect(h.out).toEqual([]);
  });

  test("AC-15: writes Error: and the thrown message when the ledger read rejects", async () => {
    const failure = new Error("ENOENT: no such file or directory, open '/global/koda/cost/r1.jsonl'");
    const h = harness({
      queryCostLedger: async () => {
        throw failure;
      },
    });

    await costCommand({ dir: "/proj" }, h.deps);

    expect(h.err).toEqual([`Error: ${failure.message}`]);
  });

  test("AC-12, AC-14, AC-16: every usage error and read failure returns the exit code 1", async () => {
    const usage = harness();
    const window = harness();
    const read = harness({
      queryCostLedger: async () => {
        throw new Error("EACCES: permission denied, open '/global/koda/cost/r1.jsonl'");
      },
    });

    expect(await costCommand({ dir: "/proj", by: "colour" }, usage.deps)).toBe(1);
    expect(await costCommand({ dir: "/proj", today: true, since: "2026-10-10" }, window.deps)).toBe(1);
    expect(await costCommand({ dir: "/proj" }, read.deps)).toBe(1);
  });

  test("AC-18: returns exit code 0 when no ledger rows match", async () => {
    const h = harness({}, report({ groups: [], total: totals() }));

    expect(await costCommand({ dir: "/proj" }, h.deps)).toBe(0);
  });
});

// ─── the real project-output resolution ──────────────────────────────────────

describe("_costCliDeps.resolveProjectOutputDir", () => {
  test("uses the project's configured name as the output-dir key", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, ".nax"), { recursive: true });
      await Bun.write(join(dir, ".nax", "config.json"), `${JSON.stringify({ name: "koda" })}\n`);

      expect(await _costCliDeps.resolveProjectOutputDir(dir)).toBe(projectOutputDir("koda", undefined));
    });
  });

  test("falls back to basename(dir) with no outputDir override when loadConfig rejects", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, ".nax"), { recursive: true });
      await Bun.write(join(dir, ".nax", "config.json"), "{ this is not json\n");

      expect(await _costCliDeps.resolveProjectOutputDir(dir)).toBe(projectOutputDir(basename(dir), undefined));
    });
  });
});

// ─── the US-004 core this command consumes ───────────────────────────────────

describe("queryCostLedger read failures", () => {
  test("AC-17: rejects when one of its listed ledger files does not exist", async () => {
    await withTempDir(async (dir) => {
      const missing = join(dir, "koda", "cost", "r1.jsonl");

      expect(codeOf(await rejectionOf(queryCostLedger([missing], { groupBy: [] })))).toBe("ENOENT");
    });
  });
});
