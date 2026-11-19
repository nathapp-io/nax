import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  assertDefined,
  cleanupTempDir,
  makeLogger,
  makeNaxConfig,
  makePRD,
  makeStory,
  makeTempDir,
  waitForCondition,
  withDepsRestore,
} from "@test/helpers";
import { createChatAskController } from "@/chat/ask-controller";
import { _flowHandoffDeps, _flowProviderDeps, handoffStepArgv } from "@/chat/flow";
import { type ChainLaunch, type ChatChains, createChainController, createHostJobs } from "@/chat/jobs";
import { _chainStoreDeps, readChainRecord } from "@/chat/jobs/chain-store";
import type { ChatChain } from "@/chat/jobs/chain-types";
import { _jobRunnerDeps } from "@/chat/jobs/job-runner";
import type { ChatJob } from "@/chat/jobs/job-types";
import { _jobsLaunchDeps } from "@/chat/jobs/jobs-launch";
import { featureDir } from "@/config";
import { NaxError } from "@/errors";
import { workflowFeatureDir } from "@/workflow/paths";

const AT = "2026-11-18T09:30:00.000Z";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const BRANCH = "feat/f1";
const FLOW = { kind: "created", id: "fl1", state: "PENDING", url: "/flows/fl1" } as const;
const ROLE_CAP = { roles: { reviewer: "acp:codex", supervisor: "acp:claude" }, costCapUsd: 5 };
const CALL = { handoff: { feature: "f1" }, ...ROLE_CAP };
const RUN = {
  kind: "run",
  target: "f1",
  argv: ["bun", "/n.ts", "run", "--feature", "f1", "--publish", "none"],
} as const;
const HANDOFF = { kind: "handoff", argv: handoffStepArgv({ feature: "f1", ...ROLE_CAP }) } satisfies ChainLaunch;

let repoRoot: string;
let outputDir: string;
let chains: ChatChains | undefined;
let closeHost: (() => void) | undefined;
let published: number;
let write: ReturnType<typeof spyOn<typeof _chainStoreDeps, "write">>;
const rename = _chainStoreDeps.rename;
const link = _chainStoreDeps.link;

beforeEach(() => {
  repoRoot = makeTempDir("chain-handoff-run-");
  outputDir = join(repoRoot, "output");
  published = 0;
  write = spyOn(_chainStoreDeps, "write");
  _chainStoreDeps.rename = (from, to) => {
    rename(from, to);
    published++;
  };
  _chainStoreDeps.link = (from, to) => {
    link(from, to);
    published++;
  };
});

afterEach(async () => {
  try {
    closeHost?.();
    chains?.stop("cleanup");
    chains?.dispose();
    const summary = chains?.summary();
    if (summary) await saved(summary);
  } finally {
    closeHost = undefined;
    chains = undefined;
    write.mockRestore();
    _chainStoreDeps.rename = rename;
    _chainStoreDeps.link = link;
    cleanupTempDir(repoRoot);
  }
});

async function saved(chain: Pick<ChatChain, "id" | "state">) {
  await waitForCondition(() => {
    const input = write.mock.calls.at(-1)?.[1];
    return (
      typeof input === "string" && JSON.parse(input).state === chain.state && published === write.mock.calls.length
    );
  });
  return readChainRecord(outputDir, chain.id);
}

async function controllerWithRun(state: "succeeded" | "running" = "succeeded") {
  const job: ChatJob = {
    ...RUN,
    schemaVersion: 1,
    id: "run-12345678",
    cwd: repoRoot,
    pid: 42,
    logPath: "run.log",
    sessionId: "chat-1",
    approvedAt: AT,
    startedAt: AT,
    state,
  };
  const controller = createChainController({
    outputDir,
    cwd: repoRoot,
    sessionId: () => job.sessionId,
    now: () => new Date(AT),
    jobs: { get: (id) => (id === job.id ? job : undefined), onChange: () => () => {} },
  });
  chains = controller;
  const chain = await controller.activate({ steps: [RUN, { ...HANDOFF, target: "f1" }] });
  expect(controller.admit(RUN).kind).toBe("auto");
  controller.started(chain.id, 1, job.id);
  return { controller, chain };
}

