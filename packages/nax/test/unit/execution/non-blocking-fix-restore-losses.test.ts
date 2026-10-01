/**
 * US-003 — NBF records what a restore discards.
 *
 * `restoreToSnapshot` lists the commits the pass landed since the
 * adversarial-passed snapshot (`listCommitsSince`) BEFORE it hard-resets the
 * tree, so the `best-effort fix exhausted — restored to adversarial-passed`
 * record names the work being thrown away. A failure to list is not a reason to
 * skip the restore: it degrades to `[]` and the restore proceeds. A kept pass
 * never lists anything.
 *
 * `listCommitsSince`'s own default implementation is exercised against a real
 * temporary git repo.
 *
 * Split out of `non-blocking-fix.test.ts` (already past the ~650-line split
 * threshold) by concern.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assertDefined, makeFinding, withInfoSpy, withTempDir } from "@test/helpers";
import type { NonBlockingFixConfig } from "@/config/selectors";
import type { NonBlockingFixArgs, NonBlockingFixDeps } from "@/execution/non-blocking-fix";
import { listCommitsSince, runNonBlockingFix } from "@/execution/non-blocking-fix";

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

/** Ordered trace of the git-touching deps, so "before" is assertable. */
interface Trace {
  events: string[];
  commitsSince: Array<[string, string]>;
}

function makeTrace(): Trace {
  return { events: [], commitsSince: [] };
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

function makeDeps(trace: Trace, overrides: Partial<NonBlockingFixDeps> = {}): Partial<NonBlockingFixDeps> {
  return {
    captureSnapshotRef: async () => ({ sha: SNAPSHOT_SHA, untrackedBefore: [] }),
    listCommitsSince: async (workdir, ref) => {
      trace.commitsSince.push([workdir, ref]);
      trace.events.push("listCommitsSince");
      return [];
    },
    rollbackToRef: async () => {
      trace.events.push("rollbackToRef");
    },
    measureSourceDiff: async () => ({ fileCount: 1, sourceLineCount: 10 }),
    ...overrides,
  };
}

describe("runNonBlockingFix — discarded-commit accounting (US-003)", () => {
  test("US-003 AC10: the restore lists commits for the workdir + snapshot sha before rollbackToRef", async () => {
    const trace = makeTrace();

    const result = await runNonBlockingFix(
      makeArgs({ runRectify: async () => ({ rectificationExhausted: true }) }),
      makeDeps(trace),
    );

    expect(result).toEqual({ ran: true, kept: false, restored: true });
    expect(trace.commitsSince).toEqual([[WORKDIR, SNAPSHOT_SHA]]);
    expect(trace.events).toEqual(["listCommitsSince", "rollbackToRef"]);
  });

  test("US-003 AC11: the restore log carries the discarded SHAs", async () => {
    const trace = makeTrace();

    const data = await withInfoSpy(async (infoSpy) => {
      await runNonBlockingFix(
        makeArgs({ runRectify: async () => ({ rectificationExhausted: true }) }),
        makeDeps(trace, { listCommitsSince: async () => ["c3", "c2", "c1"] }),
      );
      const call = infoSpy.mock.calls.find((c) => String(c[1]).includes("best-effort fix exhausted"));
      assertDefined(call, "restore log");
      assertDefined(call[2], "restore log data");
      return call[2];
    });

    expect(data.discardedCommits).toEqual(["c3", "c2", "c1"]);
    expect(data.storyId).toBe("us-003");
  });

  test("US-003 AC12: a rejecting commit listing still rolls back and logs an empty list", async () => {
    const trace = makeTrace();
    let rolled = 0;
    let discarded: unknown;

    const result = await withInfoSpy(async (infoSpy) => {
      const res = await runNonBlockingFix(
        makeArgs({ runRectify: async () => ({ rectificationExhausted: true }) }),
        makeDeps(trace, {
          listCommitsSince: async () => {
            throw new Error("git rev-list failed");
          },
          rollbackToRef: async () => {
            rolled += 1;
          },
        }),
      );
      const call = infoSpy.mock.calls.find((c) => String(c[1]).includes("best-effort fix exhausted"));
      assertDefined(call, "restore log");
      assertDefined(call[2], "restore log data");
      discarded = call[2].discardedCommits;
      return res;
    });

    expect(result).toEqual({ ran: true, kept: false, restored: true });
    expect(rolled).toBe(1);
    expect(discarded).toEqual([]);
  });

  test("US-003 AC13: a kept pass never lists commits", async () => {
    const trace = makeTrace();

    const result = await runNonBlockingFix(makeArgs(), makeDeps(trace));

    expect(result).toEqual({ ran: true, kept: true, restored: false });
    expect(trace.commitsSince).toEqual([]);
    expect(trace.events).toEqual([]);
  });
});

describe("listCommitsSince — the default dependency (US-003)", () => {
  function git(cwd: string, ...args: string[]): string {
    const proc = Bun.spawnSync(["git", ...args], { cwd });
    if (proc.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
    }
    return proc.stdout.toString();
  }

  async function initRepoWithThreeCommits(dir: string): Promise<{ ref: string; second: string; third: string }> {
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "nax-test@example.com");
    git(dir, "config", "user.name", "nax test");
    git(dir, "config", "commit.gpgsign", "false");

    const commit = async (name: string, body: string): Promise<string> => {
      await Bun.write(join(dir, name), body);
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", name);
      return git(dir, "rev-parse", "HEAD").trim();
    };

    return {
      ref: await commit("a.txt", "1\n"),
      second: await commit("b.txt", "2\n"),
      third: await commit("c.txt", "3\n"),
    };
  }

  test("US-003 AC14: returns the commits after the ref, newest first", async () => {
    await withTempDir(async (dir) => {
      const { ref, second, third } = await initRepoWithThreeCommits(dir);

      expect(await listCommitsSince(dir, ref)).toEqual([third, second]);
    });
  });

  test("US-003 AC14 boundary: an unreadable ref rejects rather than returning an empty list", async () => {
    await withTempDir(async (dir) => {
      await initRepoWithThreeCommits(dir);

      await expect(listCommitsSince(dir, "no-such-ref")).rejects.toThrow(/git rev-list/);
    });
  });
});
