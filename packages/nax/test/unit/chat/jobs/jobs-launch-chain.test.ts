import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { assertDefined, cleanupTempDir, makePRD, makeStory, makeTempDir } from "@test/helpers";
import type { ChatChains } from "@/chat/jobs/chain-controller";
import { buildJobArgv } from "@/chat/jobs/job-argv";
import type { ChatJobs, StartJobRequest } from "@/chat/jobs/job-runner";
import type { ChatJob, ChatJobKind } from "@/chat/jobs/job-types";
import * as launches from "@/chat/jobs/jobs-launch";
import { _jobsLaunchDeps } from "@/chat/jobs/jobs-launch";
import { createJobsProvider, type JobsProviderOptions } from "@/chat/jobs/jobs-provider";
import { featureDir } from "@/config";

const original = { ..._jobsLaunchDeps };
const chainId = "chain-1a2b3c4d";
const approvedAt = "2026-10-01T00:00:00Z";
let options: JobsProviderOptions;
let running: ChatJob[];
let start: ReturnType<typeof mock<ChatJobs["start"]>>;
let approve: ReturnType<typeof mock<JobsProviderOptions["approve"]>>;
let chains: ChatChains;
let admit: ReturnType<typeof mock<ChatChains["admit"]>>;

function job(): ChatJob {
  return {
    schemaVersion: 1,
    id: "run-00000002",
    kind: "run",
    target: "f1",
    cwd: options.repoRoot,
    pid: 123,
    argv: [],
    startedAt: approvedAt,
    state: "running",
    logPath: "job.log",
    sessionId: "chat-1",
    approvedAt,
  };
}
beforeEach(async () => {
  running = [];
  approve = mock(async () => "allow");
  start = mock(async (_request: StartJobRequest) => job());
  admit = mock(() => ({ kind: "auto", chainId, step: 2, approvedAt }));
  chains = {
    admit,
    isActive: mock(() => true),
    started: mock(() => {}),
    startFailed: mock(() => {}),
    stop: mock(() => undefined),
    active: () => undefined,
    activate: async () => {
      throw new Error("unused");
    },
    recordCheck: () => ({ ok: true }),
    summary: () => null,
    dispose: () => {},
  };
  options = {
    repoRoot: makeTempDir("jobs-launch-chain-"),
    naxEntry: ["bun", "/n.ts"],
    maxIterations: 20,
    interactionPlugin: "cli",
    approve,
    now: () => new Date("2026-10-02T00:00:00Z"),
    sessionId: () => "chat-1",
    chains,
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
});
afterEach(() => {
  Object.assign(_jobsLaunchDeps, original);
  cleanupTempDir(options.repoRoot);
});
async function launch(kind: ChatJobKind = "run", raw: Record<string, unknown> = { feature: "f1" }) {
  const tool = (await createJobsProvider(options).tools(options.repoRoot)).find((t) => t.localName === kind);
  assertDefined(tool, "launch tool");
  return tool.run(raw, {
    root: options.repoRoot,
    resolvedPaths: [],
    maxBytes: 300_000,
    maxFileBytes: 300_000,
    signal: new AbortController().signal,
  });
}
function lastReason() {
  return approve.mock.calls[0]?.[0].reason?.split("\n").at(-1);
}

describe("resolvePlanSpec", () => {
  test("AC-18 resolves feature spec and existing PRD", async () => {
    await Bun.write(join(featureDir(options.repoRoot, "f1"), "spec.md"), "spec");
    expect(await launches.resolvePlanSpec("f1", undefined, options)).toEqual({
      spec: ".nax/features/f1/spec.md",
      prdExists: true,
    });
  });
  test("AC-19 missing spec preserves lookup error", async () => {
    const result = await launches.resolvePlanSpec("f9", undefined, options);
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected a missing-spec error");
    expect(result.error).toStartWith("[chat] no spec for f9; looked for");
  });
});

describe("launchJob chain admission", () => {
  test("AC-1/21 legacy launch asks once and omits chain keys", async () => {
    options = { ...options, chains: undefined };
    await launch();
    expect(approve).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[0]).not.toHaveProperty("chainId");
    expect(start.mock.calls[0]?.[0]).not.toHaveProperty("chainStep");
  });
  test("AC-2 auto launch skips approval", async () => {
    await launch();
    expect(approve).not.toHaveBeenCalled();
  });
  test("AC-3 auto launch carries chain identity and original approval time", async () => {
    await launch();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[0]).toMatchObject({ chainId, chainStep: 2, approvedAt });
  });
  test("AC-4 auto launch links returned job", async () => {
    await launch();
    expect(chains.started).toHaveBeenCalledWith(chainId, 2, job().id);
  });
  test("AC-5 auto output identifies chain approval", async () => {
    const result = await launch();
    expect(result.content).toContain(`started as step 2 of chain ${chainId}; no card (approved by the chain card)`);
    expect(result.content.split("\n")[0]).toBe(JSON.stringify({ job: job().id, state: "running", log: "job.log" }));
    expect(result.content.split("\n").at(-1)).toBe("A [nax-jobs] notice arrives when it ends.");
  });
  test("AC-6 auto output retains no-ask-channel warning", async () => {
    expect((await launch()).content).toContain("asks you do not answer in chat fall to the run's timeout defaults");
  });
  test("AC-7 admission receives built run argv", async () => {
    await launch("run", { feature: "f1", maxIterations: 40 });
    expect(admit).toHaveBeenCalledWith({
      kind: "run",
      argv: buildJobArgv({ kind: "run", feature: "f1", profiles: [], maxIterations: 40 }, options),
    });
  });
  test("AC-8 bot review admission receives PR", async () => {
    await launch("bot_review", { pr: 12 });
    expect(admit).toHaveBeenCalledWith({
      kind: "bot_review",
      pr: 12,
      argv: buildJobArgv({ kind: "bot_review", pr: 12, profiles: [] }, options),
    });
  });
  test("AC-9 card note is the last reason line", async () => {
    const note = `chain ${chainId} stopped: off-card step`;
    admit.mockReturnValue({ kind: "card", note });
    await launch();
    expect(lastReason()).toBe(note);
  });
  test("AC-10 card without note preserves legacy reason", async () => {
    admit.mockReturnValue({ kind: "card" });
    await launch();
    const reason = approve.mock.calls[0]?.[0].reason;
    approve.mockClear();
    options = { ...options, chains: undefined };
    await launch();
    expect(approve.mock.calls[0]?.[0].reason).toBe(reason);
  });
  test("AC-11 early lock refusal never admits", async () => {
    _jobsLaunchDeps.lockHolder = mock(async () => 777);
    expect(await launch()).toEqual({
      isError: true,
      content: "[chat] this checkout is held by nax pid 777; wait for it or stop it first",
    });
    expect(admit).not.toHaveBeenCalled();
  });
  test("AC-12 late lock refusal reports start failure", async () => {
    _jobsLaunchDeps.lockHolder = mock<typeof _jobsLaunchDeps.lockHolder>(async () => null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(777);
    const result = await launch();
    expect(start).not.toHaveBeenCalled();
    expect(chains.startFailed).toHaveBeenCalledWith(
      chainId,
      2,
      "this checkout is held by nax pid 777; wait for it or stop it first",
    );
    expect(result).toEqual({
      isError: true,
      content: "[chat] this checkout is held by nax pid 777; wait for it or stop it first",
    });
  });
  test("AC-13 spawn rejection reports normalized start failure", async () => {
    start.mockRejectedValue(new Error("spawn failed"));
    await launch();
    expect(chains.startFailed).toHaveBeenCalledWith(chainId, 2, "could not start nax run: spawn failed");
  });
  test("AC-14 stop during final lock await prevents spawn", async () => {
    let calls = 0;
    _jobsLaunchDeps.lockHolder = mock(async () => {
      if (++calls === 2) chains.isActive = mock(() => false);
      return null;
    });
    expect(await launch()).toEqual({
      isError: true,
      content: `[chat] chain ${chainId} stopped before step 2 started; nothing started`,
    });
    expect(chains.isActive).toHaveBeenCalledWith(chainId);
    expect(start).not.toHaveBeenCalled();
  });
  test("AC-15/16 over-limit auto run stops chain and asks with final note", async () => {
    await Bun.write(
      join(featureDir(options.repoRoot, "f1"), "prd.json"),
      JSON.stringify(
        makePRD({ userStories: Array.from({ length: 25 }, (_, i) => makeStory({ id: `US-${i}`, status: "pending" })) }),
      ),
    );
    approve.mockResolvedValue("deny");
    await launch();
    const reason = "step 2: 25 stories pending but max iterations is 20 (nax#2706)";
    expect(chains.stop).toHaveBeenCalledWith(reason);
    expect(start).not.toHaveBeenCalled();
    expect(approve).toHaveBeenCalledTimes(1);
    expect(lastReason()).toBe(`chain ${chainId} stopped: ${reason}`);
  });
  test("AC-17 missing target never admits", async () => {
    expect(await launch("run", { feature: "f9" })).toEqual({
      isError: true,
      content: "[chat] no prd.json for f9; run nax plan first",
    });
    expect(admit).not.toHaveBeenCalled();
  });
  test.each(["plan", "run"] as const)("AC-22 early running %s never admits", async (kind) => {
    running = [{ ...job(), kind }];
    expect(await launch()).toEqual({
      isError: true,
      content: `[chat] nax ${kind} job ${job().id} is already running in this checkout`,
    });
    expect(admit).not.toHaveBeenCalled();
  });
  test("AC-23 late running-job refusal reports start failure", async () => {
    let calls = 0;
    _jobsLaunchDeps.lockHolder = mock(async () => {
      if (++calls === 2) running = [job()];
      return null;
    });
    const result = await launch();
    expect(start).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(chains.startFailed).toHaveBeenCalledWith(
      chainId,
      2,
      `nax run job ${job().id} is already running in this checkout`,
    );
  });
});
