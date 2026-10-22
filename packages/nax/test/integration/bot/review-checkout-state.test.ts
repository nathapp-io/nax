import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeBotFixEnv, makeBotReviewDeps, makeScriptedCallOp, makeTestRuntime } from "@test/helpers";
import { _botReviewDeps, _reviewStepDeps, runBotReview } from "@/bot";
import { _checkoutStateDeps } from "@/bot/checkout-state";
import { NaxError } from "@/errors";
import { initLogger, resetLogger } from "@/logger";
import { botPrReviewOp, botPrStaticReviewOp } from "@/operations";
import { _workflowDeps } from "@/workflow/step-context";

const original = { ..._botReviewDeps };
const workflowOriginal = { ..._workflowDeps };
const stepOriginal = { ..._reviewStepDeps };
const ciOriginal = { ..._checkoutStateDeps };
let runtime: ReturnType<typeof makeTestRuntime>;
let prompt: string;
let opSeen: unknown;
let ciRoot: string;
const input = { dir: "/repo", pr: 7, profiles: [], interactive: false };
beforeEach(() => {
  initLogger({ level: "silent" });
  const env = makeBotFixEnv();
  runtime = makeTestRuntime({ config: env.config });
  Object.assign(_botReviewDeps, makeBotReviewDeps({ config: env.config, runtime, info: () => env.info }));
  prompt = "";
  opSeen = undefined;
  ciRoot = "";
  _checkoutStateDeps.readWorkflowFiles = async (path) => {
    ciRoot = path;
    return ["ci.yml"];
  };
  _checkoutStateDeps.exists = async () => false;
  _reviewStepDeps.writeBranchReviewPackage = async () => [];
  _workflowDeps.appendChangedFileRules = async () => {};
  _workflowDeps.callOp = makeScriptedCallOp((op, value) => {
    opSeen = op;
    if (typeof value === "object" && value !== null && "prompt" in value && typeof value.prompt === "string")
      prompt = value.prompt;
    return {
      intent: "pass",
      quality: "approved",
      findings: [],
      threads: [],
      comments: [],
      cannotVerify: [],
      inspectedFiles: [],
    };
  });
  _botReviewDeps.postPrReview = async () => ({
    inlineFindings: 0,
    threadsAnswered: 0,
    earlierAnswered: 0,
    commentsAnswered: 0,
    offLine: 0,
    failed: 0,
  });
  _botReviewDeps.resolveBotChecks = async () => ({
    source: "config",
    gates: [],
    preRun: [
      { command: "setup-one", timeoutSeconds: 10 },
      { command: "setup-two", timeoutSeconds: 10 },
    ],
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

describe("runBotReview checkout state", () => {
  test("AC-12/13 trusted review describes fresh checkout, resolved setup in order and checkout CI files", async () => {
    await runBotReview(input);
    expect(opSeen).toBe(botPrReviewOp);
    expect(prompt).toContain("## Checkout state\nThis is a fresh git worktree of the PR head");
    expect(prompt).toContain("Setup nax ran: setup-one, setup-two — all succeeded");
    expect(prompt).toContain("CI config files: .github/workflows/ci.yml");
    expect(ciRoot).toBe("/checkout/.github/workflows");
  });
  test("AC-14 failed pre-run is reported, not thrown or marked successful", async () => {
    _botReviewDeps.runPreRunSteps = async () => {
      throw new NaxError("setup failed", "PRE_RUN_FAILED", { stage: "bot", command: "setup-two" });
    };
    await runBotReview(input);
    expect(prompt).toContain("Setup nax ran: setup-one, setup-two — failed at setup-two");
    expect(prompt).not.toContain("all succeeded");
  });
  test("AC-15 untrusted review has no checkout state and runs no setup", async () => {
    _botReviewDeps.classifyPrTrust = async () => ({ trusted: false, headSha: "head", reasons: [] });
    _botReviewDeps.runPreRunSteps = async () => {
      throw new Error("must not run");
    };
    await runBotReview(input);
    expect(opSeen).toBe(botPrStaticReviewOp);
    expect(prompt).not.toContain("## Checkout state");
    expect(ciRoot).toBe("");
  });
  test("AC-16 matching changed feature spec reaches review op", async () => {
    const prepare = _botReviewDeps.preparePrCheckout;
    _botReviewDeps.preparePrCheckout = async (args) => ({
      ...(await prepare(args)),
      changedFiles: [".nax/features/a/prd.json", ".nax/features/a/spec.md"],
    });
    await runBotReview(input);
    expect(prompt.split("\n").find((line) => line.startsWith("Intent:"))).toBe(
      "Intent: the PRD at /checkout/.nax/features/a/prd.json and the spec at /checkout/.nax/features/a/spec.md.",
    );
  });
  test("unrelated setup errors still propagate", async () => {
    const error = new NaxError("unexpected", "OTHER", { stage: "bot" });
    _botReviewDeps.runPreRunSteps = async () => {
      throw error;
    };
    await expect(runBotReview(input)).rejects.toBe(error);
    expect(prompt).toBe("");
  });
});
