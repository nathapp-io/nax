import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeLogger } from "@test/helpers";
import { _checkoutDeps, botWorktreePath, preparePrCheckout } from "@/bot/checkout";
import { NaxError } from "@/errors";
import type { PrInfo, PrRef } from "@/forge";

const original = { ..._checkoutDeps };
const ref: PrRef = { forge: "github", host: "github.com", repo: "o/r", number: 42 };
const info: PrInfo = {
  number: 42,
  title: "PR",
  body: "",
  url: "",
  state: "open",
  draft: false,
  author: { login: "a" },
  baseRef: "main",
  headRef: "topic",
  headSha: "head",
  crossRepo: true,
};
const input = { repoRoot: "/r", ref, info, suffix: "ab12cd34", pinBaseFiles: false };
let calls: { argv: string[]; cwd: string }[];
let events: string[];
let fetched: string;
const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
beforeEach(() => {
  calls = [];
  events = [];
  fetched = "head";
  _checkoutDeps.runGit = mock(async (argv, cwd) => {
    calls.push({ argv, cwd });
    events.push(argv.join(" "));
    if (argv[0] === "fetch") fetched = argv[2] === "main" ? "base" : "head";
    if (argv[0] === "rev-parse") return ok(fetched);
    if (argv[0] === "merge-base") return ok("ancestor\n");
    return ok();
  });
  _checkoutDeps.ensureGitExcludes = mock(async (root) => {
    events.push(`exclude ${root}`);
  });
  _checkoutDeps.snapshotBaseNax = mock(async () => true);
  _checkoutDeps.mkdtemp = mock(async () => "/snapshot");
  _checkoutDeps.rm = mock(async () => {});
});
afterEach(() => Object.assign(_checkoutDeps, original));

describe("botWorktreePath", () => {
  test("AC-1: lives beneath the trusted repo root", () => {
    expect(botWorktreePath("/r", 42, "ab12cd34")).toBe("/r/.nax-wt/bot-pr-42-ab12cd34");
  });
});
describe("preparePrCheckout", () => {
  test.each([
    ["github", "pull/42/head"],
    ["gitlab", "merge-requests/42/head"],
  ] as const)("AC-2/3: fetches %s PR ref in repo root", async (forge, spec) => {
    await preparePrCheckout({ ...input, ref: { ...ref, forge } });
    expect(calls[0]).toEqual({ argv: ["fetch", "origin", spec], cwd: "/r" });
  });
  test("AC-4/5: moved heads fail before worktree creation", async () => {
    const result = preparePrCheckout({ ...input, info: { ...info, headSha: "old" } });
    await expect(result).rejects.toBeInstanceOf(NaxError);
    await expect(result).rejects.toMatchObject({ code: "BOT_PR_HEAD_MOVED" });
    expect(calls.some(({ argv }) => argv[0] === "worktree")).toBe(false);
  });
  test("AC-6/7/8/9: fetches base, computes ancestor and excludes before detached checkout", async () => {
    const checkout = await preparePrCheckout(input);
    expect(checkout.baseSha).toBe("base");
    expect(checkout.mergeBase).toBe("ancestor");
    expect(calls).toContainEqual({ argv: ["merge-base", "base", "head"], cwd: "/r" });
    expect(_checkoutDeps.ensureGitExcludes).toHaveBeenCalledWith("/r");
    const add = "worktree add --detach /r/.nax-wt/bot-pr-42-ab12cd34 head";
    expect(events.indexOf("exclude /r")).toBeLessThan(events.indexOf(add));
    expect(calls).toContainEqual({ argv: add.split(" "), cwd: "/r" });
    expect(_checkoutDeps.snapshotBaseNax).toHaveBeenCalledWith("/r", "base", "/snapshot");
    expect(checkout.hasBaseNax).toBe(true);
  });
  test("AC-18: snapshot failure removes worktree and rethrows identical error", async () => {
    const cause = new Error("snapshot failed");
    _checkoutDeps.snapshotBaseNax = mock(async () => {
      throw cause;
    });
    await expect(preparePrCheckout(input)).rejects.toBe(cause);
    expect(calls).toContainEqual({
      argv: ["worktree", "remove", "--force", botWorktreePath("/r", 42, "ab12cd34")],
      cwd: "/r",
    });
    expect(_checkoutDeps.rm).toHaveBeenCalledWith("/snapshot");
  });
  test("AC-21: later failure removes snapshot and preserves error", async () => {
    const run = _checkoutDeps.runGit;
    const cause = new Error("diff failed");
    _checkoutDeps.runGit = mock(async (argv, cwd) => {
      if (argv[0] === "diff") throw cause;
      return run(argv, cwd);
    });
    await expect(preparePrCheckout(input)).rejects.toBe(cause);
    expect(_checkoutDeps.rm).toHaveBeenCalledWith("/snapshot");
    expect(calls.some(({ argv }) => argv[1] === "remove")).toBe(true);
  });
});
describe("dispose", () => {
  test("AC-20/22: nonzero worktree removal warns without throwing and still removes snapshot", async () => {
    const checkout = await preparePrCheckout(input);
    const logger = makeLogger();
    _checkoutDeps.getLogger = () => logger;
    _checkoutDeps.runGit = mock(async () => ({ exitCode: 1, stdout: "", stderr: "locked" }));
    await expect(checkout.dispose()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
    expect(_checkoutDeps.rm).toHaveBeenCalledWith("/snapshot");
  });
  test("thrown removal and snapshot cleanup errors are both nonfatal", async () => {
    const checkout = await preparePrCheckout(input);
    const logger = makeLogger();
    _checkoutDeps.getLogger = () => logger;
    _checkoutDeps.runGit = mock(async () => {
      throw new Error("git failed");
    });
    _checkoutDeps.rm = mock(async () => {
      throw new Error("rm failed");
    });
    await expect(checkout.dispose()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
