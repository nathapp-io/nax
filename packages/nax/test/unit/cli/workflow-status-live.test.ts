import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { type WorkflowCliDeps, workflowStatusCommand } from "@/cli/workflow";
import { _workflowForgeDeps } from "@/cli/workflow-forge";
import { type ForgeDeps, withNaxBotMarker } from "@/forge";
import { newFeatureRecord } from "@/workflow/feature-record";
import { itemKey, renderItemIndex, renderItemOpener, renderRulingEcho } from "@/workflow/item-threads";
import type { OpenItem, WorkflowFeatureRecord } from "@/workflow/types";

const URL = "https://github.com/o/r/pull/7";
const CV: OpenItem = { id: "_run:cv1", kind: "cannot-verify", issue: "manual check" };
const ADVISOR: OpenItem = { id: "D-1", kind: "advisor", issue: "needs change" };
const NOW = "2026-10-13T09:12:00Z";
type Options = {
  isDraft?: boolean;
  cvRuled?: boolean;
  advisorRuling?: "fixed" | "confirmed";
  failure?: "missing-index" | "offline" | "undetected";
  record?: Partial<WorkflowFeatureRecord>;
};

function record(overrides: Partial<WorkflowFeatureRecord> = {}): WorkflowFeatureRecord {
  return {
    ...newFeatureRecord({ now: NOW, seed: null, minors: [] }),
    step: "done",
    outcome: "draft",
    url: URL,
    ci: "green",
    passed: true,
    cannotVerify: [CV.issue],
    approval: { approved: false, rationale: ADVISOR.issue, decisionId: ADVISOR.id },
    ...overrides,
  };
}

function thread(item: OpenItem, disposition?: "fixed" | "confirmed") {
  const key = itemKey(item);
  const comment = (body: string) => ({ databaseId: 1, author: { login: "nax" }, body, createdAt: NOW });
  const comments = [comment(withNaxBotMarker(renderItemOpener(item), key))];
  if (disposition)
    comments.push(
      comment(
        withNaxBotMarker(
          renderRulingEcho({
            itemKey: key,
            itemId: item.id,
            disposition,
            reason: "addressed",
            sha: "abcdef1",
            by: "alice",
          }),
          `wr-${disposition}-${key}`,
        ),
      ),
    );
  return {
    id: key,
    isResolved: true,
    isOutdated: false,
    path: "a.ts",
    line: 1,
    originalLine: 1,
    comments: { nodes: comments },
  };
}

function reviewThreadsResponse(options: Options) {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              thread(CV, options.cvRuled === false ? undefined : "fixed"),
              thread(ADVISOR, options.advisorRuling ?? "fixed"),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  };
}

function indexComments(options: Options) {
  if (options.failure === "missing-index") return [];
  return [
    {
      id: 9,
      user: { login: "nax" },
      created_at: NOW,
      body: withNaxBotMarker(renderItemIndex({ keys: [itemKey(CV), itemKey(ADVISOR)] }), "w-index"),
    },
  ];
}

function forgeResponse(argv: readonly string[], options: Options) {
  const ok = (data: unknown) => ({ exitCode: 0, stdout: JSON.stringify(data), stderr: "" });
  if (argv[0] === "git")
    return {
      exitCode: 0,
      stdout: options.failure === "undetected" ? "git@unknown.test:o/r.git" : "git@github.com:o/r.git",
      stderr: "",
    };
  if (options.failure === "offline") throw new Error("forge offline");
  if (argv.includes("--version")) return { exitCode: 1, stdout: "", stderr: "unavailable" };
  if (argv.includes("view")) return ok({ isDraft: options.isDraft ?? false, body: "" });
  if (argv.includes("graphql")) return ok(reviewThreadsResponse(options));
  const endpoint = argv.at(-1) ?? "";
  if (endpoint === "user") return ok({ login: "nax", id: 1 });
  if (endpoint.includes("/issues/7/comments?")) return ok(indexComments(options));
  if (endpoint.includes("/reviews?")) return ok([]);
  throw new Error(`Unexpected forge command: ${argv.join(" ")}`);
}

