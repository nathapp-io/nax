import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NaxError } from "@/errors";
import type { ForgeDeps } from "@/forge";
import { withNaxBotMarker } from "@/forge";
import type { LogEntry } from "@/logger";
import { addSink, initLogger, resetLogger } from "@/logger";
import { describeUnread } from "@/workflow/approval";
import { newFeatureRecord } from "@/workflow/feature-record";
import { _itemPublishPacerDeps, type ItemPublishConfig } from "@/workflow/item-publish-pacer";
import { itemKey, parseItemFiles, renderItemIndex, renderItemOpener } from "@/workflow/item-threads";
import type { ItemThreadsInput } from "@/workflow/item-threads-post";
import { postItemThreads } from "@/workflow/item-threads-post";
import type { OpenItem } from "@/workflow/types";

const cwds: string[] = [];
const finding = { id: "B1", kind: "spec", severity: "important", issue: "leak", file: "a.ts", line: 9 } as const;
const item: OpenItem = { ...finding, kind: "finding" };
const body = withNaxBotMarker(renderItemOpener(item), itemKey(item));
const prd = ".nax/features/demo/prd.json";
const input = (over: Partial<ItemThreadsInput> = {}): ItemThreadsInput => ({
  record: { ...newFeatureRecord({ now: "t", seed: "s", minors: [] }), reviewOpen: [finding] },
  url: "https://github.com/o/r/pull/7",
  projectDir: "/repo",
  feature: "demo",
  changedFiles: [prd, "first.ts"],
  ...over,
});

function threadReply(author?: string) {
  const nodes = author
    ? [
        {
          id: "T",
          isResolved: false,
          isOutdated: false,
          path: "a.ts",
          line: 9,
          comments: { nodes: [{ databaseId: 1, author: { login: author }, body, createdAt: "t" }] },
        },
      ]
    : [];
  return { data: { repository: { pullRequest: { reviewThreads: { nodes, pageInfo: { hasNextPage: false } } } } } };
}

function prReply(gitlab = false) {
  return gitlab
    ? {
        sha: "head",
        author: { username: "author" },
        diff_refs: { base_sha: "base", start_sha: "start", head_sha: "head" },
      }
    : { head: { sha: "head", ref: "feature" }, base: { ref: "main" }, user: { login: "author" } };
}

interface Rejection {
  /** Matched as a substring of any argument, like the assertions' `field`. */
  readonly match: string;
  /** How many matching writes are rejected before the rest succeed. */
  readonly times: number;
  readonly stderr: string;
}

interface HarnessOptions {
  gitlab?: boolean;
  failures?: number;
  threadsFail?: boolean;
  own?: string;
  /** An own `w-index` comment already on the PR. */
  indexBody?: string;
  /** An own `w-index` comment the PR carries only once an index write was attempted: a write that landed. */
  indexAfterWrite?: string;
  /** Raw stdout for the index write, for a reply `gh` prints but cannot parse. */
  indexStdout?: string;
  /** Pacing rejections the pacer may retry: a NaxError, so `isRetryableRejection` sees it. */
  reject?: readonly Rejection[];
  /** The readback that follows a failed index write fails too, so the PR cannot be consulted. */
  indexReadFails?: boolean;
}

const rejection = (stderr: string): NaxError =>
  new NaxError(`[forge] Cannot write o/r#7: ${stderr}`, "FORGE_COMMENT_WRITE_FAILED", { stage: "forge", stderr });

