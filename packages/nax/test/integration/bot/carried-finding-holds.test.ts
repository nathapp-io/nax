/**
 * B1 (bot-reviewed-head branch fix): a blocking finding a review could only post in its summary has no
 * thread, so `mergeEarlier` cannot carry it. Advancing the reviewed head past that review narrowed the
 * next range to the new commits only, and the finding then vanished from the artifact readiness reads.
 *
 * The two-head case below is the regression: head B reports an unanchored critical finding, head C
 * changes an unrelated file, and the finding still holds readiness at C. The rest pin what ends a
 * carry: a re-report, a thread, a settlement and a recorded bot push.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeBotFixDraftEnv,
  makeBotReviewDeps,
  makeNaxConfig,
  makeTempDir,
  makeTestRuntime,
} from "@test/helpers";
import { loadLatestReview } from "@/bot/fix-input";
import { _fixReportDeps, readyStep } from "@/bot/fix-report";
import { BOT_REVIEW_FILENAME, type BotReviewArtifact, type PostReviewInput, postPrReview } from "@/bot/post";
import type { BotPushEntry } from "@/bot/push-ledger";
import { findingKey } from "@/bot/render";
import { _botReviewDeps, runBotReview } from "@/bot/review-run";
import type { runPrReview } from "@/bot/review-step";
import type { RecordRulingsOutcome, recordPrRulings } from "@/bot/rulings";
import {
  type ForgeDeps,
  type ForgeRunResult,
  NAX_WORKFLOW_PR_MARKER,
  type OwnComment,
  type PrInfo,
  parseNaxBotMarker,
} from "@/forge";
import { initLogger, resetLogger } from "@/logger";
import type { PrFinding, PrReviewVerdict } from "@/operations";

const PR = 7;
const BOT = "bot";
/** The head the first review started after: the workflow publish head. */
const published = "a".repeat(40);
const publishedBase = "9".repeat(40);
/** The head whose review could only post the finding in its summary. */
const headB = "b".repeat(40);
/** The unrelated push: its review covers `headB..headC` only. */
const headC = "c".repeat(40);
/** A third push, whose review must keep carrying the finding it also cannot re-report. */
const headD = "d".repeat(40);
/** A critical finding the reviewer gave no line for, so no inline thread could hold it. */
const openFinding: PrFinding = {
  kind: "quality",
  severity: "critical",
  issue: "Token cache entries are shared across users",
};
const openKey = findingKey(openFinding);
const emptyVerdict: PrReviewVerdict = {
  intent: "pass",
  quality: "approved",
  findings: [],
  threads: [],
  comments: [],
  cannotVerify: [],
  inspectedFiles: [],
};
const emptyOutcome: RecordRulingsOutcome = { recorded: [], settled: [], open: [], asked: 0, failed: 0 };

const original = { ..._botReviewDeps };
const reportOriginal = { ..._fixReportDeps };
const runtimes: ReturnType<typeof makeTestRuntime>[] = [];
let tempDir: string;
let config: ReturnType<typeof makeNaxConfig>;
let info: PrInfo;
let verdict: PrReviewVerdict;
let outcome: RecordRulingsOutcome;
let calls: string[][];
let refuse: (argv: string[]) => boolean;

const review = mock<typeof runPrReview>(async () => ({ ran: true, verdict }));
const record = mock<typeof recordPrRulings>(async () => outcome);
const ancestor = mock(async (_dir: string, _ancestor: string, _head: string) => true);
const advance = mock(async () => ({ kind: "unchanged" as const }));
/** The review artifact is the point of the two-head case, so the temporary output dir is the store. */
const loadEarlier = mock(async (outputDir: string, pr: number, head: string, options?: { codeOnly?: boolean }) =>
  loadLatestReview(outputDir, pr, head, options ?? {}),
);
const forge: ForgeDeps = {
  async run(argv): Promise<ForgeRunResult> {
    calls.push(argv);
    return refuse(argv)
      ? { exitCode: 1, stdout: "", stderr: "forge refused the write" }
      : { exitCode: 0, stdout: '{"id":99}', stderr: "" };
  },
  readText: async () => null,
};
/** The real post step, with a recording forge in place of gh/glab. */
const post = mock<typeof _botReviewDeps.postPrReview>(async (postInput) => postPrReview({ ...postInput, deps: forge }));

