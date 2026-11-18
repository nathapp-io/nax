import { describe, expect, test } from "bun:test";
import { mkdir, stat, symlink, unlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { withDepsRestore, withTempDir } from "@test/helpers";
import {
  _handoffRecordDeps,
  type HandoffRecordFile,
  type HandoffRecordRead,
  isStorableRecordText,
  readHandoffRecordFiles,
} from "@/workflow/handoff-record";

withDepsRestore(_handoffRecordDeps);

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

/**
 * `mkfifo` is the only way to build the special file the reader must refuse, and it is what makes the
 * blocking open reproducer: where the tool is missing, that one case is skipped rather than faked.
 */
const mkfifo = Bun.which("mkfifo");
const fifoTest = mkfifo === null ? test.skip : test;

/** Create a FIFO at `path`, as the platform's own tool does. */
async function makeFifo(path: string): Promise<void> {
  const created = Bun.spawn([mkfifo ?? "mkfifo", path], { stdout: "ignore", stderr: "pipe" });
  expect(await created.exited).toBe(0);
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

  test.each(["tie", "reordered", "missing"])("refuses a listed result that becomes %s before open", async (change) => {
    await withTempDir(async (dir) => {
      await makeRun(dir, "r1", { result: resultJson("r1"), resultMtimeMs: 1000 });
      const newest = await makeRun(dir, "r2", { result: resultJson("r2"), resultMtimeMs: 2000 });
      const resultPath = join(newest, "result.json");
      const open = _handoffRecordDeps.open;
      _handoffRecordDeps.open = async (path, ...args) => {
        if (path === resultPath) {
          if (change === "missing") await unlink(resultPath);
          else {
            const time = change === "tie" ? 1 : 0.5;
            await utimes(resultPath, time, time);
          }
        }
        return open(path, ...args);
      };

      expect(expectRefusal(await readHandoffRecordFiles(dir))).toContain("result.json of run r2 changed");
    });
  });

  test.each(["tie", "reordered", "missing"])("refuses a result that becomes %s after its read", async (change) => {
    await withTempDir(async (dir) => {
      await makeRun(dir, "r1", { result: resultJson("r1"), resultMtimeMs: 1000 });
      const newest = await makeRun(dir, "r2", {
        result: resultJson("r2"),
        resultMtimeMs: 2000,
        ledger: ledgerMd("r2"),
      });
      const resultPath = join(newest, "result.json");
      const ledgerPath = join(newest, "ledger.md");
      const open = _handoffRecordDeps.open;
      _handoffRecordDeps.open = async (path, ...args) => {
        if (path === ledgerPath) {
          if (change === "missing") await unlink(resultPath);
          else {
            const time = change === "tie" ? 1 : 0.5;
            await utimes(resultPath, time, time);
          }
        }
        return open(path, ...args);
      };

      expect(expectRefusal(await readHandoffRecordFiles(dir))).toContain("workflow results changed during collection");
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

  test("a record read in chunks is the file's whole text, character for character", async () => {
    await withTempDir(async (dir) => {
      // 200 KiB spans four chunk reads, so a chunk boundary falls inside the text.
      const result = `${"a".repeat(200 * 1024 - 4)}\u{1F389}`;
      await makeRun(dir, "r1", { result, ledger: ledgerMd("r1") });

      const record = expectOk(await readHandoffRecordFiles(dir)).record;

      expect(record[0]?.content).toBe(result);
    });
  });

  test("a surrogate pair split across a chunk boundary is not read as an unpaired surrogate", async () => {
    await withTempDir(async (dir) => {
      // The emoji's four bytes straddle the 65536-byte chunk boundary: byte 65535 is its first byte.
      const result = `${"a".repeat(65535)}\u{1F389}${"b".repeat(10)}`;
      await makeRun(dir, "r1", { result });

      const record = expectOk(await readHandoffRecordFiles(dir)).record;

      expect(record[0]?.content).toBe(result);
    });
  });

  test("a malformed record is counted as the text it decodes to, not as the bytes on disk", async () => {
    await withTempDir(async (dir) => {
      const runDir = await makeRun(dir, "r1", {});
      // 175 000 bytes that are not UTF-8 decode to 175 000 replacement characters — 525 000 bytes sent,
      // which is past koda's cap even though the file itself is not.
      await Bun.write(join(runDir, "result.json"), Buffer.alloc(175_000, 0xff));

      expect(expectRefusal(await readHandoffRecordFiles(dir))).toBe(
        "the run record is 525000 bytes; koda accepts at most 524288",
      );
    });
  });

  test("a BOM is not counted against the cap, because the text sent has none", async () => {
    await withTempDir(async (dir) => {
      const runDir = await makeRun(dir, "r1", {});
      // Three bytes larger than the cap on disk, and exactly the cap once the BOM decodes away.
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      await Bun.write(join(runDir, "result.json"), Buffer.concat([bom, Buffer.alloc(524_288, 0x61)]));

      const record = expectOk(await readHandoffRecordFiles(dir)).record;

      expect(record[0]?.content.length).toBe(524_288);
      expect(record[0]?.content.startsWith("\uFEFF")).toBe(false);
    });
  });

  test("an oversized record is counted exactly without being buffered, and refused", async () => {
    await withTempDir(async (dir) => {
      // 8 MiB, far past the cap and far past one chunk: the count is still exact.
      const oversized = "a".repeat(8 * 1024 * 1024);
      await makeRun(dir, "r1", { result: oversized });

      expect(expectRefusal(await readHandoffRecordFiles(dir))).toBe(
        "the run record is 8388608 bytes; koda accepts at most 524288",
      );
    });
  });

  test("a NUL past the byte cap still wins, because the text rule is checked first", async () => {
    await withTempDir(async (dir) => {
      await makeRun(dir, "r1", { result: "a".repeat(600 * 1024), ledger: "line\n\u0000\n" });

      expect(expectRefusal(await readHandoffRecordFiles(dir))).toBe(
        "ledger.md of run r1 holds a NUL or unpaired surrogate character, which koda refuses",
      );
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

  test("a run whose result.json is a link is refused, not skipped", async () => {
    await withTempDir(async (dir) => {
      await makeRun(dir, "r1", { result: resultJson("r1"), resultMtimeMs: 1000 });
      const broken = join(dir, "r2");
      await mkdir(broken, { recursive: true });
      await symlink("result.json", join(broken, "result.json"));

      // The linked run must surface, not vanish: an accepted record for r1 alone would misreport the newest run.
      expect(expectRefusal(await readHandoffRecordFiles(dir))).toBe(
        "result.json of run r2 is a link or a special file, not a regular file the handoff can read",
      );
    });
  });

  test("a linked ledger.md is refused instead of uploading the text it points at", async () => {
    await withTempDir(async (dir) => {
      const outside = join(dir, "outside-secret.txt");
      await Bun.write(outside, "SECRET-FROM-OUTSIDE-THE-WORKFLOW-TREE\n");
      const runDir = await makeRun(dir, "r1", { result: resultJson("r1"), resultMtimeMs: 1000 });
      await symlink(outside, join(runDir, "ledger.md"));

      const read = await readHandoffRecordFiles(dir);

      expect(expectRefusal(read)).toBe(
        "ledger.md of run r1 is a link or a special file, not a regular file the handoff can read",
      );
      expect(JSON.stringify(read)).not.toContain("SECRET-FROM-OUTSIDE");
    });
  });

  test("a linked result.json inside a real run dir is refused the same way", async () => {
    await withTempDir(async (dir) => {
      const outside = join(dir, "outside-result.json");
      await Bun.write(outside, resultJson("r9"));
      const runDir = await makeRun(dir, "r1", { ledger: ledgerMd("r1") });
      await symlink(outside, join(runDir, "result.json"));

      expect(expectRefusal(await readHandoffRecordFiles(dir))).toBe(
        "result.json of run r1 is a link or a special file, not a regular file the handoff can read",
      );
    });
  });

  test("a run directory that is a link to another tree is refused", async () => {
    await withTempDir(async (dir) => {
      await makeRun(dir, "r1", { result: resultJson("r1"), resultMtimeMs: 1000 });
      const elsewhere = join(dir, "elsewhere");
      await makeRun(elsewhere, "r2", { result: resultJson("r2"), resultMtimeMs: 9000 });
      await symlink(join(elsewhere, "r2"), join(dir, "r2"));

      expect(expectRefusal(await readHandoffRecordFiles(dir))).toBe(
        "the workflow run r2 is a link, not a run directory of this feature; the handoff reads only the feature's own runs",
      );
    });
  });

  test("a workflow directory that is a link is refused instead of read through", async () => {
    await withTempDir(async (dir) => {
      const otherFeature = join(dir, "other-feature");
      await makeRun(otherFeature, "r1", { result: resultJson("r1"), ledger: ledgerMd("r1") });
      const workflow = join(dir, "workflow");
      await symlink(otherFeature, workflow);

      const read = await readHandoffRecordFiles(workflow);

      expect(expectRefusal(read)).toBe(
        `${workflow} is a link, not a directory of this feature; the handoff reads only the feature's own runs`,
      );
      expect(JSON.stringify(read)).not.toContain("Workflow ledger");
    });
  });

  test("a parent directory that is a link under the trusted root is refused", async () => {
    await withTempDir(async (dir) => {
      const real = join(dir, "real-feature");
      await makeRun(join(real, "workflow"), "r1", { result: resultJson("r1") });
      const linked = join(dir, "linked-feature");
      await symlink(real, linked);

      // The chain from the root the caller trusts is walked, so the linked feature directory is refused.
      const read = await readHandoffRecordFiles(join(linked, "workflow"), dir);

      expect(expectRefusal(read)).toBe(
        `${linked} is a link, not a directory of this feature; the handoff reads only the feature's own runs`,
      );
    });
  });

  fifoTest("a FIFO in place of ledger.md is refused instead of blocking the read", async () => {
    await withTempDir(async (dir) => {
      const runDir = await makeRun(dir, "r1", { result: resultJson("r1") });
      await makeFifo(join(runDir, "ledger.md"));

      // A blocking open never answers: the read is raced against a sleep, so the failure is this test's.
      const raced = await Promise.race([readHandoffRecordFiles(dir), Bun.sleep(3_000).then(() => "blocked" as const)]);

      expect(raced).not.toBe("blocked");
      if (raced === "blocked") return;
      expect(expectRefusal(raced)).toBe(
        "ledger.md of run r1 is a link or a special file, not a regular file the handoff can read",
      );
    });
  });

  test("a directory in place of a record file is refused, not read", async () => {
    await withTempDir(async (dir) => {
      const runDir = await makeRun(dir, "r1", { result: resultJson("r1") });
      await mkdir(join(runDir, "ledger.md"), { recursive: true });

      expect(expectRefusal(await readHandoffRecordFiles(dir))).toBe(
        "ledger.md of run r1 is a link or a special file, not a regular file the handoff can read",
      );
    });
  });

  test("a stray file under the workflow dir is not a run", async () => {
    await withTempDir(async (dir) => {
      await makeRun(dir, "r1", { result: resultJson("r1"), resultMtimeMs: 1000 });
      await Bun.write(join(dir, "notes.txt"), "not a run\n");

      const read = await readHandoffRecordFiles(dir);

      expect(expectOk(read).newestRunId).toBe("r1");
      expect(entryOrder(read)).toEqual(["r1/result.json"]);
    });
  });

  test("a path a link loop runs through surfaces instead of reading as no runs", async () => {
    await withTempDir(async (dir) => {
      // A self-referential symlink makes every path below it answer ELOOP, not ENOENT — deterministic as root.
      const loop = join(dir, "loop");
      await symlink("loop", loop);

      await expect(readHandoffRecordFiles(join(loop, "workflow"))).rejects.toThrow("ELOOP");
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
