/**
 * repair.ts — deferring a damaged workflow result to the next handoff-lock holder (#2984).
 *
 * A holder outside the run's call tree — a chat chain job publishing the same feature, another process —
 * can hold the feature's handoff lock through a whole CI wait, so a run-end or crash repair no longer
 * waits for it: it keeps the good copy in `result.recovery.json` beside the result, and the next holder
 * of that lock restores it. These cases drive `repairRunState` against a real temp repository with the
 * lock held by the test itself (no publisher in the call tree), and read what the repair left behind.
 *
 * The post-release half lives in the second describe: `withResultLock` (a result writer) and a later turn
 * repair both take the lock as ordinary callers, so the recovery file is applied there.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _fileLockDeps, NaxError, withFileLock } from "@nathapp/nax-agent/internal";
import { cleanupTempDir, makeTempDir, withDepsRestore } from "@test/helpers";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import {
  _repairDeps,
  activateRunState,
  activeKeepers,
  type RepairRecord,
  type RepairTrigger,
  type RunStateHandle,
  repairRunState,
  unregisterKeeper,
} from "@/runstate";
import { runStateWrite } from "@/runstate/store";
import { gitWithTimeout } from "@/utils/git";
import { handoffLockPath, workflowFeatureDir, workflowRunDir } from "@/workflow/paths";
import { newStoryRecord, readResult, upsertStoryRecord, withLockedFeatureResult } from "@/workflow/result";
import { _resultRecoveryDeps, RESULT_RECOVERY_FILE } from "@/workflow/result-recovery";

withDepsRestore(_fileLockDeps);
withDepsRestore(_resultRecoveryDeps);

const FEATURE = "f";
const RUN = "r1";
const PRD = `.nax/features/${FEATURE}/prd.json`;
const NAX_PRD = '{"stories":"nax"}';
/** What nax last wrote for the run's result: the good copy every deferral must preserve. */
const KEPT = '{"schemaVersion":1,"runId":"r1","stories":{"US-001":{"storyId":"US-001"}}}\n';
/** Bytes an agent left on disk in place of the kept result. */
const DAMAGED = '{"schemaVersion":1,"runId":"r1","stories":{}}\n';
/** The result's path relative to the repository root, as `KeptFile.rel` spells it. */
const REL = `.nax/features/${FEATURE}/workflow/${RUN}/result.json`;

/** A turn repair's context: a story's implementer turn, which keeps its keeper. */
const TURN = { trigger: "turn" as const, storyId: "US-002", sessionName: "s1", stage: "implementer", turn: 3 };

let dir: string;
let handle: RunStateHandle | undefined;
let runDir: string;
let resultPath: string;
let recoveryPath: string;
let lockPath: string;
const warnings: { stage: string; message: string; data?: Record<string, unknown> }[] = [];
const origLogger = _repairDeps.logger;

async function git(...args: string[]): Promise<string> {
  return (await gitWithTimeout(args, dir)).stdout;
}

/** nax's own write: recorded by the keeper, which is what a repair restores from. */
async function naxWrite(path: string, content: string): Promise<void> {
  await runStateWrite(path, { content }, async () => {
    await Bun.write(path, content);
  });
}

/** Hold the feature's handoff lock as a holder outside the run's call tree, and run `task` under it. */
async function whileHeld<T>(task: () => Promise<T>): Promise<T> {
  return await withFileLock(lockPath, task, { lockName: "handoff", errorPrefix: "[test]" });
}

/** Damage the kept result, then repair it at `trigger` while the lock is held. */
async function damageThenRepair(
  trigger: RepairTrigger,
  damage: "missing" | "modified" = "missing",
): Promise<readonly RepairRecord[]> {
  return await whileHeld(async () => {
    if (damage === "missing") rmSync(resultPath);
    else await Bun.write(resultPath, DAMAGED);
    return await repairRunState({ trigger, workdir: dir });
  });
}

/** The recovery file the deferral left, parsed. */
async function recoveryFile(): Promise<Record<string, unknown>> {
  return JSON.parse(await Bun.file(recoveryPath).text());
}

