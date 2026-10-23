import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { prepareInPlaceCheckout } from "@/bot";
import { _checkoutDeps, checkoutRefs, preparePrCheckout } from "@/bot/checkout";
import { PROJECT_FEATURES_DIR } from "@/config";
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
  headRef: "feat/x",
  headSha: "head",
  crossRepo: false,
};
const input = { repoRoot: "/r", ref, info, suffix: "test" };
const refs = checkoutRefs(42, "test");
const ledger = `${PROJECT_FEATURES_DIR}/f/decisions.jsonl`;
const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
let calls: string[][];
let events: string[];
let replies: Map<string, ReturnType<typeof ok> | Error>;
function cleanupExpected(): void {
  for (const name of Object.values(refs)) expect(calls).toContainEqual(["update-ref", "-d", name]);
  expect(calls.some((argv) => argv[0] === "worktree")).toBe(false);
  expect(_checkoutDeps.rm).not.toHaveBeenCalledWith("/r");
}
beforeEach(() => {
  calls = [];
  events = [];
  replies = new Map();
  _checkoutDeps.runGit = mock(async (argv) => {
    calls.push(argv);
    events.push(argv.join(" "));
    const reply = replies.get(argv.join(" "));
    if (reply instanceof Error) throw reply;
    if (reply) return reply;
    if (argv[0] === "symbolic-ref") return ok("feat/x\n");
    if (argv[0] === "rev-parse") return ok(argv[1] === refs.base ? "base\n" : "head\n");
    if (argv[0] === "merge-base" && argv[1] !== "--is-ancestor") return ok("ancestor\n");
    if (argv.join(" ") === "diff --name-only -z --no-renames ancestor head") return ok("src/pr.ts\0");
    return ok();
  });
  _checkoutDeps.ensureGitExcludes = mock(async (root) => {
    events.push(`exclude ${root}`);
  });
  _checkoutDeps.mkdtemp = mock(async () => "/snapshot");
  _checkoutDeps.snapshotBaseNax = mock(async () => true);
  _checkoutDeps.rm = mock(async () => {});
  _checkoutDeps.rmdir = mock(async () => {});
  _checkoutDeps.reserveWorktree = mock(async () => {});
});
afterEach(() => Object.assign(_checkoutDeps, original));

