import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeFakeClock, makeTempDir } from "@test/helpers";
import { _jobRunnerDeps, createJobRunner, type StartJobRequest } from "@/chat/jobs/job-runner";
import { _jobStoreDeps, jobLogPath, jobsDir, readJobRecords } from "@/chat/jobs/job-store";
import { featureDir } from "@/config";
import { NaxError } from "@/errors";

const originalDeps = { ..._jobRunnerDeps };
const originalStoreDeps = { ..._jobStoreDeps };
let repoRoot: string;
let outputDir: string;
let clock: ReturnType<typeof makeFakeClock>;
let exit: (code: number) => void;
let child: { pid: number; exited: Promise<number>; unref: ReturnType<typeof mock> };
const request: StartJobRequest = {
  kind: "run",
  target: "f1",
  argv: ["bun", "nax.js", "run", "-f", "f1", "--headless"],
  sessionId: "chat-1",
  approvedAt: "2026-10-01T00:00:00Z",
};

beforeEach(() => {
  repoRoot = makeTempDir("job-runner-");
  outputDir = join(repoRoot, "output");
  clock = makeFakeClock();
  const deferred = Promise.withResolvers<number>();
  exit = deferred.resolve;
  child = { pid: 4242, exited: deferred.promise, unref: mock(() => {}) };
  Object.assign(_jobRunnerDeps, {
    spawn: mock(() => child),
    kill: mock(() => true),
    isProcessAlive: mock(() => true),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    openLog: mock(() => 73),
    closeLog: mock(() => {}),
  });
});
afterEach(() => {
  Object.assign(_jobRunnerDeps, originalDeps);
  Object.assign(_jobStoreDeps, originalStoreDeps);
  cleanupTempDir(repoRoot);
});
function runner() {
  return createJobRunner({ repoRoot, outputDir, now: () => new Date(clock.now()) });
}

// Wait for the runner's durable terminal notification, not a fixed sleep or microtask count.
function nextChange(jobs: ReturnType<typeof runner>): Promise<void> {
  return new Promise((resolve) => {
    const off = jobs.onChange(() => {
      off();
      resolve();
    });
  });
}

