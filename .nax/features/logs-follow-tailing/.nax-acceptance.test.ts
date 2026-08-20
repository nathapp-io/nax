import { describe, expect, mock, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _deps, logsCommand } from "../../../src/commands/logs";
import { followLogs } from "../../../src/commands/logs-formatter";
import { withTempDir } from "../../../test/helpers/temp";

type FollowOptions = { json?: boolean; story?: string; level?: "silent" | "error" | "warn" | "info" | "debug" };
type FollowDeps = {
  emit: (line: string) => void;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readRange: (filePath: string, start: number) => Promise<string>;
};
type Follow = (
  filePath: string,
  options: FollowOptions,
  opts?: { signal?: AbortSignal; _deps?: Partial<FollowDeps> },
) => Promise<"cancelled">;

const follow = followLogs as unknown as Follow;
const encoder = new TextEncoder();

function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function jsonLine(entry: Record<string, unknown>): string {
  return `${JSON.stringify(entry)}\n`;
}

function writeFixture(dir: string, content: string): string {
  const filePath = join(dir, "run.jsonl");
  writeFileSync(filePath, content);
  return filePath;
}

function rangeReader(filePath: string, start: number): Promise<string> {
  return Bun.file(filePath).slice(start).text();
}

function rejectingSleep(): Promise<never> {
  return Promise.reject(new Error("poll cancelled"));
}

