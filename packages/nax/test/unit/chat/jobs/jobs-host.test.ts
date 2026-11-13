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
import { _jobsHostDeps } from "@/chat/jobs/jobs-host";
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

/** The `memory.koda` block a flow send needs; every field optional so an absent one can be tested. */
interface KodaBlock {
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

async function compose(mode: () => ChatMode, koda?: KodaBlock) {
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
    config: makeNaxConfig({
      outputDir: join(repoRoot, "output"),
      ...(koda === undefined ? {} : { memory: { koda: { ...koda } } }),
    }),
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
  test("US-005 AC-11 provider options omit maxIterations", async () => {
    const factory = spyOn(_jobsHostDeps, "createJobsProvider");
    try {
      await compose(() => "guarded");
      expect(factory).toHaveBeenCalledTimes(1);
      expect(factory.mock.calls[0]?.[0]).not.toHaveProperty("maxIterations");
    } finally {
      factory.mockRestore();
    }
  });
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

const KODA: KodaBlock = { url: "https://koda.example/api", headers: { Authorization: "Bearer agent-key" } };

const providerIds = (composed: ReturnType<typeof createHostJobs>) => composed.providers.map((entry) => entry.id);

/** Every `memory.koda` block that is not a usable connection, and which part is missing. */
const ABSENT_KODA: { why: string; koda: KodaBlock }[] = [
  { why: "memory.koda.url is unset", koda: { headers: { Authorization: "Bearer k" } } },
  { why: "memory.koda.headers is absent", koda: { url: "https://koda.example/api" } },
  {
    why: "the authorization value is empty",
    koda: { url: "https://koda.example/api", headers: { authorization: "" } },
  },
  {
    why: "the authorization value is whitespace",
    koda: { url: "https://koda.example/api", headers: { authorization: "  \t" } },
  },
  {
    why: "no header is named authorization",
    koda: { url: "https://koda.example/api", headers: { "x-agent-key": "Bearer k" } },
  },
];

describe("createHostJobs providers", () => {
  test("AC-5 with a koda connection offers nax-jobs then nax-flow", async () => {
    const f = await compose(() => "guarded", KODA);
    expect(providerIds(f.composed)).toEqual(["nax-jobs", "nax-flow"]);
  });

  test("AC-5 without a koda connection offers nax-jobs alone", async () => {
    const f = await compose(() => "guarded");
    expect(providerIds(f.composed)).toEqual(["nax-jobs"]);
  });

  test.each(ABSENT_KODA)("AC-8 offers no flow provider when $why", async ({ koda }) => {
    const f = await compose(() => "guarded", koda);
    expect(providerIds(f.composed)).toEqual(["nax-jobs"]);
  });

  test("AC-8 matches AUTHORIZATION in any letter case", async () => {
    const f = await compose(() => "guarded", {
      url: "https://koda.example/api",
      headers: { AUTHORIZATION: "Bearer k" },
    });
    expect(providerIds(f.composed)).toEqual(["nax-jobs", "nax-flow"]);
  });

  test.each([
    { when: "with", koda: KODA },
    { when: "without", koda: undefined },
  ] satisfies { when: string; koda: KodaBlock | undefined }[])(
    "AC-9 provider is providers[0] $when a koda connection",
    async ({ koda }) => {
      const f = await compose(() => "guarded", koda);
      expect(f.composed.provider).toBe(f.composed.providers[0]);
    },
  );
});
