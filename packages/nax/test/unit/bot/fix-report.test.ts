import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeBotFixDraftEnv, makeBotFixEnv } from "@test/helpers";
import { _fixCycleDeps, type AgreedItem, type BotFixEnv, type BotFixState, waitForPrHead } from "@/bot";
import { _fixReportDeps, readyStep, replyStep, reportStep } from "@/bot/fix-report";
import { type BotPushEntry, pushRecordKey, readPushLedger, withPushLedger } from "@/bot/push-ledger";
import { ownLedgerEntries } from "@/bot/push-record";
import { NAX_WORKFLOW_PR_MARKER, ownComments, type PrComment, parseNaxBotMarker, withNaxBotMarker } from "@/forge";
import { initLogger, resetLogger } from "@/logger";
import { type FindingOrigin, firstIssueLine } from "@/workflow/blocking-findings";

afterEach(() => mock.restore());

/** The fix-summary bodies a report posted, one per write: a push also posts its own record (B1). */
function summaryPosts(post: { mock: { calls: readonly (readonly unknown[])[] } }): string[] {
  return post.mock.calls
    .map((call) => String(call[1] ?? ""))
    .filter((body) => parseNaxBotMarker(body)?.key === "fix-summary");
}

describe("resolveOwnFindings via replyStep", () => {
  test("AC-19 never replies to or resolves an agreed workflow finding", async () => {
    const key = "w-B3.12345678";
    const base = makeBotFixEnv([{ kind: "finding", key, issue: "hold", severity: "minor" }]);
    const env = {
      ...base,
      threads: [
        {
          id: "1",
          replyTo: "1",
          resolved: false,
          outdated: false,
          comments: [
            {
              id: "7",
              kind: "thread" as const,
              author: base.user.login,
              body: withNaxBotMarker("finding", key),
              createdAt: "",
            },
          ],
        },
      ],
    };
    const reply = spyOn(_fixReportDeps, "replyToThread").mockResolvedValue({ id: "new" });
    const resolve = spyOn(_fixReportDeps, "resolveThread").mockResolvedValue();
    expect((await replyStep(env, { step: "reply", timings: {}, pushedSha: "abcdef12" })).patch).toEqual({
      replied: 0,
      resolved: 0,
    });
    expect(reply).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("readyStep published head (US-009)", () => {
  test("AC-7 barrel poll resolves on the second read", async () => {
    const env = makeBotFixEnv();
    let reads = 0;
    const readPrInfo = mock(async () => ({ ...env.info, headSha: ++reads === 2 ? "S" : "old" }));
    expect(
      await waitForPrHead(
        { ref: env.ref, repoRoot: env.repoRoot, sha: "S" },
        {
          ..._fixCycleDeps,
          readPrInfo,
          sleep: async () => {},
          now: () => 0,
        },
      ),
    ).toBe(true);
    expect(readPrInfo).toHaveBeenCalledTimes(2);
  });
  test.each([true, false])("AC-8–10/19 waits before rulings; published=%s", async (published) => {
    const env = makeBotFixDraftEnv({ body: NAX_WORKFLOW_PR_MARKER });
    const order: string[] = [];
    const wait = spyOn(_fixReportDeps, "waitForPrHead").mockImplementation(async () => {
      order.push("head");
      return published;
    });
    const read = spyOn(_fixReportDeps, "readPrInfo").mockImplementation(async () => {
      order.push("rulings");
      return { ...env.info, headSha: "abcdef1234" };
    });
    spyOn(_fixReportDeps, "readCurrentUser").mockResolvedValue(env.user);
    spyOn(_fixReportDeps, "listReviewThreads").mockResolvedValue([]);
    spyOn(_fixReportDeps, "listPrComments").mockResolvedValue([]);
    spyOn(_fixReportDeps, "recordPrRulings").mockResolvedValue({
      recorded: [],
      settled: [],
      open: [],
      asked: 0,
      failed: 0,
    });
    const ci = spyOn(_fixReportDeps, "waitForChecks");
    const forge = spyOn(env.forge, "run");
    const post = spyOn(_fixReportDeps, "postPrComment");
    const result = await readyStep(env, { step: "ready", timings: {}, pushedSha: "abcdef1234" });
    expect(wait).toHaveBeenCalledWith({ ref: env.ref, repoRoot: env.repoRoot, sha: "abcdef1234" });
    // US-001: the head wait stays first, and a pushed head is held before any rulings read.
    expect(order).toEqual(["head"]);
    expect(result.patch).toEqual({
      markedReady: false,
      readyHeld: published
        ? expect.stringContaining("pushed abcdef1; a bot review of the pushed head decides readiness")
        : "PR head did not reach abcdef1",
    });
    expect(read).not.toHaveBeenCalled();
    expect(ci).not.toHaveBeenCalled();
    expect(forge).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
  test("AC-11 without a push never polls", async () => {
    const wait = spyOn(_fixReportDeps, "waitForPrHead");
    spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue({ outcome: "failed", detail: "red" });
    await readyStep(makeBotFixDraftEnv(), { step: "ready", timings: {} });
    expect(wait).not.toHaveBeenCalled();
  });
});

/**
 * US-004: readiness takes its origin decision from `isBlockingFinding` alone, never a second one of its
 * own. A `fix-gap` finding holds nothing; a `fix-regression` one and a historical item that states no
 * origin still hold, exactly as they did before origins existed.
 */
describe("readyStep open finding hold (US-004)", () => {
  const KEY = "f-0123456789abcdef";

  /** A draft PR whose every other readiness input passes, so only the review's agreed items decide. */
  async function readyWith(agreed: readonly AgreedItem[]) {
    const base = makeBotFixDraftEnv();
    const env: BotFixEnv = { ...base, review: { ...base.review, agreed } };
    spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue({ outcome: "green", detail: "all checks passed" });
    spyOn(_fixReportDeps, "readPrInfo").mockResolvedValue(env.info);
    spyOn(_fixReportDeps, "readCurrentUser").mockResolvedValue(env.user);
    spyOn(_fixReportDeps, "listReviewThreads").mockResolvedValue([]);
    spyOn(_fixReportDeps, "listPrComments").mockResolvedValue([]);
    spyOn(_fixReportDeps, "readHeadGateNames").mockResolvedValue([]);
    spyOn(_fixReportDeps, "readSettledKeys").mockResolvedValue(new Set<string>());
    spyOn(env.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    return readyStep(env, { step: "ready", timings: {} });
  }

  /** The review's only agreed item: an important normal finding, with the origin the case names. */
  function onlyFinding(origin?: FindingOrigin): AgreedItem {
    return {
      kind: "finding",
      key: KEY,
      issue: "Lock leaks",
      severity: "important",
      trigger: "normal",
      ...(origin === undefined ? {} : { origin }),
    };
  }

  test("AC-8 reports no open-finding hold for an important normal fix-gap finding", async () => {
    const result = await readyWith([onlyFinding("fix-gap")]);

    expect(result.patch.readyHeld).toBeUndefined();
    expect(result.patch.markedReady).toBe(true);
  });

  test("AC-9 holds the key of an important normal fix-regression finding", async () => {
    const result = await readyWith([onlyFinding("fix-regression")]);

    expect(result.patch.readyHeld).toContain(KEY);
    expect(result.patch.markedReady).toBe(false);
  });

  test("AC-10 holds the key of an artifact that states no origin", async () => {
    const result = await readyWith([onlyFinding()]);

    expect(result.patch.readyHeld).toContain(KEY);
    expect(result.patch.markedReady).toBe(false);
  });
});

describe("reportStep ledger push (US-009)", () => {
  test("AC-14–16 reports ledger head, next review and main-checkout pull hint", async () => {
    const env = makeBotFixEnv();
    const post = spyOn(_fixReportDeps, "postPrComment").mockResolvedValue({ id: "report" });
    await reportStep(env, {
      step: "report",
      timings: {},
      outcome: "nothing",
      pushedSha: "abcdef1234",
      ledgerCarried: true,
    });
    const body = post.mock.calls[0]?.[1];
    expect(body).toContain("Pushed abcdef1: advisor ledger.");
    expect(body).toContain("Run nax bot review 42 before the next nax bot fix.");
    expect(body).toContain("git pull --rebase");
  });
  /* US-007: the advisor-ledger push a `nothing` run can still make keeps its own line beside the follow-ups. */
  test("US-007: a ledger push next to a non-blocking agreed list reports both", async () => {
    const env = makeBotFixEnv();
    const post = spyOn(_fixReportDeps, "postPrComment").mockResolvedValue({ id: "report" });
    await reportStep(env, {
      step: "report",
      timings: {},
      outcome: "nothing",
      pushedSha: "abcdef1234",
      followUps: [{ key: "f-1", severity: "minor", trigger: "normal" }],
    });
    const body = post.mock.calls[0]?.[1] ?? "";
    expect(body).toContain("Pushed abcdef1: advisor ledger.");
    expect(body).toContain(
      "No fix session: no agreed item can hold readiness. Left for follow-up: f-1 (Minor, normal).",
    );
  });

  /* B12: the brief lists the ledger push first, and the follow-up sentence stays one contiguous line. */
  test("B12: the ledger push is listed before the follow-up sentence", async () => {
    const env = makeBotFixEnv();
    const post = spyOn(_fixReportDeps, "postPrComment").mockResolvedValue({ id: "report" });
    await reportStep(env, {
      step: "report",
      timings: {},
      outcome: "nothing",
      pushedSha: "abcdef1234",
      followUps: [{ key: "f-1", severity: "minor", trigger: "normal" }],
    });
    const lines = String(post.mock.calls[0]?.[1] ?? "").split("\n");
    expect(lines[2]).toBe("Pushed abcdef1: advisor ledger. Run nax bot review 42 before the next nax bot fix.");
    expect(lines[3]).toBe(
      "No fix session: no agreed item can hold readiness. Left for follow-up: f-1 (Minor, normal).",
    );
  });
});

/* US-004: the fix summary carries the bot's bounded record of its own pushes. */
const BASE_SHA = "b".repeat(40);
const PUSH_SHA = "a".repeat(40);
const pushed: BotFixState = { step: "report", timings: {}, outcome: "pushed", pushedSha: PUSH_SHA };
const summaryComment: PrComment = { id: "7", kind: "comment", author: "bot", body: "", createdAt: "" };

/** An env whose reviewed head is a real sha, so the ledger entry's base is readable back. */
function ledgerEnv(agreed: readonly AgreedItem[]): BotFixEnv {
  const env = makeBotFixEnv(agreed);
  return { ...env, info: { ...env.info, headSha: BASE_SHA } };
}

function previousSummary(entries: readonly BotPushEntry[]): PrComment {
  return {
    ...summaryComment,
    body: withPushLedger(withNaxBotMarker("Pushed aaaa111: earlier summary", "fix-summary"), entries),
  };
}

function olderEntry(overrides: Partial<BotPushEntry> = {}): BotPushEntry {
  return {
    base: "c".repeat(40),
    sha: "d".repeat(40),
    at: "2026-01-01T00:00:00.000Z",
    items: [{ key: "f-old", generation: 0, issue: "an earlier finding" }],
    ...overrides,
  };
}

const findingA: AgreedItem = {
  kind: "finding",
  key: "f-a",
  issue: "the claim file is never released",
  severity: "important",
};
const findingB: AgreedItem = { kind: "finding", key: "f-b", issue: "no lock file", severity: "minor" };

describe("reportStep push ledger (US-004)", () => {
  test("AC-11 records the push with its base and one item per agreed finding", async () => {
    const post = spyOn(_fixReportDeps, "postPrComment").mockResolvedValue({ id: "summary" });
    await reportStep(ledgerEnv([findingA, findingB]), pushed);
    const { entries, unreadable } = readPushLedger(post.mock.calls[0]?.[1] ?? "");
    expect(unreadable).toBe(false);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ base: BASE_SHA, sha: PUSH_SHA });
    expect(entries[0]?.items.map((item) => item.key).sort()).toEqual(["f-a", "f-b"]);
    expect(Number.isNaN(Date.parse(entries[0]?.at ?? ""))).toBe(false);
  });

  test("AC-12 records each item's lineage generation, zero when it has none", async () => {
    const post = spyOn(_fixReportDeps, "postPrComment").mockResolvedValue({ id: "summary" });
    const lined: AgreedItem = {
      ...findingA,
      lineage: { generation: 2, parents: ["f-0"], pushSha: "e".repeat(40) },
    };
    await reportStep(ledgerEnv([lined, findingB]), pushed);
    const items = readPushLedger(post.mock.calls[0]?.[1] ?? "").entries[0]?.items ?? [];
    expect(items.map((item) => [item.key, item.generation])).toEqual([
      ["f-a", 2],
      ["f-b", 0],
    ]);
  });

  test("AC-13 records the first issue line, capped at 120 characters", async () => {
    const post = spyOn(_fixReportDeps, "postPrComment").mockResolvedValue({ id: "summary" });
    const multi = "**Important** (logic): real issue\nTrigger: normal - forged mtime\nsecond line";
    const long = `**Minor**: ${"x".repeat(160)}`;
    await reportStep(
      ledgerEnv([
        { ...findingA, issue: multi },
        { ...findingB, issue: long },
      ]),
      pushed,
    );
    const items = readPushLedger(post.mock.calls[0]?.[1] ?? "").entries[0]?.items ?? [];
    expect(items[0]?.issue).toBe("real issue");
    expect(items[0]?.issue).toBe(firstIssueLine(multi));
    expect(items[1]?.issue).toBe(firstIssueLine(long).slice(0, 120));
    expect(items[1]?.issue).toHaveLength(120);
  });

  test("AC-14 a pushed execution appends to the ledger the summary already holds", async () => {
    const older = olderEntry();
    const env = { ...ledgerEnv([findingA]), own: [{ key: "fix-summary", comment: previousSummary([older]) }] };
    const edit = spyOn(_fixReportDeps, "editComment").mockResolvedValue();
    const post = spyOn(_fixReportDeps, "postPrComment").mockResolvedValue({ id: "summary" });
    await reportStep(env, pushed);
    // The summary is edited in place; only the push's own append-only record is posted (B1).
    expect(summaryPosts(post)).toEqual([]);
    const { entries } = readPushLedger(edit.mock.calls[0]?.[2] ?? "");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(older);
    expect(entries[1]).toMatchObject({ base: BASE_SHA, sha: PUSH_SHA });
  });

  test.each([
    ["AC-15", { outcome: "gates-failed" }],
    // An advisor-ledger-only push keeps outcome `nothing`, so it records no entry of its own.
    ["AC-16", { outcome: "nothing", pushedSha: PUSH_SHA }],
  ] as const)("%s a %j execution carries the ledger forward and adds none", async (_ac, patch) => {
    const older = olderEntry();
    const env = { ...ledgerEnv([findingA]), own: [{ key: "fix-summary", comment: previousSummary([older]) }] };
    const edit = spyOn(_fixReportDeps, "editComment").mockResolvedValue();
    await reportStep(env, { step: "report", timings: {}, ...patch });
    expect(readPushLedger(edit.mock.calls[0]?.[2] ?? "").entries).toEqual([older]);
  });

  test("AC-17 an unreadable block is replaced by the new entry only", async () => {
    const broken = previousSummary([]);
    const env = {
      ...ledgerEnv([findingA]),
      own: [
        { key: "fix-summary", comment: { ...broken, body: `${broken.body}\n<!-- nax-bot:pushes v1 not-json -->` } },
      ],
    };
    const edit = spyOn(_fixReportDeps, "editComment").mockResolvedValue();
    await reportStep(env, pushed);
    const { entries, unreadable } = readPushLedger(edit.mock.calls[0]?.[2] ?? "");
    expect(unreadable).toBe(false);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ sha: PUSH_SHA });
  });

  test("AC-18 warns when the ledger block it reads is unreadable", async () => {
    const broken = `${withNaxBotMarker("earlier summary", "fix-summary")}\n<!-- nax-bot:pushes v1 not-json -->`;
    const env = {
      ...ledgerEnv([findingA]),
      own: [{ key: "fix-summary", comment: { ...summaryComment, body: broken } }],
    };
    const logger = initLogger({ level: "silent" });
    const warn = spyOn(logger, "warn");
    try {
      spyOn(_fixReportDeps, "editComment").mockResolvedValue();
      await reportStep(env, pushed);
      expect(warn).toHaveBeenCalledWith("bot-fix", expect.stringContaining("ledger"), {
        pr: env.ref.number,
        error: expect.any(String),
      });
    } finally {
      resetLogger();
    }
  });

  // B1: a comment write replaces the whole body, and the ledger is the only record of the bot's own
  // pushes. A run whose push was rejected must not erase a push another run recorded while it worked.
  test("B1: a stale report cannot erase a push recorded after its own snapshot", async () => {
    const older = olderEntry();
    const recorded = olderEntry({ sha: "e".repeat(40) });
    const env = { ...ledgerEnv([findingA]), own: [{ key: "fix-summary", comment: previousSummary([older]) }] };
    // Another run appended its push after this run read its env; the forge holds both entries now.
    spyOn(_fixReportDeps, "listPrComments").mockResolvedValue([previousSummary([older, recorded])]);
    const edit = spyOn(_fixReportDeps, "editComment").mockResolvedValue();
    await reportStep(env, { step: "report", timings: {}, outcome: "push-rejected" });
    expect(readPushLedger(edit.mock.calls[0]?.[2] ?? "").entries).toEqual([older, recorded]);
  });

  test("B1: an entry only the run's own snapshot holds survives a rewrite", async () => {
    const older = olderEntry();
    const env = { ...ledgerEnv([findingA]), own: [{ key: "fix-summary", comment: previousSummary([older]) }] };
    // The fresh read is a body written before this run's snapshot existed, so its entry is carried over.
    spyOn(_fixReportDeps, "listPrComments").mockResolvedValue([{ ...previousSummary([]), id: "7" }]);
    const edit = spyOn(_fixReportDeps, "editComment").mockResolvedValue();
    await reportStep(env, { step: "report", timings: {}, outcome: "nothing", pushedSha: PUSH_SHA });
    expect(readPushLedger(edit.mock.calls[0]?.[2] ?? "").entries).toEqual([older]);
  });

  test("AC-21 a rejected summary edit surfaces and records nothing", async () => {
    const env = { ...ledgerEnv([findingA]), own: [{ key: "fix-summary", comment: previousSummary([]) }] };
    spyOn(_fixReportDeps, "editComment").mockRejectedValue(new Error("denied"));
    const post = spyOn(_fixReportDeps, "postPrComment").mockResolvedValue({ id: "summary" });
    await expect(reportStep(env, pushed)).rejects.toThrow("denied");
    expect(post).not.toHaveBeenCalled();
  });
});

/**
 * B1: both summary writers replace the whole comment body, and the forge has no conditional update, so
 * a write built from a read taken before another run's push erases it. The push therefore also posts a
 * record of its own — a comment no summary writer rewrites — and every reader takes the two together.
 */
describe("reportStep push record (B1)", () => {
  type PostComment = typeof _fixReportDeps.postPrComment;
  type EditComment = typeof _fixReportDeps.editComment;

  /** The PR's comments as the forge holds them, so two reports can share one comment. */
  function store(login: string) {
    const comments: PrComment[] = [];
    const list: typeof _fixReportDeps.listPrComments = async () => [...comments];
    const post: PostComment = async (_ref, body) => {
      comments.push({ id: String(comments.length + 1), kind: "comment", author: login, body, createdAt: "" });
      return { id: String(comments.length) };
    };
    const edit: EditComment = async (_ref, target, body) => {
      const at = comments.findIndex(({ id }) => id === target.id);
      const current = comments[at];
      if (current !== undefined) comments[at] = { ...current, body };
    };
    return { comments, list, post, edit };
  }

  test("a push posts its own record, keyed by the full sha, beside the summary", async () => {
    const env = ledgerEnv([findingA]);
    const post = spyOn(_fixReportDeps, "postPrComment").mockResolvedValue({ id: "summary" });
    await reportStep(env, pushed);
    const bodies = post.mock.calls.map((call) => String(call[1] ?? ""));
    const record = bodies.find((body) => parseNaxBotMarker(body)?.key === pushRecordKey(PUSH_SHA));
    expect(record).toBeDefined();
    expect(readPushLedger(record ?? "").entries).toEqual([expect.objectContaining({ base: BASE_SHA, sha: PUSH_SHA })]);
  });

  test("a push reported twice posts one record", async () => {
    const env = ledgerEnv([findingA]);
    const forge = store(env.user.login);
    spyOn(_fixReportDeps, "listPrComments").mockImplementation(forge.list);
    spyOn(_fixReportDeps, "postPrComment").mockImplementation(forge.post);
    spyOn(_fixReportDeps, "editComment").mockImplementation(forge.edit);
    await reportStep(env, pushed);
    await reportStep(env, pushed);
    const records = forge.comments.filter(({ body }) => parseNaxBotMarker(body)?.key === pushRecordKey(PUSH_SHA));
    expect(records).toHaveLength(1);
  });

  // The scoped probe the review ran: one report's edit lands after another run wrote its push. The
  // block in the summary is erased; the push is not, because its own comment cannot be rewritten.
  test("a delayed write that erases the summary's block leaves the push on the record", async () => {
    const env = ledgerEnv([findingA]);
    const forge = store(env.user.login);
    spyOn(_fixReportDeps, "postPrComment").mockImplementation(forge.post);
    spyOn(_fixReportDeps, "editComment").mockImplementation(forge.edit);
    spyOn(_fixReportDeps, "listPrComments").mockImplementation(forge.list);
    // The run that pushes writes its summary and its record.
    await reportStep(env, pushed);
    // The run whose push was rejected read the summary before that push existed, and its write lands
    // afterwards: its body carries the stale, empty ledger, and it edits the comment it read.
    const summary = forge.comments.find(({ body }) => parseNaxBotMarker(body)?.key === "fix-summary");
    expect(summary).toBeDefined();
    const stale: PrComment = {
      id: summary?.id ?? "1",
      kind: "comment",
      author: env.user.login,
      body: withNaxBotMarker("earlier summary", "fix-summary"),
      createdAt: "",
    };
    spyOn(_fixReportDeps, "listPrComments").mockResolvedValue([stale]);
    await reportStep(env, { step: "report", timings: {}, outcome: "push-rejected" });
    const own = ownComments(forge.comments, env.user.login);
    const erased = own.find(({ key }) => key === "fix-summary");
    // The probe's symptom: the summary's own block no longer holds the push.
    expect(readPushLedger(erased?.comment.body ?? "").entries).toEqual([]);
    // The record a reader consults still does, so lineage and the push count are not lost.
    expect(ownLedgerEntries(own).map(({ sha }) => sha)).toEqual([PUSH_SHA]);
  });
});
