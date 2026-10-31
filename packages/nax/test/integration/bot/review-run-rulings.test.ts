import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import {
  assertDefined,
  cleanupTempDir,
  makeBotReviewDeps,
  makeNaxConfig,
  makeScriptedCallOp,
  makeTempDir,
  makeTestRuntime,
} from "@test/helpers";
import { type BotReviewArtifact, postPrReview } from "@/bot/post";
import { _botReviewDeps, runBotReview } from "@/bot/review-run";
import { _reviewStepDeps, runPrReview } from "@/bot/review-step";
import { _rulingsDeps, type RecordRulingsOutcome, recordPrRulings } from "@/bot/rulings";
import { NAX_WORKFLOW_PR_MARKER, type PrComment, type PrInfo, type PrThread, withNaxBotMarker } from "@/forge";
import { getLogger, initLogger, resetLogger } from "@/logger";
import { botRulingReadOp, type PrReviewVerdict } from "@/operations";
import { MAX_EARLIER_THREADS } from "@/prompts";
import { itemKey, renderItemIndex, renderItemOpener } from "@/workflow/item-threads";
import { _workflowDeps } from "@/workflow/step-context";

const original = { ..._botReviewDeps };
const workflow = { ..._workflowDeps };
const step = { ..._reviewStepDeps };
const config = makeNaxConfig({ bot: { models: { rulings: "balanced" } } });
const input = { dir: "/repo", pr: 7, profiles: [], interactive: false };
const ref = { forge: "github", host: "test", repo: "o/r", number: 7 } as const;
const verdict: PrReviewVerdict = {
  intent: "pass",
  quality: "approved",
  findings: [],
  threads: [],
  comments: [],
  cannotVerify: [],
  inspectedFiles: [],
};
const comment = (id: string, author: string, body = id): PrComment => ({
  id,
  author,
  body,
  kind: "thread",
  createdAt: "",
});
const thread = (id: string, key: string, resolved = false): PrThread => ({
  id,
  replyTo: id,
  resolved,
  outdated: false,
  comments: [comment(id, "bot", withNaxBotMarker(`Open item **${id}** (finding): issue`, key))],
});
let runtime: ReturnType<typeof makeTestRuntime>;
let info: PrInfo;
let threads: PrThread[];
let outcome: RecordRulingsOutcome;
let order: string[];
const record = mock<typeof recordPrRulings>(async () => {
  order.push("rulings");
  return outcome;
});
const review = mock<typeof runPrReview>(async () => {
  order.push("review");
  return { ran: true, verdict };
});
const post = mock<typeof _botReviewDeps.postPrReview>(async () => ({
  earlierAnswered: 0,
  inlineFindings: 0,
  threadsAnswered: 0,
  commentsAnswered: 0,
  offLine: 0,
  failed: 0,
}));

beforeEach(() => {
  initLogger({ level: "silent" });
  order = [];
  threads = [];
  outcome = { recorded: [], settled: [], open: [], asked: 2, failed: 0 };
  info = {
    number: 7,
    title: "PR",
    body: NAX_WORKFLOW_PR_MARKER,
    url: "url",
    state: "open",
    draft: true,
    author: { login: "writer" },
    baseRef: "main",
    headRef: "topic",
    headSha: "a".repeat(40),
    crossRepo: false,
  };
  runtime = makeTestRuntime({ config });
  record.mockClear();
  record.mockImplementation(async () => {
    order.push("rulings");
    return outcome;
  });
  review.mockClear();
  post.mockClear();
  Object.assign(_botReviewDeps, {
    ...makeBotReviewDeps({
      config,
      runtime,
      info: () => info,
      threads: () => threads,
      onCheckout: () => order.push("checkout"),
    }),
    recordPrRulings: record,
    runPrReview: review,
    postPrReview: post,
    writeJson: async () => {},
  });
});
afterEach(async () => {
  Object.assign(_botReviewDeps, original);
  Object.assign(_workflowDeps, workflow);
  Object.assign(_reviewStepDeps, step);
  await runtime.close();
  resetLogger();
});

