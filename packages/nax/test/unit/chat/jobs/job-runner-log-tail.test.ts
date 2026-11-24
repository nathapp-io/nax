import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeFakeClock, makeTempDir } from "@test/helpers";
import { JOB_PANEL_LOG_LINES, readJobPanelView } from "@/chat/jobs/job-panel-view";
import { _jobRunnerDeps, createJobRunner, JOB_LOG_TAIL_LINES } from "@/chat/jobs/job-runner";
import { _jobStoreDeps, jobLogPath, writeJobRecord } from "@/chat/jobs/job-store";
import type { ChatJob } from "@/chat/jobs/job-types";
import { _logTailDeps } from "@/chat/jobs/log-tail";

const originalRunner = { ..._jobRunnerDeps };
const originalStore = { ..._jobStoreDeps };
const originalLogTail = { ..._logTailDeps };

let repoRoot: string;
let outputDir: string;
let clock: ReturnType<typeof makeFakeClock>;
let jobs: ReturnType<typeof createJobRunner>;
let job: ChatJob;

beforeEach(async () => {
  repoRoot = makeTempDir("nax-job-log-tail-");
  outputDir = join(repoRoot, "output");
  clock = makeFakeClock();
  Object.assign(_jobRunnerDeps, {
    isProcessAlive: mock(() => true),
    kill: mock(() => true),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
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
    sessionId: "chat",
    argv: [],
    approvedAt: new Date(clock.now()).toISOString(),
    startedAt: new Date(clock.now()).toISOString(),
    logPath: jobLogPath(outputDir, "bot_review-12345678"),
  };
  await writeJobRecord(outputDir, job);
  await jobs.attach();
});

afterEach(() => {
  jobs.dispose();
  Object.assign(_jobRunnerDeps, originalRunner);
  Object.assign(_jobStoreDeps, originalStore);
  Object.assign(_logTailDeps, originalLogTail);
  cleanupTempDir(repoRoot);
});

/** The error a denied read raises; anything but ENOENT has to reach the caller. */
function denied(): Error {
  return Object.assign(new Error("EACCES: permission denied, open 'job.log'"), { code: "EACCES" });
}

describe("logTail", () => {
  test("an attached job is running and readable through its own log", async () => {
    expect(jobs.running()).toEqual([job]);
  });

  test("AC-7 returns the last two lines of a three line log", async () => {
    await Bun.write(job.logPath, "a\nb\nc\n");
    expect(await jobs.logTail(job.id, 2)).toBe("b\nc");
  });

  test("AC-8 defaults to the last JOB_LOG_TAIL_LINES lines", async () => {
    const lines = Array.from({ length: 50 }, (_, index) => String(index));
    await Bun.write(job.logPath, lines.join("\n"));
    expect(JOB_LOG_TAIL_LINES).toBe(40);
    expect(await jobs.logTail(job.id)).toBe(lines.slice(10).join("\n"));
  });

  test("AC-9 a log of one line and three breaks ends in two blank lines", async () => {
    await Bun.write(job.logPath, "a\n\n\n");
    expect(await jobs.logTail(job.id, 2)).toBe("\n");
  });

  test("AC-10 a line count of zero reads nothing", async () => {
    await Bun.write(job.logPath, "a\nb\nc\n");
    expect(await jobs.logTail(job.id, 0)).toBe("");
  });

  test("AC-11 a non-finite line count reads nothing", async () => {
    await Bun.write(job.logPath, "a\nb\nc\n");
    expect(await jobs.logTail(job.id, Number.POSITIVE_INFINITY)).toBe("");
  });

  test("AC-12 a job whose log file is missing reads an empty tail", async () => {
    expect(await jobs.logTail(job.id)).toBe("");
  });

  test("AC-13 a non-empty read skips blank and whitespace-only lines", async () => {
    await Bun.write(job.logPath, "a\n  \nb\n\n\n");
    expect(await jobs.logTail(job.id, 2, { nonEmpty: true })).toBe("a\nb");
  });

  test("AC-16 a denied read rejects rather than reading an empty tail", async () => {
    const failure = denied();
    await Bun.write(job.logPath, "a\nb\n");
    _logTailDeps.readRange = () => Promise.reject(failure);
    await expect(jobs.logTail(job.id)).rejects.toBe(failure);
  });

  test("AC-21 a failing size rejects with that error", async () => {
    const failure = denied();
    _logTailDeps.size = () => Promise.reject(failure);
    await expect(jobs.logTail(job.id)).rejects.toBe(failure);
  });

  test("AC-22 a failing size leaves the panel with no log lines", async () => {
    _logTailDeps.size = () => Promise.reject(denied());
    const view = await readJobPanelView(job, jobs, new Date(clock.now()));
    expect(view.logTail).toEqual([]);
  });
});

describe("readJobPanelView over a real job runner", () => {
  test("AC-14 shows the 12 informative lines a log ends with after 12 blank lines", async () => {
    const informative = Array.from({ length: 12 }, (_, index) => `[nax-jobs] story ${index + 1} passed`);
    await Bun.write(job.logPath, `${informative.join("\n")}\n${"\n".repeat(12)}`);
    const view = await readJobPanelView(job, jobs, new Date(clock.now()));
    expect(JOB_PANEL_LOG_LINES).toBe(12);
    expect(view.logTail).toEqual(informative);
  });

  test("AC-17 a denied read leaves the panel with no log lines", async () => {
    await Bun.write(job.logPath, "a\nb\n");
    _logTailDeps.readRange = () => Promise.reject(denied());
    const view = await readJobPanelView(job, jobs, new Date(clock.now()));
    expect(view.logTail).toEqual([]);
  });
});
