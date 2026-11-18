/**
 * US-007: a chain proposal accepts a `handoff` step as its last step.
 *
 * The handoff runs in the chat's own checkout and its argv is the `nax-flow__send`
 * handoff call itself, so the proposal refuses anything that would make the handoff
 * pointless: no koda connection, a step after it, or an earlier step of the same
 * feature that publishes (in this repo or another).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { assertDefined, cleanupTempDir, makeTempDir } from "@test/helpers";
import { handoffStepArgv } from "@/chat/flow/flow-handoff-input";
import { type ChatChains, createChainController } from "@/chat/jobs/chain-controller";
import { resolveChainProposal } from "@/chat/jobs/chain-tools";
import type { ChatJobs } from "@/chat/jobs/job-runner";
import { _jobsLaunchDeps } from "@/chat/jobs/jobs-launch";
import { createJobsProvider, type JobsProviderOptions } from "@/chat/jobs/jobs-provider";

const roles = { reviewer: "r", supervisor: "s" };
const approval = "koda asks for its own approval before anything billed starts";
const runNone = { kind: "run", input: { feature: "f1", publish: "none" } };
const handoff = (input: Record<string, unknown> = {}) => ({
  kind: "handoff",
  input: { feature: "f1", roles, costCapUsd: 5, ...input },
});

let root: string;
let chains: ChatChains;
let options: JobsProviderOptions;
let approve: ReturnType<typeof mock<JobsProviderOptions["approve"]>>;
const originalGit = _jobsLaunchDeps.git;

beforeEach(async () => {
  root = makeTempDir("chain-handoff-");
  await Bun.write(join(root, ".nax/features/f1/prd.json"), "{}");
  const jobs: ChatJobs = {
    start: mock(async () => {
      throw new Error("must not launch");
    }),
    list: () => [],
    get: () => undefined,
    running: () => [],
    owned: () => [],
    cancel: async () => {
      throw new Error("must not cancel");
    },
    canCancel: async () => ({ ok: true }),
    logTail: async () => "",
    attach: async () => {},
    dispose: () => {},
    onChange: () => () => {},
    peekNotice: () => undefined,
    takeNotice: () => undefined,
  };
  approve = mock(async () => "deny");
  options = {
    repoRoot: root,
    naxEntry: ["bun", "nax.js"],
    interactionPlugin: "cli",
    // The chat this file models has a koda connection; AC-4 is the case that has none.
    handoffAvailable: true,
    jobs,
    approve,
    sessionId: () => "chat-1",
    now: () => new Date("2026-11-18T00:00:00Z"),
  };
  chains = createChainController({ ...options, outputDir: join(root, "output"), cwd: root });
  options = { ...options, chains };
  _jobsLaunchDeps.git = async () => ({ exitCode: 0, stdout: "feat/f1\n", stderr: "" });
});
afterEach(() => {
  chains.dispose();
  _jobsLaunchDeps.git = originalGit;
  cleanupTempDir(root);
});

/** Resolve a proposal against this chat's provider options, overridden per case. */
function propose(steps: readonly unknown[], extra: Partial<JobsProviderOptions> = {}) {
  return resolveChainProposal({ steps }, { ...options, chains, ...extra });
}

function errorOf(result: Awaited<ReturnType<typeof propose>>): string {
  if (!("error" in result)) throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
  return result.error;
}

function stepsOf(result: Awaited<ReturnType<typeof propose>>) {
  if ("error" in result) throw new Error(`expected a proposal, got ${result.error}`);
  return result.steps;
}