describe("createJobRunner", () => {
  test("AC-1,2,4,5,6,7 spawns detached with one append log fd and closes it in order", async () => {
    const events: string[] = [];
    _jobRunnerDeps.openLog = mock(() => {
      expect(existsSync(jobsDir(outputDir))).toBe(true);
      events.push("open");
      return 73;
    });
    _jobRunnerDeps.spawn = mock(() => {
      events.push("spawn");
      return child;
    });
    _jobRunnerDeps.closeLog = mock(() => {
      events.push("close");
    });
    const job = await runner().start(request);
    expect(_jobRunnerDeps.spawn).toHaveBeenCalledWith(request.argv, {
      cwd: repoRoot,
      detached: true,
      stdin: "ignore",
      stdout: 73,
      stderr: 73,
    });
    expect(_jobRunnerDeps.openLog).toHaveBeenCalledWith(jobLogPath(outputDir, job.id));
    expect(_jobRunnerDeps.closeLog).toHaveBeenCalledWith(73);
    expect(events).toEqual(["open", "spawn", "close"]);
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  test("AC-3,15,17 registers synchronously, persists running identity and emits once", async () => {
    const jobs = runner();
    const changed = mock(() => {});
    jobs.onChange(changed);
    const starting = jobs.start(request);
    expect(jobs.running()).toHaveLength(1);
    const job = await starting;
    const records = await readJobRecords(outputDir);
    expect(records).toHaveLength(1);
    const record = records[0];
    expect({ state: record?.state, pid: record?.pid, sessionId: record?.sessionId }).toEqual({
      state: "running",
      pid: 4242,
      sessionId: "chat-1",
    });
    expect(jobs.owned()).toEqual([job]);
    expect(jobs.get(job.id)).toEqual(job);
    expect(jobs.list()).toEqual([job]);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  test("AC-8,9,19 spawn failures are chat NaxErrors and write no record", async () => {
    _jobRunnerDeps.spawn = mock(() => {
      throw new Error("boom");
    });
    const jobs = runner();
    const changed = mock(() => {});
    jobs.onChange(changed);
    const failure = jobs.start(request);
    await expect(failure).rejects.toBeInstanceOf(NaxError);
    await expect(failure).rejects.toMatchObject({
      message: expect.stringContaining("could not start nax run: boom"),
      code: "CHAT_JOB_SPAWN_FAILED",
      context: expect.objectContaining({ stage: "chat" }),
    });
    expect(await readJobRecords(outputDir)).toEqual([]);
    expect(jobs.running()).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
    expect(_jobRunnerDeps.closeLog).toHaveBeenCalledWith(73);
  });

  test("running-record failure returns an explicitly managed launch, not a retryable spawn failure", async () => {
    _jobStoreDeps.rename = mock(() => {
      throw new Error("disk full");
    });
    const jobs = runner();
    const changed = mock(() => {});
    jobs.onChange(changed);
    const job = await jobs.start({ ...request, kind: "bot_fix" });
    expect(job).toMatchObject({ state: "running", pid: child.pid });
    expect(job.note).toContain("running record could not be saved");
    expect(job.note).toContain("do not retry");
    expect(job.note).toContain("keep this chat open");
    expect(jobs.owned()).toEqual([job]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(_jobRunnerDeps.spawn).toHaveBeenCalledTimes(1);
    expect(_jobRunnerDeps.kill).not.toHaveBeenCalled();
    expect(await readJobRecords(outputDir)).toEqual([]);

    // The exit observer must survive failure of the initial running-record write.
    _jobStoreDeps.rename = originalStoreDeps.rename;
    const ended = nextChange(jobs);
    exit(2);
    await ended;
    expect(await readJobRecords(outputDir)).toEqual([
      expect.objectContaining({ id: job.id, state: "failed", exitCode: 2, endedAt: expect.any(String) }),
    ]);
    expect(jobs.running()).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(jobs.takeNotice()).toContain(`job ${job.id} (bot_fix f1) ended: failed`);
  });

  test("AC-10,11,12,13,14,16,18 owned exit uses matching real status, persists and queues notice", async () => {
    const jobs = runner();
    const changed = mock(() => {});
    jobs.onChange(changed);
    const job = await jobs.start(request);
    await Bun.write(
      join(featureDir(repoRoot, "f1"), "status.json"),
      JSON.stringify({
        version: 1,
        run: { id: "run-1", pid: job.pid, status: "completed" },
        cost: { spent: 1.2, limit: null },
        progress: { passed: 3, total: 7, failed: 1, pending: 3 },
      }),
    );
    const ended = nextChange(jobs);
    exit(0);
    await ended;
    const records = await readJobRecords(outputDir);
    expect(records[0]).toMatchObject({
      state: "succeeded",
      endedAt: new Date(clock.now()).toISOString(),
      exitCode: 0,
      cost: 1.2,
    });
    const notice = jobs.peekNotice();
    expect(notice?.startsWith(`[nax-jobs] job ${job.id} (run f1) ended: succeeded`)).toBe(true);
    expect(jobs.takeNotice()).toBe(notice);
    expect(jobs.takeNotice()).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(jobs.running()).toEqual([]);
    expect(jobs.owned()).toEqual([]);
  });

  test("owner preserves cancellation durably requested by another chat", async () => {
    const jobs = runner();
    const job = await jobs.start(request);
    await Bun.write(
      join(featureDir(repoRoot, "f1"), "status.json"),
      JSON.stringify({
        version: 1,
        run: { id: "run-1", pid: job.pid, status: "completed" },
        cost: { spent: 1.2, limit: null },
        progress: { passed: 3, total: 7, failed: 0, pending: 4 },
      }),
    );
    const attached = runner();
    await attached.attach();
    await attached.cancel(job.id);
    expect((await readJobRecords(outputDir))[0]?.cancelRequested).toBe(true);
    expect(jobs.get(job.id)?.cancelRequested).toBeUndefined();
    const ended = nextChange(jobs);
    exit(0);
    await ended;
    expect((await readJobRecords(outputDir))[0]).toMatchObject({
      state: "cancelled",
      cancelRequested: true,
      exitCode: 0,
      cost: 1.2,
    });
    expect(jobs.takeNotice()).toContain("ended: cancelled");
    attached.dispose();
    jobs.dispose();
  });

  test("terminal write failure releases an exited job and retries without signalling or duplicate notices", async () => {
    const jobs = runner();
    const job = await jobs.start(request);
    _jobStoreDeps.rename = mock(() => {
      throw new Error("transient rename failure");
    });
    const ended = nextChange(jobs);
    exit(7);
    await ended;
    expect(jobs.running()).toEqual([]);
    expect(jobs.owned()).toEqual([]);
    expect(jobs.get(job.id)).toMatchObject({ state: "failed", exitCode: 7, endedAt: expect.any(String) });
    expect(jobs.get(job.id)?.note).toContain("could not be saved");
    expect(jobs.takeNotice()).toContain("could not be saved");
    await expect(jobs.cancel(job.id)).rejects.toMatchObject({ code: "CHAT_JOB_NOT_RUNNING" });
    expect(_jobRunnerDeps.kill).not.toHaveBeenCalled();
    expect((await readJobRecords(outputDir))[0]?.state).toBe("running");
    _jobStoreDeps.rename = originalStoreDeps.rename;
    const saved = nextChange(jobs);
    await clock.advance(2_000);
    await saved;
    expect((await readJobRecords(outputDir))[0]).toMatchObject({ state: "failed", exitCode: 7 });
    expect(jobs.takeNotice()).toBeUndefined();
    expect(clock.pending()).toBe(0);
    jobs.dispose();
  });

  test("immediately exited children finalize after the running write; notices stay FIFO", async () => {
    _jobRunnerDeps.spawn = mock(() => ({ ...child, exited: Promise.resolve(2) }));
    const jobs = runner();
    const firstEnd = nextTerminal(jobs);
    const first = await jobs.start({ ...request, kind: "bot_fix" });
    await firstEnd;
    const secondEnd = nextTerminal(jobs);
    const second = await jobs.start({ ...request, kind: "bot_review" });
    await secondEnd;
    expect((await readJobRecords(outputDir)).every((job) => job.state === "failed" && job.exitCode === 2)).toBe(true);
    expect(jobs.takeNotice()).toContain(first.id);
    expect(jobs.takeNotice()).toContain(second.id);
  });

  test("query results and start results are independent snapshots, sorted newest first", async () => {
    const jobs = runner();
    const first = await jobs.start(request);
    Object.assign(first.argv, { 0: "mutated" });
    expect(jobs.get(first.id)?.argv).toEqual(request.argv);
    await clock.advance(1);
    const second = await jobs.start({ ...request, kind: "bot_review" });
    expect(jobs.list().map((job) => job.id)).toEqual([second.id, first.id]);
    expect(jobs.running().map((job) => job.id)).toEqual([second.id, first.id]);
    const snapshot = jobs.get(first.id);
    if (snapshot) Object.assign(snapshot, { state: "failed" });
    expect(jobs.get(first.id)?.state).toBe("running");
    expect(jobs.get("missing")).toBeUndefined();
  });

  test("missing log is empty and dispose does not signal; unsubscribe removes listener", async () => {
    const jobs = runner();
    const changed = mock(() => {});
    const off = jobs.onChange(changed);
    off();
    const job = await jobs.start(request);
    await jobs.attach();
    expect(await jobs.logTail(job.id)).toBe("");
    jobs.dispose();
    expect(changed).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
    expect(_jobRunnerDeps.kill).not.toHaveBeenCalled();
  });
});

function nextTerminal(jobs: ReturnType<typeof runner>): Promise<void> {
  return new Promise((resolve) => {
    const off = jobs.onChange(() => {
      if (jobs.peekNotice() && jobs.list().every((job) => job.state !== "running")) {
        off();
        resolve();
      }
    });
  });
}
