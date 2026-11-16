import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { assertDefined, cleanupTempDir, makePRD, makeStory, makeTempDir } from "@test/helpers";
import type { HostApprovalCard } from "@/chat/ask-controller";
import { type ChatChains, createChainController } from "@/chat/jobs/chain-controller";
import type { ChatJobs, StartJobRequest } from "@/chat/jobs/job-runner";
import { _jobsLaunchDeps, featureBranchRefusal } from "@/chat/jobs/jobs-launch";
import { createJobsProvider, type JobsProviderOptions } from "@/chat/jobs/jobs-provider";
import { featureDir } from "@/config";

const original = { ..._jobsLaunchDeps };
const now = () => new Date("2026-10-01T00:00:00Z");
let root: string;
let options: JobsProviderOptions;
let chains: ChatChains | undefined;
let approve: ReturnType<typeof mock<(card: HostApprovalCard) => Promise<"allow" | "deny">>>;
let start: ReturnType<typeof mock<ChatJobs["start"]>>;

function gitAnswer(exitCode: number, stdout: string): void {
  _jobsLaunchDeps.git = mock(async () => ({ exitCode, stdout, stderr: "" }));
}

/** Every branch the guard refuses, and how the refusal names it. */
const guardedBranches = [
  ["main", "main"],
  ["master", "master"],
  ["", "an unnamed branch"],
] as const;

/** The refusal line for a branch, with the target the launch would use. */
function refusalText(kind: string, branch: string, target: string): string {
  const shown = branch === "" ? "an unnamed branch" : branch;
  return `[chat] nax ${kind} for f1 refused: the checkout is on ${shown}; plan and run a feature on its feature branch ${target}. Create or check out ${target}, then launch again.`;
}

async function writePendingPRD(branchName: string): Promise<void> {
  await Bun.write(
    join(featureDir(root, "f1"), "prd.json"),
    JSON.stringify(
      makePRD({
        branchName,
        userStories: [makeStory({ id: "US-001", status: "pending", passes: false })],
      }),
    ),
  );
}

async function writeSpec(): Promise<void> {
  await Bun.write(join(featureDir(root, "f1"), "spec.md"), "spec");
}

beforeEach(() => {
  root = makeTempDir("jobs-launch-branch-");
  chains = undefined;
  approve = mock(async () => "allow");
  start = mock(async (request: StartJobRequest) => ({
    ...request,
    schemaVersion: 1,
    id: "run-12345678",
    cwd: root,
    pid: 123,
    startedAt: now().toISOString(),
    state: "running",
    logPath: join(root, "job.log"),
  }));
  options = {
    repoRoot: root,
    naxEntry: ["bun", "/n.ts"],
    interactionPlugin: "cli",
    jobs: {
      start,
      list: () => [],
      get: () => undefined,
      running: () => [],
      owned: () => [],
      cancel: async () => {
        throw new Error("unexpected cancel");
      },
      canCancel: async () => ({ ok: false, message: "unused" }),
      attach: async () => {},
      logTail: async () => "",
      peekNotice: () => undefined,
      takeNotice: () => undefined,
      onChange: () => () => {},
      dispose: () => {},
    },
    approve,
    sessionId: () => "chat-1",
    now,
  };
  gitAnswer(0, "feat/f1\n");
  _jobsLaunchDeps.lockHolder = mock(async () => null);
});

afterEach(() => {
  chains?.dispose();
  Object.assign(_jobsLaunchDeps, original);
  cleanupTempDir(root);
});

async function launch(kind: string, input: Record<string, unknown> = { feature: "f1" }) {
  const tool = (await createJobsProvider(options).tools(root)).find((t) => t.localName === kind);
  assertDefined(tool, `launch tool ${kind}`);
  return tool.run(input, { root, resolvedPaths: [], maxBytes: 300_000, maxFileBytes: 300_000 });
}

function card(): HostApprovalCard {
  const value = approve.mock.calls[0]?.[0];
  assertDefined(value, "approval card");
  return value;
}

