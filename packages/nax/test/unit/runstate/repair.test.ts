import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _fileLockDeps, withFileLock } from "@nathapp/nax-agent/internal";
import { cleanupTempDir, makeTempDir, withDepsRestore } from "@test/helpers";
import {
  _repairDeps,
  activateRunState,
  activeKeepers,
  type RunStateHandle,
  repairRunState,
  unregisterKeeper,
} from "@/runstate";
import { runStateWrite } from "@/runstate/store";
import { gitWithTimeout } from "@/utils/git";
import { newFeatureRecord } from "@/workflow/feature-record";
import { handoffLockPath, workflowFeatureDir, workflowRunDir } from "@/workflow/paths";
import {
  newStoryRecord,
  readResult,
  upsertFeatureRecord,
  upsertStoryRecord,
  withLockedFeatureResult,
  writePreflightTokens,
} from "@/workflow/result";

withDepsRestore(_fileLockDeps);

const PRD = ".nax/features/f/prd.json";
const NAX_PRD = '{"stories":"nax"}';
let dir: string;
let handle: RunStateHandle | undefined;

/** nax's own write: recorded by the keeper (Task 8 later routes the real writers through runStateWrite). */
async function naxWrite(path: string, content: string): Promise<void> {
  await runStateWrite(path, { content }, async () => {
    await Bun.write(path, content);
  });
}
const warnings: { message: string; data?: Record<string, unknown> }[] = [];
const origLogger = _repairDeps.logger;

async function git(...args: string[]): Promise<string> {
  return (await gitWithTimeout(args, dir)).stdout;
}

beforeEach(async () => {
  dir = makeTempDir();
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "t@example.com"],
    ["config", "user.name", "t"],
  ])
    await git(...args);
  mkdirSync(join(dir, ".nax/features/f"), { recursive: true });
  writeFileSync(join(dir, PRD), '{"stories":"seed"}');
  await git("add", "-A");
  await git("commit", "-q", "-m", "seed");
  _repairDeps.logger = () => ({
    warn: (_s: string, message: string, data?: Record<string, unknown>) => warnings.push({ message, data }),
  });
  handle = await activateRunState({ runId: "r1", feature: "f", root: dir });
  await naxWrite(join(dir, PRD), NAX_PRD);
});

afterEach(() => {
  handle?.deactivate();
  for (const k of activeKeepers()) unregisterKeeper(k);
  _repairDeps.logger = origLogger;
  warnings.length = 0;
  cleanupTempDir(dir);
});

const ctx = { trigger: "turn" as const, storyId: "US-002", sessionName: "s1", stage: "implementer", turn: 3 };

