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
});