/** The warnings that name the result under test, which is what AC-9 and AC-19 bound. */
function warningsAboutResult(): { stage: string; message: string; data?: Record<string, unknown> }[] {
  return warnings.filter((warning) => warning.message.includes(REL));
}

function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

beforeEach(async () => {
  dir = makeTempDir("nax-repair-recovery-");
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "t@example.com"],
    ["config", "user.name", "t"],
  ])
    await git(...args);
  mkdirSync(join(dir, ".nax", "features", FEATURE), { recursive: true });
  writeFileSync(join(dir, PRD), '{"stories":"seed"}');
  await git("add", "-A");
  await git("commit", "-q", "-m", "seed");
  // The recovery module logs through the project logger; the repair's own lines go through the stub.
  resetLogger();
  initLogger({ level: "silent" });
  _repairDeps.logger = () => ({
    warn: (stage: string, message: string, data?: Record<string, unknown>) => warnings.push({ stage, message, data }),
  });
  handle = await activateRunState({ runId: RUN, feature: FEATURE, root: dir });
  await naxWrite(join(dir, PRD), NAX_PRD);
  runDir = workflowRunDir(dir, FEATURE, RUN);
  resultPath = join(runDir, "result.json");
  recoveryPath = join(runDir, RESULT_RECOVERY_FILE);
  lockPath = handoffLockPath(workflowFeatureDir(dir, FEATURE));
  await naxWrite(resultPath, KEPT);
});

afterEach(() => {
  handle?.deactivate();
  handle = undefined;
  for (const keeper of activeKeepers()) unregisterKeeper(keeper);
  _repairDeps.logger = origLogger;
  resetLogger();
  warnings.length = 0;
  cleanupTempDir(dir);
});

