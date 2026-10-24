import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeBotFixEnv, makeBotReviewDeps, makeScriptedCallOp, makeTestRuntime } from "@test/helpers";
import type { BotChecks, PostReviewInput } from "@/bot";
import { _botReviewDeps, _postDeps, _reviewStepDeps, postPrReview, runBotReview } from "@/bot";
import { _checkoutStateDeps } from "@/bot/checkout-state";
import { NaxError } from "@/errors";
import type { runPreRunSteps } from "@/execution/lifecycle/pre-run-steps";
import { initLogger, resetLogger } from "@/logger";
import { botPrReviewOp, botPrStaticReviewOp } from "@/operations";
import { _workflowDeps } from "@/workflow/step-context";

const INSTALL = "bun install --frozen-lockfile";
const BUILD = "bun run build";
const BUILD_STEPS = [{ command: BUILD, timeoutSeconds: 900 }];
const INSTALL_STEPS = [{ command: INSTALL, timeoutSeconds: 600 }];
const buildChecks: BotChecks = {
  source: "detected",
  gates: [
    { name: "test", command: "npm run test" },
    { name: "build", command: BUILD },
  ],
  preRun: INSTALL_STEPS,
};
const counts = {
  earlierAnswered: 0,
  inlineFindings: 0,
  threadsAnswered: 0,
  commentsAnswered: 0,
  offLine: 0,
  failed: 0,
};
const verdict = {
  intent: "pass",
  quality: "approved",
  findings: [],
  threads: [],
  comments: [],
  cannotVerify: [],
  inspectedFiles: [],
};

const original = { ..._botReviewDeps };
const workflowOriginal = { ..._workflowDeps };
const stepOriginal = { ..._reviewStepDeps };
const ciOriginal = { ..._checkoutStateDeps };
const preRun = mock<typeof runPreRunSteps>(async () => {});
const post = mock<typeof _botReviewDeps.postPrReview>(async () => counts);
const forgeRun = mock(async (_cmd: string[], _opts: { cwd: string }) => ({
  exitCode: 0,
  stdout: '{"id":42}',
  stderr: "",
}));
let runtime: ReturnType<typeof makeTestRuntime>;
let prompt: string;
let opSeen: unknown;
const input = { dir: "/repo", pr: 7, profiles: [], interactive: false };

beforeEach(() => {
  initLogger({ level: "silent" });
  const env = makeBotFixEnv();
  runtime = makeTestRuntime({ config: env.config });
  Object.assign(_botReviewDeps, makeBotReviewDeps({ config: env.config, runtime, info: () => env.info }));
  Object.assign(_botReviewDeps, {
    resolveBotChecks: async () => buildChecks,
    runPreRunSteps: preRun,
    postPrReview: post,
    prepareInPlaceCheckout: async () => ({
      worktree: "/checkout",
      inPlace: true,
      baseSha: "base",
      mergeBase: "merge",
      snapshotDir: "/snapshot",
      hasBaseNax: true,
      changedFiles: [],
      dispose: async () => {},
    }),
    runGit: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    forge: { run: forgeRun, readText: async () => null },
  });
  prompt = "";
  opSeen = undefined;
  preRun.mockClear();
  preRun.mockImplementation(async () => {});
  post.mockClear();
  post.mockImplementation(async () => counts);
  forgeRun.mockClear();
  forgeRun.mockImplementation(async () => ({ exitCode: 0, stdout: '{"id":42}', stderr: "" }));
  _checkoutStateDeps.readWorkflowFiles = async () => [];
  _checkoutStateDeps.exists = async () => false;
  _reviewStepDeps.writeBranchReviewPackage = async () => [];
  _workflowDeps.appendChangedFileRules = async () => {};
  _workflowDeps.callOp = makeScriptedCallOp((op, value) => {
    opSeen = op;
    if (typeof value === "object" && value !== null && "prompt" in value && typeof value.prompt === "string")
      prompt = value.prompt;
    return verdict;
  });
});
afterEach(async () => {
  Object.assign(_botReviewDeps, original);
  Object.assign(_workflowDeps, workflowOriginal);
  Object.assign(_reviewStepDeps, stepOriginal);
  Object.assign(_checkoutStateDeps, ciOriginal);
  await runtime.close();
  resetLogger();
});

/** Fail only the build invocation, leaving the install untouched. */
function failBuild(error: unknown): void {
  preRun.mockImplementation(async ({ steps }) => {
    if (steps.some(({ command }) => command === BUILD)) throw error;
  });
}