function harness(options: HarnessOptions = {}) {
  const writes: string[][] = [];
  const indexWrites: string[][] = [];
  const reads: string[][] = [];
  const rejections = (options.reject ?? []).map((r) => ({ ...r, left: r.times }));
  let failures = options.failures ?? 0;
  let indexAttempted = false;
  const ok = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: "" });
  const reject = (cmd: string[]) => {
    const hit = rejections.find((r) => r.left > 0 && cmd.some((arg) => arg.includes(r.match)));
    if (!hit) return;
    hit.left--;
    throw rejection(hit.stderr);
  };
  const indexReply = (cmd: string[]) => {
    indexWrites.push(cmd);
    indexAttempted = true;
    reject(cmd);
    if (options.indexStdout !== undefined) return { exitCode: 0, stdout: options.indexStdout, stderr: "" };
    return ok({ id: 99 });
  };
  const postReply = (cmd: string[]) => {
    writes.push(cmd);
    reject(cmd);
    if (failures-- > 0) throw new Error("post rejected");
    return ok(options.gitlab ? { id: "discussion", notes: [{ id: 1 }] } : { id: 1 });
  };
  const indexComment = (body: string) => ({ id: 9, user: { login: "bot" }, body, created_at: "t" });
  /** The issue-comment read: a write that landed shows up here even when its reply was unparseable. */
  const indexComments = () => {
    if (options.indexReadFails === true && indexAttempted) throw new Error("comments unreadable");
    const body = indexAttempted ? (options.indexAfterWrite ?? options.indexBody) : options.indexBody;
    return ok(body === undefined ? [] : [indexComment(body)]);
  };
  const readReply = (cmd: string[]) => {
    if (cmd[0] === "git")
      return {
        exitCode: 0,
        stdout: options.gitlab ? "git@gitlab.com:o/r.git" : "git@github.com:o/r.git",
        stderr: "",
      };
    if (cmd.includes("user")) return ok({ login: "bot", username: "bot", id: 1 });
    if (cmd.includes("graphql")) {
      if (options.threadsFail) throw new Error("threads unreadable");
      return ok(threadReply(options.own));
    }
    // Only the issue-comment read carries the index; a review summary is not editable.
    if (cmd.some((arg) => arg.includes("/issues/7/comments?per_page="))) return indexComments();
    if (cmd.some((arg) => arg.includes("?per_page="))) return ok([]);
    return ok(prReply(options.gitlab));
  };
  const deps: ForgeDeps = {
    readText: async () => null,
    run: async (cmd, opts) => {
      cwds.push(opts.cwd);
      // These tests assert item-opener mechanics; index writes have their own suite.
      if (cmd.some((arg) => arg.includes("key=w-index"))) return indexReply(cmd);
      if (cmd.includes("POST")) return postReply(cmd);
      reads.push(cmd);
      return readReply(cmd);
    },
  };
  return { deps, writes, indexWrites, reads };
}
const field = (cmd: string[] | undefined, name: string) => {
  const query = cmd?.find((arg) => arg.includes("?"))?.split("?")[1];
  return (
    cmd?.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ??
    new URLSearchParams(query).get(name) ??
    undefined
  );
};
/**
 * The expected outcome: `indexWritten`/`indexMissing` default to a written index, and the two cases
 * that expect otherwise (an unreadable PR, an unwritable index) pass the pair.
 */
const outcome = (
  posted = 0,
  failed = 0,
  skipped = 0,
  index: { readonly indexWritten: boolean; readonly indexMissing: boolean } = {
    indexWritten: true,
    indexMissing: false,
  },
) => ({ posted, closed: 0, skipped, failed, ...index });
const UNWRITTEN = { indexWritten: false, indexMissing: true } as const;
const realSleep = _itemPublishPacerDeps.sleep;
let sleeps: number[];
let logs: LogEntry[];
let removeSink: () => void;
beforeEach(() => {
  cwds.length = 0;
  sleeps = [];
  // The pacer's only timer: recording it keeps the default gap out of the suite's wall clock.
  _itemPublishPacerDeps.sleep = async (ms) => {
    sleeps.push(ms);
  };
  logs = [];
  initLogger({ level: "warn", suppressConsole: true });
  removeSink = addSink((entry) => {
    logs.push(entry);
  });
});
afterEach(() => {
  _itemPublishPacerDeps.sleep = realSleep;
  expect(cwds.every((cwd) => cwd === "/repo")).toBe(true);
  removeSink();
  resetLogger();
  expect(
    logs
      .filter(
        (entry) =>
          String(entry.message).includes("Initial PR read") || String(entry.message).includes("Cannot read PR number"),
      )
      .every((entry) => entry.data?.itemId === undefined),
  ).toBe(true);
});

