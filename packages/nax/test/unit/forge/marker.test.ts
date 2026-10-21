import { describe, expect, test } from "bun:test";
import { NaxError } from "@/errors";
import type { ForgeDeps, PrRef } from "@/forge";
import * as forge from "@/forge";

const ref: PrRef = { forge: "github", host: "github.example.com", repo: "acme/widgets", number: 5 };
const marker = (key: string) => `<!-- nax-bot:v1 key=${key} -->`;
const topEndpoint = "repos/acme/widgets/issues/5/comments?per_page=100&page=1";
const reviewEndpoint = "repos/acme/widgets/pulls/5/reviews?per_page=100&page=1";

function harness(failEndpoint?: string) {
  const calls: string[] = [];
  const comment = (id: number, author: string, body: string) => ({
    databaseId: id,
    author: { login: author },
    body,
    createdAt: "today",
  });
  const thread = (id: string, nodes: ReturnType<typeof comment>[]) => ({
    id,
    isResolved: false,
    isOutdated: false,
    comments: { nodes },
  });
  const replies: Record<string, unknown> = {
    user: { login: "alice", id: 1 },
    graphql: {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                thread("T1", [
                  comment(11, "alice", marker("thread:1")),
                  comment(12, "mallory", marker("forged")),
                  comment(13, "alice", "unmarked"),
                  comment(14, "alice", marker("thread:2")),
                ]),
                thread("T2", [comment(21, "alice", marker("thread:3"))]),
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    },
    [topEndpoint]: [
      { id: 31, user: { login: "alice" }, body: marker("top:1"), created_at: "today" },
      { id: 32, user: { login: "mallory" }, body: marker("forged-top"), created_at: "today" },
      { id: 33, user: { login: "alice" }, body: "unmarked", created_at: "today" },
    ],
    [reviewEndpoint]: [],
  };
  const deps: ForgeDeps = {
    readText: async () => null,
    run: async (argv, opts) => {
      expect(opts.cwd).toBe("/repo");
      expect(argv.slice(0, 4)).toEqual(["gh", "api", "--hostname", ref.host]);
      const endpoint = argv[4] ?? "";
      calls.push(endpoint);
      if (endpoint === failEndpoint) return { exitCode: 1, stdout: "", stderr: "denied" };
      expect(replies).toHaveProperty(endpoint);
      return { exitCode: 0, stdout: JSON.stringify(replies[endpoint]), stderr: "" };
    },
  };
  return { calls, deps };
}

describe("NAX_BOT_HEADER", () => {
  test("AC-4 stable header", () => expect(forge.NAX_BOT_HEADER).toBe("**nax bot**"));
});

describe("hasNaxWorkflowMarker", () => {
  test("AC-1 recognizes the workflow marker line", () => {
    expect(forge.hasNaxWorkflowMarker("<!-- nax-workflow:v1 -->\n\n## Summary")).toBe(true);
  });

  test("AC-2 returns false when the body has no workflow marker", () => {
    expect(forge.hasNaxWorkflowMarker("## Summary\n\nno marker")).toBe(false);
  });
});
describe("withNaxBotMarker", () => {
  test("AC-1 exact marker wrapper", () => {
    expect(forge.withNaxBotMarker("hello", "finding:a1")).toBe(
      "**nax bot**\n\nhello\n\n<!-- nax-bot:v1 key=finding:a1 -->",
    );
  });
  test.each([
    ["AC-2", "a-->b"],
    ["AC-3", ""],
    ["length", "a".repeat(129)],
    ["whitespace", "bad key"],
    ["newline", "a\n"],
    ["unicode", "é"],
  ])("%s rejects invalid key", (_, key) => {
    expect(() => forge.withNaxBotMarker("x", key)).toThrow(NaxError);
    expect(() => forge.withNaxBotMarker("x", key)).toThrow(
      expect.objectContaining({
        code: "FORGE_MARKER_KEY_INVALID",
        context: expect.objectContaining({ stage: "forge" }),
      }),
    );
  });
  test.each(["a", "a".repeat(128), "AZaz09._:-"])("accepts valid boundary key %s", (key) => {
    expect(forge.withNaxBotMarker("", key)).toBe(`**nax bot**\n\n\n\n${marker(key)}`);
  });
});
describe("parseNaxBotMarker", () => {
  test.each([
    ["AC-5", `${marker("k1")}\n${marker("k2")}`, { key: "k2" }],
    ["AC-6", "no marker", null],
    ["AC-7", marker("bad key"), null],
    ["last valid", `${marker("k1")}\n${marker("bad key")}`, { key: "k1" }],
    ["oversized", marker("a".repeat(129)), null],
    ["empty", marker(""), null],
    ["version", "<!-- nax-bot:v2 key=k -->", null],
  ])("%s parses only valid markers", (_, body, expected) => {
    expect(forge.parseNaxBotMarker(body)).toEqual(expected);
  });
  test("AC-8 round trip", () => {
    expect(forge.parseNaxBotMarker(forge.withNaxBotMarker("hello", "finding:a1"))).toEqual({ key: "finding:a1" });
  });
});
describe("findOwnComments", () => {
  test("AC-9 AC-10 AC-11 reads identity, threads, then top-level endpoints", async () => {
    const h = harness();
    await forge.findOwnComments(ref, h.deps, "/repo");
    expect(h.calls).toEqual(["user", "graphql", topEndpoint, reviewEndpoint]);
  });
  test("AC-12 AC-13 AC-14 only marked comments authored by the authenticated login", async () => {
    const result = await forge.findOwnComments(ref, harness().deps, "/repo");
    expect(result.map((own) => own.comment.id)).toEqual(["11", "14", "21", "31"]);
    expect(result.every((own) => own.comment.author === "alice")).toBe(true);
  });
  test("AC-15 AC-16 AC-17 AC-18 keys, thread association and thread-first ordering", async () => {
    const result = await forge.findOwnComments(ref, harness().deps, "/repo");
    expect(result.map(({ key, threadId }) => ({ key, threadId }))).toEqual([
      { key: "thread:1", threadId: "T1" },
      { key: "thread:2", threadId: "T1" },
      { key: "thread:3", threadId: "T2" },
      { key: "top:1", threadId: undefined },
    ]);
    expect(result[3]).not.toHaveProperty("threadId");
    expect(result[0]?.comment).toEqual({
      id: "11",
      kind: "thread",
      author: "alice",
      body: marker("thread:1"),
      createdAt: "today",
    });
  });
  test.each([
    ["AC-19", "user", "FORGE_USER_READ_FAILED", 1],
    ["thread failure", "graphql", "FORGE_THREADS_READ_FAILED", 2],
    ["comments failure", topEndpoint, "FORGE_COMMENTS_READ_FAILED", 3],
  ])("%s propagates reader failure and stops subsequent reads", async (_, endpoint, code, count) => {
    const h = harness(endpoint);
    await expect(forge.findOwnComments(ref, h.deps, "/repo")).rejects.toMatchObject({
      code,
      context: { stage: "forge" },
    });
    expect(h.calls).toHaveLength(count);
  });
});
