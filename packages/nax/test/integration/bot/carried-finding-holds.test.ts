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
  makeBotFixDeps,
  makeBotFixDraftEnv,
  makeBotReviewDeps,
  makeNaxConfig,
  makeTempDir,
  makeTestRuntime,
} from "@test/helpers";
import {
  CARRIED_RECORD_PREFIX,
  CARRY_WIDEN_CLEARED,
  carriedRecordKey,
  carryWidenKey,
  MAX_CARRIED_ENTRIES,
  parseCarriedRecord,
} from "@/bot/carried-record";
import { COVERAGE_RECORD_KEY, parseCoverageRecord } from "@/bot/coverage-record";
import { _fixInputDeps, loadLatestCarry, loadLatestReview } from "@/bot/fix-input";
import { _fixReportDeps, readyStep } from "@/bot/fix-report";
import { _botFixDeps, runBotFix } from "@/bot/fix-run";
import { _fixStepsDeps } from "@/bot/fix-steps";
import { pushEntry } from "@/bot/fix-summary-body";
import { BOT_REVIEW_FILENAME, type BotReviewArtifact, type PostReviewInput, postPrReview } from "@/bot/post";
import { clearCarryWidens } from "@/bot/post-carried";
import { type BotPushEntry, pushRecordBody } from "@/bot/push-ledger";
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
const fixInputOriginal = { ..._fixInputDeps };
const reportOriginal = { ..._fixReportDeps };
const fixOriginal = { ..._botFixDeps };
const stepsOriginal = { ..._fixStepsDeps };
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
const loadEarlier = mock(loadLatestCarry);
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
  loadEarlier.mockImplementation(loadLatestCarry);
  review.mockImplementation(async () => ({ ran: true, verdict }));
  record.mockImplementation(async () => outcome);
  ancestor.mockImplementation(async () => true);
  advance.mockImplementation(async () => ({ kind: "unchanged" as const }));
});
afterEach(async () => {
  Object.assign(_botReviewDeps, original);
  Object.assign(_fixReportDeps, reportOriginal);
  Object.assign(_botFixDeps, fixOriginal);
  Object.assign(_fixStepsDeps, stepsOriginal);
  Object.assign(_fixInputDeps, fixInputOriginal);
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
    forge,
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
    loadLatestCarry: loadEarlier,
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

/** US-004: an incomplete review posts its own signal — `w-carry-incomplete:<head>:<review id>` — per review. */
const signalsAt = (headSha: string): string[] =>
  forgeState
    .map((body) => parseNaxBotMarker(body)?.key ?? "")
    .filter((key) => key.startsWith(`${carryWidenKey(headSha)}:`));

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

  test.each([false, true])(
    "--ready-only holds on the head's preserved carry after a partial full rerun drops it (signal pending: %s)",
    async (withSignal) => {
      await reviewHead(headB, [openFinding]);
      install(headB);
      review.mockImplementationOnce(async () => ({ ran: true, verdict: emptyVerdict, unreadFiles: ["unread.ts"] }));
      expect(await runBotReview({ ...reviewInput, full: true })).toMatchObject({ outcome: "posted" });
      const artifact = await artifactFor(headB);
      // The newest artifact of the head no longer names the blocker; only the preserved record does.
      expect(artifact.agreed.map((item) => item.key)).not.toContain(openKey);
      if (withSignal) forgeState.push(withNaxBotMarker("Incomplete", carryWidenKey(headD)));
      const own = forgeState.flatMap((body, index): OwnComment[] => {
        const key = parseNaxBotMarker(body)?.key;
        return key === undefined
          ? []
          : [{ key, comment: { id: String(index + 1), kind: "comment", author: BOT, body, createdAt: "" } }];
      });

      const base = makeBotFixDraftEnv();
      const env = { ...base, info: { ...base.info, headSha: headB }, review: artifact, own };
      _fixReportDeps.readPrInfo = async () => env.info;
      _fixReportDeps.readCurrentUser = async () => ({ login: BOT });
      _fixReportDeps.listReviewThreads = async () => [];
      _fixReportDeps.listPrComments = async () => [];
      _fixReportDeps.readSettledKeys = async () => new Set<string>();
      const result = await readyStep(env, { step: "ready", timings: {}, outcome: "ready-pass", readyOnly: true });
      expect(result.patch.markedReady).toBe(false);
      expect(result.patch.readyHeld).toContain(withSignal ? "carried finding coverage is incomplete" : openKey);

      // The preserved blocker must be actionable too, not just an indefinite readiness hold.
      const runtime = makeTestRuntime({ config });
      runtimes.push(runtime);
      Object.assign(_botFixDeps, makeBotFixDeps(env, runtime), {
        listPrComments: async () => own.map(({ comment }) => comment),
        checkStep: async () => ({ patch: { outcome: "no-change" }, exit: "no-change" }),
        reportStep: async () => ({ patch: {}, exit: "done" }),
      });
      const fixer = mock<typeof _fixStepsDeps.runBranchFix>(async () => ({ autoCommitted: false, dirty: false }));
      _fixStepsDeps.runBranchFix = fixer;
      _fixStepsDeps.readHead = async () => headB;
      expect(await runBotFix({ ...reviewInput, trust: true })).toMatchObject({ outcome: "no-change" });
      expect(fixer.mock.calls[0]?.[1].findings).toContainEqual(
        expect.objectContaining({ id: openKey, issue: openFinding.issue }),
      );
    },
  );

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
    loadEarlier.mockImplementation(async () => ({ findings: [], widen: false }));
    await reviewHead(headB, [openFinding]);
    expect(forgeState.map(parseNaxBotMarker).map((marker) => marker?.key)).toContain(carriedRecordKey(headB));
    await reviewHead(headC, [], { reviewedHead: headB, reviewedBase: published, keys: [] });
    expect((await artifactFor(headC)).agreed.map((item) => item.key)).toContain(openKey);
  });

  test.each([false, true])(
    "a partial full review at the published head makes the next worker review the full range (prior carry: %s)",
    async (withPrior) => {
      const index = { reviewedHead: published, reviewedBase: publishedBase, keys: [] };
      const carryAtPublished = () =>
        forgeState.filter((body) => parseNaxBotMarker(body)?.key === carriedRecordKey(published));
      if (withPrior) await reviewHead(published, [{ ...openFinding, issue: "Earlier blocker" }]);
      const prior = carryAtPublished();
      expect(prior).toHaveLength(withPrior ? 1 : 0);
      calls = [];
      advance.mockClear();
      outcome = { ...emptyOutcome, index };
      install(published);
      review.mockImplementationOnce(async () => ({
        ran: true,
        verdict: { ...emptyVerdict, findings: [openFinding] },
        unreadFiles: ["unread.ts"],
      }));
      expect(await runBotReview({ ...reviewInput, full: true })).toMatchObject({ outcome: "posted", offLine: 1 });
      expect(summaryBody()).toContain(openFinding.issue);
      expect(advance).not.toHaveBeenCalled();
      expect(carryAtPublished()).toEqual(prior);
      expect(signalsAt(published)).toHaveLength(1);

      // A different worker can only see the forge's state, not the first worker's artifact.
      loadEarlier.mockImplementation(async () => ({ findings: [], widen: false }));
      await reviewHead(headC, [], index);
      expect(post.mock.lastCall?.[0]?.scope).toBe("full");
    },
  );

  test("a partial full review at a head the index has not reached still widens the next worker's review", async () => {
    const index = { reviewedHead: published, reviewedBase: publishedBase, keys: [] };
    outcome = { ...emptyOutcome, index };
    install(headB);
    review.mockImplementationOnce(async () => ({
      ran: true,
      verdict: { ...emptyVerdict, findings: [openFinding] },
      unreadFiles: ["unread.ts"],
    }));
    expect(await runBotReview({ ...reviewInput, full: true })).toMatchObject({ outcome: "posted", offLine: 1 });
    expect(advance).not.toHaveBeenCalled();
    expect(signalsAt(headB)).toHaveLength(1);

    // The index is still at the published head; only the forge's signal at headB says the carry is incomplete.
    loadEarlier.mockImplementation(async () => ({ findings: [], widen: false }));
    await reviewHead(headC, [], index);
    expect(post.mock.lastCall?.[0]?.scope).toBe("full");
  });

  test.each(["advanced", "unchanged", "failed", "skipped"] as const)(
    "a full review clears widening only after the index references its carry: %s",
    async (kind) => {
      const index = { reviewedHead: published, reviewedBase: publishedBase, keys: [] };
      forgeState.push(withNaxBotMarker("Incomplete", carryWidenKey(published)));
      outcome = { ...emptyOutcome, index };
      install(headB);
      _botReviewDeps.advanceReviewedHead = async () => {
        expect(forgeState.some((body) => parseNaxBotMarker(body)?.key === carriedRecordKey(headB))).toBe(true);
        expect(forgeState).not.toContain(withNaxBotMarker(CARRY_WIDEN_CLEARED, carryWidenKey(published)));
        return kind === "skipped" ? { kind, reason: "moved" } : { kind };
      };
      verdict = { ...emptyVerdict, findings: [openFinding] };
      expect(await runBotReview({ ...reviewInput, full: true })).toMatchObject({ outcome: "posted" });
      const confirmed = kind === "advanced" || kind === "unchanged";
      expect(forgeState.includes(withNaxBotMarker(CARRY_WIDEN_CLEARED, carryWidenKey(published)))).toBe(confirmed);
      if (confirmed) forgeState = forgeState.filter((body) => !body.includes("Incomplete"));
      loadEarlier.mockImplementation(async () => ({ findings: [], widen: false }));
      await reviewHead(headC, [], confirmed ? { ...index, reviewedHead: headB } : index);
      expect(post.mock.lastCall?.[0]?.scope).toBe(confirmed ? "incremental" : "full");
      if (confirmed) expect((await artifactFor(headC)).agreed.map(({ key }) => key)).toContain(openKey);
    },
  );

  test("a failed finding reopen in a workflow review keeps the index from advancing", async () => {
    const finding = { ...openFinding, file: "file.ts", line: 1 };
    const thread = {
      id: "T1",
      replyTo: "12",
      path: finding.file,
      line: finding.line,
      resolved: true,
      outdated: false,
      comments: [
        {
          id: "12",
          kind: "thread" as const,
          author: BOT,
          body: withNaxBotMarker("Finding", findingKey(finding)),
          createdAt: "",
        },
      ],
    };
    verdict = { ...emptyVerdict, findings: [finding] };
    install(headB);
    _botReviewDeps.listReviewThreads = async () => [thread];
    refuse = (argv) => argv.includes("id=T1");
    expect(await runBotReview(reviewInput)).toMatchObject({ outcome: "posted", offLine: 1, failed: 1 });
    expect(calls.some((argv) => argv.includes("id=T1"))).toBe(true);
    expect(advance).not.toHaveBeenCalled();
  });

  test("carries nothing at all when neither the PR nor this machine holds a record", async () => {
    loadEarlier.mockImplementation(async () => ({ findings: [], widen: false }));
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

  test.each(["older review", "legacy push", "same review"])(
    "an in-range push citing %s clears a carry only if it saw B's finding",
    async (source) => {
      const sha = "e".repeat(40);
      const older = source === "older review";
      if (older) await reviewHead(published, [openFinding]);
      if (source === "legacy push") {
        forgeState.push(
          pushRecordBody({
            base: published,
            sha,
            at: "",
            items: [{ key: openKey, generation: 1, issue: openFinding.issue }],
          }),
        );
      }
      if (!older) await reviewHead(headB, [openFinding]);
      if (source !== "legacy push") {
        const basedOn = older ? published : headB;
        const review = await artifactFor(basedOn);
        const finding = review.agreed.find(({ key }) => key === openKey);
        expect(finding).toHaveProperty("raisedBy", expect.any(String));
        const base = makeBotFixDraftEnv();
        const entry = pushEntry(
          { ...base, info: { ...base.info, headSha: basedOn }, review },
          {
            step: "report",
            timings: {},
            pushedSha: sha,
            outcome: "pushed",
          },
        );
        if (entry === undefined) throw new Error("expected a fix push entry");
        forgeState.push(pushRecordBody(entry));
      }
      // The SHA is absent from B and reachable from C, even when the push was made before B's review.
      ancestor.mockImplementation(async (_dir, candidate, head) => candidate !== sha || head === headC);
      if (older) await reviewHead(headB, [openFinding]);
      await reviewHead(headC, [], { reviewedHead: headB, reviewedBase: published, keys: [] });
      expect(post.mock.lastCall?.[0].carriedFixPushes?.map((entry) => entry.sha)).toEqual([sha]);
      expect((await artifactFor(headC)).agreed.map(({ key }) => key)).toEqual(
        source === "same review" ? [] : [openKey],
      );
    },
  );

  test.each([false, true])(
    "preserves trigger and evidence under an own-concurrency-only policy (artifact fallback: %s)",
    async (fallback) => {
      config = makeNaxConfig({ outputDir: tempDir, bot: { blockingTriggers: ["own-concurrency"] } });
      const finding = {
        ...openFinding,
        trigger: "own-concurrency" as const,
        triggerEvidence: "Concurrent runs share the cache",
      };
      await reviewHead(headB, [finding]);
      if (fallback) forgeState = forgeState.filter((body) => parseNaxBotMarker(body)?.key !== carriedRecordKey(headB));
      await reviewHead(headC, [], { reviewedHead: headB, reviewedBase: published, keys: [] });
      expect((await artifactFor(headC)).agreed).toEqual([
        expect.objectContaining({ key: openKey, trigger: finding.trigger, triggerEvidence: finding.triggerEvidence }),
      ]);
    },
  );

  test.each([["non-array"], [undefined], [[{ kind: "finding" }]]])(
    "checks artifact usability before ranking: %j",
    async (badAgreed) => {
      const reviewOfB = { version: 3, pr: prRef, headSha: headB, scope: "full" };
      const bad = { ...reviewOfB, agreed: badAgreed };
      const good = {
        ...reviewOfB,
        agreed: [{ kind: "finding", key: openKey, severity: "critical", issue: openFinding.issue }],
      };
      _fixInputDeps.glob = async () => ["newer", "older"];
      _fixInputDeps.readText = async (path) => JSON.stringify(path === "newer" ? bad : good);
      _fixInputDeps.mtimeMs = async (path) => (path === "newer" ? 2 : 1);
      await reviewHead(headC, [], { reviewedHead: headB, reviewedBase: published, keys: [] });
      expect(post.mock.lastCall?.[0]).toMatchObject({ scope: "incremental", carriedFindings: good.agreed });
    },
  );

  test("widens when the real loader finds only a matching artifact with non-array agreed", async () => {
    _fixInputDeps.glob = async () => ["unusable"];
    _fixInputDeps.readText = async () => JSON.stringify({ version: 3, pr: prRef, headSha: headB, agreed: {} });
    _fixInputDeps.mtimeMs = async () => 1;
    await reviewHead(headC, [], { reviewedHead: headB, reviewedBase: published, keys: [] });
    expect(post.mock.lastCall?.[0]?.scope).toBe("full");
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
      items: [{ key: openKey, generation: 1, issue: openFinding.issue, raisedBy: "review-B" }],
    };
    const input = carriedInput(stateDir, { carriedFixPushes: [entry] });
    const carriedFindings = input.carriedFindings?.map((item) => ({ ...item, raisedBy: "review-B" }));
    expect(await agreedKeys(carriedInput(stateDir, { ...input, carriedFindings }))).toEqual([]);
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

  test.each(["unread", "reply", "summary", "coverage", "budget"])(
    "does not replace the earlier record on a full rerun with %s failure",
    async (failure) => {
      await postPrReview(carriedInput(stateDir));
      const prior = records()[0] ?? "";
      expect(parseCarriedRecord(prior)?.findings.map(({ key }) => key)).toEqual([openKey]);
      const own: OwnComment[] = [
        {
          key: carriedRecordKey(headC),
          comment: { id: "1", kind: "comment", author: BOT, body: prior, createdAt: "" },
        },
      ];
      const finder =
        failure === "budget"
          ? Array.from({ length: MAX_CARRIED_ENTRIES + 1 }, (_, index) => ({
              ...openFinding,
              issue: `Finding ${index}`,
            }))
          : [];
      const threads =
        failure === "reply"
          ? [{ id: "t1", replyTo: "1", path: "file.ts", resolved: false, outdated: false, comments: [] }]
          : [];
      const threadVerdicts = threads.map(({ id }) => ({ id, decision: "disagree" as const, reason: "not relevant" }));
      refuse = (argv) =>
        (failure === "reply" && argv.some((arg) => arg.endsWith("/replies"))) ||
        parseNaxBotMarker(bodyOf(argv))?.key ===
          (failure === "summary" ? "summary" : failure === "coverage" ? COVERAGE_RECORD_KEY : "no-refusal");
      const postRerun = postPrReview(
        carriedInput(stateDir, {
          own,
          scope: "full",
          carriedFindings: [],
          threads,
          verdict: { ...emptyVerdict, findings: finder, threads: threadVerdicts },
          unreadFiles: failure === "unread" ? ["file.ts"] : [],
        }),
      );
      if (failure === "summary") await expect(postRerun).rejects.toThrow();
      else {
        const outcome = await postRerun;
        expect(outcome.failed).toBe(failure === "reply" ? 1 : 0);
        expect(outcome.carriedRecordFailed === true).toBe(failure === "budget");
        expect(outcome.coverageRecordFailed === true).toBe(failure === "coverage");
      }
      expect(records()).toEqual([prior]);
      if (failure === "unread") {
        const body = calls.map(bodyOf).findLast((text) => parseNaxBotMarker(text)?.key === COVERAGE_RECORD_KEY);
        expect(parseCoverageRecord(body ?? "")?.uncovered).toEqual(["file.ts"]);
      }
    },
  );

  test.each([false, true])(
    "a complete full rerun clears the prior record only if the edit lands (%s refused)",
    async (refused) => {
      await postPrReview(carriedInput(stateDir));
      const prior = records()[0] ?? "";
      const signalKey = carryWidenKey(headC);
      const own: OwnComment[] = [
        {
          key: carriedRecordKey(headC),
          comment: { id: "1", kind: "comment", author: BOT, body: prior, createdAt: "" },
        },
        {
          key: signalKey,
          comment: { id: "2", kind: "comment", author: BOT, body: "Incomplete", createdAt: "" },
        },
      ];
      refuse = (argv) =>
        refused && argv.includes("PATCH") && parseNaxBotMarker(bodyOf(argv))?.key === carriedRecordKey(headC);
      const outcome = await postPrReview(carriedInput(stateDir, { own, scope: "full", carriedFindings: [] }));
      expect(forgeState).not.toContain(withNaxBotMarker(CARRY_WIDEN_CLEARED, signalKey));
      if (refused) {
        expect(outcome.carriedRecordFailed).toBe(true);
        expect(records()).toEqual([prior]);
        expect(parseCarriedRecord(prior)?.findings.map(({ key }) => key)).toEqual([openKey]);
      } else {
        expect(outcome.carriedRecordFailed).toBeUndefined();
        expect(records()).toHaveLength(2);
        expect(parseCarriedRecord(records()[1] ?? "")).toEqual({ headSha: headC, findings: [] });
      }
    },
  );

  test("a complete full review also clears the incomplete signal an earlier head left", async () => {
    const signalKey = carryWidenKey(headB);
    const own: OwnComment[] = [
      {
        key: signalKey,
        comment: { id: "2", kind: "comment", author: BOT, body: "Incomplete", createdAt: "" },
      },
    ];
    const outcome = await postPrReview(carriedInput(stateDir, { own, scope: "full", carriedFindings: [] }));
    expect(outcome.carriedRecordFailed).toBeUndefined();
    expect(forgeState).not.toContain(withNaxBotMarker(CARRY_WIDEN_CLEARED, signalKey));
    // The caller has confirmed the index references the new carry before clearing signals.
    expect(await clearCarryWidens(carriedInput(stateDir, { own }))).toBe(true);
    expect(forgeState).toContain(withNaxBotMarker(CARRY_WIDEN_CLEARED, signalKey));
  });

  test("a conversation-only review writes no record: it read no range to carry across", async () => {
    await postPrReview(carriedInput(stateDir, { scope: "conversation-only" }));
    expect(records()).toEqual([]);
  });
});
