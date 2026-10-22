import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeBotFixEnv,
  makeBotReviewDeps,
  makeNaxConfig,
  makeTempDir,
  makeTestRuntime,
} from "@test/helpers";
import type { BotReviewArtifact } from "@/bot/post";
import { _botReviewDeps, runBotReview } from "@/bot/review-run";
import { type PrComment, type PrThread, withNaxBotMarker } from "@/forge";
import { getSafeLogger } from "@/logger";

const original = { ..._botReviewDeps };
let runtime: ReturnType<typeof makeTestRuntime>;
let dir: string;
let threads: PrThread[];
let comments: PrComment[];
let staticMode: boolean;
let artifactPath: string;
const access = mock(
  async (_ref: unknown, who: { readonly login: string; readonly id?: number }) =>
    who.login === "alice" || who.login === "bot",
);
const forgeRun = mock(async () => ({ exitCode: 0, stdout: '{"id":42}', stderr: "" }));
const comment = (id: string, author: string, extra: Partial<PrComment> = {}): PrComment => ({
  id,
  author,
  authorId: 7,
  body: `Request ${id}`,
  kind: "comment",
  createdAt: "",
  ...extra,
});
const thread = (id: string, author: string, replies: PrComment[] = []): PrThread => ({
  id,
  replyTo: id,
  resolved: false,
  outdated: false,
  comments: [comment(id, author), ...replies],
});

beforeEach(() => {
  dir = makeTempDir("review-writers-");
  threads = [];
  comments = [];
  staticMode = false;
  access.mockClear();
  access.mockImplementation(async (_ref, who) => who.login === "alice" || who.login === "bot");
  forgeRun.mockClear();
  const config = makeNaxConfig({ outputDir: dir });
  runtime = makeTestRuntime({ config });
  const info = makeBotFixEnv().info;
  Object.assign(_botReviewDeps, {
    ...makeBotReviewDeps({ config, runtime, info: () => info, threads: () => threads }),
    classifyPrTrust: async () => ({ trusted: !staticMode, headSha: info.headSha, reasons: [] }),
    hasWriteAccess: access,
    listPrComments: async () => comments,
    forge: { run: forgeRun, readText: async () => null },
    runPrReview: async () => ({
      ran: true,
      verdict: {
        intent: "pass",
        quality: "changes",
        findings: [{ kind: "quality", severity: "minor", issue: "Independent finding" }],
        threads: threads.map(({ id }) => ({ id, decision: "agree", reason: "Valid" })),
        comments: comments.map(({ id }) => ({ id, decision: "agree", reason: "Valid" })),
        cannotVerify: [],
        inspectedFiles: [],
      },
    }),
  });
});
afterEach(async () => {
  Object.assign(_botReviewDeps, original);
  await runtime.close();
  cleanupTempDir(dir);
});
async function review(): Promise<BotReviewArtifact> {
  const result = await runBotReview({ dir, pr: 7, profiles: [], interactive: false });
  expect(result.outcome).toBe("posted");
  if (result.outcome !== "posted") throw new Error("review did not post");
  artifactPath = result.artifactPath;
  expect(artifactPath.endsWith(join("bot-review.json"))).toBe(true);
  expect(forgeRun).toHaveBeenCalled();
  return Bun.file(artifactPath).json();
}

describe("runBotReview writer boundary", () => {
  test.each([false, true])("AC-1/7 excludes non-writer comment in static=%s", async (isStatic) => {
    staticMode = isStatic;
    comments = [comment("C1", "mallory")];
    const saved = await review();
    expect(access).toHaveBeenCalledTimes(1);
    expect(saved.agreed.map(({ kind }) => kind)).toEqual(["finding"]);
  });
  test("AC-2 keeps a writer-opened thread", async () => {
    threads = [thread("T1", "alice")];
    expect((await review()).agreed).toContainEqual(
      expect.objectContaining({ kind: "thread", threadId: "T1", issue: "Request T1" }),
    );
    expect(access.mock.calls[0]?.[1]).toEqual({ login: "alice", id: 7 });
  });
  test("AC-3/4/5 checks distinct kept authors, never repliers, resolved/empty or own items", async () => {
    const own = comment("own", "bot", { body: withNaxBotMarker("Not queued", "t-old") });
    threads = [
      thread("T1", "alice", [comment("reply", "replier"), own]),
      thread("T2", "alice"),
      { ...thread("resolved", "resolved-author"), resolved: true },
      { ...thread("empty", "absent"), comments: [] },
      { ...thread("own", "bot"), comments: [own] },
    ];
    comments = [comment("C1", "alice"), comment("C2", "mallory"), own, comment("blank", "blank-author", { body: " " })];
    await review();
    expect(access.mock.calls.map(([, who]) => who)).toEqual([
      { login: "alice", id: 7 },
      { login: "mallory", id: 7 },
    ]);
  });
  test("AC-6 rerun bot Not queued reply cannot authorize a non-writer opener", async () => {
    threads = [
      thread("T1", "mallory", [comment("bot-reply", "bot", { body: withNaxBotMarker("Not queued", "t-T1") })]),
    ];
    expect((await review()).agreed.map(({ kind }) => kind)).toEqual(["finding"]);
    expect(access.mock.calls.map(([, who]) => who.login)).toEqual(["mallory"]);
  });
  test("AC-8/9 permission outages still post findings only and warn once per login", async () => {
    threads = [thread("T1", "alice")];
    comments = [comment("C1", "alice"), comment("C2", "mallory")];
    access.mockImplementation(async () => {
      throw new Error("permission unavailable");
    });
    const logger = getSafeLogger();
    if (!logger) throw new Error("logger unavailable");
    const warn = spyOn(logger, "warn");
    try {
      expect((await review()).agreed.map(({ kind }) => kind)).toEqual(["finding"]);
      expect(access).toHaveBeenCalledTimes(2);
      for (const login of ["alice", "mallory"])
        expect(warn).toHaveBeenCalledWith("bot", "Could not check commenter permission", {
          login,
          error: "permission unavailable",
        });
    } finally {
      warn.mockRestore();
    }
  });
});
