import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { assertDefined, cleanupTempDir, makeTempDir } from "@test/helpers";
import { _askControllerDeps, createChatAskController, type HostApprovalCard } from "@/chat/ask-controller";
import { type ChatChains, createChainController } from "@/chat/jobs/chain-controller";
import { _chainStoreDeps, readChainRecord } from "@/chat/jobs/chain-store";
import { buildJobArgv } from "@/chat/jobs/job-argv";
import type { ChatJobs } from "@/chat/jobs/job-runner";
import { _jobsLaunchDeps } from "@/chat/jobs/jobs-launch";
import { createJobsProvider, type JobsProviderOptions } from "@/chat/jobs/jobs-provider";

const steps = [
  { kind: "plan", input: { feature: "f1" } },
  { kind: "run", input: { feature: "f1", maxIterations: 40 } },
];
const declined = { isError: true, content: "[chat] the user declined the chain; propose steps one at a time" };
const originalGit = _jobsLaunchDeps.git;
const originalWrite = _chainStoreDeps.write;
const originalTimers = { ..._askControllerDeps };
let root: string;
let chains: ChatChains;
let options: JobsProviderOptions;
let approve: ReturnType<typeof mock<JobsProviderOptions["approve"]>>;
let signal: AbortSignal;

beforeEach(async () => {
  root = makeTempDir("chain-card-");
  await Bun.write(join(root, ".nax/features/f1/spec.md"), "# Spec");
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
  signal = new AbortController().signal;
  _jobsLaunchDeps.git = mock(async () => ({ exitCode: 0, stdout: "feature/chat\n", stderr: "" }));
  options = {
    repoRoot: root,
    naxEntry: ["bun", "nax.js"],
    maxIterations: 20,
    interactionPlugin: "cli",
    jobs,
    approve,
    sessionId: () => "chat-1",
    now: () => new Date("2026-10-01T00:00:00Z"),
  };
  chains = createChainController({ ...options, outputDir: join(root, "output"), cwd: root });
  options = { ...options, chains };
});
afterEach(() => {
  chains.dispose();
  _jobsLaunchDeps.git = originalGit;
  _chainStoreDeps.write = originalWrite;
  Object.assign(_askControllerDeps, originalTimers);
  cleanupTempDir(root);
});
async function invoke(input: Record<string, unknown> = { steps }) {
  const tool = (await createJobsProvider(options).tools(root)).find((t) => t.localName === "chain");
  assertDefined(tool, "chain registered");
  return tool.run(input, { root, resolvedPaths: [], maxBytes: 300_000, maxFileBytes: 300_000, signal });
}
function card(): HostApprovalCard {
  const value = approve.mock.calls[0]?.[0];
  assertDefined(value, "approval card");
  return value;
}
function expectedCommands(): string {
  return [
    buildJobArgv({ kind: "plan", feature: "f1", spec: ".nax/features/f1/spec.md", profiles: [] }, options),
    buildJobArgv({ kind: "run", feature: "f1", maxIterations: 40, profiles: [] }, options),
  ]
    .map((argv) => argv.join(" "))
    .join("\n");
}

