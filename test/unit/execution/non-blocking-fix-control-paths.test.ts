/**
 * US-003 — NBF classifies control files and records restore losses.
 *
 * Two behaviours live here:
 *
 *   1. `createMeasureSourceDiff` classifies every changed path against the
 *      adversarial-passed ref: test files are excluded first (ADR-009 SSOT),
 *      `.nax` control files are reported separately (they buy no file count and
 *      no source lines), and every remaining path lands in exactly one of
 *      added / modified / deleted. Driven through a real temporary git repo so
 *      the `git diff --numstat` / `--name-status` parse is the thing under test.
 *
 *   2. `runNonBlockingFix` restores — never keeps — a pass that touched a nax
 *      control file, and the `source diff exceeded cap — restoring` log carries
 *      the classified path lists, capped at `NBF_LOGGED_PATH_LIMIT`.
 *
 * Split out of `non-blocking-fix.test.ts` (already past the ~650-line split
 * threshold) by concern.
 */
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  assertDefined,
  makeFinding,
  makeNaxConfig,
  withDepsRestore,
  withInfoSpy,
  withTempDir,
  withWarnSpy,
} from "@test/helpers";
import { testPatternConfigSelector } from "@/config";
import type { NonBlockingFixConfig } from "@/config/selectors";
import type { NonBlockingFixArgs, NonBlockingFixDeps, SourceDiffMetrics } from "@/execution/non-blocking-fix";
import {
  _nonBlockingFixDeps,
  createMeasureSourceDiff,
  NBF_LOGGED_PATH_LIMIT,
  runNonBlockingFix,
} from "@/execution/non-blocking-fix";
import type { FixReviewVerdict } from "@/review/fix-review";
import type { SpawnResult } from "@/utils/bun-deps";

// ─── classification: createMeasureSourceDiff ──────────────────────────────────

/** Test patterns are supplied explicitly so the resolver never auto-detects. */
const TEST_CONFIG = testPatternConfigSelector.select(
  makeNaxConfig({
    execution: {
      smartTestRunner: {
        enabled: true,
        testFilePatterns: ["test/**/*.test.ts"],
        fallback: "import-grep",
        maxScanFiles: 200,
      },
    },
  }),
);

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

function initRepo(dir: string): void {
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "nax-test@example.com");
  git(dir, "config", "user.name", "nax test");
  git(dir, "config", "commit.gpgsign", "false");
}

function commitAll(dir: string, message: string): string {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD").trim();
}

function measure(dir: string): (workdir: string, fromRef: string) => Promise<SourceDiffMetrics> {
  return createMeasureSourceDiff({ config: TEST_CONFIG, projectDir: dir, packageDir: dir });
}