function withChains(): JobsProviderOptions {
  const controller = createChainController({ ...options, cwd: root, outputDir: join(root, "output") });
  chains = controller;
  options = { ...options, chains: controller };
  return options;
}

async function chain(steps: unknown[]) {
  withChains();
  const tool = (await createJobsProvider(options).tools(root)).find((t) => t.localName === "chain");
  assertDefined(tool, "chain tool");
  return tool.run({ steps }, { root, resolvedPaths: [], maxBytes: 300_000, maxFileBytes: 300_000 });
}

describe("featureBranchRefusal", () => {
  test("AC-1 names main and the PRD's branchName", async () => {
    await writePendingPRD("feat/f1-x");
    gitAnswer(0, "main\n");
    expect(await featureBranchRefusal({ kind: "run", feature: "f1", repoRoot: root })).toBe(
      "[chat] nax run for f1 refused: the checkout is on main; plan and run a feature on its feature branch feat/f1-x. Create or check out feat/f1-x, then launch again.",
    );
  });

  test("AC-2 names master and the planner's default branch when there is no PRD", async () => {
    gitAnswer(0, "master\n");
    const text = await featureBranchRefusal({ kind: "plan", feature: "f1", repoRoot: root });
    expect(text).toBe(refusalText("plan", "master", "feat/f1"));
  });

  test("AC-3 calls an empty branch unnamed", async () => {
    gitAnswer(0, "\n");
    const text = await featureBranchRefusal({ kind: "run", feature: "f1", repoRoot: root });
    expect(text).toBe(refusalText("run", "", "feat/f1"));
    expect(text).toContain("the checkout is on an unnamed branch;");
  });

  test("AC-4 a feature branch is not refused", async () => {
    gitAnswer(0, "feat/f1\n");
    expect(await featureBranchRefusal({ kind: "run", feature: "f1", repoRoot: root })).toBeUndefined();
  });

  test("AC-5 an unknown branch (detached HEAD, not a repository) is not refused", async () => {
    gitAnswer(1, "");
    expect(await featureBranchRefusal({ kind: "plan", feature: "f1", repoRoot: root })).toBeUndefined();
  });

  test("AC-6 an unreadable PRD falls back to the planner's default branch", async () => {
    await writePendingPRD("feat/f1-x");
    _jobsLaunchDeps.loadPRD = mock(async () => {
      throw new Error("corrupt");
    });
    gitAnswer(0, "main\n");
    expect(await featureBranchRefusal({ kind: "run", feature: "f1", repoRoot: root })).toBe(
      refusalText("run", "main", "feat/f1"),
    );
  });

  test("a PRD whose branchName is empty falls back to the planner's default branch", async () => {
    await writePendingPRD("");
    gitAnswer(0, "main\n");
    expect(await featureBranchRefusal({ kind: "run", feature: "f1", repoRoot: root })).toBe(
      refusalText("run", "main", "feat/f1"),
    );
  });
});

