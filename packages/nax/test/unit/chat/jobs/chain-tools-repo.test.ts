import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { assertDefined, cleanupTempDir, makePRD, makeStory, makeTempDir } from "@test/helpers";
import { type ChatChains, createChainController } from "@/chat/jobs/chain-controller";
import type { ChatJobs, StartJobRequest } from "@/chat/jobs/job-runner";
import type { ChatJob } from "@/chat/jobs/job-types";
import { _jobsLaunchDeps } from "@/chat/jobs/jobs-launch";
import { createJobsProvider, type JobsProviderOptions } from "@/chat/jobs/jobs-provider";
import { featureDir } from "@/config";

let root: string;
let nested: string;
let chains: ChatChains;
let options: JobsProviderOptions;
const originalGit = _jobsLaunchDeps.git;
const originalLock = _jobsLaunchDeps.lockHolder;
const now = () => new Date("2026-10-28T00:00:00Z");
const approve = mock<JobsProviderOptions["approve"]>(async () => "allow");
const start = mock(
  async (request: StartJobRequest): Promise<ChatJob> => ({
    ...request,
    schemaVersion: 1,
    id: "run-12345678",
    cwd: request.cwd ?? root,
    pid: 42,
    state: "running",
    startedAt: now().toISOString(),
    logPath: join(root, "job.log"),
  }),
);

beforeEach(async () => {
  root = realpathSync(makeTempDir("chain-tools-repo-"));
  nested = join(root, "repos", "nax");
  mkdirSync(join(nested, ".nax"), { recursive: true });
  mkdirSync(join(root, "plain"), { recursive: true });
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
  _jobsLaunchDeps.git = async () => ({ exitCode: 0, stdout: "main\n", stderr: "" });
  _jobsLaunchDeps.lockHolder = async () => null;
  for (const dir of [root, nested]) {
    await Bun.write(
      join(featureDir(dir, "f1"), "prd.json"),
      JSON.stringify(makePRD({ userStories: [makeStory({ status: "pending", passes: false })] })),
    );
    await Bun.write(join(featureDir(dir, "f1"), "spec.md"), "spec");
  }
});
afterEach(() => {
  chains.dispose();
  _jobsLaunchDeps.git = originalGit;
  _jobsLaunchDeps.lockHolder = originalLock;
  cleanupTempDir(root);
});

async function invoke(name: string, input: Record<string, unknown>) {
  const tool = (await createJobsProvider(options).tools(root)).find((t) => t.localName === name);
  assertDefined(tool, name);
  return tool.run(input, { root, resolvedPaths: [], maxBytes: 300_000, maxFileBytes: 300_000 });
}
const chain = (steps: unknown[]) => invoke("chain", { steps });

describe("chain steps with repo", () => {
  test("AC-2/3 argv carries the nested root and the later launch is admitted there", async () => {
    const result = await chain([{ kind: "run", input: { feature: "f1", repo: "repos/nax" } }]);
    expect(result.isError).not.toBe(true);
    expect(approve.mock.calls[0]?.[0].command).toContain(`-d ${nested}`);
    expect(approve.mock.calls[0]?.[0].reason).toContain(`workdir ${root}`);
    expect((await invoke("run", { feature: "f1", repo: "repos/nax" })).isError).not.toBe(true);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[0].cwd).toBe(nested);
    expect(start.mock.calls[0]?.[0]).toMatchObject({ chainStep: 1 });
  });

  test("AC-4 a plain folder fails the proposal with a step prefix", async () => {
    const result = await chain([{ kind: "run", input: { feature: "f1", repo: "plain" } }]);
    expect(result).toEqual({
      isError: true,
      content: "[chat] step 1: repo plain is not a nax project: no .nax directory",
    });
    expect(approve).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  test("AC-5 plan step resolves its spec in the nested root", async () => {
    await Bun.write(join(featureDir(nested, "f2"), "spec.md"), "spec");
    await chain([{ kind: "plan", input: { feature: "f2", repo: "repos/nax" } }]);
    expect(approve.mock.calls[0]?.[0].command).toBe(
      ["bun", "/n.ts", "plan", "-f", "f2", "--from", ".nax/features/f2/spec.md", "-d", nested].join(" "),
    );
  });

  test("AC-6 a rejected later step is step-prefixed with no card and no launch", async () => {
    const result = await chain([
      { kind: "plan", input: { feature: "f1" } },
      { kind: "plan", input: { feature: "missingfeat", repo: "missing" } },
    ]);
    expect(result).toEqual({ isError: true, content: "[chat] step 2: repo missing does not exist" });
    expect(approve).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  test("AC-7 no repo keeps the chat root spec and argv", async () => {
    await chain([{ kind: "plan", input: { feature: "f1" } }]);
    expect(approve.mock.calls[0]?.[0].command).toBe(
      ["bun", "/n.ts", "plan", "-f", "f1", "--from", ".nax/features/f1/spec.md", "-d", root].join(" "),
    );
  });
});
