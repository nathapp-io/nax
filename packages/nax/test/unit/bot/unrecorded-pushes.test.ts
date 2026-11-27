import { describe, expect, test } from "bun:test";
import type { BotPushEntry } from "@/bot/push-ledger";
import { answerableThreads, openFindings, unrecordedPushes } from "@/bot/unrecorded-pushes";
import { type PrThread, withNaxBotMarker } from "@/forge";

const RANGE = "r".repeat(40);
const HEAD = "h".repeat(40);
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const P1 = "a".repeat(40);
const P2 = "b".repeat(40);

function thread(key: string, path: string | undefined, body: string): PrThread {
  return {
    id: `t-${key}`,
    replyTo: `r-${key}`,
    ...(path === undefined ? {} : { path }),
    line: 3,
    resolved: false,
    outdated: false,
    comments: [
      {
        id: `c-${key}`,
        kind: "thread",
        author: "bot",
        createdAt: "2026-11-27T00:00:00Z",
        body: withNaxBotMarker(body, key),
      },
    ],
  };
}

/** A git stub answering by the joined argv; an unexpected call fails the test. */
function fakeGit(answers: Readonly<Record<string, { stdout: string; exitCode?: number }>>) {
  const calls: string[] = [];
  const runGit = async (args: string[], _cwd: string) => {
    const key = args.join(" ");
    calls.push(key);
    const answer = answers[key];
    if (answer === undefined) throw new Error(`unexpected git call: ${key}`);
    return { stdout: answer.stdout, stderr: "", exitCode: answer.exitCode ?? 0 };
  };
  return { deps: { runGit }, calls };
}

const REV_LIST = `rev-list --no-merges --reverse --parents ${RANGE}..${HEAD}`;
const files = (sha: string) => `diff-tree --no-commit-id --name-only -r -z ${sha}`;

describe("openFindings", () => {
  test("reads key, path, issue and the generation a thread states", () => {
    const threads = [
      thread(
        "f-a",
        "src/a.ts",
        "Important: the lock leaks on error\n\nLineage: generation 2, on lines added by nax bot fix abc1234 for f-0",
      ),
      thread("f-b", "src/b.ts", "Minor: a name is unclear"),
    ];
    expect(openFindings(threads)).toEqual([
      { key: "f-a", path: "src/a.ts", issue: "Important: the lock leaks on error", generation: 2 },
      { key: "f-b", path: "src/b.ts", issue: "Minor: a name is unclear", generation: 0 },
    ]);
  });

  test("skips a thread with no path or no nax marker", () => {
    const unmarked: PrThread = {
      ...thread("f-c", "src/c.ts", "x"),
      comments: [{ id: "c", kind: "thread", author: "bot", createdAt: "2026-11-27T00:00:00Z", body: "plain" }],
    };
    expect(openFindings([thread("f-d", undefined, "no path"), unmarked])).toEqual([]);
  });
});

describe("unrecordedPushes", () => {
  const open = [
    { key: "f-a", path: "src/a.ts", issue: "lock leaks", generation: 1 },
    { key: "f-b", path: "src/b.ts", issue: "name unclear", generation: 0 },
  ];

  test("derives an entry for a commit that touches an open finding's file", async () => {
    const git = fakeGit({
      [REV_LIST]: { stdout: `${C1} ${P1}\n` },
      [files(C1)]: { stdout: "src/a.ts\0docs/x.md\0" },
    });
    const result = await unrecordedPushes(
      { worktree: "/w", rangeBase: RANGE, head: HEAD, recorded: [], open },
      git.deps,
    );
    expect(result).toEqual([
      { base: P1, sha: C1, at: "", unrecorded: true, items: [{ key: "f-a", generation: 1, issue: "lock leaks" }] },
    ]);
  });

  test("derives nothing for a commit that touches no open finding's file", async () => {
    const git = fakeGit({
      [REV_LIST]: { stdout: `${C1} ${P1}\n` },
      [files(C1)]: { stdout: "src/new-feature.ts\0" },
    });
    expect(
      await unrecordedPushes({ worktree: "/w", rangeBase: RANGE, head: HEAD, recorded: [], open }, git.deps),
    ).toEqual([]);
  });

  test("skips a commit a recorded bot push already covers", async () => {
    const recorded: BotPushEntry[] = [{ base: P2, sha: C2, at: "", items: [] }];
    const git = fakeGit({
      [REV_LIST]: { stdout: `${C1} ${P1}\n${C2} ${P2}\n` },
      [`rev-list ${P2}..${C2}`]: { stdout: `${C2}\n` },
      [files(C1)]: { stdout: "src/b.ts\0" },
    });
    const result = await unrecordedPushes({ worktree: "/w", rangeBase: RANGE, head: HEAD, recorded, open }, git.deps);
    expect(result.map(({ sha }) => sha)).toEqual([C1]);
    expect(git.calls).not.toContain(files(C2));
  });

  test("asks git nothing when no finding is open", async () => {
    const git = fakeGit({});
    expect(
      await unrecordedPushes({ worktree: "/w", rangeBase: RANGE, head: HEAD, recorded: [], open: [] }, git.deps),
    ).toEqual([]);
    expect(git.calls).toEqual([]);
  });

  test.each([
    ["a non-zero exit", { [REV_LIST]: { stdout: "", exitCode: 128 } }],
    ["a failed file listing", { [REV_LIST]: { stdout: `${C1} ${P1}\n` }, [files(C1)]: { stdout: "", exitCode: 128 } }],
  ])("derives nothing after %s", async (_name, answers) => {
    const git = fakeGit(answers);
    expect(
      await unrecordedPushes({ worktree: "/w", rangeBase: RANGE, head: HEAD, recorded: [], open }, git.deps),
    ).toEqual([]);
  });
});

describe("unrecordedPushes with an unreachable recorded push (#3069 review)", () => {
  test("skips the recorded push it cannot expand and still derives the rest", async () => {
    const recorded: BotPushEntry[] = [{ base: P2, sha: C2, at: "", items: [] }];
    const git = fakeGit({
      [REV_LIST]: { stdout: `${C1} ${P1}\n` },
      [`rev-list ${P2}..${C2}`]: { stdout: "", exitCode: 128 },
      [files(C1)]: { stdout: "src/a.ts\0" },
    });
    const open = [{ key: "f-a", path: "src/a.ts", issue: "lock leaks", generation: 1 }];
    const result = await unrecordedPushes({ worktree: "/w", rangeBase: RANGE, head: HEAD, recorded, open }, git.deps);
    expect(result.map(({ sha }) => sha)).toEqual([C1]);
  });
});

describe("answerableThreads (#3069 review)", () => {
  const resolved: PrThread = { ...thread("f-r", "src/r.ts", "x"), resolved: true };
  const settled = thread("f-s", "src/s.ts", "y");
  const open = thread("f-o", "src/o.ts", "z");
  test("keeps resolved threads and drops settled ones on a trusted pull request", () => {
    expect(answerableThreads([resolved, settled, open], new Set([settled.id]), false).map(({ id }) => id)).toEqual([
      resolved.id,
      open.id,
    ]);
  });
  test("answers nothing on an untrusted pull request", () => {
    expect(answerableThreads([resolved, open], new Set(), true)).toEqual([]);
  });
});