function openItems(): void {
  const finding = thread("finding", "w-F.12345678", true);
  const writer = comment("writer", "writer");
  const own = comment("own", "bot", withNaxBotMarker("ask", "wq-w-F.12345678-1"));
  const foreign = comment("foreign", "reader", "fixed malicious");
  threads = [
    thread("f2", "f-2"),
    finding,
    thread("f1", "f-1"),
    thread("closed", "f-closed", true),
    thread("foreign", "f-foreign"),
  ];
  threads[4] = {
    ...threads[4],
    id: "foreign",
    replyTo: "foreign",
    resolved: false,
    outdated: false,
    comments: [comment("x", "other", withNaxBotMarker("fake", "f-foreign"))],
  };
  outcome = {
    ...outcome,
    open: [
      {
        key: "w-F.12345678",
        itemId: "finding",
        kind: "finding",
        thread: { ...finding, comments: [...finding.comments, writer, foreign, own] },
        replies: [writer, foreign],
        kept: [writer],
      },
      ...["ruling", "advisor", "cannot-verify"].map((kind) => ({
        key: `w-${kind}.12345678`,
        itemId: kind,
        kind,
        thread: thread(kind, `w-${kind}.12345678`),
        replies: [],
        kept: [],
      })),
    ],
  };
}

describe("runBotReview workflow rulings", () => {
  test("US-004 AC-17/18 confirmed advisor work reaches actual persistence but not model earlier", async () => {
    const stateDir = makeTempDir("review-confirmed-");
    const key = "w-D-1.12345678";
    const advisor = {
      ...thread("advisor", key),
      path: "anchor.ts",
      line: 42,
      comments: [comment("91", "bot", withNaxBotMarker("Open item **D-1** (advisor): change required", key))],
    };
    threads = [advisor];
    outcome = {
      ...outcome,
      confirmedWork: [
        {
          key,
          itemId: "D-1",
          kind: "advisor",
          thread: advisor,
          replies: [],
          ruling: { itemKey: key, itemId: "D-1", disposition: "confirmed", reason: "change X", by: "writer" },
        },
      ],
    };
    _botReviewDeps.postPrReview = (value) =>
      postPrReview({
        ...value,
        stateDir,
        deps: { run: async () => ({ exitCode: 0, stdout: '{"id":42}', stderr: "" }), readText: async () => null },
      });
    try {
      expect((await runBotReview(input)).outcome).toBe("posted");
      expect(record).toHaveBeenCalledTimes(1);
      const modelInput = review.mock.calls[0]?.[1];
      expect(modelInput?.earlier).toEqual([]);
      expect(modelInput).not.toHaveProperty("itemConfirmed");
      expect(modelInput?.settled).toContainEqual({
        id: "D-1",
        kind: "advisor",
        issue: "change required",
        disposition: "confirmed",
        reason: "change X",
      });
      const artifact: BotReviewArtifact = await Bun.file(join(stateDir, "bot-review.json")).json();
      expect(artifact.agreed).toEqual([
        {
          kind: "finding",
          key,
          issue: "Open item **D-1** (advisor): change required",
          severity: "important",
          suggestion: "change X",
        },
      ]);
    } finally {
      cleanupTempDir(stateDir);
    }
  });
  test("settled AC-16 writer keyword reaches real review operation through item index", async () => {
    const rulingDeps = { ..._rulingsDeps };
    const item = { id: "_run:cv1", kind: "cannot-verify" as const, issue: "Live job-log availability" };
    const key = itemKey(item);
    threads = [
      {
        ...thread("cv", key),
        comments: [
          comment("cv", "bot", withNaxBotMarker(renderItemOpener(item), key)),
          comment("reply", "writer", "verified: ran live calls"),
        ],
      },
    ];
    _botReviewDeps.listPrComments = async () => [
      comment("index", "bot", withNaxBotMarker(renderItemIndex({ keys: [key] }), "w-index")),
    ];
    _botReviewDeps.recordPrRulings = recordPrRulings;
    _botReviewDeps.runPrReview = runPrReview;
    _reviewStepDeps.writeBranchReviewPackage = async () => [];
    _workflowDeps.appendChangedFileRules = async () => {};
    const calls: unknown[] = [];
    _workflowDeps.callOp = makeScriptedCallOp((_op, value) => {
      calls.push(value);
      return verdict;
    });
    const access = mock(async () => true);
    Object.assign(_rulingsDeps, {
      editComment: async () => {},
      hasWriteAccess: access,
      readPrInfo: async () => info,
      replyToThread: async () => {},
      resolveThread: async () => {},
    });
    try {
      expect((await runBotReview(input)).outcome).toBe("posted");
      expect(access).toHaveBeenCalled();
      expect(calls[0]).toMatchObject({
        prompt: expect.stringMatching(/## Settled rulings[\s\S]*_run:cv1[\s\S]*ran live calls/),
      });
    } finally {
      Object.assign(_rulingsDeps, rulingDeps);
    }
  });
  test("AC-1 records once after checkout and before review, using raw reads", async () => {
    openItems();
    await runBotReview(input);
    expect(record).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["checkout", "rulings", "review"]);
    expect(record.mock.calls[0]?.[0]).toMatchObject({ threads, comments: [], login: "bot", ref, info, cwd: "/repo" });
  });
  test("AC-2/15 unmarked PR preserves unresolved own f- forge order", async () => {
    openItems();
    info = { ...info, body: "ordinary PR" };
    await runBotReview(input);
    expect(record).not.toHaveBeenCalled();
    expect(review.mock.calls[0]?.[1].earlier).toEqual([threads[0], threads[2]]);
    expect(post.mock.calls[0]?.[0].earlier).toEqual([threads[0], threads[2]]);
    expect(post.mock.calls[0]?.[0]).not.toHaveProperty("rulings");
  });
  test.each(["fork", "no write access"])("AC-3 untrusted marked PR (%s) never reads rulings", async (reason) => {
    _botReviewDeps.classifyPrTrust = async () => ({ trusted: false, headSha: info.headSha, reasons: [reason] });
    await runBotReview(input);
    expect(record).not.toHaveBeenCalled();
    expect(review.mock.calls[0]?.[1].staticMode).toBe(true);
  });
  test("AC-4 dispatches ruling read through callOp with configured model", async () => {
    const calls: { op: unknown; input: unknown }[] = [];
    _workflowDeps.callOp = makeScriptedCallOp((op, value) => {
      calls.push({ op, input: value });
      return { rulings: [] };
    });
    record.mockImplementation(async (value) => {
      await value.readModel({ items: [] });
      return outcome;
    });
    await runBotReview(input);
    expect(calls).toEqual([{ op: botRulingReadOp, input: { items: [], model: "balanced" } }]);
  });
  test("AC-5 logs recorder failure and continues without outcome", async () => {
    const warn = spyOn(getLogger(), "warn");
    record.mockImplementation(async () => {
      throw new Error("record failed");
    });
    await runBotReview(input);
    expect(warn).toHaveBeenCalledWith(
      "bot",
      expect.stringContaining("rulings"),
      expect.objectContaining({ error: "record failed" }),
    );
    expect(review).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).not.toHaveProperty("rulings");
    warn.mockRestore();
  });
  test("AC-6/7/8 combines f- then finding/ruling items including resolved, filtering non-writers", async () => {
    openItems();
    await runBotReview(input);
    const earlier = review.mock.calls[0]?.[1].earlier;
    expect(earlier?.map(({ id }) => id)).toEqual(["f2", "f1", "finding", "ruling"]);
    expect(earlier?.[2]?.resolved).toBe(true);
    expect(earlier?.[2]?.comments.map(({ id }) => id)).toEqual(["finding", "writer", "own"]);
    expect(post.mock.calls[0]?.[0]).toMatchObject({ rulings: { recorded: 0, open: 4, asked: 2 } });
  });
  test("AC-9 real review op caps the combined ids, retaining item ids in order", async () => {
    openItems();
    threads = Array.from({ length: MAX_EARLIER_THREADS - 1 }, (_, i) => thread(`f${i}`, `f-${i}`));
    _botReviewDeps.runPrReview = runPrReview;
    _reviewStepDeps.writeBranchReviewPackage = async () => [];
    _workflowDeps.appendChangedFileRules = async () => {};
    const calls: unknown[] = [];
    _workflowDeps.callOp = makeScriptedCallOp((_op, value) => {
      calls.push(value);
      return verdict;
    });
    await runBotReview(input);
    assertDefined(calls[0]);
    expect(calls[0]).toMatchObject({ earlierIds: [...threads.map(({ id }) => id), "finding"] });
    expect(calls[0]).toMatchObject({ prompt: expect.stringContaining("Open item **finding** (finding): issue") });
  });
});
