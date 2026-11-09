/**
 * `CostAggregator.drain()` under write failures and overlapping drains (US-004, M9).
 *
 * The drain is nax's only whole-file ledger write, so three properties hold it up:
 * a write that throws must leave every row retained, two overlapping drains must not
 * interleave their passes, and the default writer must never leave a half-written
 * `<runId>.jsonl` behind. Every gate here is a deferred write the test opens by hand —
 * no sleeps, so the interleavings are exact rather than likely.
 *
 * Split from `cost-aggregator.test.ts` (613 lines) by concern: that file keeps the
 * aggregation and serialisation cases.
 */
import { describe, expect, mock, test } from "bun:test";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { makeLogger, withDepsRestore, withTempDir } from "@test/helpers";
import { _costAggDeps, CostAggregator, type CostErrorEvent, type CostEvent } from "@/runtime/cost-aggregator";

function makeEvent(overrides: Partial<CostEvent> = {}): CostEvent {
  return {
    ts: 1,
    runId: "run-1",
    agentName: "claude",
    model: "claude-sonnet-4-6",
    tokens: { input: 100, output: 50 },
    estimatedCostUsd: 0.001,
    exactCostUsd: 0.001,
    costUsd: 0.001,
    confidence: "estimated",
    durationMs: 500,
    ...overrides,
  };
}

function makeErrorEvent(overrides: Partial<CostErrorEvent> = {}): CostErrorEvent {
  return {
    kind: "error",
    ts: 1,
    runId: "run-1",
    agentName: "claude",
    errorCode: "SESSION_ERROR",
    durationMs: 100,
    ...overrides,
  };
}

/** Every row of a JSONL payload, parsed. */
function parseRows(text: string): Array<Record<string, unknown>> {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("CostAggregator.drain() — retained state across failed drains", () => {
  withDepsRestore(_costAggDeps, ["write", "getSafeLogger"]);

  test("AC-1: a write failing on its second call leaves turn1, turn2 and turn3 in the last write", async () => {
    await withTempDir(async (dir) => {
      const writes: string[] = [];
      let calls = 0;
      _costAggDeps.write = async (_path, data) => {
        calls++;
        if (calls === 2) throw new Error("ENOSPC");
        writes.push(String(data));
        return 0;
      };
      const agg = new CostAggregator("run-1", join(dir, "cost"));

      agg.record(makeEvent({ ts: 1, turnId: "turn1" }));
      await agg.drain();

      agg.record(makeEvent({ ts: 2, turnId: "turn2" }));
      await expect(agg.drain()).rejects.toThrow("ENOSPC");

      agg.record(makeEvent({ ts: 3, turnId: "turn3" }));
      await agg.drain();

      const last = writes.at(-1) ?? "";
      expect(last).toContain("turn1");
      expect(last).toContain("turn2");
      expect(last).toContain("turn3");
    });
  });

  test("AC-2: after a drain whose write throws, snapshot() still counts every retained event", async () => {
    await withTempDir(async (dir) => {
      _costAggDeps.write = async () => {
        throw new Error("EACCES");
      };
      const agg = new CostAggregator("run-1", join(dir, "cost"));
      agg.record(makeEvent({ ts: 1, costUsd: 0.01 }));
      agg.record(makeEvent({ ts: 2, costUsd: 0.02 }));

      await expect(agg.drain()).rejects.toThrow("EACCES");

      const snap = agg.snapshot();
      expect(snap.callCount).toBe(2);
      expect(snap.totalCostUsd).toBeCloseTo(0.03);
    });
  });

  test("AC-3: an event recorded while a write is pending survives that write's failure", async () => {
    await withTempDir(async (dir) => {
      const gate = Promise.withResolvers<number>();
      const writes: string[] = [];
      let pending = true;
      _costAggDeps.write = (_path, data) => {
        if (pending) {
          pending = false;
          return gate.promise;
        }
        writes.push(String(data));
        return Promise.resolve(0);
      };
      const agg = new CostAggregator("run-1", join(dir, "cost"));
      agg.record(makeEvent({ ts: 1, turnId: "turn1" }));

      const failing = agg.drain();
      agg.record(makeEvent({ ts: 2, turnId: "turn2" }));
      gate.reject(new Error("ENOSPC"));
      await expect(failing).rejects.toThrow("ENOSPC");

      await agg.drain();

      const last = writes.at(-1) ?? "";
      expect(last).toContain("turn1");
      expect(last).toContain("turn2");
    });
  });

  test("AC-4: an error event recorded before a failing drain is rewritten as a kind error row", async () => {
    await withTempDir(async (dir) => {
      const writes: string[] = [];
      let calls = 0;
      _costAggDeps.write = async (_path, data) => {
        calls++;
        if (calls === 1) throw new Error("ENOSPC");
        writes.push(String(data));
        return 0;
      };
      const agg = new CostAggregator("run-1", join(dir, "cost"));
      agg.recordError(makeErrorEvent({ ts: 1, errorCode: "SESSION_ERROR" }));

      await expect(agg.drain()).rejects.toThrow("ENOSPC");
      await agg.drain();

      const rows = parseRows(writes.at(-1) ?? "");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe("error");
      expect(rows[0]?.errorCode).toBe("SESSION_ERROR");
    });
  });

  test("AC-11: the default write replaces the ledger through a temp sibling and leaves no other file", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "run-1.jsonl");
      await Bun.write(path, "stale\n");
      // A read-only ledger is the observable difference between the two writers:
      // an in-place write (Bun.write straight at `path`) fails with EACCES, while
      // a temp sibling plus rename replaces the directory entry and needs write
      // permission only on the directory.
      await chmod(path, 0o444);

      const written = await _costAggDeps.write(path, "fresh\n");

      expect(await Bun.file(path).text()).toBe("fresh\n");
      expect(written).toBe("fresh\n".length);
      // A crashed write may leave at most a temp sibling behind; a clean write
      // leaves exactly the ledger, so nothing else can be swept into `cost/*.jsonl`.
      expect([...new Bun.Glob("*").scanSync({ cwd: dir })]).toEqual(["run-1.jsonl"]);
    });
  });

  test("AC-11 (failure path): a rename that fails leaves the ledger path alone and removes the temp sibling", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "run-1.jsonl");
      // A directory where the ledger belongs is the one shape that lets the temp
      // write succeed and makes the rename over `path` fail, so the cleanup runs.
      await mkdir(path);

      await expect(_costAggDeps.write(path, "new\n")).rejects.toThrow();

      // `onlyFiles: false` because the surviving ledger path is the directory here.
      expect([...new Bun.Glob("*").scanSync({ cwd: dir, onlyFiles: false })]).toEqual(["run-1.jsonl"]);
      expect(await Bun.file(path).exists()).toBe(false);
    });
  });
});