function forge(options: Options) {
  const calls: string[][] = [];
  const deps: ForgeDeps = {
    readText: async () => null,
    run: async (argv) => {
      calls.push(argv);
      return forgeResponse(argv, options);
    },
  };
  return { deps, calls };
}

async function fixture(dir: string, options: Options = {}) {
  const runDir = join(dir, ".nax", "features", "auth", "workflow", "r1");
  const file = join(runDir, "result.json");
  await Bun.write(
    file,
    JSON.stringify({
      schemaVersion: 1,
      runId: "r1",
      feature: "auth",
      stories: {},
      featureWorkflow: record(options.record),
    }),
  );
  // A nonempty supplementary list proves the overlay preserves it, not just an empty default.
  await Bun.write(join(runDir, "ledger.md"), "US-001: cannot-verify: Redis TTL\n");
  const fx = forge(options);
  const forgeDeps = { ..._workflowForgeDeps, forge: fx.deps, resolveOutputDir: async () => join(dir, "out") };
  async function invoke(json = true) {
    const out: string[] = [];
    const err: string[] = [];
    const deps: WorkflowCliDeps = { log: (s) => out.push(s), logErr: (s) => err.push(s), exit: () => {} };
    const code = await workflowStatusCommand({ dir, feature: "auth", json }, deps, forgeDeps);
    expect(err).toEqual([]);
    return { code, out };
  }
  async function report() {
    const result = await invoke();
    expect(result.out).toHaveLength(1);
    const value: Record<string, unknown> = JSON.parse(result.out[0] ?? "null");
    return { ...result, value };
  }
  return { ...fx, invoke, report, file };
}

function expectLive(value: Record<string, unknown>) {
  expect(value.source).toBe("live");
  expect(value).not.toHaveProperty("liveError");
}

