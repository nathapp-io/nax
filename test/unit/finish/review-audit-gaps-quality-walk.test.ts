import { describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
/**
 * Coverage gate for the quality WALK — US-002.
 *
 * Each AC below corresponds to one entry in the story's acceptance list.
 * The audit's git seam (`_gitDeps.spawn`) is stubbed in `makeGitStub()` so
 * tests control the changed-file list; tests that exercise a git failure
 * inject a spawn that returns a non-zero exit code.
 */
import type { FindingDisposition, ReviewReport } from "@/finish";
import { auditGaps, validateDispositions } from "@/finish";
import { _gitDeps } from "@/utils/git";
import { withTempDir } from "@test/helpers";

function makeReport(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    findings: [],
    touchpoints: [],
    walk: [],
    sawNoFindings: false,
    sawTouchpointsSection: false,
    sawWalkSection: false,
    ...overrides,
  };
}

/** Spawn stub that returns `stdout` and `exitCode` on its `exited` promise. */
function makeGitSpawnMock(stdout: string, exitCode = 0) {
  return mock(() => ({
    exited: Promise.resolve(exitCode),
    stdout: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(stdout));
        c.close();
      },
    }),
    stderr: new ReadableStream({
      start(c) {
        c.close();
      },
    }),
    kill: () => {},
  })) as unknown as typeof _gitDeps.spawn; // test-ratchet-allow: as-unknown-as
}

/** Wrap a spawn mock as a beforeEach-save / afterEach-restore on _gitDeps.spawn. */
function stubGitSpawn(spawnFn: typeof _gitDeps.spawn) {
  const orig = _gitDeps.spawn;
  _gitDeps.spawn = spawnFn;
  return () => {
    _gitDeps.spawn = orig;
  };
}

