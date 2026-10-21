import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _postDeps, type BotReviewArtifact, type PostReviewInput, postPrReview } from "@/bot/post";
import { type PrThread, withNaxBotMarker } from "@/forge";
import { readItemThreads, settleItemThreads } from "@/workflow/item-thread-state";
import { itemKey, renderItemIndex, renderItemOpener, renderRulingEcho } from "@/workflow/item-threads";

const original = { ..._postDeps };
const item = { id: "F-1", kind: "finding", issue: "Leaking resource", suggestion: "Close it" } as const;
const key = itemKey(item);
const opener = {
  id: "opener",
  kind: "thread",
  author: "bot",
  body: withNaxBotMarker(renderItemOpener(item), key),
  createdAt: "",
} as const;
const thread: PrThread = {
  id: "T",
  replyTo: "1",
  resolved: false,
  outdated: false,
  path: "a.ts",
  line: 2,
  comments: [opener, { ...opener, id: "human", author: "writer", body: "I disagree" }],
};
const run = mock(async (_argv: string[], _opts: { cwd: string }) => ({ exitCode: 0, stdout: '{"id":42}', stderr: "" }));
let artifact: BotReviewArtifact | undefined;
let input: PostReviewInput;
const bodies = () =>
  run.mock.calls.flatMap(([argv]) => argv.filter((arg) => arg.startsWith("body=")).map((arg) => arg.slice(5)));
const resolved = () => run.mock.calls.some(([argv]) => argv.some((arg) => arg.includes("resolveReviewThread")));

beforeEach(() => {
  artifact = undefined;
  run.mockClear();
  _postDeps.writeArtifact = async (_path, value) => {
    artifact = value;
    return 0;
  };
  input = {
    ref: { forge: "github", host: "test", repo: "o/r", number: 7 },
    info: {
      number: 7,
      title: "PR",
      body: "",
      url: "",
      state: "open",
      draft: true,
      author: { login: "a" },
      baseRef: "main",
      headRef: "topic",
      headSha: "abcdef1234567890",
      crossRepo: false,
    },
    verdict: {
      intent: "pass",
      quality: "approved",
      findings: [],
      threads: [],
      comments: [],
      cannotVerify: [],
      inspectedFiles: [],
    },
    threads: [],
    comments: [],
    own: [],
    login: "bot",
    staticMode: false,
    sensitive: [],
    stateDir: "/unused",
    deps: { run, readText: async () => null },
    cwd: "/repo",
  };
});
afterEach(() => Object.assign(_postDeps, original));

async function post(status: "fixed" | "withdrawn" | "open", extra = {}) {
  await postPrReview({
    ...input,
    ...extra,
    itemEarlier: [thread],
    verdict: { ...input.verdict, earlier: [{ id: thread.id, status, reason: "Verified in head" }] },
  });
}

describe("postPrReview item rulings", () => {
  test("AC-10 fixed item echoes bot fixed at the reviewed head and resolves once despite duplicate input", async () => {
    await post("fixed", { earlier: [thread] });
    expect(bodies()).toContain(
      withNaxBotMarker(
        renderRulingEcho({
          itemKey: key,
          itemId: item.id,
          disposition: "fixed",
          reason: "Verified in head",
          by: null,
          sha: input.info.headSha,
        }),
        `wr-fixed-${key}`,
      ),
    );
    expect(bodies().join("\n")).toContain("fixed in abcdef1");
    expect(resolved()).toBe(true);
    expect(run.mock.calls.filter(([argv]) => argv.some((arg) => arg.includes("resolveReviewThread")))).toHaveLength(1);
  });
  test("AC-11 withdrawn item posts plain earlier reply but never resolves", async () => {
    await post("withdrawn");
    expect(bodies().join("\n")).toContain("Verified in head");
    expect(bodies().join("\n")).toContain("key=e-");
    expect(bodies().join("\n")).not.toContain("wr-");
    expect(resolved()).toBe(false);
  });
  test("AC-12 open item persists only the first content line under its item key", async () => {
    await post("open");
    expect(artifact?.agreed).toEqual([
      {
        kind: "finding",
        key,
        issue: "Open item **F-1** (finding): Leaking resource",
        severity: "important",
        file: "a.ts",
        line: 2,
      },
    ]);
    expect(JSON.stringify(artifact?.agreed)).not.toContain("Rule on it");
    expect(JSON.stringify(artifact?.agreed)).not.toContain("nax bot");
  });
  test("AC-13 withdrawn item emits no withdrawal event", async () => {
    await post("withdrawn", { earlier: [thread] });
    expect(artifact?.events).toEqual([]);
  });
  test("AC-14 carries ruling counts without changing artifact version", async () => {
    await post("open", { rulings: { recorded: 2, open: 3, asked: 1 } });
    expect(artifact).toMatchObject({ version: 2, rulings: { recorded: 2, open: 3, asked: 1 } });
  });
  test("AC-16 preserves all f- withdrawal event fields alongside a withdrawn w- thread", async () => {
    const finding = {
      ...thread,
      id: "F",
      comments: [{ ...opener, body: withNaxBotMarker("**Important** leak", "f-existing") }, thread.comments[1]],
    };
    await postPrReview({
      ...input,
      earlier: [finding, thread],
      verdict: {
        ...input.verdict,
        earlier: [
          { id: "F", status: "withdrawn", reason: "Not a bug" },
          { id: "T", status: "withdrawn", reason: "Not a bug" },
        ],
      },
    });
    expect(artifact?.events).toEqual([
      {
        type: "finding-withdrawn",
        key: "f-existing",
        threadId: "F",
        file: "a.ts",
        line: 2,
        finding: "**Important** leak",
        reason: "Not a bug",
        disagreedBy: ["writer"],
      },
    ]);
  });
});

test("fixed review of a reopened workflow item appends an echo that actually settles it", async () => {
  const old = {
    ...opener,
    id: "old",
    body: withNaxBotMarker(
      renderRulingEcho({
        itemKey: key,
        itemId: item.id,
        disposition: "fixed",
        sha: "abcdef1",
        reason: "old",
        by: null,
      }),
      `wr-fixed-${key}`,
    ),
  };
  const reopened = {
    ...thread,
    comments: [opener, old, { ...opener, id: "writer", author: "writer", body: "reconsider" }],
  };
  await postPrReview({
    ...input,
    itemEarlier: [reopened],
    verdict: { ...input.verdict, earlier: [{ id: thread.id, status: "fixed", reason: "new fix" }] },
  });
  const body = bodies().find((body) => body.includes(`key=wr-fixed-${key}`));
  expect(body).toContain("new fix");
  expect(run.mock.calls.some(([argv]) => argv.includes("PATCH"))).toBe(false);
  if (!body) throw new Error("no echo");
  const after = { ...reopened, comments: [...reopened.comments, { ...opener, id: "new", body }] };
  const index = {
    ...opener,
    kind: "comment" as const,
    body: withNaxBotMarker(renderItemIndex({ keys: [key] }), "w-index"),
  };
  const settled = await settleItemThreads(readItemThreads([after], [index], "bot"), async () => true);
  expect(settled.open).toHaveLength(0);
  expect(settled.settled).toHaveLength(1);
});
