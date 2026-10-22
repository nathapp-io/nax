import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import { assertDefined, makeMockCallContext, makeNaxConfig, makeTestRuntime } from "@test/helpers";
import { _postDeps, postPrReview, sensitivePaths } from "@/bot";
import { type BotChecks, checkCommands, type resolveBotChecks } from "@/bot/checks";
import { openBotLog } from "@/bot/log";
import { _botReviewDeps, BOT_REVIEW_GRAPH, runBotReview } from "@/bot/review-run";
import { PROJECT_FEATURES_DIR, resolveWorkflowConfig } from "@/config";
import { NaxError } from "@/errors";
import type { runPreRunSteps } from "@/execution/lifecycle/pre-run-steps";
import type { PrComment, PrInfo, PrRef, PrThread } from "@/forge";
import { withNaxBotMarker } from "@/forge";
import { getLogger, initLogger, resetLogger } from "@/logger";
import type { PrReviewVerdict } from "@/operations";
import { botChecksExtractOp } from "@/operations";
import { validateStepGraph } from "@/step-graph";
import type { PrStepContext } from "@/workflow/branch-step-context";
import { botRunDir } from "@/workflow/paths";
import { _workflowDeps } from "@/workflow/step-context";

const original = { ..._botReviewDeps };
const checks: BotChecks = {
  source: "detected",
  gates: [{ name: "test", command: "npm run test" }],
  preRun: [{ command: "npm ci", timeoutSeconds: 600 }],
};
const resolveChecks = mock<typeof resolveBotChecks>(async () => checks);
const preRun = mock<typeof runPreRunSteps>(async () => {});
const buildContext = mock<typeof _botReviewDeps.buildPrStepContext>();
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
const counts = {
  earlierAnswered: 0,
  inlineFindings: 2,
  threadsAnswered: 3,
  commentsAnswered: 4,
  offLine: 5,
  failed: 1,
};
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
const ci = { outcome: "green" as const, detail: "CI checks: 2/2 passed" };
const headCi = mock<typeof _botReviewDeps.readHeadCi>(async () => ci);
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
  resolveChecks.mockClear();
  resolveChecks.mockImplementation(async () => checks);
  preRun.mockClear();
  preRun.mockImplementation(async () => {});
  buildContext.mockClear();
  buildContext.mockImplementation(async ({ config: resolved }) => ({
    ctx: { ...ctx, config: resolved, callCtx: { ...ctx.callCtx, config: resolved } },
    dispose: contextDispose,
  }));
  review.mockImplementation(async () => ({ ran: true, verdict }));
  post.mockImplementation(async () => counts);
  contextDispose.mockImplementation(async () => {
    events.push("context-close");
  });
  checkoutDispose.mockImplementation(async () => {
    events.push("checkout-close");
  });
  Object.assign(_botReviewDeps, {
    setupBotRuntime: mock(async () => {}),
    openBotLog: () => ({ close: async () => {} }),
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
    buildPrStepContext: buildContext,
    resolveBotChecks: resolveChecks,
    runPreRunSteps: preRun,
    readCurrentUser: async () => ({ login: "bot" }),
    listReviewThreads: async () => threads,
    recordPrRulings: async () => ({ recorded: [], settled: [], open: [], asked: 0, failed: 0 }),
    listPrComments: async () => comments,
    readLinkedIssues: async () => issues,
    readHeadCi: headCi,
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
  test("US-015 AC-10 forwards unread files from review to posting", async () => {
    review.mockImplementation(async () => ({ ran: true, verdict, unreadFiles: ["src/unread.ts"] }));
    await runBotReview(input);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toMatchObject({ unreadFiles: ["src/unread.ts"] });
  });
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
  test("nax#2631 reads CI once for the exact head and gives it to the review and the summary", async () => {
    headCi.mockClear();
    await runBotReview(input);
    expect(headCi).toHaveBeenCalledWith({ forge: ref.forge, url: info.url, repoRoot: "/repo", headSha: info.headSha });
    expect(review.mock.calls.at(-1)?.[1].ci).toEqual(ci);
    expect(post.mock.calls.at(-1)?.[0].ci).toEqual(ci);
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
  test("returned artifactPath is the exact path passed to the real artifact writer", async () => {
    const writeArtifact = spyOn(_postDeps, "writeArtifact").mockResolvedValue(1);
    post.mockImplementation(async (postInput) =>
      postPrReview({
        ...postInput,
        deps: { ...postInput.deps, run: async () => ({ exitCode: 0, stdout: '{"id":42}', stderr: "" }) },
      }),
    );
    try {
      const result = await runBotReview(input);
      expect(result.outcome).toBe("posted");
      if (result.outcome !== "posted") throw new Error("review did not post");
      expect(writeArtifact).toHaveBeenCalledTimes(1);
      expect(writeArtifact.mock.calls[0]?.[0]).toBe(result.artifactPath);
    } finally {
      writeArtifact.mockRestore();
    }
  });
  test("AC-24 returns posting counts", async () => {
    expect(await runBotReview(input)).toEqual({
      outcome: "posted",
      spentUsd: expect.any(Number),
      limitUsd: expect.any(Number),
      ...counts,
      intent: verdict.intent,
      quality: verdict.quality,
      staticMode: false,
      checksSource: "detected",
      artifactPath: join(botRunDir(runtime.outputDir, 42, runtime.runId), "bot-review.json"),
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
  test("US-011 AC-1/2/5 enables loopback in one shared config without mutating loaded config", async () => {
    const before = structuredClone(config);
    await runBotReview(input);
    const resolved = create.mock.calls[0]?.[0];
    expect(resolved?.execution.sandbox?.network?.allowLocalBinding).toBe(true);
    expect(buildContext.mock.calls[0]?.[0].config).toBe(resolved);
    expect(review.mock.calls[0]?.[0].callCtx.config).toBe(resolved);
    expect(config).toEqual(before);
    expect(config.execution.sandbox?.network?.allowLocalBinding).toBeUndefined();
  });
  test("US-011 AC-3 preserves explicit false for trusted review", async () => {
    assertDefined(config.execution.sandbox);
    config.execution.sandbox.network = { allowLocalBinding: false };
    await runBotReview(input);
    expect(create.mock.calls[0]?.[0].execution.sandbox?.network?.allowLocalBinding).toBe(false);
    expect(buildContext.mock.calls[0]?.[0].config).toBe(create.mock.calls[0]?.[0]);
  });
  test.each([undefined, false, true])("US-011 AC-4/5 static preserves loaded loopback %s", async (value) => {
    assertDefined(config.execution.sandbox);
    config.execution.sandbox.network = value === undefined ? {} : { allowLocalBinding: value };
    const before = structuredClone(config);
    await untrusted();
    expect(create.mock.calls[0]?.[0].execution.sandbox?.network?.allowLocalBinding).toBe(value);
    expect(config).toEqual(before);
  });
  test("US-011 AC-6/7/8/12/13 resolves base checks once and installs in head checkout", async () => {
    await runBotReview(input);
    expect(resolveChecks).toHaveBeenCalledTimes(1);
    expect(resolveChecks).toHaveBeenCalledWith({
      repoRoot: "/repo",
      baseSha: "base",
      snapshotDir: "/snapshot",
      hasBaseNax: true,
      config: create.mock.calls[0]?.[0],
      extract: expect.any(Function),
    });
    expect(preRun).toHaveBeenCalledTimes(1);
    expect(preRun).toHaveBeenCalledWith({ steps: checks.preRun, workdir: "/checkout" });
  });
  test("US-011 AC-9 extraction dispatches operation with input and configured model", async () => {
    config.bot = { ...config.bot, models: { checks: "balanced" } };
    const extracted = { gates: [] };
    const call = spyOn(_workflowDeps, "callOp").mockResolvedValue(extracted);
    resolveChecks.mockImplementationOnce(async ({ extract }) => {
      expect(await extract({ fileName: "AGENTS.md", text: "run checks" })).toBe(extracted);
      return checks;
    });
    try {
      await runBotReview(input);
      expect(call).toHaveBeenCalledTimes(1);
      expect(call).toHaveBeenCalledWith(review.mock.calls[0]?.[0].callCtx, botChecksExtractOp, {
        fileName: "AGENTS.md",
        text: "run checks",
        model: "balanced",
      });
    } finally {
      call.mockRestore();
    }
  });
  test("US-011 AC-10/11/18 static skips checks and install and reports null source", async () => {
    _botReviewDeps.classifyPrTrust = async () => ({ trusted: false, headSha: "head", reasons: ["fork"] });
    expect(await runBotReview(input)).toMatchObject({ outcome: "posted", staticMode: true, checksSource: null });
    expect(resolveChecks).not.toHaveBeenCalled();
    expect(preRun).not.toHaveBeenCalled();
  });
  test("US-011 AC-14 awaits install before review", async () => {
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    preRun.mockImplementationOnce(async () => {
      started.resolve();
      await finish.promise;
      events.push("installed");
    });
    const running = runBotReview(input);
    try {
      // If preparation is skipped, the run finishes and the assertion fails rather than hanging.
      await Promise.race([started.promise, running]);
      expect(preRun).toHaveBeenCalledTimes(1);
      expect(review).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await running;
    }
    expect(events).toContain("installed");
    expect(review).toHaveBeenCalledTimes(1);
  });
  test("US-011 AC-15 continues review after PRE_RUN_FAILED npm ci", async () => {
    preRun.mockImplementationOnce(async () => {
      throw new NaxError("[bot] install failed", "PRE_RUN_FAILED", { stage: "execution", command: "npm ci" });
    });
    expect(await runBotReview(input)).toMatchObject({ outcome: "posted" });
    expect(preRun).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledTimes(1);
  });
  test.each([
    new NaxError("[bot] trust refused", "PROJECT_UNTRUSTED", { stage: "execution" }),
    new Error("unexpected install failure"),
  ])("US-011 AC-16 propagates unexpected preparation error %s and cleans up", async (failure) => {
    preRun.mockImplementationOnce(async () => {
      throw failure;
    });
    await expect(runBotReview(input)).rejects.toBe(failure);
    expect(review).not.toHaveBeenCalled();
    expect(events.slice(-2)).toEqual(["context-close", "checkout-close"]);
  });
  test.each(["config", "agents-md", "claude-md", "detected", "none"] as const)(
    "US-011 AC-17 returns resolved source %s",
    async (source) => {
      resolveChecks.mockResolvedValueOnce({ ...checks, source });
      expect(await runBotReview(input)).toMatchObject({ outcome: "posted", checksSource: source });
    },
  );
  test.each([
    ["AC-1 includes unresolved own finding", "bot", "f-one", false, true],
    ["AC-2 excludes own summary", "bot", "summary", false, false],
    ["AC-3 excludes resolved own finding", "bot", "f-one", true, false],
    ["excludes another author's finding marker", "human", "f-one", false, false],
    ["excludes invalid marker", "bot", null, false, false],
  ] as const)("US-012 %s", async (_name, author, key, resolved, included) => {
    const thread: PrThread = {
      id: "T",
      replyTo: "C",
      resolved,
      outdated: false,
      comments: [
        comment("C", author, key === null ? "<!-- nax-bot:v1 key=f-invalid key -->" : withNaxBotMarker("finding", key)),
      ],
    };
    threads = [thread];
    await runBotReview(input);
    expect(review.mock.calls[0]?.[1].earlier).toEqual(included ? [thread] : []);
  });
  test("US-012 AC-4 passes resolved check commands", async () => {
    await runBotReview(input);
    expect(review.mock.calls[0]?.[1].checks).toEqual(checkCommands(checks));
  });
  test.each([
    [false, [{ id: "D-1", statement: "S" }]],
    [true, [{ id: "D-1", statement: "S" }]],
    [false, undefined],
    [true, undefined],
  ] as const)("US-012 AC-5/6 forwards decisions or defaults in static mode %s", async (staticMode, decisions) => {
    if (staticMode)
      _botReviewDeps.classifyPrTrust = async () => ({ trusted: false, headSha: "head", reasons: ["fork"] });
    await runBotReview({ ...input, ...(decisions === undefined ? {} : { decisions }) });
    expect(review.mock.calls[0]?.[1].decisions).toEqual(decisions ?? []);
  });
  test("US-012 AC-7/8 forwards all earlier threads beyond the prompt cap and current login", async () => {
    threads = Array.from(
      { length: 51 },
      (_, i): PrThread => ({
        id: `T-${i}`,
        replyTo: `C-${i}`,
        resolved: false,
        outdated: false,
        comments: [comment(`C-${i}`, "bot", withNaxBotMarker("finding", `f-${i}`))],
      }),
    );
    await runBotReview(input);
    expect(post.mock.calls[0]?.[0].earlier).toEqual(threads);
    expect(post.mock.calls[0]?.[0].login).toBe("bot");
    expect(review.mock.calls[0]?.[1].earlier).toEqual(threads);
  });
  test("US-012 AC-6 defaults omitted decisions to an empty list", async () => {
    await runBotReview(input);
    expect(review.mock.calls[0]?.[1].decisions).toEqual([]);
  });
  test("US-012 AC-8 forwards the authenticated login", async () => {
    await runBotReview(input);
    expect(post.mock.calls[0]?.[0].login).toBe("bot");
  });
  test("US-012 AC-9 forwards full resolved checks to posting", async () => {
    await runBotReview(input);
    expect(post.mock.calls[0]?.[0].checks).toEqual(checks);
  });
  test("US-012 AC-10 forwards failed install command to posting", async () => {
    preRun.mockRejectedValueOnce(
      new NaxError("[bot] install failed", "PRE_RUN_FAILED", {
        stage: "execution",
        command: "npm ci",
      }),
    );
    await runBotReview(input);
    expect(post.mock.calls[0]?.[0].preRunFailed).toBe("npm ci");
    expect(post.mock.calls[0]?.[0].checks).toEqual(checks);
  });
  test("US-012 AC-11 static posting gets null checks and prompt gets no commands", async () => {
    await untrusted();
    expect(post.mock.calls[0]?.[0].checks).toBeNull();
    expect(review.mock.calls[0]?.[1].checks).toEqual([]);
    expect(post.mock.calls[0]?.[0].preRunFailed).toBeUndefined();
  });
  test("US-012 AC-12 returns the artifact path", async () => {
    expect(await runBotReview(input)).toMatchObject({
      artifactPath: join(botRunDir(runtime.outputDir, 42, runtime.runId), "bot-review.json"),
    });
  });
  test("US-012 AC-13 preserves non-own selection and forge order separately from earlier", async () => {
    const thread = (id: string, first: PrComment, resolved = false): PrThread => ({
      id,
      replyTo: first.id,
      resolved,
      outdated: false,
      comments: [first],
    });
    const human = thread("human", comment("human"));
    const own = thread("own", comment("own", "bot", withNaxBotMarker("finding", "f-own")));
    const spoofed = thread("spoofed", comment("spoofed", "other", withNaxBotMarker("finding", "f-spoofed")));
    const unmarked = thread("unmarked", comment("unmarked", "bot"));
    const replied = {
      ...thread("replied", comment("first")),
      comments: [comment("first"), comment("reply", "bot", withNaxBotMarker("reply", "f-reply"))],
    };
    threads = [human, own, thread("resolved", comment("resolved"), true), spoofed, unmarked, replied];
    await runBotReview(input);
    expect(review.mock.calls[0]?.[1].threads).toEqual([human, spoofed, unmarked, replied]);
    expect(review.mock.calls[0]?.[1].earlier).toEqual([own]);
  });
  test("graph validates", () => {
    expect(validateStepGraph(BOT_REVIEW_GRAPH)).toEqual({ errors: [] });
  });
});

describe("US-016 review logging", () => {
  test("logs failed install without aborting review", async () => {
    resetLogger();
    initLogger({ level: "silent", useChalk: false });
    const warn = spyOn(getLogger(), "warn");
    preRun.mockImplementation(async () => {
      throw new NaxError("install", "PRE_RUN_FAILED", { stage: "test", command: "npm ci" });
    });
    try {
      expect((await runBotReview(input)).outcome).toBe("posted");
      expect(warn).toHaveBeenCalledWith("bot", "Install step failed", { command: "npm ci" });
    } finally {
      warn.mockRestore();
      resetLogger();
    }
  });
  test("AC-9/10/12/13/14 opens run log, emits milestones and returns path", async () => {
    resetLogger();
    initLogger({ level: "silent", useChalk: false });
    const infoLog = spyOn(getLogger(), "info");
    const path = join(botRunDir(runtime.outputDir, ref.number, runtime.runId), "bot.jsonl");
    const open = mock((requested: string) => ({
      path: requested,
      close: async () => {
        events.push("log-close");
      },
    }));
    _botReviewDeps.openBotLog = open;
    const close = runtime.close.bind(runtime);
    runtime.close = async () => {
      events.push("runtime-close");
      await close();
    };
    try {
      expect(await runBotReview(input)).toMatchObject({ outcome: "posted", logPath: path });
      expect(open).toHaveBeenCalledWith(path);
      expect(events.indexOf("log-close")).toBeLessThan(events.indexOf("runtime-close"));
      expect(infoLog).toHaveBeenCalledWith("bot", "Checks resolved", {
        source: "detected",
        commands: checkCommands(checks),
      });
      expect(infoLog).toHaveBeenCalledWith("bot", "Bot review started", { pr: 42, headSha: "head", trusted: true });
      expect(infoLog).toHaveBeenCalledWith(
        "bot",
        "Bot review posted",
        expect.objectContaining({
          inlineFindings: 2,
          threadsAnswered: 3,
          earlierAnswered: 0,
          failed: 1,
          intent: "pass",
          quality: "approved",
        }),
      );
    } finally {
      infoLog.mockRestore();
      resetLogger();
    }
  });
  test("AC-11 closes the log when review throws", async () => {
    const close = mock(async () => {});
    _botReviewDeps.openBotLog = () => ({ path: "/log", close });
    review.mockImplementation(async () => {
      throw new NaxError("review failed", "TEST_REVIEW", { stage: "test" });
    });
    await expect(runBotReview(input)).rejects.toThrow("review failed");
    expect(close).toHaveBeenCalledTimes(1);
  });
  test("AC-24 posted review without logger omits logPath", async () => {
    resetLogger();
    _botReviewDeps.openBotLog = openBotLog;
    const result = await runBotReview(input);
    expect(result.outcome).toBe("posted");
    expect(result).not.toHaveProperty("logPath");
  });
});

describe("runBotReview log initialization cleanup", () => {
  test("closes runtime if opening the sink unexpectedly throws", async () => {
    const close = spyOn(runtime, "close");
    _botReviewDeps.openBotLog = () => {
      throw new NaxError("sink failure", "TEST_SINK", { stage: "test" });
    };
    await expect(runBotReview(input)).rejects.toThrow("sink failure");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
