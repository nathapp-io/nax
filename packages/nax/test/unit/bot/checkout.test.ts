import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeLogger } from "@test/helpers";
import { checkoutRefs } from "@/bot";
import { _checkoutDeps, BOT_GIT_NETWORK_TIMEOUT_MS, botWorktreePath, preparePrCheckout } from "@/bot/checkout";
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
let calls: { argv: string[]; cwd: string; timeoutMs?: number }[];
let events: string[];
const refs = { head: "refs/nax-bot/pr-42/checkout-ab12cd34/head", base: "refs/nax-bot/pr-42/checkout-ab12cd34/base" };
function expectRefCleanup(): void {
  for (const name of Object.values(refs))
    expect(calls).toContainEqual({ argv: ["update-ref", "-d", name], cwd: "/r", timeoutMs: undefined });
}
const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
beforeEach(() => {
  calls = [];
  events = [];
  _checkoutDeps.runGit = mock(async (argv, cwd, timeoutMs) => {
    calls.push({ argv, cwd, timeoutMs });
    events.push(argv.join(" "));
    if (argv[0] === "rev-parse") return ok(argv[1] === refs.base ? "base" : argv[1] === refs.head ? "head" : "");
    if (argv[0] === "merge-base") return ok("ancestor\n");
    return ok();
  });
  _checkoutDeps.ensureGitExcludes = mock(async (root) => {
    events.push(`exclude ${root}`);
  });
  _checkoutDeps.snapshotBaseNax = mock(async () => true);
  _checkoutDeps.mkdtemp = mock(async () => "/snapshot");
  _checkoutDeps.reserveWorktree = mock(async (path) => {
    events.push(`reserve ${path}`);
  });
  _checkoutDeps.rmdir = mock(async () => {});
  _checkoutDeps.rm = mock(async () => {});
});
afterEach(() => Object.assign(_checkoutDeps, original));

