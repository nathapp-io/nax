/**
 * US-005 — `nax cost` through its registration (`registerCostCommand`).
 *
 * Every assertion enters through `program.parseAsync(["node", "nax", "cost", …])`
 * with the `CostCliDeps` seam stubbed, so what is pinned is the CLI as the
 * operator invokes it: which flags exist, which scan roots they produce, what
 * reaches `queryCostLedger`, what lands on each output channel, and which code
 * the action hands to `deps.exit` (AC-12/14/16/18 and AC-20-25 — the exit half
 * of the pairs whose stderr half `test/unit/cli/cost.test.ts` owns).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assertDefined } from "@test/helpers";
import { Command } from "commander";
import {
  type CostCliDeps,
  type CostGroupRow,
  type CostLedgerReport,
  type CostQuery,
  type CostTotals,
  registerCostCommand,
} from "@/cli";

// ─── fixtures ────────────────────────────────────────────────────────────────

/** 2026-10-10T12:00Z — a fixed clock, so `--today` is deterministic. */
const NOW = Date.UTC(2026, 9, 10, 12);
const GLOBAL_DIR = "/global";
const KODA_ROOT = join(GLOBAL_DIR, "koda");
const NORTHWIND_ROOT = join(GLOBAL_DIR, "northwind");
const LEDGER_FILE = join(KODA_ROOT, "cost", "r1.jsonl");

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

/** One group row: a group key plus its totals. */
function group(key: Record<string, string>, over: Partial<CostTotals> = {}): CostGroupRow {
  return { ...totals(over), key };
}

/** The local midnight of `nowMs`'s calendar day — what `--today` resolves to. */
function localMidnight(nowMs: number): number {
  const now = new Date(nowMs);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

interface LedgerCall {
  readonly files: readonly string[];
  readonly query: CostQuery;
}

interface Harness {
  readonly deps: CostCliDeps;
  readonly out: string[];
  readonly err: string[];
  readonly codes: number[];
  readonly calls: LedgerCall[];
  /** Arguments of each `listProjectOutputDirs` call. */
  readonly globalDirs: string[];
  /** Roots passed to `listCostLedgerFiles`, one entry per call. */
  readonly fileRoots: Array<readonly string[]>;
  /** Directories handed to `resolveProjectOutputDir` (only reachable via `--here`). */
  readonly hereDirs: string[];
}

function harness(over: Partial<CostCliDeps> = {}, result: CostLedgerReport = report()): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  const calls: LedgerCall[] = [];
  const globalDirs: string[] = [];
  const fileRoots: Array<readonly string[]> = [];
  const hereDirs: string[] = [];
  const deps: CostCliDeps = {
    log: (msg) => out.push(msg),
    logErr: (msg) => err.push(msg),
    exit: (code) => codes.push(code),
    now: () => NOW,
    globalConfigDir: () => GLOBAL_DIR,
    resolveProjectOutputDir: async (dir) => {
      hereDirs.push(dir);
      return join(GLOBAL_DIR, "here");
    },
    listProjectOutputDirs: async (globalDir) => {
      globalDirs.push(globalDir);
      return [KODA_ROOT, NORTHWIND_ROOT];
    },
    listCostLedgerFiles: async (roots) => {
      fileRoots.push(roots);
      return [LEDGER_FILE];
    },
    queryCostLedger: async (files, query) => {
      calls.push({ files, query });
      return result;
    },
    ...over,
  };
  return { deps, out, err, codes, calls, globalDirs, fileRoots, hereDirs };
}

/** `nax cost <args>` through a program the command registered itself on. */
async function runCost(h: Harness, args: readonly string[]): Promise<void> {
  const program = new Command();
  registerCostCommand(program, h.deps);
  await program.parseAsync(["node", "nax", "cost", ...args]);
}

/** The single query the command ran; fails loudly when it ran none. */
function onlyCall(h: Harness): LedgerCall {
  expect(h.calls).toHaveLength(1);
  const call = h.calls[0];
  assertDefined(call, "the queryCostLedger call");
  return call;
}

/** The single argument list `listCostLedgerFiles` received. */
function onlyRoots(h: Harness): readonly string[] {
  expect(h.fileRoots).toHaveLength(1);
  const roots = h.fileRoots[0];
  assertDefined(roots, "the listCostLedgerFiles roots");
  return roots;
}

// ─── the query the flags build ───────────────────────────────────────────────

describe("nax cost — query", () => {
  test("AC-1: --today --by model queries once for today's local midnight, grouped by model", async () => {
    const h = harness();

    await runCost(h, ["--today", "--by", "model"]);

    const { query } = onlyCall(h);
    expect(query.groupBy).toEqual(["model"]);
    expect(query.sinceMs).toBe(localMidnight(NOW));
    expect(query.untilMs).toBeUndefined();
    expect(h.codes).toEqual([0]);
  });

  test("AC-2: --project koda --feature f1 --run r1 reach the query as filters", async () => {
    const h = harness();

    await runCost(h, ["--project", "koda", "--feature", "f1", "--run", "r1"]);

    const { query } = onlyCall(h);
    expect(query.projects).toEqual(["koda"]);
    expect(query.feature).toBe("f1");
    expect(query.runId).toBe("r1");
  });

  test("--by takes a comma list, in the order given", async () => {
    const h = harness();

    await runCost(h, ["--by", "project,feature"]);

    expect(onlyCall(h).query.groupBy).toEqual(["project", "feature"]);
  });

  test("--here and --project combine: one root, and the project still filters rows", async () => {
    const h = harness();

    await runCost(h, ["--here", "-d", "/work/koda", "--project", "koda"]);

    expect(onlyRoots(h)).toEqual([join(GLOBAL_DIR, "here")]);
    expect(onlyCall(h).query.projects).toEqual(["koda"]);
  });
});

