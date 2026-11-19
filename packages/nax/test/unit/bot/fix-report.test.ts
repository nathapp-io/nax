import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeBotFixDraftEnv, makeBotFixEnv } from "@test/helpers";
import { _fixCycleDeps, type AgreedItem, type BotFixEnv, type BotFixState, waitForPrHead } from "@/bot";
import { _fixReportDeps, readyStep, replyStep, reportStep } from "@/bot/fix-report";
import { type BotPushEntry, readPushLedger, withPushLedger } from "@/bot/push-ledger";
import { NAX_WORKFLOW_PR_MARKER, type PrComment, withNaxBotMarker } from "@/forge";
import { initLogger, resetLogger } from "@/logger";
import { firstIssueLine } from "@/workflow/blocking-findings";

afterEach(() => mock.restore());

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
    expect(post).not.toHaveBeenCalled();
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

  test("AC-21 a rejected summary edit surfaces and records nothing", async () => {
    const env = { ...ledgerEnv([findingA]), own: [{ key: "fix-summary", comment: previousSummary([]) }] };
    spyOn(_fixReportDeps, "editComment").mockRejectedValue(new Error("denied"));
    const post = spyOn(_fixReportDeps, "postPrComment").mockResolvedValue({ id: "summary" });
    await expect(reportStep(env, pushed)).rejects.toThrow("denied");
    expect(post).not.toHaveBeenCalled();
  });
});