describe("createMeasureSourceDiff — path classification (US-003)", () => {
  test("US-003 AC1: classifies modified / added / deleted source paths against the ref", async () => {
    await withTempDir(async (dir) => {
      initRepo(dir);
      await Bun.write(join(dir, "src/a.ts"), "a1\n");
      await Bun.write(join(dir, "src/c.ts"), "c1\n");
      const ref = commitAll(dir, "initial");

      await Bun.write(join(dir, "src/a.ts"), "a2\n");
      await Bun.write(join(dir, "src/b.ts"), "b1\n");
      rmSync(join(dir, "src/c.ts"));
      commitAll(dir, "second");

      const metrics = await measure(dir)(dir, ref);

      expect(metrics.paths).toEqual({ added: ["src/b.ts"], modified: ["src/a.ts"], deleted: ["src/c.ts"] });
      expect(metrics.fileCount).toBe(3);
      expect(metrics.controlPaths).toEqual([]);
    });
  });

  test("US-003 AC2: an excluded test file appears in no list and buys no file count", async () => {
    await withTempDir(async (dir) => {
      initRepo(dir);
      await Bun.write(join(dir, "src/a.ts"), "a1\n");
      await Bun.write(join(dir, "test/unit/a.test.ts"), "t1\n");
      const ref = commitAll(dir, "initial");

      await Bun.write(join(dir, "src/a.ts"), "a2\n");
      await Bun.write(join(dir, "test/unit/a.test.ts"), "t2\n");
      commitAll(dir, "second");

      const metrics = await measure(dir)(dir, ref);

      expect(metrics.paths).toEqual({ added: [], modified: ["src/a.ts"], deleted: [] });
      expect(metrics.controlPaths).toEqual([]);
      expect(metrics.fileCount).toBe(1);
    });
  });

  test("US-003 AC3: a deleted .nax control file is reported and buys no counts", async () => {
    await withTempDir(async (dir) => {
      initRepo(dir);
      await Bun.write(join(dir, ".nax/features/f/stories/US-001.json"), "{}\n");
      const ref = commitAll(dir, "initial");

      rmSync(join(dir, ".nax/features/f/stories/US-001.json"));
      commitAll(dir, "second");

      const metrics = await measure(dir)(dir, ref);

      expect(metrics.controlPaths).toEqual([".nax/features/f/stories/US-001.json"]);
      expect(metrics.fileCount).toBe(0);
      expect(metrics.sourceLineCount).toBe(0);
    });
  });

  test("US-003 AC16: a .nax acceptance test file is a control path, not an excluded test file", async () => {
    // The `.nax-acceptance.test.ts` suffix does not match the resolved test globs,
    // so the file reaches the control-path branch rather than the test-file skip.
    await withTempDir(async (dir) => {
      initRepo(dir);
      await Bun.write(join(dir, ".nax/features/f/.nax-acceptance.test.ts"), "t1\n");
      const ref = commitAll(dir, "initial");

      await Bun.write(join(dir, ".nax/features/f/.nax-acceptance.test.ts"), "t2\n");
      commitAll(dir, "second");

      const metrics = await measure(dir)(dir, ref);

      expect(metrics.controlPaths).toEqual([".nax/features/f/.nax-acceptance.test.ts"]);
      expect(metrics.fileCount).toBe(0);
    });
  });
});

/** A fake subprocess for `_nonBlockingFixDeps.spawn`, typed as `src/utils/bun-deps` expects. */
function gitProc(spec: { stdout?: string; stderr?: string; exitCode?: number } = {}): SpawnResult {
  const body = (text: string): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(text);
        if (bytes.length > 0) controller.enqueue(bytes);
        controller.close();
      },
    });
  return {
    stdout: body(spec.stdout ?? ""),
    stderr: body(spec.stderr ?? ""),
    exited: Promise.resolve(spec.exitCode ?? 0),
    pid: 4242,
    kill: () => {},
  };
}

describe("createMeasureSourceDiff — git failures surface (US-003)", () => {
  withDepsRestore(_nonBlockingFixDeps, ["spawn"]);

  test("a failing git diff --numstat rejects rather than reporting an empty diff", async () => {
    await withTempDir(async (dir) => {
      _nonBlockingFixDeps.spawn = () => gitProc({ stderr: "fatal: bad revision", exitCode: 128 });

      await expect(measure(dir)(dir, "HEAD~1")).rejects.toThrow(/git diff --numstat/);
    });
  });

  test("a failing git diff --name-status rejects too", async () => {
    await withTempDir(async (dir) => {
      _nonBlockingFixDeps.spawn = (cmd: string[]) =>
        cmd.includes("--name-status") ? gitProc({ stderr: "fatal: boom", exitCode: 128 }) : gitProc();

      await expect(measure(dir)(dir, "HEAD~1")).rejects.toThrow(/git diff --name-status/);
    });
  });
});

// ─── the restore gate: runNonBlockingFix ──────────────────────────────────────

const CFG: NonBlockingFixConfig = {
  enabled: true,
  scope: "both",
  regressionAttempts: 1,
  verifierGuard: true,
  sourceDiffCap: { maxFiles: 10, maxLines: 500 },
  sources: ["adversarial"],
};

