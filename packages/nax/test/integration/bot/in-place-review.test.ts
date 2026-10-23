import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeBotFixEnv, makeBotReviewDeps, makeTempDir, makeTestRuntime } from "@test/helpers";
import { _botReviewDeps, runBotReview } from "@/bot";
import { botGit } from "@/bot/git";
import { initLogger, resetLogger } from "@/logger";

const original = { ..._botReviewDeps };
let runtime: ReturnType<typeof makeTestRuntime>;
let repoRoot: string;
const input = { dir: "/repo", pr: 7, profiles: [], interactive: false, inPlace: true };
const checkout = () => ({
  worktree: repoRoot,
  snapshotDir: "/snapshot",
  baseSha: "base",
  mergeBase: "merge",
  hasBaseNax: true,
  changedFiles: [],
  inPlace: true,
  startHead: "head",
  dispose: mock(async () => {}),
});
let prepared: ReturnType<typeof checkout>;
const inPlace = mock(async (_input: { repoRoot: string; suffix: string }) => prepared);
const isolated = mock(async () => prepared);
const review = mock(async () => ({ ran: false as const, why: "test stop" }));

beforeEach(async () => {
  initLogger({ level: "silent" });
  repoRoot = makeTempDir("in-place-review-");
  for (const argv of [
    ["init"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.com"],
    ["commit", "--allow-empty", "-m", "initial"],
  ]) {
    const result = await botGit(argv, repoRoot);
    expect(result.exitCode).toBe(0);
  }
  const env = makeBotFixEnv();
  runtime = makeTestRuntime({ config: env.config });
  prepared = checkout();
  inPlace.mockClear();
  isolated.mockClear();
  review.mockClear();
  Object.assign(_botReviewDeps, makeBotReviewDeps({ config: env.config, runtime, info: () => env.info }), {
    gitToplevel: async () => repoRoot,
    prepareInPlaceCheckout: inPlace,
    preparePrCheckout: isolated,
    runPrReview: review,
    runGit: botGit,
    randomSuffix: () => "test",
  });
});
afterEach(async () => {
  Object.assign(_botReviewDeps, original);
  await runtime?.close();
  cleanupTempDir(repoRoot);
  resetLogger();
});

describe("runBotReview in-place", () => {
  test("trusted review selects in-place and never isolated checkout (AC-5/6)", async () => {
    const result = await runBotReview(input);
    expect(inPlace).toHaveBeenCalledWith(expect.objectContaining({ repoRoot, suffix: "test" }));
    expect(isolated).not.toHaveBeenCalled();
    expect(review).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ outcome: "not-reviewed", reason: "test stop" });
    expect(prepared.dispose).toHaveBeenCalledTimes(1);
  });
  test("untrusted PR refuses without either checkout (AC-7/8)", async () => {
    _botReviewDeps.classifyPrTrust = async () => ({ trusted: false, headSha: "head", reasons: [] });
    const result = await runBotReview(input);
    expect(result).toEqual({ outcome: "refused", reason: "--in-place needs a trusted PR" });
    expect(inPlace).not.toHaveBeenCalled();
    expect(isolated).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
  });
  test("setup untracked file refuses even when git hides untracked files (AC-9/10)", async () => {
    expect((await botGit(["config", "status.showUntrackedFiles", "no"], repoRoot)).exitCode).toBe(0);
    _botReviewDeps.runPreRunSteps = async ({ workdir }) => {
      await Bun.write(join(workdir, "setup-generated.txt"), "untracked");
    };
    const result = await runBotReview(input);
    expect(result).toEqual({ outcome: "refused", reason: "in-place checkout not clean after setup" });
    expect(review).not.toHaveBeenCalled();
    expect(prepared.dispose).toHaveBeenCalledTimes(1);
    expect((await botGit(["status", "--porcelain", "--untracked-files=all"], repoRoot)).stdout).toContain(
      "?? setup-generated.txt",
    );
  });
});
