import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeFakeClock, makeTempDir, waitForCondition } from "@test/helpers";
import { _jobOutcomeDeps } from "@/chat/jobs/job-outcome";
import { _jobRunnerDeps, CANCEL_GRACE_MS, type ChatJobs, createJobRunner, JOB_POLL_MS } from "@/chat/jobs/job-runner";
import { _jobStoreDeps, jobLogPath, readJobRecords, writeJobRecord } from "@/chat/jobs/job-store";
import type { ChatJob } from "@/chat/jobs/job-types";
import { featureDir } from "@/config";
import { NaxError } from "@/errors";

const original = { ..._jobRunnerDeps };
const originalStore = { ..._jobStoreDeps };
const originalOutcome = { ..._jobOutcomeDeps };
let repoRoot: string;
let outputDir: string;
let clock: ReturnType<typeof makeFakeClock>;
let jobs: ChatJobs;
let alive: boolean;
let exited: ReturnType<typeof Promise.withResolvers<number>>;
beforeEach(() => {
  repoRoot = makeTempDir("job-cancel-");
  outputDir = join(repoRoot, "output");
  clock = makeFakeClock();
  alive = true;
  exited = Promise.withResolvers<number>();
  Object.assign(_jobRunnerDeps, {
    spawn: mock(() => ({ pid: 4242, exited: exited.promise, unref() {} })),
    kill: mock(() => true),
    isProcessAlive: mock(() => alive),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    openLog: mock(() => 73),
    closeLog: mock(() => {}),
  });
  jobs = createJobRunner({ repoRoot, outputDir, now: () => new Date(clock.now()) });
});
afterEach(() => {
  jobs.dispose();
  Object.assign(_jobRunnerDeps, original);
  Object.assign(_jobStoreDeps, originalStore);
  Object.assign(_jobOutcomeDeps, originalOutcome);
  cleanupTempDir(repoRoot);
});
function start() {
  return jobs.start({
    kind: "bot_review",
    target: "1",
    argv: [],
    sessionId: "chat",
    approvedAt: new Date(0).toISOString(),
  });
}
async function attach(kind: ChatJob["kind"] = "bot_review", state: ChatJob["state"] = "running") {
  const id = `${kind}-12345678`;
  const job: ChatJob = {
    schemaVersion: 1,
    id,
    kind,
    state,
    target: "f1",
    cwd: repoRoot,
    pid: 4242,
    sessionId: "old-chat",
    argv: [],
    approvedAt: new Date(0).toISOString(),
    startedAt: new Date(0).toISOString(),
    logPath: jobLogPath(outputDir, id),
  };
  await writeJobRecord(outputDir, job);
  await jobs.attach();
  return job;
}
async function status(pid = 4242) {
  await Bun.write(
    join(featureDir(repoRoot, "f1"), "status.json"),
    JSON.stringify({
      version: 1,
      run: { id: "r1", pid, status: "completed" },
      cost: { spent: 2.5, limit: null },
      progress: { passed: 3, total: 5 },
    }),
  );
}
function unverified(id: string) {
  return `job ${id} was started by another chat and its pid cannot be verified; stop it from that chat or by hand`;
}
describe("createJobRunner cancellation", () => {
  test("AC-1 owned running job can be cancelled without signalling", async () => {
    const job = await start();
    expect(await jobs.canCancel(job.id)).toEqual({ ok: true });
    expect(_jobRunnerDeps.kill).not.toHaveBeenCalled();
  });
  test("AC-2,3 persists intent before sending SIGINT", async () => {
    const job = await start();
    let atKill: Promise<ChatJob[]> | undefined;
    _jobRunnerDeps.kill = mock(() => {
      atKill = readJobRecords(outputDir);
      return true;
    });
    const result = await jobs.cancel(job.id);
    expect(_jobRunnerDeps.kill).toHaveBeenCalledWith(job.pid, "SIGINT");
    expect(await atKill).toMatchObject([{ id: job.id, cancelRequested: true }]);
    expect(result).toMatchObject({ id: job.id, state: "running", cancelRequested: true });
  });
  test.each([true, false])("AC-4,5 escalation only for a live pid (alive=%s)", async (isAlive) => {
    const job = await start();
    await jobs.cancel(job.id);
    alive = isAlive;
    await clock.advance(CANCEL_GRACE_MS - 1);
    expect(_jobRunnerDeps.kill).toHaveBeenCalledTimes(1);
    await clock.advance(1);
    expect(_jobRunnerDeps.kill).toHaveBeenCalledTimes(isAlive ? 2 : 1);
    if (isAlive) expect(_jobRunnerDeps.kill).toHaveBeenLastCalledWith(job.pid, "SIGTERM");
  });
  test("AC-6 child exit after cancellation finalizes cancelled and clears timers", async () => {
    const job = await start();
    await jobs.cancel(job.id);
    exited.resolve(0);
    await waitForCondition(() => jobs.get(job.id)?.state === "cancelled", 500);
    expect((await readJobRecords(outputDir))[0]).toMatchObject({ state: "cancelled", cancelRequested: true });
    expect(clock.pending()).toBe(0);
  });
  test("F1 observed child exit stops escalation while outcome resolution is pending", async () => {
    const job = await jobs.start({
      kind: "run",
      target: "f1",
      argv: [],
      sessionId: "chat",
      approvedAt: new Date(0).toISOString(),
    });
    await jobs.cancel(job.id);
    const outcome = Promise.withResolvers<null>();
    let reading = false;
    _jobOutcomeDeps.readStatusFile = () => {
      reading = true;
      return outcome.promise;
    };
    exited.resolve(0);
    await waitForCondition(() => reading, 500);
    try {
      // A recycled PID can appear alive even though this child has already exited.
      expect(jobs.get(job.id)?.state).toBe("running");
      await clock.advance(CANCEL_GRACE_MS);
      expect(_jobRunnerDeps.kill).toHaveBeenCalledTimes(1);
      expect(_jobRunnerDeps.kill).toHaveBeenLastCalledWith(job.pid, "SIGINT");
    } finally {
      outcome.resolve(null);
      await waitForCondition(() => jobs.get(job.id)?.state === "cancelled", 500);
    }
    expect(clock.pending()).toBe(0);
  });
  test("AC-7 succeeded job cannot be cancelled", async () => {
    const job = await attach("bot_review", "succeeded");
    expect(await jobs.canCancel(job.id)).toEqual({
      ok: false,
      message: `job ${job.id} is not running (state succeeded)`,
    });
  });
  test("AC-8 succeeded cancellation rejects a chat NaxError", async () => {
    const job = await attach("bot_review", "succeeded");
    const error = await jobs.cancel(job.id).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(NaxError);
    expect(error).toMatchObject({ code: "CHAT_JOB_NOT_RUNNING", context: { stage: "chat" } });
    expect(_jobRunnerDeps.kill).not.toHaveBeenCalled();
  });
  test("AC-9 dead-pid SIGINT failure does not reject cancellation", async () => {
    const job = await start();
    _jobRunnerDeps.kill = mock(() => {
      throw new NaxError("dead", "ESRCH", { stage: "test" });
    });
    expect(await jobs.cancel(job.id)).toMatchObject({ cancelRequested: true });
    expect(_jobRunnerDeps.kill).toHaveBeenCalledWith(job.pid, "SIGINT");
  });
  test("AC-10 attached bot is unverified", async () => {
    const job = await attach();
    expect(await jobs.canCancel(job.id)).toEqual({ ok: false, message: unverified(job.id) });
  });
  test("AC-11,12 unverified cancellation rejects without signalling or saving intent", async () => {
    const job = await attach();
    const error = await jobs.cancel(job.id).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(NaxError);
    expect(error).toMatchObject({ code: "CHAT_JOB_UNVERIFIED", context: { stage: "chat" } });
    expect(_jobRunnerDeps.kill).not.toHaveBeenCalled();
    expect((await readJobRecords(outputDir))[0]?.cancelRequested).toBeUndefined();
  });
  test("AC-13 fixture PID verifies attached run without signalling", async () => {
    await status();
    const job = await attach("run");
    expect(jobs.owned()).toEqual([]);
    expect(await jobs.canCancel(job.id)).toEqual({ ok: true });
    expect(_jobRunnerDeps.kill).not.toHaveBeenCalled();
  });
  test("AC-14 verified attached run receives SIGINT and preserves metrics on cancelled outcome", async () => {
    await status();
    const job = await attach("run");
    await jobs.cancel(job.id);
    expect(_jobRunnerDeps.kill).toHaveBeenCalledWith(job.pid, "SIGINT");
    alive = false;
    await clock.advance(JOB_POLL_MS);
    await waitForCondition(() => jobs.get(job.id)?.state === "cancelled", 500);
    expect(jobs.get(job.id)).toMatchObject({ state: "cancelled", cost: 2.5, progress: { passed: 3, total: 5 } });
  });
  test("AC-15 dispose clears grace timer and never signals again", async () => {
    const job = await start();
    await jobs.cancel(job.id);
    expect(clock.pending()).toBe(2);
    jobs.dispose();
    expect(clock.pending()).toBe(0);
    await clock.advance(CANCEL_GRACE_MS);
    expect(_jobRunnerDeps.kill).toHaveBeenCalledTimes(1);
  });
  test("exit already resolving cannot be overwritten by a concurrent cancel", async () => {
    const job = await jobs.start({
      kind: "run",
      target: "f1",
      argv: [],
      sessionId: "chat",
      approvedAt: new Date(0).toISOString(),
    });
    const outcome = Promise.withResolvers<null>();
    let reading = false;
    _jobOutcomeDeps.readStatusFile = () => {
      reading = true;
      return outcome.promise;
    };
    exited.resolve(0);
    await waitForCondition(() => reading, 500);
    const cancellation = jobs.cancel(job.id).catch((cause: unknown) => cause);
    outcome.resolve(null);
    expect(await cancellation).toMatchObject({ code: "CHAT_JOB_NOT_RUNNING" });
    expect(jobs.get(job.id)?.state).toBe("failed");
    expect(_jobRunnerDeps.kill).not.toHaveBeenCalled();
  });
  test("record write failure prevents signalling and arming grace", async () => {
    const job = await start();
    _jobStoreDeps.write = mock(() => {
      throw new NaxError("disk full", "ENOSPC", { stage: "test" });
    });
    await expect(jobs.cancel(job.id)).rejects.toMatchObject({ code: "CHAT_JOB_WRITE_FAILED" });
    expect(_jobRunnerDeps.kill).not.toHaveBeenCalled();
    expect(jobs.get(job.id)?.cancelRequested).toBeUndefined();
    expect(clock.pending()).toBe(1);
  });
  test("repeated requests keep only one grace timer and tolerate a late SIGTERM failure", async () => {
    const job = await start();
    await jobs.cancel(job.id);
    await jobs.cancel(job.id);
    expect(clock.pending()).toBe(2);
    _jobRunnerDeps.kill = mock(() => {
      throw new NaxError("dead", "ESRCH", { stage: "test" });
    });
    await clock.advance(CANCEL_GRACE_MS);
    expect(_jobRunnerDeps.kill).toHaveBeenCalledTimes(1);
  });
  test.each(["missing", "mismatched"])("attached run with %s status cannot signal", async (fixture) => {
    if (fixture === "mismatched") await status(1);
    const job = await attach("run");
    expect(await jobs.canCancel(job.id)).toEqual({ ok: false, message: unverified(job.id) });
    await expect(jobs.cancel(job.id)).rejects.toMatchObject({ code: "CHAT_JOB_UNVERIFIED" });
    expect(_jobRunnerDeps.kill).not.toHaveBeenCalled();
  });
});
