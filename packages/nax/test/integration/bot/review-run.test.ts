import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { makeMockCallContext, makeNaxConfig, makeTestRuntime } from "@test/helpers";
import { sensitivePaths } from "@/bot";
import { _botReviewDeps, BOT_REVIEW_GRAPH, runBotReview } from "@/bot/review-run";
import { PROJECT_FEATURES_DIR, resolveWorkflowConfig } from "@/config";
import type { PrComment, PrInfo, PrRef, PrThread } from "@/forge";
import { withNaxBotMarker } from "@/forge";
import type { PrReviewVerdict } from "@/operations";
import { validateStepGraph } from "@/step-graph";
import type { PrStepContext } from "@/workflow/branch-step-context";
import { botRunDir } from "@/workflow/paths";

const original = { ..._botReviewDeps };
const input = { dir: "/repo/sub", pr: 42, profiles: ["a", "b"], interactive: false };
const ref: PrRef = { forge: "github", host: "example.test", repo: "org/repo", number: 42 };
const verdict: PrReviewVerdict = {
  intent: "pass",
  quality: "approved",
  findings: [],
  threads: [],
  comments: [],
  cannotVerify: [],
  inspectedFiles: [],
};
const counts = { inlineFindings: 2, threadsAnswered: 3, commentsAnswered: 4, offLine: 5, failed: 1 };
const comment = (id: string, author = "human", body = id): PrComment => ({
  id,
  author,
  body,
  kind: "comment",
  createdAt: "today",
});
let info: PrInfo;
let config: ReturnType<typeof makeNaxConfig>;
let runtime: ReturnType<typeof makeTestRuntime>;
let events: string[];
let threads: PrThread[];
let comments: PrComment[];
let changedFiles: string[];
const review = mock<typeof _botReviewDeps.runPrReview>(async () => ({ ran: true, verdict }));
const post = mock<typeof _botReviewDeps.postPrReview>(async () => counts);
const checkoutDispose = mock(async () => {});
const contextDispose = mock(async () => {});
const prepare = mock<typeof _botReviewDeps.preparePrCheckout>(async () => ({
  worktree: "/checkout",
  snapshotDir: "/snapshot",
  baseSha: "base",
  mergeBase: "merge",
  hasBaseNax: true,
  changedFiles,
  dispose: checkoutDispose,
}));
const load = mock<typeof _botReviewDeps.loadBotConfig>(async () => config);
const create = mock<typeof _botReviewDeps.createRuntime>(() => runtime);
const write = mock<typeof _botReviewDeps.writeJson>(async () => {});
const issues = [{ number: 7, title: "Issue", body: "Intent", url: "https://example.test/7" }];

beforeEach(() => {
  events = [];
  threads = [];
  comments = [];
  changedFiles = ["src/a.ts", ".github/workflows/ci.yml"];
  info = {
    number: 42,
    title: "Change",
    body: "Closes #7",
    url: "url",
    state: "open",
    draft: false,
    author: { login: "alice" },
    baseRef: "main",
    headRef: "topic",
    headSha: "head",
    crossRepo: false,
  };
  config = makeNaxConfig({
    bot: { models: { review: "powerful" } },
    mcp: { servers: { sample: { command: "server" } } },
  });
  runtime = makeTestRuntime({ config });
  const ctx: PrStepContext = {
    config,
    workflow: resolveWorkflowConfig(config),
    callCtx: makeMockCallContext({ runtime }),
    projectDir: "/checkout",
    runDir: "/artifacts",
    reportPath: "/report",
    feature: "bot-pr-42",
    packageDirs: [],
    dryRun: false,
    pr: { forge: "github", number: 42, base: "merge", head: "head" },
  };
  for (const fn of [review, post, prepare, load, create, write, checkoutDispose, contextDispose]) fn.mockClear();
  review.mockImplementation(async () => ({ ran: true, verdict }));
  post.mockImplementation(async () => counts);
  contextDispose.mockImplementation(async () => {
    events.push("context-close");
  });
  checkoutDispose.mockImplementation(async () => {
    events.push("checkout-close");
  });
  Object.assign(_botReviewDeps, {
    gitToplevel: async () => "/repo",
    ensureProjectTrusted: async () => {
      events.push("trust:/repo");
    },
    resolvePrRef: async () => {
      events.push("resolve");
      return ref;
    },
    readPrInfo: async () => info,
    classifyPrTrust: async () => ({ trusted: true, headSha: "head", reasons: ["same repo"] }),
    preparePrCheckout: prepare,
    loadBotConfig: load,
    createRuntime: create,
    buildPrStepContext: async () => ({ ctx, dispose: contextDispose }),
    readCurrentUser: async () => ({ login: "bot" }),
    listReviewThreads: async () => threads,
    listPrComments: async () => comments,
    readLinkedIssues: async () => issues,
    runPrReview: review,
    postPrReview: post,
    writeJson: write,
    randomSuffix: () => "abcdef12",
  });
});
afterEach(async () => {
  Object.assign(_botReviewDeps, original);
  await runtime.close();
});

