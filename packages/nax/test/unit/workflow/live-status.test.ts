import { describe, expect, test } from "bun:test";
import { type ForgeDeps, withNaxBotMarker } from "@/forge";
import { itemKey, renderItemIndex, renderItemOpener, renderRulingEcho } from "@/workflow/item-threads";
import type { LiveStatus } from "@/workflow/live-status";
import type { OpenItem } from "@/workflow/types";

const item: OpenItem = { id: "D-1", kind: "advisor", issue: "needs a change" };
const url = "https://github.com/o/r/pull/7";
const cwd = "/fake/repository";
type Options = {
  item?: OpenItem;
  echo?: "fixed" | "confirmed" | false;
  fix?: boolean;
  reply?: boolean;
  permission?: "read" | "write" | "throws";
  index?: "missing" | "empty";
  fail?: "resolve" | "user" | "threads" | "comments" | "reviews" | "state";
  throws?: boolean;
  undetected?: boolean;
  isDraft?: boolean;
};

function readStage(argv: readonly string[]): Options["fail"] | "other" {
  const endpoint = argv.at(-1) ?? "";
  if (argv[0] === "git") return "resolve";
  if (argv.includes("view")) return "state";
  if (argv.includes("graphql")) return "threads";
  if (endpoint === "user") return "user";
  if (endpoint.includes("/issues/7/comments?")) return "comments";
  if (endpoint.includes("/reviews?")) return "reviews";
  return "other";
}

function indexComments(key: string, mode: Options["index"]) {
  if (mode === "missing") return [];
  return [
    {
      id: 9,
      user: { login: "nax" },
      created_at: "2026-10-13T09:12:00Z",
      body: withNaxBotMarker(renderItemIndex({ keys: mode === "empty" ? [] : [key] }), "w-index"),
    },
  ];
}

function fixture(options: Options = {}) {
  const published = options.item ?? item;
  const key = itemKey(published);
  const calls: string[][] = [];
  const mutations: string[][] = [];
  const comment = (body: string, login = "nax") => ({
    databaseId: 1,
    author: { login },
    body,
    createdAt: "2026-10-13T09:12:00Z",
  });
  const echo = options.echo ?? "fixed";
  const comments = [comment(withNaxBotMarker(renderItemOpener(published), key))];
  if (echo)
    comments.push(
      comment(
        withNaxBotMarker(
          renderRulingEcho({
            itemKey: key,
            itemId: published.id,
            disposition: echo,
            reason: "addressed",
            sha: "abcdef1",
            by: "alice",
          }),
          `wr-${echo}-${key}`,
        ),
      ),
    );
  if (options.fix) comments.push(comment(withNaxBotMarker("Fixed in abcdef1", `fix-${key}`)));
  if (options.reply) comments.push(comment("please reconsider", "bob"));
  const nodes = [
    {
      id: "thread-1",
      isResolved: true,
      isOutdated: false,
      path: "a.ts",
      line: 1,
      originalLine: 1,
      comments: { nodes: comments },
    },
  ];
  const ok = (data: unknown) => ({ exitCode: 0, stdout: JSON.stringify(data), stderr: "" });
  function answer(argv: readonly string[], stage: ReturnType<typeof readStage>) {
    if (stage === "resolve")
      return {
        exitCode: 0,
        stdout: options.undetected ? "git@unknown.test:o/r.git" : "git@github.com:o/r.git",
        stderr: "",
      };
    if (argv.includes("--version")) return { exitCode: 1, stdout: "", stderr: "not installed" };
    if (stage === "state") return ok({ isDraft: options.isDraft ?? false, body: "" });
    if (stage === "user") return ok({ login: "nax", id: 1 });
    if (stage === "threads")
      return ok({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        },
      });
    if (stage === "comments") return ok(indexComments(key, options.index));
    if (stage === "reviews") return ok([]);
    throw new Error(`unexpected argv: ${argv.join(" ")}`);
  }
  const deps: ForgeDeps = {
    readText: async () => null,
    run: async (argv) => {
      calls.push(argv);
      if (
        argv.some((arg) => /mutation\b|POST|PATCH|PUT|DELETE|resolveReviewThread|addComment/.test(arg)) ||
        argv.some((arg) => ["edit", "comment", "ready"].includes(arg))
      ) {
        mutations.push(argv);
        throw new Error("mutation attempted");
      }
      const endpoint = argv.at(-1) ?? "";
      const stage = readStage(argv);
      if (stage === options.fail) {
        if (options.throws) throw new Error(`${stage} offline`);
        return { exitCode: 1, stdout: "", stderr: `${stage} offline` };
      }
      if (endpoint.endsWith("/permission")) {
        if (options.permission === "throws") throw new Error("permission offline");
        return ok({ permission: options.permission ?? "read" });
      }
      return answer(argv, stage);
    },
  };
  return { deps, calls, mutations };
}

