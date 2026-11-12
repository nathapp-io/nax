/** nax#2838: a draft is not marked ready while the PR head configures gates the bot did not run. */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeBotFixDraftEnv } from "@test/helpers";
import { _fixReportDeps, type BotFixEnv, type BotFixState, readyStep } from "@/bot";
import { NAX_WORKFLOW_PR_MARKER } from "@/forge";

/** A ready-only pass: the pushed-head hold is US-001's, and these tests are about the head gates. */
const state: BotFixState = { step: "ready", timings: {}, outcome: "pushed", pushedSha: "abcdef12", readyOnly: true };
const greenCi = { outcome: "green", detail: "all checks passed" } as const;

function envWithBotGates(names: readonly string[], body = ""): BotFixEnv {
  const base = makeBotFixDraftEnv({ body });
  return { ...base, checks: { ...base.checks, gates: names.map((name) => ({ name, command: `run ${name}` })) } };
}

beforeEach(() => {
  spyOn(_fixReportDeps, "waitForPrHead").mockResolvedValue(true);
  spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue(greenCi);
  spyOn(_fixReportDeps, "readPrInfo").mockImplementation(async (_ref, _forge, _root) => {
    return { ...makeBotFixDraftEnv().info, headSha: "abcdef12" };
  });
});
afterEach(() => mock.restore());

describe.each([
  ["plain PR", ""],
  ["workflow PR", NAX_WORKFLOW_PR_MARKER],
])("readyStep head gates, %s", (_label, body) => {
  test("holds when the head configures a gate the bot did not run", async () => {
    const env = envWithBotGates(["test", "typecheck"], body);
    const resolve = spyOn(_fixReportDeps, "readHeadGateNames").mockResolvedValue(["test", "typecheck", "e2e"]);
    const run = spyOn(env.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const result = await readyStep(env, state);
    expect(resolve).toHaveBeenCalledWith(env.checkout.worktree);
    expect(result.patch.markedReady).toBe(false);
    expect(result.patch.readyHeld).toContain("e2e");
    expect(result.patch.readyHeld).toContain("did not run");
    expect(run).not.toHaveBeenCalled();
  });

  test("holds, fail closed, when the head gates cannot be read", async () => {
    const env = envWithBotGates(["test"], body);
    spyOn(_fixReportDeps, "readHeadGateNames").mockRejectedValue(new Error("bad config"));
    const run = spyOn(env.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const result = await readyStep(env, state);
    expect(result.patch.markedReady).toBe(false);
    expect(result.patch.readyHeld).toContain("head gates could not be read");
    expect(run).not.toHaveBeenCalled();
  });

  test("does not hold when the head gates equal the bot's gates", async () => {
    const env = envWithBotGates(["test", "typecheck"], body);
    spyOn(_fixReportDeps, "readHeadGateNames").mockResolvedValue(["typecheck", "test"]);
    const result = await readyStep(env, state);
    expect(result.patch.readyHeld ?? "").not.toContain("did not run");
    expect(result.patch.readyHeld ?? "").not.toContain("head gates could not be read");
  });
});

test("plain PR with matching gates is marked ready", async () => {
  const env = envWithBotGates(["test"]);
  spyOn(_fixReportDeps, "readHeadGateNames").mockResolvedValue(["test"]);
  const run = spyOn(env.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  expect(await readyStep(env, state)).toEqual({ patch: { markedReady: true }, exit: "report" });
  expect(run).toHaveBeenCalledTimes(1);
});

test("readyOnly state is held too", async () => {
  const env = envWithBotGates(["test"]);
  spyOn(_fixReportDeps, "readHeadGateNames").mockResolvedValue(["test", "e2e"]);
  const result = await readyStep(env, { step: "ready", timings: {}, readyOnly: true, outcome: "ready-pass" });
  expect(result.patch.readyHeld).toContain("e2e");
});
