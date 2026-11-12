/** US-001: readiness is held for an unreviewed pushed head and for open critical/important findings. */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeBotFixDraftEnv, makeBotFixEnv } from "@test/helpers";
import {
  _fixReportDeps,
  type AgreedItem,
  type BotFixEnv,
  type BotFixState,
  type BotReviewArtifact,
  readyStep,
} from "@/bot";
import { _rulingsDeps } from "@/bot/rulings";
import { withNaxBotMarker } from "@/forge";
import { markReadyArgv } from "@/workflow/promote";

const HEAD = "abc1234def";
const greenCi = { outcome: "green", detail: "all checks passed" } as const;
/** This execution pushed `HEAD`: the fix graph's post-push readiness pass. */
const pushed: BotFixState = { step: "reply", timings: {}, outcome: "pushed", pushedSha: HEAD };
/** A ready-only pass (`nax bot fix --ready-only`): no fix session, no push. */
const readyPass: BotFixState = { step: "ready", timings: {}, outcome: "ready-pass", readyOnly: true };

function finding(key: string, severity: "critical" | "important" | "minor"): AgreedItem {
  return { kind: "finding", key, issue: `issue ${key}`, severity };
}
const threadItem: AgreedItem = {
  kind: "thread",
  key: "t-1",
  issue: "rename",
  reason: "clearer",
  threadId: "n1",
  replyTo: "r1",
};
const commentItem: AgreedItem = { kind: "comment", key: "c-1", issue: "please rename", reason: "reasonable" };
/** What the PR read reports as settled; each test sets the keys it needs. */
const settled = { current: new Set<string>() };
/** The reconciliation spy, so one case can re-run the real read (B1). */
let settledSpy: ReturnType<typeof spyOn<typeof _fixReportDeps, "readSettledKeys">>;

/** A draft PR at `HEAD` whose readiness review agreed on `agreed`. */
function draftEnv(agreed: readonly AgreedItem[] = []): BotFixEnv {
  const base = makeBotFixDraftEnv({ url: "https://github.com/o/r/pull/42" });
  return {
    ...base,
    info: { ...base.info, headSha: HEAD },
    review: { ...base.review, headSha: HEAD, agreed },
  };
}

beforeEach(() => {
  spyOn(_fixReportDeps, "waitForPrHead").mockResolvedValue(true);
  spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue(greenCi);
  spyOn(_fixReportDeps, "readPrInfo").mockResolvedValue({ ...makeBotFixDraftEnv().info, headSha: HEAD });
  // The open-finding hold reconciles with the PR (B1), so its reads are stubbed for every case.
  settled.current = new Set();
  spyOn(_fixReportDeps, "readCurrentUser").mockResolvedValue({ login: "bot" });
  spyOn(_fixReportDeps, "listReviewThreads").mockResolvedValue([]);
  spyOn(_fixReportDeps, "listPrComments").mockResolvedValue([]);
  settledSpy = spyOn(_fixReportDeps, "readSettledKeys").mockImplementation(async () => settled.current);
});
afterEach(() => mock.restore());

