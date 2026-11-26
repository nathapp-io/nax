import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeBotFixEnv } from "@test/helpers";
import { buildMenu } from "@/advisor";
import type { AgreedItem, BotFixEnv } from "@/bot";
import type { ChainFinding } from "@/bot/chain-advise";
import { _chainQuestionDeps, buildChainQuestion, CHAIN_DIFF_CHARS } from "@/bot/chain-question";
import { chainRulingKey } from "@/bot/chain-rulings";
import { pushRecordBody, pushRecordKey } from "@/bot/push-ledger";

type Finding = Extract<AgreedItem, { kind: "finding" }>;
type GitResult = Awaited<ReturnType<typeof _chainQuestionDeps.runGit>>;

const SHA = "abcdef1000000000000000000000000000000000";
const MERGE_BASE = "mergebase0";

function item(overrides: Partial<Finding> = {}): Finding {
  return {
    kind: "finding",
    key: "f-1",
    issue: "first line of issue\nsecond line",
    severity: "important",
    trigger: "normal",
    triggerEvidence: "trigger-evidence-text",
    origin: "fix-gap",
    originEvidence: "origin-evidence-text",
    file: "src/a.ts",
    line: 12,
    suggestion: "do the suggested thing",
    lineage: { generation: 2, pushSha: SHA, parents: ["f-p1", "f-p2"] },
    ...overrides,
  };
}

function env(): BotFixEnv {
  const base = makeBotFixEnv([]);
  const entry = { base: "b", sha: SHA, at: "t", items: [{ key: "f-p1", generation: 1, issue: "first parent issue" }] };
  const comment = { id: "c", kind: "comment" as const, author: "bot", body: pushRecordBody(entry), createdAt: "" };
  return {
    ...base,
    checkout: { ...base.checkout, mergeBase: MERGE_BASE, worktree: "/wt" },
    own: [{ comment, key: pushRecordKey(SHA) }],
  };
}

const ok = (stdout: string): GitResult => ({ stdout, stderr: "", exitCode: 0 });
const calls: { args: string[]; cwd: string }[] = [];
let original: typeof _chainQuestionDeps.runGit;

function stubGit(impl: (args: string[]) => Promise<GitResult>): void {
  _chainQuestionDeps.runGit = (args, cwd) => {
    calls.push({ args, cwd });
    return impl(args);
  };
}

function chain(it: Finding = item()): ChainFinding {
  return { item: it };
}

beforeEach(() => {
  original = _chainQuestionDeps.runGit;
  calls.length = 0;
  stubGit(async (args) => ok(args[0] === "diff" ? "DIFF-OUT" : "SHOW-OUT"));
});
afterEach(() => {
  _chainQuestionDeps.runGit = original;
});