describe("repairRunState — a damaged result under a handoff lock held outside the run", () => {
  test("a run-end repair defers a missing result without waiting for the lock (AC-1)", async () => {
    const sleeps: number[] = [];
    const sleep = _fileLockDeps.sleep;
    _fileLockDeps.sleep = async (ms) => {
      sleeps.push(ms);
    };

    const records = await damageThenRepair("run-end");
    _fileLockDeps.sleep = sleep;

    expect(records).toMatchObject([{ path: resultPath, rel: REL, damage: ["missing"], restored: false }]);
    // The lock was never waited for: a zero-wait attempt fails on its first create.
    expect(sleeps).toEqual([]);
  });

  test("a run-end repair leaves the missing result missing (AC-2)", async () => {
    await damageThenRepair("run-end");

    expect(await Bun.file(resultPath).exists()).toBe(false);
  });

  test("a run-end repair keeps a missing result's good copy in a version-1 recovery file (AC-3)", async () => {
    await damageThenRepair("run-end");

    expect(await recoveryFile()).toEqual({
      schemaVersion: 1,
      rel: REL,
      damaged: { kind: "missing" },
      content: KEPT,
    });
  });

  test("a run-end repair records the modified bytes' sha256, not the kept text's (AC-4)", async () => {
    const damagedBytes = new TextEncoder().encode(DAMAGED);

    await damageThenRepair("run-end", "modified");

    expect(await recoveryFile()).toEqual({
      schemaVersion: 1,
      rel: REL,
      damaged: { kind: "modified", sha256: sha256Hex(damagedBytes) },
      content: KEPT,
    });
  });

  test("a crash repair defers as a run-end repair does (AC-5)", async () => {
    const records = await damageThenRepair("crash");

    expect(records).toMatchObject([{ rel: REL, restored: false }]);
    expect(await Bun.file(resultPath).exists()).toBe(false);
    expect(await recoveryFile()).toMatchObject({ rel: REL, damaged: { kind: "missing" }, content: KEPT });
  });

  test("an orphaned reclamation claim defers the repair instead of failing it (AC-6)", async () => {
    // An abandoned lock whose claim names a process that is gone: acquisition cannot clear it.
    await Bun.write(lockPath, "4242\n");
    await Bun.write(`${lockPath}.claim`, "4343\n");
    const isPidAlive = _fileLockDeps.isPidAlive;
    _fileLockDeps.isPidAlive = () => false;
    rmSync(resultPath);

    const records = await repairRunState({ trigger: "run-end", workdir: dir });
    _fileLockDeps.isPidAlive = isPidAlive;

    expect(records).toMatchObject([{ path: resultPath, damage: ["missing"], restored: false }]);
    expect(await recoveryFile()).toMatchObject({ rel: REL, damaged: { kind: "missing" }, content: KEPT });
  });

  test("a turn repair writes no recovery file and reports the damage unrestored (AC-7, AC-8)", async () => {
    // A turn keeps its keeper, so the next turn retries: nothing is handed over.
    const records = await damageThenRepair("turn");

    expect(records).toMatchObject([{ rel: REL, damage: ["missing"], restored: false }]);
    expect(await Bun.file(recoveryPath).exists()).toBe(false);
    expect(await Bun.file(resultPath).exists()).toBe(false);
  });

  test("the deferral is one [WARN] naming the result, where the copy went and who restores it (AC-9)", async () => {
    await damageThenRepair("run-end");

    const logged = warningsAboutResult();
    expect(logged).toHaveLength(1);
    expect(logged[0]?.stage).toBe("runstate");
    expect(logged[0]?.message.startsWith("[WARN]")).toBe(true);
    expect(logged[0]?.message).toContain(REL);
    expect(logged[0]?.message).toContain(recoveryPath);
    expect(logged[0]?.message).toContain("next handoff-lock holder restores it");
    expect(Object.keys(logged[0]?.data ?? {})[0]).toBe("storyId");
    expect(logged[0]?.data?.storyId).toBe("_run");
    expect(logged.some((warning) => warning.message.includes("[FAIL]"))).toBe(false);
  });

  test("a recovery write that fails keeps today's not-restored record (AC-10, AC-11)", async () => {
    _resultRecoveryDeps.rename = async () => {
      throw new Error("cannot rename the recovery file");
    };

    const records = await damageThenRepair("run-end");

    expect(records).toMatchObject([{ path: resultPath, rel: REL, damage: ["missing"], restored: false }]);
    const failed = warningsAboutResult().filter((warning) => warning.message.includes("[FAIL]"));
    expect(failed).toHaveLength(1);
    expect(failed[0]?.stage).toBe("runstate");
    expect(failed[0]?.message).toContain(REL);
    expect(failed[0]?.data?.error).toBe("cannot rename the recovery file");
  });

  test("a result that healed before the lock attempt is neither kept nor reported (AC-17)", async () => {
    await whileHeld(async () => {
      await Bun.write(resultPath, DAMAGED);
      // The agent's damage is undone between the damage read and the failed lock attempt: a `link`
      // onto the handoff lock is the first thing that attempt does.
      const link = _fileLockDeps.link;
      let healed = false;
      _fileLockDeps.link = async (from, to) => {
        if (!healed && String(to) === lockPath) {
          healed = true;
          await Bun.write(resultPath, KEPT);
        }
        return link(from, to);
      };
      try {
        expect(await repairRunState({ trigger: "run-end", workdir: dir })).toEqual([]);
      } finally {
        _fileLockDeps.link = link;
      }
    });

    expect(await Bun.file(resultPath).text()).toBe(KEPT);
    expect(await Bun.file(recoveryPath).exists()).toBe(false);
  });

  test("a result this process cannot read is a failed restore, not a missing-damage copy (F1)", async () => {
    await whileHeld(async () => {
      await Bun.write(resultPath, DAMAGED);
      const link = _fileLockDeps.link;
      let revoked = false;
      _fileLockDeps.link = async (from, to) => {
        if (!revoked && String(to) === lockPath) {
          revoked = true;
          // The result is still there with its damaged bytes, but this process may no longer read it.
          // Recording that as absence would hand replay a "missing" copy the next read would discard.
          chmodSync(resultPath, 0o000);
        }
        return link(from, to);
      };
      try {
        expect(await repairRunState({ trigger: "run-end", workdir: dir })).toMatchObject([
          { path: resultPath, rel: REL, damage: ["modified"], restored: false },
        ]);
      } finally {
        _fileLockDeps.link = link;
        chmodSync(resultPath, 0o644);
      }
    });

    expect(await Bun.file(recoveryPath).exists()).toBe(false);
    const failed = warningsAboutResult().filter((warning) => warning.message.includes("[FAIL]"));
    expect(failed).toHaveLength(1);
    expect(failed[0]?.message).toContain(REL);
  });

  const KEPT_FAILURE: [string, () => Promise<void>][] = [
    [
      "a FILE_LOCK_INVALID rejection",
      async () => {
        // The rejection a symlink, FIFO or garbage file at `.handoff.lock` produces. A zero-wait
        // attempt cannot surface it on its own: the deadline is reached before the diagnosis reads
        // the lock, so the diagnosis stays best effort (US-001). The attempt's create is made to
        // raise the very error the lock raises for that file.
        rmSync(resultPath);
        const link = _fileLockDeps.link;
        _fileLockDeps.link = async (from, to) => {
          if (String(to) === lockPath) {
            throw new NaxError(
              "[file-lock] Expected a regular lock file with valid PID metadata",
              "FILE_LOCK_INVALID",
              {
                stage: "file-lock",
                lockPath: String(to),
              },
            );
          }
          return link(from, to);
        };
      },
    ],
    [
      "an unwritable workflow directory",
      async () => {
        rmSync(workflowFeatureDir(dir, FEATURE), { recursive: true, force: true });
        writeFileSync(workflowFeatureDir(dir, FEATURE), "not a directory");
      },
    ],
  ];

  test.each(KEPT_FAILURE)(
    "a run-end repair meets %s and keeps today's failed restore (AC-19)",
    async (_label, breaker) => {
      await breaker();

      const records = await repairRunState({ trigger: "run-end", workdir: dir });

      expect(records).toMatchObject([{ path: resultPath, rel: REL, restored: false }]);
      const failed = warningsAboutResult().filter((warning) => warning.message.includes("[FAIL]"));
      expect(failed).toHaveLength(1);
      expect(failed[0]?.stage).toBe("runstate");
      expect(failed[0]?.message).toContain(REL);
    },
  );
});

