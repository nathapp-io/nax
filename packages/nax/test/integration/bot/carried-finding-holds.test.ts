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
import { CARRIED_RECORD_PREFIX, carriedRecordKey, parseCarriedRecord } from "@/bot/carried-record";
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
  type PrRef,
  parseNaxBotMarker,
  withNaxBotMarker,
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
/** The top-level comments the forge holds, every write appended in order: the bot's own state. */
let forgeState: string[];

const review = mock<typeof runPrReview>(async () => ({ ran: true, verdict }));
const record = mock<typeof recordPrRulings>(async () => outcome);
const ancestor = mock(async (_dir: string, _ancestor: string, _head: string) => true);
const advance = mock(async () => ({ kind: "unchanged" as const }));
/** B4: the whole reference, as the review and the loader now pass it. */
const prRef: PrRef = { forge: "github", host: "test", repo: "o/r", number: PR };
/** The review artifact is the point of the two-head case, so the temporary output dir is the store. */
const loadEarlier = mock(async (outputDir: string, ref: PrRef, head: string, options?: { codeOnly?: boolean }) =>
  loadLatestReview(outputDir, ref, head, options ?? {}),
);
const forge: ForgeDeps = {
  async run(argv): Promise<ForgeRunResult> {
    calls.push(argv);
    if (refuse(argv)) return { exitCode: 1, stdout: "", stderr: "forge refused the write" };
    const body = bodyOf(argv);
    if (body !== "") forgeState.push(body);
    return { exitCode: 0, stdout: '{"id":99}', stderr: "" };
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
  forgeState = [];
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
    // The forge keeps what the bot posted, so a second review reads the first one's own comments.
    listPrComments: async () =>
      forgeState.map((body, index) => ({
        id: String(index + 1),
        kind: "comment" as const,
        author: BOT,
        body,
        createdAt: "",
      })),
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
  const artifact = await loadLatestReview(tempDir, prRef, headSha);
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

  test("carries the finding on another machine, from the record on the PR (B1)", async () => {
    // No artifact of head B on this machine at all: the review of C runs on another worker.
    loadEarlier.mockImplementation(async () => null);
    await reviewHead(headB, [openFinding]);
    expect(forgeState.map(parseNaxBotMarker).map((marker) => marker?.key)).toContain(carriedRecordKey(headB));
    await reviewHead(headC, [], { reviewedHead: headB, reviewedBase: published, keys: [] });
    expect((await artifactFor(headC)).agreed.map((item) => item.key)).toContain(openKey);
  });

  test("carries nothing at all when neither the PR nor this machine holds a record", async () => {
    loadEarlier.mockImplementation(async () => null);
    await reviewHead(headB, [openFinding]);
    // A PR whose record comment was deleted: nothing claims this head's findings, so nothing is carried.
    forgeState = forgeState.filter((body) => parseNaxBotMarker(body)?.key !== carriedRecordKey(headB));
    await reviewHead(headC, [], { reviewedHead: headB, reviewedBase: published, keys: [] });
    expect((await artifactFor(headC)).agreed).toEqual([]);
  });

  test("widens a review whose carry record does not parse (B3)", async () => {
    await reviewHead(headB, [openFinding]);
    // The record a damaged edit or a foreign writer left: a heading with no usable payload.
    forgeState = forgeState.map((body) =>
      parseNaxBotMarker(body)?.key === carriedRecordKey(headB)
        ? withNaxBotMarker("Carried blocking findings", carriedRecordKey(headB))
        : body,
    );
    await reviewHead(headC, [], { reviewedHead: headB, reviewedBase: published, keys: [] });
    // The review re-read the whole range instead of skipping the part that reported the finding.
    expect(post.mock.calls[0]?.[0].scope).toBe("full");
    expect(post.mock.calls[0]?.[0].carriedFindings).toEqual([]);
  });

  test("holds the reviewed head when the record it needed cannot be written (B1)", async () => {
    await reviewHead(headB, [openFinding], { reviewedHead: published, reviewedBase: publishedBase, keys: [] });
    // The premise: the review whose record landed advances the index.
    expect(advance).toHaveBeenCalledTimes(1);
    advance.mockClear();
    refuse = (argv) => bodyOf(argv).includes(`nax-bot:v1 key=${carriedRecordKey(headC)}`);
    // Head C carries B's finding and cannot write the record that keeps it: nothing may advance.
    await reviewHead(headC, [], { reviewedHead: headB, reviewedBase: published, keys: [] });
    expect(advance).not.toHaveBeenCalled();
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

  test("a bot push recorded after the reviewed head that claims the key ends the carry", async () => {
    const entry: BotPushEntry = {
      base: published,
      sha: headB,
      at: "",
      items: [{ key: openKey, generation: 1, issue: openFinding.issue }],
    };
    expect(await agreedKeys(carriedInput(stateDir, { carriedFixPushes: [entry] }))).toEqual([]);
  });

  test("a push at or before the review that raised the finding cannot end the carry (B1)", async () => {
    // The ledger's whole history reaches back before head B, so a key it holds says nothing about a
    // finding B reported after that push: only `carriedFixPushes` — the pushes after B — may clear one.
    const entry: BotPushEntry = {
      base: published,
      sha: headB,
      at: "",
      items: [{ key: openKey, generation: 1, issue: openFinding.issue }],
    };
    expect(await agreedKeys(carriedInput(stateDir, { botPushes: [entry] }))).toEqual([openKey]);
  });
});

describe("the carried findings record the post leaves on the PR (B1)", () => {
  let stateDir: string;
  /** The record bodies this post wrote, in write order. */
  function records(): string[] {
    return forgeState.filter((body) => parseNaxBotMarker(body)?.key?.startsWith(CARRIED_RECORD_PREFIX));
  }
  beforeEach(() => {
    stateDir = makeTempDir("bot-carried-record-");
    forgeState = [];
    refuse = () => false;
  });
  afterEach(() => {
    cleanupTempDir(stateDir);
  });

  test("records the blocking finding it could not anchor, keyed by the finding", async () => {
    const input = carriedInput(stateDir, {
      carriedFindings: [],
      verdict: { ...emptyVerdict, findings: [openFinding] },
    });
    const outcome = await postPrReview(input);
    const record = parseCarriedRecord(records()[0] ?? "");
    expect(record?.headSha).toBe(headC);
    expect(record?.findings.map(({ key }) => key)).toEqual([openKey]);
    expect(outcome.carriedRecordFailed).toBeUndefined();
  });

  test("records the carry it kept, so a third review still sees it", async () => {
    await postPrReview(carriedInput(stateDir));
    const record = parseCarriedRecord(records()[0] ?? "");
    expect(record?.findings.map(({ key }) => key)).toEqual([openKey]);
  });

  test("holds the reviewed head when the record did not land and there was something to carry", async () => {
    refuse = (argv) => bodyOf(argv).includes(`nax-bot:v1 key=${carriedRecordKey(headC)}`);
    const outcome = await postPrReview(carriedInput(stateDir));
    expect(outcome.carriedRecordFailed).toBe(true);
  });

  test("does not hold the reviewed head when it had nothing to carry", async () => {
    refuse = (argv) => bodyOf(argv).includes(`nax-bot:v1 key=${carriedRecordKey(headC)}`);
    const outcome = await postPrReview(carriedInput(stateDir, { carriedFindings: [] }));
    expect(outcome.carriedRecordFailed).toBeUndefined();
  });

  test("keys the record by the head it speaks for, so a later head writes beside it", async () => {
    await postPrReview(carriedInput(stateDir, { info: { ...info, headSha: headB } }));
    await postPrReview(carriedInput(stateDir, { info: { ...info, headSha: headC } }));
    const keys = records().map((body) => parseNaxBotMarker(body)?.key);
    expect(keys).toEqual([carriedRecordKey(headB), carriedRecordKey(headC)]);
  });

  test("a conversation-only review writes no record: it read no range to carry across", async () => {
    await postPrReview(carriedInput(stateDir, { scope: "conversation-only" }));
    expect(records()).toEqual([]);
  });
});