describe("CostAggregator.drain() — write-pass loop", () => {
  withDepsRestore(_costAggDeps, ["write", "getSafeLogger"]);

  test("the pass bound stops a write loop that never runs out of late events, with a warning", async () => {
    await withTempDir(async (dir) => {
      const messages: string[] = [];
      const logger = makeLogger();
      logger.warn = mock((_stage: string, message: string) => {
        messages.push(message);
      }) as typeof logger.warn;
      _costAggDeps.getSafeLogger = mock(() => logger);

      const agg = new CostAggregator("run-1", join(dir, "cost"));
      let passes = 0;
      _costAggDeps.write = async () => {
        passes++;
        // Every pass produces a late event, so the loop can only stop at the bound.
        agg.record(makeEvent({ ts: 100 + passes }));
        return 0;
      };
      agg.record(makeEvent({ ts: 1 }));

      await agg.drain();

      expect(passes).toBe(20);
      expect(messages).toContain("drain exceeded max passes — late events keep arriving");
    });
  });
});

describe("CostAggregator.drain() — overlapping drains", () => {
  withDepsRestore(_costAggDeps, ["write", "getSafeLogger"]);

  test("AC-5: a second drain's first write starts only after the first drain's write resolved", async () => {
    await withTempDir(async (dir) => {
      const gate = Promise.withResolvers<number>();
      const firstSettledAtWriteStart: boolean[] = [];
      let firstSettled = false;
      let calls = 0;
      _costAggDeps.write = async () => {
        calls++;
        firstSettledAtWriteStart.push(firstSettled);
        if (calls === 1) {
          await gate.promise;
          firstSettled = true;
        }
        return 0;
      };
      const agg = new CostAggregator("run-1", join(dir, "cost"));
      agg.record(makeEvent({ ts: 1 }));

      const first = agg.drain();
      const second = agg.drain();
      await Promise.resolve();
      expect(calls).toBe(1);

      gate.resolve(0);
      await Promise.all([first, second]);

      expect(firstSettledAtWriteStart).toEqual([false, true]);
    });
  });

  test("AC-6: two overlapping drains end with the last write holding every recorded event", async () => {
    await withTempDir(async (dir) => {
      const writes: string[] = [];
      _costAggDeps.write = async (_path, data) => {
        writes.push(String(data));
        return 0;
      };
      const agg = new CostAggregator("run-1", join(dir, "cost"));
      agg.record(makeEvent({ ts: 1, turnId: "turn1" }));

      const first = agg.drain();
      agg.record(makeEvent({ ts: 2, turnId: "turn2" }));
      const second = agg.drain();
      await Promise.all([first, second]);

      const rows = parseRows(writes.at(-1) ?? "").map((row) => row.turnId);
      expect(rows).toEqual(["turn1", "turn2"]);
    });
  });

  test("AC-7: a drain queued behind a rejected drain still runs its write and resolves", async () => {
    await withTempDir(async (dir) => {
      const writes: string[] = [];
      let calls = 0;
      _costAggDeps.write = async (_path, data) => {
        calls++;
        if (calls === 1) throw new Error("ENOSPC");
        writes.push(String(data));
        return 0;
      };
      const agg = new CostAggregator("run-1", join(dir, "cost"));
      agg.record(makeEvent({ ts: 1, turnId: "turn1" }));

      const results = await Promise.allSettled([agg.drain(), agg.drain()]);

      expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled"]);
      expect(writes.at(-1) ?? "").toContain("turn1");
    });
  });

  test("AC-8: an event recorded while the first write is pending forces a second, complete write", async () => {
    await withTempDir(async (dir) => {
      const gate = Promise.withResolvers<number>();
      const writes: string[] = [];
      _costAggDeps.write = (_path, data) => {
        writes.push(String(data));
        return writes.length === 1 ? gate.promise : Promise.resolve(0);
      };
      const agg = new CostAggregator("run-1", join(dir, "cost"));
      agg.record(makeEvent({ ts: 1, turnId: "turn1" }));

      const task = agg.drain();
      agg.record(makeEvent({ ts: 2, turnId: "turn2" }));
      gate.resolve(0);
      await task;

      expect(writes).toHaveLength(2);
      expect(writes[0]).toContain("turn1");
      expect(writes[0]).not.toContain("turn2");
      expect(writes[1]).toContain("turn1");
      expect(writes[1]).toContain("turn2");
    });
  });

  test("AC-9: a snapshot taken mid-drain counts the rows being written and those recorded since", async () => {
    await withTempDir(async (dir) => {
      const gate = Promise.withResolvers<number>();
      _costAggDeps.write = async () => gate.promise;
      const agg = new CostAggregator("run-1", join(dir, "cost"));
      agg.record(makeEvent({ ts: 1, costUsd: 0.01 }));

      const task = agg.drain();
      agg.record(makeEvent({ ts: 2, costUsd: 0.02 }));

      const snap = agg.snapshot();
      expect(snap.callCount).toBe(2);
      expect(snap.totalCostUsd).toBeCloseTo(0.03);

      gate.resolve(0);
      await task;
    });
  });

  test("AC-10: an event a throwing later pass already took from the in-flight buffer is rewritten", async () => {
    await withTempDir(async (dir) => {
      const gate = Promise.withResolvers<number>();
      const writes: string[] = [];
      let calls = 0;
      _costAggDeps.write = async (_path, data) => {
        calls++;
        if (calls === 1) {
          await gate.promise;
          writes.push(String(data));
          return 0;
        }
        if (calls === 2) throw new Error("ENOSPC");
        writes.push(String(data));
        return 0;
      };
      const agg = new CostAggregator("run-1", join(dir, "cost"));
      agg.record(makeEvent({ ts: 1, turnId: "turn1" }));

      const failing = agg.drain();
      agg.record(makeEvent({ ts: 2, turnId: "turn2" }));
      gate.resolve(0);
      await expect(failing).rejects.toThrow("ENOSPC");

      await agg.drain();

      const rows = parseRows(writes.at(-1) ?? "").map((row) => row.turnId);
      expect(rows).toEqual(["turn1", "turn2"]);
    });
  });
});
