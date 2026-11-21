import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeBotReviewDeps, makeNaxConfig, makeScriptedCallOp, makeTestRuntime } from "@test/helpers";
import type { BotReviewArtifact } from "@/bot";
import type { BotPushEntry } from "@/bot/push-ledger";
import { pushRecordBody, withPushLedger } from "@/bot/push-ledger";
import { findingKey } from "@/bot/render";
import { _botReviewDeps, runBotReview } from "@/bot/review-run";
import { _reviewStepDeps } from "@/bot/review-step";
import type { RecordRulingsOutcome, recordPrRulings } from "@/bot/rulings";
import { NAX_WORKFLOW_PR_MARKER, type PrComment, type PrInfo, type PrThread, withNaxBotMarker } from "@/forge";
import { initLogger, resetLogger } from "@/logger";
import type { PrFinding, PrReviewVerdict } from "@/operations";
import { _workflowDeps } from "@/workflow/step-context";

const HEAD = "a".repeat(40);
const BASE = "e".repeat(40);
const PUSH = "c".repeat(40);
const BLAMED = "5".repeat(40);
const RANGE_BASE = "d".repeat(40);
const REVIEWED_BASE = "9".repeat(40);
const SUMMARY_ID = "900";
const FILE = "src/a.ts";
const LINE = 12;
/** The anchor a re-raised finding moved to while keeping its key (B3). */
const RE_RAISED_LINE = 22;
const EARLIER_KEY = `f-${"0".repeat(16)}`;

const original = { ..._botReviewDeps };
const workflow = { ..._workflowDeps };
const step = { ..._reviewStepDeps };
const config = makeNaxConfig({ bot: { models: { rulings: "balanced" } } });
const input = { dir: "/repo", pr: 7, profiles: [], interactive: false };
const finding: PrFinding = { kind: "quality", severity: "important", issue: "Lock leaks", file: FILE, line: LINE };
const emptyVerdict: PrReviewVerdict = {
  intent: "pass",
  quality: "approved",
  findings: [],
  threads: [],
  comments: [],
  cannotVerify: [],
  inspectedFiles: [],
};
const push: BotPushEntry = {
  base: BASE,
  sha: PUSH,
  at: "2026-01-01T00:00:00.000Z",
  items: [{ key: "f-a", generation: 0, issue: "lock leaks" }],
};

type BlameAnswer = { readonly sha: string } | { readonly failed: true };
interface GitAnswers {
  /** Exit code per `merge-base --is-ancestor <ancestor> <descendant>` question. */
  readonly ancestry: Readonly<Record<string, number>>;
  /** What blame reports; a failed blame is the missing-answer case. */
  readonly blame?: BlameAnswer;
  /** One blame answer per line number, for the cases where two anchors blame to different pushes. */
  readonly blameAt?: Readonly<Record<number, BlameAnswer>>;
}

