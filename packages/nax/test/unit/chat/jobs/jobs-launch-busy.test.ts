import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { assertDefined, cleanupTempDir, makePRD, makeTempDir } from "@test/helpers";
import type { ChatJobs, StartJobRequest } from "@/chat/jobs/job-runner";
import type { ChatJob, ChatJobKind } from "@/chat/jobs/job-types";
import { _jobsLaunchDeps } from "@/chat/jobs/jobs-launch";
import { createJobsProvider, type JobsProviderOptions } from "@/chat/jobs/jobs-provider";
import { featureDir } from "@/config";
import { validateFeatureName } from "@/utils/feature-name";

const original = { ..._jobsLaunchDeps };
let options: JobsProviderOptions;
let running: ChatJob[];
let start: ReturnType<typeof mock<ChatJobs["start"]>>;
let approve: ReturnType<typeof mock<JobsProviderOptions["approve"]>>;

function job(kind: ChatJobKind = "run", id = "run-00000002"): ChatJob {
  return {
    schemaVersion: 1,
    id,
    kind,
    target: "f1",
    cwd: options.repoRoot,
    pid: 123,
    argv: [],
    startedAt: options.now().toISOString(),
    state: "running",
    logPath: "job.log",
    sessionId: "chat-1",
    approvedAt: options.now().toISOString(),
  };
}

beforeEach(async () => {
  running = [];
  approve = mock(async () => "allow");
  start = mock(async (_request: StartJobRequest) => job());
  options = {
    repoRoot: makeTempDir("jobs-launch-busy-"),
    naxEntry: ["bun", "/n.ts"],
    maxIterations: 20,
    interactionPlugin: "cli",
    approve,
    now: () => new Date("2026-10-01T00:00:00Z"),
    sessionId: () => "chat-1",
    jobs: {
      start,
      running: () => running,
      list: () => [],
      owned: () => [],
      get: () => undefined,
      cancel: async () => job(),
      canCancel: async () => ({ ok: true }),
      attach: async () => {},
      logTail: async () => "",
      peekNotice: () => undefined,
      takeNotice: () => undefined,
      onChange: () => () => {},
      dispose: () => {},
    },
  };
  _jobsLaunchDeps.git = mock(async () => ({ exitCode: 0, stdout: "main", stderr: "" }));
  _jobsLaunchDeps.lockHolder = mock(async () => null);
  await Bun.write(join(featureDir(options.repoRoot, "f1"), "prd.json"), JSON.stringify(makePRD()));
  await Bun.write(join(featureDir(options.repoRoot, "f1"), "spec.md"), "spec");
});
afterEach(() => {
  Object.assign(_jobsLaunchDeps, original);
  cleanupTempDir(options.repoRoot);
});

async function launch(kind: ChatJobKind = "run", input: Record<string, unknown> = { feature: "f1" }) {
  const tool = (await createJobsProvider(options).tools(options.repoRoot)).find((t) => t.localName === kind);
  assertDefined(tool, "launch tool");
  return tool.run(input, {
    root: options.repoRoot,
    resolvedPaths: [],
    maxBytes: 300_000,
    maxFileBytes: 300_000,
    signal: new AbortController().signal,
  });
}
const busy = (kind: string, id: string) => ({
  isError: true,
  content: `[chat] nax ${kind} job ${id} is already running in this checkout`,
});
const held = (pid: number) => ({
  isError: true,
  content: `[chat] this checkout is held by nax pid ${pid}; wait for it or stop it first`,
});

