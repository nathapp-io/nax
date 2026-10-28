import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import type { ProviderTool } from "@nathapp/nax-agent";
import { assertDefined, cleanupTempDir, makePRD, makeStory, makeTempDir } from "@test/helpers";
import { type ChatChains, createChainController } from "@/chat/jobs/chain-controller";
import type { ChatJobs, StartJobRequest } from "@/chat/jobs/job-runner";
import type { ChatJob } from "@/chat/jobs/job-types";
import { _jobsLaunchDeps } from "@/chat/jobs/jobs-launch";
import { createJobsProvider, type JobsProviderOptions } from "@/chat/jobs/jobs-provider";
import { featureDir } from "@/config";

let root: string;
let chains: ChatChains;
let options: JobsProviderOptions;
const originalGit = _jobsLaunchDeps.git;
const now = () => new Date("2026-10-28T00:00:00Z");
const approve = mock<JobsProviderOptions["approve"]>(async () => "allow");
const start = mock(
  async (request: StartJobRequest): Promise<ChatJob> => ({
    ...request,
    schemaVersion: 1,
    id: "run-12345678",
    cwd: root,
    pid: 42,
    state: "running",
    startedAt: now().toISOString(),
    logPath: join(root, "job.log"),
  }),
);

beforeEach(async () => {
  root = makeTempDir("chain-tools-");
  approve.mockClear();
  start.mockClear();
  const jobs: ChatJobs = {
    start,
    list: () => [],
    get: () => undefined,
    running: () => [],
    owned: () => [],
    cancel: mock(async () => {
      throw new Error("must not cancel");
    }),
    canCancel: async () => ({ ok: true }),
    logTail: async () => "",
    attach: async () => {},
    dispose: () => {},
    onChange: () => () => {},
    peekNotice: () => undefined,
    takeNotice: () => undefined,
  };
  options = {
    repoRoot: root,
    naxEntry: ["bun", "/n.ts"],
    maxIterations: 20,
    interactionPlugin: "cli",
    jobs,
    approve,
    sessionId: () => "chat-1",
    now,
  };
  chains = createChainController({ ...options, cwd: root, outputDir: join(root, "output") });
  options = { ...options, chains };
  _jobsLaunchDeps.git = async () => ({ exitCode: 0, stdout: "feat/f1\n", stderr: "" });
  await Bun.write(
    join(featureDir(root, "f1"), "prd.json"),
    JSON.stringify(makePRD({ userStories: [makeStory({ status: "pending", passes: false })] })),
  );
});
afterEach(() => {
  chains.dispose();
  _jobsLaunchDeps.git = originalGit;
  cleanupTempDir(root);
});
async function tool(name: string, opts = options): Promise<ProviderTool> {
  const value = (await createJobsProvider(opts).tools(root)).find((t) => t.localName === name);
  assertDefined(value, name);
  return value;
}
async function invoke(name: string, input: Record<string, unknown> = {}, opts = options) {
  return (await tool(name, opts)).run(input, { root, resolvedPaths: [], maxBytes: 300_000, maxFileBytes: 300_000 });
}
async function nextStep(check = true) {
  const first = { kind: "run" as const, target: "f1", argv: ["first"] };
  await chains.activate({ steps: [first, { ...first, argv: ["second"], ...(check ? { checkBefore: "READY" } : {}) }] });
  expect(chains.admit(first).kind).toBe("auto");
}