describe("postItemThreads", () => {
  test("AC-1 posts every located item in order using PR head and GitLab diffRefs", async () => {
    const h = harness({ gitlab: true });
    const source = input();
    const result = await postItemThreads(
      {
        ...source,
        head: "not-the-pr-head",
        record: { ...source.record, reviewOpen: [finding, { ...finding, id: "B2", line: 12 }] },
      },
      h.deps,
    );
    expect(result).toEqual(outcome(2));
    expect(h.writes.map((cmd) => field(cmd, "position[new_line]"))).toEqual(["9", "12"]);
    for (const cmd of h.writes) {
      expect(field(cmd, "position[new_path]")).toBe("a.ts");
      expect(field(cmd, "position[head_sha]")).toBe("head");
      expect(field(cmd, "position[base_sha]")).toBe("base");
      expect(field(cmd, "position[start_sha]")).toBe("start");
    }
  });
  test("AC-2 posts the exact marked opener", async () => {
    const h = harness();
    expect(await postItemThreads(input(), h.deps)).toEqual(outcome(1));
    expect(field(h.writes[0], "body")).toBe(body);
    expect(field(h.writes[0], "commit_id")).toBe("head");
    expect(field(h.writes[0], "line")).toBe("9");
  });
  test.each([
    [1, "a.ts", "AC-3"],
    [2, prd, "AC-4"],
  ] as const)("%s failed attempts fall back to %s (%s)", async (failures, path) => {
    const h = harness({ failures });
    expect(await postItemThreads(input(), h.deps)).toEqual(outcome(1));
    expect(h.writes).toHaveLength(failures + 1);
    expect(field(h.writes.at(-1), "path")).toBe(path);
    expect(field(h.writes.at(-1), "subject_type")).toBe("file");
    expect(h.writes.map((cmd) => field(cmd, "body"))).toEqual(Array(failures + 1).fill(body));
    expect(logs.filter((entry) => entry.level === "warn")).toHaveLength(failures);
  });
  test.each([
    [["first.ts", prd], prd, "AC-5"],
    [["first.ts", "second.ts"], "first.ts", "AC-6"],
  ] as const)("unlocated anchor %j (%s, %s)", async (changedFiles, path) => {
    const h = harness();
    const source = input({ changedFiles });
    expect(
      await postItemThreads(
        { ...source, record: { ...source.record, reviewOpen: [], cannotVerify: ["check manually"] } },
        h.deps,
      ),
    ).toEqual(outcome(1));
    expect(field(h.writes[0], "path")).toBe(path);
  });
  test("AC-7 no GitHub anchor fails without posting", async () => {
    const h = harness();
    const source = input({ changedFiles: [] });
    expect(
      await postItemThreads(
        { ...source, record: { ...source.record, reviewOpen: [], cannotVerify: ["manual"] } },
        h.deps,
      ),
    ).toEqual(outcome(0, 1));
    expect(h.writes).toEqual([]);
  });
  test("AC-8 excludes CI", async () => {
    const h = harness();
    const source = input();
    expect(
      await postItemThreads({ ...source, record: { ...source.record, reviewOpen: [], ci: "failed" } }, h.deps),
    ).toEqual(outcome());
    expect(h.writes).toEqual([]);
  });
  test("AC-9 deduplicates own threads by key", async () => {
    const h = harness({ own: "bot" });
    expect(await postItemThreads(input(), h.deps)).toEqual(outcome(0, 0, 1));
    expect(h.writes).toEqual([]);
  });
  test("AC-10 skips invalid ids with warning", async () => {
    const h = harness();
    const source = input();
    expect(
      await postItemThreads(
        { ...source, record: { ...source.record, reviewOpen: [{ ...finding, id: "bad id" }] } },
        h.deps,
      ),
    ).toEqual(outcome(0, 0, 1));
    expect(h.writes).toEqual([]);
    expect(logs.some((entry) => entry.level === "warn" && entry.data?.itemId === "bad id")).toBe(true);
  });
  test("AC-11 initial thread read failure aborts posting and warns", async () => {
    const h = harness({ threadsFail: true });
    expect(await postItemThreads(input(), h.deps)).toEqual(outcome(0, 1, 0, UNWRITTEN));
    expect(h.writes).toEqual([]);
    expect(logs.some((entry) => entry.level === "warn")).toBe(true);
  });
  test("AC-12 exhausted item does not stop next item", async () => {
    const h = harness({ failures: 3 });
    const source = input();
    expect(
      await postItemThreads(
        { ...source, record: { ...source.record, reviewOpen: [finding, { ...finding, id: "B2" }] } },
        h.deps,
      ),
    ).toEqual(outcome(1, 1));
    expect(h.writes).toHaveLength(4);
    expect(field(h.writes[3], "body")).toContain("**B2**");
  });
  test("GitLab posts an unlocated discussion without changed files", async () => {
    const h = harness({ gitlab: true });
    const source = input({ changedFiles: [] });
    expect(
      await postItemThreads(
        { ...source, record: { ...source.record, reviewOpen: [], cannotVerify: ["manual"] } },
        h.deps,
      ),
    ).toEqual(outcome(1));
    expect(h.writes).toHaveLength(1);
    expect(field(h.writes[0], "body")).toContain("**_run:cv1**");
  });
  test("another author's marked thread does not suppress posting", async () => {
    const h = harness({ own: "other" });
    expect(await postItemThreads(input(), h.deps)).toEqual(outcome(1));
    expect(h.writes).toHaveLength(1);
  });
  test("invalid PR URL fails closed before forge I/O", async () => {
    const h = harness();
    expect(await postItemThreads(input({ url: "invalid" }), h.deps)).toEqual(outcome(0, 1, 0, UNWRITTEN));
    expect(h.reads).toEqual([]);
    expect(h.writes).toEqual([]);
  });
  test("AC-13 counts exhaustion once after three failures", async () => {
    const h = harness({ failures: 3 });
    expect(await postItemThreads(input(), h.deps)).toEqual(outcome(0, 1));
    expect(h.writes).toHaveLength(3);
    expect(logs.filter((entry) => entry.data?.itemId === "B1")).toHaveLength(3);
  });
  test("US-010 AC-11 posts the unread-files item and lists its files", async () => {
    const h = harness();
    const record = {
      ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
      reviewUnread: ["a.ts"],
      reasons: [describeUnread(["a.ts"])],
    };
    expect(await postItemThreads(input({ record }), h.deps)).toEqual(outcome(1));
    expect(h.writes).toHaveLength(1);
    expect(parseItemFiles(field(h.writes[0], "body") ?? "")).toEqual(["a.ts"]);
  });
});