beforeEach(() => {
  initLogger({ level: "silent" });
  tempDir = makeTempDir("bot-carried-");
  // The runtime's output dir is the artifact store `loadLatestReview` globs (B1).
  config = makeNaxConfig({ outputDir: tempDir });
  info = {
    number: PR,
    title: "PR",
    body: NAX_WORKFLOW_PR_MARKER,
    url: "url",
    state: "open",
    draft: true,
    author: { login: "writer" },
    baseRef: "main",
    headRef: "topic",
    headSha: headB,
    crossRepo: false,
  };
  verdict = emptyVerdict;
  outcome = { ...emptyOutcome, index: { reviewedHead: published, reviewedBase: publishedBase, keys: [] } };
  calls = [];
  refuse = () => false;
  for (const fn of [review, record, ancestor, advance, loadEarlier, post]) fn.mockClear();
  review.mockImplementation(async () => ({ ran: true, verdict }));
  record.mockImplementation(async () => outcome);
  ancestor.mockImplementation(async () => true);
  advance.mockImplementation(async () => ({ kind: "unchanged" as const }));
});
afterEach(async () => {
  Object.assign(_botReviewDeps, original);
  Object.assign(_fixReportDeps, reportOriginal);
  mock.restore();
  resetLogger();
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  cleanupTempDir(tempDir);
});

/** A fresh runtime per run: a review closes the runtime it used. */
function install(headSha: string): void {
  info = { ...info, headSha };
  const runtime = makeTestRuntime({ config });
  runtimes.push(runtime);
  Object.assign(_botReviewDeps, {
    ...makeBotReviewDeps({ config, runtime, info: () => info }),
    listPrComments: async () => [],
    isAncestor: ancestor,
    recordPrRulings: record,
    runPrReview: review,
    postPrReview: post,
    loadLatestReview: loadEarlier,
    advanceReviewedHead: advance,
    writeJson: async () => {},
  });
}

const reviewInput = { dir: "/repo", pr: PR, profiles: [], interactive: false };

/** Review one head as the real graph does, with the listed heads' artifacts on disk. */
async function reviewHead(headSha: string, findings: readonly PrFinding[], index?: RecordRulingsOutcome["index"]) {
  verdict = { ...emptyVerdict, findings };
  outcome = { ...emptyOutcome, ...(index === undefined ? {} : { index }) };
  install(headSha);
  const result = await runBotReview(reviewInput);
  if (result.outcome !== "posted") throw new Error(`expected a posted review of ${headSha}, got ${result.outcome}`);
  return result;
}

/** The artifact written for one head, as readiness loads it. */
async function artifactFor(headSha: string): Promise<BotReviewArtifact> {
  const artifact = await loadLatestReview(tempDir, PR, headSha);
  if (artifact === null) throw new Error(`no review artifact was written for ${headSha}`);
  return artifact;
}

function bodyOf(argv: readonly string[]): string {
  const arg = argv.find((value) => value.startsWith("body="));
  return arg === undefined ? "" : arg.slice("body=".length);
}

function summaryBody(): string {
  const body = calls.map(bodyOf).find((candidate) => parseNaxBotMarker(candidate)?.key === "summary");
  if (body === undefined) throw new Error("no summary comment was written");
  return body;
}

