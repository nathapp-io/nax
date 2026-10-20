import { describe, expect, test } from "bun:test";
import { NaxError } from "@/errors";
import type { ForgeDeps, ForgeRunResult, PrRef } from "@/forge";
import * as forge from "@/forge";

const github: PrRef = { forge: "github", host: "github.example.com", repo: "acme/widgets", number: 5 };
const gitlab: PrRef = { forge: "gitlab", host: "gitlab.example.com", repo: "group/sub/widgets", number: 5 };
const node = (id = "T1") => ({
  id,
  isResolved: true,
  isOutdated: true,
  path: "new.ts",
  line: null,
  originalLine: 9,
  comments: { nodes: [{ databaseId: 71, author: null, body: "review", createdAt: "today" }] },
});
const ghPage = (nodes: unknown[] = [node()], hasNextPage = false, endCursor: string | null = null) => ({
  data: { repository: { pullRequest: { reviewThreads: { nodes, pageInfo: { hasNextPage, endCursor } } } } },
});
const note = () => ({
  id: 81,
  system: false,
  resolved: true,
  author: { username: "bot" },
  body: "note",
  created_at: "today",
  position: { new_path: "new.ts", old_path: "old.ts", new_line: 12, old_line: 8 },
});
const discussion = (id = "D1") => ({
  id,
  individual_note: false,
  notes: [note(), { ...note(), id: 82, system: true }],
});
function harness(pages: unknown[], result?: ForgeRunResult) {
  const calls: string[][] = [];
  const deps: ForgeDeps = {
    run: async (argv, opts) => {
      expect(opts.cwd).toBe("/repo");
      calls.push(argv);
      return (
        result ?? {
          exitCode: 0,
          stdout: JSON.stringify(pages[Math.min(calls.length - 1, pages.length - 1)]),
          stderr: "",
        }
      );
    },
    readText: async () => null,
  };
  return { calls, deps };
}
async function ghThreads(nodes: unknown[] = [node()]) {
  return forge.listReviewThreads(github, harness([ghPage(nodes)]).deps, "/repo");
}
async function glThreads(items: unknown[] = [discussion()]) {
  return forge.listReviewThreads(gitlab, harness([items]).deps, "/repo");
}

