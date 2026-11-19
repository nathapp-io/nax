/**
 * US-003: the effective blocking set decides which new findings get an inline thread. A critical or
 * important finding that does not block is posted as a residual in the summary instead, exactly as a
 * minor already is; a finding with an existing own thread is still edited in place.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import type { BotReviewArtifact, PostReviewInput } from "@/bot";
import * as bot from "@/bot";
import type { PrComment } from "@/forge";
import type { PrFinding } from "@/operations";
import type { FindingTrigger } from "@/workflow/blocking-findings";

/** What `bot.blockingTriggers` defaults to: a finding must need `normal` or `own-concurrency` to block. */
const BLOCKING: readonly FindingTrigger[] = ["normal", "own-concurrency"];
const adversarial: PrFinding = {
  kind: "quality",
  severity: "important",
  issue: "Race on the claim file",
  file: "a.ts",
  line: 3,
  trigger: "adversarial",
  triggerEvidence: "forged mtime on the claim file",
};
const comment: PrComment = { id: "12", kind: "comment", author: "alice", body: "Please fix", createdAt: "" };
const INLINE = "repos/o/r/pulls/7/comments";
const SUMMARY = "repos/o/r/issues/7/comments";

let stateDir: string;
let input: PostReviewInput;
const run = mock(async (_argv: string[], _options: { cwd: string }) => ({
  exitCode: 0,
  stdout: '{"id":42}',
  stderr: "",
}));

beforeEach(() => {
  stateDir = makeTempDir("bot-post-blocking-");
  run.mockClear();
  input = {
    ref: { forge: "github", host: "github.test", repo: "o/r", number: 7 },
    info: {
      number: 7,
      title: "PR",
      body: "",
      url: "",
      state: "open",
      draft: false,
      author: { login: "a" },
      baseRef: "main",
      headRef: "fix",
      headSha: "abc1234ffff",
      crossRepo: false,
    },
    verdict: {
      intent: "pass",
      quality: "changes",
      findings: [adversarial],
      threads: [],
      comments: [],
      cannotVerify: [],
      inspectedFiles: [],
    },
    threads: [],
    comments: [],
    own: [],
    staticMode: false,
    sensitive: [],
    stateDir,
    deps: { run, readText: async () => null },
    cwd: stateDir,
  };
});
afterEach(() => {
  cleanupTempDir(stateDir);
});

/** The same review with the blocking set applied, a chosen verdict and any per-case overrides. */
function blocking(
  findings: readonly PrFinding[] = [adversarial],
  extra: Partial<PostReviewInput> = {},
): PostReviewInput {
  return { ...input, blockingTriggers: BLOCKING, verdict: { ...input.verdict, findings }, ...extra };
}

/** Every argv the forge was asked to run, so a test can tell an inline post from the summary write. */
function argvs(): string[][] {
  return run.mock.calls.map(([argv]) => argv);
}

function callsTo(endpoint: string): string[][] {
  return argvs().filter((argv) => argv.includes(endpoint));
}

function bodyOf(argv: string[] | undefined): string {
  return argv?.find((arg) => arg.startsWith("body="))?.slice("body=".length) ?? "";
}

function summaryBody(): string {
  return bodyOf(callsTo(SUMMARY).at(-1));
}

async function artifact(): Promise<BotReviewArtifact> {
  return Bun.file(join(stateDir, "bot-review.json")).json();
}

describe("postPrReview residual findings (US-003)", () => {
  test("AC-1 posts no inline comment for an important finding outside the blocking set", async () => {
    await bot.postPrReview(blocking());
    expect(callsTo(INLINE)).toEqual([]);
  });

  test("AC-2 lists that finding under the residual section with its trigger", async () => {
    await bot.postPrReview(blocking());
    expect(summaryBody()).toContain(
      "### Residual findings (not blocking)\n- **Important** `a.ts`:3: Race on the claim file (trigger adversarial - forged mtime on the claim file)\n",
    );
  });

  test("AC-3 still posts a blocking finding as an inline comment", async () => {
    const blocks: PrFinding = { ...adversarial, trigger: "normal" };
    await bot.postPrReview(blocking([blocks]));
    expect(callsTo(INLINE)[0]).toContain(`body=${bot.renderFindingComment(blocks)}`);
    expect(summaryBody()).not.toContain("### Residual findings");
  });

  test("AC-4 leaves a non-blocking finding with no line in the off-line section", async () => {
    await bot.postPrReview(blocking([{ ...adversarial, line: undefined }]));
    expect(summaryBody()).toContain("### Findings not on a changed line");
    expect(summaryBody()).not.toContain("### Residual findings");
  });

  test("AC-5 edits an existing own thread for a non-blocking finding", async () => {
    await bot.postPrReview(
      blocking([adversarial], {
        own: [{ key: bot.findingKey(adversarial), comment: { ...comment, id: "99", kind: "thread" }, threadId: "T1" }],
      }),
    );
    const edits = argvs().filter((argv) => argv.includes("repos/o/r/pulls/comments/99"));
    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain("PATCH");
    expect(callsTo(INLINE)).toEqual([]);
  });

  test("AC-6 does not list a finding whose own thread was edited as residual", async () => {
    await bot.postPrReview(
      blocking([adversarial], {
        own: [{ key: bot.findingKey(adversarial), comment: { ...comment, id: "99", kind: "thread" }, threadId: "T1" }],
      }),
    );
    expect(summaryBody()).not.toContain("### Residual findings");
  });

  test("AC-7 renders a residual's trigger evidence through safeText", async () => {
    await bot.postPrReview(blocking([{ ...adversarial, triggerEvidence: "@alice [x](http://e.com)" }]));
    const summary = summaryBody();
    expect(summary).toContain("(trigger adversarial - ");
    expect(summary).not.toContain("](");
    expect(summary).toContain("alice [x]");
  });

  test("AC-8 persists the blocking set it was given on the artifact", async () => {
    await bot.postPrReview(blocking());
    expect((await artifact()).blockingTriggers).toEqual(BLOCKING);
  });

  test("writes no blockingTriggers key when the caller supplied none", async () => {
    await bot.postPrReview(input);
    expect(Object.hasOwn(await artifact(), "blockingTriggers")).toBe(false);
  });

  test("AC-9 states the configured set and where it came from", async () => {
    await bot.postPrReview(blocking([adversarial], { blockingSource: "config" }));
    expect(summaryBody()).toContain("Blocking triggers: normal, own-concurrency (config)");
  });

  test("AC-10 names the writer comment that ruled the scope", async () => {
    await bot.postPrReview(
      blocking([adversarial], {
        blockingTriggers: ["normal"],
        blockingSource: { commentId: "c1", author: "alice" },
      }),
    );
    expect(summaryBody()).toContain("Blocking triggers: normal (PR comment by @alice)");
  });

  test("AC-11 names every writer scope ruling it ignored", async () => {
    await bot.postPrReview(blocking([adversarial], { ignoredScopeRulings: ["blocking triggers: normal, race"] }));
    expect(summaryBody()).toContain("Ignored scope ruling: blocking triggers: normal, race");
  });
});