function buildFailedError(code = "PRE_RUN_FAILED"): NaxError {
  return new NaxError("[bot] build failed", code, { stage: "execution", command: BUILD });
}

/** The one checkout-state line that reports the setup nax ran. */
function setupLine(text: string): string | undefined {
  return text.split("\n").find((line) => line.startsWith("Setup nax ran:"));
}

describe("runBotReview builds the fresh review worktree", () => {
  test("AC-6: install runs first, then the build, both in the checkout worktree", async () => {
    await runBotReview(input);
    expect(preRun).toHaveBeenCalledTimes(2);
    expect(preRun.mock.calls[0]?.[0]).toEqual({ steps: INSTALL_STEPS, workdir: "/checkout" });
    expect(preRun.mock.calls[1]?.[0]).toEqual({ steps: BUILD_STEPS, workdir: "/checkout" });
  });
  test("AC-7: the prompt reports both setup steps as succeeded", async () => {
    await runBotReview(input);
    expect(setupLine(prompt)).toBe(`Setup nax ran: ${INSTALL}, ${BUILD} — all succeeded`);
  });
  test("AC-8: a failed install never attempts the build", async () => {
    preRun.mockImplementationOnce(async () => {
      throw new NaxError("[bot] install failed", "PRE_RUN_FAILED", { stage: "execution", command: INSTALL });
    });
    await runBotReview(input);
    expect(preRun).toHaveBeenCalledTimes(1);
    expect(preRun.mock.calls[0]?.[0]).toEqual({ steps: INSTALL_STEPS, workdir: "/checkout" });
  });
  test("AC-9: the checkout state reports only the failed install", async () => {
    preRun.mockImplementationOnce(async () => {
      throw new NaxError("[bot] install failed", "PRE_RUN_FAILED", { stage: "execution", command: INSTALL });
    });
    await runBotReview(input);
    expect(setupLine(prompt)).toBe(`Setup nax ran: ${INSTALL} — failed at ${INSTALL}`);
  });
  test("AC-10/11: the review still runs after a failed build and its prompt names the step", async () => {
    failBuild(buildFailedError());
    expect((await runBotReview(input)).outcome).toBe("posted");
    expect(opSeen).toBe(botPrReviewOp);
    expect(setupLine(prompt)).toBe(`Setup nax ran: ${INSTALL}, ${BUILD} — failed at ${BUILD}`);
  });
  test("AC-12: a failed build is forwarded to posting as buildFailed", async () => {
    failBuild(buildFailedError());
    await runBotReview(input);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0].buildFailed).toBe(BUILD);
  });
  test("AC-13: the real postPrReview renders the build line in the summary it posts", async () => {
    const writeArtifact = spyOn(_postDeps, "writeArtifact").mockResolvedValue(1);
    post.mockImplementation(async (postInput: PostReviewInput) =>
      postPrReview({ ...postInput, deps: { run: forgeRun, readText: async () => null } }),
    );
    try {
      failBuild(buildFailedError());
      expect((await runBotReview(input)).outcome).toBe("posted");
    } finally {
      writeArtifact.mockRestore();
    }
    const bodies = forgeRun.mock.calls.map(([cmd]) => cmd.find((arg) => arg.startsWith("body=")) ?? "").join("\n");
    expect(bodies).toContain(
      `Build step failed (${BUILD}); checks that import built workspace packages may not have started.`,
    );
  });
  test.each([
    ["AC-14", () => buildFailedError("BOT_TRUST_REFUSED")],
    ["AC-15", () => new Error("unexpected build failure")],
  ] as const)("%s: an unexpected build error propagates unchanged", async (_ac, make) => {
    const failure = make();
    failBuild(failure);
    await expect(runBotReview(input)).rejects.toBe(failure);
    expect(post).not.toHaveBeenCalled();
  });
  test("AC-16: an in-place review runs the install only", async () => {
    await runBotReview({ ...input, inPlace: true });
    expect(preRun).toHaveBeenCalledTimes(1);
    expect(preRun.mock.calls[0]?.[0]).toEqual({ steps: INSTALL_STEPS, workdir: "/checkout" });
  });
  test("AC-17: a static review of an untrusted PR runs no setup at all", async () => {
    _botReviewDeps.classifyPrTrust = async () => ({ trusted: false, headSha: "head", reasons: ["fork"] });
    await runBotReview(input);
    expect(opSeen).toBe(botPrStaticReviewOp);
    expect(preRun).not.toHaveBeenCalled();
  });
});
