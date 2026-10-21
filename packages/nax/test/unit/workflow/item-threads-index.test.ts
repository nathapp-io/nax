import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ForgeDeps } from "@/forge";
import { withNaxBotMarker } from "@/forge";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { newFeatureRecord } from "@/workflow/feature-record";
import { itemKey, parseItemIndex, renderItemIndex, renderItemOpener } from "@/workflow/item-threads";
import { type ItemThreadsInput, postItemThreads } from "@/workflow/item-threads-post";
import { buildOpenItems } from "@/workflow/open-items";
import type { WorkflowFeatureRecord } from "@/workflow/types";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const OLD = "c".repeat(40);
const finding = { id: "B1", kind: "spec", severity: "important", issue: "leak" } as const;
const oldItem = { id: "old", kind: "finding", issue: "obsolete" } as const;
const oldKey = itemKey(oldItem);
const marked = (body: string, key = "w-index") => withNaxBotMarker(body, key);
const oldIndex = marked(renderItemIndex({ keys: [], reviewedHead: OLD, reviewedBase: BASE }));
const input = (record: Partial<WorkflowFeatureRecord> = {}): ItemThreadsInput => ({
  record: { ...newFeatureRecord({ now: "t", seed: BASE, minors: [] }), ...record },
  url: "https://github.com/o/r/pull/7",
  head: HEAD,
  projectDir: "/repo",
  feature: "demo",
  changedFiles: ["a.ts"],
});

interface HarnessOptions {
  index?: string;
  indexAuthor?: string;
  threads?: boolean;
  closedAuthor?: string;
  fail?: string;
}
const comment = (body: string, author: string, id: number) => ({
  databaseId: id,
  author: { login: author },
  body,
  createdAt: "t",
});
function threadSnapshot(options: HarnessOptions) {
  const nodes = options.threads
    ? [
        {
          id: "T",
          isResolved: false,
          isOutdated: false,
          path: "a.ts",
          line: 1,
          comments: {
            nodes: [
              comment(marked(renderItemOpener(oldItem), oldKey), "bot", 10),
              ...(options.closedAuthor ? [comment(marked("closed", `wc-${oldKey}`), options.closedAuthor, 11)] : []),
            ],
          },
        },
      ]
    : [];
  return { data: { repository: { pullRequest: { reviewThreads: { nodes, pageInfo: { hasNextPage: false } } } } } };
}
function indexSnapshot(options: HarnessOptions) {
  return options.index
    ? [{ id: 9, user: { login: options.indexAuthor ?? "bot" }, body: options.index, created_at: "t" }]
    : [];
}
function harness(options: HarnessOptions = {}) {
  const writes: string[][] = [];
  const ok = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: "" });
  const deps: ForgeDeps = {
    readText: async () => null,
    run: async (cmd) => {
      if (cmd.includes("POST") || cmd.includes("PATCH") || cmd.some((a) => a.startsWith("query=mutation"))) {
        writes.push(cmd);
        if (options.fail && cmd.some((a) => a.includes(options.fail ?? ""))) throw new Error("write rejected");
        return ok({ id: 1 });
      }
      if (cmd[0] === "git") return { exitCode: 0, stdout: "git@github.com:o/r.git", stderr: "" };
      if (cmd.includes("user")) return ok({ login: "bot", id: 1 });
      if (cmd.includes("graphql")) return ok(threadSnapshot(options));
      if (cmd.some((a) => a.includes("/reviews?"))) return ok([]);
      if (cmd.some((a) => a.includes("?per_page="))) return ok(indexSnapshot(options));
      return ok({ head: { sha: HEAD, ref: "feature" }, base: { ref: "main" }, user: { login: "author" } });
    },
  };
  const indexWrite = () => writes.find((cmd) => cmd.some((a) => a.includes("key=w-index")));
  const index = () =>
    parseItemIndex(
      indexWrite()
        ?.find((a) => a.startsWith("body="))
        ?.slice(5) ?? "",
    );
  return { deps, writes, indexWrite, index };
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

