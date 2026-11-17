import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _jobOutcomeDeps } from "@/chat/jobs/job-outcome";
import type { ChatJob } from "@/chat/jobs/job-types";
import { featureDir } from "@/config/paths";
import type { LoadedRun } from "@/workflow/run-verdict";
import type { OpenItem } from "@/workflow/types";

const originalOutcomeDeps = { ..._jobOutcomeDeps };
/** The output directory every test's stubbed resolver hands back. */
const OUTPUT_DIR = "/output/project";
/** Every call the stubbed verdict loader received, in order. */
let verdictCalls: { root: string; feature: string; resolve: (dir: string) => Promise<string> }[] = [];

let repoRoot: string;
beforeEach(() => {
  repoRoot = makeTempDir("job-outcome-");
  verdictCalls = [];
});
afterEach(() => {
  Object.assign(_jobOutcomeDeps, originalOutcomeDeps);
  cleanupTempDir(repoRoot);
});

/** A loaded run whose only interesting part is the open items it lists, in verdict order. */
function loadedRun(openItems: readonly OpenItem[]): LoadedRun {
  return {
    runId: "w1",
    runDir: "unused",
    result: { schemaVersion: 1, runId: "w1", feature: "feature", stories: {} },
    record: {
      step: "done",
      startedAt: "2026-10-01",
      seed: null,
      gateFindings: [],
      reviewRan: true,
      reviewOpen: [],
      minors: [],
      newMinors: [],
      nextFindingId: 1,
      fixRan: false,
      rulings: [],
      reasons: [],
      timings: {},
      tokensByRole: {},
      url: "https://x/pull/7",
    },
    openItems,
    reasons: [],
    supplementaryItems: [],
  };
}

/** Open items built from `[id, kind]` pairs. */
function openItemsOf(...entries: readonly (readonly [string, OpenItem["kind"]])[]): OpenItem[] {
  return entries.map(([id, kind]) => ({ id, kind, issue: `${id} is still open` }));
}

/** Stubs the verdict read, or makes it reject, and records what it was called with. */
function stubVerdict(result: readonly OpenItem[] | Error): void {
  _jobOutcomeDeps.resolveOutputDir = async () => OUTPUT_DIR;
  _jobOutcomeDeps.loadRunVerdict = async (root, feature, resolve) => {
    verdictCalls.push({ root, feature, resolve });
    if (result instanceof Error) throw result;
    return loadedRun(result);
  };
}

/** The two items AC-1, AC-2 and AC-3 name. */
const D1_AND_US003 = openItemsOf(["D-1", "advisor"], ["US-003", "cannot-verify"]);
const HELD_NOTE_TAIL = "held by 2 open items: D-1 advisor, US-003 cannot-verify";
/** How seven findings read once the formatter names five and counts the rest. */
const HELD_SEVEN_LIST = "I-1 finding, I-2 finding, I-3 finding, I-4 finding, I-5 finding, and 2 more";

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
async function status(
  runStatus = "completed",
  pid = 4242,
  workflow?: { outcome: string; url?: string },
  metrics: { cost?: number; passed?: number; total?: number } = {},
): Promise<void> {
  await Bun.write(
    join(featureDir(repoRoot, "feature"), "status.json"),
    JSON.stringify({
      version: 1,
      run: { id: "run-1", pid, status: runStatus },
      cost: { spent: metrics.cost ?? 1.2, limit: null },
      progress: { passed: metrics.passed ?? 3, total: metrics.total ?? 7, failed: 1, pending: 3 },
      ...(workflow ? { workflow: { step: "done", stories: {}, ...workflow } } : {}),
    }),
  );
}
async function resolve(overrides: Partial<ChatJob> = {}, exitCode?: number) {
  const { resolveJobOutcome } = await import("@/chat/jobs/job-outcome");
  return resolveJobOutcome(job(overrides), { exitCode }, repoRoot);
}