// ─── scan roots ──────────────────────────────────────────────────────────────

describe("nax cost — scan roots", () => {
  test("AC-3: without --here the roots are the projects under the global config dir", async () => {
    const h = harness();

    await runCost(h, []);

    expect(h.globalDirs).toEqual([GLOBAL_DIR]);
    expect(onlyRoots(h)).toEqual([KODA_ROOT, NORTHWIND_ROOT]);
    expect(onlyCall(h).files).toEqual([LEDGER_FILE]);
  });

  test("AC-4: --here -d <dir> passes exactly one root — that project's output dir", async () => {
    const h = harness();

    await runCost(h, ["--here", "-d", "/work/koda"]);

    expect(h.hereDirs).toEqual(["/work/koda"]);
    expect(onlyRoots(h)).toEqual([join(GLOBAL_DIR, "here")]);
  });

  test("AC-5: --here -d <dir> never scans the global config dir for projects", async () => {
    const h = harness();

    await runCost(h, ["--here", "-d", "/work/koda"]);

    expect(h.globalDirs).toEqual([]);
  });
});

// ─── exit codes (the stderr half lives in the unit file) ─────────────────────

describe("nax cost — exit codes", () => {
  test("AC-12: --by colour writes Error: + the unknown key to stderr and exits 1", async () => {
    const h = harness();

    await runCost(h, ["--by", "colour"]);

    expect(h.err.join("\n")).toStartWith("Error:");
    expect(h.err.join("\n")).toContain("colour");
    expect(h.codes).toEqual([1]);
    expect(h.calls).toEqual([]);
  });

  test("AC-14: --today --since 2026-10-10 writes Error: to stderr and exits 1", async () => {
    const h = harness();

    await runCost(h, ["--today", "--since", "2026-10-10"]);

    expect(h.err.join("\n")).toStartWith("Error:");
    expect(h.codes).toEqual([1]);
    expect(h.out).toEqual([]);
  });

  test("AC-16: a rejecting queryCostLedger writes Error: + the message and exits 1", async () => {
    const h = harness({
      queryCostLedger: async () => {
        throw new Error("ENOENT: no such file or directory, open '/global/koda/cost/r1.jsonl'");
      },
    });

    await runCost(h, []);

    expect(h.err).toEqual(["Error: ENOENT: no such file or directory, open '/global/koda/cost/r1.jsonl'"]);
    expect(h.codes).toEqual([1]);
  });

  test("AC-18: no matching rows still exits 0, and exits exactly once", async () => {
    const h = harness();

    await runCost(h, []);

    expect(h.codes).toEqual([0]);
    expect(h.err).toEqual([]);
    expect(h.out.some((line) => line.startsWith("TOTAL"))).toBe(true);
  });

  test("a report with matching rows exits 0 exactly once", async () => {
    const h = harness(
      {},
      report({
        groups: [
          group(
            { stage: "run" },
            { calls: 3, runs: 2, input: 10, output: 5, cacheRead: 1, cacheWrite: 2, costUsd: 1.25, exactUsd: 1.25 },
          ),
        ],
        total: totals({ calls: 3, runs: 2, costUsd: 1.25, exactUsd: 1.25 }),
      }),
    );

    await runCost(h, ["--by", "stage"]);

    expect(h.codes).toEqual([0]);
    expect(h.out[0]).toStartWith("stage");
    expect(h.out[1]).toStartWith("run");
    expect(h.out[2]).toStartWith("TOTAL");
    expect(h.out).toContain("exact $1.25 / estimated $0.00");
  });
});

// ─── a failing seam, flag by flag ────────────────────────────────────────────

describe("nax cost — a failing read seam", () => {
  test("AC-20, AC-21: a rejecting listProjectOutputDirs writes Error: <message> and exits 1", async () => {
    const h = harness({
      listProjectOutputDirs: async () => {
        throw new Error("EACCES: permission denied, scandir '/global'");
      },
    });

    await runCost(h, []);

    expect(h.err).toEqual(["Error: EACCES: permission denied, scandir '/global'"]);
    expect(h.codes).toEqual([1]);
  });

  test("AC-22, AC-23: a rejecting listCostLedgerFiles writes Error: <message> and exits 1", async () => {
    const h = harness({
      listCostLedgerFiles: async () => {
        throw new Error("ENOTDIR: not a directory, scandir '/global/koda/cost'");
      },
    });

    await runCost(h, []);

    expect(h.err).toEqual(["Error: ENOTDIR: not a directory, scandir '/global/koda/cost'"]);
    expect(h.codes).toEqual([1]);
  });

  test("AC-24, AC-25: a rejecting resolveProjectOutputDir under --here writes Error: <message> and exits 1", async () => {
    const h = harness({
      resolveProjectOutputDir: async () => {
        throw new Error("CONFIG_INVALID: outputDir must be absolute or start with ~/");
      },
    });

    await runCost(h, ["--here", "-d", "/work/koda"]);

    expect(h.err).toEqual(["Error: CONFIG_INVALID: outputDir must be absolute or start with ~/"]);
    expect(h.codes).toEqual([1]);
  });
});

// ─── registration ────────────────────────────────────────────────────────────

describe("nax cost — registration", () => {
  test("registers a `cost` command carrying every documented flag", () => {
    const program = new Command();
    const command = registerCostCommand(program, harness().deps);

    expect(command.name()).toBe("cost");
    const longs = command.options.map((option) => option.long).filter((long) => long !== "--help");
    expect(longs).toEqual([
      "--today",
      "--since",
      "--until",
      "--utc",
      "--by",
      "--project",
      "--here",
      "--feature",
      "--run",
      "--json",
      "--dir",
    ]);
  });
});
