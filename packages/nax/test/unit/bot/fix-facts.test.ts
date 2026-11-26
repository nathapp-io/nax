import { describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { makePRD, makeStory, withTempDir } from "@test/helpers";
import type { AgreedItem } from "@/bot";
import { findingFactLines, lineagePushFacts, type OutsideGrowthDeps, outsideDeclaredGrowth } from "@/bot/fix-facts";
import { botGit } from "@/bot/git";
import type { BotPushEntry, BotPushItem } from "@/bot/push-ledger";
import { DEFAULT_BLOCKING_TRIGGERS } from "@/workflow/blocking-findings";

const PUSH_SHA = "abcdef1234567890abcdef1234567890abcdef12";
const SHORT_PUSH_SHA = PUSH_SHA.slice(0, 7);
const BASE_SHA = "0".repeat(40);

function finding(overrides: Partial<Extract<AgreedItem, { kind: "finding" }>> = {}): AgreedItem {
  return { kind: "finding", key: "f-new", severity: "important", issue: "Fresh finding", ...overrides };
}

function entry(items: readonly BotPushItem[], sha = PUSH_SHA): BotPushEntry {
  return { base: BASE_SHA, sha, at: "2026-01-01T00:00:00.000Z", items };
}

const items: readonly BotPushItem[] = [
  { key: "f-a", generation: 0, issue: "lock leaks" },
  { key: "f-b", generation: 1, issue: "claim files leak" },
];
const ledger: readonly BotPushEntry[] = [entry(items)];

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

  // #2998: one Lineage line per finding. A two-parent lineage names both parents on that one line;
  // their issues belong to the push's own item list (`lineagePushFacts`), not to each finding.
  test("AC-1: a two-parent lineage yields exactly one Lineage line naming both parents", () => {
    const lines = findingFactLines(
      finding({ lineage: { generation: 3, parents: ["f-a", "f-b"], pushSha: PUSH_SHA } }),
      ledger,
      DEFAULT_BLOCKING_TRIGGERS,
    );
    expect(lines.filter((line) => line.startsWith("Lineage:"))).toEqual([
      `Lineage: generation 3, on lines added by nax bot fix ${SHORT_PUSH_SHA} for f-a, f-b`,
    ]);
  });

  test("AC-2: a single-parent lineage keeps the parent's issue as a suffix", () => {
    const lines = findingFactLines(
      finding({ lineage: { generation: 2, parents: ["f-a"], pushSha: PUSH_SHA } }),
      ledger,
      DEFAULT_BLOCKING_TRIGGERS,
    );
    expect(lines.filter((line) => line.startsWith("Lineage:"))).toEqual([
      `Lineage: generation 2, on lines added by nax bot fix ${SHORT_PUSH_SHA} for f-a (lock leaks)`,
    ]);
  });

  test("AC-3: a single parent whose push the ledger dropped carries no issue suffix", () => {
    const lines = findingFactLines(
      finding({ lineage: { generation: 2, parents: ["f-a"], pushSha: "2".repeat(40) } }),
      ledger,
      DEFAULT_BLOCKING_TRIGGERS,
    );
    expect(lines.filter((line) => line.startsWith("Lineage:"))).toEqual([
      "Lineage: generation 2, on lines added by nax bot fix 2222222 for f-a",
    ]);
  });

  // B7: a finding key recurs across pushes, so the issue must come from the push the lineage names.
  test("B7: a repeated key reports the issue the lineage's own push recorded", () => {
    const later = "1".repeat(40);
    const repeated: readonly BotPushEntry[] = [
      entry([{ key: "f-a", generation: 0, issue: "lock leaks" }], PUSH_SHA),
      entry([{ key: "f-a", generation: 1, issue: "claim file leaks instead" }], later),
    ];
    const lines = findingFactLines(
      finding({ lineage: { generation: 2, parents: ["f-a"], pushSha: PUSH_SHA } }),
      repeated,
      DEFAULT_BLOCKING_TRIGGERS,
    );
    expect(lines).toContain(
      `Lineage: generation 2, on lines added by nax bot fix ${SHORT_PUSH_SHA} for f-a (lock leaks)`,
    );
    expect(lines.join("\n")).not.toContain("claim file leaks instead");
  });

  // B7: a push the ledger has dropped must not lend another push's issue to its parent.
  test("B7: an evicted push names the parent without borrowing another push's issue", () => {
    const lines = findingFactLines(
      finding({ lineage: { generation: 2, parents: ["f-a"], pushSha: "2".repeat(40) } }),
      ledger,
      DEFAULT_BLOCKING_TRIGGERS,
    );
    expect(lines).toContain(`Lineage: generation 2, on lines added by nax bot fix 2222222 for f-a`);
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

/**
 * #2998: the items of a push that a multi-parent lineage names are listed once, per push, instead of
 * once for every parent of every finding. A push named only by single-parent lineages contributes
 * nothing — its parent's issue is already on that finding's own `Lineage:` line.
 */
describe("lineagePushFacts", () => {
  /** A sha sorting before `PUSH_SHA`, so a sorted result is distinguishable from the input order. */
  const EARLIER_SHA = "0f".repeat(20);
  const SHORT_EARLIER_SHA = EARLIER_SHA.slice(0, 7);
  const EVICTED_SHA = "2".repeat(40);

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
  const comment: AgreedItem = { kind: "comment", key: "c-1", issue: "Consider this", reason: "Agrees" };

  const multi = (key: string, parents: readonly string[], pushSha = PUSH_SHA): AgreedItem =>
    finding({ key, lineage: { generation: 3, parents, pushSha } });

  /** The output reduced to what AC-4 and AC-8 pin: each push's sha and its keys, in order. */
  function shaAndKeys(agreed: readonly AgreedItem[], entries: readonly BotPushEntry[]) {
    return lineagePushFacts(agreed, entries).map(({ sha, items }) => ({ sha, keys: items.map(({ key }) => key) }));
  }

  const threeItems: readonly BotPushItem[] = [
    { key: "f-a", generation: 0, issue: "lock leaks" },
    { key: "f-b", generation: 1, issue: "claim files leak" },
    { key: "f-c", generation: 1, issue: "dirty index" },
  ];

  test("AC-4: two multi-parent lineages on one push list its keys once, in first-seen order", () => {
    expect(shaAndKeys([multi("f-1", ["f-a", "f-b"]), multi("f-2", ["f-b", "f-c"])], [entry(threeItems)])).toEqual([
      { sha: SHORT_PUSH_SHA, keys: ["f-a", "f-b", "f-c"] },
    ]);
  });

  test("AC-5: each item carries the issue the ledger recorded for its key on that push", () => {
    const facts = lineagePushFacts([multi("f-1", ["f-a", "f-b"]), multi("f-2", ["f-b", "f-c"])], [entry(threeItems)]);
    expect(facts[0]?.items).toEqual([
      { key: "f-a", issue: "lock leaks" },
      { key: "f-b", issue: "claim files leak" },
      { key: "f-c", issue: "dirty index" },
    ]);
  });

  test("AC-6: a key the push's entry does not hold carries no issue field", () => {
    const facts = lineagePushFacts([multi("f-1", ["f-a", "f-c"])], ledger);
    const missing = facts[0]?.items.find(({ key }) => key === "f-c");
    expect(missing).toEqual({ key: "f-c" });
    expect(Object.keys(missing ?? {})).toEqual(["key"]);
  });

  test("AC-7: single-parent lineages alone list no push", () => {
    expect(lineagePushFacts([multi("f-1", ["f-a"]), multi("f-2", ["f-b"])], ledger)).toEqual([]);
  });

  test("AC-8: one entry per distinct push, in the order the items first name them", () => {
    expect(shaAndKeys([multi("f-1", ["f-a", "f-b"]), multi("f-2", ["f-c", "f-d"], EARLIER_SHA)], ledger)).toEqual([
      { sha: SHORT_PUSH_SHA, keys: ["f-a", "f-b"] },
      { sha: SHORT_EARLIER_SHA, keys: ["f-c", "f-d"] },
    ]);
  });

  test("AC-9: items that are not findings add no entry and change nothing beside a finding", () => {
    expect(lineagePushFacts([thread, comment], ledger)).toEqual([]);
    expect(shaAndKeys([thread, multi("f-1", ["f-a", "f-b"]), comment], ledger)).toEqual([
      { sha: SHORT_PUSH_SHA, keys: ["f-a", "f-b"] },
    ]);
  });

  test("AC-10: a single-parent lineage naming the same push adds none of its own keys", () => {
    expect(shaAndKeys([multi("f-1", ["f-a", "f-b"]), multi("f-2", ["f-c"])], [entry(threeItems)])).toEqual([
      { sha: SHORT_PUSH_SHA, keys: ["f-a", "f-b"] },
    ]);
  });

  test("AC-11: a push the ledger no longer holds is listed with keys and no issues", () => {
    expect(lineagePushFacts([multi("f-1", ["f-a", "f-b"], EVICTED_SHA)], ledger)).toEqual([
      { sha: "2222222", items: [{ key: "f-a" }, { key: "f-b" }] },
    ]);
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

  /**
   * The ADR-032 R3 probe: which repo-relative paths exist in this fixture's tree. Nothing exists unless
   * a test says so, so every declared path stays exactly as written.
   */
  function tree(...paths: readonly string[]): OutsideGrowthDeps["exists"] {
    return (path) => paths.includes(path);
  }

  /** `git diff --numstat -z` records, NUL separated, each `<added>\t<deleted>\t<path>`. */
  const records = (...entries: readonly string[]): string => entries.map((line) => `${line}\0`).join("");

  /** A rename record: numstat carries no path inline, the old and the new path follow as fields. */
  const rename = (added: number, from: string, to: string): string => `${added}\t0\t\0${from}\0${to}\0`;

  function deps(overrides: Partial<OutsideGrowthDeps> = {}): OutsideGrowthDeps {
    return {
      loadPRD: overrides.loadPRD ?? (async () => declaredPRD),
      runGit: overrides.runGit ?? git(""),
      exists: overrides.exists ?? tree(),
    };
  }

  test("AC-8: only the undeclared path is reported", async () => {
    const runGit = git(records("10\t0\tsrc/a.ts", "20\t2\tsrc/c.ts", "5\t1\tsrc/b.ts"));
    const growth = await outsideDeclaredGrowth(
      { prdPath, worktree, entries: [{ base: "base", sha: "sha" }] },
      deps({ runGit }),
    );
    expect(growth).toEqual([{ path: "src/c.ts", added: 20 }]);
  });

  test("AC-8: a declared modified file is not growth", async () => {
    const runGit = git(records("7\t0\ttest/a.test.ts"));
    const growth = await outsideDeclaredGrowth(
      { prdPath, worktree, entries: [{ base: "base", sha: "sha" }] },
      deps({ runGit }),
    );
    expect(growth).toEqual([]);
  });

  test("AC-8: a binary file and a pure deletion report no growth", async () => {
    const runGit = git(records("-\t-\tassets/logo.png", "0\t9\tsrc/gone.ts"));
    const growth = await outsideDeclaredGrowth(
      { prdPath, worktree, entries: [{ base: "base", sha: "sha" }] },
      deps({ runGit }),
    );
    expect(growth).toEqual([]);
  });

  test("AC-9: every ledger entry is diffed as numstat from its base to its sha", async () => {
    const runGit = git(records("1\t0\tsrc/c.ts"));
    await outsideDeclaredGrowth(
      {
        prdPath,
        worktree,
        entries: [
          { base: "base-1", sha: "sha-1" },
          { base: "base-2", sha: "sha-2" },
        ],
      },
      deps({ runGit }),
    );
    expect(runGit.mock.calls.map(([args]) => args)).toEqual([
      ["diff", "--numstat", "-z", "base-1", "sha-1"],
      ["diff", "--numstat", "-z", "base-2", "sha-2"],
    ]);
    expect(runGit.mock.calls.every(([, dir]) => dir === worktree)).toBe(true);
  });

  test("AC-10: a declared path re-spelled into the story's package counts as declared", async () => {
    // The legacy shape R3 allows: absent at the repo root, present under the package.
    const prd = makePRD({ userStories: [makeStory({ contextFiles: ["src/a.ts"], workdir: "packages/x" })] });
    const runGit = git(records("4\t0\tpackages/x/src/a.ts", "3\t0\tpackages/x/src/c.ts"));
    const growth = await outsideDeclaredGrowth(
      { prdPath, worktree, entries: [{ base: "base", sha: "sha" }] },
      deps({ loadPRD: async () => prd, runGit, exists: tree("/checkout/packages/x/src/a.ts") }),
    );
    expect(growth).toEqual([{ path: "packages/x/src/c.ts", added: 3 }]);
  });

  // B9 (ADR-032 R3): the root spelling is what the story declares, so a same-named file inside the
  // package is a different file and stays visible as growth.
  test("B9: when root and package spellings both exist, only the root one is declared", async () => {
    const prd = makePRD({ userStories: [makeStory({ contextFiles: ["src/a.ts"], workdir: "packages/x" })] });
    const runGit = git(records("5\t0\tpackages/x/src/a.ts"));
    const growth = await outsideDeclaredGrowth(
      { prdPath, worktree, entries: [{ base: "base", sha: "sha" }] },
      deps({
        loadPRD: async () => prd,
        runGit,
        exists: tree("/checkout/src/a.ts", "/checkout/packages/x/src/a.ts"),
      }),
    );
    expect(growth).toEqual([{ path: "packages/x/src/a.ts", added: 5 }]);
  });

  // B8: plain numstat prints a rename as a compact expression, which is not a repository path.
  test("B8: a rename counts against its destination path", async () => {
    const prd = makePRD({ userStories: [makeStory({ expectedFiles: ["src/b.ts"] })] });
    const runGit = git(rename(42, "src/a.ts", "src/b.ts"));
    const growth = await outsideDeclaredGrowth(
      { prdPath, worktree, entries: [{ base: "base", sha: "sha" }] },
      deps({ loadPRD: async () => prd, runGit }),
    );
    expect(growth).toEqual([]);
  });

  test("B8: a rename into an undeclared path is growth at the destination", async () => {
    const runGit = git(rename(6, "src/a.ts", "src/moved.ts"));
    const growth = await outsideDeclaredGrowth(
      { prdPath, worktree, entries: [{ base: "base", sha: "sha" }] },
      deps({ runGit }),
    );
    expect(growth).toEqual([{ path: "src/moved.ts", added: 6 }]);
  });

  // B8: the real-Git regression. A rename with edits into a declared path reports the destination, and
  // the destination is declared, so none of its 42 added lines are outside growth.
  test("B8: real git reports a rename's destination, so an edited rename into a declared path is no growth", async () => {
    await withTempDir(async (dir) => {
      const gitIn = (args: readonly string[]) => botGit([...args], dir);
      const before = Array.from({ length: 100 }, (_unused, index) => `line ${index}\n`).join("");
      await Bun.write(join(dir, "src/a.ts"), before);
      for (const args of [
        ["init", "-q"],
        ["config", "user.email", "test@example.com"],
        ["config", "user.name", "Test"],
        ["add", "."],
        ["commit", "-q", "-m", "base"],
      ])
        expect((await gitIn(args)).exitCode).toBe(0);
      const base = (await gitIn(["rev-parse", "HEAD"])).stdout.trim();
      // A real rename: git reports one only where the old path is gone, so `git mv` and then edit.
      expect((await gitIn(["mv", "src/a.ts", "src/b.ts"])).exitCode).toBe(0);
      await Bun.write(join(dir, "src/b.ts"), `${before}${"extra\n".repeat(42)}`);
      for (const args of [
        ["add", "-A"],
        ["commit", "-q", "-m", "rename with edits"],
      ])
        expect((await gitIn(args)).exitCode).toBe(0);
      const sha = (await gitIn(["rev-parse", "HEAD"])).stdout.trim();
      // A rename record carries no inline path: the old path and the destination follow as their own fields.
      const raw = await gitIn(["diff", "--numstat", "-z", base, sha]);
      expect(raw.stdout.startsWith("42\t0\t\0src/a.ts\0src/b.ts\0")).toBe(true);

      const prd = makePRD({ userStories: [makeStory({ expectedFiles: ["src/b.ts"] })] });
      const growth = await outsideDeclaredGrowth(
        { prdPath: join(dir, "prd.json"), worktree: dir, entries: [{ base, sha }] },
        {
          loadPRD: async () => prd,
          runGit: (args, workdir) => botGit(args, workdir),
          exists: (path) => Bun.file(path).size > 0,
        },
      );
      expect(growth).toEqual([]);
    });
  });

  test("AC-11: two entries at the same undeclared path are summed", async () => {
    const declaredA = makePRD({ userStories: [makeStory({ contextFiles: ["src/a.ts"] })] });
    const runGit = mock(async (args: string[]) => ({
      exitCode: 0,
      stdout: records(args[4] === "sha-1" ? "10\t0\tsrc/c.ts" : "20\t0\tsrc/c.ts"),
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
      deps({ loadPRD: async () => declaredA, runGit }),
    );
    expect(growth).toEqual([{ path: "src/c.ts", added: 30 }]);
  });

  test("AC-12: no PRD path gives no fact", async () => {
    const loadPRD = mock(async () => declaredPRD);
    const runGit = git(records("3\t0\tsrc/c.ts"));
    const growth = await outsideDeclaredGrowth(
      { worktree, entries: [{ base: "base", sha: "sha" }] },
      deps({ loadPRD, runGit }),
    );
    expect(growth).toBeUndefined();
    expect(loadPRD).not.toHaveBeenCalled();
    expect(runGit).not.toHaveBeenCalled();
  });

  test("AC-13: an unreadable PRD gives no fact", async () => {
    const runGit = git(records("3\t0\tsrc/c.ts"));
    const growth = await outsideDeclaredGrowth(
      { prdPath, worktree, entries: [{ base: "base", sha: "sha" }] },
      deps({
        loadPRD: async () => {
          throw new Error("PRD file is corrupt");
        },
        runGit,
      }),
    );
    expect(growth).toBeUndefined();
    expect(runGit).not.toHaveBeenCalled();
  });

  test("AC-14: a failed numstat gives no fact", async () => {
    const growth = await outsideDeclaredGrowth(
      { prdPath, worktree, entries: [{ base: "base", sha: "sha" }] },
      deps({ runGit: git("", 128) }),
    );
    expect(growth).toBeUndefined();
  });

  test("AC-14: a throwing numstat gives no fact", async () => {
    const growth = await outsideDeclaredGrowth(
      { prdPath, worktree, entries: [{ base: "base", sha: "sha" }] },
      deps({
        runGit: async () => {
          throw new Error("posix_spawn 'git' ENOENT");
        },
      }),
    );
    expect(growth).toBeUndefined();
  });
});

describe("findingFactLines advisor ruling", () => {
  const withLineage = finding({
    trigger: "adversarial",
    lineage: { generation: 2, parents: ["f-a"], pushSha: PUSH_SHA },
  });
  test("AC-3 ends with the advisor ruling line", () => {
    const lines = findingFactLines(withLineage, ledger, DEFAULT_BLOCKING_TRIGGERS, "restore the guard");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.at(-1)).toBe("Advisor ruling: restore the guard");
  });
  test("AC-4 states no ruling line without an instruction", () => {
    const lines = findingFactLines(withLineage, ledger, DEFAULT_BLOCKING_TRIGGERS);
    expect(lines.some((line) => line.startsWith("Advisor ruling:"))).toBe(false);
  });
  test("AC-5 a thread item stays empty even with an instruction", () => {
    const thread: AgreedItem = { kind: "thread", key: "t-1", issue: "x", reason: "y", threadId: "T", replyTo: "C" };
    expect(findingFactLines(thread, ledger, DEFAULT_BLOCKING_TRIGGERS, "restore the guard")).toEqual([]);
  });
});