let runtime: ReturnType<typeof makeTestRuntime>;
let info: PrInfo;
let outcome: RecordRulingsOutcome;
let verdict: PrReviewVerdict;
let threads: PrThread[];
let comments: PrComment[];
let prompts: { prompt?: string }[];
type ForgeRun = (
  argv: string[],
  options: { cwd: string },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
let run: ReturnType<typeof mock<ForgeRun>>;

/** The body of every comment the review wrote through the forge (inline, reply or summary). */
function postedBodies(endpoint?: string): string[] {
  return run.mock.calls
    .filter(([args]) => endpoint === undefined || args.includes(endpoint))
    .flatMap(([args]) => args.filter((arg) => arg.startsWith("body=")))
    .map((arg) => arg.slice("body=".length));
}

/** The prompt the real review step handed to the review operation. */
function prompt(): string {
  const value = prompts[0]?.prompt;
  if (value === undefined) throw new Error("the review operation was not dispatched with a prompt");
  return value;
}

/** The bot's own fix summary: the ledger of its pushes, carried in the comment it edits in place. */
function summaryComment(entries: readonly BotPushEntry[]): PrComment {
  const body = withNaxBotMarker("Pushed abcdef1: 2 agreed items fixed in one round.", "fix-summary");
  return { id: SUMMARY_ID, kind: "comment", author: "bot", body: withPushLedger(body, entries), createdAt: "" };
}

/** A push's own append-only record: the copy a summary rewrite cannot erase (B1). */
function pushRecordComment(entry: BotPushEntry): PrComment {
  return { id: "901", kind: "comment", author: "bot", body: pushRecordBody(entry), createdAt: "" };
}

/** An open finding thread an earlier bot review opened, at the line the tests blame. */
function earlierThread(key = EARLIER_KEY, line = LINE, id = "T1"): PrThread {
  const opener = {
    id: "77",
    kind: "thread" as const,
    author: "bot",
    body: withNaxBotMarker("**Important** (quality): Lock leaks", key),
    createdAt: "",
  };
  return { id, replyTo: "77", path: FILE, line, resolved: false, outdated: false, comments: [opener] };
}

/** A git whose answers are exactly the questions a test declared. */
function stubGit(answers: GitAnswers) {
  return mock(async (args: string[], _dir: string) => {
    if (args[0] === "blame") {
      const line = Number.parseInt((args[3] ?? "").split(",")[0] ?? "", 10);
      const blame = answers.blameAt?.[line] ?? answers.blame ?? { sha: PUSH };
      if ("failed" in blame) return { exitCode: 128, stdout: "", stderr: "fatal: no such path" };
      return { exitCode: 0, stdout: `${blame.sha} 1 1 1\nfilename ${FILE}\n\tconst x = 1;\n`, stderr: "" };
    }
    const [, , ancestor, descendant] = args;
    const exitCode = answers.ancestry[`${ancestor}>${descendant}`];
    if (exitCode === undefined) throw new Error(`unexpected ancestry question ${ancestor} > ${descendant}`);
    return { exitCode, stdout: "", stderr: "" };
  });
}

/** The ancestry seam the range decisions use (reviewRange and the prompt's push selection). */
function stubAncestry(answers: Readonly<Record<string, boolean>>) {
  return mock(async (_dir: string, ancestor: string, descendant: string) => {
    const answer = answers[`${ancestor}>${descendant}`];
    if (answer === undefined) throw new Error(`unexpected isAncestor question ${ancestor} > ${descendant}`);
    return answer;
  });
}

/** Review the PR and read the artifact the post node wrote. */
async function reviewArtifact(): Promise<BotReviewArtifact> {
  const result = await runBotReview(input);
  if (result.outcome !== "posted") throw new Error(`the review did not post: ${result.outcome}`);
  return Bun.file(result.artifactPath).json();
}

function agreedFinding(artifact: BotReviewArtifact, key: string) {
  return artifact.agreed.find((item) => item.key === key);
}

beforeEach(() => {
  initLogger({ level: "silent" });
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
    headSha: HEAD,
    crossRepo: false,
  };
  outcome = { index: undefined, recorded: [], settled: [], open: [], asked: 0, failed: 0 };
  verdict = emptyVerdict;
  threads = [];
  comments = [];
  prompts = [];
  run = mock<ForgeRun>(async () => ({ exitCode: 0, stdout: '{"id":42}', stderr: "" }));
  runtime = makeTestRuntime({ config });
  const record = mock<typeof recordPrRulings>(async () => outcome);
  _reviewStepDeps.writeBranchReviewPackage = async () => ["changed"];
  _workflowDeps.appendChangedFileRules = async () => {};
  _workflowDeps.callOp = makeScriptedCallOp((_op, value) => {
    prompts.push(value as { prompt?: string });
    return verdict;
  });
  Object.assign(_botReviewDeps, makeBotReviewDeps({ config, runtime, info: () => info }), {
    recordPrRulings: record,
    listPrComments: async () => comments,
    listReviewThreads: async () => threads,
    isAncestor: stubAncestry({}),
    runGit: stubGit({ ancestry: {} }),
    forge: { run, readText: async () => null },
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

describe("runBotReview finding lineage", () => {
  test("AC-15 gives an agreed finding the lineage of the push blamed for its line", async () => {
    comments = [summaryComment([push])];
    verdict = { ...emptyVerdict, findings: [finding] };
    _botReviewDeps.runGit = stubGit({ ancestry: { [`${PUSH}>${HEAD}`]: 0 } });

    const artifact = await reviewArtifact();

    expect(agreedFinding(artifact, findingKey(finding))).toMatchObject({
      lineage: { generation: 1, parents: ["f-a"], pushSha: PUSH },
    });
    expect(artifact.unreachablePushes).toBeUndefined();
  });
  test("AC-16 posts the lineage line on the inline comment of a new finding", async () => {
    comments = [summaryComment([push])];
    verdict = { ...emptyVerdict, findings: [finding] };
    _botReviewDeps.runGit = stubGit({ ancestry: { [`${PUSH}>${HEAD}`]: 0 } });

    await runBotReview(input);

    expect(postedBodies("repos/o/r/pulls/7/comments")).toContainEqual(
      expect.stringContaining(`Lineage: generation 1, on lines added by nax bot fix ${PUSH.slice(0, 7)} for f-a`),
    );
  });
  test("AC-17 counts a ledger entry the reviewed head cannot reach", async () => {
    comments = [summaryComment([push])];
    verdict = { ...emptyVerdict, findings: [finding] };
    _botReviewDeps.runGit = stubGit({ ancestry: { [`${PUSH}>${HEAD}`]: 1 } });

    const artifact = await reviewArtifact();

    expect(artifact.unreachablePushes).toBe(1);
    expect(agreedFinding(artifact, findingKey(finding))).not.toHaveProperty("lineage");
  });
  test("AC-18 lists a push of an incremental range in the review prompt", async () => {
    outcome = { ...outcome, index: { reviewedHead: RANGE_BASE, reviewedBase: REVIEWED_BASE, keys: [] } };
    comments = [summaryComment([push])];
    _botReviewDeps.isAncestor = stubAncestry({
      [`${RANGE_BASE}>${HEAD}`]: true,
      [`${REVIEWED_BASE}>merge`]: true,
      [`${PUSH}>${HEAD}`]: true,
      [`${PUSH}>${RANGE_BASE}`]: false,
    });
    _botReviewDeps.runGit = stubGit({ ancestry: { [`${PUSH}>${HEAD}`]: 0 } });

    await runBotReview(input);

    expect(prompt()).toContain("## Earlier nax bot fix pushes in this range");
    expect(prompt()).toContain(
      `- ${BASE.slice(0, 7)}..${PUSH.slice(0, 7)}: nax bot fix for f-a (lock leaks), generation 0`,
    );
  });
  test.each([
    ["no own fix summary at all", []],
    ["an own fix summary with an empty ledger", [summaryComment([])]],
  ])("AC-19 asks git nothing and writes no lineage with %s", async (_name, summary) => {
    comments = summary;
    verdict = { ...emptyVerdict, findings: [finding] };
    const runGit = stubGit({ ancestry: {} });
    _botReviewDeps.runGit = runGit;

    const artifact = await reviewArtifact();

    // The empty case proves the ledger reader ran and still had nothing to ask git about.
    expect(postedBodies()).not.toContainEqual(expect.stringContaining("Lineage:"));
    expect(agreedFinding(artifact, findingKey(finding))).not.toHaveProperty("lineage");
    expect(runGit).not.toHaveBeenCalled();
  });
  // B3: `findingKey` names the file and the issue, not the line, so a re-raised finding shares its key
  // with the thread it replaces. The two anchors can blame to different pushes, and the verdict is the
  // one the artifact records — so its anchor, not the earlier thread's, is what the lineage must read.
  test("B3: a re-raised finding keeps the lineage of the anchor the verdict names", async () => {
    const earlierPush = "4".repeat(40);
    const key = findingKey({ file: FILE, issue: finding.issue });
    threads = [earlierThread(key)];
    comments = [summaryComment([push, { ...push, sha: earlierPush }])];
    verdict = { ...emptyVerdict, findings: [{ ...finding, line: RE_RAISED_LINE }] };
    _botReviewDeps.runGit = stubGit({
      ancestry: {
        [`${PUSH}>${HEAD}`]: 0,
        [`${earlierPush}>${HEAD}`]: 0,
        // The two pushes are unrelated, so neither owns the other's lines.
        [`${earlierPush}>${PUSH}`]: 1,
        [`${PUSH}>${earlierPush}`]: 1,
      },
      blameAt: { [LINE]: { sha: earlierPush }, [RE_RAISED_LINE]: { sha: PUSH } },
    });

    const artifact = await reviewArtifact();

    expect(agreedFinding(artifact, key)).toMatchObject({ lineage: { pushSha: PUSH } });
  });
  // B3: two open threads can carry one marker key (a re-raised finding whose earlier thread was never
  // closed). The artifact keeps the first thread, so its anchor — not the second thread's — is what the
  // lineage must read, even though the two anchors blame to different pushes.
  test("B3: two carried-over threads with one key take the lineage of the thread the artifact keeps", async () => {
    const firstPush = "4".repeat(40);
    const secondPush = "6".repeat(40);
    const secondLine = 30;
    threads = [earlierThread(EARLIER_KEY, LINE, "T1"), earlierThread(EARLIER_KEY, secondLine, "T2")];
    comments = [summaryComment([push, { ...push, sha: firstPush }, { ...push, sha: secondPush }])];
    _botReviewDeps.runGit = stubGit({
      ancestry: {
        [`${PUSH}>${HEAD}`]: 0,
        [`${firstPush}>${HEAD}`]: 0,
        [`${secondPush}>${HEAD}`]: 0,
        // The pushes are unrelated, so neither owns another's lines.
        [`${firstPush}>${PUSH}`]: 1,
        [`${PUSH}>${firstPush}`]: 1,
        [`${secondPush}>${PUSH}`]: 1,
        [`${PUSH}>${secondPush}`]: 1,
        [`${secondPush}>${firstPush}`]: 1,
        [`${firstPush}>${secondPush}`]: 1,
      },
      blameAt: { [LINE]: { sha: firstPush }, [secondLine]: { sha: secondPush } },
    });

    const artifact = await reviewArtifact();

    // The artifact keeps the first thread's anchor, so that is the anchor the lineage belongs to.
    expect(agreedFinding(artifact, EARLIER_KEY)).toMatchObject({ line: LINE, lineage: { pushSha: firstPush } });
  });
  // B1: the summary's block is written by whole-body writers, so a stale rewrite can drop an entry.
  // The review reads the append-only copy each push posts beside it, so the push is still dated.
  test("B1: a push recorded only in its own comment still gives the finding a lineage", async () => {
    comments = [summaryComment([]), pushRecordComment(push)];
    verdict = { ...emptyVerdict, findings: [finding] };
    _botReviewDeps.runGit = stubGit({ ancestry: { [`${PUSH}>${HEAD}`]: 0 } });

    const artifact = await reviewArtifact();

    expect(agreedFinding(artifact, findingKey(finding))).toMatchObject({
      lineage: { generation: 1, parents: ["f-a"], pushSha: PUSH },
    });
  });
  test("AC-21 gives a merged earlier finding the lineage of its own thread key", async () => {
    threads = [earlierThread()];
    comments = [summaryComment([push])];
    _botReviewDeps.runGit = stubGit({ ancestry: { [`${PUSH}>${HEAD}`]: 0 } });

    const artifact = await reviewArtifact();

    expect(agreedFinding(artifact, EARLIER_KEY)).toMatchObject({ lineage: { pushSha: PUSH, parents: ["f-a"] } });
  });
  test.each([
    ["the finding's blame failed", { ancestry: { [`${PUSH}>${HEAD}`]: 0 }, blame: { failed: true as const } }],
    [
      "the matching ancestry check errored",
      { ancestry: { [`${PUSH}>${HEAD}`]: 0, [`${BLAMED}>${PUSH}`]: 2 }, blame: { sha: BLAMED } },
    ],
  ])("AC-24 keeps reviewing with lineageUnknown when %s", async (_name, answers: GitAnswers) => {
    comments = [summaryComment([push])];
    verdict = { ...emptyVerdict, findings: [finding] };
    _botReviewDeps.runGit = stubGit(answers);

    const artifact = await reviewArtifact();

    const agreed = agreedFinding(artifact, findingKey(finding));
    expect(agreed).toMatchObject({ lineageUnknown: true });
    expect(agreed).not.toHaveProperty("lineage");
  });
});

/** The claim the reviewer made: a finding on a line a bot fix wrote, with the evidence it gave for it. */
const fixGap: PrFinding = { ...finding, origin: "fix-gap", originEvidence: "the fix added this line" };

/** An incremental review whose range holds P: the reviewed head and P are reachable, P is after the range base. */
function incrementalRange(): void {
  outcome = { ...outcome, index: { reviewedHead: RANGE_BASE, reviewedBase: REVIEWED_BASE, keys: [] } };
  _botReviewDeps.isAncestor = stubAncestry({
    [`${RANGE_BASE}>${HEAD}`]: true,
    [`${REVIEWED_BASE}>merge`]: true,
    [`${PUSH}>${HEAD}`]: true,
    [`${PUSH}>${RANGE_BASE}`]: false,
  });
}

/** The review summary the post node wrote: the only body it posts at the issue endpoint that opens this way. */
function summaryBody(): string {
  const body = postedBodies().find((text) => text.includes("Review of"));
  if (body === undefined) throw new Error("the review posted no summary");
  return body;
}

describe("runBotReview finding origins", () => {
  beforeEach(() => {
    incrementalRange();
    comments = [summaryComment([push])];
    verdict = { ...emptyVerdict, findings: [fixGap] };
    // Blame names P itself, which the reviewed head reaches, so the push owns the finding's line.
    _botReviewDeps.runGit = stubGit({ ancestry: { [`${PUSH}>${HEAD}`]: 0 } });
  });

  test("AC-12 posts no inline comment for a fix-gap finding a bot push backs", async () => {
    await runBotReview(input);

    expect(postedBodies("repos/o/r/pulls/7/comments")).not.toContainEqual(expect.stringContaining(fixGap.issue));
  });

  test("AC-13 lists a backed fix-gap finding as residual with its origin in the parenthesis", async () => {
    await runBotReview(input);

    expect(summaryBody()).toContain("### Residual findings (not blocking)");
    expect(summaryBody()).toContain(`${fixGap.issue} (trigger normal; origin fix-gap`);
  });

  test("AC-14 records the fix-gap origin and its evidence on the agreed item", async () => {
    const artifact = await reviewArtifact();

    expect(agreedFinding(artifact, findingKey(fixGap))).toMatchObject({
      origin: "fix-gap",
      originEvidence: fixGap.originEvidence,
    });
  });

  test("AC-15 posts an inline comment when blame names a commit the push cannot reach", async () => {
    // The ancestry answer this test adds: the blamed commit is not reachable from the push.
    _botReviewDeps.runGit = stubGit({
      ancestry: { [`${PUSH}>${HEAD}`]: 0, [`${BLAMED}>${PUSH}`]: 1 },
      blame: { sha: BLAMED },
    });

    await runBotReview(input);

    expect(postedBodies("repos/o/r/pulls/7/comments")).toContainEqual(expect.stringContaining(fixGap.issue));
  });

  test("AC-16 records the unsupported claim as pr, with no evidence left behind", async () => {
    _botReviewDeps.runGit = stubGit({
      ancestry: { [`${PUSH}>${HEAD}`]: 0, [`${BLAMED}>${PUSH}`]: 1 },
      blame: { sha: BLAMED },
    });

    const artifact = await reviewArtifact();

    const agreed = agreedFinding(artifact, findingKey(fixGap));
    expect(agreed).toMatchObject({ origin: "pr" });
    expect(agreed).not.toHaveProperty("originEvidence");
  });

  test("AC-20 settles an unsolicited fix-gap claim a review that listed no bot push still states", async () => {
    // No ledger at all: nothing in range to list, and no lineage that could back the claim.
    comments = [];

    const artifact = await reviewArtifact();

    expect(prompt()).not.toContain("## Earlier nax bot fix pushes in this range");
    expect(agreedFinding(artifact, findingKey(fixGap))).toMatchObject({ origin: "pr" });
  });
});
