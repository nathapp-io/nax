import { describe, expect, test } from "bun:test";
import { NaxError } from "@/errors";
import type { ForgeDeps, ForgeRunResult, PrRef } from "@/forge";
import * as forge from "@/forge";
import type { GitlabDiscussion } from "@/forge/threads";

const github: PrRef = { forge: "github", host: "github.example.com", repo: "acme/widgets", number: 5 };
const gitlab: PrRef = { forge: "gitlab", host: "gitlab.example.com", repo: "group/sub/widgets", number: 5 };
const issue = (id = 71) => ({ id, user: { login: "alice" }, body: "issue", created_at: "created" });
const review = (id = 81) => ({ id, user: { login: "bob" }, body: "review", submitted_at: "submitted" });
const discussion = (id = 91) => ({
  id: String(id),
  individual_note: true,
  notes: [{ id, system: false, author: { username: "carol", id: 9 }, body: "note", created_at: "noted" }],
});
const full = (item: unknown) => Array.from({ length: 100 }, () => item);
const ghThreads = (next: boolean) => ({
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: [],
          pageInfo: { hasNextPage: next, endCursor: next ? "C1" : null },
        },
      },
    },
  },
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
const comments = (pages: unknown[]) => forge.listPrComments(github, harness(pages).deps, "/repo");
const endpoint = (ref: PrRef, kind: "issues" | "pulls" | "discussions", page: number) =>
  kind === "discussions"
    ? `projects/group%2Fsub%2Fwidgets/merge_requests/${ref.number}/discussions?per_page=100&page=${page}`
    : `repos/${ref.repo}/${kind}/${ref.number}/${kind === "issues" ? "comments" : "reviews"}?per_page=100&page=${page}`;

function replied(key = "summary"): GitlabDiscussion {
  return {
    id: "summary-thread",
    individual_note: false,
    notes: [
      {
        id: 91,
        system: false,
        author: { username: "bot", id: 1 },
        body: forge.withNaxBotMarker("s", key),
        created_at: "t",
      },
      { id: 92, system: false, author: { username: "carol", id: 9 }, body: "reply", created_at: "later" },
    ],
  };
}

describe("replied GitLab top-level notes", () => {
  test("AC-1 exports the top-level marker keys", () => {
    expect(forge.TOP_LEVEL_MARKER_KEYS).toEqual(["summary", "w-index", "w-evidence", "fix-summary"]);
  });
  test("AC-2 preserves the public marker parser", () => {
    expect(forge.parseNaxBotMarker(forge.withNaxBotMarker("body", "summary"))).toEqual({ key: "summary" });
  });
  test.each(["summary", "w-index", "w-evidence", "fix-summary"])("AC-3/4 flattens %s in order", async (key) => {
    expect(await forge.listPrComments(gitlab, harness([[replied(key)]]).deps, "/repo")).toEqual([
      { id: "91", kind: "comment", author: "bot", authorId: 1, body: forge.withNaxBotMarker("s", key), createdAt: "t" },
      { id: "92", kind: "comment", author: "carol", authorId: 9, body: "reply", createdAt: "later" },
    ]);
  });
  test("AC-5 ignores system notes including before the opener", async () => {
    const d = replied();
    const system = { ...d.notes[1], id: 90, system: true };
    d.notes = [system, ...d.notes, system];
    expect((await forge.listPrComments(gitlab, harness([[d]]).deps, "/repo")).map((c) => c.id)).toEqual(["91", "92"]);
  });
  test.each(["position", "finding", "second-only"])("AC-6/7/8 does not flatten %s", async (kind) => {
    const d = replied(kind === "finding" ? "f-abc123" : "summary");
    if (kind === "position" && d.notes[0]) d.notes[0].position = { new_path: "a.ts", new_line: 1 };
    if (kind === "second-only" && d.notes[0] && d.notes[1]) {
      d.notes[1].body = d.notes[0].body;
      d.notes[0].body = "unmarked";
    }
    expect(await forge.listPrComments(gitlab, harness([[d]]).deps, "/repo")).toEqual([]);
    expect(await forge.listReviewThreads(gitlab, harness([[d]]).deps, "/repo")).toHaveLength(1);
  });
  test("AC-9 leaves flattened summaries out of review threads", async () => {
    expect(await forge.listReviewThreads(gitlab, harness([[replied()]]).deps, "/repo")).toEqual([]);
  });
  test("AC-10 preserves position-less item threads", async () => {
    const threads = await forge.listReviewThreads(gitlab, harness([[replied("w-B1.12345678")]]).deps, "/repo");
    expect(threads).toHaveLength(1);
    expect(threads[0]?.comments.map((c) => c.id)).toEqual(["91", "92"]);
  });
});

