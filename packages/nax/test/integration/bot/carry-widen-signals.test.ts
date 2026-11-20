/**
 * US-004 (#3000): one incomplete-carry signal per review, keyed by head and review id.
 *
 * An incomplete review used to leave one signal per head. A complete review of that head then edited that
 * single comment to the cleared text, including a signal another review posted after the complete review
 * read its starting snapshot, and the next worker trusted a carry record that never held the new blocker.
 * Keying each signal by the review that posted it keeps the snapshot-scoped clear honest: a complete review
 * edits only the signals it read at start, and anything posted after that read stays pending.
 *
 * The forge here holds real comment state — a post appends, a PATCH edits the comment it names — so the
 * assertions read the PR back the way the next worker's `ownComments` would.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeBotReviewDeps, makeNaxConfig, makeTempDir, makeTestRuntime } from "@test/helpers";
import { CARRY_INCOMPLETE_HOLD, carriedReadiness } from "@/bot/carried-hold";
import {
  CARRY_WIDEN_CLEARED,
  carriedRecordKey,
  carryWidenKey,
  carryWidenPending,
  carryWidenReviewKey,
} from "@/bot/carried-record";
import { BOT_REVIEW_FILENAME, type BotReviewArtifact, type PostReviewInput, postPrReview } from "@/bot/post";
import { postCarriedRecord } from "@/bot/post-carried";
import { _botReviewDeps, runBotReview } from "@/bot/review-run";
import type { runPrReview } from "@/bot/review-step";
import type { RecordRulingsOutcome, recordPrRulings } from "@/bot/rulings";
import {
  type ForgeDeps,
  type ForgeRunResult,
  NAX_WORKFLOW_PR_MARKER,
  type OwnComment,
  type PrComment,
  type PrInfo,
  type PrRef,
  parseNaxBotMarker,
  withNaxBotMarker,
} from "@/forge";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import type { PrFinding, PrReviewVerdict } from "@/operations";
import { DEFAULT_BLOCKING_TRIGGERS } from "@/workflow/blocking-findings";

const PR = 7;
const BOT = "bot";
const published = "a".repeat(40);
const publishedBase = "9".repeat(40);
const headB = "b".repeat(40);
/** Review ids the post-level cases do not generate themselves; both are lowercase like a real one. */
const olderReview = "11111111-1111-4111-8111-111111111111";
const postingReview = "22222222-2222-4222-8222-222222222222";
/** Every incomplete-review signal shares this prefix, whichever review posted it. */
const SIGNAL_PREFIX = "w-carry-incomplete:";
const PENDING_TEXT = "Carried finding coverage is incomplete. Review the full range before relying on this head.";
/** A blocking finding the reviewer gave no line for: only a record or a signal can hold it. */
const openFinding: PrFinding = {
  kind: "quality",
  severity: "critical",
  issue: "Token cache entries are shared across users",
};
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
const prRef: PrRef = { forge: "github", host: "test", repo: "o/r", number: PR };
const reviewInput = { dir: "/repo", pr: PR, profiles: [], interactive: false };

/** One comment as the fake forge holds it: `id` is the database id a PATCH targets. */
interface ForgeComment {
  id: string;
  body: string;
}

const original = { ..._botReviewDeps };
const runtimes: ReturnType<typeof makeTestRuntime>[] = [];
let tempDir: string;
let stateDir: string;
let config: ReturnType<typeof makeNaxConfig>;
let info: PrInfo;
let verdict: PrReviewVerdict;
let outcome: RecordRulingsOutcome;
/** Every write the forge was asked to make, in order. */
let writes: string[][];
/** The PR's top-level comments: a post appends, a PATCH edits the comment it names. */
let comments: ForgeComment[];
let nextId: number;
let refuse: (argv: readonly string[]) => boolean;

const review = mock<typeof runPrReview>(async () => ({ ran: true, verdict }));
const record = mock<typeof recordPrRulings>(async () => outcome);
const ancestor = mock(async () => true);
const advance = mock(async () => ({ kind: "advanced" as const }));
/** The real post step, with the recording forge in place of gh/glab. */
const post = mock<typeof _botReviewDeps.postPrReview>(async (postInput) => postPrReview({ ...postInput, deps: forge }));