describe("postItemThreads index and closing", () => {
  test("AC-1 posts a top-level index when none is owned", async () => {
    const h = harness({ index: oldIndex, indexAuthor: "other" });
    await postItemThreads(input(), h.deps);
    expect(h.indexWrite()).toContain("POST");
    expect(h.indexWrite()).toContain("repos/o/r/issues/7/comments");
    expect(h.index()).toEqual({ keys: [] });
  });
  test("AC-2 edits the own index in place", async () => {
    const h = harness({ index: oldIndex });
    await postItemThreads(input(), h.deps);
    expect(h.indexWrite()).toContain("PATCH");
    expect(h.indexWrite()).toContain("repos/o/r/issues/comments/9");
    expect(h.writes).toHaveLength(1);
  });
  test("AC-3 indexes non-postable and failed keys, never CI, in item order", async () => {
    const h = harness({ fail: "subject_type=file" });
    const source = input({ reviewOpen: [finding, { ...finding, id: "bad id" }], ci: "failed" });
    const out = await postItemThreads(source, h.deps);
    expect(out).toMatchObject({ failed: 1, skipped: 1 });
    expect(h.index()?.keys).toEqual(
      buildOpenItems(source.record)
        .filter((i) => i.kind !== "ci")
        .map(itemKey),
    );
    expect(h.index()?.keys).toHaveLength(2);
  });
  test.each([undefined, 0])("AC-4 reviewed head and seed with eligible review (rounds %s)", async (rounds) => {
    const h = harness();
    await postItemThreads(input({ reviewRan: true, gateRepairRounds: rounds, ciRepairRounds: rounds }), h.deps);
    expect(h.index()).toEqual({ keys: [], reviewedHead: HEAD, reviewedBase: BASE });
  });
  test.each([
    ["AC-5", { reReviewSkipped: true }],
    ["AC-6", { gateRepairRounds: 1 }],
    ["unread", { reviewUnread: ["unread.ts"] }],
    ["cost", { costLimited: true }],
    ["not run", { reviewRan: false }],
  ] as const)("%s clears reviewed head", async (_name, over) => {
    const h = harness({ index: oldIndex });
    await postItemThreads(input({ reviewRan: true, ...over }), h.deps);
    expect(h.index()).toEqual({ keys: [] });
  });
  test("an empty unread list permits review evidence", async () => {
    const h = harness();
    await postItemThreads(input({ reviewRan: true, reviewUnread: [] }), h.deps);
    expect(h.index()).toEqual({ keys: [], reviewedHead: HEAD, reviewedBase: BASE });
  });
  test("closing falls back to the PR head when the local head is unavailable", async () => {
    const h = harness({ threads: true });
    await postItemThreads({ ...input(), head: undefined }, h.deps);
    expect(h.writes[1]).toContain(`body=${marked("No longer open in the run at aaaaaaa.", `wc-${oldKey}`)}`);
    expect(h.index()).toEqual({ keys: [] });
  });
  test("AC-7 only CI repair preserves the previous reviewed head and base", async () => {
    const h = harness({ index: oldIndex });
    await postItemThreads(input({ reviewRan: true, ciRepairRounds: 1, seed: "d".repeat(40) }), h.deps);
    expect(h.index()).toEqual({ keys: [], reviewedHead: OLD, reviewedBase: BASE });
  });
  test("CI repair with another disqualifier or no prior index does not claim a review", async () => {
    for (const over of [{ reviewUnread: ["unread.ts"] }, { gateRepairRounds: 1 }, { reviewRan: false }]) {
      const h = harness({ index: oldIndex });
      await postItemThreads(input({ reviewRan: true, ciRepairRounds: 1, ...over }), h.deps);
      expect(h.index()).toEqual({ keys: [] });
    }
    const h = harness();
    await postItemThreads(input({ reviewRan: true, ciRepairRounds: 1 }), h.deps);
    expect(h.index()).toEqual({ keys: [] });
  });
  test("AC-8 replies with a closed marker and resolves obsolete own thread", async () => {
    const h = harness({ threads: true });
    expect(await postItemThreads(input(), h.deps)).toMatchObject({ closed: 1, failed: 0 });
    expect(h.writes[1]).toContain(`body=${marked("No longer open in the run at aaaaaaa.", `wc-${oldKey}`)}`);
    expect(h.writes[1]).toContain("repos/o/r/pulls/7/comments/10/replies");
    expect(h.writes[2]).toContain("id=T");
  });
  test("AC-9 an own closed reply prevents a duplicate, a foreign marker does not", async () => {
    const h = harness({ threads: true, closedAuthor: "bot" });
    expect(await postItemThreads(input(), h.deps)).toMatchObject({ closed: 0 });
    expect(h.writes).toHaveLength(1);
    const foreign = harness({ threads: true, closedAuthor: "other" });
    expect(await postItemThreads(input(), foreign.deps)).toMatchObject({ closed: 1 });
    expect(foreign.writes).toHaveLength(3);
  });
  test.each(["key=w-index", "/replies", "query=mutation"])(
    "AC-19 %s failure warns, counts and continues",
    async (fail) => {
      const h = harness({ threads: true, fail });
      const out = await postItemThreads(input(), h.deps);
      expect(out.failed).toBe(1);
      expect(logs.some((entry) => entry.level === "warn" && typeof entry.data?.itemId === "string")).toBe(true);
      expect(h.writes).toHaveLength(fail === "key=w-index" ? 1 : 3);
    },
  );
});