describe("launchJob feature branch guard", () => {
  test("AC-7 a run on main is refused with the PRD's branch as the target", async () => {
    await writePendingPRD("feat/f1-x");
    gitAnswer(0, "main\n");
    expect(await launch("run")).toEqual({
      isError: true,
      content:
        "[chat] nax run for f1 refused: the checkout is on main; plan and run a feature on its feature branch feat/f1-x. Create or check out feat/f1-x, then launch again.",
    });
  });

  test("AC-8 a refused run asks for no approval", async () => {
    await writePendingPRD("feat/f1-x");
    gitAnswer(0, "main\n");
    await launch("run");
    expect(approve).not.toHaveBeenCalled();
  });

  test("AC-9 a refused run starts no job", async () => {
    await writePendingPRD("feat/f1-x");
    gitAnswer(0, "main\n");
    await launch("run");
    expect(start).not.toHaveBeenCalled();
  });

  test("AC-10 a plan on main is refused", async () => {
    await writeSpec();
    gitAnswer(0, "main\n");
    const result = await launch("plan");
    expect(result.isError).toBe(true);
    expect(result.content).toStartWith("[chat] nax plan for f1 refused: the checkout is on main");
  });

  test("AC-11 a refused plan asks for no approval", async () => {
    await writeSpec();
    gitAnswer(0, "main\n");
    await launch("plan");
    expect(approve).not.toHaveBeenCalled();
  });

  test("AC-12 a run on its feature branch is approved once", async () => {
    await writePendingPRD("feat/f1");
    await launch("run");
    expect(approve).toHaveBeenCalledTimes(1);
  });

  test("AC-13 a bot review on main is not branch-guarded", async () => {
    gitAnswer(0, "main\n");
    await launch("bot_review", { pr: 12 });
    expect(approve).toHaveBeenCalledTimes(1);
  });

  test("AC-14 a missing PRD is reported before the branch refusal", async () => {
    gitAnswer(0, "main\n");
    expect(await launch("run")).toEqual({
      isError: true,
      content: "[chat] no prd.json for f1; run nax plan first",
    });
  });

  test("AC-20 an unknown branch leaves the card reason as it was", async () => {
    await writePendingPRD("feat/f1");
    gitAnswer(1, "");
    await launch("run");
    expect(approve).toHaveBeenCalledTimes(1);
    expect(card().reason.split("\n")[0]).toBe(`workdir ${root}`);
    expect(card().reason).not.toContain("on branch");
  });

  test.each(guardedBranches)("AC-21/22 a plan on %p is refused without approval", async (branch, shown) => {
    await writeSpec();
    gitAnswer(0, `${branch}\n`);
    const result = await launch("plan");
    expect(result.isError).toBe(true);
    expect(result.content).toStartWith(`[chat] nax plan for f1 refused: the checkout is on ${shown};`);
    expect(approve).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  test.each(guardedBranches)("AC-21/22 a run on %p is refused without approval", async (branch, shown) => {
    await writePendingPRD("feat/f1-x");
    gitAnswer(0, `${branch}\n`);
    const result = await launch("run");
    expect(result.isError).toBe(true);
    expect(result.content).toStartWith(`[chat] nax run for f1 refused: the checkout is on ${shown};`);
    expect(approve).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});

describe("nax-jobs__chain feature branch guard", () => {
  test("AC-15 a plan step on main fails the proposal", async () => {
    await writeSpec();
    gitAnswer(0, "main\n");
    const result = await chain([
      { kind: "plan", input: { feature: "f1" } },
      { kind: "run", input: { feature: "f1" } },
    ]);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("nax plan for f1 refused");
  });

  test("AC-16 a refused chain asks for no approval", async () => {
    await writeSpec();
    gitAnswer(0, "main\n");
    await chain([
      { kind: "plan", input: { feature: "f1" } },
      { kind: "run", input: { feature: "f1" } },
    ]);
    expect(approve).not.toHaveBeenCalled();
  });

  test("AC-17 a bot chain on main is not branch-guarded", async () => {
    gitAnswer(0, "main\n");
    const result = await chain([
      { kind: "bot_review", input: { pr: 12 } },
      { kind: "bot_fix", input: { pr: 12 } },
    ]);
    expect(result.isError).not.toBe(true);
    expect(approve).toHaveBeenCalledTimes(1);
  });

  test.each(guardedBranches)("AC-23/24 a single plan step on %p is refused without approval", async (branch, shown) => {
    await writeSpec();
    gitAnswer(0, `${branch}\n`);
    const result = await chain([{ kind: "plan", input: { feature: "f1" } }]);
    expect(result.isError).toBe(true);
    expect(result.content).toStartWith(`[chat] step 1: nax plan for f1 refused: the checkout is on ${shown};`);
    expect(approve).not.toHaveBeenCalled();
  });

  test.each(guardedBranches)("AC-23/24 a single run step on %p is refused without approval", async (branch, shown) => {
    await writePendingPRD("feat/f1-x");
    gitAnswer(0, `${branch}\n`);
    const result = await chain([{ kind: "run", input: { feature: "f1" } }]);
    expect(result.isError).toBe(true);
    expect(result.content).toStartWith(`[chat] step 1: nax run for f1 refused: the checkout is on ${shown};`);
    expect(approve).not.toHaveBeenCalled();
  });
});