const SEED = [
  makeFinding({ source: "adversarial-review", severity: "warning", category: "input", message: "seed finding" }),
];

const WORKDIR = "/tmp/nax-us003-workdir";
const SNAPSHOT_SHA = "us003-snapshot-sha";

interface Recorder {
  rollbacks: string[];
}

function makeRecorder(): Recorder {
  return { rollbacks: [] };
}

function makeArgs(overrides: Partial<NonBlockingFixArgs> = {}): NonBlockingFixArgs {
  return {
    workdir: WORKDIR,
    storyId: "us-003",
    advisoryFindings: SEED,
    cfg: CFG,
    phaseOutputs: {},
    phaseCosts: {},
    runRectify: async () => ({ rectificationExhausted: false }),
    ...overrides,
  };
}

function makeDeps(
  record: Recorder,
  metrics: SourceDiffMetrics,
  overrides: Partial<NonBlockingFixDeps> = {},
): Partial<NonBlockingFixDeps> {
  return {
    captureSnapshotRef: async () => ({ sha: SNAPSHOT_SHA, untrackedBefore: [] }),
    rollbackToRef: async (_workdir, ref) => {
      record.rollbacks.push(ref);
    },
    listCommitsSince: async () => [],
    measureSourceDiff: async () => metrics,
    ...overrides,
  };
}

const WITHIN_CAP: SourceDiffMetrics = { fileCount: 1, sourceLineCount: 10 };

describe("runNonBlockingFix — nax control files force a restore (US-003)", () => {
  test("US-003 AC4: a control path restores the pass", async () => {
    const record = makeRecorder();

    const result = await runNonBlockingFix(
      makeArgs(),
      makeDeps(record, { fileCount: 0, sourceLineCount: 0, controlPaths: [".nax/rules/a.md"] }),
    );

    expect(result).toEqual({ ran: true, kept: false, restored: true });
    expect(record.rollbacks).toEqual([SNAPSHOT_SHA]);
  });

  test("US-003 AC5: the restore names the control paths it is undoing", async () => {
    const record = makeRecorder();

    const call = await withWarnSpy(async (warnSpy) => {
      await runNonBlockingFix(
        makeArgs(),
        makeDeps(record, { fileCount: 0, sourceLineCount: 0, controlPaths: [".nax/rules/a.md"] }),
      );
      return warnSpy.mock.calls.find((c) => String(c[1]).includes("NBF pass touched nax control files"));
    });

    assertDefined(call, "control-path warn log");
    expect(call[0]).toBe("non-blocking-fix");
    const fields = call[2];
    assertDefined(fields, "control-path warn data");
    expect(fields.storyId).toBe("us-003");
    expect(fields.controlPaths).toEqual([".nax/rules/a.md"]);
    expect(fields.controlPathCount).toBe(1);
  });

  test("US-003 AC6: 25 control paths are logged as a sample of 20 with the full count", async () => {
    const record = makeRecorder();
    const many = Array.from({ length: 25 }, (_, i) => `.nax/rules/rule-${i}.md`);

    const data = await withWarnSpy(async (warnSpy) => {
      await runNonBlockingFix(makeArgs(), makeDeps(record, { fileCount: 0, sourceLineCount: 0, controlPaths: many }));
      const call = warnSpy.mock.calls.find((c) => String(c[1]).includes("NBF pass touched nax control files"));
      assertDefined(call, "control-path warn log");
      assertDefined(call[2], "control-path warn data");
      return call[2];
    });

    expect(NBF_LOGGED_PATH_LIMIT).toBe(20);
    expect(data.controlPaths).toHaveLength(20);
    expect(data.controlPathCount).toBe(25);
  });

  test("US-003 AC17: a reviewFix dep is never consulted once a control path forces a restore", async () => {
    const record = makeRecorder();
    let reviewCalls = 0;

    const result = await runNonBlockingFix(
      makeArgs(),
      makeDeps(
        record,
        { fileCount: 0, sourceLineCount: 0, controlPaths: [".nax/rules/a.md"] },
        {
          reviewFix: async (): Promise<FixReviewVerdict> => {
            reviewCalls += 1;
            return { kind: "pass", reviewed: true, reason: "ok" };
          },
        },
      ),
    );

    expect(result).toEqual({ ran: true, kept: false, restored: true });
    expect(reviewCalls).toBe(0);
  });

  test("US-003 AC9: a metric with only counts and no path lists is kept", async () => {
    const record = makeRecorder();

    const result = await runNonBlockingFix(makeArgs(), makeDeps(record, { fileCount: 1, sourceLineCount: 10 }));

    expect(result).toEqual({ ran: true, kept: true, restored: false });
    expect(record.rollbacks).toEqual([]);
  });

  test("US-003 AC15: a throwing measurement warns and restores", async () => {
    const record = makeRecorder();

    const warn = await withWarnSpy(async (warnSpy) => {
      const result = await runNonBlockingFix(
        makeArgs(),
        makeDeps(record, WITHIN_CAP, {
          measureSourceDiff: async () => {
            throw new Error("git diff failed");
          },
        }),
      );
      expect(result).toEqual({ ran: true, kept: false, restored: true });
      return warnSpy.mock.calls.find((c) => String(c[1]).includes("source-diff measurement threw"));
    });

    expect(warn).toBeDefined();
    expect(record.rollbacks).toEqual([SNAPSHOT_SHA]);
  });
});