describe("chain controller handoff", () => {
  test("AC-1 auto-admits the exact handoff after a successful run", async () => {
    const { controller, chain } = await controllerWithRun();
    expect(controller.admit(HANDOFF)).toEqual({ kind: "auto", chainId: chain.id, step: 2, approvedAt: AT });
  });

  test("AC-2 hands a different cost cap back to the card and stops the chain", async () => {
    const { controller, chain } = await controllerWithRun();
    const argv = handoffStepArgv({ feature: "f1", ...ROLE_CAP, costCapUsd: 6 });
    expect(controller.admit({ kind: "handoff", argv })).toEqual({
      kind: "card",
      note: `chain ${chain.id} stopped: off-card step`,
    });
    expect(controller.summary()).toMatchObject({ state: "stopped", stopReason: "off-card step" });
  });

  test("AC-3 refuses to admit the exact handoff while the run is still running", async () => {
    const { controller, chain } = await controllerWithRun("running");
    expect(controller.admit(HANDOFF)).toEqual({
      kind: "card",
      note: `chain ${chain.id} stopped: step 1 has not succeeded`,
    });
    expect(controller.summary()).toMatchObject({ state: "stopped", stopReason: "step 1 has not succeeded" });
  });

  test("AC-4 completes and persists a succeeded final handoff without a job", async () => {
    const { controller, chain } = await controllerWithRun();
    expect(controller.admit(HANDOFF).kind).toBe("auto");
    controller.stepEnded(chain.id, 2, "succeeded", "flow fl1");

    const ended = { state: "succeeded", note: "flow fl1", at: AT } as const;
    expect(controller.summary()?.state).toBe("completed");
    const step = controller.summary()?.steps[1];
    expect(step?.ended).toEqual(ended);
    expect(step).not.toHaveProperty("job");
    const record = await saved({ id: chain.id, state: "completed" });
    expect(record?.endedAt).toBe(AT);
    expect(record?.steps[1]?.ended).toEqual(ended);
  });

  test("AC-5 stops and records a failed handoff", async () => {
    const { controller, chain } = await controllerWithRun();
    expect(controller.admit(HANDOFF).kind).toBe("auto");
    controller.stepEnded(chain.id, 2, "failed", "X");

    expect(controller.summary()).toMatchObject({ state: "stopped", stopReason: "step 2 handoff failed: X" });
    expect(controller.summary()?.steps[1]?.ended).toEqual({ state: "failed", note: "X", at: AT });
  });

  test("AC-6 ignores terminal events for another chain or an unadmitted step", async () => {
    const { controller, chain } = await controllerWithRun();
    const before = controller.summary();
    controller.stepEnded(chain.id, 2, "failed", "not yet admitted");
    expect(controller.summary()).toEqual(before);

    expect(controller.admit(HANDOFF).kind).toBe("auto");
    const admitted = controller.summary();
    controller.stepEnded("chain-ffffffff", 2, "succeeded", "another chain");
    expect(controller.summary()).toEqual(admitted);
    controller.stepEnded(chain.id, 1, "failed", "wrong step");
    expect(controller.summary()).toEqual(admitted);
  });

  test("audits the terminal event once without reopening a chain stopped during the handoff", async () => {
    const { controller, chain } = await controllerWithRun();
    expect(controller.admit(HANDOFF).kind).toBe("auto");
    controller.stop("stopped by the agent");
    controller.stepEnded(chain.id, 2, "succeeded", "flow fl1");
    controller.stepEnded(chain.id, 2, "failed", "duplicate");

    expect(controller.summary()).toMatchObject({ state: "stopped", stopReason: "stopped by the agent" });
    expect(controller.summary()?.steps[1]?.ended).toEqual({ state: "succeeded", note: "flow fl1", at: AT });
  });
});