describe("prepareInPlaceCheckout", () => {
  test("AC-1/2/3/4/6: prepares main checkout without switching or pinning", async () => {
    const result = await prepareInPlaceCheckout(input);
    expect(result).toMatchObject({
      worktree: "/r",
      inPlace: true,
      startHead: "head",
      baseSha: "base",
      mergeBase: "ancestor",
      snapshotDir: "/snapshot",
      hasBaseNax: true,
    });
    expect(events[0]).toBe("exclude /r");
    expect(_checkoutDeps.ensureGitExcludes).toHaveBeenCalledWith("/r");
    expect(calls.some((argv) => ["worktree", "checkout", "ls-tree", "ls-files"].includes(argv[0] ?? ""))).toBe(false);
    expect(calls).toContainEqual(["rev-parse", refs.base]);
    expect(_checkoutDeps.snapshotBaseNax).toHaveBeenCalledWith("/r", "base", "/snapshot");
  });
  test("AC-5: uses exactly the isolated checkout fetch argv", async () => {
    await prepareInPlaceCheckout(input);
    const fetched = calls.filter((argv) => argv[0] === "fetch");
    calls = [];
    await preparePrCheckout({ ...input, pinBaseFiles: false });
    expect(fetched).toHaveLength(1);
    expect(fetched).toEqual(calls.filter((argv) => argv[0] === "fetch"));
  });
  test("AC-7/15: ledger-only local HEAD is admitted but not listed in PR files", async () => {
    replies.set("rev-parse HEAD", ok("local-ledger\n"));
    replies.set("diff --name-only -z --no-renames head HEAD", ok(`${ledger}\0`));
    const result = await prepareInPlaceCheckout(input);
    expect(result.startHead).toBe("local-ledger");
    expect(result.changedFiles).toEqual(["src/pr.ts"]);
    expect(calls).toContainEqual(["diff", "--name-only", "-z", "--no-renames", "ancestor", "head"]);
  });
  test.each([
    ["AC-8 cross repo", "", ok(), "another repository"],
    ["AC-9 wrong branch", "symbolic-ref --short HEAD", ok("main\n"), "check out feat/x first"],
    [
      "AC-10 detached",
      "symbolic-ref --short HEAD",
      { exitCode: 1, stdout: "", stderr: "detached" },
      "check out feat/x first",
    ],
    ["AC-11 untracked", "status --porcelain --untracked-files=all", ok("?? notes.txt\n"), "working tree is not clean"],
  ] as const)("%s refuses before fetch", async (label, command, reply, message) => {
    replies.set(command, reply);
    await expect(
      prepareInPlaceCheckout({ ...input, info: { ...info, crossRepo: label.startsWith("AC-8") } }),
    ).rejects.toMatchObject({ code: "BOT_IN_PLACE_REFUSED", message: expect.stringContaining(message) });
    expect(calls.some((argv) => argv[0] === "fetch")).toBe(false);
  });
  test.each([
    ["AC-12 moved head", `rev-parse ${refs.head}`, ok("moved"), "BOT_PR_HEAD_MOVED", "head moved"],
    [
      "AC-13 behind",
      "merge-base --is-ancestor head HEAD",
      { exitCode: 1, stdout: "", stderr: "" },
      "BOT_IN_PLACE_REFUSED",
      "pull first",
    ],
    [
      "AC-14 extra commit",
      "diff --name-only -z --no-renames head HEAD",
      ok("src/a.ts\0"),
      "BOT_IN_PLACE_REFUSED",
      "commits the PR does not have",
    ],
    [
      "AC-16 diff failure",
      "diff --name-only -z --no-renames head HEAD",
      { exitCode: 128, stdout: "", stderr: "bad diff" },
      "BOT_CHECKOUT_FAILED",
      "bad diff",
    ],
    [
      "AC-20 thrown diff",
      "diff --name-only -z --no-renames head HEAD",
      new Error("spawn failed"),
      "BOT_CHECKOUT_FAILED",
      "spawn failed",
    ],
    [
      "AC-20 ancestry failure",
      "merge-base --is-ancestor head HEAD",
      { exitCode: 128, stdout: "", stderr: "bad ancestry" },
      "BOT_CHECKOUT_FAILED",
      "bad ancestry",
    ],
    [
      "AC-20 thrown ancestry",
      "merge-base --is-ancestor head HEAD",
      new Error("spawn failed"),
      "BOT_CHECKOUT_FAILED",
      "spawn failed",
    ],
    [
      "AC-20 HEAD failure",
      "rev-parse HEAD",
      { exitCode: 128, stdout: "", stderr: "bad HEAD" },
      "BOT_CHECKOUT_FAILED",
      "bad HEAD",
    ],
  ] as const)("%s cleans refs without touching checkout", async (_label, command, reply, code, message) => {
    replies.set(command, reply);
    await expect(prepareInPlaceCheckout(input)).rejects.toMatchObject({
      code,
      message: expect.stringContaining(message),
    });
    cleanupExpected();
  });
  test.each([
    `${PROJECT_FEATURES_DIR}/f/nested/decisions.jsonl`,
    `${PROJECT_FEATURES_DIR}/decisions.jsonl`,
    `${PROJECT_FEATURES_DIR}/f/other.jsonl`,
  ])("rejects non-ledger path %s", async (path) => {
    replies.set("diff --name-only -z --no-renames head HEAD", ok(`${path}\0`));
    await expect(prepareInPlaceCheckout(input)).rejects.toMatchObject({ code: "BOT_IN_PLACE_REFUSED" });
    cleanupExpected();
  });
  test.each([
    [ok("src/a.ts\0src/a.ts\0"), "BOT_IN_PLACE_REFUSED"],
    [{ exitCode: 128, stdout: "", stderr: "log failed" }, "BOT_CHECKOUT_FAILED"],
    [new Error("log spawn failed"), "BOT_CHECKOUT_FAILED"],
  ] as const)("F1: historical path scan rejects unsafe history or scan failure %#", async (reply, code) => {
    replies.set("log --format= --name-only -z --no-renames -m head..HEAD", reply);
    await expect(prepareInPlaceCheckout(input)).rejects.toMatchObject({ code });
    cleanupExpected();
  });
  test("AC-17/18: disposal deletes only refs and snapshot", async () => {
    const result = await prepareInPlaceCheckout(input);
    calls = [];
    await result.dispose();
    cleanupExpected();
    expect(calls).toHaveLength(2);
    expect(_checkoutDeps.rm).toHaveBeenCalledTimes(1);
    expect(_checkoutDeps.rm).toHaveBeenCalledWith("/snapshot");
    expect(_checkoutDeps.rmdir).not.toHaveBeenCalled();
  });
});