describe("workflowStatusCommand live overlay", () => {
  test("AC-1/2/17/18: ready PR with both rulings exits zero and exposes live settlement", async () => {
    await withTempDir(async (dir) => {
      const fx = await fixture(dir);
      const { code, value } = await fx.report();
      expect(code).toBe(0);
      expectLive(value);
      expect(value.outcome).toBe("ready");
      expect(value.openItems).toEqual([]);
      expect(value.settledItems).toEqual([
        { id: CV.id, disposition: "fixed" },
        { id: ADVISOR.id, disposition: "fixed" },
      ]);
    });
  });
  test("AC-3/4: draft PR with only advisor ruled keeps cannot-verify and exits two", async () => {
    await withTempDir(async (dir) => {
      const { code, value } = await (await fixture(dir, { isDraft: true, cvRuled: false })).report();
      expectLive(value);
      expect(value.openItems).toEqual([CV]);
      expect(value.outcome).toBe("draft");
      expect(code).toBe(2);
    });
  });
  test("AC-5: fully ruled draft remains draft and exits two", async () => {
    await withTempDir(async (dir) => {
      const { code, value } = await (await fixture(dir, { isDraft: true })).report();
      expectLive(value);
      expect(value.openItems).toEqual([]);
      expect(value.outcome).toBe("draft");
      expect(code).toBe(2);
    });
  });
  test.each([true, false])("AC-6/7: outstanding confirmed advisor stays open, draft=%s", async (isDraft) => {
    await withTempDir(async (dir) => {
      const { code, value } = await (await fixture(dir, { isDraft, advisorRuling: "confirmed" })).report();
      expectLive(value);
      expect(value.openItems).toEqual([ADVISOR]);
      expect(value.outcome).toBe(isDraft ? "draft" : "ready");
      expect(value.settledItems).toEqual([{ id: CV.id, disposition: "fixed" }]);
      expect(code).toBe(2);
    });
  });
  test.each(["missing-index", "offline", "undetected"] as const)(
    "AC-8/9/18/19: %s failure preserves snapshot and prints diagnostic",
    async (failure) => {
      await withTempDir(async (dir) => {
        const fx = await fixture(dir, { failure });
        const { value, code } = await fx.report();
        expect(value.source).toBe("run-record");
        const message =
          failure === "missing-index"
            ? "no nax item index on this PR"
            : failure === "offline"
              ? "forge offline"
              : "Cannot determine forge";
        expect(value.liveError).toEqual(expect.stringContaining(message));
        const baseline = await fixture(dir, { record: { url: "https://gh/pr/7" } });
        const snapshot = await baseline.report();
        expect(value).toEqual({ ...snapshot.value, url: URL, liveError: value.liveError });
        expect(value.settledItems).toEqual([]);
        expect(code).toBe(snapshot.code);
        expect(code).toBe(2);
        // Restore the eligible URL before testing the plain command.
        const plain = await (await fixture(dir, { failure })).invoke(false);
        expect(plain.out[1]).toBe(`(run record only: ${value.liveError})`);
      });
    },
  );
  test.each([
    { outcome: "ready", url: URL },
    { outcome: "draft", url: undefined },
    { outcome: "draft", url: "https://gh/pr/7" },
  ] as const)("AC-10/11/12/17/18: ineligible $outcome $url never invokes forge", async (record) => {
    await withTempDir(async (dir) => {
      const fx = await fixture(dir, { record });
      const { value } = await fx.report();
      expect(value.source).toBe("run-record");
      expect(value).not.toHaveProperty("liveError");
      expect(value.settledItems).toEqual([]);
      expect((await fx.invoke(false)).out.join("\n")).not.toContain("(run record only:");
      expect(fx.calls).toEqual([]);
    });
  });
  test.each([true, false])(
    "AC-13/14/15/16: preserves snapshot fields and handles CI item, draft=%s",
    async (isDraft) => {
      await withTempDir(async (dir) => {
        const snapshotRecord = { ci: "failed", reasons: ["CI failed"], step: "publish" } as const;
        const baseline = await fixture(dir, {
          record: { ...snapshotRecord, reasons: [...snapshotRecord.reasons], url: "https://gh/pr/7" },
        });
        const snapshot = (await baseline.report()).value;
        const fx = await fixture(dir, { isDraft, record: { ...snapshotRecord, reasons: [...snapshotRecord.reasons] } });
        const { value } = await fx.report();
        expectLive(value);
        for (const field of ["workflowPassed", "reasons", "ci", "step", "supplementaryItems"])
          expect(value[field]).toEqual(snapshot[field]);
        expect(value.supplementaryItems).toEqual([{ id: "US-001:cv1", kind: "cannot-verify", issue: "Redis TTL" }]);
        expect(value.openItems).toEqual(isDraft ? [{ id: "_run:ci", kind: "ci", issue: "CI failed" }] : []);
      });
    },
  );
  test("AC-20/21/22: repeated reports are identical and all forge commands are read-only", async () => {
    await withTempDir(async (dir) => {
      const fx = await fixture(dir);
      const before = await Bun.file(fx.file).text();
      const first = await fx.report();
      const second = await fx.report();
      expectLive(first.value);
      expect(second).toEqual(first);
      const plain = await fx.invoke(false);
      expect(plain.out).toEqual([
        `auth: ready ${URL}`,
        "No open items.",
        "Also to verify (not blocking):",
        "- [cannot-verify] US-001:cv1 — Redis TTL",
      ]);
      expect(fx.calls.length).toBeGreaterThan(0);
      for (const argv of fx.calls) {
        const readOnly =
          argv[0] === "git"
            ? argv.slice(1).join(" ") === "remote get-url origin"
            : argv[0] === "gh" &&
              (argv[1] === "api"
                ? !argv.some((arg) => /mutation|POST|PATCH|PUT|DELETE/.test(arg))
                : argv[1] === "pr" && argv[2] === "view");
        expect(readOnly).toBe(true);
      }
      expect(await Bun.file(fx.file).text()).toBe(before);
    });
  });
});