describe("createHostJobs handoff", () => {
  withDepsRestore(_jobRunnerDeps);
  withDepsRestore(_jobsLaunchDeps);
  withDepsRestore(_flowProviderDeps);
  withDepsRestore(_flowHandoffDeps);

  async function approvedChain() {
    await mkdir(workflowFeatureDir(repoRoot, RUN.target), { recursive: true });
    const exited = Promise.withResolvers<number>();
    _jobRunnerDeps.spawn = mock(() => ({ pid: 4242, exited: exited.promise, unref() {} }));
    _jobRunnerDeps.isProcessAlive = () => true;
    _jobsLaunchDeps.git = async () => ({ exitCode: 0, stdout: BRANCH, stderr: "" });
    _jobsLaunchDeps.lockHolder = async () => null;
    const create = mock<typeof _flowProviderDeps.createKodaFlow>(async () => FLOW);
    _flowProviderDeps.createKodaFlow = create;
    _flowProviderDeps.readFlowRepoState = async () => ({
      ok: true,
      branch: BRANCH,
      sha: SHA,
      remoteUrl: "https://github.com/o/r",
    });
    _flowProviderDeps.readFlowPushUrl = async () => ({ ok: true, url: "git@github.com:o/r.git" });
    _flowProviderDeps.headSha = async () => SHA;
    _flowProviderDeps.isDirty = async () => false;
    _flowProviderDeps.commitAndPush = mock(async () => ({ pushed: true, committed: false }));
    _flowHandoffDeps.collectHandoffRecord = async () => ({ ok: true, record: [], newestRunId: "r1", results: [] });
    _flowHandoffDeps.handoffResultsMatch = async () => true;
    _flowHandoffDeps.readNewestHandoffMark = async () => null;
    _flowHandoffDeps.readRunMark = async () => null;
    _flowHandoffDeps.writeHandoffMark = mock(async () => {});
    // The default seam would ask the real forge about the fixture repository and refuse the handoff.
    _flowHandoffDeps.hasOpenPr = async () => false;

    const asks = createChatAskController({
      mode: "guarded",
      approvalTimeoutMs: 30_000,
      now: () => new Date(AT),
      answer: () => {},
    });
    const approve = spyOn(asks, "requestHostApproval").mockResolvedValue("allow");
    const host = createHostJobs({
      repoRoot,
      outputDir,
      asks,
      naxEntry: ["bun", "/n.ts"],
      config: makeNaxConfig({
        memory: { koda: { url: "https://koda.example/api", headers: { Authorization: "Bearer fixture" } } },
      }),
      mode: () => "guarded",
      sessionId: () => "chat-1",
      now: () => new Date(AT),
      logger: makeLogger(),
    });
    chains = host.chains;
    closeHost = () => {
      host.close();
      host.jobs.dispose();
    };
    await finishApprovedRun(host, exited);
    expect(approve.mock.calls.map(([card]) => card.tool)).toEqual(["nax-jobs__chain"]);
    approve.mockClear();

    const provider = host.providers.find(({ id }) => id === "nax-flow");
    assertDefined(provider, "flow provider");
    const send = (await provider.tools(repoRoot)).find(({ localName }) => localName === "send");
    assertDefined(send, "send tool");
    return { host, approve, create, send: (raw: Record<string, unknown> = CALL) => send.run(raw, context()) };
  }

  function context() {
    return { root: repoRoot, resolvedPaths: [], maxBytes: 300_000, maxFileBytes: 300_000 };
  }

  async function finishApprovedRun(
    host: ReturnType<typeof createHostJobs>,
    exited: ReturnType<typeof Promise.withResolvers<number>>,
  ) {
    const dir = featureDir(repoRoot, "f1");
    await Bun.write(
      join(dir, "prd.json"),
      JSON.stringify(makePRD({ userStories: [makeStory({ status: "pending", passes: false })] })),
    );
    const tools = await host.provider.tools(repoRoot);
    const chainTool = tools.find(({ localName }) => localName === "chain");
    const run = tools.find(({ localName }) => localName === "run");
    assertDefined(chainTool, "chain tool");
    assertDefined(run, "run tool");
    const runInput = { feature: "f1", publish: "none" };
    const approved = await chainTool.run(
      {
        steps: [
          { kind: "run", input: runInput },
          { kind: "handoff", input: { feature: "f1", ...ROLE_CAP } },
        ],
      },
      context(),
    );
    if (approved.isError) throw new Error(approved.content);
    const launched = await run.run(runInput, context());
    if (launched.isError) throw new Error(launched.content);
    await Bun.write(
      join(dir, "status.json"),
      JSON.stringify({
        version: 1,
        run: { id: "r1", pid: 4242, status: "completed" },
        cost: { spent: 2, limit: null },
        progress: { passed: 1, total: 1, failed: 0, pending: 0 },
        workflow: { outcome: "local-only" },
      }),
    );
    exited.resolve(0);
    await waitForCondition(() => host.chains.summary()?.steps[0]?.jobState === "succeeded");
    expect(host.chains.summary()).toMatchObject({ state: "active", next: 2 });
  }

  test("AC-7 creates the approved flow without a second card or a job and completes the chain", async () => {
    const { host, approve, create, send } = await approvedChain();
    expect((await send()).content).toContain('"flow":"fl1"');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[1]).toMatchObject({ handoff: { feature: "f1" }, ...ROLE_CAP });
    expect(approve).not.toHaveBeenCalled();
    expect(host.jobs.list()).toHaveLength(1);
    expect(host.chains.summary()?.state).toBe("completed");
  });

  test("AC-8 stops the approved handoff on koda's HTTP 409", async () => {
    const { host, approve, create, send } = await approvedChain();
    create.mockRejectedValue(
      new NaxError("answered 409: duplicate", "MEMORY_KODA_HTTP", { stage: "memory", status: 409 }),
    );
    const result = await send();
    expect(result.isError).toBe(true);
    expect(approve).not.toHaveBeenCalled();
    expect(host.chains.summary()?.state).toBe("stopped");
    expect(
      host.chains
        .summary()
        ?.stopReason?.startsWith("step 2 handoff failed: [chat] koda did not create the flow (HTTP 409)"),
    ).toBe(true);
  });

  test("AC-9 stops on a record refusal for the next handoff without asking or pushing", async () => {
    const { host, approve, create, send } = await approvedChain();
    _flowHandoffDeps.collectHandoffRecord = async () => ({ ok: false, reason: "R" });
    expect(await send()).toEqual({ isError: true, content: "[chat] cannot hand off f1: R" });
    expect(approve).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(_flowProviderDeps.commitAndPush).not.toHaveBeenCalled();
    expect(host.chains.summary()).toMatchObject({ state: "stopped", stopReason: "cannot hand off f1: R" });
  });

  test("AC-9 stops on a local check that throws for the next handoff, instead of waiting", async () => {
    const { host, approve, create, send } = await approvedChain();
    _flowHandoffDeps.collectHandoffRecord = async () => {
      throw new Error("ELOOP");
    };

    expect(await send()).toEqual({ isError: true, content: "[chat] flow send failed: ELOOP" });
    expect(approve).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(_flowProviderDeps.commitAndPush).not.toHaveBeenCalled();
    expect(host.chains.summary()).toMatchObject({ state: "stopped", stopReason: "flow send failed: ELOOP" });
  });

  test("AC-9 stops on a request carrying both forms, keeping the mixed-form refusal text", async () => {
    const { host, create, send } = await approvedChain();
    const refusal = "[chat] the flow request is invalid:\n- exactly one of features or handoff is required";

    expect(await send({ ...CALL, features: [{ feature: "f1", specPath: ".nax/features/f1/spec.md" }] })).toEqual({
      isError: true,
      content: refusal,
    });
    expect(create).not.toHaveBeenCalled();
    expect(host.chains.summary()).toMatchObject({
      state: "stopped",
      stopReason: "the flow request is invalid:\n- exactly one of features or handoff is required",
    });
  });

  test("an off-card handoff asks for approval with the admission's note", async () => {
    const { host, approve, create, send } = await approvedChain();
    const id = host.chains.active()?.id;
    approve.mockResolvedValue("deny");
    const result = await send({ ...CALL, costCapUsd: 6 });
    expect(result.content).toContain("the user declined");
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0]?.[0].reason).toEndWith(`chain ${id} stopped: off-card step`);
    expect(create).not.toHaveBeenCalled();
    expect(host.chains.summary()).toMatchObject({ state: "stopped", stopReason: "off-card step" });
  });
});
