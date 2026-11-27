import { afterEach, describe, expect, mock, test } from "bun:test";
import type { BotPushEntry } from "@/bot/push-ledger";
import { reviewPushFacts } from "@/bot/review-convergence";
import { _unrecordedPushDeps } from "@/bot/unrecorded-pushes";
import { type PrThread, withNaxBotMarker } from "@/forge";

const original = { ..._unrecordedPushDeps };
afterEach(() => {
  Object.assign(_unrecordedPushDeps, original);
});

const RANGE = "r".repeat(40);
const HEAD = "h".repeat(40);
const COMMIT = "1".repeat(40);
const PARENT = "a".repeat(40);
const open: PrThread = {
  id: "t",
  replyTo: "r",
  path: "src/a.ts",
  line: 3,
  resolved: false,
  outdated: false,
  comments: [
    {
      id: "c",
      kind: "thread",
      author: "bot",
      createdAt: "2026-11-27T00:00:00Z",
      body: withNaxBotMarker("Important: the lock leaks", "f-a"),
    },
  ],
};

function stubGit(): ReturnType<typeof mock> {
  const runGit = mock(async (args: string[]) => {
    if (args[0] === "rev-list") return { stdout: `${COMMIT} ${PARENT}\n`, stderr: "", exitCode: 0 };
    if (args[0] === "diff-tree") return { stdout: "src/a.ts\0", stderr: "", exitCode: 0 };
    // The only other question asked here: is the derived commit inside the range? Yes for HEAD, no for the base.
    return { stdout: "", stderr: "", exitCode: args.at(-1) === HEAD ? 0 : 1 };
  });
  _unrecordedPushDeps.runGit = runGit;
  return runGit;
}

const isAncestor = async (_dir: string, ancestor: string, head: string) => ancestor === COMMIT && head === HEAD;

describe("reviewPushFacts unrecorded pushes (#3069)", () => {
  test("lists a derived push in the prompt and hands it to the post node", async () => {
    stubGit();
    const facts = await reviewPushFacts({
      own: [],
      worktree: "/w",
      head: HEAD,
      rangeBase: RANGE,
      isAncestor,
      earlier: [open],
    });
    const derived: BotPushEntry = {
      base: PARENT,
      sha: COMMIT,
      at: "",
      unrecorded: true,
      items: [{ key: "f-a", generation: 0, issue: "Important: the lock leaks" }],
    };
    expect(facts.prompt.botPushes).toEqual([derived]);
    expect(facts.post.botPushes).toEqual([derived]);
  });

  test("derives nothing for a full review", async () => {
    const runGit = stubGit();
    const facts = await reviewPushFacts({ own: [], worktree: "/w", head: HEAD, isAncestor, earlier: [open] });
    expect(facts).toEqual({ prompt: {}, post: {} });
    expect(runGit).not.toHaveBeenCalled();
  });
});