describe("repairRunState — the recovery file at the next handoff-lock take", () => {
  test("a result writer restores the kept stories before merging its own (AC-12)", async () => {
    await damageThenRepair("run-end");
    expect(await Bun.file(recoveryPath).exists()).toBe(true);
    // The run is over: without the keeper, the writer's merge can only come from the restored file.
    handle?.deactivate();
    handle = undefined;
    const story = newStoryRecord("US-002", 5, "t");

    await upsertStoryRecord(runDir, { runId: RUN, feature: FEATURE }, story);

    expect(await readResult(runDir)).toMatchObject({
      stories: { "US-001": { storyId: "US-001" }, "US-002": story },
    });
    expect(await Bun.file(recoveryPath).exists()).toBe(false);
  });

  test("a later turn repair restores the kept content and removes the recovery file (AC-13)", async () => {
    await damageThenRepair("run-end");
    expect(await Bun.file(resultPath).exists()).toBe(false);

    expect(await repairRunState(TURN)).toEqual([]);

    expect(await Bun.file(resultPath).text()).toBe(KEPT);
    expect(await Bun.file(recoveryPath).exists()).toBe(false);
  });

  test("a repair inside the publisher's own hold scans once, at its lock-take (AC-18)", async () => {
    // A recovery file this module cannot read: every scan of the workflow directory reports it, so the
    // number of lines naming it is the number of scans. The publisher's own lock-take is the one that
    // must replay pending recoveries; a repair running under that hold already benefits from it.
    const decoyDir = join(workflowFeatureDir(dir, FEATURE), "r0");
    mkdirSync(decoyDir, { recursive: true });
    const decoy = join(decoyDir, RESULT_RECOVERY_FILE);
    await Bun.write(decoy, "{not json");
    const logs: LogEntry[] = [];
    const unlisten = addSink((entry) => logs.push(entry));

    try {
      await withLockedFeatureResult({ runId: RUN, feature: FEATURE, runDir }, async () => {
        await Bun.write(resultPath, DAMAGED);
        expect(await repairRunState(TURN)).toMatchObject([{ path: resultPath, damage: ["modified"], restored: true }]);
      });
    } finally {
      unlisten();
    }

    expect(logs.filter((entry) => entry.message.includes(decoy))).toHaveLength(1);
  });
});
