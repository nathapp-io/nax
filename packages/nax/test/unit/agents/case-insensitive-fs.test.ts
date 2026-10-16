/**
 * The case-insensitivity probe behind the owned-path screen (#2347).
 *
 * Every answer here is driven through `_caseFsDeps.stat`, so both filesystem
 * behaviours are testable on either platform. The one case that needs a REAL
 * volume (AC-24) is darwin-gated, the same way
 * `packages/nax-agent/test/unit/tools/credential-read-deny.test.ts` gates its
 * case-variant case.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { cleanupTempDir, makeTempDir, withDepsRestore } from "@test/helpers";
import { _caseFsDeps, _resetCaseFsCache, isCaseInsensitiveFs } from "@/agents/case-insensitive-fs";

withDepsRestore(_caseFsDeps, ["stat"]);
// The cache is keyed by root and AC-9 pins its lifetime, so every case starts
// from a cold cache -- and ACs 14/17 of the sibling file give one root
// opposite answers.
afterEach(() => {
  _resetCaseFsCache();
});

/** The dev+ino pair a stub reports for a path that resolves. */
const STATS = { dev: 7, ino: 42 };

/** An errno-carrying error, the shape `statSync` throws. */
const fsError = (code: string): Error => Object.assign(new Error(`${code}: stub`), { code });

/** A root whose last segment carries cased letters, so the probe path is the root itself. */
const ROOT = "/probe/Root";

/** Every path the stub was asked to stat, in call order. */
let statCalls: string[] = [];

/** Replace the probe's stat with `answer`, recording every path it is asked about. */
function stubStat(answer: (path: string) => { dev: number; ino: number }): void {
  statCalls = [];
  _caseFsDeps.stat = (path: string) => {
    statCalls.push(path);
    return answer(path);
  };
}

/** Resolve every spelling: a case-insensitive filesystem, where both reach one inode. */
const everySpelling = (): { dev: number; ino: number } => STATS;

/** Resolve only `original`; every other spelling throws `code`. */
const originalOnly =
  (original: string, code: string) =>
  (path: string): { dev: number; ino: number } => {
    if (path === original) return STATS;
    throw fsError(code);
  };

describe("isCaseInsensitiveFs", () => {
  test("AC1: the same dev and ino for the case-swapped spelling means case-insensitive", () => {
    stubStat(everySpelling);
    expect(isCaseInsensitiveFs(ROOT)).toBe(true);
  });

  test("AC2: ENOENT for the case-swapped spelling means case-sensitive", () => {
    stubStat(originalOnly(ROOT, "ENOENT"));
    expect(isCaseInsensitiveFs(ROOT)).toBe(false);
  });

  test("AC3: ENOTDIR for the case-swapped spelling means case-sensitive", () => {
    stubStat(originalOnly(ROOT, "ENOTDIR"));
    expect(isCaseInsensitiveFs(ROOT)).toBe(false);
  });

  test("AC4: a different ino for the case-swapped spelling means case-sensitive", () => {
    stubStat((path) => (path === ROOT ? STATS : { dev: STATS.dev, ino: STATS.ino + 1 }));
    expect(isCaseInsensitiveFs(ROOT)).toBe(false);
  });

  test("AC5: any other errno for the case-swapped spelling fails closed to case-insensitive", () => {
    stubStat(originalOnly(ROOT, "EACCES"));
    expect(isCaseInsensitiveFs(ROOT)).toBe(true);
  });

  test("AC6: when the original spelling cannot be stat'ed at all, it fails closed without a swap", () => {
    stubStat(() => {
      throw fsError("ENOENT");
    });
    expect(isCaseInsensitiveFs(ROOT)).toBe(true);
    expect(statCalls).toEqual([ROOT]);
  });

  test("AC7: a path with no cased segment anywhere up to the filesystem root fails closed", () => {
    stubStat(everySpelling);
    expect(isCaseInsensitiveFs("/1/2")).toBe(true);
    expect(statCalls).toEqual([]);
  });

  test("AC8: the probe swaps the nearest cased segment and never a later one", () => {
    stubStat(everySpelling);
    expect(isCaseInsensitiveFs("/probe-x/Work/123")).toBe(true);
    expect(statCalls).toEqual(["/probe-x/Work", "/probe-x/wORK"]);
    expect(statCalls.some((path) => path.endsWith("123"))).toBe(false);
  });

  test("AC9: one probe per root is cached until the cache is reset", () => {
    stubStat(everySpelling);
    expect(isCaseInsensitiveFs(ROOT)).toBe(true);
    const afterFirstProbe = statCalls.length;
    expect(afterFirstProbe).toBeGreaterThan(0);

    expect(isCaseInsensitiveFs(ROOT)).toBe(true);
    expect(statCalls.length).toBe(afterFirstProbe);

    _resetCaseFsCache();
    expect(isCaseInsensitiveFs(ROOT)).toBe(true);
    expect(statCalls.length).toBeGreaterThan(afterFirstProbe);
  });
});

/** The probe's own swap, recomputed here: `Work` -> `wORK`. */
const caseSwapped = (path: string): string =>
  join(
    dirname(path),
    basename(path).replace(/[a-zA-Z]/g, (char) =>
      char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase(),
    ),
  );

// AC-24 is the only case that uses the REAL stat: it pins the probe against an
// actual volume, so it needs a filesystem that answers the question at all.
describe("isCaseInsensitiveFs — real filesystem", () => {
  test.if(process.platform === "darwin")(
    "AC24: on darwin the probe agrees with the on-disk case-swapped spelling",
    () => {
      const root = realpathSync(makeTempDir("nax-case-fs-"));
      try {
        expect(isCaseInsensitiveFs(root)).toBe(existsSync(caseSwapped(root)));
      } finally {
        cleanupTempDir(root);
      }
    },
  );
});
