/**
 * US-004: what a review of a rebased head carries and records, and what `nax bot fix` does with it.
 *
 * The PR was rebased onto the target branch and force-pushed, so the reviewed head is no longer an
 * ancestor of the head. The patch is unchanged (US-003 detects that and records scope `"rebased"`), so
 * the earlier review's blocking findings must still hold the new head, its coverage record must be
 * written at the new head, and `nax bot fix` must read the rebased artifact as that head's code review.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  makeBotFixDeps,
  makeBotFixDraftEnv,
  type makeBotFixEnv,
  makeBotReviewDeps,
  makeNaxConfig,
  makeScriptedCallOp,
  makeTestRuntime,
} from "@test/helpers";
import { _postDeps, type AgreedItem, type BotReviewArtifact, postPrReview as botPostPrReview } from "@/bot";
import { type CarriedEntry, carriedRecordBody, carriedRecordKey, parseCarriedRecord } from "@/bot/carried-record";
import { parseCoverageRecord } from "@/bot/coverage-record";
import { _fixInputDeps, loadLatestReview } from "@/bot/fix-input";
import { _fixReportDeps } from "@/bot/fix-report";
import { _botFixDeps, runBotFix } from "@/bot/fix-run";
import { _fixStepsDeps, fixStep } from "@/bot/fix-steps";
import { _botReviewDeps, runBotReview } from "@/bot/review-run";
import { _reviewStepDeps, runPrReview } from "@/bot/review-step";
import type { RecordRulingsOutcome, recordPrRulings } from "@/bot/rulings";
import { NAX_WORKFLOW_PR_MARKER, type PrComment, type PrInfo, withNaxBotMarker } from "@/forge";
import { initLogger, resetLogger } from "@/logger";
import type { PrReviewVerdict } from "@/operations";
import { _workflowDeps } from "@/workflow/step-context";

/** The head the index says was reviewed, its base, and the head the rebase produced. */
const REVIEWED_HEAD = "a".repeat(40);
const REVIEWED_BASE = "b".repeat(40);
const NEW_HEAD = "c".repeat(40);
/** The merge base the bot's checkout reports for the rebased head. */
const MERGE_BASE = "merge";
/** The blocking finding the reviewed head's record holds and the rebased review must keep holding. */
const CARRIED: CarriedEntry = {
  key: "f-shared",
  severity: "important",
  issue: "Token cache entries are shared across users",
};
const INSTALL_STEPS = [{ command: "bun install --frozen-lockfile", timeoutSeconds: 600 }];

const config = makeNaxConfig({ bot: { models: { rulings: "balanced" } } });
const input = { dir: "/repo", pr: 7, profiles: [], interactive: false };
const verdict: PrReviewVerdict = {
  intent: "pass",
  quality: "approved",
  findings: [],
  threads: [],
  comments: [],
  cannotVerify: [],
  inspectedFiles: [],
};

/** The bot's own carried-record comment for any head, as triage resolves it. */
function recordComment(headSha: string, findings: readonly CarriedEntry[] = [CARRIED]): PrComment {
  const key = carriedRecordKey(headSha);
  return {
    id: `c-${headSha.slice(0, 4)}`,
    kind: "comment",
    author: "bot",
    body: withNaxBotMarker(carriedRecordBody({ headSha, findings }).body, key),
    createdAt: "t",
  };
}

