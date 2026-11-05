import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeFakeClock, makeTempDir, waitForCondition } from "@test/helpers";
import { _jobRunnerDeps, type ChatJobs, createJobRunner } from "@/chat/jobs/job-runner";
import { _jobStoreDeps, jobLogPath, writeJobRecord } from "@/chat/jobs/job-store";
import type { ChatJob } from "@/chat/jobs/job-types";
import { featureDir } from "@/config";

const originalDeps = { ..._jobRunnerDeps };
const originalStore = { ..._jobStoreDeps };
let root: string;
let nested: string;
let outputDir: string;
let clock: ReturnType<typeof makeFakeClock>;
let jobs: ChatJobs;

function record(cwd: string, id = "bot_review-12345678"): ChatJob {
  return {
    schemaVersion: 1,
    id,
    kind: "bot_review",
    target: "1",
    cwd,
    pid: 4242,
    state: "succeeded",
    sessionId: "old",
    argv: [],
    approvedAt: "2026-10-01T00:00:00.000Z",
    startedAt: "2026-10-01T00:00:00.000Z",
    logPath: jobLogPath(outputDir, id),
  };
}

beforeEach(() => {
  root = realpathSync(makeTempDir("job-nested-"));
  nested = join(root, "repos", "nax");
  mkdirSync(nested, { recursive: true });
  outputDir = join(root, "output");
  clock = makeFakeClock();
  Object.assign(_jobRunnerDeps, {
    isProcessAlive: mock(() => true),
    kill: mock(() => true),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    spawn: mock(() => ({ pid: 4242, exited: new Promise<number>(() => {}), unref() {} })),
    openLog: mock(() => 73),
    closeLog: mock(() => {}),
  });
  jobs = createJobRunner({ repoRoot: root, outputDir, now: () => new Date(clock.now()) });
});
afterEach(() => {
  jobs.dispose();
  Object.assign(_jobRunnerDeps, originalDeps);
  Object.assign(_jobStoreDeps, originalStore);
  cleanupTempDir(root);
});

const base = {
  kind: "bot_fix",
  target: "1",
  argv: ["x"],
  sessionId: "c",
  approvedAt: "2026-10-01T00:00:00.000Z",
} as const;

describe("job runner cwd", () => {
  test("AC-10 start with cwd spawns there and records it", async () => {
    const job = await jobs.start({ ...base, cwd: nested });
    expect(_jobRunnerDeps.spawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ cwd: nested }));
    expect(job.cwd).toBe(nested);
  });

  test("AC-15 start without cwd uses the runner's repoRoot", async () => {
    const job = await jobs.start({ ...base });
    expect(_jobRunnerDeps.spawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ cwd: root }));
    expect(job.cwd).toBe(root);
  });

  test("AC-11 a finished nested run reads status.json from job.cwd", async () => {
    const exited = Promise.withResolvers<number>();
    _jobRunnerDeps.spawn = mock(() => ({ pid: 4242, exited: exited.promise, unref() {} }));
    const job = await jobs.start({ ...base, kind: "run", target: "f1", cwd: nested });
    await Bun.write(
      join(featureDir(nested, "f1"), "status.json"),
      JSON.stringify({
        version: 1,
        run: { id: "r", pid: 4242, status: "completed" },
        cost: { spent: 2, limit: null },
        progress: { passed: 1, total: 1, failed: 0, pending: 0 },
      }),
    );
    exited.resolve(0);
    await waitForCondition(() => jobs.get(job.id)?.state === "succeeded", 500);
    expect(jobs.get(job.id)?.cost).toBe(2);
  });
});

describe("job runner attach containment", () => {
  test("AC-12 loads a record whose cwd lies inside repoRoot", async () => {
    await writeJobRecord(outputDir, record(nested));
    await jobs.attach();
    expect(jobs.list()).toHaveLength(1);
  });

  test("AC-13 skips a record whose cwd is a sibling of repoRoot", async () => {
    const sibling = `${root}-sibling`;
    mkdirSync(sibling, { recursive: true });
    try {
      await writeJobRecord(outputDir, record(sibling));
      await jobs.attach();
      expect(jobs.list()).toEqual([]);
    } finally {
      cleanupTempDir(sibling);
    }
  });

  test("AC-16 a symlinked repoRoot still loads a nested real cwd", async () => {
    const link = `${root}-link`;
    symlinkSync(root, link);
    try {
      const linked = createJobRunner({ repoRoot: link, outputDir, now: () => new Date(clock.now()) });
      await writeJobRecord(outputDir, record(nested));
      await linked.attach();
      expect(linked.list()).toHaveLength(1);
      linked.dispose();
    } finally {
      cleanupTempDir(link);
    }
  });

  test("AC-19 a record whose cwd vanished is skipped, others still load", async () => {
    await writeJobRecord(outputDir, record(join(root, "gone"), "bot_review-aaaaaaaa"));
    await writeJobRecord(outputDir, record(nested, "bot_review-bbbbbbbb"));
    await jobs.attach();
    expect(jobs.list().map((j) => j.id)).toEqual(["bot_review-bbbbbbbb"]);
  });
});
