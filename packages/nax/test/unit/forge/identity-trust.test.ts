/**
 * Forge identity checks driven by the injected identity (US-003).
 *
 * Every case here runs the real readers — `readCurrentUser`, `classifyPrTrust`,
 * `listReviewThreads`, `findOwnComments` — over fake `ForgeDeps` replies, so the
 * assertions cover the wiring a caller gets rather than a helper in isolation.
 * The token is the one the whole feature uses; nothing asserts on its presence
 * in argv, because it must never appear there.
 */

import { describe, expect, test } from "bun:test";
import { assertNaxError } from "@test/helpers";
import { NaxError } from "@/errors";
import {
  classifyPrTrust,
  type ForgeDeps,
  type ForgeRunResult,
  findOwnComments,
  type InjectedForgeIdentity,
  listReviewThreads,
  type PrInfo,
  type PrRef,
  readCurrentUser,
} from "@/forge";

const TOKEN = "tok-7f3a9c";
const LOGIN = "acme-bot[bot]";

const gh: PrRef = { forge: "github", host: "github.example.com", repo: "acme/widgets", number: 7 };
const gl: PrRef = { forge: "gitlab", host: "gitlab.example.com", repo: "group/sub/widgets", number: 7 };

const info: PrInfo = {
  number: 7,
  title: "Title",
  body: "Body",
  url: "url",
  state: "open",
  draft: false,
  author: { login: "alice" },
  baseRef: "main",
  headRef: "feature",
  headSha: "abc123",
  crossRepo: false,
};

const ok = (reply: unknown): ForgeRunResult => ({ exitCode: 0, stdout: JSON.stringify(reply), stderr: "" });
const trustOf = (trusted: boolean, reason: string) => ({ trusted, headSha: info.headSha, reasons: [reason] });
const marker = (key: string) => `<!-- nax-bot:v1 key=${key} -->`;

interface Harness {
  deps: ForgeDeps;
  calls: string[][];
}

/**
 * A `ForgeDeps` whose `run` replays `replies` in order. Omitting `identity`
 * leaves the member off entirely, which is how a fake written before this
 * feature looks.
 */
function harness(options: { identity?: InjectedForgeIdentity; replies?: ForgeRunResult[] } = {}): Harness {
  const calls: string[][] = [];
  const replies = [...(options.replies ?? [])];
  const base: ForgeDeps = {
    run: async (cmd, opts) => {
      expect(opts.cwd).toBe("/repo");
      calls.push(cmd);
      const reply = replies.shift();
      if (reply === undefined) throw new TypeError(`[test] unexpected forge call: ${cmd.join(" ")}`);
      return reply;
    },
    readText: async () => null,
  };
  const { identity } = options;
  return { deps: identity === undefined ? base : { ...base, identity: () => identity }, calls };
}

/** Await a rejection and narrow it to a `NaxError`. */
async function rejection(run: Promise<unknown>): Promise<NaxError> {
  let caught: unknown;
  try {
    await run;
  } catch (err) {
    caught = err;
  }
  assertNaxError(caught, "readCurrentUser rejection");
  return caught;
}