// Import per case so the initial RED run reports every criterion before the module exists.
async function read(options: Options = {}, items: readonly OpenItem[] = [item]) {
  const fx = fixture(options);
  const { readLiveStatus } = await import("@/workflow/live-status");
  return { ...fx, result: await readLiveStatus({ url, cwd, deps: fx.deps, items }) };
}
const live = (
  settled: readonly { id: string; disposition: string }[] = [],
  awaitingFix: readonly string[] = [],
): Extract<LiveStatus, { source: "live" }> => ({
  source: "live",
  isDraft: false,
  settled,
  awaitingFix,
});

describe("readLiveStatus", () => {
  test("AC-1: returns non-draft live fixed ruling", async () => {
    expect((await read()).result).toEqual(live([{ id: "D-1", disposition: "fixed" }]));
  });
  test("AC-2: leaves an unruled thread open", async () => {
    expect((await read({ echo: false })).result).toEqual(live());
  });
  test("AC-3: confirmed advisor awaits a fix", async () => {
    expect((await read({ echo: "confirmed" })).result).toEqual(live([], ["D-1"]));
  });
  test("AC-4: own fix closes confirmed advisor", async () => {
    expect((await read({ echo: "confirmed", fix: true })).result).toEqual(
      live([{ id: "D-1", disposition: "confirmed" }]),
    );
  });
  test.each([
    { ac: 5, permission: "read", settled: true },
    { ac: 6, permission: "write", settled: false },
  ] as const)("AC-$ac: $permission reply settlement", async ({ permission, settled }) => {
    const fx = await read({ reply: true, permission });
    expect(fx.result).toEqual(live(settled ? [{ id: "D-1", disposition: "fixed" }] : []));
    expect(fx.calls.some((argv) => argv.at(-1)?.endsWith("/bob/permission"))).toBe(true);
  });
  test("AC-7: ignores unindexed thread", async () => {
    expect((await read({ index: "empty" })).result).toEqual(live());
  });
  test("AC-8: matches by id despite kind and issue drift", async () => {
    const changed: OpenItem = { ...item, kind: "finding", issue: "different" };
    expect(itemKey(changed)).not.toBe(itemKey(item));
    expect((await read({}, [changed])).result).toEqual(live([{ id: "D-1", disposition: "fixed" }]));
  });
  test("AC-9: missing index falls back", async () => {
    expect((await read({ index: "missing" })).result).toEqual({
      source: "run-record",
      error: "no nax item index on this PR",
    });
  });
  test("AC-10: includes run-level cannot-verify id", async () => {
    const cv: OpenItem = { id: "_run:cv1", kind: "cannot-verify", issue: "cannot verify" };
    expect((await read({ item: cv }, [cv])).result).toEqual(live([{ id: cv.id, disposition: "fixed" }]));
  });
  test("AC-11: input without thread stays open; other thread ids are excluded", async () => {
    expect((await read({}, [{ ...item, id: "absent" }])).result).toEqual(live());
  });
  test("AC-12: successful reads never mutate forge", async () => {
    const fx = await read({ reply: true, fix: true });
    expect(fx.result).toEqual(live([{ id: "D-1", disposition: "fixed" }]));
    expect(fx.mutations).toEqual([]);
    expect(fx.calls.length).toBeGreaterThan(0);
  });
  test("AC-13/14: invalid URL falls back before any command", async () => {
    const fx = fixture();
    const { readLiveStatus } = await import("@/workflow/live-status");
    const result = await readLiveStatus({ url: "https://github.com/o/r", cwd, deps: fx.deps, items: [item] });
    expect(result).toEqual({ source: "run-record", error: expect.any(String) });
    if (result.source === "run-record") expect(result.error.length).toBeGreaterThan(0);
    expect(fx.calls).toEqual([]);
  });
  test.each(["state", "threads"] as const)("AC-15/16: %s failure falls back", async (fail) => {
    expect((await read({ fail })).result).toEqual({
      source: "run-record",
      error: expect.stringContaining(`${fail} offline`),
    });
  });
  test("AC-17: undetectable forge falls back", async () => {
    expect((await read({ undetected: true })).result).toEqual({
      source: "run-record",
      error: expect.stringContaining("Cannot determine forge"),
    });
  });
  test.each(["resolve", "user", "comments", "reviews", "threads", "state"] as const)(
    "AC-18: thrown %s read failure preserves message",
    async (fail) => {
      expect((await read({ fail, throws: true })).result).toEqual({
        source: "run-record",
        error: expect.stringContaining(`${fail} offline`),
      });
    },
  );
  test("permission lookup exceptions deny reply, not live read", async () => {
    expect((await read({ reply: true, permission: "throws" })).result).toEqual(
      live([{ id: "D-1", disposition: "fixed" }]),
    );
  });
  test("partitions by thread kind despite run-record drift", async () => {
    expect((await read({ echo: "confirmed", isDraft: true }, [{ ...item, kind: "finding" }])).result).toEqual({
      ...live([], ["D-1"]),
      isDraft: true,
    });
  });
  test("confirmed non-advisor needs no fix", async () => {
    const finding: OpenItem = { ...item, kind: "finding" };
    expect((await read({ item: finding, echo: "confirmed" }, [finding])).result).toEqual(
      live([{ id: "D-1", disposition: "confirmed" }]),
    );
  });
});