describe("createChainTools check, stop and listing", () => {
  test.each([true, false])("AC-1/2 records check passed=%s", async (passed) => {
    await nextStep();
    expect(await invoke("chain_check", { step: 2, passed, note: passed ? "READY" : "2 blockers" })).toEqual({
      content: `check recorded for step 2${passed ? "" : "; the chain stopped"}`,
    });
    expect(chains.summary()?.steps[1]?.check).toMatchObject({ passed, note: passed ? "READY" : "2 blockers" });
    if (!passed) expect(chains.active()).toBeUndefined();
  });
  test("AC-3 rejects check without a chain", async () => {
    expect(await invoke("chain_check", { step: 2, passed: true, note: "READY" })).toEqual({
      isError: true,
      content: "[chat] no active chain",
    });
  });
  test("AC-4 rejects a check for the wrong next step", async () => {
    await nextStep();
    expect(await invoke("chain_check", { step: 3, passed: true, note: "READY" })).toEqual({
      isError: true,
      content: "[chat] step 3 is not the next step",
    });
  });
  test("AC-5 requires all check fields and forbids extras", async () => {
    expect((await tool("chain_check")).inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["step", "passed", "note"],
      properties: { step: { type: "integer" }, passed: { type: "boolean" }, note: { type: "string" } },
    });
  });
  test("AC-6/7 stops without approval or cancelling jobs", async () => {
    await nextStep();
    const id = chains.active()?.id;
    expect(await invoke("chain_stop")).toEqual({ content: `chain ${id} stopped; running jobs keep running` });
    expect(chains.active()).toBeUndefined();
    expect(chains.summary()?.stopReason).toBe("stopped by the agent");
    expect(approve).not.toHaveBeenCalled();
    expect(options.jobs.cancel).not.toHaveBeenCalled();
  });
  test("AC-8 rejects stop without a chain", async () => {
    expect(await invoke("chain_stop")).toEqual({ isError: true, content: "[chat] no active chain" });
    expect(approve).not.toHaveBeenCalled();
  });
  test("AC-9 lists null before activation", async () => {
    expect(JSON.parse(String((await invoke("list")).content))).toEqual({ jobs: [], omitted: 0, chain: null });
  });
  test("AC-10 lists the live summary", async () => {
    await nextStep();
    expect(JSON.parse(String((await invoke("list")).content)).chain).toEqual(chains.summary());
  });
  test("AC-11/12 real chain approval admits once, then asks again", async () => {
    expect((await invoke("chain", { steps: [{ kind: "run", input: { feature: "f1" } }] })).isError).not.toBe(true);
    expect((await invoke("run", { feature: "f1" })).isError).not.toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[0]).toMatchObject({ chainStep: 1, chainId: chains.summary()?.id });
    expect(approve).toHaveBeenCalledTimes(1);
    expect((await invoke("run", { feature: "f1" })).isError).not.toBe(true);
    expect(approve).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(2);
  });
  test("AC-19 rejects check on a step without checkBefore", async () => {
    await nextStep(false);
    expect(await invoke("chain_check", { step: 2, passed: true, note: "READY" })).toEqual({
      isError: true,
      content: "[chat] step 2 has no check to record",
    });
  });
  test.each([
    {},
    { step: 1.5, passed: true, note: "READY" },
    { step: 1, passed: "true", note: "READY" },
    { step: 1, passed: true, note: 7 },
  ])("rejects malformed direct check input %j without recording", async (input) => {
    await nextStep();
    expect(await invoke("chain_check", input)).toEqual({
      isError: true,
      content: "[chat] chain_check requires an integer step, boolean passed and string note",
    });
    expect(chains.summary()?.steps[1]?.check).toBeUndefined();
  });
  test("job detail never includes the chain summary", async () => {
    await nextStep();
    const job = await start({
      kind: "run",
      target: "f1",
      argv: [],
      sessionId: "chat-1",
      approvedAt: now().toISOString(),
    });
    const detailOptions = { ...options, jobs: { ...options.jobs, get: () => job } };
    const result = await invoke("list", { job: job.id }, detailOptions);
    expect(JSON.parse(String(result.content))).toEqual({ ...job, logTail: "" });
  });
  test("AC-20 preserves exact legacy list and tools", async () => {
    const legacy = { ...options, chains: undefined };
    expect((await invoke("list", {}, legacy)).content).toBe('{"jobs":[],"omitted":0}');
    expect((await createJobsProvider(legacy).tools(root)).map((t) => t.localName)).toEqual([
      "plan",
      "run",
      "bot_review",
      "bot_fix",
      "list",
      "cancel",
    ]);
  });
});