function bodyOf(argv: readonly string[]): string {
  const arg = argv.find((value) => value.startsWith("body="));
  return arg === undefined ? "" : arg.slice("body=".length);
}

/** The marker key of a write, whether the case passes its argv or the body it built. */
function keyOf(target: readonly string[] | string): string | undefined {
  return parseNaxBotMarker(typeof target === "string" ? target : bodyOf(target))?.key;
}

/** The database id a PATCH edits, read from the endpoint it targets. */
function patchId(argv: readonly string[]): string | undefined {
  if (!argv.includes("PATCH")) return undefined;
  return argv.find((arg) => arg.includes("/comments/"))?.split("/comments/")[1];
}

const forge: ForgeDeps = {
  async run(argv): Promise<ForgeRunResult> {
    writes.push(argv);
    if (refuse(argv)) return { exitCode: 1, stdout: "", stderr: "forge refused the write" };
    const body = bodyOf(argv);
    const edited = patchId(argv);
    if (edited === undefined) {
      if (body !== "") comments.push({ id: String(nextId++), body });
    } else {
      const target = comments.find(({ id }) => id === edited);
      if (target) target.body = body;
    }
    return { exitCode: 0, stdout: JSON.stringify({ id: nextId }), stderr: "" };
  },
  readText: async () => null,
};

/** The PR's top-level comments as the forge lists them, fresh objects each read. */
const listComments = async (): Promise<PrComment[]> =>
  comments.map(({ id, body }) => ({ id, kind: "comment" as const, author: BOT, body, createdAt: "" }));

/** The bot's own comments, as a review reads them when it starts. */
function ownCommentsNow(): OwnComment[] {
  return comments.flatMap(({ id, body }): OwnComment[] => {
    const key = parseNaxBotMarker(body)?.key;
    return key === undefined ? [] : [{ key, comment: { id, kind: "comment", author: BOT, body, createdAt: "" } }];
  });
}

/** Append one signal comment to the PR the way an earlier review left it. */
function signal(key: string): ForgeComment {
  const comment = { id: String(nextId++), body: withNaxBotMarker(PENDING_TEXT, key) };
  comments.push(comment);
  return comment;
}

/** Every incomplete-review signal on the PR, in post order. */
function signalKeys(): string[] {
  return comments
    .map(({ body }) => parseNaxBotMarker(body)?.key)
    .filter((key): key is string => key?.startsWith(SIGNAL_PREFIX) === true);
}

/** The per-review signals still pending at one head. */
function pendingSignalsAt(headSha: string): string[] {
  const prefix = `${carryWidenKey(headSha)}:`;
  return ownCommentsNow()
    .filter((own) => own.key.startsWith(prefix) && carryWidenPending(own))
    .map(({ key }) => key);
}

function postInput(extra: Partial<PostReviewInput> = {}): PostReviewInput {
  return {
    ref: prRef,
    info: { ...info, headSha: headB },
    verdict: emptyVerdict,
    threads: [],
    comments: [],
    own: ownCommentsNow(),
    staticMode: false,
    sensitive: [],
    stateDir,
    deps: forge,
    cwd: stateDir,
    carriedFindings: [],
    ...extra,
  };
}

/** The review id `postPrReview` generated: the artifact attributes its findings to that review. */
async function postedReviewId(): Promise<string> {
  const artifact: BotReviewArtifact = await Bun.file(join(stateDir, BOT_REVIEW_FILENAME)).json();
  const finding = artifact.agreed.find((item) => item.kind === "finding");
  const raisedBy = finding?.kind === "finding" ? finding.raisedBy : undefined;
  if (raisedBy === undefined) throw new Error("the artifact did not record the review that raised the finding");
  return raisedBy;
}