describe("readyStep pushed-head hold", () => {
  test("AC-1 holds a pushed head for a bot review of that head", async () => {
    const env = draftEnv();
    const result = await readyStep(env, pushed);
    expect(result.patch.markedReady).toBe(false);
    expect(result.patch.readyHeld).toStartWith("pushed abc1234; a bot review of the pushed head decides readiness");
  });

  test("AC-2 never writes the mark-ready argv for an unreviewed pushed head", async () => {
    const env = draftEnv();
    const run = spyOn(env.forge, "run");
    await readyStep(env, pushed);
    expect(run).not.toHaveBeenCalledWith(markReadyArgv(env.ref.forge, env.info.url), expect.anything());
    expect(run).not.toHaveBeenCalled();
  });

  test("the hold names both recovery commands for this PR", async () => {
    const result = await readyStep(draftEnv(), pushed);
    expect(result.patch.readyHeld).toContain("nax bot review 42, then nax bot fix 42 --ready-only");
  });

  test("a ready-only pass is not held by the pushed-head check", async () => {
    const env = draftEnv();
    const run = spyOn(env.forge, "run");
    const result = await readyStep(env, { ...pushed, readyOnly: true });
    expect(result.patch.markedReady).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("readyStep open-finding hold", () => {
  test("AC-3 an important finding of the readiness review holds readiness", async () => {
    const result = await readyStep(draftEnv([finding("f-1", "important")]), readyPass);
    expect(result.patch.markedReady).toBe(false);
    expect(result.patch.readyHeld).toContain("1 open critical/important finding(s)");
    expect(result.patch.readyHeld).toContain("f-1");
  });

  test("AC-4 a critical finding holds readiness", async () => {
    const result = await readyStep(draftEnv([finding("f-2", "critical")]), readyPass);
    expect(result.patch.markedReady).toBe(false);
    expect(result.patch.readyHeld).toContain("f-2");
  });

  test("AC-5 minor findings, threads and comments never hold the mark-ready write", async () => {
    const env = draftEnv([finding("f-3", "minor"), threadItem]);
    const run = spyOn(env.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const result = await readyStep(env, readyPass);
    expect(result.patch).toEqual({ markedReady: true });
    expect(run).toHaveBeenCalledWith(markReadyArgv(env.ref.forge, env.info.url), { cwd: env.repoRoot });
  });

  test("AC-6 names at most five keys and counts the rest", async () => {
    const agreed = Array.from({ length: 7 }, (_, index) => finding(`f-${index}`, "important"));
    const result = await readyStep(draftEnv(agreed), readyPass);
    expect(result.patch.readyHeld).toContain("7 open critical/important finding(s)");
    expect(result.patch.readyHeld).toEndWith("f-0, f-1, f-2, f-3, f-4, +2 more");
  });

  test("AC-7 the hold wins over a PR that is not a draft", async () => {
    const base = makeBotFixEnv([finding("f-1", "important")]);
    const env: BotFixEnv = {
      ...base,
      info: { ...base.info, headSha: HEAD, draft: false },
      review: { ...base.review, headSha: HEAD, agreed: [finding("f-1", "important")] },
    };
    const run = spyOn(env.forge, "run");
    expect(await readyStep(env, readyPass)).toEqual({
      patch: {
        markedReady: false,
        readyHeld: "1 open critical/important finding(s) in the bot review of abc1234: f-1",
      },
      exit: "report",
    });
    expect(run).not.toHaveBeenCalled();
  });

  test("AC-20 only minor findings, threads or comments leave the readiness checks in charge", async () => {
    for (const agreed of [
      [finding("f-4", "minor")],
      [threadItem],
      [commentItem],
      [finding("f-5", "minor"), commentItem],
    ]) {
      const env = draftEnv(agreed);
      spyOn(env.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      const result = await readyStep(env, readyPass);
      expect(result.patch.readyHeld).toBeUndefined();
      expect(result.patch.markedReady).toBe(true);
    }
  });
});

// B1: the artifact is immutable, so a settlement or withdrawal recorded after it was written must lift
// the hold — otherwise `--ready-only` (the documented recovery) still needs a whole new code review.
describe("readyStep open-finding hold reconciled with the PR now", () => {
  const codeReview: BotReviewArtifact = {
    version: 3,
    scope: "full",
    pr: { forge: "github", host: "github.com", repo: "o/r", number: 42 },
    headSha: HEAD,
    trusted: true,
    intent: "pass",
    quality: "changes",
    agreed: [finding("f-9", "important")],
  };
  /** The newer review of the same head: conversation-only, so it read no code and raised nothing itself. */
  const conversationOnly: BotReviewArtifact = {
    ...codeReview,
    scope: "conversation-only",
    quality: "not-reviewed",
    agreed: [],
  };

  function reconciledEnv(review: BotReviewArtifact): BotFixEnv {
    return { ...draftEnv(), review, codeReview };
  }

  test("a ruling recorded since the code review lifts its hold and readies the PR", async () => {
    settled.current = new Set(["f-9"]);
    const env = reconciledEnv(conversationOnly);
    const run = spyOn(env.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    expect(await readyStep(env, readyPass)).toEqual({ patch: { markedReady: true }, exit: "report" });
    expect(run).toHaveBeenCalledWith(markReadyArgv(env.ref.forge, env.info.url), { cwd: env.repoRoot });
  });

  const withdrawnReview: BotReviewArtifact = {
    ...conversationOnly,
    events: [
      {
        type: "finding-withdrawn",
        key: "f-9",
        threadId: "n1",
        finding: "leaks",
        reason: "wrong",
        disagreedBy: ["alice"],
      },
    ],
  };

  test("a newer review's finding-withdrawn event lifts the hold when no one reconfirmed it", async () => {
    const env = reconciledEnv(withdrawnReview);
    const run = spyOn(env.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    expect(await readyStep(env, readyPass)).toEqual({ patch: { markedReady: true }, exit: "report" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  // B5: the withdrawal used to drop the key before any ruling was read, so a writer's later `confirm`
  // never reached the hold.
  test("B5: a withdrawal followed by an authorized reconfirmation still holds readiness", async () => {
    settledSpy.mockRestore();
    const comment = (id: string, body: string, author: string, authorId: number, minute: number) => ({
      id,
      body,
      author,
      authorId,
      kind: "thread" as const,
      createdAt: `2026-01-01T00:0${minute}:00Z`,
    });
    spyOn(_fixReportDeps, "listReviewThreads").mockResolvedValue([
      {
        id: "n1",
        replyTo: "c1",
        resolved: false,
        outdated: false,
        comments: [
          comment("c1", withNaxBotMarker("leaks the token", "f-9"), "bot", 7, 0),
          comment("c2", "confirm", "alice", 8, 1),
        ],
      },
    ]);
    spyOn(_rulingsDeps, "hasWriteAccess").mockResolvedValue(true);
    const env = reconciledEnv(withdrawnReview);
    const run = spyOn(env.forge, "run");
    expect(await readyStep(env, readyPass)).toEqual({
      patch: {
        markedReady: false,
        readyHeld: "1 open critical/important finding(s) in the bot review of abc1234: f-9",
      },
      exit: "report",
    });
    expect(run).not.toHaveBeenCalled();
  });

  test("an unreadable PR state holds a withdrawn finding too (fail closed)", async () => {
    const env = reconciledEnv(withdrawnReview);
    spyOn(_fixReportDeps, "listReviewThreads").mockRejectedValue(new Error("offline"));
    const run = spyOn(env.forge, "run");
    const result = await readyStep(env, readyPass);
    expect(result.patch).toEqual({
      markedReady: false,
      readyHeld: "1 open critical/important finding(s) in the bot review of abc1234: f-9",
    });
    expect(run).not.toHaveBeenCalled();
  });

  test("only the settled keys are released; the rest still hold", async () => {
    settled.current = new Set(["f-9"]);
    const env: BotFixEnv = {
      ...reconciledEnv(conversationOnly),
      codeReview: { ...codeReview, agreed: [finding("f-9", "important"), finding("f-8", "critical")] },
    };
    expect(await readyStep(env, readyPass)).toEqual({
      patch: {
        markedReady: false,
        readyHeld: "1 open critical/important finding(s) in the bot review of abc1234: f-8",
      },
      exit: "report",
    });
  });

  test("an unreadable PR state keeps every key open (fail closed)", async () => {
    const env = reconciledEnv(conversationOnly);
    spyOn(_fixReportDeps, "readSettledKeys").mockRejectedValue(new Error("offline"));
    const run = spyOn(env.forge, "run");
    const result = await readyStep(env, readyPass);
    expect(result.patch).toEqual({
      markedReady: false,
      readyHeld: "1 open critical/important finding(s) in the bot review of abc1234: f-9",
    });
    expect(run).not.toHaveBeenCalled();
  });

  // B1: `recordFindingRulings` applies an authorized waiver whether or not the thread was resolved, so the
  // readiness read must too — otherwise one failed presentation-only resolve holds the PR forever.
  test("B1: an echoed waiver on an unresolved finding thread lifts the hold", async () => {
    settledSpy.mockRestore();
    spyOn(_fixReportDeps, "listReviewThreads").mockResolvedValue([
      {
        id: "n1",
        replyTo: "c1",
        resolved: false,
        outdated: false,
        comments: [
          {
            id: "c1",
            body: withNaxBotMarker("leaks the token", "f-9"),
            author: "bot",
            authorId: 7,
            kind: "thread",
            createdAt: "2026-01-01T00:00:00Z",
          },
          {
            id: "c2",
            body: "waive: by design",
            author: "alice",
            authorId: 8,
            kind: "thread",
            createdAt: "2026-01-01T00:01:00Z",
          },
        ],
      },
    ]);
    spyOn(_rulingsDeps, "hasWriteAccess").mockResolvedValue(true);
    const env = reconciledEnv(conversationOnly);
    const run = spyOn(env.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    expect(await readyStep(env, readyPass)).toEqual({ patch: { markedReady: true }, exit: "report" });
    expect(run).toHaveBeenCalledWith(markReadyArgv(env.ref.forge, env.info.url), { cwd: env.repoRoot });
  });

  // B5: a resolved thread used to settle unconditionally. A writer who reconfirms the finding reopened
  // outstanding work, so the hold must stand.
  test("B5: a reconfirmed finding on a resolved thread still holds readiness", async () => {
    settledSpy.mockRestore();
    spyOn(_fixReportDeps, "listReviewThreads").mockResolvedValue([
      {
        id: "n1",
        replyTo: "c1",
        resolved: true,
        outdated: false,
        comments: [
          {
            id: "c1",
            body: withNaxBotMarker("leaks the token", "f-9"),
            author: "bot",
            authorId: 7,
            kind: "thread",
            createdAt: "2026-01-01T00:00:00Z",
          },
          {
            id: "c2",
            body: "confirm",
            author: "alice",
            authorId: 8,
            kind: "thread",
            createdAt: "2026-01-01T00:01:00Z",
          },
        ],
      },
    ]);
    spyOn(_rulingsDeps, "hasWriteAccess").mockResolvedValue(true);
    const env = reconciledEnv(conversationOnly);
    const run = spyOn(env.forge, "run");
    expect(await readyStep(env, readyPass)).toEqual({
      patch: {
        markedReady: false,
        readyHeld: "1 open critical/important finding(s) in the bot review of abc1234: f-9",
      },
      exit: "report",
    });
    expect(run).not.toHaveBeenCalled();
  });
});