describe("readCurrentUser with an injected identity", () => {
  test("AC-1 returns the injected login without asking the forge who it is", async () => {
    const { deps, calls } = harness({ identity: { token: TOKEN, login: LOGIN } });

    const user = await readCurrentUser(gh, deps, "/repo");

    expect(user).toEqual({ login: LOGIN });
    expect(Object.hasOwn(user, "id")).toBe(false);
    expect(calls).toEqual([]);
  });

  test("AC-2 carries the injected account id", async () => {
    const { deps, calls } = harness({ identity: { token: TOKEN, login: LOGIN, id: 42 } });

    expect(await readCurrentUser(gh, deps, "/repo")).toEqual({ login: LOGIN, id: 42 });
    expect(calls).toEqual([]);
  });

  test("AC-3 a GitHub ref with a token but no login fails closed without running a command", async () => {
    const { deps, calls } = harness({ identity: { token: TOKEN } });

    const error = await rejection(readCurrentUser(gh, deps, "/repo"));

    expect(error).toBeInstanceOf(NaxError);
    expect(error.code).toBe("FORGE_IDENTITY_LOGIN_REQUIRED");
    expect(error.message).toBe("[forge] NAX_FORGE_LOGIN is required with NAX_FORGE_TOKEN_FILE on GitHub");
    expect(calls).toEqual([]);
  });

  test("AC-4 a GitLab ref with a token but no login still asks the token's own user", async () => {
    const { deps, calls } = harness({
      identity: { token: TOKEN },
      replies: [ok({ username: "acme-bot", id: 9 })],
    });

    expect(await readCurrentUser(gl, deps, "/repo")).toEqual({ login: "acme-bot", id: 9 });
    expect(calls).toEqual([["glab", "api", "--hostname", gl.host, "user"]]);
    expect(calls[0]).not.toContain(TOKEN);
  });

  test("AC-5 a deps without an identity member reads the api user, as before this feature", async () => {
    const { deps, calls } = harness({ replies: [ok({ login: "alice" })] });

    expect(Object.hasOwn(deps, "identity")).toBe(false);
    expect(await readCurrentUser(gh, deps, "/repo")).toEqual({ login: "alice" });
    expect(calls).toEqual([["gh", "api", "--hostname", gh.host, "user"]]);
  });

  test("an identity accessor that returns undefined is the same as no identity", async () => {
    const { deps, calls } = harness({ identity: undefined, replies: [ok({ username: "alice", id: 3 })] });

    expect(await readCurrentUser(gl, { ...deps, identity: () => undefined }, "/repo")).toEqual({
      login: "alice",
      id: 3,
    });
    expect(calls).toEqual([["glab", "api", "--hostname", gl.host, "user"]]);
  });
});

describe("classifyPrTrust with an injected identity", () => {
  test("AC-6 a PR authored by the injected login is the current user", async () => {
    const { deps, calls } = harness({ identity: { token: TOKEN, login: LOGIN } });

    const trust = await classifyPrTrust(gh, { ...info, author: { login: LOGIN } }, deps, "/repo");

    expect(trust).toEqual(trustOf(true, "author is the current user"));
    expect(calls).toEqual([]);
  });

  test("AC-7 a different author falls through to the write-access check", async () => {
    const { deps, calls } = harness({
      identity: { token: TOKEN, login: LOGIN },
      replies: [ok({ permission: "write" })],
    });

    const trust = await classifyPrTrust(gh, { ...info, author: { login: "alice" } }, deps, "/repo");

    expect(trust).toEqual(trustOf(true, "author has write access"));
    expect(calls).toEqual([["gh", "api", "--hostname", gh.host, "repos/acme/widgets/collaborators/alice/permission"]]);
  });

  test("AC-8 a GitHub PR with a token and no login is untrusted, naming the missing login", async () => {
    const { deps, calls } = harness({ identity: { token: TOKEN } });

    const trust = await classifyPrTrust(gh, info, deps, "/repo");

    expect(trust.trusted).toBe(false);
    expect(trust.headSha).toBe(info.headSha);
    expect(trust.reasons).toHaveLength(1);
    expect(trust.reasons[0]).toContain("NAX_FORGE_LOGIN is required");
    expect(calls).toEqual([]);
  });

  test("the injected account id still decides identity when the logins differ", async () => {
    const { deps, calls } = harness({ identity: { token: TOKEN, login: LOGIN, id: 42 } });

    const trust = await classifyPrTrust(gh, { ...info, author: { login: "renamed", id: 42 } }, deps, "/repo");

    expect(trust).toEqual(trustOf(true, "author is the current user"));
    expect(calls).toEqual([]);
  });

  test("a GitLab PR with only a token keeps asking glab who the token is", async () => {
    const { deps, calls } = harness({
      identity: { token: TOKEN },
      replies: [ok({ username: "acme-bot", id: 7 })],
    });

    const trust = await classifyPrTrust(gl, { ...info, author: { login: "acme-bot", id: 7 } }, deps, "/repo");

    expect(trust).toEqual(trustOf(true, "author is the current user"));
    expect(calls).toEqual([["glab", "api", "--hostname", gl.host, "user"]]);
  });
});