/** One review run, with a fresh runtime: a review closes the runtime it used. */
function install(headSha: string, starting?: readonly PrComment[]): void {
  info = { ...info, headSha };
  const runtime = makeTestRuntime({ config });
  runtimes.push(runtime);
  Object.assign(_botReviewDeps, {
    ...makeBotReviewDeps({ config, runtime, info: () => info }),
    forge,
    // Without a pinned snapshot a run reads the PR as it stands when the run starts.
    listPrComments: async () => (starting === undefined ? await listComments() : [...starting]),
    isAncestor: ancestor,
    recordPrRulings: record,
    runPrReview: review,
    postPrReview: post,
    advanceReviewedHead: advance,
    writeJson: async () => {},
  });
}

beforeEach(() => {
  initLogger({ level: "warn", suppressConsole: true });
  tempDir = makeTempDir("bot-carry-signals-");
  stateDir = makeTempDir("bot-carry-signals-post-");
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
  writes = [];
  comments = [];
  nextId = 1;
  refuse = () => false;
  for (const fn of [review, record, ancestor, advance, post]) fn.mockClear();
  review.mockImplementation(async () => ({ ran: true, verdict }));
  record.mockImplementation(async () => outcome);
  ancestor.mockImplementation(async () => true);
  advance.mockImplementation(async () => ({ kind: "advanced" as const }));
});

afterEach(async () => {
  Object.assign(_botReviewDeps, original);
  mock.restore();
  resetLogger();
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  cleanupTempDir(tempDir);
  cleanupTempDir(stateDir);
});

describe("one incomplete-review signal per review", () => {
  test("AC-9: posts a signal keyed by the head and its own review id beside the one already pending", async () => {
    signal(carryWidenKey(headB));
    const result = await postPrReview(
      postInput({ verdict: { ...emptyVerdict, findings: [openFinding] }, unreadFiles: ["unread.ts"] }),
    );
    expect(result.carriedRecordFailed).toBeUndefined();
    expect(signalKeys()).toContain(carryWidenReviewKey(headB, await postedReviewId()));
  });

  test("AC-10: leaves the signal already pending at that head unedited", async () => {
    const existing = signal(carryWidenKey(headB));
    const before = existing.body;
    await postPrReview(
      postInput({ verdict: { ...emptyVerdict, findings: [openFinding] }, unreadFiles: ["unread.ts"] }),
    );
    expect(existing.body).toBe(before);
    expect(writes.some((argv) => patchId(argv) === existing.id)).toBe(false);
    // The blocker went into a new signal, not into an edit of the old one.
    expect(signalKeys()).toContain(carryWidenReviewKey(headB, await postedReviewId()));
  });

  test("AC-11: adds its own signal beside another review's, leaving two pending at the head", async () => {
    signal(carryWidenReviewKey(headB, olderReview));
    await postPrReview(
      postInput({ verdict: { ...emptyVerdict, findings: [openFinding] }, unreadFiles: ["unread.ts"] }),
    );
    expect(pendingSignalsAt(headB)).toEqual([
      carryWidenReviewKey(headB, olderReview),
      carryWidenReviewKey(headB, await postedReviewId()),
    ]);
  });

  test("AC-12: posts no signal when the incomplete review found no new blocker", async () => {
    await postPrReview(postInput({ unreadFiles: ["unread.ts"] }));
    expect(signalKeys()).toEqual([]);
  });

  test("AC-13: a complete review whose carried-record write fails posts a signal for its own review", async () => {
    refuse = (argv) => keyOf(argv) === carriedRecordKey(headB);
    const result = await postPrReview(
      postInput({ verdict: { ...emptyVerdict, findings: [openFinding] }, scope: "full" }),
    );
    expect(result.carriedRecordFailed).toBe(true);
    expect(signalKeys()).toEqual([carryWidenReviewKey(headB, await postedReviewId())]);
  });
});