describe("repairRunState (#2497)", () => {
  test("restores a reverted file and warns with session, step and turn", async () => {
    await git("checkout", "--", PRD);
    const records = await repairRunState(ctx);
    expect(await Bun.file(join(dir, PRD)).text()).toBe(NAX_PRD);
    expect(records).toEqual([{ path: join(dir, PRD), rel: PRD, damage: ["modified"], restored: true }]);
    expect(warnings[0]?.message).toBe(`US-002 implementer turn 3: ${PRD} modified by the agent; restored`);
    expect(Object.keys(warnings[0]?.data ?? {})[0]).toBe("storyId");
  });

  test("recreates a deleted feature directory", async () => {
    rmSync(join(dir, ".nax/features/f"), { recursive: true, force: true });
    const records = await repairRunState(ctx);
    expect(records[0]?.damage).toEqual(["missing"]);
    expect(await Bun.file(join(dir, PRD)).text()).toBe(NAX_PRD);
  });

  test("clears skip-worktree on a tracked file", async () => {
    await git("update-index", "--skip-worktree", PRD);
    const records = await repairRunState(ctx);
    expect(records[0]?.damage).toEqual(["hidden"]);
    expect(await git("ls-files", "-v", "--", PRD)).toMatch(/^H /);
  });

  test("an intact file is not reported", async () => {
    expect(await repairRunState(ctx)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("a file being written by nax is skipped", async () => {
    const keeper = activeKeepers()[0];
    keeper?.begin(join(dir, PRD));
    await git("checkout", "--", PRD);
    expect(await repairRunState(ctx)).toEqual([]);
    keeper?.end(join(dir, PRD));
  });

  test("defers restoring a workflow result until the handoff lock is released", async () => {
    const path = join(workflowRunDir(dir, "f", "r1"), "result.json");
    await naxWrite(path, '{"runId":"r1"}');
    rmSync(path);
    const lockPath = handoffLockPath(workflowFeatureDir(dir, "f"));
    await withFileLock(
      lockPath,
      async () => {
        expect(await repairRunState(ctx)).toMatchObject([{ path, damage: ["missing"], restored: false }]);
        expect(await Bun.file(path).exists()).toBe(false);
      },
      { lockName: "handoff", errorPrefix: "[test]" },
    );
    expect(await repairRunState(ctx)).toMatchObject([{ path, restored: true }]);
    expect(await Bun.file(path).text()).toBe('{"runId":"r1"}');
  });

  test.each(["missing", "modified"] as const)(
    "a queued checkpoint write preserves stories and preflight totals after repair defers (%s)",
    async (damage) => {
      const runDir = workflowRunDir(dir, "f", "r1");
      const header = { runId: "r1", feature: "f" };
      const story = newStoryRecord("US-001", 5, "t");
      const preflightTokensByRole = { advisor: { inputTokens: 20, outputTokens: 10, costUsd: 0.01, calls: 1 } };
      await writePreflightTokens(runDir, header, preflightTokensByRole);
      await upsertStoryRecord(runDir, header, story);
      const path = join(runDir, "result.json");

      const waiting = Promise.withResolvers<string>();
      const sleep = _fileLockDeps.sleep;
      _fileLockDeps.sleep = (ms, signal) => {
        waiting.resolve("waiting");
        return sleep(ms, signal);
      };
      const record = newFeatureRecord({ now: "t", seed: "s", minors: [] });
      let write: Promise<void> | undefined;
      try {
        await withFileLock(
          handoffLockPath(workflowFeatureDir(dir, "f")),
          async () => {
            if (damage === "missing") rmSync(path);
            else await Bun.write(path, JSON.stringify({ schemaVersion: 1, ...header, stories: {} }));
            expect(await repairRunState(ctx)).toMatchObject([{ path, damage: [damage], restored: false }]);
            write = upsertFeatureRecord(runDir, header, record);
            expect(await Promise.race([waiting.promise, write.then(() => "written")])).toBe("waiting");
          },
          { lockName: "handoff", errorPrefix: "[test]" },
        );
      } finally {
        await write;
      }
      expect(await readResult(runDir)).toMatchObject({
        stories: { [story.storyId]: story },
        preflightTokensByRole,
        featureWorkflow: record,
      });
      expect(await repairRunState({ trigger: "run-end", workdir: dir })).toEqual([]);
    },
  );

  test("a turn repair inside the publisher's own lock restores the checkpoint before its next write", async () => {
    // A publish-only run holds the handoff lock across its workflow, CI-repair turns included. A repair
    // at the end of such a turn runs inside that hold: it must restore, not defer, or the publisher's
    // next write reads the damaged stories and keeps them as its own.
    const runDir = workflowRunDir(dir, "f", "r1");
    const header = { runId: "r1", feature: "f" };
    await upsertStoryRecord(runDir, header, newStoryRecord("US-001", 5, "t"));
    const path = join(runDir, "result.json");
    const kept = await Bun.file(path).text();

    await withLockedFeatureResult({ ...header, runDir }, async (write) => {
      const damaged = JSON.parse(kept);
      damaged.stories["US-001"].phase = "done";
      await Bun.write(path, JSON.stringify(damaged));
      expect(await repairRunState(ctx)).toMatchObject([{ path, damage: ["modified"], restored: true }]);
      await write(newFeatureRecord({ now: "t", seed: "s", minors: [] }));
    });

    expect((await readResult(runDir))?.stories["US-001"]?.phase).toBe("implement");
  });

  test("a turn repair outside the publisher's call tree still defers to its hold", async () => {
    // Same process, not a descendant of the holder: another chat job must not be treated as the owner.
    const runDir = workflowRunDir(dir, "f", "r1");
    const header = { runId: "r1", feature: "f" };
    await upsertStoryRecord(runDir, header, newStoryRecord("US-001", 5, "t"));
    const path = join(runDir, "result.json");
    rmSync(path);
    const holding = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const publisher = withLockedFeatureResult({ ...header, runDir }, async () => {
      holding.resolve();
      await release.promise;
    });
    try {
      await holding.promise;
      expect(await repairRunState(ctx)).toMatchObject([{ path, damage: ["missing"], restored: false }]);
      expect(await Bun.file(path).exists()).toBe(false);
    } finally {
      release.resolve();
      await publisher;
    }
  });

  test("run-end defers a missing checkpoint to the next handoff-lock holder", async () => {
    const runDir = workflowRunDir(dir, "f", "r1");
    const path = join(runDir, "result.json");
    const ledger = join(runDir, "ledger.md");
    const content = '{"runId":"r1"}';
    await naxWrite(path, content);
    await naxWrite(ledger, "# Workflow ledger\n");
    rmSync(path);
    const lockPath = handoffLockPath(workflowFeatureDir(dir, "f"));

    await withFileLock(
      lockPath,
      async () => {
        expect(await repairRunState(ctx)).toMatchObject([{ path, restored: false }]);
        // A holder outside this call tree may wait through a whole CI run, so run-end no longer waits
        // for it: the good copy is kept beside the result for the next holder to restore.
        expect(await repairRunState({ trigger: "run-end", workdir: dir })).toMatchObject([
          { path, damage: ["missing"], restored: false },
        ]);
        expect(await Bun.file(ledger).text()).toBe("# Workflow ledger\n");
        expect(await Bun.file(path).exists()).toBe(false);
        expect(JSON.parse(await Bun.file(join(runDir, "result.recovery.json")).text())).toMatchObject({
          schemaVersion: 1,
          rel: ".nax/features/f/workflow/r1/result.json",
          damaged: { kind: "missing" },
          content,
        });
      },
      { lockName: "handoff", errorPrefix: "[test]" },
    );
  });

  test("a workflow ledger tracked under the root gets one repair line", async () => {
    const ledger = join(dir, ".nax/features/f/workflow/run-1/ledger.md");
    mkdirSync(join(dir, ".nax/features/f/workflow/run-1"), { recursive: true });
    await naxWrite(ledger, "# Workflow ledger\n");
    await git("checkout", "--", PRD);
    await repairRunState(ctx);
    expect(await Bun.file(ledger).text()).toBe(`# Workflow ledger\nUS-002: run-state repaired: ${PRD} (modified)\n`);
    expect(await repairRunState(ctx)).toEqual([]); // the ledger line is nax's own write, never flagged
  });

  test("a nax write recorded while the repair awaits git is not reverted", async () => {
    const origHidden = _repairDeps.hiddenNaxPaths;
    _repairDeps.hiddenNaxPaths = async (workdir, logger) => {
      await naxWrite(join(dir, PRD), '{"stories":"newer"}');
      return origHidden(workdir, logger);
    };
    const records = await repairRunState(ctx);
    _repairDeps.hiddenNaxPaths = origHidden;
    expect(records).toEqual([]);
    expect(await Bun.file(join(dir, PRD)).text()).toBe('{"stories":"newer"}');
  });

  test("a hidden file whose flag could not be cleared is not reported restored", async () => {
    await git("update-index", "--skip-worktree", PRD);
    const origClear = _repairDeps.clearNaxIndexFlags;
    _repairDeps.clearNaxIndexFlags = async () => [];
    const records = await repairRunState(ctx);
    _repairDeps.clearNaxIndexFlags = origClear;
    expect(records[0]?.restored).toBe(false);
  });

  test("a failing ledger note keeps the repair records", async () => {
    const ledger = join(dir, ".nax/features/f/workflow/run-1/ledger.md");
    mkdirSync(join(dir, ".nax/features/f/workflow/run-1"), { recursive: true });
    await naxWrite(ledger, "# Workflow ledger\n");
    rmSync(join(dir, ".nax/features/f/workflow"), { recursive: true, force: true });
    writeFileSync(join(dir, ".nax/features/f/workflow"), "not a directory");
    await git("checkout", "--", PRD);
    const records = await repairRunState(ctx);
    expect(records.some((r) => r.rel === PRD && r.restored)).toBe(true);
  });

  test("never rejects when git fails; falls back to the flag sweep with no keeper", async () => {
    const origHidden = _repairDeps.hiddenNaxPaths;
    _repairDeps.hiddenNaxPaths = async () => {
      throw new Error("git gone");
    };
    await expect(repairRunState(ctx)).resolves.toEqual([]);
    _repairDeps.hiddenNaxPaths = origHidden;

    handle?.deactivate();
    const swept: string[] = [];
    const origClear = _repairDeps.clearNaxIndexFlags;
    _repairDeps.clearNaxIndexFlags = async (workdir) => {
      swept.push(workdir);
      return [];
    };
    await repairRunState({ trigger: "run-end", workdir: dir });
    _repairDeps.clearNaxIndexFlags = origClear;
    expect(swept).toEqual([dir]);
  });

  describe("the .nax flag sweep with a keeper active (#2490)", () => {
    const SPEC = ".nax/features/f/spec.md";
    async function hideSpec(): Promise<void> {
      writeFileSync(join(dir, SPEC), "spec");
      await git("add", "-f", SPEC);
      await git("commit", "-q", "-m", "spec");
      await git("update-index", "--skip-worktree", SPEC);
    }
    const tag = async (): Promise<string> => (await git("ls-files", "-v", "--", SPEC)).slice(0, 2);

    test("run-end clears flags on files the keeper does not hold", async () => {
      await hideSpec();
      expect(await tag()).toBe("S ");
      await repairRunState({ trigger: "run-end", workdir: dir });
      expect(await tag()).toBe("H ");
    });

    test("crash clears them too", async () => {
      await hideSpec();
      await repairRunState({ trigger: "crash", workdir: dir });
      expect(await tag()).toBe("H ");
    });

    test("a turn repair leaves them (scope of the per-turn check)", async () => {
      await hideSpec();
      await repairRunState({ trigger: "turn", workdir: dir });
      expect(await tag()).toBe("S ");
    });
  });
});
