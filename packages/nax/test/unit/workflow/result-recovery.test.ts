import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { stat, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { _fileLockDeps } from "@nathapp/nax-agent/internal";
import { cleanupTempDir, makeTempDir, withDepsRestore } from "@test/helpers";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { activateRunState, type RunStateHandle, repairRunState } from "@/runstate";
import { runStateWrite } from "@/runstate/store";
import { HANDOFF_MARK_FILE, readNewestHandoffMark } from "@/workflow/handoff-mark";
import { runDirsNewestFirst } from "@/workflow/result";
import {
  _resultRecoveryDeps,
  RESULT_RECOVERY_FILE,
  type ResultRecovery,
  restorePendingResults,
  writeResultRecovery,
} from "@/workflow/result-recovery";

withDepsRestore(_fileLockDeps);
withDepsRestore(_resultRecoveryDeps);

const RUN = "r1";
const REL = `.nax/features/f/workflow/${RUN}/result.json`;
const LEDGER = "# Workflow ledger — run: r1 — feature: f\n";
const RESULT_TEXT = '{"schemaVersion":1,"runId":"r1","stories":{}}\n';
const RECOVERED_TEXT = '{"schemaVersion":1,"runId":"r1","stories":{"US-001":{"storyId":"US-001"}}}\n';

let dir: string;
let workflowDir: string;
let handle: RunStateHandle | undefined;
let logs: LogEntry[] = [];
let unlisten: (() => void) | undefined;

interface RunPaths {
  readonly runDir: string;
  readonly resultPath: string;
  readonly recoveryPath: string;
  readonly ledgerPath: string;
}

function sha256Of(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function missingRecovery(content: string = RECOVERED_TEXT): ResultRecovery {
  return { schemaVersion: 1, rel: REL, damaged: { kind: "missing" }, content };
}

function modifiedRecovery(sha256: string, content: string = RECOVERED_TEXT): ResultRecovery {
  return { schemaVersion: 1, rel: REL, damaged: { kind: "modified", sha256 }, content };
}

interface SeedInput {
  readonly run?: string;
  readonly resultText?: string;
  readonly recovery?: ResultRecovery;
  /** A recovery file written verbatim, for bodies that are not a `ResultRecovery` (AC-4). */
  readonly recoveryText?: string;
  readonly ledger?: string;
}

/** One run directory under the workflow dir, with whichever of its files the case needs. */
async function seedRun(input: SeedInput = {}): Promise<RunPaths> {
  const runDir = join(workflowDir, input.run ?? RUN);
  mkdirSync(runDir, { recursive: true });
  const paths: RunPaths = {
    runDir,
    resultPath: join(runDir, "result.json"),
    recoveryPath: join(runDir, RESULT_RECOVERY_FILE),
    ledgerPath: join(runDir, "ledger.md"),
  };
  if (input.resultText !== undefined) await Bun.write(paths.resultPath, input.resultText);
  if (input.ledger !== undefined) await Bun.write(paths.ledgerPath, input.ledger);
  const recoveryText =
    input.recoveryText ?? (input.recovery === undefined ? undefined : `${JSON.stringify(input.recovery, null, 2)}\n`);
  if (recoveryText !== undefined) await Bun.write(paths.recoveryPath, recoveryText);
  return paths;
}

/** Every file under `root` with its bytes (or a marker for a directory or a link), to prove nothing moved. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (path: string): void => {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      const stats = lstatSync(child);
      const key = child.slice(root.length);
      if (stats.isSymbolicLink()) out[key] = "link";
      else if (stats.isDirectory()) {
        out[key] = "dir";
        walk(child);
      } else out[key] = readFileSync(child, "utf8");
    }
  };
  walk(root);
  return out;
}

/** Replace one filesystem dep of the module under test for the rest of the case. */
function failingRename(onDestination: string, code: string): void {
  const rename = _resultRecoveryDeps.rename;
  _resultRecoveryDeps.rename = async (from, to) => {
    if (String(to) === onDestination) throw Object.assign(new Error(`cannot rename to ${onDestination}`), { code });
    return rename(from, to);
  };
}

/** Create a FIFO at `path`, or report false where the platform has no `mkfifo` (the case is skipped). */
function makeFifo(path: string): boolean {
  return Bun.spawnSync(["mkfifo", path], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

beforeEach(() => {
  dir = makeTempDir("nax-result-recovery-");
  workflowDir = join(dir, "workflow");
  mkdirSync(workflowDir, { recursive: true });
  logs = [];
  resetLogger();
  initLogger({ level: "silent" });
  unlisten = addSink((entry) => logs.push(entry));
});

afterEach(() => {
  unlisten?.();
  unlisten = undefined;
  resetLogger();
  handle?.deactivate();
  handle = undefined;
  cleanupTempDir(dir);
  logs = [];
});

describe("restorePendingResults", () => {
  test("a missing-damage recovery restores the result, drops the recovery file and reports restored (AC-1)", async () => {
    const paths = await seedRun({ recovery: missingRecovery() });

    const outcomes = await restorePendingResults(workflowDir);

    expect(await Bun.file(paths.resultPath).text()).toBe(RECOVERED_TEXT);
    expect(await Bun.file(paths.recoveryPath).exists()).toBe(false);
    expect(outcomes).toEqual([{ kind: "restored", resultPath: paths.resultPath }]);
  });

  test("a modified recovery matching the result's raw bytes rewrites it, drops the file and reports restored (AC-2)", async () => {
    const paths = await seedRun({ resultText: RESULT_TEXT });
    const digest = sha256Of(await Bun.file(paths.resultPath).bytes());
    await Bun.write(paths.recoveryPath, JSON.stringify(modifiedRecovery(digest)));

    const outcomes = await restorePendingResults(workflowDir);

    expect(await Bun.file(paths.resultPath).text()).toBe(RECOVERED_TEXT);
    expect(await Bun.file(paths.recoveryPath).exists()).toBe(false);
    expect(outcomes).toEqual([{ kind: "restored", resultPath: paths.resultPath }]);
  });

  test("a modified recovery whose hash no longer matches leaves the result and reports superseded (AC-3)", async () => {
    const paths = await seedRun({
      resultText: RESULT_TEXT,
      recovery: modifiedRecovery(sha256Of(RECOVERED_TEXT)),
    });

    const outcomes = await restorePendingResults(workflowDir);

    expect(await Bun.file(paths.resultPath).text()).toBe(RESULT_TEXT);
    expect(await Bun.file(paths.recoveryPath).exists()).toBe(false);
    expect(outcomes).toEqual([{ kind: "superseded", resultPath: paths.resultPath }]);
  });

  test("a missing-damage recovery whose result came back leaves the result and reports superseded (AC-3)", async () => {
    const paths = await seedRun({ resultText: RESULT_TEXT, recovery: missingRecovery() });

    const outcomes = await restorePendingResults(workflowDir);

    expect(await Bun.file(paths.resultPath).text()).toBe(RESULT_TEXT);
    expect(await Bun.file(paths.recoveryPath).exists()).toBe(false);
    expect(outcomes).toEqual([{ kind: "superseded", resultPath: paths.resultPath }]);
  });

  const INVALID: [string, string][] = [
    ["invalid JSON", "{not json"],
    [
      "another schema version",
      JSON.stringify({ schemaVersion: 2, rel: REL, damaged: { kind: "missing" }, content: RECOVERED_TEXT }),
    ],
    [
      "a non-string rel",
      JSON.stringify({ schemaVersion: 1, rel: 5, damaged: { kind: "missing" }, content: RECOVERED_TEXT }),
    ],
    ["a non-string content", JSON.stringify({ schemaVersion: 1, rel: REL, damaged: { kind: "missing" }, content: 5 })],
    [
      "an unknown damage kind",
      JSON.stringify({ schemaVersion: 1, rel: REL, damaged: { kind: "hidden" }, content: RECOVERED_TEXT }),
    ],
    ["no damaged field", JSON.stringify({ schemaVersion: 1, rel: REL, content: RECOVERED_TEXT })],
    [
      "a modified damage with a short sha256",
      JSON.stringify({ schemaVersion: 1, rel: REL, damaged: { kind: "modified", sha256: "abc" }, content: "" }),
    ],
    [
      "a modified damage with an uppercase sha256",
      JSON.stringify({
        schemaVersion: 1,
        rel: REL,
        damaged: { kind: "modified", sha256: "A".repeat(64) },
        content: "",
      }),
    ],
    [
      "an ordering time that is not a number",
      JSON.stringify({
        schemaVersion: 1,
        rel: REL,
        damaged: { kind: "missing" },
        content: RECOVERED_TEXT,
        orderedAt: "soon",
      }),
    ],
  ];

  test.each(INVALID)("a recovery with %s is left in place and reports unreadable (AC-4)", async (_label, body) => {
    const paths = await seedRun({ resultText: RESULT_TEXT, recoveryText: body });

    const outcomes = await restorePendingResults(workflowDir);

    expect(outcomes).toEqual([{ kind: "unreadable", recoveryPath: paths.recoveryPath }]);
    expect(await Bun.file(paths.recoveryPath).text()).toBe(body);
    expect(await Bun.file(paths.resultPath).text()).toBe(RESULT_TEXT);
  });

  test.each(["missing", "modified"] as const)(
    "a restored run appends the repair line to its ledger (%s damage) (AC-5)",
    async (damage) => {
      const recovery = damage === "missing" ? missingRecovery() : modifiedRecovery(sha256Of(RESULT_TEXT));
      const paths = await seedRun({
        resultText: damage === "modified" ? RESULT_TEXT : undefined,
        recovery,
        ledger: LEDGER,
      });

      await restorePendingResults(workflowDir);

      expect(await Bun.file(paths.ledgerPath).text()).toBe(`${LEDGER}_run: run-state repaired: ${REL} (${damage})\n`);
    },
  );

  test("a restored run without a ledger does not create one (AC-5)", async () => {
    const paths = await seedRun({ recovery: missingRecovery() });

    await restorePendingResults(workflowDir);

    expect(await Bun.file(paths.ledgerPath).exists()).toBe(false);
  });

  test("a workflow directory with no recovery files yields no outcome and writes nothing (AC-6)", async () => {
    await seedRun({ resultText: RESULT_TEXT, ledger: LEDGER });
    const before = snapshot(dir);

    const outcomes = await restorePendingResults(workflowDir);

    expect(outcomes).toEqual([]);
    expect(snapshot(dir)).toEqual(before);
  });

  test("a regular .handoff.lock is not a run directory, so only the real run reports (AC-8)", async () => {
    const paths = await seedRun({ recovery: missingRecovery() });
    await Bun.write(join(workflowDir, ".handoff.lock"), "");

    const outcomes = await restorePendingResults(workflowDir);

    expect(outcomes).toEqual([{ kind: "restored", resultPath: paths.resultPath }]);
  });

  test("non-directory workflow entries are skipped without a log (AC-9)", async () => {
    const outside = join(dir, "outside");
    mkdirSync(outside, { recursive: true });
    await Bun.write(join(outside, RESULT_RECOVERY_FILE), JSON.stringify(missingRecovery()));
    await Bun.write(join(workflowDir, ".handoff.lock"), "");
    await Bun.write(join(workflowDir, ".handoff.lock.claim"), "");
    symlinkSync(outside, join(workflowDir, "linked"), "dir");

    const outcomes = await restorePendingResults(workflowDir);

    expect(outcomes).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("a run entry that is a symlink is not followed and nothing is written through it (AC-10)", async () => {
    const outside = join(dir, "outside");
    mkdirSync(outside, { recursive: true });
    await Bun.write(join(outside, RESULT_RECOVERY_FILE), JSON.stringify(missingRecovery()));
    symlinkSync(outside, join(workflowDir, RUN), "dir");
    const before = snapshot(dir);

    const outcomes = await restorePendingResults(workflowDir);

    expect(outcomes).toEqual([]);
    expect(snapshot(dir)).toEqual(before);
    expect(await Bun.file(join(outside, "result.json")).exists()).toBe(false);
  });

  test("a missing workflow directory yields no outcome and no log (AC-11)", async () => {
    const outcomes = await restorePendingResults(join(dir, "absent"));

    expect(outcomes).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("a readdir failure is warned about and never thrown (AC-12)", async () => {
    _resultRecoveryDeps.readdir = async () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    };

    await expect(restorePendingResults(workflowDir)).resolves.toEqual([]);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: "warn", stage: "runstate" });
    expect(logs[0]?.message.startsWith("[WARN]")).toBe(true);
    expect(Object.keys(logs[0]?.data ?? {})[0]).toBe("storyId");
    expect(logs[0]?.data?.storyId).toBe("_run");
  });

  test("an unreadable recovery warns with the recovery path and storyId first (AC-15)", async () => {
    const paths = await seedRun({ recoveryText: "{not json" });

    await restorePendingResults(workflowDir);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: "warn", stage: "runstate" });
    expect(logs[0]?.message.startsWith("[WARN]")).toBe(true);
    expect(logs[0]?.message).toContain(paths.recoveryPath);
    expect(Object.keys(logs[0]?.data ?? {})[0]).toBe("storyId");
    expect(logs[0]?.data?.storyId).toBe("_run");
  });

  test("a rename failure keeps that run's recovery file while the other run restores (AC-16)", async () => {
    const first = await seedRun({ run: "r1", recovery: missingRecovery('{"runId":"first"}\n') });
    const second = await seedRun({ run: "r2", recovery: missingRecovery('{"runId":"second"}\n') });
    const firstRecoveryBytes = await Bun.file(first.recoveryPath).text();
    failingRename(first.resultPath, "EXDEV");

    const outcomes = await restorePendingResults(workflowDir);

    expect(await Bun.file(first.recoveryPath).text()).toBe(firstRecoveryBytes);
    expect(outcomes).toHaveLength(2);
    expect(outcomes).toContainEqual({ kind: "failed", recoveryPath: first.recoveryPath });
    expect(outcomes).toContainEqual({ kind: "restored", resultPath: second.resultPath });
  });

  test("a failed write warns for that run and carries on with the rest (AC-17)", async () => {
    const first = await seedRun({ run: "r1", recovery: missingRecovery('{"runId":"first"}\n') });
    const second = await seedRun({ run: "r2", recovery: missingRecovery('{"runId":"second"}\n') });
    failingRename(first.resultPath, "EIO");

    const outcomes = await restorePendingResults(workflowDir);

    expect(outcomes).toContainEqual({ kind: "failed", recoveryPath: first.recoveryPath });
    expect(outcomes).toContainEqual({ kind: "restored", resultPath: second.resultPath });
    const warned = logs.find((entry) => entry.level === "warn" && entry.message.includes(first.recoveryPath));
    expect(warned?.stage).toBe("runstate");
    expect(warned?.message.startsWith("[WARN]")).toBe(true);
    expect(Object.keys(warned?.data ?? {})[0]).toBe("storyId");
    expect(warned?.data?.storyId).toBe("_run");
  });

  test("a recovery file that cannot be read is reported failed while the other run restores (AC-17)", async () => {
    const unreadable = await seedRun({ run: "r1" });
    mkdirSync(unreadable.recoveryPath, { recursive: true });
    const second = await seedRun({ run: "r2", recovery: missingRecovery('{"runId":"second"}\n') });

    const outcomes = await restorePendingResults(workflowDir);

    expect(outcomes).toContainEqual({ kind: "failed", recoveryPath: unreadable.recoveryPath });
    expect(outcomes).toContainEqual({ kind: "restored", resultPath: second.resultPath });
    expect(logs.some((entry) => entry.message.includes(unreadable.recoveryPath))).toBe(true);
  });

  test("a recovery file that cannot be removed still reports the run restored (AC-18)", async () => {
    const paths = await seedRun({ recovery: missingRecovery() });
    _resultRecoveryDeps.unlink = async () => {
      throw Object.assign(new Error("busy"), { code: "EBUSY" });
    };

    const outcomes = await restorePendingResults(workflowDir);

    expect(outcomes).toEqual([{ kind: "restored", resultPath: paths.resultPath }]);
    expect(await Bun.file(paths.recoveryPath).exists()).toBe(true);
  });

  test("a second scan after a failed unlink drops the superseded recovery and keeps the restored bytes (AC-19)", async () => {
    const paths = await seedRun({ recovery: missingRecovery() });
    const unlink = _resultRecoveryDeps.unlink;
    let firstCall = true;
    _resultRecoveryDeps.unlink = async (path) => {
      if (firstCall) {
        firstCall = false;
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      }
      return unlink(path);
    };

    await restorePendingResults(workflowDir);
    const restoredText = await Bun.file(paths.resultPath).text();
    expect(restoredText).toBe(RECOVERED_TEXT);
    expect(await Bun.file(paths.recoveryPath).exists()).toBe(true);

    expect(await restorePendingResults(workflowDir)).toEqual([{ kind: "superseded", resultPath: paths.resultPath }]);
    expect(await Bun.file(paths.recoveryPath).exists()).toBe(false);
    expect(await Bun.file(paths.resultPath).text()).toBe(restoredText);
  });

  test("an active keeper takes the restored result and the ledger line as nax's own writes (AC-7)", async () => {
    const featureDir = join(dir, ".nax", "features", "f");
    const keeperRunDir = join(featureDir, "workflow", RUN);
    mkdirSync(keeperRunDir, { recursive: true });
    const ledgerPath = join(keeperRunDir, "ledger.md");
    const resultPath = join(keeperRunDir, "result.json");
    handle = await activateRunState({ runId: RUN, feature: "f", root: dir });
    await runStateWrite(ledgerPath, { content: LEDGER }, async () => {
      await Bun.write(ledgerPath, LEDGER);
    });
    await Bun.write(join(keeperRunDir, RESULT_RECOVERY_FILE), JSON.stringify(missingRecovery()));

    const outcomes = await restorePendingResults(join(featureDir, "workflow"));
    expect(outcomes).toEqual([{ kind: "restored", resultPath }]);
    expect(await repairRunState({ trigger: "turn" })).toEqual([]);
    expect(await Bun.file(ledgerPath).text()).toBe(`${LEDGER}_run: run-state repaired: ${REL} (missing)\n`);
  });
});

describe("restorePendingResults — a deferral that publishes during a replay (B2)", () => {
  /**
   * A deferral publishes a replacement while a replay is between reading its payload and removing the
   * file. Without a lock of its own that removal takes the replacement too, and a damaged result is left
   * behind with no good copy at all — which is why publication and consumption share the recovery lock.
   */
  async function deferDuringReplay(
    recover: ResultRecovery,
    outcome: "restored" | "superseded",
  ): Promise<{ readonly resultText: string }> {
    const paths = await seedRun({ resultText: RESULT_TEXT, recovery: recover });
    const replacement = missingRecovery('{"runId":"replacement"}\n');
    const lockPath = join(workflowDir, ".result-recovery.lock");
    const unlink = _resultRecoveryDeps.unlink;
    const removing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let deferred = false;
    _resultRecoveryDeps.unlink = async (path) => {
      // The replay has read and applied its payload and is about to remove it, with its lock still held.
      if (!deferred && String(path) === paths.recoveryPath) {
        deferred = true;
        removing.resolve();
        await release.promise;
      }
      return unlink(path);
    };
    try {
      const replay = restorePendingResults(workflowDir);
      await removing.promise;
      // Watch what the deferred write does next: publish over the path (unlocked) or wait for its lock.
      const progressed = Promise.withResolvers<void>();
      const rename = _resultRecoveryDeps.rename;
      _resultRecoveryDeps.rename = async (from, to) => {
        await rename(from, to);
        if (String(to) === paths.recoveryPath) progressed.resolve();
      };
      const link = _fileLockDeps.link;
      _fileLockDeps.link = async (from, to) => {
        try {
          return await link(from, to);
        } finally {
          // An attempt on the lock, whether it wins (no lock held) or loses with EEXIST (waiting).
          if (String(to) === lockPath) progressed.resolve();
        }
      };
      const deferral = writeResultRecovery(paths.resultPath, replacement);
      await progressed.promise;
      release.resolve();
      expect(await replay).toEqual([{ kind: outcome, resultPath: paths.resultPath }]);
      await deferral;
      _resultRecoveryDeps.rename = rename;
      _fileLockDeps.link = link;
    } finally {
      _resultRecoveryDeps.unlink = unlink;
    }
    // The replay removed the payload it consumed, and the deferral's replacement is still there.
    expect(JSON.parse(await Bun.file(paths.recoveryPath).text())).toEqual(replacement);
    return { resultText: await Bun.file(paths.resultPath).text() };
  }

  test("a restore's cleanup removes its own payload and not the replacement (B2)", async () => {
    const seen = await deferDuringReplay(modifiedRecovery(sha256Of(RESULT_TEXT), RECOVERED_TEXT), "restored");

    expect(seen.resultText).toBe(RECOVERED_TEXT);
  });

  test("a supersede's discard removes its own payload and not the replacement (B2)", async () => {
    const seen = await deferDuringReplay(modifiedRecovery(sha256Of(RECOVERED_TEXT), RECOVERED_TEXT), "superseded");

    expect(seen.resultText).toBe(RESULT_TEXT);
  });
});

describe("restorePendingResults — the paths it writes and reads (B3, B5, B6)", () => {
  test("a symlink at the staging name is never written through (B3)", async () => {
    const paths = await seedRun({ recovery: missingRecovery() });
    const outside = join(dir, "outside.json");
    await Bun.write(outside, "untouched\n");
    // The predictable staging name this module used to write: a link there must neither receive the
    // payload nor become the result.
    symlinkSync(outside, `${paths.resultPath}.tmp`);

    const outcomes = await restorePendingResults(workflowDir);

    expect(outcomes).toEqual([{ kind: "restored", resultPath: paths.resultPath }]);
    expect(await Bun.file(outside).text()).toBe("untouched\n");
    expect(lstatSync(paths.resultPath).isFile()).toBe(true);
    expect(await Bun.file(paths.resultPath).text()).toBe(RECOVERED_TEXT);
  });

  test("a restored run keeps its place in the newest-first ordering (B5)", async () => {
    const older = await seedRun({ run: "r1", recovery: { ...missingRecovery(), orderedAt: 1_000 } });
    const newer = await seedRun({ run: "r2", resultText: RESULT_TEXT });
    await utimes(newer.resultPath, 2, 2);

    const outcomes = await restorePendingResults(workflowDir);

    expect(outcomes).toEqual([{ kind: "restored", resultPath: older.resultPath }]);
    // The replay wrote the result now, but the run keeps the ordering time the repair recorded, so the
    // newer run is still the newest — which is what the handoff mark and the publish guards read.
    expect((await stat(older.resultPath)).mtimeMs).toBe(1_000);
    expect(await runDirsNewestFirst(workflowDir)).toEqual([newer.runDir, older.runDir]);
  });

  test("restoring an older run does not hide a newer run's handoff mark (B5)", async () => {
    const older = await seedRun({ run: "r1", recovery: { ...missingRecovery(), orderedAt: 1_000 } });
    const newer = await seedRun({ run: "r2", resultText: RESULT_TEXT });
    const newerMark = join(newer.runDir, HANDOFF_MARK_FILE);
    await utimes(newer.resultPath, 2, 2);
    await Bun.write(newerMark, JSON.stringify({ schemaVersion: 1, at: "T", flowId: "fl1" }));

    expect(await restorePendingResults(workflowDir)).toEqual([{ kind: "restored", resultPath: older.resultPath }]);

    // The publish and handoff guards both read the newest run's mark, so a repair that promoted the
    // older run would let a local publish run beside the publisher koda already owns.
    expect((await readNewestHandoffMark(workflowDir))?.path).toBe(newerMark);
  });

  test("a FIFO in place of the recovery file is a per-run failure, never a wait (B6)", async () => {
    const paths = await seedRun({ resultText: RESULT_TEXT });
    if (!makeFifo(paths.recoveryPath)) return;

    const outcomes = await restorePendingResults(workflowDir);

    expect(outcomes).toEqual([{ kind: "failed", recoveryPath: paths.recoveryPath }]);
    expect(await Bun.file(paths.resultPath).text()).toBe(RESULT_TEXT);
  });

  test("a FIFO in place of the result keeps the good copy and reports the run failed (B6)", async () => {
    const paths = await seedRun({ recovery: missingRecovery() });
    if (!makeFifo(paths.resultPath)) return;

    const outcomes = await restorePendingResults(workflowDir);

    expect(outcomes).toEqual([{ kind: "failed", recoveryPath: paths.recoveryPath }]);
    expect(await Bun.file(paths.recoveryPath).exists()).toBe(true);
  });
});

describe("writeResultRecovery", () => {
  test("writes the recovery beside the result and replaces it on the next write (AC-13)", async () => {
    const resultPath = join(workflowDir, RUN, "result.json");
    const recoveryPath = join(dirname(resultPath), RESULT_RECOVERY_FILE);
    const first = missingRecovery();

    await writeResultRecovery(resultPath, first);
    expect(JSON.parse(await Bun.file(recoveryPath).text())).toEqual(first);

    const second = modifiedRecovery("b".repeat(64), '{"runId":"second"}\n');
    await writeResultRecovery(resultPath, second);
    expect(JSON.parse(await Bun.file(recoveryPath).text())).toEqual(second);
  });

  test("recreates a run directory an agent deleted before writing (AC-14)", async () => {
    const paths = await seedRun({ resultText: RESULT_TEXT });
    rmSync(paths.runDir, { recursive: true, force: true });

    await writeResultRecovery(paths.resultPath, missingRecovery());

    expect(JSON.parse(await Bun.file(paths.recoveryPath).text())).toEqual(missingRecovery());
  });

  test("two writes of the same result path at once each land a whole payload (AC-13)", async () => {
    // Recovery files are written outside the handoff lock, so two runs can write one result path at
    // once. A staging file shared between the two callers would let the second truncate the first's
    // payload; the recovery lock serializes them and each stages a name of its own.
    const resultPath = join(workflowDir, RUN, "result.json");
    const recoveryPath = join(dirname(resultPath), RESULT_RECOVERY_FILE);
    const first = missingRecovery('{"runId":"first"}\n');
    const second = modifiedRecovery("c".repeat(64), '{"runId":"second"}\n');

    const open = _resultRecoveryDeps.open;
    const staged = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let deferFirstOpen = true;
    _resultRecoveryDeps.open = async (path, flags, mode) => {
      if (deferFirstOpen) {
        deferFirstOpen = false;
        staged.resolve();
        await release.promise;
      }
      return open(path, flags, mode);
    };

    try {
      const firstWrite = writeResultRecovery(resultPath, first);
      await staged.promise;
      const secondWrite = writeResultRecovery(resultPath, second);
      release.resolve();
      await firstWrite;
      await secondWrite;
    } finally {
      _resultRecoveryDeps.open = open;
    }

    // The last writer's payload is whole, and neither call left a staging file behind.
    expect(JSON.parse(await Bun.file(recoveryPath).text())).toEqual(second);
    expect(readdirSync(dirname(resultPath))).toEqual([RESULT_RECOVERY_FILE]);
  });

  test("a failed rename removes that write's staging file (AC-13)", async () => {
    const resultPath = join(workflowDir, RUN, "result.json");
    const recoveryPath = join(dirname(resultPath), RESULT_RECOVERY_FILE);
    _resultRecoveryDeps.rename = async () => {
      throw Object.assign(new Error("cannot rename"), { code: "EIO" });
    };

    await expect(writeResultRecovery(resultPath, missingRecovery())).rejects.toThrow("cannot rename");

    expect(await Bun.file(recoveryPath).exists()).toBe(false);
    expect(readdirSync(dirname(resultPath))).toEqual([]);
  });
});
