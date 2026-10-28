import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import type { ChatJob } from "@/chat/jobs/job-types";
import { featureDir } from "@/config/paths";

let repoRoot: string;
beforeEach(() => {
  repoRoot = makeTempDir("job-outcome-");
});
afterEach(() => {
  cleanupTempDir(repoRoot);
});

function job(overrides: Partial<ChatJob> = {}): ChatJob {
  return {
    schemaVersion: 1,
    id: "run-1a2b3c4d",
    kind: "run",
    target: "feature",
    argv: [],
    cwd: repoRoot,
    pid: 4242,
    startedAt: "2026-10-01T00:00:00Z",
    state: "running",
    logPath: join(repoRoot, "job.log"),
    sessionId: "session",
    approvedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}
async function status(runStatus = "completed", pid = 4242): Promise<void> {
  await Bun.write(
    join(featureDir(repoRoot, "feature"), "status.json"),
    JSON.stringify({
      version: 1,
      run: { id: "run-1", pid, status: runStatus },
      cost: { spent: 1.2, limit: null },
      progress: { passed: 3, total: 7, failed: 1, pending: 3 },
    }),
  );
}
async function resolve(overrides: Partial<ChatJob> = {}, exitCode?: number) {
  const { resolveJobOutcome } = await import("@/chat/jobs/job-outcome");
  return resolveJobOutcome(job(overrides), { exitCode }, repoRoot);
}

describe("resolveJobOutcome", () => {
  test("AC-1 matching completed run succeeds", async () => {
    await status();
    expect((await resolve({}, 0)).state).toBe("succeeded");
  });
  test("AC-2 matching run projects cost", async () => {
    await status();
    expect((await resolve({}, 0)).cost).toBe(1.2);
  });
  test("AC-3 matching run projects only passed and total", async () => {
    await status();
    expect((await resolve({}, 0)).progress).toEqual({ passed: 3, total: 7 });
  });
  test.each([
    ["AC-4", "completed", 1, "succeeded", "exit code 1 disagrees with the run record"],
    ["AC-5", "failed", 0, "failed", "run status failed"],
    ["AC-7", "running", 0, "failed", "run status running"],
  ] as const)("%s resolves %s despite exit %s", async (_ac, runStatus, exitCode, state, note) => {
    await status(runStatus);
    expect(await resolve({}, exitCode)).toEqual({ state, note, cost: 1.2, progress: { passed: 3, total: 7 } });
  });
  test("AC-6 aborted run is cancelled", async () => {
    await status("aborted");
    expect((await resolve()).state).toBe("cancelled");
  });
  test("AC-8 rejects a different pid even after exit zero", async () => {
    await status("completed", 1);
    expect(await resolve({}, 0)).toEqual({ state: "failed", note: "no run record for pid 4242; exit code 0" });
  });
  test("AC-9 absent status without exit fails", async () => {
    expect(await resolve()).toEqual({ state: "failed", note: "no run record for pid 4242" });
  });
  test("AC-10 cancellation wins and keeps matching run metrics", async () => {
    await status();
    expect(await resolve({ cancelRequested: true }, 1)).toEqual({
      state: "cancelled",
      cost: 1.2,
      progress: { passed: 3, total: 7 },
    });
  });
  test.each([
    ["AC-11", "2026-10-02T00:00:00Z", { state: "succeeded" }],
    ["AC-12", "2026-09-30T00:00:00Z", { state: "failed", note: "plan wrote no prd.json" }],
    ["timestamp equality", "2026-10-01T00:00:00Z", { state: "succeeded" }],
  ] as const)("%s checks plan prd modification time", async (_ac, modifiedAt, expected) => {
    const path = join(featureDir(repoRoot, "feature"), "prd.json");
    await Bun.write(path, "{}");
    const date = new Date(modifiedAt);
    await utimes(path, date, date);
    expect(await resolve({ kind: "plan" }, 2)).toEqual(expected);
  });
  test("AC-13 missing plan prd fails", async () => {
    expect(await resolve({ kind: "plan" }, 0)).toEqual({ state: "failed", note: "plan wrote no prd.json" });
  });
  test("AC-14 bot fix exit zero succeeds without metrics", async () => {
    expect(await resolve({ kind: "bot_fix" }, 0)).toEqual({ state: "succeeded" });
  });
  test("AC-15 bot review nonzero exit fails", async () => {
    expect(await resolve({ kind: "bot_review" }, 2)).toEqual({ state: "failed", note: "exit code 2" });
  });
  test("AC-16 bot review unobserved exit is lost", async () => {
    expect(await resolve({ kind: "bot_review" })).toEqual({
      state: "lost",
      note: "outcome unknown: exit code not observed",
    });
  });
  test.each(["run", "plan", "bot_review", "bot_fix"] as const)(
    "cancellation wins without records for %s",
    async (kind) => {
      expect(await resolve({ kind, cancelRequested: true }, 2)).toEqual({ state: "cancelled" });
    },
  );
  test("cancelled run does not inherit another pid's metrics", async () => {
    await status("completed", 1);
    expect(await resolve({ cancelRequested: true }, 0)).toEqual({ state: "cancelled" });
  });
});

describe("readRunProgress", () => {
  test("AC-17 projects matching pid metrics", async () => {
    await status();
    const { readRunProgress } = await import("@/chat/jobs/job-outcome");
    expect(await readRunProgress(job(), repoRoot)).toEqual({ cost: 1.2, progress: { passed: 3, total: 7 } });
  });
  test("AC-18 rejects another pid", async () => {
    await status("completed", 1);
    const { readRunProgress } = await import("@/chat/jobs/job-outcome");
    expect(await readRunProgress(job(), repoRoot)).toBeNull();
  });
  test("missing status has no progress", async () => {
    const { readRunProgress } = await import("@/chat/jobs/job-outcome");
    expect(await readRunProgress(job(), repoRoot)).toBeNull();
  });
});