describe("runBotReview of a rebased head (US-004)", () => {
  const original = { ..._botReviewDeps };
  const workflow = { ..._workflowDeps };
  const step = { ..._reviewStepDeps };
  let runtime: ReturnType<typeof makeTestRuntime>;
  let info: PrInfo;
  let outcome: RecordRulingsOutcome;
  let comments: PrComment[];
  let artifacts: BotReviewArtifact[];
  let advance: ReturnType<typeof mock<typeof _botReviewDeps.advanceReviewedHead>>;
  const ancestor = mock(async (_dir: string, _ancestor: string, _head: string) => true);
  const patch = mock(async () => true);
  const record = mock<typeof recordPrRulings>(async () => outcome);
  const writePackage = mock<typeof _reviewStepDeps.writeBranchReviewPackage>(async () => []);
  const review = mock<typeof runPrReview>((ctx, reviewInput) => runPrReview(ctx, reviewInput));
  const forgeRun = mock(async (_cmd: string[], _opts: { cwd: string }) => ({
    exitCode: 0,
    stdout: '{"id":42}',
    stderr: "",
  }));
  const writeArtifact = _postDeps.writeArtifact;

  /** Every body the real post/publish steps handed the forge, marker and all. */
  function postedBodies(): string[] {
    return forgeRun.mock.calls.flatMap(([cmd]) =>
      cmd.filter((arg) => arg.startsWith("body=")).map((arg) => arg.slice("body=".length)),
    );
  }

  /** The carried record the review posted for a head, if it posted one. */
  function carriedRecordOf(headSha: string) {
    return postedBodies().flatMap((body) => {
      const parsed = parseCarriedRecord(body);
      return parsed !== null && parsed.headSha === headSha ? [parsed] : [];
    });
  }

  beforeEach(() => {
    initLogger({ level: "silent" });
    outcome = {
      index: { reviewedHead: REVIEWED_HEAD, reviewedBase: REVIEWED_BASE, keys: [] },
      recorded: [],
      settled: [],
      open: [],
      asked: 0,
      failed: 0,
    };
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
      headSha: NEW_HEAD,
      crossRepo: false,
    };
    // A rebase: the reviewed head is no longer an ancestor, only the base it was reviewed against is.
    ancestor.mockClear();
    ancestor.mockImplementation(async (_dir, ancestorSha) => ancestorSha === REVIEWED_BASE);
    patch.mockClear();
    patch.mockImplementation(async () => true);
    record.mockClear();
    record.mockImplementation(async () => outcome);
    review.mockClear();
    review.mockImplementation((ctx, reviewInput) => runPrReview(ctx, reviewInput));
    for (const doubled of [writePackage, forgeRun]) doubled.mockClear();
    comments = [recordComment(REVIEWED_HEAD)];
    artifacts = [];
    advance = mock(async () => ({ kind: "unchanged" }) as const);
    runtime = makeTestRuntime({ config });
    Object.assign(_botReviewDeps, {
      isAncestor: ancestor,
      ...makeBotReviewDeps({ config, runtime, info: () => info }),
      recordPrRulings: record,
      runPrReview: review,
      postPrReview: botPostPrReview,
      advanceReviewedHead: advance,
      listPrComments: async () => comments,
      forge: { run: forgeRun, readText: async () => null },
      patchEquivalent: patch,
      resolveBotChecks: async () => ({ source: "detected" as const, gates: [], preRun: INSTALL_STEPS }),
      runPreRunSteps: async () => {},
      writeJson: async () => {},
    });
    _postDeps.writeArtifact = async (_path, artifact) => {
      artifacts.push(artifact);
      return 0;
    };
    _reviewStepDeps.writeBranchReviewPackage = writePackage;
    _workflowDeps.appendChangedFileRules = async () => {};
    _workflowDeps.callOp = makeScriptedCallOp(() => verdict);
  });

  afterEach(async () => {
    _postDeps.writeArtifact = writeArtifact;
    Object.assign(_botReviewDeps, original);
    Object.assign(_workflowDeps, workflow);
    Object.assign(_reviewStepDeps, step);
    await runtime.close();
    resetLogger();
  });

  test("AC-8 posts a carried record for the new head that holds the earlier blocking finding's key", async () => {
    const result = await runBotReview(input);
    expect(result.outcome).toBe("posted");
    expect(artifacts[0]?.scope).toBe("rebased");
    const carried = carriedRecordOf(NEW_HEAD);
    expect(carried).toHaveLength(1);
    expect(carried[0]?.findings.map(({ key }) => key)).toEqual([CARRIED.key]);
  });

  test("AC-9 writes the coverage record at the new head with no uncovered files", async () => {
    await runBotReview(input);
    const coverage = postedBodies().flatMap((body) => {
      const parsed = parseCoverageRecord(body);
      return parsed === null ? [] : [parsed];
    });
    expect(coverage).toEqual([{ headSha: NEW_HEAD, uncovered: [] }]);
  });

  test("AC-10 advances the reviewed head to the new head and its merge base", async () => {
    await runBotReview(input);
    expect(advance).toHaveBeenCalledTimes(1);
    expect(advance.mock.calls[0]?.[0]).toMatchObject({
      expectedHead: REVIEWED_HEAD,
      head: NEW_HEAD,
      base: MERGE_BASE,
    });
  });

  test("the rebased review records not-reviewed, not the carried code review's verdict", async () => {
    const result = await runBotReview(input);
    expect(artifacts[0]?.quality).toBe("not-reviewed");
    if (result.outcome !== "posted") throw new Error(`not posted: ${result.reason}`);
    expect(result.quality).toBe("not-reviewed");
  });

  test("AC-13 a pending carry-widen comment widens the rebase review to the full range", async () => {
    const key = `w-carry-incomplete:${REVIEWED_HEAD}:r1`;
    comments = [
      ...comments,
      { id: "signal", kind: "comment", author: "bot", body: withNaxBotMarker("Incomplete", key), createdAt: "t" },
    ];
    await runBotReview(input);
    const called = review.mock.calls[0]?.[1];
    expect(called?.rangeBase).toBe(MERGE_BASE);
    expect(called?.conversationOnly).not.toBe(true);
    // A widened review reads code again, so it writes the review package the talk-only path skips.
    expect(writePackage).toHaveBeenCalled();
    expect(artifacts[0]?.scope).toBe("full");
    expect(carriedRecordOf(NEW_HEAD)[0]?.findings).toEqual([]);
  });

  test("AC-14 an unparseable carried record for the reviewed head widens the rebase review", async () => {
    const key = carriedRecordKey(REVIEWED_HEAD);
    comments = [
      {
        id: "damaged",
        kind: "comment",
        author: "bot",
        body: withNaxBotMarker("Carried blocking findings", key),
        createdAt: "t",
      },
    ];
    await runBotReview(input);
    expect(review.mock.calls[0]?.[1].rangeBase).toBe(MERGE_BASE);
    expect(writePackage).toHaveBeenCalled();
    expect(artifacts[0]?.scope).toBe("full");
  });
});