describe("resolveJobOutcome", () => {
  test("AC-12 a publish job names a ready PR the same way a finish job did", async () => {
    await status("completed", 4242, { outcome: "ready", url: "https://x/pull/7" });
    expect(await resolve({ kind: "publish", id: "publish-1a2b3c4d" })).toMatchObject({
      state: "succeeded",
      note: "publish ready https://x/pull/7",
    });
  });
  test("#2819 a publish job reads its run record and names the published PR", async () => {
    await status("completed", 4242, { outcome: "draft", url: "https://x/pull/7" });
    stubVerdict([]);
    expect(await resolve({ kind: "publish", id: "publish-1a2b3c4d" })).toMatchObject({
      state: "succeeded",
      note: "publish draft https://x/pull/7",
    });
    expect(verdictCalls).toHaveLength(1);
  });
  test("#2819 a refused publish fails and keeps the run record's reason", async () => {
    await status("failed", 4242, { outcome: "local-only" });
    expect(await resolve({ kind: "publish", id: "publish-1a2b3c4d" })).toMatchObject({
      state: "failed",
      note: "publish local-only; run status failed",
    });
  });
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
  test("#2819 a publish job projects its run record too; a bot job never does", async () => {
    await status();
    const { readRunProgress } = await import("@/chat/jobs/job-outcome");
    expect(await readRunProgress(job({ kind: "publish" }), repoRoot)).toEqual({
      cost: 1.2,
      progress: { passed: 3, total: 7 },
    });
    expect(await readRunProgress(job({ kind: "bot_fix" }), repoRoot)).toBeNull();
  });
  test("missing status has no progress", async () => {
    const { readRunProgress } = await import("@/chat/jobs/job-outcome");
    expect(await readRunProgress(job(), repoRoot)).toBeNull();
  });
});

describe("readJobStatus", () => {
  test("AC-20 returns null for a status file naming a different pid", async () => {
    await status("completed", 1);
    const { readJobStatus } = await import("@/chat/jobs/job-outcome");
    expect(await readJobStatus(job(), repoRoot)).toBeNull();
  });

  test("AC-20 returns the run record when the pid matches", async () => {
    await status("running", 4242);
    const { readJobStatus } = await import("@/chat/jobs/job-outcome");
    expect(await readJobStatus(job(), repoRoot)).toMatchObject({ run: { pid: 4242, status: "running" } });
  });

  test("AC-24 readRunProgress keeps its cost/progress projection once readJobStatus is exported", async () => {
    await status("running", 4242, undefined, { cost: 3.18, passed: 4, total: 13 });
    const { readJobStatus, readRunProgress } = await import("@/chat/jobs/job-outcome");
    expect(await readJobStatus(job(), repoRoot)).not.toBeNull();
    expect(await readRunProgress(job(), repoRoot)).toEqual({ cost: 3.18, progress: { passed: 4, total: 13 } });
  });
});

