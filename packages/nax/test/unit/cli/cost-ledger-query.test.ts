/**
 * US-004 — cost ledger query core (`nax cost`).
 *
 * The 30 ACs of `docs/specs/SPEC-oct19-bundle.md` Part D. Discovery runs over a
 * real temp tree (`<outputDir>/cost/<runId>.jsonl`) so the error paths (`ENOENT`
 * → empty, everything else → rethrow) are exercised against the real filesystem
 * rather than a mocked one; `queryCostLedger` is driven through ledger files
 * written the same way `CostAggregator.drain()` writes them.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { assertNaxError, withTempDir } from "@test/helpers";
import { type CostQuery, listCostLedgerFiles, listProjectOutputDirs, queryCostLedger, resolveCostWindow } from "@/cli";
import { NaxError } from "@/errors";

// ─── fixtures ────────────────────────────────────────────────────────────────

/** 2026-10-10T12:00:00Z — inside every window the report tests open. */
const T0 = Date.UTC(2026, 9, 10, 12);

/** A ledger line: strings are written verbatim (malformed-line cases), objects as JSON. */
type LedgerLine = Record<string, unknown> | string;

/** A plausible `CostEvent` row; every test overrides only the fields it asserts on. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ts: T0, runId: "r1", agentName: "claude", model: "sonnet", costUsd: 1, confidence: "exact", ...over };
}

/** Write `<dir>/<project>/cost/<file>` — one JSON row per line, newline-terminated. */
async function writeLedger(dir: string, project: string, file: string, lines: readonly LedgerLine[]): Promise<string> {
  const path = join(dir, project, "cost", file);
  await mkdir(join(dir, project, "cost"), { recursive: true });
  const body = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
  await Bun.write(path, `${body}\n`);
  return path;
}

/** Run `fn` against a single ledger file built from `lines` (project `koda`, run `r1`). */
async function withLedgerFile(lines: readonly LedgerLine[], fn: (file: string) => Promise<void>): Promise<void> {
  await withTempDir(async (dir) => {
    await fn(await writeLedger(dir, "koda", "r1.jsonl", lines));
  });
}

/** Query defaults — no window, no filters, total only. */
function q(over: Partial<CostQuery> = {}): CostQuery {
  return { groupBy: [], ...over };
}

/** `err.code` without a cast — the fs error code is the observable these tests assert. */
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

// ─── listCostLedgerFiles / listProjectOutputDirs ─────────────────────────────

describe("listCostLedgerFiles", () => {
  test("AC-1 returns every <root>/cost/*.jsonl path, sorted, ignoring non-.jsonl files", async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, "koda");
      await writeLedger(dir, "koda", "b.jsonl", []);
      await writeLedger(dir, "koda", "a.jsonl", []);
      await Bun.write(join(root, "cost", "notes.txt"), "not a ledger\n");

      expect(await listCostLedgerFiles([root])).toEqual([join(root, "cost", "a.jsonl"), join(root, "cost", "b.jsonl")]);
    });
  });

  test("AC-2 returns [] for a root with no cost/ directory (existing root and absent root)", async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, "koda");
      await mkdir(root, { recursive: true });
      await Bun.write(join(root, "metrics.jsonl"), "{}\n");

      expect(await listCostLedgerFiles([root])).toEqual([]);
      expect(await listCostLedgerFiles([join(dir, "never-created")])).toEqual([]);
    });
  });

  test("AC-26 rethrows directory-read errors other than missing-directory errors", async () => {
    await withTempDir(async (dir) => {
      // `cost` is a regular file, so reading it as a directory is ENOTDIR — not
      // the ENOENT "nothing to read" case AC-2 turns into [].
      const root = join(dir, "koda");
      await Bun.write(join(root, "cost"), "not a directory\n");

      expect(codeOf(await rejectionOf(listCostLedgerFiles([root])))).toBe("ENOTDIR");
    });
  });
});

