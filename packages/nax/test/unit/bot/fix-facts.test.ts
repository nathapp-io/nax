import { describe, expect, mock, test } from "bun:test";
import { makePRD, makeStory } from "@test/helpers";
import type { AgreedItem } from "@/bot";
import { findingFactLines, outsideDeclaredGrowth } from "@/bot/fix-facts";
import type { BotPushItem } from "@/bot/push-ledger";
import { DEFAULT_BLOCKING_TRIGGERS } from "@/workflow/blocking-findings";

const PUSH_SHA = "abcdef1234567890abcdef1234567890abcdef12";
const SHORT_PUSH_SHA = PUSH_SHA.slice(0, 7);

function finding(overrides: Partial<Extract<AgreedItem, { kind: "finding" }>> = {}): AgreedItem {
  return { kind: "finding", key: "f-new", severity: "important", issue: "Fresh finding", ...overrides };
}

const ledger: readonly BotPushItem[] = [
  { key: "f-a", generation: 0, issue: "lock leaks" },
  { key: "f-b", generation: 1, issue: "claim files leak" },
];

describe("findingFactLines", () => {
  test("AC-1: a triggered finding leads with its class and evidence", () => {
    const lines = findingFactLines(
      finding({ trigger: "adversarial", triggerEvidence: "forged mtime" }),
      [],
      DEFAULT_BLOCKING_TRIGGERS,
    );
    expect(lines[0]).toBe("Trigger: adversarial - forged mtime");
  });

  test("AC-2: a finding with no trigger states no Trigger line", () => {
    const lines = findingFactLines(finding({ severity: "minor" }), [], DEFAULT_BLOCKING_TRIGGERS);
    expect(lines.some((line) => line.startsWith("Trigger:"))).toBe(false);
  });

  test("AC-3: lineage names the generation, the push and the parent's issue", () => {
    const lines = findingFactLines(
      finding({ lineage: { generation: 2, parents: ["f-a"], pushSha: PUSH_SHA } }),
      ledger,
      DEFAULT_BLOCKING_TRIGGERS,
    );
    expect(lines).toContain(
      `Lineage: generation 2, on lines added by nax bot fix ${SHORT_PUSH_SHA} for f-a (lock leaks)`,
    );
  });

  test("AC-4: two parents yield one Lineage line each", () => {
    const lines = findingFactLines(
      finding({ lineage: { generation: 3, parents: ["f-a", "f-b"], pushSha: PUSH_SHA } }),
      ledger,
      DEFAULT_BLOCKING_TRIGGERS,
    );
    const lineage = lines.filter((line) => line.startsWith("Lineage:"));
    expect(lineage).toEqual([
      `Lineage: generation 3, on lines added by nax bot fix ${SHORT_PUSH_SHA} for f-a (lock leaks)`,
      `Lineage: generation 3, on lines added by nax bot fix ${SHORT_PUSH_SHA} for f-b (claim files leak)`,
    ]);
  });

  test("AC-5: a minor finding states it holds no readiness", () => {
    const lines = findingFactLines(finding({ severity: "minor" }), [], DEFAULT_BLOCKING_TRIGGERS);
    expect(lines).toContain("Not blocking readiness (minor or trigger outside the blocking set)");
  });

  test("AC-6: an important normal finding under the default set states no readiness line", () => {
    const lines = findingFactLines(finding({ trigger: "normal" }), [], ["normal"]);
    expect(lines.some((line) => line.startsWith("Not blocking readiness"))).toBe(false);
  });

  test("AC-6: a trigger outside the blocking set states the readiness line", () => {
    const lines = findingFactLines(finding({ trigger: "adversarial" }), [], ["normal"]);
    expect(lines).toContain("Not blocking readiness (minor or trigger outside the blocking set)");
  });

  test("AC-7: a thread item yields no lines", () => {
    const thread: AgreedItem = {
      kind: "thread",
      key: "t-1",
      issue: "Rename it",
      reason: "Clearer",
      threadId: "T1",
      replyTo: "1",
      file: "src/a.ts",
      line: 4,
    };
    expect(findingFactLines(thread, ledger, DEFAULT_BLOCKING_TRIGGERS)).toEqual([]);
  });

  test("AC-7: a comment item yields no lines", () => {
    const comment: AgreedItem = { kind: "comment", key: "c-1", issue: "Consider this", reason: "Agrees" };
    expect(findingFactLines(comment, ledger, DEFAULT_BLOCKING_TRIGGERS)).toEqual([]);
  });
});