describe("US-003 held draft", () => {
  test("AC-1 a run job records the draft PR and its open items in verdict order", async () => {
    await status("completed", 4242, { outcome: "draft", url: "https://x/pull/7" });
    stubVerdict(D1_AND_US003);
    expect((await resolve()).held).toEqual({
      url: "https://x/pull/7",
      items: [
        { id: "D-1", kind: "advisor" },
        { id: "US-003", kind: "cannot-verify" },
      ],
    });
    expect((await resolve()).state).toBe("succeeded");
  });

  test("AC-2 a run job's note names the held-by count and every item with its kind", async () => {
    await status("completed", 4242, { outcome: "draft", url: "https://x/pull/7" });
    stubVerdict(D1_AND_US003);
    expect((await resolve()).note).toBe(`publish draft https://x/pull/7; ${HELD_NOTE_TAIL}`);
  });

  test("AC-3 a publish job records the same held draft and note as a run job", async () => {
    await status("completed", 4242, { outcome: "draft", url: "https://x/pull/7" });
    stubVerdict(D1_AND_US003);
    expect(await resolve({ kind: "publish", id: "publish-1a2b3c4d" })).toEqual({
      state: "succeeded",
      cost: 1.2,
      progress: { passed: 3, total: 7 },
      held: {
        url: "https://x/pull/7",
        items: [
          { id: "D-1", kind: "advisor" },
          { id: "US-003", kind: "cannot-verify" },
        ],
      },
      note: `publish draft https://x/pull/7; ${HELD_NOTE_TAIL}`,
    });
  });

  test("AC-4 the note names five items then counts the rest, and held keeps all seven", async () => {
    await status("completed", 4242, { outcome: "draft", url: "https://x/pull/7" });
    const seven = ["I-1", "I-2", "I-3", "I-4", "I-5", "I-6", "I-7"] as const;
    stubVerdict(seven.map((id) => ({ id, kind: "finding" as const, issue: `${id} is still open` })));
    const outcome = await resolve();
    expect(outcome.note?.endsWith(`held by 7 open items: ${HELD_SEVEN_LIST}`)).toBe(true);
    expect(outcome.held?.items).toHaveLength(7);
  });

  test("AC-5 a ready workflow carries no held draft and reads no verdict", async () => {
    await status("completed", 4242, { outcome: "ready", url: "https://x/pull/7" });
    stubVerdict([]);
    const outcome = await resolve();
    expect(outcome).not.toHaveProperty("held");
    expect(outcome.note).toBe("publish ready https://x/pull/7");
    expect(verdictCalls).toHaveLength(0);
  });

  test("AC-6 a status with no workflow block carries no held draft and reads no verdict", async () => {
    await status("completed");
    stubVerdict([]);
    const outcome = await resolve();
    expect(outcome).not.toHaveProperty("held");
    expect(verdictCalls).toHaveLength(0);
  });

  test("AC-7 a failed run record stays failed and carries no held draft", async () => {
    await status("failed", 4242, { outcome: "draft", url: "https://x/pull/7" });
    stubVerdict(D1_AND_US003);
    const outcome = await resolve();
    expect(outcome.state).toBe("failed");
    expect(outcome).not.toHaveProperty("held");
    expect(verdictCalls).toHaveLength(0);
  });

  test("AC-8 an unreadable verdict keeps the draft PR and names the read failure", async () => {
    await status("completed", 4242, { outcome: "draft", url: "https://x/pull/7" });
    stubVerdict(new Error("no workflow result"));
    expect(await resolve()).toMatchObject({
      state: "succeeded",
      held: { url: "https://x/pull/7", items: [], unreadable: true },
      note: "publish draft https://x/pull/7; open items unreadable: no workflow result",
    });
  });

  test("AC-9 the verdict read gets the repo root, the job's target and the output resolver", async () => {
    await status("completed", 4242, { outcome: "draft", url: "https://x/pull/7" });
    stubVerdict([]);
    await resolve();
    expect(verdictCalls).toHaveLength(1);
    expect(verdictCalls[0]?.root).toBe(repoRoot);
    expect(verdictCalls[0]?.feature).toBe("feature");
    expect(verdictCalls[0]?.resolve).toBe(_jobOutcomeDeps.resolveOutputDir);
    expect(await verdictCalls[0]?.resolve(repoRoot)).toBe(OUTPUT_DIR);
  });

  test("AC-10 a draft with no open items keeps an empty held list and no unreadable marker", async () => {
    await status("completed", 4242, { outcome: "draft", url: "https://x/pull/7" });
    stubVerdict([]);
    const outcome = await resolve();
    expect(outcome.held).toEqual({ url: "https://x/pull/7", items: [] });
    expect(outcome.note).toBe("publish draft https://x/pull/7");
  });

  test("AC-11 a disagreeing exit code follows the held segment, singular for one item", async () => {
    await status("completed", 4242, { outcome: "draft", url: "https://x/pull/7" });
    stubVerdict(openItemsOf(["D-1", "advisor"]));
    expect((await resolve({}, 1)).note).toBe(
      "publish draft https://x/pull/7; held by 1 open item: D-1 advisor; exit code 1 disagrees with the run record",
    );
  });
});
