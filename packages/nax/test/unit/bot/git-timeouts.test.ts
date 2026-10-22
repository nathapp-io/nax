import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeBotFixEnv } from "@test/helpers";
import { _checkoutDeps, BOT_GIT_NETWORK_TIMEOUT_MS, preparePrCheckout } from "@/bot/checkout";
import { _fixInputDeps, checkPushAccess } from "@/bot/fix-input";
import { renderFixSummary } from "@/bot/fix-report";
import { _gateBaselineDeps, failingOnHead } from "@/bot/gate-baseline";

const checkoutOriginal = { ..._checkoutDeps };
const inputOriginal = { ..._fixInputDeps };
const baselineOriginal = { ..._gateBaselineDeps };
const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
afterEach(() => {
  Object.assign(_checkoutDeps, checkoutOriginal);
  Object.assign(_fixInputDeps, inputOriginal);
  Object.assign(_gateBaselineDeps, baselineOriginal);
});

describe("bot slow git timeouts", () => {
  test("AC-6 exports the shared 120 second timeout", () => {
    expect(BOT_GIT_NETWORK_TIMEOUT_MS).toBe(120_000);
  });
  test("AC-7/8 extends the combined fetch and worktree add, not other git commands", async () => {
    const env = makeBotFixEnv();
    const run = mock<typeof _checkoutDeps.runGit>(async (argv) => {
      return ok(argv[0] === "rev-parse" ? (argv[1]?.endsWith("/base") ? "base" : env.info.headSha) : "");
    });
    Object.assign(_checkoutDeps, {
      runGit: run,
      ensureGitExcludes: async () => {},
      reserveWorktree: async () => {},
      mkdtemp: async () => "/snapshot",
      snapshotBaseNax: async () => true,
      rm: async () => {},
      rmdir: async () => {},
    });
    const checkout = await preparePrCheckout({
      repoRoot: env.repoRoot,
      ref: env.ref,
      info: env.info,
      suffix: "timeout",
      pinBaseFiles: false,
    });
    await checkout.dispose();
    const slow = run.mock.calls.filter(
      ([argv]) => argv[0] === "fetch" || (argv[0] === "worktree" && argv[1] === "add"),
    );
    expect(slow).toHaveLength(2);
    for (const call of slow) expect(call[2]).toBe(120_000);
    for (const call of run.mock.calls.filter((call) => !slow.includes(call))) expect(call[2]).toBeUndefined();
  });
  test("AC-9 extends the push access dry run", async () => {
    const run = mock<typeof _fixInputDeps.runGit>(async () => ok());
    _fixInputDeps.runGit = run;
    expect(await checkPushAccess("/worktree", "topic")).toEqual({ ok: true });
    expect(run).toHaveBeenCalledWith(
      ["push", "--dry-run", "--no-verify", "origin", "HEAD:refs/heads/topic"],
      "/worktree",
      120_000,
    );
  });
  test.each([false, true])("AC-10 extends both head checkouts and restores after gate failure=%s", async (fails) => {
    const failure = new Error("gate execution failed");
    const run = mock<typeof _gateBaselineDeps.runGit>(async () => ok());
    _gateBaselineDeps.runGit = run;
    _gateBaselineDeps.readHead = async () => "fix-sha";
    _gateBaselineDeps.runQualityGates = async () => {
      if (fails) throw failure;
      return { passed: false, ran: ["test"], failing: ["test"], output: "red" };
    };
    const result = failingOnHead("/worktree", "head-sha", []);
    if (fails) await expect(result).rejects.toBe(failure);
    else expect(await result).toEqual(["test"]);
    expect(run).toHaveBeenCalledWith(["checkout", "--detach", "head-sha"], "/worktree", 120_000);
    expect(run).toHaveBeenCalledWith(["checkout", "--detach", "fix-sha"], "/worktree", 120_000);
    expect(run.mock.calls[0]?.[2]).toBeUndefined();
  });
});

describe("renderFixSummary setup failure", () => {
  test("AC-5 renders the exact summary with a code-quoted command", () => {
    expect(
      renderFixSummary({ step: "report", timings: {}, outcome: "setup-failed", setupFailed: "bun install" }),
    ).toContain("Setup failed at `bun install`; nothing ran.");
  });
});
