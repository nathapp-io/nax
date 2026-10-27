import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeFakeClock, makeTempDir, waitForCondition } from "@test/helpers";
import { _jobRunnerDeps, type ChatJobs, createJobRunner, JOB_POLL_MS } from "@/chat/jobs/job-runner";
import { _jobStoreDeps, jobLogPath, readJobRecords, writeJobRecord } from "@/chat/jobs/job-store";
import type { ChatJob } from "@/chat/jobs/job-types";
import { featureDir } from "@/config";

const originalDeps = { ..._jobRunnerDeps };
const originalStore = { ..._jobStoreDeps };
let repoRoot: string;
let outputDir: string;
let clock: ReturnType<typeof makeFakeClock>;
let jobs: ChatJobs;
let alive: boolean;
let job: ChatJob;
beforeEach(() => {
  repoRoot = makeTempDir("job-attach-");
  outputDir = join(repoRoot, "output");
  clock = makeFakeClock();
  alive = true;
  Object.assign(_jobRunnerDeps, {
    isProcessAlive: mock(() => alive),
    kill: mock(() => true),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    spawn: mock(() => ({ pid: 4242, exited: new Promise<number>(() => {}), unref() {} })),
    openLog: mock(() => 73),
    closeLog: mock(() => {}),
  });
  jobs = createJobRunner({ repoRoot, outputDir, now: () => new Date(clock.now()) });
  job = {
    schemaVersion: 1,
    id: "bot_review-12345678",
    kind: "bot_review",
    target: "1",
    cwd: repoRoot,
    pid: 4242,
    state: "running",
    sessionId: "old-chat",
    argv: [],
    approvedAt: new Date(clock.now()).toISOString(),
    startedAt: new Date(clock.now()).toISOString(),
    logPath: jobLogPath(outputDir, "bot_review-12345678"),
  };
});
afterEach(() => {
  jobs.dispose();
  Object.assign(_jobRunnerDeps, originalDeps);
  Object.assign(_jobStoreDeps, originalStore);
  cleanupTempDir(repoRoot);
});
async function status(passed: number, state = "running", cost = 1.5) {
  await Bun.write(
    join(featureDir(repoRoot, job.target), "status.json"),
    JSON.stringify({
      version: 1,
      run: { id: "r1", pid: job.pid, status: state },
      cost: { spent: cost, limit: null },
      progress: { passed, total: 5, failed: 0, pending: 5 - passed },
    }),
  );
}
async function attachLive() {
  await writeJobRecord(outputDir, job);
  await jobs.attach();
  expect(jobs.running()).toEqual([job]);
}
describe("createJobRunner attachment and polling", () => {
  test("AC-1,2 startup dead bot is durably lost without a notice", async () => {
    alive = false;
    await writeJobRecord(outputDir, job);
    await jobs.attach();
    expect(jobs.get(job.id)?.state).toBe("lost");
    expect((await readJobRecords(outputDir))[0]?.state).toBe("lost");
    expect(jobs.takeNotice()).toBeUndefined();
    expect(clock.pending()).toBe(0);
  });
  test("AC-3 startup dead run uses a real matching completed status fixture", async () => {
    job = { ...job, kind: "run", id: "run-12345678", target: "f1" };
    alive = false;
    await status(5, "completed");
    await writeJobRecord(outputDir, job);
    await jobs.attach();
    expect((await readJobRecords(outputDir))[0]).toMatchObject({ state: "succeeded", cost: 1.5 });
    expect(jobs.takeNotice()).toBeUndefined();
  });
  test("AC-4,5 live attachment runs but is not owned", async () => {
    await attachLive();
    expect(jobs.owned()).toEqual([]);
    expect(clock.pending()).toBe(1);
  });
  test("AC-6 ignores other repositories", async () => {
    await writeJobRecord(outputDir, { ...job, cwd: join(repoRoot, "other") });
    await jobs.attach();
    expect(jobs.list()).toEqual([]);
  });
  test("AC-7 finished records are loaded unchanged", async () => {
    job = { ...job, state: "succeeded", endedAt: "2026-10-02T00:00:00Z", note: "owner" };
    await writeJobRecord(outputDir, job);
    await jobs.attach();
    expect(jobs.list()).toEqual([job]);
    expect(jobs.takeNotice()).toBeUndefined();
  });
  test("AC-8 concurrent and repeated attach reads once", async () => {
    await writeJobRecord(outputDir, { ...job, state: "succeeded" });
    _jobStoreDeps.readdir = mock(originalStore.readdir);
    await Promise.all([jobs.attach(), jobs.attach()]);
    await jobs.attach();
    expect(_jobStoreDeps.readdir).toHaveBeenCalledTimes(1);
  });
  test("AC-9,10 poll finalizes a newly dead attached job and queues a notice", async () => {
    await attachLive();
    alive = false;
    await clock.advance(JOB_POLL_MS);
    await waitForCondition(() => jobs.get(job.id)?.state === "lost", 500);
    expect((await readJobRecords(outputDir))[0]?.state).toBe("lost");
    expect(jobs.takeNotice()?.startsWith(`[nax-jobs] job ${job.id}`)).toBe(true);
    expect(clock.pending()).toBe(0);
  });
  test("AC-11,12,13 poll adopts the owner's terminal record without writing or notice", async () => {
    await attachLive();
    const terminal: ChatJob = { ...job, state: "succeeded", exitCode: 0, endedAt: "2026-10-02T00:00:00Z" };
    await writeJobRecord(outputDir, terminal);
    _jobStoreDeps.write = mock(originalStore.write);
    alive = false;
    await clock.advance(JOB_POLL_MS);
    await waitForCondition(() => jobs.get(job.id)?.state === "succeeded", 500);
    expect(jobs.get(job.id)).toEqual(terminal);
    expect(_jobStoreDeps.write).not.toHaveBeenCalled();
    expect(jobs.takeNotice()).toBeUndefined();
  });
  test("AC-14,15 poll refreshes run progress and cost and only emits on changes", async () => {
    job = { ...job, kind: "run", id: "run-12345678", target: "f1" };
    await attachLive();
    const changed = mock(() => {});
    jobs.onChange(changed);
    await status(2);
    await clock.advance(JOB_POLL_MS);
    await waitForCondition(() => jobs.get(job.id)?.progress?.passed === 2, 500);
    expect(jobs.get(job.id)?.progress).toEqual({ passed: 2, total: 5 });
    expect(jobs.get(job.id)?.cost).toBe(1.5);
    expect(changed).toHaveBeenCalledTimes(1);
    await clock.advance(JOB_POLL_MS);
    expect(changed).toHaveBeenCalledTimes(1);
  });
  test("owned run polling emits cost-only changes and preserves refreshed metrics on exit", async () => {
    const exited = Promise.withResolvers<number>();
    _jobRunnerDeps.spawn = mock(() => ({ pid: 4242, exited: exited.promise, unref() {} }));
    job = await jobs.start({ kind: "run", target: "f1", argv: [], sessionId: "chat", approvedAt: job.approvedAt });
    const changed = mock(() => {});
    jobs.onChange(changed);
    await status(2);
    await clock.advance(JOB_POLL_MS);
    await waitForCondition(() => jobs.get(job.id)?.cost === 1.5, 500);
    await status(2, "running", 2.5);
    await clock.advance(JOB_POLL_MS);
    await waitForCondition(() => jobs.get(job.id)?.cost === 2.5, 500);
    expect(changed).toHaveBeenCalledTimes(2);
    // A mismatched later status must not erase the last PID-matched metrics.
    await Bun.write(
      join(featureDir(repoRoot, job.target), "status.json"),
      JSON.stringify({
        version: 1,
        run: { pid: 1, status: "completed" },
      }),
    );
    exited.resolve(1);
    await waitForCondition(() => jobs.get(job.id)?.state === "failed", 500);
    expect((await readJobRecords(outputDir))[0]).toMatchObject({
      cost: 2.5,
      progress: { passed: 2, total: 5 },
      exitCode: 1,
    });
    expect(clock.pending()).toBe(0);
  });
  test("AC-16 no poll is armed without running jobs", async () => {
    await jobs.attach();
    expect(clock.pending()).toBe(0);
  });
  test("AC-17,18 log tails use explicit and default limits ignoring a trailing newline", async () => {
    job = { ...job, state: "succeeded" };
    await writeJobRecord(outputDir, job);
    await jobs.attach();
    await Bun.write(job.logPath, "a\nb\nc\n");
    expect(await jobs.logTail(job.id, 2)).toBe("b\nc");
    const lines = Array.from({ length: 50 }, (_, i) => String(i));
    await Bun.write(job.logPath, lines.join("\n"));
    expect(await jobs.logTail(job.id)).toBe(lines.slice(10).join("\n"));
    expect(await jobs.logTail(job.id, 0)).toBe("");
  });
  test("AC-19 missing logs and unknown ids return empty text", async () => {
    await attachLive();
    expect(await jobs.logTail(job.id)).toBe("");
    expect(await jobs.logTail("unknown")).toBe("");
  });
  test("AC-20,21 dispose clears an owned job poll without killing it", async () => {
    await jobs.start({ kind: "bot_fix", target: "1", argv: [], sessionId: "chat", approvedAt: job.approvedAt });
    expect(clock.pending()).toBe(1);
    jobs.dispose();
    expect(clock.pending()).toBe(0);
    await clock.advance(JOB_POLL_MS * 2);
    expect(clock.pending()).toBe(0);
    expect(_jobRunnerDeps.kill).not.toHaveBeenCalled();
    expect(jobs.owned()).toHaveLength(1);
  });
});
