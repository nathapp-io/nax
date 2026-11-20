import { beforeEach, describe, expect, mock, test } from "bun:test";
import { carriedFromArtifact, earlierCarriedFindings, type LoadCarry } from "@/bot/carried-findings";
import { type CarriedEntry, carriedRecordBody, carriedRecordKey, parseCarriedRecord } from "@/bot/carried-record";
import type { BotReviewArtifact } from "@/bot/post";
import { type OwnComment, type PrRef, withNaxBotMarker } from "@/forge";

const ref: PrRef = { forge: "github", host: "github.test", repo: "o/r", number: 7 };
/** The head the reviewed index names: the earlier review this one carries from. */
const reviewedHead = "a".repeat(40);
const mergeBase = "9".repeat(40);
const leak: CarriedEntry = {
  key: "f-1234",
  severity: "critical",
  issue: "Token cache entries are shared across users",
};

function artifact(overrides: Partial<BotReviewArtifact> = {}): BotReviewArtifact {
  return {
    version: 3,
    pr: ref,
    headSha: reviewedHead,
    trusted: true,
    intent: "pass",
    quality: "changes",
    scope: "full",
    agreed: [{ kind: "finding", ...leak }],
    ...overrides,
  };
}

/** The bot's own carried-record comment, as triage resolves it. */
function recordComment(findings: readonly CarriedEntry[], headSha = reviewedHead): OwnComment {
  return {
    key: carriedRecordKey(headSha),
    comment: {
      id: "c1",
      kind: "comment",
      author: "bot",
      body: withNaxBotMarker(carriedRecordBody({ headSha, findings }).body, carriedRecordKey(headSha)),
      createdAt: "t",
    },
  };
}

let load: ReturnType<typeof mock<LoadCarry>>;

beforeEach(() => {
  load = mock<LoadCarry>(async () => carriedFromArtifact(artifact().agreed));
});

/** An incremental review of a head the index says was reviewed already. */
function carry(overrides: Partial<Parameters<typeof earlierCarriedFindings>[0]> = {}) {
  return earlierCarriedFindings({
    outputDir: "/output",
    ref,
    index: { reviewedHead, reviewedBase: mergeBase, keys: [] },
    scope: "incremental",
    rangeBase: reviewedHead,
    own: [],
    load,
    ...overrides,
  });
}

describe("where a review reads an earlier review's carried findings (B1)", () => {
  test("reads the bot's record on the PR, so another host needs no local artifact", async () => {
    const read = await carry({ own: [recordComment([leak])] });
    expect(read).toEqual({ findings: [{ kind: "finding", ...leak }], widen: false });
    expect(load).not.toHaveBeenCalled();
  });

  test("falls back to this machine's artifact when the PR carries no record", async () => {
    const read = await carry();
    expect(load).toHaveBeenCalledWith("/output", ref, reviewedHead);
    expect(read.findings.map(({ key }) => key)).toEqual([leak.key]);
    expect(read.widen).toBe(false);
  });

  test("carries nothing when neither the PR nor this machine holds a record", async () => {
    load.mockImplementation(async () => ({ findings: [], widen: false }));
    expect(await carry()).toEqual({ findings: [], widen: false });
  });

  test("ignores a record that names another head than the index does", async () => {
    const beside: CarriedEntry = { key: "f-other", severity: "critical", issue: "Reported at another head" };
    const read = await carry({ own: [recordComment([beside], "b".repeat(40))] });
    // The record cannot speak for this head; the machine's own artifact is read instead.
    expect(read.findings.map(({ key }) => key)).toEqual([leak.key]);
    expect(read.widen).toBe(false);
    expect(load).toHaveBeenCalled();
  });

  test("ignores a record comment that sits in a review thread", async () => {
    load.mockImplementation(async () => ({ findings: [], widen: false }));
    const threaded = { ...recordComment([leak]), threadId: "t1" };
    expect((await carry({ own: [threaded] })).findings).toEqual([]);
    expect(load).toHaveBeenCalled();
  });

  test.each([
    ["a full review re-reads the range itself", { scope: "full" as const, rangeBase: mergeBase }],
    ["a conversation-only review reads nothing", { scope: "conversation-only" as const }],
    ["a range base that is not the reviewed head", { rangeBase: mergeBase }],
  ])("carries nothing when %s", async (_label, overrides) => {
    expect(await carry({ own: [recordComment([leak])], ...overrides })).toEqual({ findings: [], widen: false });
    expect(load).not.toHaveBeenCalled();
  });

  test("carries nothing when the index names no reviewed head", async () => {
    expect(await carry({ index: { reviewedBase: mergeBase, keys: [] } })).toEqual({ findings: [], widen: false });
    expect(load).not.toHaveBeenCalled();
  });
});

describe("a carry record this review cannot use (B3)", () => {
  test("widens the review when the PR's record does not parse", async () => {
    const corrupt = recordComment([leak]);
    const damaged: OwnComment = {
      ...corrupt,
      comment: {
        ...corrupt.comment,
        body: withNaxBotMarker("Carried blocking findings", carriedRecordKey(reviewedHead)),
      },
    };
    expect(await carry({ own: [damaged] })).toEqual({ findings: [], widen: true });
  });

  test.each([undefined, null, "leak"])("widens the review when the artifact's agreed field is %j", (agreed) => {
    expect(carriedFromArtifact(agreed)).toEqual({ findings: [], widen: true });
  });

  test.each([{ trigger: "invented" }, { triggerEvidence: 42 }])(
    "rejects invalid trigger metadata in both carry sources: %j",
    (fields) => {
      const entry = { ...leak, ...fields };
      const payload = Buffer.from(JSON.stringify({ headSha: reviewedHead, findings: [entry] })).toString("base64");
      expect(
        parseCarriedRecord(`Carried blocking findings at ${reviewedHead}: 1\n<!-- nax-bot:carried v1 ${payload} -->`),
      ).toBeNull();
      expect(carriedFromArtifact([{ kind: "finding", ...entry }])).toEqual({ findings: [], widen: true });
    },
  );

  test("widens the review when no finding entry of the artifact is usable", () => {
    expect(carriedFromArtifact([{ kind: "finding" }])).toEqual({ findings: [], widen: true });
  });

  test("skips an unusable entry and keeps the usable ones", () => {
    const read = carriedFromArtifact([
      { kind: "finding" },
      { kind: "finding", ...leak },
      { kind: "comment", key: "c-1", issue: "x", reason: "y" },
    ]);
    expect(read.findings.map(({ key }) => key)).toEqual([leak.key]);
    expect(read.widen).toBe(false);
  });

  test("an artifact with no finding items carries nothing and does not widen", () => {
    expect(carriedFromArtifact([{ kind: "comment", key: "c-1", issue: "x", reason: "y" }])).toEqual({
      findings: [],
      widen: false,
    });
  });
});
