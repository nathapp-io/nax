import { describe, expect, test } from "bun:test";
import { mkdir, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import type { HandoffRecordFile, HandoffRecordRead } from "@/workflow/handoff-record";
import { isStorableRecordText, readHandoffRecordFiles } from "@/workflow/handoff-record";

const RESULT = '{"schemaVersion":1,"runId":"{run}","stories":{}}\n';
const LEDGER = "# Workflow ledger \u2014 run: {run}\n_run: done (all stories passed)\n";

function resultJson(runId: string): string {
  return RESULT.replace("{run}", runId);
}

function ledgerMd(runId: string): string {
  return LEDGER.replace("{run}", runId);
}

interface RunFixture {
  /** The result.json text, or absent for a directory the handoff must ignore. */
  readonly result?: string;
  readonly ledger?: string;
  /** Set the file's mtime, so ordering and ties are fixtures rather than wall-clock luck. */
  readonly resultMtimeMs?: number;
  readonly ledgerMtimeMs?: number;
}

async function writeFile(path: string, text: string, mtimeMs: number | undefined): Promise<void> {
  await Bun.write(path, text);
  if (mtimeMs !== undefined) await utimes(path, mtimeMs / 1000, mtimeMs / 1000);
}

async function makeRun(workflowDir: string, runId: string, fixture: RunFixture): Promise<string> {
  const runDir = join(workflowDir, runId);
  await mkdir(runDir, { recursive: true });
  if (fixture.result !== undefined) await writeFile(join(runDir, "result.json"), fixture.result, fixture.resultMtimeMs);
  if (fixture.ledger !== undefined) await writeFile(join(runDir, "ledger.md"), fixture.ledger, fixture.ledgerMtimeMs);
  return runDir;
}

function expectOk(read: HandoffRecordRead): {
  readonly record: readonly HandoffRecordFile[];
  readonly newestRunId: string;
} {
  if (!read.ok) throw new Error(`expected an accepted record, got the refusal: ${read.reason}`);
  return read;
}

function expectRefusal(read: HandoffRecordRead): string {
  if (read.ok) throw new Error("expected a refusal, got an accepted record");
  return read.reason;
}

/** `runId/file` per entry, in the order the handoff sends them. */
function entryOrder(read: HandoffRecordRead): string[] {
  return expectOk(read).record.map((entry) => `${entry.runId}/${entry.file}`);
}

describe("isStorableRecordText (US-002)", () => {
  test("refuses text holding a NUL character", () => {
    expect(isStorableRecordText("a\u0000b")).toBe(false);
  });

  test("refuses text holding a lone high surrogate", () => {
    expect(isStorableRecordText("a\uD800b")).toBe(false);
  });

  test("refuses text holding a lone low surrogate", () => {
    expect(isStorableRecordText("a\uDC00b")).toBe(false);
  });

  test("accepts text holding a valid surrogate pair", () => {
    expect(isStorableRecordText("a\u{1F389}b")).toBe(true);
  });

  test("accepts text holding multi-byte characters and newlines", () => {
    expect(isStorableRecordText("ledger line \u00e9\nsecond line \u2603\n")).toBe(true);
  });
});

describe("readHandoffRecordFiles (US-002)", () => {
  test("one run with a result.json and a ledger.md sends both, result.json first", async () => {
    await withTempDir(async (dir) => {
      await makeRun(dir, "r1", { result: resultJson("r1"), ledger: ledgerMd("r1") });

      const read = await readHandoffRecordFiles(dir);

      expect(read.ok).toBe(true);
      expect(expectOk(read).newestRunId).toBe("r1");
      expect(entryOrder(read)).toEqual(["r1/result.json", "r1/ledger.md"]);
    });
  });

  test("each entry's content is the file's UTF-8 text", async () => {
    await withTempDir(async (dir) => {
      const result = '{"schemaVersion":1,"note":"h\u00e9llo \u2603"}\n';
      const ledger = "# Workflow ledger \u2014 run: r1\nr1: done (all stories passed)\n";
      await makeRun(dir, "r1", { result, ledger });

      const record = expectOk(await readHandoffRecordFiles(dir)).record;

      expect(record.map((entry) => entry.content)).toEqual([result, ledger]);
    });
  });

  test("each entry's mtimeMs is the truncated stat mtime of its file", async () => {
    await withTempDir(async (dir) => {
      const runDir = await makeRun(dir, "r1", {
        result: resultJson("r1"),
        ledger: ledgerMd("r1"),
        resultMtimeMs: 5000.7,
        ledgerMtimeMs: 6000.25,
      });
      const resultStat = (await stat(join(runDir, "result.json"))).mtimeMs;
      const ledgerStat = (await stat(join(runDir, "ledger.md"))).mtimeMs;

      const record = expectOk(await readHandoffRecordFiles(dir)).record;

      expect(record.map((entry) => entry.mtimeMs)).toEqual([Math.trunc(resultStat), Math.trunc(ledgerStat)]);
      expect(record.map((entry) => entry.mtimeMs)).toEqual([5000, 6000]);
    });
  });

  test("the newer run's files come before the older run's", async () => {
    await withTempDir(async (dir) => {
      await makeRun(dir, "r1", { result: resultJson("r1"), ledger: ledgerMd("r1"), resultMtimeMs: 1000 });
      await makeRun(dir, "r2", { result: resultJson("r2"), ledger: ledgerMd("r2"), resultMtimeMs: 2000 });

      const read = await readHandoffRecordFiles(dir);

      expect(expectOk(read).newestRunId).toBe("r2");
      expect(entryOrder(read)).toEqual(["r2/result.json", "r2/ledger.md", "r1/result.json", "r1/ledger.md"]);
    });
  });

  test("a run without a ledger.md sends only its result.json", async () => {
    await withTempDir(async (dir) => {
      await makeRun(dir, "r1", { result: resultJson("r1") });

      const read = await readHandoffRecordFiles(dir);

      expect(entryOrder(read)).toEqual(["r1/result.json"]);
      expect(expectOk(read).record[0]?.content).toBe(resultJson("r1"));
    });
  });

  test("a run directory without a result.json is ignored and does not count as a run", async () => {
    await withTempDir(async (dir) => {
      for (let i = 1; i <= 20; i++) {
        await makeRun(dir, `r${i}`, { result: resultJson(`r${i}`), resultMtimeMs: i * 1000 });
      }
      await makeRun(dir, "unfinished", { ledger: ledgerMd("unfinished") });

      const read = await readHandoffRecordFiles(dir);

      expect(expectOk(read).record).toHaveLength(20);
      expect(entryOrder(read)).not.toContain("unfinished/ledger.md");
    });
  });

  test("a ledger.md holding a NUL character is refused, naming the file and run", async () => {
    await withTempDir(async (dir) => {
      await makeRun(dir, "r1", { result: resultJson("r1"), ledger: "r1: done\n\u0000\n" });

      expect(expectRefusal(await readHandoffRecordFiles(dir))).toBe(
        "ledger.md of run r1 holds a NUL or unpaired surrogate character, which koda refuses",
      );
    });
  });

  test("a result.json holding a NUL character is refused, naming result.json", async () => {
    await withTempDir(async (dir) => {
      await makeRun(dir, "r1", { result: '{"schemaVersion":1,"note":"a\u0000b"}' });

      expect(expectRefusal(await readHandoffRecordFiles(dir))).toBe(
        "result.json of run r1 holds a NUL or unpaired surrogate character, which koda refuses",
      );
    });
  });

  test("a record of 524289 UTF-8 bytes is refused, naming the byte count", async () => {
    await withTempDir(async (dir) => {
      // The cap is the sum over every content, so the overflow is split across the two files.
      await makeRun(dir, "r1", { result: "a".repeat(524288), ledger: "b" });

      expect(expectRefusal(await readHandoffRecordFiles(dir))).toBe(
        "the run record is 524289 bytes; koda accepts at most 524288",
      );
    });
  });

  test("a record of exactly 524288 UTF-8 bytes is accepted, counting a 2-byte character as 2", async () => {
    await withTempDir(async (dir) => {
      // "\u00e9" is 2 bytes in UTF-8, so 524286 ASCII bytes beside it total exactly the cap.
      const result = `\u00e9${"a".repeat(524286)}`;
      await makeRun(dir, "r1", { result });

      const record = expectOk(await readHandoffRecordFiles(dir)).record;

      expect(Buffer.byteLength(result, "utf8")).toBe(524288);
      expect(record.map((entry) => entry.content)).toEqual([result]);
    });
  });

  test("21 finished runs are refused, naming the count koda accepts", async () => {
    await withTempDir(async (dir) => {
      for (let i = 1; i <= 21; i++) {
        await makeRun(dir, `r${i}`, { result: resultJson(`r${i}`), resultMtimeMs: i * 1000 });
      }

      expect(expectRefusal(await readHandoffRecordFiles(dir))).toBe(
        "the feature has 21 workflow runs; koda accepts at most 20",
      );
    });
  });

  test("20 finished runs are accepted", async () => {
    await withTempDir(async (dir) => {
      for (let i = 1; i <= 20; i++) {
        await makeRun(dir, `r${i}`, { result: resultJson(`r${i}`), resultMtimeMs: i * 1000 });
      }

      const read = await readHandoffRecordFiles(dir);

      expect(expectOk(read).newestRunId).toBe("r20");
      expect(expectOk(read).record).toHaveLength(20);
    });
  });

  test("two runs whose result.json mtimes are equal and newest are refused as ambiguous", async () => {
    await withTempDir(async (dir) => {
      await makeRun(dir, "r1", { result: resultJson("r1"), resultMtimeMs: 5000 });
      await makeRun(dir, "r2", { result: resultJson("r2"), resultMtimeMs: 5000 });

      expect(expectRefusal(await readHandoffRecordFiles(dir))).toBe(
        "two workflow runs share the newest result.json time, so the newest run is ambiguous",
      );
    });
  });

  test("two runs whose newest mtimes truncate to the same integer are refused as ambiguous", async () => {
    await withTempDir(async (dir) => {
      await makeRun(dir, "r1", { result: resultJson("r1"), resultMtimeMs: 1000.2 });
      await makeRun(dir, "r2", { result: resultJson("r2"), resultMtimeMs: 1000.7 });

      // The premise: the integers koda compares are equal even though the float mtimes differ.
      const truncated = await Promise.all(
        ["r1", "r2"].map(async (runId) => Math.trunc((await stat(join(dir, runId, "result.json"))).mtimeMs)),
      );
      expect(truncated).toEqual([1000, 1000]);
      expect(expectRefusal(await readHandoffRecordFiles(dir))).toBe(
        "two workflow runs share the newest result.json time, so the newest run is ambiguous",
      );
    });
  });

  test("a tie below the newest run is not ambiguous, since koda compares the newest only", async () => {
    await withTempDir(async (dir) => {
      await makeRun(dir, "r1", { result: resultJson("r1"), resultMtimeMs: 1000 });
      await makeRun(dir, "r2", { result: resultJson("r2"), resultMtimeMs: 1000 });
      await makeRun(dir, "r3", { result: resultJson("r3"), resultMtimeMs: 3000 });

      const read = await readHandoffRecordFiles(dir);

      expect(expectOk(read).newestRunId).toBe("r3");
      expect(expectOk(read).record).toHaveLength(3);
    });
  });

  test("an empty workflow dir refuses, naming nax run", async () => {
    await withTempDir(async (dir) => {
      expect(expectRefusal(await readHandoffRecordFiles(dir))).toBe(
        "no finished workflow run for this feature; run nax run first",
      );
    });
  });

  test("a workflow dir that does not exist refuses, naming nax run", async () => {
    await withTempDir(async (dir) => {
      expect(expectRefusal(await readHandoffRecordFiles(join(dir, "absent")))).toBe(
        "no finished workflow run for this feature; run nax run first",
      );
    });
  });
});
