/**
 * US-003: `nax bot review` reads the PR's own blocking policy — a writer's top-level
 * `blocking triggers:` scope ruling, else `bot.blockingTriggers` — and both posts and records it.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanupTempDir,
  type DeepPartial,
  makeBotFixEnv,
  makeBotReviewDeps,
  makeNaxConfig,
  makeTempDir,
  makeTestRuntime,
} from "@test/helpers";
import type { BotReviewArtifact } from "@/bot/post";
import { _botReviewDeps, runBotReview } from "@/bot/review-run";
import type { NaxConfig } from "@/config";
import type { PrComment } from "@/forge";
import type { PrFinding } from "@/operations";

const original = { ..._botReviewDeps };
const INLINE = "repos/o/r/pulls/7/comments";
const SUMMARY = "repos/o/r/issues/7/comments";
/** One finding this feature's default policy does not block on: it needs a second concurrent run. */
const finding: PrFinding = {
  kind: "quality",
  severity: "important",
  issue: "Two runs share the claim file",
  file: "a.ts",
  line: 3,
  trigger: "own-concurrency",
  triggerEvidence: "two runs",
};

let runtime: ReturnType<typeof makeTestRuntime> | undefined;
let dir: string;
let comments: PrComment[];
const access = mock(
  async (_ref: unknown, who: { readonly login: string; readonly id?: number }) => who.login === "alice",
);
const forgeRun = mock(async (_argv: string[], _options: { cwd: string }) => ({
  exitCode: 0,
  stdout: '{"id":42}',
  stderr: "",
}));

function comment(id: string, author: string, body: string): PrComment {
  return { id, author, authorId: 7, body, kind: "comment", createdAt: "" };
}

/** Wire the graph against the forge stubs; a later call with overrides replaces the config wholesale. */
async function stub(overrides: DeepPartial<NaxConfig> = {}): Promise<void> {
  await runtime?.close();
  const config = makeNaxConfig({ outputDir: dir, ...overrides });
  runtime = makeTestRuntime({ config });
  const info = makeBotFixEnv().info;
  Object.assign(_botReviewDeps, {
    ...makeBotReviewDeps({ config, runtime, info: () => info }),
    hasWriteAccess: access,
    listPrComments: async () => comments,
    forge: { run: forgeRun, readText: async () => null },
    runPrReview: async () => ({
      ran: true,
      verdict: {
        intent: "pass",
        quality: "changes",
        findings: [finding],
        threads: [],
        comments: [],
        cannotVerify: [],
        inspectedFiles: [],
      },
    }),
  });
}

beforeEach(async () => {
  dir = makeTempDir("review-blocking-");
  comments = [];
  access.mockClear();
  access.mockImplementation(async (_ref, who) => who.login === "alice");
  forgeRun.mockClear();
  await stub();
});
afterEach(async () => {
  Object.assign(_botReviewDeps, original);
  await runtime?.close();
  runtime = undefined;
  cleanupTempDir(dir);
});

async function review(): Promise<BotReviewArtifact> {
  const result = await runBotReview({ dir, pr: 7, profiles: [], interactive: false });
  if (result.outcome !== "posted") throw new Error(`review did not post: ${JSON.stringify(result)}`);
  return Bun.file(result.artifactPath).json();
}

function argvs(): string[][] {
  return forgeRun.mock.calls.map(([argv]) => argv);
}

function bodiesTo(endpoint: string): string[] {
  return argvs()
    .filter((argv) => argv.includes(endpoint))
    .map((argv) => argv.find((arg) => arg.startsWith("body="))?.slice("body=".length) ?? "");
}

function summaryBody(): string {
  return bodiesTo(SUMMARY).at(-1) ?? "";
}

describe("runBotReview writer scope ruling (US-003)", () => {
  beforeEach(() => {
    comments = [comment("c1", "alice", "blocking triggers: normal")];
  });

  test("AC-12 records the writer's ruling as the artifact's blocking set", async () => {
    expect((await review()).blockingTriggers).toEqual(["normal"]);
  });

  test("AC-13 lists a non-blocking finding as residual in the summary", async () => {
    await review();
    expect(summaryBody()).toContain("### Residual findings (not blocking)");
    expect(summaryBody()).toContain("Two runs share the claim file (trigger own-concurrency");
  });

  test("AC-14 creates no inline thread for the new non-blocking finding", async () => {
    await review();
    expect(argvs().filter((argv) => argv.includes(INLINE))).toEqual([]);
  });

  test("AC-15 a non-writer's ruling leaves the configured set in force", async () => {
    comments = [comment("c1", "mallory", "blocking triggers: normal")];
    expect((await review()).blockingTriggers).toEqual(["normal", "own-concurrency"]);
    expect(access).toHaveBeenCalledTimes(1);
  });
});

describe("runBotReview scope ruling with an empty list (US-003)", () => {
  beforeEach(async () => {
    // A non-default configured set, so "the configured set" is distinguishable from the default.
    await stub({ bot: { blockingTriggers: ["normal", "manual"] } });
  });

  test("AC-22 persists the configured set when the only ruling states no class", async () => {
    comments = [comment("c1", "alice", "blocking triggers:")];
    expect((await review()).blockingTriggers).toEqual(["normal", "manual"]);
  });

  test("AC-23 names the ignored ruling in the summary", async () => {
    comments = [comment("c1", "alice", "blocking triggers:")];
    await review();
    expect(summaryBody()).toContain("Ignored scope ruling: blocking triggers:");
  });
});