describe("runBotFix on a rebased head (US-004)", () => {
  const original = { ..._botFixDeps };
  const originalInput = { ..._fixInputDeps };
  const input = { dir: "/repo", pr: 42, profiles: [], interactive: false };
  let env: ReturnType<typeof makeBotFixEnv>;
  let runtime: ReturnType<typeof makeTestRuntime>;
  let comments: PrComment[];
  let forgeRun: ReturnType<typeof mock<(cmd: string[], opts: { cwd: string }) => Promise<unknown>>>;

  /** The head's only review: the rebased artifact, with the carried finding in its record beside it. */
  function rebasedReview(agreed: readonly AgreedItem[]): BotReviewArtifact {
    return {
      version: 3,
      scope: "rebased",
      rebasedFrom: REVIEWED_HEAD,
      pr: env.ref,
      headSha: env.info.headSha,
      trusted: true,
      intent: "pass",
      quality: "not-reviewed",
      agreed,
    };
  }

  function postedBodies(): string[] {
    return forgeRun.mock.calls.flatMap(([cmd]) =>
      cmd.filter((arg) => arg.startsWith("body=")).map((arg) => arg.slice("body=".length)),
    );
  }

  beforeEach(() => {
    initLogger({ level: "silent" });
    env = makeBotFixDraftEnv({ url: "https://github.com/o/r/pull/42" });
    env = { ...env, info: { ...env.info, headSha: NEW_HEAD } };
    comments = [recordComment(NEW_HEAD)];
    forgeRun = mock(async (_cmd: string[], _opts: { cwd: string }) => ({
      exitCode: 0,
      stdout: '{"id":1}',
      stderr: "",
    }));
    runtime = makeTestRuntime({ config: env.config });
    Object.assign(_botFixDeps, makeBotFixDeps(env, runtime), {
      loadLatestReview,
      fixStep: fixStep,
      listPrComments: async () => comments,
      readPrInfo: async () => env.info,
      forge: { run: forgeRun, readText: async () => null },
    });
    spyOn(_fixReportDeps, "readPrInfo").mockResolvedValue(env.info);
    spyOn(_fixReportDeps, "readCurrentUser").mockResolvedValue({ login: "bot" });
    spyOn(_fixReportDeps, "listReviewThreads").mockResolvedValue([]);
    spyOn(_fixReportDeps, "listPrComments").mockImplementation(async () => comments);
    spyOn(_fixReportDeps, "readSettledKeys").mockResolvedValue(new Set<string>());
  });

  afterEach(async () => {
    Object.assign(_botFixDeps, original);
    Object.assign(_fixInputDeps, originalInput);
    mock.restore();
    await runtime.close();
    resetLogger();
  });

  test("AC-11 loads the rebased artifact as the head's code review and runs the fix session", async () => {
    // The head's only artifact is scope "rebased": the code-only read must keep it.
    const agreed: AgreedItem[] = [
      { kind: "thread", key: "w-1", issue: "Rename x", reason: "clearer", threadId: "T1", replyTo: "C1" },
    ];
    const artifact = rebasedReview(agreed);
    Object.assign(_fixInputDeps, {
      glob: async () => ["rebased-review"],
      readText: async () => JSON.stringify(artifact),
      mtimeMs: async () => 1,
    });
    const session = spyOn(_fixStepsDeps, "runBranchFix").mockResolvedValue({ autoCommitted: false, dirty: false });
    spyOn(_fixStepsDeps, "readHead").mockResolvedValue("fixed-head");
    _botFixDeps.checkStep = async () => ({ patch: { outcome: "nothing" }, exit: "no-change" });
    _botFixDeps.reportStep = async () => ({ patch: {}, exit: "done" });
    const result = await runBotFix(input);
    expect(result.outcome).not.toBe("refused");
    expect(session).toHaveBeenCalledTimes(1);
  });

  test("AC-12 the fix summary keeps the draft while the carried record holds the blocking key", async () => {
    const artifact = rebasedReview([]);
    Object.assign(_fixInputDeps, {
      glob: async () => ["rebased-review"],
      readText: async () => JSON.stringify(artifact),
      mtimeMs: async () => 1,
    });
    _botFixDeps.fixStep = async () => ({ patch: { outcome: "nothing" }, exit: "nothing" });
    const result = await runBotFix(input);
    expect(result).toMatchObject({ outcome: "nothing", markedReady: false });
    const summary = postedBodies().find((body) => body.includes("Kept as draft:"));
    expect(summary).toContain(CARRIED.key);
    expect(postedBodies().some((body) => body.includes("Marked ready"))).toBe(false);
  });
});