describe("checkoutRefs", () => {
  test("US-003 AC-1: exports run-owned head and base names", () => {
    expect(checkoutRefs(42, "ab12cd34")).toEqual(refs);
  });
});
describe("botWorktreePath", () => {
  test.each(["../../../../etc/x", "a/b", "a\\b", ""])("rejects unsafe suffix %s", (suffix) => {
    expect(() => botWorktreePath("/r", 42, suffix)).toThrow("Invalid checkout suffix");
  });
  test("AC-1: lives beneath the trusted repo root", () => {
    expect(botWorktreePath("/r", 42, "ab12cd34")).toBe("/r/.nax-wt/bot-pr-42-ab12cd34");
  });
});
describe("preparePrCheckout", () => {
  test("US-003 AC-4: never reads shared FETCH_HEAD", async () => {
    await preparePrCheckout(input);
    expect(calls.some(({ argv }) => argv.includes("FETCH_HEAD"))).toBe(false);
  });
  test("US-003 AC-6: reserves checkout before fetching", async () => {
    await preparePrCheckout(input);
    expect(events.indexOf(`reserve ${botWorktreePath("/r", 42, input.suffix)}`)).toBeLessThan(
      events.findIndex((event) => event.startsWith("fetch ")),
    );
  });
  test("US-003 AC-11: moved head removes reserved directory", async () => {
    await expect(preparePrCheckout({ ...input, info: { ...info, headSha: "old" } })).rejects.toMatchObject({
      code: "BOT_PR_HEAD_MOVED",
    });
    expect(_checkoutDeps.rm).toHaveBeenCalledWith(botWorktreePath("/r", 42, input.suffix));
  });
  test("US-003 AC-15/16: pinning failure removes worktree and allocated snapshot", async () => {
    const run = _checkoutDeps.runGit;
    const cause = new Error("pinning failed");
    _checkoutDeps.runGit = async (argv, cwd) => {
      if (argv[0] === "ls-files") throw cause;
      return run(argv, cwd);
    };
    await expect(preparePrCheckout({ ...input, pinBaseFiles: true })).rejects.toBe(cause);
    expect(calls).toContainEqual({
      argv: ["worktree", "remove", "--force", botWorktreePath("/r", 42, input.suffix)],
      cwd: "/r",
      timeoutMs: undefined,
    });
    expect(_checkoutDeps.rm).toHaveBeenCalledWith("/snapshot");
    expectRefCleanup();
  });
  test("US-003 AC-7: invalid suffix prevents fetch", async () => {
    await expect(preparePrCheckout({ ...input, suffix: "a/b" })).rejects.toMatchObject({
      code: "BOT_CHECKOUT_SUFFIX_INVALID",
    });
    expect(calls).toEqual([]);
  });
  test("US-003 AC-12: failed fetch cleans only owned reservation and refs", async () => {
    const run = _checkoutDeps.runGit;
    _checkoutDeps.runGit = async (argv, cwd) =>
      argv[0] === "fetch" ? { exitCode: 1, stdout: "", stderr: "network failed" } : run(argv, cwd);
    await expect(preparePrCheckout(input)).rejects.toMatchObject({ code: "BOT_CHECKOUT_FAILED" });
    expect(_checkoutDeps.rm).toHaveBeenCalledWith(botWorktreePath("/r", 42, input.suffix));
    expectRefCleanup();
    expect(calls.some(({ argv }) => argv[0] === "worktree")).toBe(false);
  });
  test("a failed exclusive reservation never adds or cleans up a pre-existing path", async () => {
    const collision = Object.assign(new Error("checkout already exists"), { code: "EEXIST" });
    _checkoutDeps.reserveWorktree = mock(async () => {
      throw collision;
    });
    await expect(preparePrCheckout(input)).rejects.toBe(collision);
    expect(calls.some(({ argv }) => argv[0] === "worktree")).toBe(false);
    expect(_checkoutDeps.rm).not.toHaveBeenCalled();
    expect(calls.some(({ argv }) => ["fetch", "update-ref"].includes(argv[0] ?? ""))).toBe(false);
  });
  test("a failed worktree add still unwinds its registration", async () => {
    const run = _checkoutDeps.runGit;
    _checkoutDeps.runGit = async (argv, cwd) => {
      if (argv[0] === "worktree" && argv[1] === "add") return { exitCode: 128, stdout: "", stderr: "partial add" };
      return run(argv, cwd);
    };
    await expect(preparePrCheckout(input)).rejects.toThrow("partial add");
    expect(calls).toContainEqual({
      argv: ["worktree", "remove", "--force", botWorktreePath("/r", 42, input.suffix)],
      cwd: "/r",
      timeoutMs: undefined,
    });
  });
  test("a timed out base path read fails instead of silently omitting rules", async () => {
    const run = _checkoutDeps.runGit;
    _checkoutDeps.runGit = async (argv, cwd) =>
      argv[0] === "ls-tree" ? { exitCode: 1, stdout: "", stderr: "", timedOut: true } : run(argv, cwd);
    await expect(preparePrCheckout({ ...input, pinBaseFiles: true })).rejects.toMatchObject({
      code: "BOT_CHECKOUT_FAILED",
    });
  });
  test.each([
    ["github", "pull/42/head"],
    ["gitlab", "merge-requests/42/head"],
  ] as const)("AC-2/3: fetches %s PR ref in repo root", async (forge, spec) => {
    await preparePrCheckout({ ...input, ref: { ...ref, forge } });
    expect(calls.filter(({ argv }) => argv[0] === "fetch")).toEqual([
      {
        argv: ["fetch", "--no-tags", "origin", `+${spec}:${refs.head}`, `+refs/heads/main:${refs.base}`],
        cwd: "/r",
        timeoutMs: BOT_GIT_NETWORK_TIMEOUT_MS,
      },
    ]);
  });
  test("AC-4/5: moved heads fail before worktree creation", async () => {
    const result = preparePrCheckout({ ...input, info: { ...info, headSha: "old" } });
    await expect(result).rejects.toBeInstanceOf(NaxError);
    await expect(result).rejects.toMatchObject({ code: "BOT_PR_HEAD_MOVED" });
    expect(calls.some(({ argv }) => argv[0] === "worktree")).toBe(false);
    expectRefCleanup();
    expect(_checkoutDeps.rm).toHaveBeenCalledWith(botWorktreePath("/r", 42, input.suffix));
  });
  test("AC-6/7/8/9: fetches base, computes ancestor and excludes before detached checkout", async () => {
    const checkout = await preparePrCheckout(input);
    expect(checkout.baseSha).toBe("base");
    expect(calls).toContainEqual({ argv: ["rev-parse", refs.base], cwd: "/r", timeoutMs: undefined });
    expect(calls.some(({ argv }) => argv.includes("FETCH_HEAD"))).toBe(false);
    const fetchIndex = events.findIndex((event) => event.startsWith("fetch "));
    expect(events.indexOf(`reserve ${checkout.worktree}`)).toBeLessThan(fetchIndex);
    expect(_checkoutDeps.reserveWorktree).toHaveBeenCalledWith(checkout.worktree);
    expect(checkout.mergeBase).toBe("ancestor");
    expect(calls).toContainEqual({ argv: ["merge-base", "base", "head"], cwd: "/r", timeoutMs: undefined });
    expect(_checkoutDeps.ensureGitExcludes).toHaveBeenCalledWith("/r");
    const add = "worktree add --detach /r/.nax-wt/bot-pr-42-ab12cd34 head";
    expect(events.indexOf("exclude /r")).toBeLessThan(events.indexOf(add));
    expect(calls).toContainEqual({ argv: add.split(" "), cwd: "/r", timeoutMs: BOT_GIT_NETWORK_TIMEOUT_MS });
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
      timeoutMs: undefined,
    });
    expect(_checkoutDeps.rm).toHaveBeenCalledWith("/snapshot");
    expectRefCleanup();
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
  test("releases checkout refs before removing the exclusive reservation", async () => {
    const checkout = await preparePrCheckout(input);
    calls = [];
    await checkout.dispose();
    expect(calls.slice(0, 2).map(({ argv }) => argv)).toEqual([
      ["update-ref", "-d", refs.head],
      ["update-ref", "-d", refs.base],
    ]);
  });
  test.each([false, true])("US-003 AC-17/18/19: deletes refs with retained=%s", async (retained) => {
    const checkout = await preparePrCheckout(input);
    calls = [];
    if (retained) checkout.retain?.();
    await checkout.dispose();
    expectRefCleanup();
    expect(calls.some(({ argv }) => argv[0] === "worktree")).toBe(!retained);
  });
  test("US-003 AC-20/21: ref deletion errors warn and resolve", async () => {
    const checkout = await preparePrCheckout(input);
    const logger = makeLogger();
    _checkoutDeps.getLogger = () => logger;
    const run = _checkoutDeps.runGit;
    _checkoutDeps.runGit = async (argv, cwd) =>
      argv[0] === "update-ref" ? { exitCode: 1, stdout: "", stderr: "locked ref" } : run(argv, cwd);
    await expect(checkout.dispose()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      "bot",
      "Failed to dispose PR checkout artifact",
      expect.objectContaining({ error: expect.stringContaining("locked ref") }),
    );
  });
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
    expect(logger.warn).toHaveBeenCalledTimes(4);
  });
});
