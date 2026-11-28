import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, withDepsRestore } from "@test/helpers";
import { _logTailDeps, LOG_TAIL_CHUNK_BYTES, readTailLines } from "@/chat/jobs/log-tail";

const MIB = 1024 * 1024;
const FILLER = "filler\n";

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = makeTempDir("nax-log-tail-");
  logPath = join(dir, "job.log");
});
afterEach(() => {
  cleanupTempDir(dir);
});

/** The ENOENT a file read raises when the log went away with its process. */
function enoent(): Error {
  return Object.assign(new Error("ENOENT: no such file or directory, open 'job.log'"), { code: "ENOENT" });
}

function tailLines(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `<tail line ${index + 1}>`);
}

/** A log of exactly `totalBytes` ASCII bytes whose final content is `tail`. */
function paddedLog(totalBytes: number, tail: string): string {
  const fillerBytes = totalBytes - tail.length;
  const line = `${"z".repeat(63)}\n`;
  const whole = Math.floor(fillerBytes / line.length);
  const rest = fillerBytes - whole * line.length;
  return `${line.repeat(whole)}${rest === 0 ? "" : `${"z".repeat(rest - 1)}\n`}${tail}`;
}

async function writeLog(content: string): Promise<void> {
  await Bun.write(logPath, content);
}

/** Counts the file bytes a tail read spends, and the chunk reads that spent them. */
function meterReads(): { bytes(): number; calls(): number } {
  const readRange = _logTailDeps.readRange;
  let bytes = 0;
  let calls = 0;
  _logTailDeps.readRange = async (path, start, end) => {
    const chunk = await readRange(path, start, end);
    bytes += chunk.byteLength;
    calls += 1;
    return chunk;
  };
  return { bytes: () => bytes, calls: () => calls };
}

