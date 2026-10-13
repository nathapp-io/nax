import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assertDefined, cleanupTempDir, makeTempDir } from "@test/helpers";
import {
  activeKeepers,
  classifyRunStatePath,
  RunStateKeeper,
  registerKeeper,
  runStateWrite,
  unregisterKeeper,
} from "@/runstate/store";

let dir: string;
beforeEach(() => {
  dir = makeTempDir();
});
afterEach(() => {
  for (const k of activeKeepers()) unregisterKeeper(k);
  cleanupTempDir(dir);
});

/** A keeper whose base read fails, so a later keeper in the loop throws mid-computation. */
class ReadFailingKeeper extends RunStateKeeper {
  override get(): never {
    throw new Error("base read failed");
  }
}

async function featureFile(feature: string, name: string): Promise<string> {
  await mkdir(join(dir, ".nax/features", feature), { recursive: true });
  return join(dir, ".nax/features", feature, name);
}

describe("runStateWrite (#2497)", () => {
  test("no active keeper: just runs the write", async () => {
    const path = await featureFile("f", "prd.json");
    await runStateWrite(path, { content: "{}" }, () => Bun.write(path, "{}").then(() => undefined));
    expect(await Bun.file(path).text()).toBe("{}");
  });

  test("records the content before the write and clears the in-flight mark after", async () => {
    const k = new RunStateKeeper("r", "f");
    registerKeeper(k);
    const path = await featureFile("f", "prd.json");
    let seenDuringWrite: string | undefined;
    await runStateWrite(path, { content: '{"a":1}' }, async () => {
      seenDuringWrite = k.get(path)?.content;
      expect(k.isInFlight(path)).toBe(true);
      await Bun.write(path, '{"a":1}');
    });
    expect(seenDuringWrite).toBe('{"a":1}');
    expect(k.isInFlight(path)).toBe(false);
  });

  test("another feature's writes are not recorded (second run in the same repo)", async () => {
    const k = new RunStateKeeper("r", "f");
    registerKeeper(k);
    const other = await featureFile("g", "prd.json");
    await runStateWrite(other, { content: "{}" }, () => Bun.write(other, "{}").then(() => undefined));
    expect(k.files()).toEqual([]);
  });

  test("an append to an untracked existing file keeps the real base plus the chunk", async () => {
    const path = await featureFile("f", "decisions.jsonl");
    await Bun.write(path, '{"id":"D-1"}\n');
    const k = new RunStateKeeper("r", "f");
    registerKeeper(k);
    const chunk = '{"id":"D-2"}\n';
    await runStateWrite(path, { append: chunk }, () => appendFile(path, chunk));
    expect(k.get(path)?.content).toBe('{"id":"D-1"}\n{"id":"D-2"}\n');
    expect(k.get(path)?.content).toBe(await Bun.file(path).text());
  });

  test("a failing write still clears the in-flight mark and rethrows", async () => {
    const k = new RunStateKeeper("r", "f");
    registerKeeper(k);
    const path = await featureFile("f", "prd.json");
    await expect(
      runStateWrite(path, { content: "x" }, async () => {
        throw new Error("disk full");
      }),
    ).rejects.toThrow("disk full");
    expect(k.isInFlight(path)).toBe(false);
  });

  test("two appends fired without awaiting between them keep both chunks", async () => {
    const path = await featureFile("f", "decisions.jsonl");
    await Bun.write(path, '{"id":"D-1"}\n');
    const k = new RunStateKeeper("r", "f");
    registerKeeper(k);
    const first = '{"id":"D-2"}\n';
    const second = '{"id":"D-3"}\n';
    await Promise.all([
      runStateWrite(path, { append: first }, () => appendFile(path, first)),
      runStateWrite(path, { append: second }, () => appendFile(path, second)),
    ]);
    const onDisk = await Bun.file(path).text();
    expect(onDisk).toBe('{"id":"D-1"}\n{"id":"D-2"}\n{"id":"D-3"}\n');
    expect(k.get(path)?.content).toBe(onDisk);
  });

  test("a base read that throws rejects, and no keeper is left in flight", async () => {
    const path = await featureFile("f", "decisions.jsonl");
    const earlier = new RunStateKeeper("r1", "f");
    const later = new ReadFailingKeeper("r2", "f");
    const classified = classifyRunStatePath(path);
    assertDefined(classified, "path");
    earlier.record(path, classified, '{"id":"D-1"}\n');
    registerKeeper(earlier);
    registerKeeper(later);
    const write = mock(async () => {});
    await expect(runStateWrite(path, { append: "x" }, write)).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
    expect(earlier.isInFlight(path)).toBe(false);
    expect(later.isInFlight(path)).toBe(false);
  });
});