describe("listPrComments", () => {
  test("US-001 AC-11 maps each GitLab note author id in order", async () => {
    const d = discussion();
    const notes = [
      ...d.notes,
      { id: 92, system: false, author: { username: "alice", id: 10 }, body: "reply", created_at: "later" },
    ];
    const result = await forge.listPrComments(gitlab, harness([[{ ...d, notes }]]).deps, "/repo");
    expect(result.map((c) => [c.id, c.authorId])).toEqual([
      ["91", 9],
      ["92", 10],
    ]);
  });
  test("AC-1 issue comments precede review bodies", async () => {
    expect(await comments([[issue()], [review()]])).toEqual([
      { id: "71", kind: "comment", author: "alice", body: "issue", createdAt: "created" },
      { id: "81", kind: "review", author: "bob", body: "review", createdAt: "submitted" },
    ]);
  });
  test("AC-2 issue identity is a string", async () => {
    expect((await comments([[issue()], []]))[0]?.id).toBe("71");
  });
  test("AC-3 issue author and timestamp", async () => {
    expect((await comments([[issue()], []]))[0]).toMatchObject({ author: "alice", createdAt: "created" });
  });
  test("AC-4 review submitted timestamp", async () => {
    expect((await comments([[], [review()]]))[0]?.createdAt).toBe("submitted");
  });
  test("AC-5 excludes empty review bodies but keeps whitespace", async () => {
    expect(
      (
        await comments([
          [],
          [
            { ...review(), body: "" },
            { ...review(82), body: " " },
          ],
        ])
      ).map((c) => c.id),
    ).toEqual(["82"]);
  });
  test("AC-6 deleted issue and review authors become ghost", async () => {
    expect(
      (await comments([[{ ...issue(), user: null }], [{ ...review(), user: null }]])).map((c) => c.author),
    ).toEqual(["ghost", "ghost"]);
  });
  test("AC-7 both GitHub endpoints page independently in order", async () => {
    const h = harness([full(issue()), [issue(72)], full(review()), [review(82)]]);
    const result = await forge.listPrComments(github, h.deps, "/repo");
    expect(h.calls.map((c) => c[4])).toEqual([
      endpoint(github, "issues", 1),
      endpoint(github, "issues", 2),
      endpoint(github, "pulls", 1),
      endpoint(github, "pulls", 2),
    ]);
    expect(result).toHaveLength(202);
    expect([result[100]?.id, result[101]?.id, result[201]?.id]).toEqual(["72", "81", "82"]);
  });
  test("AC-8 individual GitLab note mapping", async () => {
    expect(await forge.listPrComments(gitlab, harness([[discussion()]]).deps, "/repo")).toEqual([
      { id: "91", kind: "comment", author: "carol", authorId: 9, body: "note", createdAt: "noted" },
    ]);
  });
  test("AC-9 excludes system notes", async () => {
    const d = discussion();
    expect(
      await forge.listPrComments(
        gitlab,
        harness([[{ ...d, notes: d.notes.map((n) => ({ ...n, system: true })) }]]).deps,
        "/repo",
      ),
    ).toEqual([]);
  });
  test("AC-10 excludes thread discussions", async () => {
    expect(
      await forge.listPrComments(gitlab, harness([[{ ...discussion(), individual_note: false }]]).deps, "/repo"),
    ).toEqual([]);
  });
  test("AC-11 GitLab full page continues even when all items are filtered", async () => {
    const h = harness([full({ ...discussion(), individual_note: false }), [discussion(92)]]);
    expect((await forge.listPrComments(gitlab, h.deps, "/repo")).map((c) => c.id)).toEqual(["92"]);
    expect(h.calls.map((c) => c[4])).toEqual([endpoint(gitlab, "discussions", 1), endpoint(gitlab, "discussions", 2)]);
  });
  test("AC-12 GitLab short page stops", async () => {
    const h = harness([[discussion()], [discussion(92)]]);
    expect(await forge.listPrComments(gitlab, h.deps, "/repo")).toHaveLength(1);
    expect(h.calls).toHaveLength(1);
  });
  test.each(["issues", "pulls", "discussions"] as const)("AC-13 %s cap is exactly 50 requests", async (kind) => {
    const ref = kind === "discussions" ? gitlab : github;
    const h = harness(kind === "pulls" ? [[], full(review())] : [full(kind === "issues" ? issue() : discussion())]);
    const pending = forge.listPrComments(ref, h.deps, "/repo");
    await expect(pending).rejects.toBeInstanceOf(NaxError);
    await expect(pending).rejects.toMatchObject({ code: "FORGE_PAGINATION_LIMIT", context: { stage: "forge" } });
    expect(h.calls.filter((c) => c[4]?.split("?")[0] === endpoint(ref, kind, 1).split("?")[0])).toHaveLength(50);
    expect(h.calls.at(-1)?.[4]).toBe(endpoint(ref, kind, 50));
  });
  test.each([github, gitlab])("AC-14 $forge command failure", async (ref) => {
    const h = harness([], { exitCode: 1, stdout: "", stderr: "denied" });
    const pending = forge.listPrComments(ref, h.deps, "/repo");
    await expect(pending).rejects.toBeInstanceOf(NaxError);
    await expect(pending).rejects.toMatchObject({ code: "FORGE_COMMENTS_READ_FAILED", context: { stage: "forge" } });
    expect(h.calls).toHaveLength(1);
  });
  test.each([github, gitlab])("AC-15 $forge invalid JSON", async (ref) => {
    const h = harness([], { exitCode: 0, stdout: "not json", stderr: "" });
    await expect(forge.listPrComments(ref, h.deps, "/repo")).rejects.toMatchObject({
      code: "FORGE_RESPONSE_UNPARSEABLE",
      context: { stage: "forge" },
    });
  });
  test.each([github, gitlab])(
    "AC-16/17 $forge both readers explicitly host every page without --paginate",
    async (ref) => {
      const h = harness(ref.forge === "github" ? [full(issue()), [], full(review()), []] : [full(discussion()), []]);
      await forge.listPrComments(ref, h.deps, "/repo");
      const t = harness(
        ref.forge === "github"
          ? [ghThreads(true), ghThreads(false)]
          : [full({ ...discussion(), individual_note: false }), []],
      );
      await forge.listReviewThreads(ref, t.deps, "/repo");
      expect(h.calls.length).toBe(ref.forge === "github" ? 4 : 2);
      expect(t.calls).toHaveLength(2);
      for (const call of [...h.calls, ...t.calls]) {
        expect(call.slice(0, 4)).toEqual([ref.forge === "github" ? "gh" : "glab", "api", "--hostname", ref.host]);
        expect(call).not.toContain("--paginate");
      }
      if (ref.forge === "gitlab")
        expect(t.calls.map((c) => c[4])).toEqual([endpoint(ref, "discussions", 1), endpoint(ref, "discussions", 2)]);
    },
  );
});