describe("resolveChainProposal handoff steps", () => {
  test("AC-1 resolves a handoff step last with the tool call's own argv", async () => {
    const steps = stepsOf(await propose([runNone, handoff()]));
    expect(steps).toHaveLength(2);
    expect(steps[0]?.kind).toBe("run");
    expect(steps[1]).toEqual({
      kind: "handoff",
      target: "f1",
      argv: handoffStepArgv({ feature: "f1", roles, costCapUsd: 5 }),
    });
  });

  test("AC-2 refuses an invalid handoff feature, naming handoff.feature", async () => {
    const error = errorOf(await propose([runNone, handoff({ feature: "../x" })]));
    expect(error).toStartWith("[chat] step 2:");
    expect(error).toContain("handoff.feature");
  });

  test("AC-3 refuses a handoff input carrying repo as an unknown field", async () => {
    expect(errorOf(await propose([runNone, handoff({ repo: "repos/nax" })]))).toBe("[chat] step 2: unknown field repo");
  });

  test("AC-4 refuses a handoff without a koda connection", async () => {
    expect(errorOf(await propose([handoff()], { handoffAvailable: undefined }))).toBe(
      "[chat] step 1: handoff needs a koda connection (memory.koda in the nax config)",
    );
  });

  test("AC-5 refuses a handoff that is not the chain's last step", async () => {
    const run = { kind: "run", input: { feature: "f2" } };
    expect(errorOf(await propose([handoff(), run]))).toBe("[chat] step 1: a handoff must be the chain's last step");
  });

  test.each([
    ["AC-6", { feature: "f1" }],
    ["AC-7", { feature: "f1", publish: "push" }],
  ])("%s refuses a run of the same feature that publishes", async (_ac, input) => {
    expect(errorOf(await propose([{ kind: "run", input }, handoff()]))).toBe(
      '[chat] step 2: step 1 runs f1 without publish "none", so it would publish its own PR before the handoff',
    );
  });

  test("AC-8 refuses a publish step of the same feature", async () => {
    const publish = { kind: "publish", input: { feature: "f1" } };
    expect(errorOf(await propose([publish, handoff()]))).toBe(
      "[chat] step 2: step 1 publishes f1, so there would be nothing to hand off",
    );
  });

  test("AC-9 refuses a run of the same feature in another repo root", async () => {
    await Bun.write(join(root, "other/.nax/config.json"), "{}");
    const other = realpathSync(join(root, "other"));
    const runElsewhere = { kind: "run", input: { feature: "f1", publish: "none", repo: "other" } };
    expect(errorOf(await propose([runElsewhere, handoff()]))).toBe(
      `[chat] step 2: the handoff runs in ${root}, but step 1 runs f1 in ${other}`,
    );
  });

  test("AC-10 a run of another feature is not subject to the handoff checks", async () => {
    const steps = stepsOf(await propose([{ kind: "run", input: { feature: "f2" } }, handoff()]));
    expect(steps.map((step) => step.kind)).toEqual(["run", "handoff"]);
  });

  test("refuses a handoff step that carries a checkBefore", async () => {
    expect(errorOf(await propose([runNone, { ...handoff(), checkBefore: "READY" }]))).toBe(
      "[chat] step 2: a handoff step takes no checkBefore",
    );
  });
});

describe("createChainTools handoff card", () => {
  async function card(): Promise<string> {
    const tool = (await createJobsProvider(options).tools(root)).find((entry) => entry.localName === "chain");
    assertDefined(tool, "chain tool registered");
    await tool.run(
      { steps: [runNone, handoff()] },
      { root, resolvedPaths: [], maxBytes: 300_000, maxFileBytes: 300_000 },
    );
    const request = approve.mock.calls[0]?.[0];
    assertDefined(request, "approval card");
    return String(request.reason);
  }

  test("AC-11 names the handoff on its step line", async () => {
    expect((await card()).split("\n")).toContain(
      "2. hand f1 to koda (reviewer r, supervisor s, cost cap $5.00) — starts after: step 1 succeeded",
    );
  });

  test("AC-11 prints a cap with more than two decimals exactly, never rounded to cents", async () => {
    const tool = (await createJobsProvider(options).tools(root)).find((entry) => entry.localName === "chain");
    assertDefined(tool, "chain tool registered");
    await tool.run(
      { steps: [runNone, handoff({ costCapUsd: 5.004 })] },
      { root, resolvedPaths: [], maxBytes: 300_000, maxFileBytes: 300_000 },
    );
    const request = approve.mock.calls[0]?.[0];
    assertDefined(request, "approval card");
    expect(String(request.reason).split("\n")).toContain(
      "2. hand f1 to koda (reviewer r, supervisor s, cost cap $5.004) — starts after: step 1 succeeded",
    );
  });

  test("AC-12 says koda asks for its own approval before billing", async () => {
    expect((await card()).split("\n")).toContain(approval);
  });

  test("a chain with no handoff step does not mention koda's approval", async () => {
    const tool = (await createJobsProvider(options).tools(root)).find((entry) => entry.localName === "chain");
    assertDefined(tool, "chain tool registered");
    await tool.run({ steps: [runNone] }, { root, resolvedPaths: [], maxBytes: 300_000, maxFileBytes: 300_000 });
    const request = approve.mock.calls[0]?.[0];
    assertDefined(request, "approval card");
    expect(String(request.reason)).not.toContain(approval);
  });
});