const RATE_LIMIT =
  "gh: You have exceeded a secondary rate limit and have been temporarily blocked from content creation.";
const VALIDATION_422 = "gh: Validation Failed (HTTP 422)";
const BUDGET_SPENT = "[item-threads] Pacing budget spent; skipping remaining threads";

const pacing = (over: Partial<ItemPublishConfig> = {}): ItemPublishConfig => ({
  writeGapMs: 1000,
  retryBackoffMs: 60_000,
  maxRetries: 2,
  maxWaitMs: 300_000,
  ...over,
});

/** Postable items with no file and no line: every thread for them is a file-level post. */
const fileLevelRecord = (count: number) => ({
  ...input().record,
  reviewOpen: [],
  cannotVerify: Array.from({ length: count }, (_, i) => `check ${i + 1} manually`),
});

describe("postItemThreads item-publish pacing", () => {
  test("US-002 AC-1 retries a rejected file-level post after one pacing back-off", async () => {
    const h = harness({ reject: [{ match: "pulls/7/comments", times: 1, stderr: VALIDATION_422 }] });
    const source = input({ pacing: pacing(), record: fileLevelRecord(1) });
    expect(await postItemThreads(source, h.deps)).toEqual(outcome(1));
    expect(h.writes).toHaveLength(2);
    expect(sleeps.filter((ms) => ms === 60_000)).toEqual([60_000]);
  });
  test("US-002 AC-2 retries a rate-limited index write and reports it written", async () => {
    const h = harness({ reject: [{ match: "key=w-index", times: 1, stderr: RATE_LIMIT }] });
    const result = await postItemThreads(input({ pacing: pacing() }), h.deps);
    expect(result).toEqual(outcome(1));
    expect(h.indexWrites).toHaveLength(2);
  });
  test("US-002 AC-3 waits writeGapMs between consecutive thread posts", async () => {
    const h = harness();
    const source = input({ pacing: pacing({ writeGapMs: 1000 }), record: fileLevelRecord(3) });
    await postItemThreads(source, h.deps);
    expect(h.writes).toHaveLength(3);
    // The three thread posts precede the index write, so the first two waits are thread gaps.
    expect(sleeps.slice(0, 2)).toEqual([1000, 1000]);
    expect(h.indexWrites).toHaveLength(1);
  });
  test("US-002 AC-4 stops after the refused gap and names the threads it skipped", async () => {
    const h = harness();
    const source = input({ pacing: pacing({ maxWaitMs: 0, writeGapMs: 1 }), record: fileLevelRecord(3) });
    const result = await postItemThreads(source, h.deps);
    expect(result).toMatchObject({ posted: 1, failed: 2 });
    // The refused gap means neither later item reaches the forge.
    expect(h.writes).toHaveLength(1);
    const spent = logs.filter((entry) => entry.message === BUDGET_SPENT);
    expect(spent).toHaveLength(1);
    expect(spent[0]?.data?.skipped).toBe(2);
  });
  test("US-002 AC-5 still writes the index after the threads were skipped", async () => {
    const h = harness();
    const source = input({ pacing: pacing({ maxWaitMs: 0, writeGapMs: 1 }), record: fileLevelRecord(3) });
    const result = await postItemThreads(source, h.deps);
    expect(result).toMatchObject({ indexWritten: true, indexMissing: false });
    expect(h.indexWrites).toHaveLength(1);
  });
  test("US-002 AC-6 reports a missing index after maxRetries + 1 failed index posts", async () => {
    const h = harness({ reject: [{ match: "key=w-index", times: Number.POSITIVE_INFINITY, stderr: RATE_LIMIT }] });
    const result = await postItemThreads(input({ pacing: pacing({ maxRetries: 2 }) }), h.deps);
    expect(result).toMatchObject({ indexWritten: false, indexMissing: true });
    expect(h.indexWrites).toHaveLength(3);
  });
  test("US-002 AC-7 a failed edit of an own index leaves the index present but unwritten", async () => {
    const h = harness({
      indexBody: withNaxBotMarker(renderItemIndex({ keys: [] }), "w-index"),
      reject: [{ match: "key=w-index", times: Number.POSITIVE_INFINITY, stderr: RATE_LIMIT }],
    });
    const result = await postItemThreads(input({ pacing: pacing() }), h.deps);
    expect(result).toMatchObject({ indexWritten: false, indexMissing: false });
    expect(h.indexWrites).toHaveLength(3);
    expect(h.indexWrites.every((cmd) => cmd.includes("PATCH"))).toBe(true);
  });
  test("US-002 AC-8 does not retry an unparseable index write, and confirms the absence", async () => {
    const h = harness({ indexStdout: "not-json" });
    const result = await postItemThreads(input({ pacing: pacing() }), h.deps);
    expect(result).toMatchObject({ indexWritten: false, indexMissing: true });
    expect(h.indexWrites).toHaveLength(1);
    // A failed write cannot say whether it landed, so the absence is read back off the PR.
    expect(h.reads.filter((cmd) => cmd.some((a) => a.includes("/issues/7/comments?per_page=")))).toHaveLength(2);
  });
  test("US-002 AC-8 an unparseable reply from an index write that landed is not missing", async () => {
    const h = harness({
      indexStdout: "not-json",
      indexAfterWrite: withNaxBotMarker(renderItemIndex({ keys: [] }), "w-index"),
    });
    const result = await postItemThreads(input({ pacing: pacing() }), h.deps);
    expect(result).toMatchObject({ indexWritten: false, indexMissing: false });
    expect(h.indexWrites).toHaveLength(1);
  });
  test("US-002 AC-9 an unreadable PR reports one failure and no index", async () => {
    const h = harness({ threadsFail: true });
    expect(await postItemThreads(input(), h.deps)).toEqual({
      posted: 0,
      closed: 0,
      skipped: 0,
      failed: 1,
      indexWritten: false,
      indexMissing: true,
    });
    expect(h.writes).toEqual([]);
    expect(h.indexWrites).toEqual([]);
  });
  test("US-002 AC-11 absent pacing reads the workflow defaults", async () => {
    const h = harness();
    const source = input({ record: fileLevelRecord(2) });
    expect(source.pacing).toBeUndefined();
    await postItemThreads(source, h.deps);
    expect(h.writes).toHaveLength(2);
    expect(sleeps).toEqual([1000, 1000]);
  });
  test("US-002 AC-14 falls back from a rejected inline post with no back-off", async () => {
    const h = harness({ reject: [{ match: "line=9", times: 1, stderr: VALIDATION_422 }] });
    const result = await postItemThreads(input({ pacing: pacing() }), h.deps);
    expect(result).toEqual(outcome(1));
    expect(h.writes).toHaveLength(2);
    expect(field(h.writes[0], "line")).toBe("9");
    expect(field(h.writes[1], "subject_type")).toBe("file");
    expect(field(h.writes[1], "path")).toBe("a.ts");
    // The 422 is permanent, so the inline attempt takes the file post's gap but never a back-off.
    expect(sleeps).not.toContain(60_000);
  });
  test("US-002 AC-15 counts an item failed once the file-level retries are spent", async () => {
    const h = harness({
      reject: [{ match: "pulls/7/comments", times: Number.POSITIVE_INFINITY, stderr: VALIDATION_422 }],
    });
    const source = input({ pacing: pacing({ maxRetries: 2 }), record: fileLevelRecord(1) });
    const result = await postItemThreads(source, h.deps);
    expect(result).toMatchObject({ posted: 0, failed: 1, indexWritten: true });
    // One post and two retries; the budget permitted both back-offs, so nothing was cut short.
    expect(h.writes).toHaveLength(3);
    expect(sleeps.filter((ms) => ms === 60_000)).toHaveLength(2);
    expect(logs.some((entry) => entry.message === BUDGET_SPENT)).toBe(false);
  });
  // B1: a readback that fails says nothing about the index, so the failed write's own evidence has
  // to decide. Every index write here was *refused* by the forge, and nothing can have landed.
  test("B1 reports a refused index write as missing even when the readback fails", async () => {
    const h = harness({
      reject: [{ match: "key=w-index", times: Number.POSITIVE_INFINITY, stderr: RATE_LIMIT }],
      indexReadFails: true,
    });
    const result = await postItemThreads(input({ pacing: pacing({ maxRetries: 2 }) }), h.deps);
    expect(result).toMatchObject({ indexWritten: false, indexMissing: true });
    expect(h.indexWrites).toHaveLength(3);
  });
  // B1: the other half of the same rule. A write that may have landed plus an unreadable PR leaves
  // the index unknown; claiming it present would clear a genuine earlier warning at run end.
  test("B1 leaves the index unconfirmed when the write may have landed and the readback fails", async () => {
    const h = harness({ indexStdout: "not-json", indexReadFails: true });
    const result = await postItemThreads(input({ pacing: pacing() }), h.deps);
    expect(result).toMatchObject({ indexWritten: false });
    expect(result).not.toHaveProperty("indexMissing");
    expect(h.indexWrites).toHaveLength(1);
  });
});