interface GhNode {
  author: { login: string; __typename?: string } | null;
  body?: string;
}

const ghPage = (nodes: GhNode[]) => ({
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: nodes.map((node, i) => ({
            id: `T${i + 1}`,
            isResolved: false,
            isOutdated: false,
            path: "src/a.ts",
            line: 3,
            originalLine: null,
            comments: {
              pageInfo: { hasNextPage: false },
              nodes: [{ databaseId: 70 + i, author: node.author, body: node.body ?? "note", createdAt: "today" }],
            },
          })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  },
});

/** Read thread authors from a GitHub ref through the real reader. */
async function ghAuthors(nodes: GhNode[], identity?: InjectedForgeIdentity) {
  const { deps, calls } = harness({ identity, replies: [ok(ghPage(nodes))] });
  const threads = await listReviewThreads(gh, deps, "/repo");
  return { authors: threads.flatMap((thread) => thread.comments.map((comment) => comment.author)), calls };
}

describe("GitHub review-thread authors", () => {
  test("AC-9 the GraphQL query asks for the comment author's __typename", async () => {
    const { calls } = await ghAuthors([{ author: { login: "alice" } }]);

    const query = calls[0]?.find((arg) => arg.startsWith("query="));
    expect(query).toContain("author { login __typename }");
  });

  test("AC-10 a Bot author is reported in the REST [bot] form", async () => {
    const { authors } = await ghAuthors([{ author: { login: "acme-bot", __typename: "Bot" } }]);

    expect(authors).toEqual([`${LOGIN}`]);
  });

  test("AC-11 a User author keeps its login unchanged", async () => {
    const { authors } = await ghAuthors([{ author: { login: "acme-bot", __typename: "User" } }]);

    expect(authors).toEqual(["acme-bot"]);
  });

  test("a reply without __typename (older replies, fakes) keeps the login unchanged", async () => {
    const { authors } = await ghAuthors([{ author: { login: "acme-bot" } }, { author: null }]);

    expect(authors).toEqual(["acme-bot", "ghost"]);
  });
});

interface GhApiHarness {
  deps: ForgeDeps;
  endpoints: string[];
}

/** GitHub REST/GraphQL fake keyed by the endpoint the reader requests. */
function ghApi(identity: InjectedForgeIdentity, replies: Record<string, unknown>): GhApiHarness {
  const endpoints: string[] = [];
  const deps: ForgeDeps = {
    identity: () => identity,
    readText: async () => null,
    run: async (argv, opts) => {
      expect(opts.cwd).toBe("/repo");
      expect(argv.slice(0, 4)).toEqual(["gh", "api", "--hostname", gh.host]);
      const endpoint = argv[4] ?? "";
      endpoints.push(endpoint);
      const reply = replies[endpoint];
      if (reply === undefined) throw new TypeError(`[test] unexpected forge call: ${endpoint}`);
      return ok(reply);
    },
  };
  return { deps, endpoints };
}

describe("findOwnComments with an injected identity", () => {
  const ownThreads = ghPage([
    { author: { login: "acme-bot", __typename: "Bot" }, body: marker("thread:bot") },
    { author: { login: "acme-bot", __typename: "User" }, body: marker("thread:human") },
  ]);

  test("AC-12 only the Bot-authored thread comment belongs to the injected login", async () => {
    const { deps, endpoints } = ghApi(
      { token: TOKEN, login: LOGIN },
      {
        graphql: ownThreads,
        "repos/acme/widgets/issues/7/comments?per_page=100&page=1": [],
        "repos/acme/widgets/pulls/7/reviews?per_page=100&page=1": [],
      },
    );

    const own = await findOwnComments(gh, deps, "/repo");

    expect(own.map(({ comment, key, threadId }) => ({ id: comment.id, key, threadId }))).toEqual([
      { id: "70", key: "thread:bot", threadId: "T1" },
    ]);
    expect(own[0]?.comment.author).toBe(LOGIN);
    // The injected login replaces the `api user` round-trip the reader used to make.
    expect(endpoints).not.toContain("user");
  });
});
