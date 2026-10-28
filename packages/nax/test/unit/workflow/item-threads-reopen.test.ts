import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ForgeDeps, withNaxBotMarker as marked } from "@/forge";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import type { Disposition } from "@/workflow/decisions-sidecar";
import { newFeatureRecord } from "@/workflow/feature-record";
import {
  itemKey,
  renderItemIndex,
  renderItemOpener,
  renderItemReopened,
  renderRulingEcho,
  reopenKey,
} from "@/workflow/item-threads";
import { type ItemThreadsInput, postItemThreads } from "@/workflow/item-threads-post";

const HEAD = "a".repeat(40);
const OLD = "c".repeat(40);
const finding = { id: "B1", kind: "spec", severity: "important", issue: "leak" } as const;
const item = { id: "B1", kind: "finding", issue: "leak" } as const;
const key = itemKey(item);
interface Options {
  disposition?: Disposition;
  previous?: string | null;
  notice?: boolean;
  author?: string;
  permission?: "write" | "read" | "reject";
  fail?: "reply" | "unresolve";
}
function harness(options: Options = {}) {
  const writes: string[][] = [];
  const permissions: string[][] = [];
  const ok = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: "" });
  const comment = (body: string, author: string, id: number) => ({
    databaseId: id,
    body,
    author: { login: author },
    createdAt: "t",
  });
  const disposition = options.disposition ?? "fixed";
  const ruling = { itemKey: key, itemId: item.id, disposition, reason: "done", by: "carol", sha: OLD };
  const comments = [
    comment(marked(renderItemOpener(item), key), "bot", 10),
    comment(marked(renderRulingEcho(ruling), `wr-${disposition}-${key}`), "bot", 11),
    ...(options.notice ? [comment(marked(renderItemReopened(OLD), reopenKey(key)), "bot", 12)] : []),
    ...(options.author
      ? [comment("pending reply", options.author, 13), comment("another reply", options.author, 14)]
      : []),
  ];
  const deps: ForgeDeps = {
    readText: async () => null,
    run: async (cmd) => {
      if (cmd.includes("POST") || cmd.includes("PATCH") || cmd.some((arg) => arg.startsWith("query=mutation"))) {
        writes.push(cmd);
        if (
          (options.fail === "reply" && cmd.some((arg) => arg.includes("key=wo-"))) ||
          (options.fail === "unresolve" && cmd.some((arg) => arg.includes("unresolveReviewThread")))
        )
          throw new Error("write rejected");
        return ok({ id: 1 });
      }
      if (cmd[0] === "git") return { exitCode: 0, stdout: "git@github.com:o/r.git", stderr: "" };
      if (cmd.includes("user")) return ok({ login: "bot", id: 1 });
      if (cmd.some((arg) => arg.includes("/permission"))) {
        permissions.push(cmd);
        if (options.permission === "reject") throw new Error("permission rejected");
        return ok({ permission: options.permission ?? "read" });
      }
      if (cmd.includes("graphql"))
        return ok({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [{ id: "T", isResolved: !options.notice, isOutdated: false, comments: { nodes: comments } }],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        });
      if (cmd.some((arg) => arg.includes("/reviews?"))) return ok([]);
      if (cmd.some((arg) => arg.includes("?per_page=")))
        return ok([
          {
            id: 9,
            user: { login: "bot" },
            created_at: "t",
            body: marked(
              renderItemIndex({
                keys: [key],
                reviewedHead: options.previous === null ? undefined : (options.previous ?? OLD),
              }),
              "w-index",
            ),
          },
        ]);
      return ok({ head: { sha: HEAD, ref: "feature" }, base: { ref: "main" }, user: { login: "author" } });
    },
  };
  const input: ItemThreadsInput = {
    record: { ...newFeatureRecord({ now: "t", seed: OLD, minors: [] }), reviewRan: true, reviewOpen: [finding] },
    url: "https://github.com/o/r/pull/7",
    head: HEAD,
    projectDir: "/repo",
    feature: "demo",
    changedFiles: ["a.ts"],
  };
  const replies = () => writes.filter((cmd) => cmd.some((arg) => arg.includes("key=wo-")));
  const unresolves = () => writes.filter((cmd) => cmd.some((arg) => arg.includes("unresolveReviewThread")));
  return { deps, input, writes, replies, unresolves, permissions };
}
let logs: LogEntry[];
let remove: () => void;
beforeEach(() => {
  logs = [];
  initLogger({ level: "warn", suppressConsole: true });
  remove = addSink((entry) => {
    logs.push(entry);
  });
});
afterEach(() => {
  remove();
  resetLogger();
});
describe("postItemThreads re-raised rulings", () => {
  test.each(["fixed", "verified"] as const)("AC-1/2/3/4 reopens %s before unresolve and index", async (disposition) => {
    const h = harness({ disposition });
    expect(await postItemThreads(h.input, h.deps)).toMatchObject({ failed: 0, posted: 0 });
    expect(h.replies()).toHaveLength(1);
    expect(h.replies()[0]).toContain(`body=${marked(renderItemReopened(HEAD), reopenKey(key))}`);
    expect(h.replies()[0]?.join(" ")).toContain("Raised again by the run at aaaaaaa");
    expect(h.unresolves()).toHaveLength(1);
    expect(h.unresolves()[0]).toContain("id=T");
    expect(h.writes[0]).toBe(h.replies()[0]);
    expect(h.writes[1]).toBe(h.unresolves()[0]);
    expect(h.writes[2]?.join(" ")).toContain("key=w-index");
  });
  test.each(["waived", "confirmed", "overridden"] as const)("AC-5 preserves %s", async (disposition) => {
    const h = harness({ disposition });
    await postItemThreads(h.input, h.deps);
    expect(h.replies()).toHaveLength(0);
    expect(h.unresolves()).toHaveLength(0);
  });
  test.each([
    ["AC-6 same head", { previous: HEAD }, {}],
    ["AC-8 no review", {}, { reviewRan: false }],
    ["AC-9 CI repair", {}, { ciRepairRounds: 1 }],
    ["AC-10 not raised", {}, { reviewOpen: [] }],
    ["AC-11 already reopened", { notice: true }, {}],
    ["incomplete review", {}, { reviewUnread: ["a.ts"] }],
  ] satisfies [string, Options, Partial<ItemThreadsInput["record"]>][])(
    "%s never reopens",
    async (_name, options, record) => {
      const h = harness(options);
      await postItemThreads({ ...h.input, record: { ...h.input.record, ...record } }, h.deps);
      expect(h.replies()).toHaveLength(0);
      expect(h.unresolves()).toHaveLength(0);
    },
  );
  test("AC-7 reopens after a previous incomplete review", async () => {
    const h = harness({ previous: null });
    await postItemThreads(h.input, h.deps);
    expect(h.replies()).toHaveLength(1);
    expect(h.unresolves()).toHaveLength(1);
  });
  test.each([
    ["AC-12", "carol", "write", 0],
    ["AC-13", "dave", "read", 1],
    ["AC-14", "dave", "reject", 1],
  ] as const)("%s checks later replies with cached fail-closed permissions", async (_ac, author, permission, count) => {
    const h = harness({ author, permission });
    await postItemThreads(h.input, h.deps);
    expect(h.replies()).toHaveLength(count);
    expect(h.unresolves()).toHaveLength(count);
    expect(h.permissions).toHaveLength(1);
    expect(h.permissions[0]?.join(" ")).toContain(`/collaborators/${author}/permission`);
  });
  test.each(["reply", "unresolve"] as const)(
    "AC-15/16/17/18/19 %s failure warns and increments failed",
    async (fail) => {
      const baseline = harness();
      const before = await postItemThreads(baseline.input, baseline.deps);
      const h = harness({ fail });
      const after = await postItemThreads(h.input, h.deps);
      expect(after.failed).toBe(before.failed + 1);
      expect(h.replies()).toHaveLength(1);
      expect(h.unresolves()).toHaveLength(fail === "reply" ? 0 : 1);
      expect(
        logs.some(
          (entry) =>
            entry.level === "warn" &&
            entry.stage === "item-threads" &&
            entry.message === "[item-threads] Reopen write failed" &&
            entry.data?.itemId === "B1" &&
            entry.data?.error === "write rejected",
        ),
      ).toBe(true);
      expect(h.writes.at(-1)?.join(" ")).toContain("key=w-index");
    },
  );
});