describe("listReviewThreads", () => {
  test("AC-1 explicit GitHub host, owner and name", async () => {
    const h = harness([ghPage()]);
    await forge.listReviewThreads(github, h.deps, "/repo");
    expect(h.calls[0]?.slice(0, 5)).toEqual(["gh", "api", "--hostname", github.host, "graphql"]);
    expect(h.calls[0]?.slice(-6)).toEqual(["-f", "owner=acme", "-f", "name=widgets", "-F", "number=5"]);
    const query = h.calls[0]?.find((arg) => arg.startsWith("query="));
    for (const field of [
      "reviewThreads(first: 100, after: $endCursor)",
      "comments(first: 100)",
      "databaseId",
      "originalLine",
      "pageInfo",
    ])
      expect(query).toContain(field);
  });
  test("AC-2 number is typed", async () => {
    const h = harness([ghPage()]);
    await forge.listReviewThreads(github, h.deps, "/repo");
    expect(h.calls[0]?.slice(-2)).toEqual(["-F", "number=5"]);
  });
  test("AC-3 first page omits cursor argument", async () => {
    const h = harness([ghPage()]);
    await forge.listReviewThreads(github, h.deps, "/repo");
    expect(h.calls[0]?.some((arg) => arg.startsWith("endCursor="))).toBe(false);
  });
  test("AC-4 next page carries explicit cursor", async () => {
    const h = harness([ghPage([node()], true, "C1"), ghPage([node("T2")])]);
    await forge.listReviewThreads(github, h.deps, "/repo");
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toEqual([...(h.calls[0] ?? []), "-f", "endCursor=C1"]);
  });
  test("AC-5 retains page and item order", async () => {
    const h = harness([ghPage([node("A"), node("B")], true, "C1"), ghPage([node("C")])]);
    expect((await forge.listReviewThreads(github, h.deps, "/repo")).map((t) => t.id)).toEqual(["A", "B", "C"]);
  });
  test.each([
    ["AC-6", "id", "T1"],
    ["AC-7", "replyTo", "71"],
    ["AC-9", "resolved", true],
    ["AC-10", "outdated", true],
    ["AC-11", "line", 9],
  ] as const)("%s maps GitHub %s", async (_ac, field, value) => {
    expect((await ghThreads())[0]?.[field]).toBe(value);
  });
  test("AC-8 comment database id and content", async () => {
    expect((await ghThreads())[0]?.comments[0]).toEqual({
      id: "71",
      kind: "thread",
      author: "ghost",
      body: "review",
      createdAt: "today",
    });
  });
  test("AC-12 absent lines remain undefined", async () => {
    expect((await ghThreads([{ ...node(), originalLine: null }]))[0]?.line).toBeUndefined();
  });
  test("AC-13 deleted author becomes ghost", async () => {
    expect((await ghThreads())[0]?.comments[0]?.author).toBe("ghost");
  });
  test("AC-14 only non-individual discussions", async () => {
    expect(
      (await glThreads([{ ...discussion("solo"), individual_note: true }, discussion()])).map((t) => t.id),
    ).toEqual(["D1"]);
  });
  test("AC-15 discussion id is both identities", async () => {
    expect((await glThreads())[0]).toMatchObject({ id: "D1", replyTo: "D1" });
  });
  test("AC-16 GitLab outdated is false", async () => {
    expect((await glThreads())[0]?.outdated).toBe(false);
  });
  test("AC-17 first note determines resolution", async () => {
    expect((await glThreads())[0]?.resolved).toBe(true);
  });
  test("AC-18 new path preferred, old path fallback", async () => {
    const old = { ...discussion("old"), notes: [{ ...note(), position: { ...note().position, new_path: null } }] };
    expect((await glThreads([discussion(), old])).map((t) => t.path)).toEqual(["new.ts", "old.ts"]);
  });
  test("AC-19 new line preferred, old line fallback", async () => {
    const old = { ...discussion("old"), notes: [{ ...note(), position: { ...note().position, new_line: null } }] };
    expect((await glThreads([discussion(), old])).map((t) => t.line)).toEqual([12, 8]);
  });
  test("AC-20 system notes excluded with stable note ids", async () => {
    expect((await glThreads())[0]?.comments).toEqual([
      { id: "81", kind: "thread", author: "bot", body: "note", createdAt: "today" },
    ]);
  });
  test("AC-21 stops at exactly 50 GitHub requests", async () => {
    const h = harness([ghPage([], true, "next")]);
    await expect(forge.listReviewThreads(github, h.deps, "/repo")).rejects.toMatchObject({
      code: "FORGE_PAGINATION_LIMIT",
      context: { stage: "forge" },
    });
    expect(h.calls).toHaveLength(50);
  });
  test.each([github, gitlab])("AC-22 command failure for $forge", async (ref) => {
    const h = harness([], { exitCode: 1, stdout: "", stderr: "denied" });
    const pending = forge.listReviewThreads(ref, h.deps, "/repo");
    await expect(pending).rejects.toBeInstanceOf(NaxError);
    await expect(pending).rejects.toMatchObject({ code: "FORGE_THREADS_READ_FAILED", context: { stage: "forge" } });
  });
  test.each([github, gitlab])("AC-23 invalid JSON for $forge", async (ref) => {
    const h = harness([], { exitCode: 0, stdout: "not json", stderr: "" });
    await expect(forge.listReviewThreads(ref, h.deps, "/repo")).rejects.toMatchObject({
      code: "FORGE_RESPONSE_UNPARSEABLE",
      context: { stage: "forge" },
    });
  });
  test("GitLab explicitly requests each encoded page without CLI pagination", async () => {
    const h = harness([Array.from({ length: 100 }, (_, i) => discussion(String(i))), [discussion("last")]]);
    const threads = await forge.listReviewThreads(gitlab, h.deps, "/repo");
    expect(threads.map((t) => t.id)).toEqual([...Array.from({ length: 100 }, (_, i) => String(i)), "last"]);
    expect(h.calls).toEqual(
      [1, 2].map((page) => [
        "glab",
        "api",
        "--hostname",
        gitlab.host,
        `projects/group%2Fsub%2Fwidgets/merge_requests/5/discussions?per_page=100&page=${page}`,
      ]),
    );
  });
  test("current GitHub line and live author take precedence", async () => {
    const live = {
      ...node(),
      line: 14,
      isResolved: false,
      isOutdated: false,
      comments: { nodes: [{ databaseId: 72, author: { login: "reviewer" }, body: "live", createdAt: "now" }] },
    };
    expect((await ghThreads([live]))[0]).toMatchObject({
      line: 14,
      path: "new.ts",
      resolved: false,
      outdated: false,
      comments: [{ id: "72", kind: "thread", author: "reviewer", body: "live", createdAt: "now" }],
    });
  });
  test.each([github, gitlab])("empty final page for $forge", async (ref) => {
    const h = harness([ref.forge === "github" ? ghPage([]) : []]);
    expect(await forge.listReviewThreads(ref, h.deps, "/repo")).toEqual([]);
    expect(h.calls).toHaveLength(1);
  });
  test.each([{}, null, { data: { repository: null } }])(
    "malformed GitHub connection is unparseable: %j",
    async (reply) => {
      await expect(forge.listReviewThreads(github, harness([reply]).deps, "/repo")).rejects.toMatchObject({
        code: "FORGE_RESPONSE_UNPARSEABLE",
        context: { stage: "forge" },
      });
    },
  );
  test("missing GitHub reply target is unparseable", async () => {
    await expect(ghThreads([{ ...node(), comments: { nodes: [] } }])).rejects.toMatchObject({
      code: "FORGE_RESPONSE_UNPARSEABLE",
      context: { stage: "forge" },
    });
  });
  test("GitLab position is optional", async () => {
    const { position: _position, ...unpositioned } = note();
    expect((await glThreads([{ ...discussion(), notes: [{ ...unpositioned, resolved: false }] }]))[0]).toMatchObject({
      line: undefined,
      path: undefined,
      resolved: false,
    });
  });
  test("GitLab full page 50 hits the limit", async () => {
    const h = harness([Array.from({ length: 100 }, () => discussion())]);
    await expect(forge.listReviewThreads(gitlab, h.deps, "/repo")).rejects.toMatchObject({
      code: "FORGE_PAGINATION_LIMIT",
      context: { stage: "forge" },
    });
    expect(h.calls).toHaveLength(50);
  });
});
describe("MAX_FORGE_PAGES", () => {
  test("AC-24 equals 50", () => {
    expect(forge.MAX_FORGE_PAGES).toBe(50);
  });
});
