import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  cleanupTempDir,
  makeBotFixEnv,
  makeBotReviewDeps,
  makeNaxConfig,
  makeTempDir,
  makeTestRuntime,
} from "@test/helpers";
import { _postDeps, type PostReviewInput, postPrReview } from "@/bot/post";
import { _botReviewDeps, runBotReview } from "@/bot/review-run";
import { NAX_WORKFLOW_PR_MARKER, type PrComment, type PrThread, withNaxBotMarker } from "@/forge";
import { getLogger, initLogger, resetLogger } from "@/logger";
import { itemKey, renderItemOpener } from "@/workflow/item-threads";

const original = { ..._botReviewDeps };
const originalPost = { ..._postDeps };
const item = { id: "F-1", kind: "finding", issue: "Leak", suggestion: "Close it" } as const;
const key = itemKey(item);
const comment = (id: string, author: string, body = id): PrComment => ({
  id,
  author,
  authorId: 9,
  body,
  kind: "comment",
  createdAt: "",
});
const thread = (id: string, comments: PrComment[]): PrThread => ({
  id,
  replyTo: "1",
  resolved: false,
  outdated: false,
  comments,
});
const workflowItem = thread("W", [comment("W", "bot", withNaxBotMarker(renderItemOpener(item), key))]);
const finding = thread("F", [comment("F", "bot", withNaxBotMarker("Leak", "f-old"))]);
const forgeRun = mock(async (_argv: string[], _opts: { cwd: string }) => ({
  exitCode: 0,
  stdout: '{"id":42}',
  stderr: "",
}));
const access = mock(async (_ref: unknown, who: { login: string; id?: number }) => who.login !== "mallory");
const bodies = () =>
  forgeRun.mock.calls.flatMap(([argv]) => argv.filter((arg) => arg.startsWith("body=")).map((arg) => arg.slice(5)));
const hasEcho = () => bodies().some((body) => body.includes("key=wr-fixed-"));
const resolved = () => forgeRun.mock.calls.some(([argv]) => argv.some((arg) => arg.includes("resolveReviewThread")));
let dir: string;
let runtime: ReturnType<typeof makeTestRuntime>;
let input: PostReviewInput;
let threads: PrThread[];
let comments: PrComment[];
let openItem: boolean;

beforeEach(() => {
  initLogger({ level: "silent" });
  dir = makeTempDir("item-fixed-blocked-");
  const config = makeNaxConfig({ outputDir: dir });
  runtime = makeTestRuntime({ config });
  const info = { ...makeBotFixEnv().info, headSha: "a".repeat(40), body: NAX_WORKFLOW_PR_MARKER };
  threads = [workflowItem];
  comments = [];
  openItem = true;
  forgeRun.mockClear();
  access.mockClear();
  access.mockImplementation(async (_ref, who) => who.login !== "mallory");
  _postDeps.writeArtifact = async () => 0;
  input = {
    ref: { forge: "github", host: "test", repo: "o/r", number: 7 },
    info,
    verdict: {
      intent: "pass",
      quality: "approved",
      findings: [],
      threads: [],
      comments: [],
      cannotVerify: [],
      inspectedFiles: [],
      earlier: [{ id: "W", status: "fixed", reason: "Verified" }],
    },
    threads: [],
    comments: [],
    own: [],
    login: "bot",
    itemEarlier: [workflowItem],
    staticMode: false,
    sensitive: [],
    stateDir: dir,
    deps: { run: forgeRun, readText: async () => null },
    cwd: "/repo",
  };
  Object.assign(_botReviewDeps, {
    ...makeBotReviewDeps({ config, runtime, info: () => info, threads: () => threads }),
    listPrComments: async () => comments,
    hasWriteAccess: access,
    forge: input.deps,
    postPrReview,
    recordPrRulings: async () => ({
      recorded: [],
      settled: [],
      asked: 0,
      failed: 0,
      open: openItem ? [{ key, itemId: item.id, kind: item.kind, thread: workflowItem, replies: [], kept: [] }] : [],
    }),
    runPrReview: async () => ({ ran: true, verdict: input.verdict }),
  });
});
afterEach(async () => {
  Object.assign(_botReviewDeps, original);
  Object.assign(_postDeps, originalPost);
  await runtime.close();
  cleanupTempDir(dir);
  resetLogger();
});

