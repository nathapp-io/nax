import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { assertDefined, cleanupTempDir, makePRD, makeStory, makeTempDir } from "@test/helpers";
import type { ChainSummary, ChatChains } from "@/chat/jobs/chain-controller";
import type { ChainStep, ChatChain } from "@/chat/jobs/chain-types";
import { buildJobArgv } from "@/chat/jobs/job-argv";
import type { ChatJobs, StartJobRequest } from "@/chat/jobs/job-runner";
import type { ChatJob, ChatJobKind } from "@/chat/jobs/job-types";
import * as launches from "@/chat/jobs/jobs-launch";
import { _jobsLaunchDeps } from "@/chat/jobs/jobs-launch";
import { createJobsProvider, type JobsProviderOptions } from "@/chat/jobs/jobs-provider";
import { featureDir } from "@/config";
import { newFeatureRecord } from "@/workflow/feature-record";
import type { FoundHandoffMark } from "@/workflow/handoff-mark";
import type { WorkflowFeatureRecord } from "@/workflow/types";

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
    stepEnded: mock(() => {}),
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
  _jobsLaunchDeps.git = mock(async () => ({ exitCode: 0, stdout: "feat/f1", stderr: "" }));
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
    await launch("run", { feature: "f1" });
    expect(admit).toHaveBeenCalledWith({
      kind: "run",
      argv: buildJobArgv({ kind: "run", feature: "f1", profiles: [] }, options),
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
  test("US-005 AC-8 auto-admitted 25-pending run starts without stopping", async () => {
    await Bun.write(
      join(featureDir(options.repoRoot, "f1"), "prd.json"),
      JSON.stringify(
        makePRD({ userStories: Array.from({ length: 25 }, (_, i) => makeStory({ id: `US-${i}`, status: "pending" })) }),
      ),
    );
    const result = await launch();
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("stories 25 pending of 25");
    expect(chains.stop).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
    expect(approve).not.toHaveBeenCalled();
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

/**
 * US-002: a publish refused because the feature is already published at HEAD would otherwise leave
 * the chain active with a next step that can never start.
 */
describe("launchJob publish refusal stops the matching chain step", () => {
  const publishedAtHead =
    "f1 is already published at HEAD abcdef0 as a draft PR https://x/pull/7; nothing to publish: use nax-jobs__bot_review for its open items";

  function publishedRecord(): WorkflowFeatureRecord {
    return {
      ...newFeatureRecord({ now: approvedAt, seed: null, minors: [] }),
      step: "done",
      head: "abcdef0123",
      outcome: "draft",
      url: "https://x/pull/7",
      ci: "green",
      reasons: [],
    };
  }
  async function allPassedPrd(): Promise<void> {
    await Bun.write(
      join(featureDir(options.repoRoot, "f1"), "prd.json"),
      JSON.stringify(makePRD({ userStories: [makeStory({ id: "US-001", status: "passed", passes: true })] })),
    );
    _jobsLaunchDeps.loadPriorFeature = mock(async () => publishedRecord());
    _jobsLaunchDeps.headSha = mock(async () => "abcdef0123");
  }
  function stageChain(steps: readonly ChainStep[], next: number): void {
    const active: ChatChain = {
      schemaVersion: 1,
      id: chainId,
      sessionId: "chat-1",
      cwd: options.repoRoot,
      approvedAt,
      state: "active",
      steps,
    };
    chains.active = mock(() => active);
    chains.summary = mock(
      (): ChainSummary => ({
        id: chainId,
        state: "active",
        next,
        steps: steps.map((step, i) => ({ step: i + 1, kind: step.kind, argv: step.argv })),
        spent: 0,
      }),
    );
  }

  test("AC-14 the chain stops with the refusal text when its next step is that publish", async () => {
    await allPassedPrd();
    stageChain(
      [
        { kind: "run", argv: [], target: "f1" },
        { kind: "publish", argv: [], target: "f1" },
      ],
      2,
    );
    expect(await launch("publish", { feature: "f1" })).toEqual({
      isError: true,
      content: `[chat] ${publishedAtHead}`,
    });
    expect(chains.stop).toHaveBeenCalledTimes(1);
    expect(chains.stop).toHaveBeenCalledWith(publishedAtHead);
  });

  test("AC-15 no active chain is left to stop", async () => {
    await allPassedPrd();
    expect(await launch("publish", { feature: "f1" })).toMatchObject({ isError: true });
    expect(chains.stop).not.toHaveBeenCalled();
  });

  /**
   * US-004: the handoff-mark refusal takes the same route, because a chain whose next step publishes a
   * feature koda already owns would otherwise wait for a step that can never start.
   */
  test("US-004 AC-14 a handoff refusal stops the chain's publish of the same feature in this repo", async () => {
    await allPassedPrd();
    const found: FoundHandoffMark = {
      mark: { schemaVersion: 1, at: "2026-11-18T00:00:00.000Z", flowId: "fl1", url: "https://koda/flows/fl1" },
      path: "/r/handoff.json",
    };
    _jobsLaunchDeps.readNewestHandoffMark = mock(async () => found);
    const refused =
      "f1 was handed off to koda (flow fl1 https://koda/flows/fl1) at 2026-11-18T00:00:00.000Z; koda publishes it. Delete /r/handoff.json to publish it here instead";
    stageChain(
      [
        { kind: "run", argv: [], target: "f1" },
        { kind: "publish", argv: publishArgv(options.repoRoot), target: "f1" },
      ],
      2,
    );
    expect(await launch("publish", { feature: "f1" })).toEqual({ isError: true, content: `[chat] ${refused}` });
    expect(chains.stop).toHaveBeenCalledTimes(1);
    expect(chains.stop).toHaveBeenCalledWith(refused);
    // The control inside this case: the same feature and chain without a mark stops on the older refusal,
    // so the words the chain receives above are the mark's, not the published-at-head guard's.
    chains.stop = mock(() => undefined);
    _jobsLaunchDeps.readNewestHandoffMark = mock(async () => null);
    await launch("publish", { feature: "f1" });
    expect(chains.stop).toHaveBeenCalledWith(publishedAtHead);
  });

  test("AC-16 a chain whose next step is a bot review is not stopped", async () => {
    await allPassedPrd();
    stageChain(
      [
        { kind: "run", argv: [], target: "f1" },
        { kind: "bot_review", argv: [], target: "12" },
      ],
      2,
    );
    expect(await launch("publish", { feature: "f1" })).toMatchObject({ isError: true });
    expect(chains.stop).not.toHaveBeenCalled();
  });

  /** A publish step's real argv names the repository it runs in; the chat's own is the default. */
  function publishArgv(repoRoot: string): string[] {
    return [...options.naxEntry, "run", "-f", "f1", "-d", repoRoot, "--headless", "--publish-only"];
  }

  test("the same feature name in another repository is not the step this refusal stops", async () => {
    await allPassedPrd();
    stageChain(
      [
        { kind: "run", argv: [], target: "f1" },
        { kind: "publish", argv: publishArgv(join(options.repoRoot, "repos", "other")), target: "f1" },
      ],
      2,
    );
    expect(await launch("publish", { feature: "f1" })).toMatchObject({ isError: true });
    expect(chains.stop).not.toHaveBeenCalled();
  });

  test("a refusal in a nested repository leaves the chat's own publish step active", async () => {
    await allPassedPrd();
    const nested = join(options.repoRoot, "repos", "other");
    await Bun.write(
      join(featureDir(nested, "f1"), "prd.json"),
      JSON.stringify(makePRD({ userStories: [makeStory({ id: "US-001", status: "passed", passes: true })] })),
    );
    stageChain(
      [
        { kind: "run", argv: [], target: "f1" },
        { kind: "publish", argv: publishArgv(options.repoRoot), target: "f1" },
      ],
      2,
    );
    expect(await launch("publish", { feature: "f1", repo: "repos/other" })).toMatchObject({ isError: true });
    expect(chains.stop).not.toHaveBeenCalled();
  });

  test("the step this refusal stops is the one that runs in the same repository", async () => {
    await allPassedPrd();
    stageChain(
      [
        { kind: "run", argv: [], target: "f1" },
        { kind: "publish", argv: publishArgv(options.repoRoot), target: "f1" },
      ],
      2,
    );
    expect(await launch("publish", { feature: "f1" })).toMatchObject({ isError: true });
    expect(chains.stop).toHaveBeenCalledWith(publishedAtHead);
  });
});
