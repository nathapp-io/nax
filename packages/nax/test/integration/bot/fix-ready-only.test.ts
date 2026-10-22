import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeBotFixDeps, makeBotFixEnv, makeTestRuntime } from "@test/helpers";
import { _botFixDeps, runBotFix } from "@/bot/fix-run";
import { _fixStepsDeps } from "@/bot/fix-steps";

const original = { ..._botFixDeps };
const stepsOriginal = { ..._fixStepsDeps };
const runtimes: ReturnType<typeof makeTestRuntime>[] = [];
afterEach(async () => {
  Object.assign(_botFixDeps, original);
  Object.assign(_fixStepsDeps, stepsOriginal);
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
});