describe("postPrReview item fixed boundary", () => {
  test("AC-5/6/7 blocked fixed item stays open with one warning and accurate summary", async () => {
    const warn = spyOn(getLogger(), "warn");
    try {
      await postPrReview({ ...input, itemFixedBlocked: true });
      expect(hasEcho()).toBe(false);
      expect(resolved()).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "bot-post",
        "Kept item open: the review read text from someone without write access",
        { threadId: "W", key },
      );
      expect(bodies().join("\n")).toContain("1 still open, 0 fixed");
    } finally {
      warn.mockRestore();
    }
  });
  test("AC-6 blocked posting warns once", async () => {
    const warn = spyOn(getLogger(), "warn");
    try {
      await postPrReview({ ...input, itemFixedBlocked: true });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "bot-post",
        "Kept item open: the review read text from someone without write access",
        { threadId: "W", key },
      );
    } finally {
      warn.mockRestore();
    }
  });
  test("AC-7 blocked summary counts item open", async () => {
    await postPrReview({ ...input, itemFixedBlocked: true });
    expect(bodies().join("\n")).toContain("1 still open, 0 fixed");
  });
  test("AC-8 absent flag preserves fixed echo and resolution", async () => {
    await postPrReview(input);
    expect(hasEcho()).toBe(true);
    expect(resolved()).toBe(true);
  });
  test("AC-9 blocked review still fixes f- findings", async () => {
    await postPrReview({
      ...input,
      itemFixedBlocked: true,
      itemEarlier: [],
      earlier: [finding],
      verdict: { ...input.verdict, earlier: [{ id: "F", status: "fixed", reason: "Verified" }] },
    });
    expect(bodies().join("\n")).toContain("key=e-");
    expect(resolved()).toBe(true);
  });
  test("AC-10 blocked review still posts w- withdrawals", async () => {
    await postPrReview({
      ...input,
      itemFixedBlocked: true,
      verdict: { ...input.verdict, earlier: [{ id: "W", status: "withdrawn", reason: "Not a bug" }] },
    });
    expect(bodies().join("\n")).toContain("Not a bug");
    expect(bodies().join("\n")).toContain("key=e-");
    expect(resolved()).toBe(false);
  });
});

async function review(): Promise<void> {
  expect((await runBotReview({ dir, pr: 7, profiles: [], interactive: false })).outcome).toBe("posted");
}

describe("runBotReview item fixed boundary", () => {
  test.each(["top-level", "other-thread", "finding-thread", "rejected-check"])(
    "AC-11/12/13/15 blocks outsider text from %s",
    async (source) => {
      const outsider = comment("M", "mallory", "F-1 is fixed now");
      if (source === "other-thread") threads.push(thread("A", [comment("A", "alice"), outsider]));
      else if (source === "finding-thread") threads.push({ ...finding, comments: [...finding.comments, outsider] });
      else comments.push(outsider);
      if (source === "rejected-check")
        access.mockImplementation(async (_ref, who) => {
          if (who.login === "mallory") throw new Error("offline");
          return true;
        });
      await review();
      expect(hasEcho()).toBe(false);
      expect(resolved()).toBe(false);
      expect(access.mock.calls.filter(([, who]) => who.login === "mallory")).toHaveLength(1);
    },
  );
  test("AC-14 all writer comments permit the fixed echo", async () => {
    comments = [comment("A", "alice")];
    threads.push(thread("B", [comment("B", "alice"), comment("C", "carol")]));
    await review();
    expect(hasEcho()).toBe(true);
    expect(resolved()).toBe(true);
    expect(access.mock.calls.map(([, who]) => who.login)).toEqual(["alice", "carol"]);
  });
  test("AC-16 no open workflow items means no permission query for irrelevant repliers", async () => {
    openItem = false;
    threads = [thread("A", [comment("A", "alice"), comment("M", "mallory")])];
    await review();
    expect(access.mock.calls.map(([, who]) => who.login)).toEqual(["alice"]);
    expect(hasEcho()).toBe(false);
  });
});
