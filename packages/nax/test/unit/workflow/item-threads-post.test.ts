import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ForgeDeps } from "@/forge";
import { withNaxBotMarker } from "@/forge";
import type { LogEntry } from "@/logger";
import { addSink, initLogger, resetLogger } from "@/logger";
import { newFeatureRecord } from "@/workflow/feature-record";
import { itemKey, renderItemOpener } from "@/workflow/item-threads";
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

function harness(options: { gitlab?: boolean; failures?: number; threadsFail?: boolean; own?: string } = {}) {
  const writes: string[][] = [];
  const reads: string[][] = [];
  let failures = options.failures ?? 0;
  const ok = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: "" });
  const post = (cmd: string[]) => {
    writes.push(cmd);
    if (failures-- > 0) throw new Error("post rejected");
    return ok(options.gitlab ? { id: "discussion", notes: [{ id: 1 }] } : { id: 1 });
  };
  const deps: ForgeDeps = {
    readText: async () => null,
    run: async (cmd, opts) => {
      cwds.push(opts.cwd);
      // These tests assert item-opener mechanics; index writes have their own suite.
      if (cmd.some((arg) => arg.includes("key=w-index"))) return ok({ id: 99 });
      if (cmd.includes("POST")) return post(cmd);
      reads.push(cmd);
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
      if (cmd.some((arg) => arg.includes("?per_page="))) return ok([]);
      return ok(prReply(options.gitlab));
    },
  };
  return { deps, writes, reads };
}
const field = (cmd: string[] | undefined, name: string) => {
  const query = cmd?.find((arg) => arg.includes("?"))?.split("?")[1];
  return (
    cmd?.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ??
    new URLSearchParams(query).get(name) ??
    undefined
  );
};
const outcome = (posted = 0, failed = 0, skipped = 0) => ({ posted, closed: 0, skipped, failed });
let logs: LogEntry[];
let removeSink: () => void;
beforeEach(() => {
  cwds.length = 0;
  logs = [];
  initLogger({ level: "warn", suppressConsole: true });
  removeSink = addSink((entry) => {
    logs.push(entry);
  });
});
afterEach(() => {
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
    expect(await postItemThreads(input(), h.deps)).toEqual(outcome(0, 1));
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
    expect(await postItemThreads(input({ url: "invalid" }), h.deps)).toEqual(outcome(0, 1));
    expect(h.reads).toEqual([]);
    expect(h.writes).toEqual([]);
  });
  test("AC-13 counts exhaustion once after three failures", async () => {
    const h = harness({ failures: 3 });
    expect(await postItemThreads(input(), h.deps)).toEqual(outcome(0, 1));
    expect(h.writes).toHaveLength(3);
    expect(logs.filter((entry) => entry.data?.itemId === "B1")).toHaveLength(3);
  });
});
