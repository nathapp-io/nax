import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import type { ProviderTool } from "@nathapp/nax-agent";
import { assertDefined, cleanupTempDir, makeTempDir } from "@test/helpers";
import { type ChatChains, createChainController } from "@/chat/jobs/chain-controller";
import { parseJobInput } from "@/chat/jobs/job-argv";
import type { ChatJobs } from "@/chat/jobs/job-runner";
import { createJobsProvider, type JobsProviderOptions } from "@/chat/jobs/jobs-provider";

const run = { kind: "run", input: { feature: "f1" } };
let root: string;
let chains: ChatChains;
let options: JobsProviderOptions;
let approve: ReturnType<typeof mock<JobsProviderOptions["approve"]>>;
const signal = new AbortController().signal;
beforeEach(async () => {
  root = makeTempDir("chain-input-");
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
  cleanupTempDir(root);
});
async function tool(): Promise<ProviderTool> {
  const found = (await createJobsProvider(options).tools(root)).find((t) => t.localName === "chain");
  assertDefined(found, "chain tool registered");
  return found;
}
async function invoke(input: Record<string, unknown>) {
  return (await tool()).run(input, { root, resolvedPaths: [], maxBytes: 300_000, maxFileBytes: 300_000, signal });
}

describe("createChainTools input", () => {
  test("AC-1 registers the three chain tools after cancel", async () => {
    expect((await createJobsProvider(options).tools(root)).map((t) => t.localName)).toEqual([
      "plan",
      "run",
      "bot_review",
      "bot_fix",
      "list",
      "cancel",
      "chain",
      "chain_check",
      "chain_stop",
    ]);
  });
  test("AC-2 closed schema requires steps", async () => {
    expect((await tool()).inputSchema.required).toEqual(["steps"]);
    expect((await tool()).inputSchema.additionalProperties).toBe(false);
  });
  test("AC-23 absent controller leaves six tools", async () => {
    expect((await createJobsProvider({ ...options, chains: undefined }).tools(root)).map((t) => t.localName)).toEqual([
      "plan",
      "run",
      "bot_review",
      "bot_fix",
      "list",
      "cancel",
    ]);
  });
  const invalid: [string, Record<string, unknown>, string][] = [
    ["AC-3", { steps: [] }, "a chain needs 1 to 6 steps"],
    ["AC-4", { steps: Array(7).fill(run) }, "a chain needs 1 to 6 steps"],
    ["AC-6", { steps: "plan" }, "a chain needs 1 to 6 steps"],
    ["AC-7", { steps: ["run"] }, "step 1: input must be an object"],
    ["AC-8", { steps: [{ kind: "run" }] }, "step 1: input must be an object"],
    ["AC-9", { steps: [{ kind: "run", input: [] }] }, "step 1: input must be an object"],
    ["AC-10", { steps: [{ ...run, kind: "merge" }] }, "step 1: unknown kind merge"],
    ["AC-11", { steps: [{ ...run, kind: 7 }] }, "step 1: unknown kind 7"],
    ["AC-12", { steps: [{ kind: "run", input: { feature: "f1", bogus: 1 } }] }, "step 1: unknown field bogus"],
    ["AC-15", { steps: [run], costCap: -1 }, "costCap must be a positive number"],
    ["AC-16", { steps: [run], costCap: "10" }, "costCap must be a positive number"],
    ["AC-17", { steps: [run, { ...run, checkBefore: "" }] }, "step 2: checkBefore must be 1 to 200 characters"],
    [
      "AC-18",
      { steps: [run, { ...run, checkBefore: "x".repeat(201) }] },
      "step 2: checkBefore must be 1 to 200 characters",
    ],
  ];
  test.each(invalid)("%s rejects before approval (AC-21)", async (_ac, input, message) => {
    expect(await invoke(input)).toEqual({ isError: true, content: `[chat] ${message}` });
    expect(approve).not.toHaveBeenCalled();
  });
  test.each([null, 1, "x", new Date(), Object.create({ inherited: true })])(
    "AC-22 rejects non-plain input %p",
    async (input) => {
      expect(await invoke({ steps: [run, { kind: "run", input }] })).toEqual({
        isError: true,
        content: "[chat] step 2: input must be an object",
      });
      expect(approve).not.toHaveBeenCalled();
    },
  );
  test("AC-13 preserves parser error with step prefix", async () => {
    const parsed = parseJobInput("run", { feature: "../x" });
    expect(parsed).toHaveProperty("error");
    if (!("error" in parsed)) throw new Error("expected parser error");
    expect(await invoke({ steps: [{ kind: "run", input: { feature: "../x" } }] })).toEqual({
      isError: true,
      content: `[chat] step 1: ${parsed.error.replace(/^\[chat\] /, "")}`,
    });
    expect(approve).not.toHaveBeenCalled();
  });
  test("AC-14 missing plan spec never asks", async () => {
    const result = await invoke({ steps: [{ kind: "plan", input: { feature: "f9" } }] });
    expect(result.isError).toBe(true);
    expect(result.content).toStartWith("[chat] step 1: no spec for f9; looked for");
    expect(approve).not.toHaveBeenCalled();
  });
  test("AC-5 six steps and a 200 character check reach approval", async () => {
    await invoke({
      steps: Array.from({ length: 6 }, (_, i) => (i === 1 ? { ...run, checkBefore: "x".repeat(200) } : run)),
    });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0]?.[0]).toMatchObject({ tool: "nax-jobs__chain", signal });
    expect(options.jobs.start).not.toHaveBeenCalled();
  });
  test.each([
    ["AC-19", [run]],
    ["AC-20", []],
  ])("%s active check precedes step validation", async (_ac, steps) => {
    const active = await chains.activate({ steps: [{ kind: "run", argv: ["nax", "run", "f1"], target: "f1" }] });
    expect(await invoke({ steps })).toEqual({
      isError: true,
      content: `[chat] chain ${active.id} is already active; stop it with nax-jobs__chain_stop first`,
    });
    expect(approve).not.toHaveBeenCalled();
  });
  test.each([0, NaN, Infinity, null])("rejects nonpositive/nonfinite cost %p", async (costCap) => {
    expect(await invoke({ steps: [run], costCap })).toEqual({
      isError: true,
      content: "[chat] costCap must be a positive number",
    });
    expect(approve).not.toHaveBeenCalled();
  });
  test("validates all step inputs before resolving plan targets", async () => {
    expect(
      await invoke({
        steps: [
          { kind: "plan", input: { feature: "f9" } },
          { ...run, checkBefore: 7 },
        ],
      }),
    ).toEqual({ isError: true, content: "[chat] step 2: checkBefore must be 1 to 200 characters" });
    expect(approve).not.toHaveBeenCalled();
  });
  test("resolves exact argv, targets, PR slots and existing plan PRDs", async () => {
    const { resolveChainProposal } = await import("@/chat/jobs/chain-tools");
    const result = await resolveChainProposal(
      {
        steps: [
          { kind: "plan", input: { feature: "f1" } },
          { kind: "bot_review", input: {} },
          { kind: "bot_fix", input: { pr: 12 }, checkBefore: "ready" },
        ],
        costCap: 10,
      },
      { ...options, chains },
    );
    expect(result).toEqual({
      steps: [
        {
          kind: "plan",
          target: "f1",
          argv: ["bun", "nax.js", "plan", "-f", "f1", "--from", ".nax/features/f1/spec.md", "-d", root],
        },
        { kind: "bot_review", target: "", prIndex: 4, argv: ["bun", "nax.js", "bot", "review", "<pr>", "-d", root] },
        {
          kind: "bot_fix",
          target: "12",
          checkBefore: "ready",
          argv: ["bun", "nax.js", "bot", "fix", "12", "-d", root],
        },
      ],
      costCap: 10,
      existingPlanPrds: [{ step: 1, feature: "f1" }],
    });
  });
  test("does not require run PRDs or bot decisions files at proposal time", async () => {
    await invoke({
      steps: [
        { kind: "run", input: { feature: "f9" } },
        { kind: "bot_review", input: { decisions: "missing.md" } },
      ],
    });
    expect(approve).toHaveBeenCalledTimes(1);
  });
});