describe("listProjectOutputDirs", () => {
  test("AC-3 returns each child directory holding a cost/ dir and omits the rest", async () => {
    await withTempDir(async (dir) => {
      await writeLedger(dir, "koda", "r1.jsonl", []);
      await writeLedger(dir, "northwind", "r1.jsonl", []);
      await mkdir(join(dir, "nagoya"), { recursive: true }); // no cost/
      await Bun.write(join(dir, "loose.jsonl"), "{}\n"); // file child

      expect(await listProjectOutputDirs(dir)).toEqual([join(dir, "koda"), join(dir, "northwind")]);
    });
  });

  test("AC-3 resolves children through a symlink (stat-based, not lstat-based)", async () => {
    await withTempDir(async (dir) => {
      const outside = join(dir, "elsewhere");
      await writeLedger(outside, "koda", "r1.jsonl", []);
      await symlink(join(outside, "koda"), join(dir, "linked"));
      await mkdir(join(dir, "empty"), { recursive: true });

      expect(await listProjectOutputDirs(dir)).toEqual([join(dir, "linked")]);
    });
  });

  test("AC-27 returns [] when globalDir is missing", async () => {
    await withTempDir(async (dir) => {
      expect(await listProjectOutputDirs(join(dir, "no-such-config-dir"))).toEqual([]);
    });
  });

  test("AC-28 rethrows directory-read errors other than missing-directory errors", async () => {
    await withTempDir(async (dir) => {
      const notADir = join(dir, "config.json");
      await Bun.write(notADir, "{}\n");

      expect(codeOf(await rejectionOf(listProjectOutputDirs(notADir)))).toBe("ENOTDIR");
    });
  });
});

// ─── queryCostLedger ─────────────────────────────────────────────────────────

