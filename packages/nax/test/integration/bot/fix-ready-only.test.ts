import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeBotFixDeps, makeBotFixEnv, makeTestRuntime } from "@test/helpers";
import { _fixInputDeps, type BotReviewArtifact, loadLatestReview } from "@/bot";
import { _botFixDeps, runBotFix } from "@/bot/fix-run";
import { _fixStepsDeps } from "@/bot/fix-steps";

const original = { ..._botFixDeps };
const stepsOriginal = { ..._fixStepsDeps };
const inputOriginal = { ..._fixInputDeps };
const runtimes: ReturnType<typeof makeTestRuntime>[] = [];
afterEach(async () => {
  Object.assign(_botFixDeps, original);
  Object.assign(_fixStepsDeps, stepsOriginal);
  Object.assign(_fixInputDeps, inputOriginal);
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});
function fixture(withFindings = false) {
  const env = makeBotFixEnv(withFindings ? [{ kind: "finding", key: "f1", issue: "fix me", severity: "minor" }] : []);
  const runtime = makeTestRuntime({ config: env.config });
  runtimes.push(runtime);
  const deps = makeBotFixDeps(env, runtime);
  const runBranchFix = mock(async () => ({ autoCommitted: false, dirty: false }));
  _fixStepsDeps.runBranchFix = runBranchFix;
  const runPreRunSteps = mock(deps.runPreRunSteps);
  const checkPushAccess = mock(deps.checkPushAccess);
  const savedFix = { read: mock(deps.savedFix.read), save: mock(deps.savedFix.save), clear: mock(deps.savedFix.clear) };
  const reportStep = mock(async () => ({ patch: {}, exit: "done" }));
  const readyStep = mock(original.readyStep);
  const recordPrRulings = mock(async () => {});
  Object.assign(_botFixDeps, deps, {
    runPreRunSteps,
    checkPushAccess,
    savedFix,
    reportStep,
    readyStep,
    recordPrRulings,
  });
  return { env, runBranchFix, runPreRunSteps, checkPushAccess, savedFix, reportStep, readyStep };
}
const input = { dir: "/repo", pr: 42, profiles: [], interactive: false };
describe("runBotFix ready-only", () => {
  test("AC-15/16/17/18 ready ends at done without sessions, setup, push probe, saved fixes or summary", async () => {
    const f = fixture(true);
    const result = await runBotFix({ ...input, readyOnly: true, fresh: true });
    expect(result).toMatchObject({ step: "done", outcome: "ready-pass", readyOnly: true, markedReady: false });
    expect(f.readyStep).toHaveBeenCalledTimes(1);
    expect(f.runBranchFix).not.toHaveBeenCalled();
    expect(f.runPreRunSteps).not.toHaveBeenCalled();
    expect(f.checkPushAccess).not.toHaveBeenCalled();
    for (const operation of Object.values(f.savedFix)) expect(operation).not.toHaveBeenCalled();
    expect(f.reportStep).not.toHaveBeenCalled();
  });
  test("AC-20 ordinary nothing path still publishes its summary", async () => {
    const f = fixture();
    expect(await runBotFix(input)).toMatchObject({ step: "done", outcome: "nothing" });
    expect(f.readyStep).toHaveBeenCalledTimes(1);
    expect(f.reportStep).toHaveBeenCalledTimes(1);
  });
  test("ready-only still checks trust and records workflow rulings", async () => {
    const f = fixture();
    const ensureProjectTrusted = mock(async () => {});
    _botFixDeps.ensureProjectTrusted = ensureProjectTrusted;
    _botFixDeps.readPrInfo = async () => ({ ...f.env.info, body: "<!-- nax-workflow:v1 -->" });
    expect(await runBotFix({ ...input, readyOnly: true })).toMatchObject({ outcome: "ready-pass" });
    expect(ensureProjectTrusted).toHaveBeenCalledWith("/repo", { interactive: false });
    expect(_botFixDeps.recordPrRulings).toHaveBeenCalledTimes(1);
  });
  test("ready-only retains review-of-head refusal", async () => {
    const f = fixture();
    _botFixDeps.loadLatestReview = async () => null;
    expect(await runBotFix({ ...input, readyOnly: true })).toMatchObject({
      outcome: "refused",
      reason: expect.stringContaining("no nax bot review of head"),
    });
    expect(f.readyStep).not.toHaveBeenCalled();
  });
  test("US-001 AC-9: open findings survive a newer conversation-only review of the head", async () => {
    const f = fixture();
    const code: BotReviewArtifact = {
      version: 3,
      scope: "full",
      pr: f.env.ref,
      headSha: f.env.info.headSha,
      trusted: true,
      intent: "pass",
      quality: "changes",
      agreed: [{ kind: "finding", key: "f-9", issue: "leaks", severity: "important" }],
    };
    const conversation: BotReviewArtifact = {
      ...code,
      scope: "conversation-only",
      quality: "not-reviewed",
      agreed: [],
    };
    // Two artifacts of one head, served through the real selector: the newer review read no code.
    _fixInputDeps.glob = async () => ["newer", "older"];
    _fixInputDeps.readText = async (path) => JSON.stringify(path === "newer" ? conversation : code);
    _fixInputDeps.mtimeMs = async (path) => (path === "newer" ? 2 : 1);
    _botFixDeps.loadLatestReview = loadLatestReview;
    const result = await runBotFix({ ...input, readyOnly: true });
    if (result.outcome === "refused") throw new Error(`refused: ${result.reason}`);
    expect(f.readyStep.mock.calls[0]?.[0].codeReview).toEqual(code);
    expect(result.markedReady).toBe(false);
    expect(result.readyHeld).toContain("f-9");
  });
});