describe("buildChainQuestion", () => {
  test("AC-1 returns the question's identifying fields", async () => {
    const d = await buildChainQuestion(env(), chain(), "my-feature");
    expect(d).toMatchObject({
      kind: "bot-fix-chain",
      feature: "my-feature",
      dedupeKey: chainRulingKey("f-1"),
      findingSeverity: "important",
      anchorFile: "src/a.ts",
    });
  });

  test("AC-2 options equal the bot-fix-chain menu", async () => {
    const d = await buildChainQuestion(env(), chain(), "f");
    expect(d.options).toEqual(buildMenu({ kind: "bot-fix-chain" }));
  });

  test("AC-3 rulingTitle is the first line of the issue", async () => {
    expect((await buildChainQuestion(env(), chain(), "f")).rulingTitle).toBe("first line of issue");
  });

  test("AC-4 summary names the finding, generation and short sha", async () => {
    const d = await buildChainQuestion(env(), chain(), "f");
    expect(d.summary).toBe("Finding f-1 (important) sits at generation 2 on lines nax bot fix abcdef1 added.");
  });

  test("AC-5..8 first evidence is the finding with issue, location and suggestion", async () => {
    const first = (await buildChainQuestion(env(), chain(), "f")).evidence[0];
    expect(first?.source).toBe("finding");
    expect(first?.text).toContain("first line of issue");
    expect(first?.text).toContain("src/a.ts:12");
    expect(first?.text).toContain("do the suggested thing");
    expect(first?.text).toContain("trigger-evidence-text");
    expect(first?.text).toContain("origin-evidence-text");
  });

  test("AC-9..11 second evidence is the review round with parent issues", async () => {
    const second = (await buildChainQuestion(env(), chain(), "f")).evidence[1];
    expect(second?.source).toBe("review-round");
    expect(second?.text).toContain("first parent issue");
    expect(second?.text).toContain("f-p2");
  });

  test("AC-12/13 runs git diff and git show in the worktree", async () => {
    await buildChainQuestion(env(), chain(), "f");
    expect(calls.map((c) => c.args)).toContainEqual(["diff", `${MERGE_BASE}..HEAD`, "--", "src/a.ts"]);
    expect(calls.map((c) => c.args)).toContainEqual(["show", SHA, "--", "src/a.ts"]);
    expect(calls.every((c) => c.cwd === "/wt")).toBe(true);
  });

  test("AC-14/15 diff entries carry the git output", async () => {
    const { evidence } = await buildChainQuestion(env(), chain(), "f");
    expect(evidence.find((e) => e.ref === "src/a.ts")?.text).toBe("DIFF-OUT");
    expect(evidence.find((e) => e.ref === SHA)?.text).toBe("SHOW-OUT");
    expect(evidence.filter((e) => e.source === "diff")).toHaveLength(2);
  });

  test("AC-16 cuts a diff over the cap", async () => {
    stubGit(async (args) => ok(args[0] === "diff" ? "x".repeat(20_000) : "s"));
    const { evidence } = await buildChainQuestion(env(), chain(), "f");
    expect(evidence.find((e) => e.ref === "src/a.ts")?.text).toBe(
      `${"x".repeat(12_000)}\n(diff cut at 12000 characters)`,
    );
  });

  test("AC-17 leaves a diff of exactly the cap untouched", async () => {
    stubGit(async (args) => ok(args[0] === "diff" ? "x".repeat(12_000) : "s"));
    const { evidence } = await buildChainQuestion(env(), chain(), "f");
    expect(evidence.find((e) => e.ref === "src/a.ts")?.text).toBe("x".repeat(12_000));
  });

  test("AC-18 non-zero exits leave only finding and review-round", async () => {
    stubGit(async () => ({ stdout: "out", stderr: "", exitCode: 1 }));
    const { evidence } = await buildChainQuestion(env(), chain(), "f");
    expect(evidence.map((e) => e.source)).toEqual(["finding", "review-round"]);
  });

  test("AC-19 a rejecting git diff leaves only the show entry", async () => {
    stubGit(async (args) => {
      if (args[0] === "diff") throw new Error("boom");
      return ok("SHOW-OUT");
    });
    const { evidence } = await buildChainQuestion(env(), chain(), "f");
    expect(evidence.filter((e) => e.source === "diff").map((e) => e.ref)).toEqual([SHA]);
  });

  test("AC-20 runs no git for a finding with no file", async () => {
    const { file: _f, ...rest } = item();
    const d = await buildChainQuestion(env(), chain(rest), "f");
    expect(calls).toHaveLength(0);
    expect(d.anchorFile).toBeUndefined();
  });

  test("AC-21 CHAIN_DIFF_CHARS is 12000", () => {
    expect(CHAIN_DIFF_CHARS).toBe(12_000);
  });

  test("AC-22 a timed-out command leaves out its entry", async () => {
    stubGit(async (args) =>
      args[0] === "diff" ? { stdout: "", stderr: "", exitCode: 1, timedOut: true } : ok("SHOW-OUT"),
    );
    const { evidence } = await buildChainQuestion(env(), chain(), "f");
    expect(evidence.filter((e) => e.source === "diff").map((e) => e.ref)).toEqual([SHA]);
  });
});