describe("queryCostLedger", () => {
  test("AC-4 sums tokens.input, tokens.output, tokens.cacheRead and tokens.cacheWrite", async () => {
    await withLedgerFile(
      [
        row({ tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 7 } }),
        row({ ts: T0 + 1, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }),
      ],
      async (file) => {
        const { total } = await queryCostLedger([file], q());
        expect([total.input, total.output, total.cacheRead, total.cacheWrite]).toEqual([101, 22, 8, 11]);
      },
    );
  });

  test("AC-5 reports total.calls as the number of counted rows", async () => {
    await withLedgerFile([row(), row({ ts: T0 + 1 }), row({ ts: T0 + 2 })], async (file) => {
      const report = await queryCostLedger([file], q());
      expect(report.total.calls).toBe(3);
      expect(report.filesScanned).toBe(1);
      expect(report.schemaVersion).toBe(1);
      expect(report.groups).toEqual([]);
    });
  });

  test("AC-6 reports total.runs as the number of distinct runId values", async () => {
    await withLedgerFile([row({ runId: "r1" }), row({ runId: "r2" }), row({ runId: "r1" })], async (file) => {
      expect((await queryCostLedger([file], q())).total.runs).toBe(2);
    });
  });

  test("AC-7 adds a non-error row's costUsd to exactUsd on confidence exact, else to estimatedUsd", async () => {
    await withLedgerFile(
      [
        row({ costUsd: 1.5, confidence: "exact" }),
        row({ costUsd: 0.25, confidence: "exact" }),
        row({ costUsd: 2.25, confidence: "estimated" }),
      ],
      async (file) => {
        const { total } = await queryCostLedger([file], q());
        expect(total.exactUsd).toBe(1.75);
        expect(total.estimatedUsd).toBe(2.25);
      },
    );
  });

  test("AC-8 reports costUsd equal to exactUsd + estimatedUsd (error rows included)", async () => {
    await withLedgerFile(
      [
        row({ costUsd: 1.1, confidence: "exact" }),
        row({ costUsd: 2.2, confidence: "estimated" }),
        row({ kind: "error", confidence: undefined, costUsd: 0.3, exactCostUsd: 0.3 }),
      ],
      async (file) => {
        const { total } = await queryCostLedger([file], q());
        expect(total.costUsd).toBe(total.exactUsd + total.estimatedUsd);
        expect(total.costUsd).toBeCloseTo(3.6, 10);
      },
    );
  });

  test("AC-9 excludes a row whose ts equals untilMs", async () => {
    const untilMs = T0 + 1_000;
    await withLedgerFile([row({ ts: untilMs, costUsd: 5 }), row({ ts: untilMs - 1, costUsd: 1 })], async (file) => {
      const { total } = await queryCostLedger([file], q({ untilMs }));
      expect(total.calls).toBe(1);
      expect(total.costUsd).toBe(1);
    });
  });

  test("AC-10 includes a row whose ts equals sinceMs", async () => {
    const sinceMs = T0 + 1_000;
    await withLedgerFile([row({ ts: sinceMs, costUsd: 1 }), row({ ts: sinceMs - 1, costUsd: 5 })], async (file) => {
      const { total } = await queryCostLedger([file], q({ sinceMs }));
      expect(total.calls).toBe(1);
      expect(total.costUsd).toBe(1);
    });
  });

  test("AC-25 rejects with the read error when a listed ledger file vanishes", async () => {
    await withTempDir(async (dir) => {
      await writeLedger(dir, "koda", "r1.jsonl", [row()]);
      const listed = await listCostLedgerFiles([join(dir, "koda")]);
      expect(listed).toHaveLength(1);
      await rm(listed[0]);

      // The failure is a read error, not a skipped row: aggregating past a
      // vanished file would silently under-report spend.
      expect(codeOf(await rejectionOf(queryCostLedger(listed, q())))).toBe("ENOENT");
    });
  });

  test("AC-25 rejects rather than skipping when a listed ledger file cannot be read", async () => {
    await withTempDir(async (dir) => {
      await writeLedger(dir, "koda", "r1.jsonl", [row()]);

      await expect(queryCostLedger([join(dir, "koda", "cost")], q())).rejects.toThrow();
    });
  });

  test("AC-11 counts an invalid-JSON line and rows with a non-numeric ts or costUsd in skippedRows", async () => {
    await withLedgerFile(
      [row(), "{ not json", row({ ts: "yesterday" }), row({ costUsd: "1.50" }), "42"],
      async (file) => {
        const report = await queryCostLedger([file], q());
        expect(report.skippedRows).toBe(4);
        expect(report.total.calls).toBe(1);
      },
    );
  });

  test("AC-12 ignores blank lines without counting them in skippedRows", async () => {
    await withLedgerFile([row(), "", "   ", "\t", row({ ts: T0 + 1 })], async (file) => {
      const report = await queryCostLedger([file], q());
      expect(report.skippedRows).toBe(0);
      expect(report.total.calls).toBe(2);
    });
  });

  test("AC-13 groups by stage, one row per distinct stage, sorted by costUsd descending", async () => {
    await withLedgerFile(
      [
        row({ stage: "review", costUsd: 2 }),
        row({ stage: "run", costUsd: 9 }),
        row({ stage: "run", costUsd: 1 }),
        row({ stage: "plan", costUsd: 5 }),
      ],
      async (file) => {
        const { groups } = await queryCostLedger([file], q({ groupBy: ["stage"] }));
        expect(groups.map((g) => [g.key.stage, g.costUsd, g.calls])).toEqual([
          ["run", 10, 2],
          ["plan", 5, 1],
          ["review", 2, 1],
        ]);
      },
    );
  });

  test("AC-14 keys each group by project (projectKey) and feature (featureName), in groupBy order", async () => {
    await withTempDir(async (dir) => {
      const files = [
        await writeLedger(dir, "koda", "r1.jsonl", [row({ projectKey: "koda", featureName: "f1", costUsd: 3 })]),
        await writeLedger(dir, "koda", "r2.jsonl", [
          row({ projectKey: "koda", featureName: "f2", runId: "r2", costUsd: 1 }),
        ]),
        await writeLedger(dir, "northwind", "r1.jsonl", [
          row({ projectKey: "northwind", featureName: "f1", costUsd: 5 }),
        ]),
      ];

      const { groups } = await queryCostLedger(files, q({ groupBy: ["project", "feature"] }));
      expect(Object.keys(groups[0].key)).toEqual(["project", "feature"]);
      expect(groups.map((g) => [g.key.project, g.key.feature, g.costUsd])).toEqual([
        ["northwind", "f1", 5],
        ["koda", "f1", 3],
        ["koda", "f2", 1],
      ]);
    });
  });

  test("AC-15 keys groups by sessionRole, using (none) when the row has none", async () => {
    await withLedgerFile(
      [
        row({ sessionRole: "implementer", costUsd: 2 }),
        row({ sessionRole: "implementer", costUsd: 2 }),
        row({ sessionRole: "verifier", costUsd: 1 }),
        row({ costUsd: 0.5 }),
      ],
      async (file) => {
        const { groups } = await queryCostLedger([file], q({ groupBy: ["role"] }));
        expect(groups.map((g) => [g.key.role, g.costUsd])).toEqual([
          ["implementer", 4],
          ["verifier", 1],
          ["(none)", 0.5],
        ]);
      },
    );
  });

  test("AC-16 counts only rows matching the projects, feature or runId filter", async () => {
    await withTempDir(async (dir) => {
      const files = [
        await writeLedger(dir, "koda", "r1.jsonl", [
          row({ projectKey: "koda", featureName: "f1", runId: "r1", costUsd: 1 }),
        ]),
        await writeLedger(dir, "northwind", "r2.jsonl", [
          row({ projectKey: "northwind", featureName: "f2", runId: "r2", costUsd: 4 }),
        ]),
      ];

      expect((await queryCostLedger(files, q({ projects: ["koda"] }))).total.costUsd).toBe(1);
      expect((await queryCostLedger(files, q({ feature: "f2" }))).total.costUsd).toBe(4);
      expect((await queryCostLedger(files, q({ runId: "r2" }))).total.costUsd).toBe(4);
      expect((await queryCostLedger(files, q({ feature: "f1", runId: "r2" }))).total.calls).toBe(0);
    });
  });

  test("AC-17 counts a row with no tokens field as 0 tokens while still adding its costUsd", async () => {
    await withLedgerFile(
      [row({ costUsd: 2 }), row({ ts: T0 + 1, costUsd: 0.5, tokens: { input: 5, output: 5 } })],
      async (file) => {
        const { total } = await queryCostLedger([file], q());
        expect([total.input, total.output, total.cacheRead, total.cacheWrite]).toEqual([5, 5, 0, 0]);
        expect(total.costUsd).toBe(2.5);
      },
    );
  });

  test("AC-18 counts an error row with no costUsd as a call worth 0 dollars, not as skipped", async () => {
    await withLedgerFile(
      [row({ kind: "error", costUsd: undefined, exactCostUsd: undefined, errorCode: "AGENT_CRASH" })],
      async (file) => {
        const report = await queryCostLedger([file], q());
        expect(report.skippedRows).toBe(0);
        expect(report.total.calls).toBe(1);
        expect(report.total.errorCalls).toBe(1);
        expect(report.total.costUsd).toBe(0);
      },
    );
  });

  test("AC-19 classifies an error row by exactCostUsd but sums costUsd", async () => {
    await withLedgerFile(
      [
        // confidence-less error row, finite exactCostUsd → exact, but the dollars are costUsd (0.75, not 0.9).
        row({ kind: "error", confidence: undefined, costUsd: 0.75, exactCostUsd: 0.9, errorCode: "E1" }),
        // no exactCostUsd → estimated.
        row({ kind: "error", confidence: undefined, costUsd: 0.25, errorCode: "E2" }),
      ],
      async (file) => {
        const { total } = await queryCostLedger([file], q());
        expect(total.exactUsd).toBe(0.75);
        expect(total.estimatedUsd).toBe(0.25);
        expect(total.costUsd).toBe(1);
        expect(total.errorCalls).toBe(2);
      },
    );
  });

  test("AC-20 attributes a row with no projectKey to its output dir basename", async () => {
    await withTempDir(async (dir) => {
      const file = await writeLedger(dir, "koda", "r1.jsonl", [
        row({ projectKey: undefined, featureName: "f1", costUsd: 3 }),
      ]);

      expect((await queryCostLedger([file], q({ projects: ["koda"] }))).total.costUsd).toBe(3);
      expect((await queryCostLedger([file], q({ projects: ["northwind"] }))).total.calls).toBe(0);

      const { groups } = await queryCostLedger([file], q({ groupBy: ["project"] }));
      expect(groups.map((g) => [g.key.project, g.costUsd])).toEqual([["koda", 3]]);
    });
  });

  test("counts a still-unrecorded partial row like any other row", async () => {
    await withLedgerFile([row({ partial: true, costUsd: 1.25 })], async (file) => {
      const { total } = await queryCostLedger([file], q());
      expect(total.calls).toBe(1);
      expect(total.costUsd).toBe(1.25);
    });
  });

  test("yields an empty report when until is earlier than since", async () => {
    await withLedgerFile([row()], async (file) => {
      const report = await queryCostLedger([file], q({ sinceMs: T0 + 1_000, untilMs: T0 }));
      expect(report.total).toEqual({
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
      });
      expect(report.skippedRows).toBe(0);
      expect(report.sinceMs).toBe(T0 + 1_000);
      expect(report.untilMs).toBe(T0);
    });
  });
});