describe("logs-follow-tailing acceptance", () => {
  test("AC-1: returns cancelled without emitting when the signal is already aborted", async () => {
    await withTempDir(async (dir) => {
      const filePath = writeFixture(dir, jsonLine({ message: "ASCII seed" }));
      const controller = new AbortController();
      const emit = mock((_line: string) => {});
      controller.abort();

      await expect(follow(filePath, { json: true }, { signal: controller.signal, _deps: { emit } })).resolves.toBe(
        "cancelled",
      );
      expect(emit).toHaveBeenCalledTimes(0);
    });
  });

  test("AC-2: converts a rejected first sleep into cancelled", async () => {
    await withTempDir(async (dir) => {
      const filePath = writeFixture(dir, jsonLine({ message: "ASCII seed" }));

      await expect(follow(filePath, { json: true }, { _deps: { sleep: rejectingSleep } })).resolves.toBe("cancelled");
    });
  });

  test("AC-3: emits two existing ASCII entries in file order before cancellation", async () => {
    await withTempDir(async (dir) => {
      const first = jsonLine({ message: "first" });
      const second = jsonLine({ message: "second" });
      const emitted: string[] = [];
      const emit = mock((line: string) => emitted.push(line));
      const filePath = writeFixture(dir, first + second);

      await expect(follow(filePath, { json: true }, { _deps: { emit, sleep: rejectingSleep } })).resolves.toBe(
        "cancelled",
      );
      expect(emit).toHaveBeenCalledTimes(2);
      expect(emitted.map((line) => JSON.parse(line).message)).toEqual(["first", "second"]);
    });
  });

  test("AC-4: applies the story filter through the injected emitter", async () => {
    await withTempDir(async (dir) => {
      const emitted: string[] = [];
      const emit = mock((line: string) => emitted.push(line));
      const filePath = writeFixture(
        dir,
        jsonLine({ storyId: "US-001", message: "wanted" }) + jsonLine({ storyId: "US-002", message: "unwanted" }),
      );

      await expect(
        follow(filePath, { json: true, story: "US-001" }, { _deps: { emit, sleep: rejectingSleep } }),
      ).resolves.toBe("cancelled");
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emitted[0]).toContain("storyId");
      expect(emitted[0]).not.toContain("US-002");
    });
  });

  test("AC-5: returns cancelled with default dependencies when the signal is already aborted", async () => {
    await withTempDir(async (dir) => {
      const filePath = writeFixture(dir, jsonLine({ message: "ASCII seed" }));
      const controller = new AbortController();
      const originalLog = console.log;
      const emit = mock((_line: unknown) => {});
      controller.abort();
      console.log = emit;

      try {
        await expect(follow(filePath, { json: true }, { signal: controller.signal })).resolves.toBe("cancelled");
        expect(emit).toHaveBeenCalledTimes(0);
      } finally {
        console.log = originalLog;
      }
    });
  });

  test("AC-6: logsCommand resolves undefined for an already-aborted follow run", async () => {
    await withTempDir(async (dir) => {
      const runId = "acceptance-run";
      const runsDir = join(dir, "events");
      const registryDir = join(dir, "registry");
      const originalGetRunsDir = _deps.getRunsDir;
      mkdirSync(runsDir, { recursive: true });
      mkdirSync(join(registryDir, "entry"), { recursive: true });
      writeFileSync(join(runsDir, `${runId}.jsonl`), jsonLine({ message: "ASCII seed" }));
      writeFileSync(join(registryDir, "entry", "meta.json"), JSON.stringify({ runId, eventsDir: runsDir }));
      _deps.getRunsDir = () => registryDir;
      const controller = new AbortController();
      controller.abort();

      try {
        await expect(logsCommand({ follow: true, run: runId, signal: controller.signal })).resolves.toBeUndefined();
      } finally {
        _deps.getRunsDir = originalGetRunsDir;
      }
    });
  });

  test("AC-7: reads a Unicode append from the byte offset without corrupting it", async () => {
    await withTempDir(async (dir) => {
      const seed = jsonLine({ message: "α ✓ β ✓ γ ✓ δ" });
      const appended = jsonLine({ message: "appended" });
      const emitted: string[] = [];
      const emit = mock((line: string) => emitted.push(line));
      const readRange = mock(rangeReader);
      const filePath = writeFixture(dir, seed);
      let initialCallCount = 0;
      let polls = 0;
      const sleep = mock(async () => {
        polls += 1;
        if (polls === 1) {
          initialCallCount = emit.mock.calls.length;
          appendFileSync(filePath, appended);
          return;
        }
        return rejectingSleep();
      });

      await expect(follow(filePath, { json: true }, { _deps: { emit, readRange, sleep } })).resolves.toBe("cancelled");
      expect(emit.mock.calls.length - initialCallCount).toBe(1);
      expect(JSON.parse(emitted.at(-1) ?? "")).toEqual({ message: "appended" });
      expect(seed).toContain("✓ ✓ ✓");
      expect(readRange.mock.calls.some(([, start]) => start === bytes(seed))).toBe(true);
    });
  });

  test("AC-8: emits three Unicode appends in their append order", async () => {
    await withTempDir(async (dir) => {
      const filePath = writeFixture(dir, jsonLine({ message: "seed" }));
      const appended = [jsonLine({ message: "1 ✓" }), jsonLine({ message: "2 ✓" }), jsonLine({ message: "3 ✓" })];
      const emitted: string[] = [];
      const emit = mock((line: string) => emitted.push(line));
      let baseline = 0;
      let polls = 0;
      const sleep = async () => {
        if (polls === 0) baseline = emit.mock.calls.length;
        if (polls < appended.length) {
          appendFileSync(filePath, appended[polls]);
          polls += 1;
          return;
        }
        return rejectingSleep();
      };

      await expect(follow(filePath, { json: true }, { _deps: { emit, readRange, sleep } })).resolves.toBe("cancelled");
      expect(emit.mock.calls.length - baseline).toBe(3);
      expect(emitted.slice(baseline).map((line) => JSON.parse(line).message)).toEqual(["1 ✓", "2 ✓", "3 ✓"]);
    });
  });

  test("AC-9: emits initial and appended entries exactly once", async () => {
    await withTempDir(async (dir) => {
      const initial = [1, 2, 3].map((n) => jsonLine({ n })).join("");
      const filePath = writeFixture(dir, initial);
      const emitted: string[] = [];
      const emit = mock((line: string) => emitted.push(line));
      const appends = [jsonLine({ n: 4 }), jsonLine({ n: 5 })];
      let polls = 0;
      const sleep = async () => {
        if (polls < appends.length) {
          appendFileSync(filePath, appends[polls]);
          polls += 1;
          return;
        }
        return rejectingSleep();
      };

      await expect(follow(filePath, { json: true }, { _deps: { emit, readRange, sleep } })).resolves.toBe("cancelled");
      expect(emit).toHaveBeenCalledTimes(5);
      expect(emitted.map((line) => JSON.parse(line).n)).toEqual([1, 2, 3, 4, 5]);
    });
  });

  test("AC-10: skips an invalid line and continues to a later Unicode entry", async () => {
    await withTempDir(async (dir) => {
      const filePath = writeFixture(dir, jsonLine({ message: "before ✓" }));
      const emitted: string[] = [];
      const emit = mock((line: string) => emitted.push(line));
      let polls = 0;
      const sleep = async () => {
        if (polls === 0) {
          appendFileSync(filePath, `NOT_JSON\n${jsonLine({ message: "after ✓" })}`);
          polls += 1;
          return;
        }
        return rejectingSleep();
      };

      await expect(follow(filePath, { json: true }, { _deps: { emit, readRange, sleep } })).resolves.toBe("cancelled");
      expect(emit).toHaveBeenCalledTimes(2);
      expect(emitted.map((line) => JSON.parse(line).message)).toEqual(["before ✓", "after ✓"]);
    });
  });

  test("AC-11: resynchronizes to offset zero after in-place truncation", async () => {
    await withTempDir(async (dir) => {
      const seed = jsonLine({ message: "this initial entry is deliberately longer than replacement content ✓" });
      const filePath = writeFixture(dir, seed);
      const emitted: string[] = [];
      const starts: number[] = [];
      const emit = mock((line: string) => emitted.push(line));
      const readRange = mock(async (fp: string, start: number) => {
        starts.push(start);
        return rangeReader(fp, start);
      });
      let polls = 0;
      let readsBeforeTruncation = 0;
      const sleep = async () => {
        if (polls === 0) {
          readsBeforeTruncation = starts.length;
          writeFileSync(filePath, jsonLine({ message: "reset" }));
          polls += 1;
          return;
        }
        if (polls === 1) {
          appendFileSync(filePath, jsonLine({ message: "resumed ✓" }));
          polls += 1;
          return;
        }
        return rejectingSleep();
      };

      await expect(follow(filePath, { json: true }, { _deps: { emit, readRange, sleep } })).resolves.toBe("cancelled");
      expect(emitted.some((line) => JSON.parse(line).message === "resumed ✓")).toBe(true);
      expect(starts.slice(readsBeforeTruncation)).toContain(0);
    });
  });

  test("AC-12: reads each growth poll from the previously consumed byte length", async () => {
    await withTempDir(async (dir) => {
      const filePath = writeFixture(dir, "");
      const first = jsonLine({ message: "first" });
      const second = jsonLine({ message: "second" });
      const starts: number[] = [];
      const readRange = mock(async (fp: string, start: number) => {
        starts.push(start);
        return rangeReader(fp, start);
      });
      let polls = 0;
      const sleep = async () => {
        if (polls === 0) {
          appendFileSync(filePath, first);
          polls += 1;
          return;
        }
        if (polls === 1) {
          appendFileSync(filePath, second);
          polls += 1;
          return;
        }
        return rejectingSleep();
      };

      await expect(
        follow(filePath, { json: true }, { _deps: { emit: mock((_line: string) => {}), readRange, sleep } }),
      ).resolves.toBe("cancelled");
      expect(readRange.mock.calls.map(([fp]) => fp)).toEqual([filePath, filePath]);
      expect(starts).toEqual([0, bytes(first)]);
      expect(starts.slice(1)).not.toContain(0);
    });
  });
});