describe("launchJob busy checkout and failures", () => {
  test("AC-1/2 running plan prevents run without approval", async () => {
    running = [job("plan", "plan-00000001")];
    expect(await launch()).toEqual(busy("plan", "plan-00000001"));
    expect(approve).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(_jobsLaunchDeps.lockHolder).not.toHaveBeenCalled();
  });
  test("AC-3/17 live checkout holder prevents plan without approval", async () => {
    _jobsLaunchDeps.lockHolder = mock(async () => 777);
    expect(await launch("plan")).toEqual(held(777));
    expect(approve).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  test("AC-4/5 competing job started during approval prevents launch", async () => {
    approve.mockImplementation(async () => {
      running = [job()];
      return "allow";
    });
    expect(await launch()).toEqual(busy("run", "run-00000002"));
    expect(approve).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });
  test("AC-6/7 checkout lock acquired during approval prevents launch", async () => {
    approve.mockImplementation(async () => {
      _jobsLaunchDeps.lockHolder = mock(async () => 888);
      return "allow";
    });
    expect(await launch()).toEqual(held(888));
    expect(start).not.toHaveBeenCalled();
  });
  test("AC-8 bot fix ignores checkout jobs and locks but still asks", async () => {
    running = [job()];
    _jobsLaunchDeps.lockHolder = mock(async () => 777);
    await launch("bot_fix", { pr: 12 });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(_jobsLaunchDeps.lockHolder).not.toHaveBeenCalled();
  });
  test("AC-13 malformed PRD is an unreadable result, not a throw", async () => {
    await Bun.write(join(featureDir(options.repoRoot, "f1"), "prd.json"), "{");
    const result = await launch();
    expect(result.isError).toBe(true);
    expect(result.content).toStartWith("[chat] prd.json for f1 is unreadable:");
    expect(approve).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  test.each([
    ["AC-14", "could not start nax run: spawn ENOENT", "spawn ENOENT"],
    ["AC-15", "disk full", "disk full"],
    ["runner stage prefix", "[chat] could not start nax run: spawn ENOENT", "spawn ENOENT"],
  ])("%s maps start rejection once", async (_ac, message, expected) => {
    start.mockRejectedValue(new Error(message));
    expect(await launch()).toEqual({ isError: true, content: `[chat] could not start nax run: ${expected}` });
    expect(approve).toHaveBeenCalledTimes(1);
  });
  test("AC-16 featureDir rejection preserves its message", async () => {
    const feature = "a".repeat(65);
    validateFeatureName(feature);
    let message = "";
    try {
      featureDir(options.repoRoot, feature);
    } catch (error) {
      message = errorMessage(error);
    }
    expect(message).not.toBe("");
    expect(await launch("plan", { feature })).toEqual({ isError: true, content: message });
    expect(approve).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  test("simultaneous allowed launches check jobs after lock read without an async gap", async () => {
    start.mockImplementation(async () => {
      const started = job();
      running.push(started);
      return started;
    });
    const results = await Promise.all([launch(), launch()]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.isError)).toEqual([busy("run", "run-00000002")]);
  });
  test("foreign checkout jobs and bot jobs do not block plan/run", async () => {
    running = [{ ...job(), cwd: join(options.repoRoot, "other") }, job("bot_review")];
    expect((await launch()).isError).not.toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe("real lockHolder", () => {
  test("AC-9 reads live pid from nax.lock", async () => {
    await Bun.write(join(options.repoRoot, "nax.lock"), JSON.stringify({ pid: process.pid }));
    expect(await original.lockHolder(options.repoRoot)).toBe(process.pid);
  });
  test("AC-10 returns null when isProcessAlive reports dead", async () => {
    _jobsLaunchDeps.isProcessAlive = mock(() => false);
    await Bun.write(join(options.repoRoot, "nax.lock"), JSON.stringify({ pid: 123 }));
    expect(await original.lockHolder(options.repoRoot)).toBeNull();
    expect(_jobsLaunchDeps.isProcessAlive).toHaveBeenCalledWith(123);
  });
  test.each(["not json", "null", "{}", '{"pid":"123"}', '{"pid":0}', '{"pid":-1}', '{"pid":1.5}'])(
    "AC-11 invalid lock %s returns null",
    async (raw) => {
      await Bun.write(join(options.repoRoot, "nax.lock"), raw);
      expect(await original.lockHolder(options.repoRoot)).toBeNull();
    },
  );
  test("AC-12 missing nax.lock returns null", async () => {
    expect(await original.lockHolder(options.repoRoot)).toBeNull();
  });
});