describe("createChainTools card and activation", () => {
  test("AC-1 asks exactly once for the chain tool", async () => {
    await invoke();
    expect(approve).toHaveBeenCalledTimes(1);
    expect(card().tool).toBe("nax-jobs__chain");
    expect(options.jobs.start).not.toHaveBeenCalled();
  });
  test("AC-2 shows exact resolved commands", async () => {
    await invoke();
    expect(card().command).toBe(expectedCommands());
  });
  test("AC-3 labels the full ordered run", async () => {
    await invoke();
    expect(card().summary).toBe("full run of 2 steps: nax plan f1 → nax run f1");
  });
  test.each([
    ["AC-4", "1. nax plan f1 — starts after: you approve this card"],
    ["AC-5", "2. nax run f1 — starts after: step 1 succeeded"],
    ["AC-8", "no cost cap"],
    [
      "AC-9",
      "Steps run in this order, each once. A failed step or check, a different step, the cost cap, a cancel or closing the chat stops the chain.",
    ],
    ["AC-10", "warning: step 1 replaces the existing prd.json for f1"],
    ["AC-11", "warning: run steps have no channel for their own asks; they will time out"],
  ])("%s includes reason line", async (_ac, line) => {
    await invoke();
    expect(card().reason.split("\n")).toContain(line);
  });
  test("AC-6 states the check prerequisite", async () => {
    await invoke({ steps: [steps[0], { ...steps[1], checkBefore: "PRD fidelity READY" }] });
    expect(card().reason.split("\n")).toContain(
      '2. nax run f1 — starts after: step 1 succeeded and check "PRD fidelity READY" passed',
    );
  });
  test("AC-7 describes the between-step cap", async () => {
    await invoke({ steps, costCap: 25 });
    expect(card().reason.split("\n")).toContain(
      "cost cap $25.00, checked between steps; plan and bot job costs are not counted",
    );
  });
  test("AC-12 PR-less bot command retains the sole PR slot", async () => {
    await invoke({ steps: [{ kind: "bot_review", input: {} }] });
    expect(card().command).toBe(["bun", "nax.js", "bot", "review", "<pr>", "-d", root].join(" "));
  });
  test("AC-13 labels the agent-selected PR", async () => {
    await invoke({ steps: [{ kind: "bot_review", input: {} }] });
    expect(card().summary).toBe("full run of 1 steps: nax bot review (PR chosen by the agent)");
  });
  test("AC-14 explains when the agent selects the PR", async () => {
    await invoke({ steps: [{ kind: "bot_review", input: {} }] });
    expect(card().reason.split("\n")).toContain(
      "1. nax bot review (PR chosen by the agent) — starts after: you approve this card — the agent picks the PR when the step starts",
    );
  });
  test("AC-15 forwards the tool signal", async () => {
    await invoke();
    expect(card().signal).toBe(signal);
  });
  test("shows workdir, injected git branch and entry before the steps", async () => {
    await invoke();
    expect(card().reason.split("\n").slice(0, 2)).toEqual([`workdir ${root} on branch feature/chat`, "nax bun nax.js"]);
    expect(_jobsLaunchDeps.git).toHaveBeenCalledWith(["symbolic-ref", "--short", "HEAD"], root);
  });
  test("omits an unavailable branch and nonapplicable warnings", async () => {
    _jobsLaunchDeps.git = mock(async () => ({ exitCode: 1, stdout: "", stderr: "detached" }));
    await invoke({ steps: [{ kind: "bot_fix", input: {} }] });
    expect(card().reason.split("\n")[0]).toBe(`workdir ${root}`);
    expect(card().reason).not.toContain("warning:");
    expect(card().summary).toBe("full run of 1 steps: nax bot fix (PR chosen by the agent)");
  });
  test.each(["bot_review", "bot_fix"])("labels an explicit PR for %s without a substitution warning", async (kind) => {
    await invoke({ steps: [{ kind, input: { pr: 12 } }] });
    const label = `nax bot ${kind === "bot_review" ? "review" : "fix"} #12`;
    expect(card().summary).toBe(`full run of 1 steps: ${label}`);
    expect(card().reason.split("\n")).toContain(`1. ${label} — starts after: you approve this card`);
    expect(card().command).not.toContain("<pr>");
  });
  test("shows a run's own max cost and omits CLI warning on other channels", async () => {
    options = { ...options, interactionPlugin: "telegram" };
    await invoke({ steps: [{ kind: "run", input: { feature: "f1", maxCost: 3 } }] });
    expect(card().command).toBe(
      buildJobArgv({ kind: "run", feature: "f1", maxCost: 3, profiles: [] }, options).join(" "),
    );
    expect(card().reason).not.toContain("warning:");
  });
  test("AC-16 activates and durably saves exactly the displayed argv and cap", async () => {
    approve.mockResolvedValue("allow");
    await invoke({ steps, costCap: 25 });
    const active = chains.active();
    assertDefined(active, "active chain");
    expect(active.steps.map((step) => step.argv.join(" ")).join("\n")).toBe(card().command);
    expect(active.costCap).toBe(25);
    expect(await readChainRecord(join(root, "output"), active.id)).toEqual(active);
  });
  test("AC-17 returns the active chain and exact next-step instruction", async () => {
    approve.mockResolvedValue("allow");
    const result = await invoke();
    const active = chains.active();
    assertDefined(active, "active chain");
    expect(result.isError).not.toBe(true);
    expect(result.content).toBe(
      `${JSON.stringify({ chain: active.id, state: "active", next: 1 })}\nCall step 1 now with exactly the approved arguments.`,
    );
  });
  test("AC-18 denies without activating", async () => {
    expect(await invoke()).toEqual(declined);
    expect(chains.active()).toBeUndefined();
  });
  test("AC-19 reports a failed durable write without activating", async () => {
    approve.mockResolvedValue("allow");
    const write = mock(async () => {
      throw new Error("disk full");
    });
    _chainStoreDeps.write = write;
    const result = await invoke();
    expect(result.isError).toBe(true);
    expect(result.content).toStartWith("[chat] could not save the chain:");
    expect(result.content).toEndWith("; it is not active");
    expect(write).toHaveBeenCalledTimes(1);
    expect(chains.active()).toBeUndefined();
  });
  test("AC-20 only the first of two open approved cards activates", async () => {
    const first = Promise.withResolvers<"allow" | "deny">();
    const second = Promise.withResolvers<"allow" | "deny">();
    const bothOpen = Promise.withResolvers<void>();
    approve
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => {
        bothOpen.resolve();
        return second.promise;
      });
    const a = invoke();
    const b = invoke();
    await bothOpen.promise;
    expect(chains.active()).toBeUndefined();
    first.resolve("allow");
    const firstResult = await a;
    second.resolve("allow");
    const secondResult = await b;
    expect(firstResult.isError).not.toBe(true);
    expect(secondResult).toEqual({
      isError: true,
      content: "[chat] another chain became active while this card was open; this one is not active",
    });
    expect(chains.active()?.id).toBe(JSON.parse(firstResult.content.split("\n")[0] ?? "{}").chain);
  });
  test.each(["timeout", "abort"])("AC-21 host %s denies without activating", async (mode) => {
    const abort = new AbortController();
    signal = abort.signal;
    let expire = () => {};
    _askControllerDeps.setTimeout = (callback) => {
      expire = callback;
      return 1;
    };
    _askControllerDeps.clearTimeout = () => {};
    const asks = createChatAskController({ mode: "full", answer: () => {} });
    const opened = Promise.withResolvers<void>();
    asks.onChange(() => {
      if (asks.pending().length) opened.resolve();
    });
    options = { ...options, approve: (request) => asks.requestHostApproval(request) };
    const result = invoke();
    await opened.promise;
    expect(chains.active()).toBeUndefined();
    const pending = asks.pending()[0];
    assertDefined(pending, "host card");
    if (pending.type === "approval_requested") expect(asks.canRemember(pending)).toBe(false);
    if (mode === "abort") abort.abort();
    else expire();
    expect(await result).toEqual(declined);
    expect(asks.pending()).toEqual([]);
    expect(chains.active()).toBeUndefined();
    asks.reset();
  });
});