describe("readTailLines", () => {
  withDepsRestore(_logTailDeps);

  test("AC-1 returns the 12 informative lines of a log that ends in 12 blank lines", async () => {
    const informative = tailLines(12);
    await writeLog(`${informative.join("\n")}\n${"\n".repeat(12)}`);
    expect(await readTailLines(logPath, 12, { nonEmpty: true })).toBe(informative.join("\n"));
  });

  test("AC-2 returns exactly the last 12 lines of a 16 MiB log", async () => {
    const tail = tailLines(12);
    await writeLog(paddedLog(16 * MIB, tail.join("\n")));
    expect(await readTailLines(logPath, 12)).toBe(tail.join("\n"));
  });

  test("AC-3 reads a 16 MiB log through at most two chunks", async () => {
    const tail = tailLines(12);
    await writeLog(paddedLog(16 * MIB, tail.join("\n")));
    const readRange = _logTailDeps.readRange;
    let bytes = 0;
    _logTailDeps.readRange = async (path, start, end) => {
      const chunk = await readRange(path, start, end);
      bytes += chunk.byteLength;
      return chunk;
    };
    expect(await readTailLines(logPath, 12)).toBe(tail.join("\n"));
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(2 * LOG_TAIL_CHUNK_BYTES);
  });

  test("AC-4 returns three lines intact when the chunk boundary falls inside the third from last", async () => {
    const thirdFromLast = "c".repeat(70_000);
    const tail = [thirdFromLast, "middle line", "last line"];
    await writeLog(`${FILLER.repeat(200)}${tail.join("\n")}`);
    const lineOffset = Bun.file(logPath).size - LOG_TAIL_CHUNK_BYTES - FILLER.repeat(200).length;
    expect(lineOffset).toBeGreaterThan(0);
    expect(lineOffset).toBeLessThan(thirdFromLast.length);
    expect(await readTailLines(logPath, 3)).toBe(tail.join("\n"));
  });

  test("AC-5 returns a line intact when the chunk boundary falls inside a multi-byte character", async () => {
    const filler = FILLER.repeat(200);
    const lastLine = `a${"é".repeat(40_000)}b`;
    await writeLog(`${filler}${lastLine}`);
    // The boundary lands two bytes into one é, so it splits the character's two-byte sequence.
    const accentOffset = Bun.file(logPath).size - LOG_TAIL_CHUNK_BYTES - filler.length - 1;
    expect(accentOffset).toBeGreaterThan(0);
    expect(accentOffset % 2).toBe(1);
    const result = await readTailLines(logPath, 1);
    expect(result).toBe(lastLine);
    expect(result).not.toContain("\uFFFD");
  });

  test("AC-6 reads a \\r\\n log as breaks and ignores one trailing break", async () => {
    await writeLog("a\r\nb\r\nc\r\n");
    expect(await readTailLines(logPath, 2)).toBe("b\nc");
  });

  test("AC-18 an ENOENT size is an empty tail", async () => {
    _logTailDeps.size = () => Promise.reject(enoent());
    expect(await readTailLines(logPath, 12)).toBe("");
  });

  test("AC-19 an ENOENT readRange after a nonzero size is an empty tail", async () => {
    await writeLog("a\nb\nc\n");
    _logTailDeps.readRange = () => Promise.reject(enoent());
    expect(await readTailLines(logPath, 12)).toBe("");
  });

  test("a size error that is not ENOENT propagates", async () => {
    const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    _logTailDeps.size = () => Promise.reject(denied);
    await expect(readTailLines(logPath, 12)).rejects.toBe(denied);
  });

  test("AC-20 a missing file sizes to zero and reads as an empty tail", async () => {
    expect(Bun.file(logPath).size).toBe(0);
    expect(await readTailLines(logPath, 12)).toBe("");
  });

  test("a non-finite or sub-one line count reads nothing", async () => {
    await writeLog("a\nb\n");
    expect(await readTailLines(logPath, Number.POSITIVE_INFINITY)).toBe("");
    expect(await readTailLines(logPath, 0)).toBe("");
    expect(await readTailLines(logPath, 0.5)).toBe("");
    expect(await readTailLines(logPath, 1.7)).toBe("b");
  });

  test("US-007 AC-1: a 256 KiB record costs one 64 KiB read and marks the omitted text", async () => {
    const record = "r".repeat(256 * 1024);
    await writeLog(record);
    const meter = meterReads();
    const tail = await readTailLines(logPath, 12, { nonEmpty: true, maxBytes: 64 * 1024 });
    // One read of the budget, not the five an unbounded scan of this record spends.
    expect(meter.calls()).toBe(1);
    expect(meter.bytes()).toBe(64 * 1024);
    const lines = tail.split("\n");
    expect(lines).toHaveLength(1);
    // The mark says text before the fragment is not shown, and the fragment is the record's end.
    expect(lines[0]?.startsWith("…")).toBe(true);
    expect(lines[0]?.slice(1)).toBe(record.slice(-64 * 1024));
  });

  test("US-007 AC-2: twelve nonblank lines inside the budget come back in order and unmarked", async () => {
    const tail = tailLines(12);
    const head = Array.from({ length: 200 }, (_, index) => `filler line ${index + 1}`).join("\n");
    await writeLog(`${head}\n${tail.join("\n")}\n`);
    const meter = meterReads();
    const read = await readTailLines(logPath, 12, { nonEmpty: true, maxBytes: 512 });
    expect(meter.bytes()).toBeLessThanOrEqual(512);
    expect(read).toBe(tail.join("\n"));
    expect(read.split("\n").every((line) => !line.startsWith("…"))).toBe(true);
  });

  test("US-007 AC-3: a budget cutting a multibyte character marks only that partial line", async () => {
    const cut = "é".repeat(1000);
    const complete = ["first complete line", "second complete line"];
    await writeLog(`${cut}\n${complete.join("\n")}\n`);
    // The 1023-byte tail starts on the second byte of a two-byte character.
    const lines = (await readTailLines(logPath, 4, { maxBytes: 1023 })).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^…é+$/);
    expect(lines[0]).not.toContain("\uFFFD");
    // The newer lines are whole, so only the cut fragment carries a mark.
    expect(lines.slice(1)).toEqual(complete);
  });

  test("US-007 AC-4: a character on a chunk boundary inside retained text stays intact", async () => {
    const accents = "é".repeat(33_000);
    // The record before the accents is one line, so the budget — not the line count — stops the scan.
    await writeLog(`${"x".repeat(200_000)}\n${accents}\nlast one\nlast two\n`);
    const meter = meterReads();
    const read = await readTailLines(logPath, 12, { maxBytes: 2 * LOG_TAIL_CHUNK_BYTES });
    expect(meter.bytes()).toBeLessThanOrEqual(2 * LOG_TAIL_CHUNK_BYTES);
    const lines = read.split("\n");
    // The boundary at the second chunk falls inside an é: the carry keeps it whole.
    expect(lines[1]).toBe(accents);
    expect(read).not.toContain("\uFFFD");
  });

  test("US-007 AC-5: a caller without a budget still gets its long complete line", async () => {
    const record = "c".repeat(256 * 1024);
    await writeLog(`${record}\nlast line\n`);
    const meter = meterReads();
    expect(await readTailLines(logPath, 2)).toBe(`${record}\nlast line`);
    // Reading the line's head back is what an unbudgeted caller asks for.
    expect(meter.calls()).toBeGreaterThan(1);
    expect(meter.bytes()).toBeGreaterThan(LOG_TAIL_CHUNK_BYTES);
  });

  test("an unbounded budget reads as no budget at all", async () => {
    const record = "c".repeat(256 * 1024);
    await writeLog(`${record}\nlast line\n`);
    expect(await readTailLines(logPath, 2, { maxBytes: Number.POSITIVE_INFINITY })).toBe(`${record}\nlast line`);
  });

  test("a cut fragment of nothing but whitespace is dropped when blank lines are skipped", async () => {
    await writeLog(" ".repeat(256 * 1024));
    expect(await readTailLines(logPath, 12, { nonEmpty: true, maxBytes: 64 * 1024 })).toBe("");
    // The same fragment is a line when the caller keeps blank lines.
    expect((await readTailLines(logPath, 12, { maxBytes: 64 * 1024 })).startsWith("… ")).toBe(true);
  });
});