describe("outsideDeclaredGrowth", () => {
  const prdPath = "/checkout/.nax/features/f/prd.json";
  const worktree = "/checkout";
  const declaredPRD = makePRD({
    userStories: [
      makeStory({
        contextFiles: ["src/a.ts"],
        expectedFiles: ["src/b.ts"],
        modifiedFiles: [{ path: "test/a.test.ts", reason: "a changed assertion" }],
      }),
    ],
  });

  function git(stdout: string, exitCode = 0) {
    return mock(async (_args: string[], _workdir: string) => ({ exitCode, stdout, stderr: "" }));
  }

  test("AC-8: only the undeclared path is reported", async () => {
    const runGit = git("10\t0\tsrc/a.ts\n20\t2\tsrc/c.ts\n5\t1\tsrc/b.ts");
    const growth = await outsideDeclaredGrowth(
      { prdPath, worktree, entries: [{ base: "base", sha: "sha" }] },
      { loadPRD: async () => declaredPRD, runGit },
    );
    expect(growth).toEqual([{ path: "src/c.ts", added: 20 }]);
  });

  test("AC-8: a declared modified file is not growth", async () => {
    const runGit = git("7\t0\ttest/a.test.ts");
    const growth = await outsideDeclaredGrowth(
      { prdPath, worktree, entries: [{ base: "base", sha: "sha" }] },
      { loadPRD: async () => declaredPRD, runGit },
    );
    expect(growth).toEqual([]);
  });

  test("AC-8: a binary file and a pure deletion report no growth", async () => {
    const runGit = git("-\t-\tassets/logo.png\n0\t9\tsrc/gone.ts");
    const growth = await outsideDeclaredGrowth(
      { prdPath, worktree, entries: [{ base: "base", sha: "sha" }] },
      { loadPRD: async () => declaredPRD, runGit },
    );
    expect(growth).toEqual([]);
  });

  test("AC-9: every ledger entry is diffed as numstat from its base to its sha", async () => {
    const runGit = git("1\t0\tsrc/c.ts");
    await outsideDeclaredGrowth(
      {
        prdPath,
        worktree,
        entries: [
          { base: "base-1", sha: "sha-1" },
          { base: "base-2", sha: "sha-2" },
        ],
      },
      { loadPRD: async () => declaredPRD, runGit },
    );
    expect(runGit.mock.calls.map(([args]) => args)).toEqual([
      ["diff", "--numstat", "base-1", "sha-1"],
      ["diff", "--numstat", "base-2", "sha-2"],
    ]);
    expect(runGit.mock.calls.every(([, workdir]) => workdir === worktree)).toBe(true);
  });

  test("AC-10: a story's workdir makes the declared path relative to the package", async () => {
    const prd = makePRD({ userStories: [makeStory({ contextFiles: ["src/a.ts"], workdir: "packages/x" })] });
    const runGit = git("4\t0\tpackages/x/src/a.ts\n3\t0\tpackages/x/src/c.ts");
    const growth = await outsideDeclaredGrowth(
      { prdPath, worktree, entries: [{ base: "base", sha: "sha" }] },
      { loadPRD: async () => prd, runGit },
    );
    expect(growth).toEqual([{ path: "packages/x/src/c.ts", added: 3 }]);
  });

  test("AC-11: two entries at the same undeclared path are summed", async () => {
    const declaredA = makePRD({ userStories: [makeStory({ contextFiles: ["src/a.ts"] })] });
    const runGit = mock(async (args: string[]) => ({
      exitCode: 0,
      stdout: args[3] === "sha-1" ? "10\t0\tsrc/c.ts" : "20\t0\tsrc/c.ts",
      stderr: "",
    }));
    const growth = await outsideDeclaredGrowth(
      {
        prdPath,
        worktree,
        entries: [
          { base: "base", sha: "sha-1" },
          { base: "base", sha: "sha-2" },
        ],
      },
      { loadPRD: async () => declaredA, runGit },
    );
    expect(growth).toEqual([{ path: "src/c.ts", added: 30 }]);
  });

  test("AC-12: no PRD path gives no fact", async () => {
    const loadPRD = mock(async () => declaredPRD);
    const runGit = git("3\t0\tsrc/c.ts");
    const growth = await outsideDeclaredGrowth(
      { worktree, entries: [{ base: "base", sha: "sha" }] },
      { loadPRD, runGit },
    );
    expect(growth).toBeUndefined();
    expect(loadPRD).not.toHaveBeenCalled();
    expect(runGit).not.toHaveBeenCalled();
  });

  test("AC-13: an unreadable PRD gives no fact", async () => {
    const runGit = git("3\t0\tsrc/c.ts");
    const growth = await outsideDeclaredGrowth(
      { prdPath, worktree, entries: [{ base: "base", sha: "sha" }] },
      {
        loadPRD: async () => {
          throw new Error("PRD file is corrupt");
        },
        runGit,
      },
    );
    expect(growth).toBeUndefined();
    expect(runGit).not.toHaveBeenCalled();
  });

  test("AC-14: a failed numstat gives no fact", async () => {
    const growth = await outsideDeclaredGrowth(
      { prdPath, worktree, entries: [{ base: "base", sha: "sha" }] },
      { loadPRD: async () => declaredPRD, runGit: git("", 128) },
    );
    expect(growth).toBeUndefined();
  });

  test("AC-14: a throwing numstat gives no fact", async () => {
    const growth = await outsideDeclaredGrowth(
      { prdPath, worktree, entries: [{ base: "base", sha: "sha" }] },
      {
        loadPRD: async () => declaredPRD,
        runGit: async () => {
          throw new Error("posix_spawn 'git' ENOENT");
        },
      },
    );
    expect(growth).toBeUndefined();
  });
});
