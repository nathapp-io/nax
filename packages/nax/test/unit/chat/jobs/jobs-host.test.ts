import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import {
  assertDefined,
  cleanupTempDir,
  makeLogger,
  makeNaxConfig,
  makePRD,
  makeStory,
  makeTempDir,
} from "@test/helpers";
import { createChatAskController } from "@/chat/ask-controller";
import type { ChatMode } from "@/chat/chat-mode";
import { createHostJobs } from "@/chat/jobs";
import { _jobRunnerDeps } from "@/chat/jobs/job-runner";
import { _jobsLaunchDeps } from "@/chat/jobs/jobs-launch";
import { featureDir } from "@/config";

const dirs: string[] = [];
const compositions: ReturnType<typeof createHostJobs>[] = [];
const originalRunner = { ..._jobRunnerDeps };
const originalLaunch = { ..._jobsLaunchDeps };
const now = () => new Date("2026-10-28T00:00:00Z");
afterEach(() => {
  for (const composition of compositions.splice(0)) {
    composition.close();
    composition.jobs.dispose();
  }
  Object.assign(_jobRunnerDeps, originalRunner);
  Object.assign(_jobsLaunchDeps, originalLaunch);
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

async function compose(mode: () => ChatMode) {
  const repoRoot = makeTempDir("jobs-host-");
  dirs.push(repoRoot);
  await Bun.write(
    join(featureDir(repoRoot, "f1"), "prd.json"),
    JSON.stringify(makePRD({ userStories: [makeStory({ status: "pending", passes: false })] })),
  );
  const spawn = mock(() => ({ pid: 4242, exited: new Promise<number>(() => {}), unref() {} }));
  _jobRunnerDeps.spawn = spawn;
  _jobRunnerDeps.isProcessAlive = () => false;
  _jobsLaunchDeps.git = async () => ({ exitCode: 0, stdout: "feat/f1\n", stderr: "" });
  _jobsLaunchDeps.lockHolder = async () => null;
  const asks = createChatAskController({ mode: "guarded", approvalTimeoutMs: 30_000, now, answer: () => {} });
  const approve = spyOn(asks, "requestHostApproval").mockResolvedValue("allow");
  const composed = createHostJobs({
    repoRoot,
    outputDir: join(repoRoot, "output"),
    naxEntry: ["bun", "/n.ts"],
    config: makeNaxConfig({ outputDir: join(repoRoot, "output") }),
    asks,
    mode,
    sessionId: () => "chat-jobs",
    now,
    logger: makeLogger(),
  });
  compositions.push(composed);
  const tools = await composed.provider.tools(repoRoot);
  const run = tools.find((t) => t.localName === "run");
  assertDefined(run, "run tool");
  const call = (signal?: AbortSignal) =>
    run.run(
      { feature: "f1" },
      { root: repoRoot, resolvedPaths: [], maxBytes: 300_000, maxFileBytes: 300_000, ...(signal ? { signal } : {}) },
    );
  return { call, approve, spawn, composed, tools, repoRoot };
}

describe("createHostJobs approve", () => {
  test("AC-1/2 full mode starts the job without calling requestHostApproval", async () => {
    const f = await compose(() => "full");
    const result = await f.call();
    expect(result.isError).not.toBe(true);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.approve).not.toHaveBeenCalled();
  });
  test("AC-3 guarded mode requests one card for nax-jobs__run", async () => {
    const f = await compose(() => "guarded");
    await f.call();
    expect(f.approve).toHaveBeenCalledTimes(1);
    expect(f.approve.mock.calls[0]?.[0]).toMatchObject({ tool: "nax-jobs__run" });
  });
  test("AC-4/5 full mode with an already-aborted signal denies without a card", async () => {
    const f = await compose(() => "full");
    const result = await f.call(AbortSignal.abort());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("declined");
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.approve).not.toHaveBeenCalled();
  });
  test("AC-6 reads the mode at call time", async () => {
    const modes: ChatMode[] = ["guarded", "full"];
    let reads = 0;
    const f = await compose(() => modes[reads++] ?? "full");
    // bot_review has no busy-job check, so two launches can both reach approval.
    const review = f.tools.find((t) => t.localName === "bot_review");
    assertDefined(review, "bot_review tool");
    const ctx = { root: f.repoRoot, resolvedPaths: [], maxBytes: 300_000, maxFileBytes: 300_000 };
    expect((await review.run({ pr: 1 }, ctx)).isError).not.toBe(true);
    expect((await review.run({ pr: 2 }, ctx)).isError).not.toBe(true);
    expect(f.spawn).toHaveBeenCalledTimes(2);
    expect(f.approve).toHaveBeenCalledTimes(1);
    expect(f.approve.mock.calls[0]?.[0]).toMatchObject({ tool: "nax-jobs__bot_review" });
  });
});
