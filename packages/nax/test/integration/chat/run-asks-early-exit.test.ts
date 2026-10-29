import { expect, mock, test } from "bun:test";
import { assertDefined, cleanupTempDir, makeFakeClock, makeLogger, makeTempDir, waitForCondition } from "@test/helpers";
import { _jobRunnerDeps, createJobRunner } from "@/chat/jobs/job-runner";
import { _jobStoreDeps, jobAsksDir } from "@/chat/jobs/job-store";
import { _runAsksDeps, createRunAsks } from "@/chat/jobs/run-asks";
import { RUN_ASK_POLL_MS, writeChatAsk, writeChatNotice, writeChatSettled } from "@/interaction/chat-ask-files";
import type { InteractionRequest } from "@/interaction/types";

test("B5 exit during launch persistence drains final records without cards or heartbeat refresh", async () => {
  const outputDir = makeTempDir("run-asks-early-exit-");
  const runnerOriginal = { ..._jobRunnerDeps };
  const storeOriginal = { ..._jobStoreDeps };
  const asksOriginal = { ..._runAsksDeps };
  const clock = makeFakeClock();
  const exited = Promise.withResolvers<number>();
  const writing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let scanned = Promise.resolve();
  Object.assign(_jobRunnerDeps, {
    spawn: () => ({ pid: 123, exited: exited.promise, unref: () => {}, stdin: { write: () => 65, end: () => 0 } }),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  _jobStoreDeps.write = async (destination, data, options) => {
    if (typeof destination !== "string" || typeof data !== "string") {
      throw new Error("Expected a JSON job record write");
    }
    writing.resolve();
    await release.promise;
    return storeOriginal.write(destination, data, options);
  };
  Object.assign(_runAsksDeps, {
    setTimeout: (callback: () => void | Promise<void>, ms: number) =>
      clock.setTimeout(() => {
        scanned = Promise.resolve(callback());
      }, ms),
    clearTimeout: clock.clearTimeout,
  });
  const jobs = createJobRunner({ repoRoot: outputDir, outputDir, now: () => new Date(0) });
  const choice = mock(async () => "closed");
  const registry = createRunAsks({
    outputDir,
    jobs,
    now: () => new Date(clock.now()),
    logger: makeLogger(),
    chains: { isActive: () => false },
    asks: { requestHostChoice: choice, requestHostQuestion: async () => null },
  });
  const request: InteractionRequest = {
    id: "final-ask",
    type: "confirm",
    featureName: "feature",
    stage: "cost",
    summary: "Proceed?",
    fallback: "abort",
    createdAt: 0,
  };
  try {
    const launch = jobs.start({
      kind: "run",
      target: "feature",
      argv: ["nax", "run", "feature"],
      sessionId: "chat",
      approvedAt: new Date(0).toISOString(),
    });
    await writing.promise;
    const job = jobs.list()[0];
    assertDefined(job);
    const secret = jobs.askSecret?.(job.id);
    assertDefined(secret);
    const dir = jobAsksDir(outputDir, job.id);
    const key = await writeChatAsk(dir, request, new Date(0), secret);
    await writeChatSettled(
      dir,
      key,
      { requestId: request.id, by: "timeout", action: "skip", settledAt: new Date(0).toISOString() },
      secret,
    );
    await writeChatNotice(dir, { ...request, type: "notify", summary: "final advisor" }, new Date(0), secret);
    exited.resolve(0);
    await waitForCondition(() => jobs.running().length === 0);
    release.resolve();
    await launch;
    await waitForCondition(() => jobs.get(job.id)?.state !== "running");
    const heartbeat = mock(asksOriginal.writeChatHeartbeat);
    _runAsksDeps.writeChatHeartbeat = heartbeat;
    await clock.advance(RUN_ASK_POLL_MS);
    await scanned;
    expect(registry.takeNotes()).toEqual([`[${job.id}] final advisor`, `[${job.id}] ask timed out: Proceed?`]);
    expect(choice).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
    await clock.advance(RUN_ASK_POLL_MS);
    await scanned;
    expect(registry.takeNotes()).toEqual([]);
  } finally {
    release.resolve();
    registry.dispose();
    jobs.dispose();
    Object.assign(_jobRunnerDeps, runnerOriginal);
    Object.assign(_jobStoreDeps, storeOriginal);
    Object.assign(_runAsksDeps, asksOriginal);
    cleanupTempDir(outputDir);
  }
});