describe("a summary-only blocking finding across two heads (B1)", () => {
  test("holds readiness at the head whose review could not re-report it", async () => {
    await reviewHead(headB, [openFinding]);
    // The premise: an unanchored finding is posted in the summary, with no thread to carry it.
    expect(summaryBody()).toContain("Findings not on a changed line");
    await reviewHead(headC, [], { reviewedHead: headB, reviewedBase: published, keys: [] });
    const artifact = await artifactFor(headC);
    // The review of C covered `headB..headC`, so its own verdict says nothing about B's finding.
    expect(verdict.findings).toEqual([]);
    expect(artifact.agreed.map((item) => item.key)).toContain(openKey);

    const base = makeBotFixDraftEnv();
    const env = { ...base, info: { ...base.info, headSha: headC }, review: artifact };
    _fixReportDeps.readPrInfo = async () => env.info;
    _fixReportDeps.readCurrentUser = async () => ({ login: BOT });
    _fixReportDeps.listReviewThreads = async () => [];
    _fixReportDeps.listPrComments = async () => [];
    _fixReportDeps.readSettledKeys = async () => new Set<string>();
    const result = await readyStep(env, { step: "ready", timings: {}, outcome: "ready-pass", readyOnly: true });
    expect(result.patch.markedReady).toBe(false);
    expect(result.patch.readyHeld).toContain("1 open critical/important finding(s)");
    expect(result.patch.readyHeld).toContain(openKey);
  });

  test("lists the carried finding in the new summary instead of dropping it", async () => {
    await reviewHead(headB, [openFinding]);
    calls = [];
    await reviewHead(headC, [], { reviewedHead: headB, reviewedBase: published, keys: [] });
    expect(summaryBody()).toContain("### Still open from an earlier review");
    expect(summaryBody()).toContain(openFinding.issue);
  });

  test("carries the finding forward again at a third head", async () => {
    await reviewHead(headB, [openFinding]);
    await reviewHead(headC, [], { reviewedHead: headB, reviewedBase: published, keys: [] });
    await reviewHead(headD, [], { reviewedHead: headC, reviewedBase: published, keys: [] });
    expect((await artifactFor(headD)).agreed.map((item) => item.key)).toContain(openKey);
  });

  test("carries nothing when the earlier review's artifact is not on this machine", async () => {
    loadEarlier.mockImplementation(async () => null);
    await reviewHead(headB, [openFinding]);
    await reviewHead(headC, [], { reviewedHead: headB, reviewedBase: published, keys: [] });
    expect((await artifactFor(headC)).agreed).toEqual([]);
  });
});

/** A post input that carries whichever findings a case hands it. */
function carriedInput(stateDir: string, extra: Partial<PostReviewInput> = {}): PostReviewInput {
  return {
    ref: { forge: "github", host: "github.test", repo: "o/r", number: PR },
    info: { ...info, headSha: headC },
    verdict: emptyVerdict,
    threads: [],
    comments: [],
    own: [],
    staticMode: false,
    sensitive: [],
    stateDir,
    deps: forge,
    cwd: stateDir,
    carriedFindings: [{ kind: "finding", key: openKey, severity: "critical", issue: openFinding.issue }],
    ...extra,
  };
}

/** The agreed keys the artifact recorded for one post. */
async function agreedKeys(input: PostReviewInput): Promise<string[]> {
  await postPrReview(input);
  const artifact: BotReviewArtifact = await Bun.file(join(input.stateDir, BOT_REVIEW_FILENAME)).json();
  return artifact.agreed.map((item) => item.key);
}

describe("what ends a carry", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = makeTempDir("bot-carried-post-");
  });
  afterEach(() => {
    cleanupTempDir(stateDir);
  });

  test("the review reporting the same key itself does not carry a second copy", async () => {
    const keys = await agreedKeys(carriedInput(stateDir, { verdict: { ...emptyVerdict, findings: [openFinding] } }));
    expect(keys).toEqual([openKey]);
  });

  test("a thread that owns the key keeps it, so the carry defers to it", async () => {
    const own: OwnComment[] = [
      {
        key: openKey,
        threadId: "t1",
        comment: { id: "1", kind: "review", author: BOT, body: "", createdAt: "" },
      },
    ];
    expect(await agreedKeys(carriedInput(stateDir, { own }))).toEqual([]);
  });

  test("a finding outside the blocking set is not carried", async () => {
    const keys = await agreedKeys(
      carriedInput(stateDir, {
        carriedFindings: [{ kind: "finding", key: openKey, severity: "minor", issue: openFinding.issue }],
      }),
    );
    expect(keys).toEqual([]);
  });

  test("an authorized ruling that settled the key ends the carry", async () => {
    expect(await agreedKeys(carriedInput(stateDir, { settledKeys: new Set([openKey]) }))).toEqual([]);
  });

  test("a recorded bot push that claims the key ends the carry", async () => {
    const entry: BotPushEntry = {
      base: published,
      sha: headB,
      at: "",
      items: [{ key: openKey, generation: 1, issue: openFinding.issue }],
    };
    expect(await agreedKeys(carriedInput(stateDir, { botPushes: [entry] }))).toEqual([]);
  });
});