async function untrusted(): Promise<void> {
  _botReviewDeps.classifyPrTrust = async () => ({ trusted: false, headSha: "head", reasons: ["fork"] });
  await runBotReview(input);
}

describe("runBotReview", () => {
  test("AC-1 refuses merged PR", async () => {
    info = { ...info, state: "merged" };
    expect(await runBotReview(input)).toEqual({ outcome: "refused", reason: "PR #42 is merged" });
  });
  test("AC-2 merged PR never prepares checkout", async () => {
    info = { ...info, state: "merged" };
    await runBotReview(input);
    expect(prepare).not.toHaveBeenCalled();
  });
  test("AC-3 trusts root before resolving", async () => {
    const trust = mock<typeof _botReviewDeps.ensureProjectTrusted>(async () => {
      events.push("trust:/repo");
    });
    _botReviewDeps.ensureProjectTrusted = trust;
    await runBotReview(input);
    expect(trust).toHaveBeenCalledWith("/repo", { interactive: false });
    expect(events.slice(0, 2)).toEqual(["trust:/repo", "resolve"]);
  });
  test("AC-4 untrusted review is static", async () => {
    await untrusted();
    expect(review.mock.calls[0]?.[1].staticMode).toBe(true);
  });
  test("AC-5 static runtime strips MCP without mutating config", async () => {
    await untrusted();
    expect(create.mock.calls[0]?.[0].mcp?.servers).toEqual({});
    expect(config.mcp?.servers).toHaveProperty("sample");
  });
  test("AC-6 trusted review is not static", async () => {
    await runBotReview(input);
    expect(review.mock.calls[0]?.[1].staticMode).toBe(false);
  });
  test("AC-7 pins base files", async () => {
    await runBotReview(input);
    expect(prepare).toHaveBeenCalledWith({ repoRoot: "/repo", ref, info, suffix: "abcdef12", pinBaseFiles: true });
  });
  test("AC-8 loads snapshot profiles", async () => {
    await runBotReview(input);
    expect(load).toHaveBeenCalledWith({ snapshotDir: "/snapshot", profiles: input.profiles });
  });
  test("AC-9 resolves review model", async () => {
    await runBotReview(input);
    expect(review.mock.calls[0]?.[1].model).toBe("powerful");
  });
  test.each([
    ["AC-10 excludes own opened thread", "bot", false, 0],
    ["AC-11 keeps other author's marker", "other", false, 1],
    ["AC-12 excludes resolved thread", "other", true, 0],
  ] as const)("%s", async (_name, author, resolved, length) => {
    threads = [
      {
        id: "T",
        replyTo: "C",
        resolved,
        outdated: false,
        comments: [comment("C", author, withNaxBotMarker("hi", "summary"))],
      },
    ];
    await runBotReview(input);
    expect(review.mock.calls[0]?.[1].threads).toHaveLength(length);
  });
  test("AC-13 excludes empty, own, and nested comments", async () => {
    comments = [
      comment("empty", "human", "  "),
      comment("own", "bot", withNaxBotMarker("hi", "summary")),
      { ...comment("nested"), kind: "thread" },
      comment("keep"),
    ];
    await runBotReview(input);
    expect(review.mock.calls[0]?.[1].comments.map((c) => c.id)).toEqual(["keep"]);
  });
  test("AC-14 forwards linked issues and body", async () => {
    const readIssues = mock<typeof _botReviewDeps.readLinkedIssues>(async () => issues);
    _botReviewDeps.readLinkedIssues = readIssues;
    await runBotReview(input);
    expect(readIssues).toHaveBeenCalledWith(ref, info.body, _botReviewDeps.forge, "/repo");
    expect(review.mock.calls[0]?.[1].issues).toEqual(issues);
  });
  test("AC-15 selects single feature PRD", async () => {
    changedFiles = [`${PROJECT_FEATURES_DIR}/one/prd.json`, "src/a.ts"];
    await runBotReview(input);
    expect(review.mock.calls[0]?.[1].prdPath).toBe(join("/checkout", changedFiles[0] ?? ""));
  });
  test("AC-16 omits ambiguous PRD", async () => {
    changedFiles = [`${PROJECT_FEATURES_DIR}/one/prd.json`, `${PROJECT_FEATURES_DIR}/two/prd.json`];
    await runBotReview(input);
    expect(review.mock.calls[0]?.[1]).not.toHaveProperty("prdPath");
  });
  test("AC-17 forwards sensitive paths", async () => {
    await runBotReview(input);
    expect(post.mock.calls[0]?.[0].sensitive).toEqual(sensitivePaths(changedFiles));
  });
  test("AC-18 durable state directory", async () => {
    await runBotReview(input);
    expect(post.mock.calls[0]?.[0].stateDir).toBe(botRunDir(runtime.outputDir, 42, runtime.runId));
  });
  test.each(["AC-19 not-reviewed result", "AC-20 no posting"])("%s", async () => {
    review.mockImplementation(async () => ({ ran: false, why: "timeout" }));
    expect(await runBotReview(input)).toEqual({ outcome: "not-reviewed", reason: "timeout" });
    expect(post).not.toHaveBeenCalled();
  });
  test("AC-21 persists after review before posting", async () => {
    post.mockImplementation(async () => {
      expect(write.mock.calls[0]).toEqual([
        join(botRunDir(runtime.outputDir, 42, runtime.runId), "bot-state.json"),
        expect.objectContaining({ step: "post", reviewRan: true, verdict }),
      ]);
      return counts;
    });
    await runBotReview(input);
    expect(write).toHaveBeenCalledTimes(2);
  });
  test.each(["AC-22 closes runtime", "AC-23 disposes checkout"])("%s on thrown review", async () => {
    const close = runtime.close.bind(runtime);
    runtime.close = mock(async () => {
      events.push("runtime-close");
      await close();
    });
    review.mockImplementation(async () => {
      throw new Error("review failed");
    });
    await expect(runBotReview(input)).rejects.toThrow("review failed");
    expect(events.slice(-3)).toEqual(["context-close", "runtime-close", "checkout-close"]);
  });
  test("AC-24 returns posting counts", async () => {
    expect(await runBotReview(input)).toEqual({
      outcome: "posted",
      ...counts,
      intent: verdict.intent,
      quality: verdict.quality,
      staticMode: false,
    });
  });
  test.each(["config", "context", "post", "persist", "context-dispose", "runtime-close"] as const)(
    "attempts all acquired cleanup after %s failure",
    async (stage) => {
      const failure = new Error(`${stage} failed`);
      const close = runtime.close.bind(runtime);
      const closeSpy = mock(async () => {
        await close();
        if (stage === "runtime-close") throw failure;
      });
      runtime.close = closeSpy;
      if (stage === "config")
        load.mockImplementationOnce(async () => {
          throw failure;
        });
      if (stage === "context")
        _botReviewDeps.buildPrStepContext = async () => {
          throw failure;
        };
      if (stage === "post")
        post.mockImplementationOnce(async () => {
          throw failure;
        });
      if (stage === "persist")
        write.mockImplementationOnce(async () => {
          throw failure;
        });
      if (stage === "context-dispose")
        contextDispose.mockImplementationOnce(async () => {
          throw failure;
        });
      try {
        await expect(runBotReview(input)).rejects.toThrow(`${stage} failed`);
        expect(checkoutDispose).toHaveBeenCalledTimes(1);
        expect(closeSpy).toHaveBeenCalledTimes(stage === "config" ? 0 : 1);
        expect(contextDispose).toHaveBeenCalledTimes(stage === "config" || stage === "context" ? 0 : 1);
      } finally {
        runtime.close = close;
      }
    },
  );
  test("explicit model overrides configured model and own replies retain thread scope", async () => {
    threads = [
      {
        id: "T",
        replyTo: "first",
        resolved: false,
        outdated: false,
        comments: [comment("first"), comment("reply", "bot", withNaxBotMarker("reply", "thread:T"))],
      },
    ];
    await runBotReview({ ...input, model: "fast" });
    expect(review.mock.calls[0]?.[1].model).toBe("fast");
    expect(review.mock.calls[0]?.[1].threads).toHaveLength(1);
    expect(post.mock.calls[0]?.[0].own).toEqual([{ comment: threads[0]?.comments[1], key: "thread:T", threadId: "T" }]);
  });
  test("no matching PRD omits intent path", async () => {
    changedFiles = [`${PROJECT_FEATURES_DIR}/nested/one/prd.json`, "other/prd.json"];
    await runBotReview(input);
    expect(review.mock.calls[0]?.[1]).not.toHaveProperty("prdPath");
  });
  test("graph validates", () => {
    expect(validateStepGraph(BOT_REVIEW_GRAPH)).toEqual({ errors: [] });
  });
});