describe("a per-review signal that cannot be posted", () => {
  beforeEach(() => {
    refuse = (argv) => keyOf(argv)?.startsWith(SIGNAL_PREFIX) === true;
  });

  test("AC-18: holds the reviewed head", async () => {
    const input = postInput({ verdict: { ...emptyVerdict, findings: [openFinding] }, unreadFiles: ["unread.ts"] });
    expect(await postCarriedRecord(input, [openFinding], { id: postingReview, complete: false })).toBe(false);
    // The write that failed is this review's own signal, not the head-only key it replaced.
    expect(writes.map(bodyOf).map(keyOf)).toContain(carryWidenReviewKey(headB, postingReview));
  });

  test("AC-19: warns on stage bot-post", async () => {
    const logs: LogEntry[] = [];
    const dispose = addSink((entry) => logs.push(entry));
    const input = postInput({ verdict: { ...emptyVerdict, findings: [openFinding] }, unreadFiles: ["unread.ts"] });
    await postCarriedRecord(input, [openFinding], { id: postingReview, complete: false });
    dispose();
    expect(logs.filter((entry) => entry.level === "warn" && entry.stage === "bot-post")).not.toEqual([]);
    // The warn is about this review's own signal write, so it still says which head is held.
    expect(writes.map(bodyOf).map(keyOf)).toContain(carryWidenReviewKey(headB, postingReview));
  });
});

describe("the legacy signal an earlier nax left", () => {
  test("AC-20: a complete full review that read it at start still clears it", async () => {
    const legacy = signal(carryWidenKey(headB));
    install(headB);
    expect(await runBotReview(reviewInput)).toMatchObject({ outcome: "posted" });
    expect(legacy.body).toContain(CARRY_WIDEN_CLEARED);
  });
});

/**
 * The race AC-14..AC-17 describe: review Y reads its snapshot of the bot's comments, incomplete review X
 * posts its own signal for a new blocker, and Y then completes a full review from the snapshot it read.
 */
async function runRace(): Promise<{ read: ForgeComment; posted: string }> {
  const read = signal(carryWidenReviewKey(headB, olderReview));
  const commentsAtStart = await listComments();
  // X starts from the same state and posts beside Y's signal, as the incomplete review does.
  await postPrReview(
    postInput({
      verdict: { ...emptyVerdict, findings: [openFinding] },
      unreadFiles: ["unread.ts"],
      own: ownCommentsNow(),
    }),
  );
  const posted = carryWidenReviewKey(headB, await postedReviewId());
  expect(signalKeys()).toContain(posted);
  // Y's run sees exactly the comments it read before X posted.
  install(headB, commentsAtStart);
  verdict = emptyVerdict;
  const result = await runBotReview(reviewInput);
  if (result.outcome !== "posted") throw new Error(`expected Y to post, got ${result.outcome}`);
  return { read, posted };
}

describe("a complete review racing an incomplete one at the same head", () => {
  test("AC-14: clears the signal it read at start", async () => {
    const { read } = await runRace();
    expect(read.body).toContain(CARRY_WIDEN_CLEARED);
  });

  test("AC-15: leaves the signal posted after that read pending", async () => {
    const { posted } = await runRace();
    expect(pendingSignalsAt(headB)).toEqual([posted]);
  });

  test("AC-16: makes the next review read the newcomer and review the full range", async () => {
    const { posted } = await runRace();
    install(headB);
    expect(await runBotReview(reviewInput)).toMatchObject({ outcome: "posted" });
    expect(post.mock.lastCall?.[0]?.own.map(({ key }) => key)).toContain(posted);
    expect(post.mock.lastCall?.[0]?.scope).toBe("full");
  });

  test("AC-17: holds readiness on the incomplete-carry reason while the newcomer is pending", async () => {
    const { posted } = await runRace();
    expect(carriedReadiness(ownCommentsNow(), headB, DEFAULT_BLOCKING_TRIGGERS)).toEqual({
      kind: "held",
      reason: CARRY_INCOMPLETE_HOLD,
    });
    // The newcomer is what holds it: the record Y wrote at the head is readable on its own.
    const withoutNewcomer = ownCommentsNow().filter(({ key }) => key !== posted);
    expect(carriedReadiness(withoutNewcomer, headB, DEFAULT_BLOCKING_TRIGGERS).kind).toBe("keys");
  });
});