describe("auditGaps — quality WALK coverage against changed files", () => {
  // AC1: range names src/a.ts and src/b.ts; walk names both → no unwalked-files gap
  test("AC1: quality walk covering both changed files emits no unwalked-files gap", async () => {
    await withTempDir(async (dir) => {
      const restore = stubGitSpawn(makeGitSpawnMock("src/a.ts\nsrc/b.ts\n"));
      try {
        const report = makeReport({
          sawTouchpointsSection: true,
          touchpoints: [{ path: "none", note: "n/a" }],
          sawWalkSection: true,
          walk: ["src/a.ts — earns its place", "src/b.ts — earns its place"],
        });
        const gaps = await auditGaps(report, dir, { base: "main", head: "HEAD" }, "quality");
        expect(gaps.some((g) => /unwalked|not walked|walked/i.test(g))).toBe(false);
      } finally {
        restore();
      }
    });
  });

  // AC2: range names src/a.ts and src/b.ts; walk names only src/a.ts → gap names src/b.ts
  test("AC2: quality walk missing a changed file names that file in the gap", async () => {
    await withTempDir(async (dir) => {
      const restore = stubGitSpawn(makeGitSpawnMock("src/a.ts\nsrc/b.ts\n"));
      try {
        const report = makeReport({
          sawTouchpointsSection: true,
          touchpoints: [{ path: "none", note: "n/a" }],
          sawWalkSection: true,
          walk: ["src/a.ts — earns its place"],
        });
        const gaps = await auditGaps(report, dir, { base: "main", head: "HEAD" }, "quality");
        const unwalkedGap = gaps.find((g) => /unwalked|not walked|src\/b\.ts/i.test(g));
        expect(unwalkedGap).toBeDefined();
        expect(unwalkedGap).toContain("src/b.ts");
      } finally {
        restore();
      }
    });
  });

  // AC3: walk line "src/a.ts — earns its place" for changed src/a.ts → no gap for src/a.ts
  test("AC3: quality walk with annotation after the path still counts as coverage", async () => {
    await withTempDir(async (dir) => {
      const restore = stubGitSpawn(makeGitSpawnMock("src/a.ts\n"));
      try {
        const report = makeReport({
          sawTouchpointsSection: true,
          touchpoints: [{ path: "none", note: "n/a" }],
          sawWalkSection: true,
          walk: ["src/a.ts — earns its place"],
        });
        const gaps = await auditGaps(report, dir, { base: "main", head: "HEAD" }, "quality");
        expect(gaps.some((g) => g.includes("src/a.ts") && /unwalked|not walked/i.test(g))).toBe(false);
      } finally {
        restore();
      }
    });
  });

  // AC4: range with .nax/config.json + src/a.ts; walk names only src/a.ts → no unwalked gap
  test("AC4: quality walk covering the only non-noise changed file emits no gap", async () => {
    await withTempDir(async (dir) => {
      const restore = stubGitSpawn(makeGitSpawnMock("packages/core/.nax/config.json\nsrc/a.ts\n"));
      try {
        const report = makeReport({
          sawTouchpointsSection: true,
          touchpoints: [{ path: "none", note: "n/a" }],
          sawWalkSection: true,
          walk: ["src/a.ts — earns its place"],
        });
        const gaps = await auditGaps(report, dir, { base: "main", head: "HEAD" }, "quality");
        expect(gaps.some((g) => /unwalked|not walked/i.test(g))).toBe(false);
      } finally {
        restore();
      }
    });
  });

  // AC5: range with bun.lock + src/a.ts; walk names only src/a.ts → no unwalked gap
  test("AC5: lockfile-only changed files are excluded from the quality coverage check", async () => {
    await withTempDir(async (dir) => {
      const restore = stubGitSpawn(makeGitSpawnMock("bun.lock\nsrc/a.ts\n"));
      try {
        const report = makeReport({
          sawTouchpointsSection: true,
          touchpoints: [{ path: "none", note: "n/a" }],
          sawWalkSection: true,
          walk: ["src/a.ts — earns its place"],
        });
        const gaps = await auditGaps(report, dir, { base: "main", head: "HEAD" }, "quality");
        expect(gaps.some((g) => /unwalked|not walked|bun\.lock/i.test(g))).toBe(false);
      } finally {
        restore();
      }
    });
  });

  // AC6: git invocation non-zero → no unwalked-files gap; existing touchpoint behaviour preserved
  test("AC6: changed-file git invocation failure emits no unwalked-files gap", async () => {
    await withTempDir(async (dir) => {
      const restore = stubGitSpawn(makeGitSpawnMock("fatal: bad revision", 128));
      try {
        const report = makeReport({
          sawTouchpointsSection: true,
          touchpoints: [{ path: "none", note: "n/a" }],
          sawWalkSection: true,
          walk: ["src/a.ts — earns its place"],
        });
        const gaps = await auditGaps(report, dir, { base: "main", head: "HEAD" }, "quality");
        expect(gaps.some((g) => /unwalked|not walked/i.test(g))).toBe(false);
      } finally {
        restore();
      }
    });
  });

  // AC7: git failure AND no TOUCHPOINTS section → existing touchpoints shape gap emitted
  test("AC7: on git failure, the existing touchpoints shape gap still fires when the section is missing", async () => {
    await withTempDir(async (dir) => {
      const restore = stubGitSpawn(makeGitSpawnMock("fatal: bad revision", 128));
      try {
        const report = makeReport({
          sawTouchpointsSection: false,
          touchpoints: [],
          sawWalkSection: true,
          walk: ["src/a.ts — earns its place"],
        });
        const gaps = await auditGaps(report, dir, { base: "main", head: "HEAD" }, "quality");
        expect(gaps.some((g) => g.includes("TOUCHPOINTS"))).toBe(true);
      } finally {
        restore();
      }
    });
  });

  // AC8: spec phase; walk names no changed files → no unwalked-files gap
  test("AC8: spec phase never emits an unwalked-files gap even when walk is empty", async () => {
    await withTempDir(async (dir) => {
      const restore = stubGitSpawn(makeGitSpawnMock("src/a.ts\nsrc/b.ts\n"));
      try {
        const report = makeReport({
          sawTouchpointsSection: true,
          touchpoints: [{ path: "none", note: "n/a" }],
          sawWalkSection: true,
          walk: ["AC-1 Covered"],
        });
        const gaps = await auditGaps(report, dir, { base: "main", head: "HEAD" }, "spec");
        expect(gaps.some((g) => /unwalked|not walked/i.test(g))).toBe(false);
      } finally {
        restore();
      }
    });
  });

  // AC9: 4 cited touchpoint paths, only 1 existing → touchpoint-path gap
  test("AC9: when most checked cited touchpoint paths do not exist, the touchpoint gap fires", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "real.ts"), "export const x = 1;\n");
      const restore = stubGitSpawn(makeGitSpawnMock(""));
      try {
        const report = makeReport({
          sawTouchpointsSection: true,
          touchpoints: [
            { path: "src/does-not-exist-a.ts", note: "fake" },
            { path: "src/does-not-exist-b.ts", note: "fake" },
            { path: "src/does-not-exist-c.ts", note: "fake" },
            { path: "real.ts", note: "real one" },
          ],
          sawWalkSection: true,
          walk: ["AC-1 Covered"],
        });
        const gaps = await auditGaps(report, dir, { base: "main", head: "HEAD" }, "quality");
        expect(gaps.some((g) => /touchpoint path.*does not exist/i.test(g))).toBe(true);
      } finally {
        restore();
      }
    });
  });

  // AC10: 4 cited touchpoint paths, 3 existing → no touchpoint-path gap
  test("AC10: when a majority of checked cited touchpoint paths exist, no touchpoint-path gap", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "real-a.ts"), "export const a = 1;\n");
      await Bun.write(join(dir, "real-b.ts"), "export const b = 1;\n");
      await Bun.write(join(dir, "real-c.ts"), "export const c = 1;\n");
      const restore = stubGitSpawn(makeGitSpawnMock(""));
      try {
        const report = makeReport({
          sawTouchpointsSection: true,
          touchpoints: [
            { path: "real-a.ts", note: "real one" },
            { path: "real-b.ts", note: "real one" },
            { path: "real-c.ts", note: "real one" },
            { path: "src/does-not-exist.ts", note: "fake" },
          ],
          sawWalkSection: true,
          walk: ["AC-1 Covered"],
        });
        const gaps = await auditGaps(report, dir, { base: "main", head: "HEAD" }, "quality");
        expect(gaps.some((g) => /touchpoint path.*does not exist/i.test(g))).toBe(false);
      } finally {
        restore();
      }
    });
  });

  // AC11: WALK section absent → existing missing-WALK gap (preserved)
  test("AC11: when the WALK section is absent, the existing missing-WALK gap fires", async () => {
    await withTempDir(async (dir) => {
      const restore = stubGitSpawn(makeGitSpawnMock("src/a.ts\n"));
      try {
        const report = makeReport({
          sawTouchpointsSection: true,
          touchpoints: [{ path: "none", note: "n/a" }],
          sawWalkSection: false,
          walk: [],
        });
        const gaps = await auditGaps(report, dir, { base: "main", head: "HEAD" }, "quality");
        expect(gaps.some((g) => g.includes("WALK"))).toBe(true);
      } finally {
        restore();
      }
    });
  });

  // AC12: all changed paths excluded as noise → no unwalked-files gap
  test("AC12: when all changed files are noise, no unwalked-files gap is emitted", async () => {
    await withTempDir(async (dir) => {
      const restore = stubGitSpawn(makeGitSpawnMock("bun.lock\npackages/core/.nax/config.json\ndist/site.js\n"));
      try {
        const report = makeReport({
          sawTouchpointsSection: true,
          touchpoints: [{ path: "none", note: "n/a" }],
          sawWalkSection: true,
          walk: ["AC-1 Covered"],
        });
        const gaps = await auditGaps(report, dir, { base: "main", head: "HEAD" }, "quality");
        expect(gaps.some((g) => /unwalked|not walked/i.test(g))).toBe(false);
      } finally {
        restore();
      }
    });
  });

  // AC13: walk line with no extractable leading changed-file path provides no coverage
  test("AC13: a malformed WALK line provides no coverage; every otherwise-unwalked required file is named", async () => {
    await withTempDir(async (dir) => {
      const restore = stubGitSpawn(makeGitSpawnMock("src/a.ts\nsrc/b.ts\n"));
      try {
        const report = makeReport({
          sawTouchpointsSection: true,
          touchpoints: [{ path: "none", note: "n/a" }],
          sawWalkSection: true,
          walk: ["totally malformed line", "another malformed line"],
        });
        const gaps = await auditGaps(report, dir, { base: "main", head: "HEAD" }, "quality");
        const unwalkedGap = gaps.find((g) => /unwalked|not walked/i.test(g));
        expect(unwalkedGap).toBeDefined();
        // The gap must name every otherwise-unwalked required changed file.
        expect(unwalkedGap).toContain("src/a.ts");
        expect(unwalkedGap).toContain("src/b.ts");
      } finally {
        restore();
      }
    });
  });

  // AC14: walk names an extra path outside the changed set while all required files are covered
  test("AC14: extra paths in the quality WALK are ignored when all required files are covered", async () => {
    await withTempDir(async (dir) => {
      const restore = stubGitSpawn(makeGitSpawnMock("src/a.ts\n"));
      try {
        const report = makeReport({
          sawTouchpointsSection: true,
          touchpoints: [{ path: "none", note: "n/a" }],
          sawWalkSection: true,
          walk: ["src/a.ts — earns its place", "src/extra-not-in-diff.ts — picked this up anyway"],
        });
        const gaps = await auditGaps(report, dir, { base: "main", head: "HEAD" }, "quality");
        expect(gaps.some((g) => /unwalked|not walked/i.test(g))).toBe(false);
      } finally {
        restore();
      }
    });
  });
});

describe("validateDispositions (smoke — unchanged behaviour)", () => {
  test("marks evidenceMissing only on a rejected disposition whose cited file is absent", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "real.ts"), "export const x = 1;\n");
      const dispositions: FindingDisposition[] = [
        { index: 1, disposition: "rejected", evidence: "real.ts:12" },
        { index: 2, disposition: "rejected", evidence: "missing.ts:3" },
      ];
      const out = await validateDispositions(dir, dispositions);
      expect(out[0].evidenceMissing).toBeUndefined();
      expect(out[1].evidenceMissing).toBe(true);
    });
  });
});