// ─── resolveCostWindow ───────────────────────────────────────────────────────

describe("resolveCostWindow", () => {
  /** Capture a throw from a synchronous call, failing the test if nothing throws. */
  function thrownBy(fn: () => unknown): unknown {
    try {
      fn();
    } catch (err) {
      return err;
    }
    throw new Error("expected the call to throw");
  }

  test("AC-21 returns local midnight of nowMs's day for today, with no untilMs", () => {
    const nowMs = new Date(2026, 9, 10, 15, 30, 45).getTime();

    const window = resolveCostWindow({ today: true, nowMs });

    expect(window.sinceMs).toBe(new Date(2026, 9, 10, 0, 0, 0, 0).getTime());
    expect(window.untilMs).toBeUndefined();
    expect(Object.hasOwn(window, "untilMs")).toBe(false);
  });

  test("AC-21 reads the day in UTC when utc is set", () => {
    const nowMs = new Date(2026, 9, 10, 15, 30).getTime();

    expect(resolveCostWindow({ today: true, utc: true, nowMs }).sinceMs).toBe(Date.UTC(2026, 9, 10));
  });

  test("AC-22 maps since to that day's start and until to the day after, in UTC", () => {
    const window = resolveCostWindow({ since: "2026-10-10", until: "2026-10-17", utc: true, nowMs: 0 });

    expect(window.sinceMs).toBe(Date.UTC(2026, 9, 10));
    expect(window.untilMs).toBe(Date.UTC(2026, 9, 18));
  });

  test("AC-22 maps since and until to local midnight when utc is not set", () => {
    const window = resolveCostWindow({ since: "2026-10-10", until: "2026-10-17", nowMs: 0 });

    expect(window.sinceMs).toBe(new Date(2026, 9, 10).getTime());
    expect(window.untilMs).toBe(new Date(2026, 9, 18).getTime());
  });

  test("AC-23 throws COST_USAGE when today is combined with since", () => {
    const err = thrownBy(() => resolveCostWindow({ today: true, since: "2026-10-10", nowMs: T0 }));

    assertNaxError(err, "resolveCostWindow today+since");
    expect(err.code).toBe("COST_USAGE");
  });

  test("AC-29 throws COST_USAGE with context { stage: 'cost' } when today is combined with until", () => {
    const err = thrownBy(() => resolveCostWindow({ today: true, until: "2026-10-10", nowMs: T0 }));

    assertNaxError(err, "resolveCostWindow today+until");
    expect(err).toBeInstanceOf(NaxError);
    expect(err.code).toBe("COST_USAGE");
    expect(err.context).toEqual({ stage: "cost" });
  });

  test("AC-24 throws COST_USAGE for a date that is not a real calendar date", () => {
    const err = thrownBy(() => resolveCostWindow({ since: "2026-13-40", nowMs: T0 }));

    assertNaxError(err, "resolveCostWindow 2026-13-40");
    expect(err.code).toBe("COST_USAGE");
  });

  test.each(["2026-10", "10/10/2026", "2026-1-1", "2026-02-30", "yesterday", ""])(
    "AC-30 throws COST_USAGE with context { stage: 'cost' } for %p",
    (value) => {
      const err = thrownBy(() => resolveCostWindow({ since: value, nowMs: T0 }));

      assertNaxError(err, `resolveCostWindow since=${value}`);
      expect(err.code).toBe("COST_USAGE");
      expect(err.context).toEqual({ stage: "cost" });
    },
  );

  test("AC-30 throws COST_USAGE with context { stage: 'cost' } for an invalid until", () => {
    const err = thrownBy(() => resolveCostWindow({ until: "2026-02-30", nowMs: T0 }));

    assertNaxError(err, "resolveCostWindow until=2026-02-30");
    expect(err.code).toBe("COST_USAGE");
    expect(err.context).toEqual({ stage: "cost" });
  });

  test("returns no bounds when no flag is set", () => {
    expect(resolveCostWindow({ nowMs: T0 })).toEqual({});
  });

  test("accepts a leap day and rolls until across a month boundary", () => {
    const window = resolveCostWindow({ since: "2028-02-29", until: "2028-02-29", utc: true, nowMs: T0 });

    expect(window.sinceMs).toBe(Date.UTC(2028, 1, 29));
    expect(window.untilMs).toBe(Date.UTC(2028, 2, 1));
  });
});