describe("runNonBlockingFix — the cap log carries the classified paths (US-003)", () => {
  test("US-003 AC7: the cap log carries the path lists and their counts", async () => {
    const record = makeRecorder();
    const metrics: SourceDiffMetrics = {
      fileCount: 4,
      sourceLineCount: 900,
      paths: { added: ["src/x.ts", "src/y.ts"], modified: ["src/m.ts"], deleted: ["src/d.ts"] },
      controlPaths: [],
    };

    const data = await withInfoSpy(async (infoSpy) => {
      await runNonBlockingFix(
        makeArgs({ cfg: { ...CFG, sourceDiffCap: { maxFiles: 100, maxLines: 10 } } }),
        makeDeps(record, metrics),
      );
      const call = infoSpy.mock.calls.find((c) => String(c[1]).includes("source diff exceeded cap"));
      assertDefined(call, "cap log");
      assertDefined(call[2], "cap log data");
      return call[2];
    });

    expect(data.added).toEqual(["src/x.ts", "src/y.ts"]);
    expect(data.modified).toEqual(["src/m.ts"]);
    expect(data.deleted).toEqual(["src/d.ts"]);
    expect(data.addedCount).toBe(2);
    expect(data.modifiedCount).toBe(1);
    expect(data.deletedCount).toBe(1);
    expect(data.fileCount).toBe(4);
    expect(data.sourceLineCount).toBe(900);
  });

  test("US-003 AC8: 30 added paths are logged as a sample of 20 with addedCount 30", async () => {
    const record = makeRecorder();
    const added = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`);
    const metrics: SourceDiffMetrics = {
      fileCount: 30,
      sourceLineCount: 120,
      paths: { added, modified: [], deleted: [] },
      controlPaths: [],
    };

    const data = await withInfoSpy(async (infoSpy) => {
      await runNonBlockingFix(
        makeArgs({ cfg: { ...CFG, sourceDiffCap: { maxFiles: 5, maxLines: 500 } } }),
        makeDeps(record, metrics),
      );
      const call = infoSpy.mock.calls.find((c) => String(c[1]).includes("source diff exceeded cap"));
      assertDefined(call, "cap log");
      assertDefined(call[2], "cap log data");
      return call[2];
    });

    expect(data.added).toHaveLength(20);
    expect(data.added).toEqual(added.slice(0, 20));
    expect(data.addedCount).toBe(30);
  });
});
