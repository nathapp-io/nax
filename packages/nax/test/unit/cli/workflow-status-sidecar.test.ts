/**
 * US-004 (item-publish-pacing): `nax workflow status` on a run-record fallback.
 *
 * When the live PR read fails, the report settles the run's open and supplementary items from the
 * run's newest decisions sidecar, names the sidecar in `decisions`, reports a `promoted` or
 * `verified-ready` sidecar as ready, and surfaces the record's own missing item index. The command
 * stays read-only and a live read that succeeds keeps the live report authoritative, so a sidecar is
 * read on the failed-live path only.
 *
 * Every scenario enters at `workflowStatusCommand` — the surface a finishing tool calls — with only
 * the forge and the output directory swapped, so the assertions read the report the command emits.
 * The run tree spells its path out (`.nax/features/auth/workflow/r1/`) rather than deriving it with
 * `workflowFeatureDir`, for the reason `workflow-status.test.ts` gives.
 */
import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { _workflowForgeDeps, type WorkflowCliDeps, type WorkflowForgeDeps, workflowStatusCommand } from "@/cli";
import { type ForgeDeps, type ForgeRunResult, withNaxBotMarker } from "@/forge";
import type { OpenItem, WorkflowFeatureRecord } from "@/workflow";
import {
  type DecisionEntry,
  type DecisionsSidecar,
  type SidecarOutcome,
  sidecarFileName,
  writeSidecar,
} from "@/workflow/decisions-sidecar";
import { newFeatureRecord } from "@/workflow/feature-record";
import { itemKey, renderItemIndex, renderItemOpener, renderRulingEcho } from "@/workflow/item-threads";

const FEATURE = "auth";
const RUN_ID = "r1";
const URL = "https://github.com/o/r/pull/7";
const NOW = "2026-10-13T09:12:00.417Z";
const SIDECAR_NAME = sidecarFileName(new Date(NOW));
/** The open item the fixtures' `cannotVerify` line produces. */
const CV: OpenItem = { id: "_run:cv1", kind: "cannot-verify", issue: "manual check" };
/** The open item a held finish-approval produces. */
const ADVISOR: OpenItem = { id: "D-1", kind: "advisor", issue: "needs change" };

const workflowDir = (dir: string): string => join(dir, ".nax", "features", FEATURE, "workflow");
const runDirOf = (dir: string): string => join(workflowDir(dir), RUN_ID);
/** The sidecar path as the report names it: relative to the project directory. */
const SIDECAR_REPORT_PATH = join(".nax", "features", FEATURE, "workflow", RUN_ID, SIDECAR_NAME);

const MISSING_INDEX_LINE = `item index not written; settle items with nax workflow record -f ${FEATURE}`;

/** The fixture record: a published draft holding the CV item, exactly as a run writes it. */
function record(over: Partial<WorkflowFeatureRecord> = {}): WorkflowFeatureRecord {
  return {
    ...newFeatureRecord({ now: NOW, seed: null, minors: [] }),
    step: "done",
    outcome: "draft",
    url: URL,
    ci: "green",
    cannotVerify: [CV.issue],
    ...over,
  };
}

function entry(id: string, kind: DecisionEntry["kind"], disposition: DecisionEntry["disposition"]): DecisionEntry {
  return { id, kind, disposition, reason: `${id} ruled` };
}

/** The default sidecar: the CV item waived. */
const WAIVED: readonly DecisionEntry[] = [entry(CV.id, "cannot-verify", "waived")];

interface Options {
  readonly record?: Partial<WorkflowFeatureRecord>;
  /** The sidecar's entries. Default: `_run:cv1` waived. */
  readonly decisions?: readonly DecisionEntry[];
  readonly sidecarOutcome?: SidecarOutcome;
  /** `"broken"` writes a file wearing the sidecar name that does not parse; `"none"` writes none. */
  readonly sidecar?: "valid" | "broken" | "none";
  /** What the live PR read does. Default `"fails"`. */
  readonly live?: "fails" | "succeeds";
  /** Write a run ledger line, which the report lists as the supplementary item `US-001:cv1`. */
  readonly ledger?: boolean;
}

const ok = (data: unknown): ForgeRunResult => ({ exitCode: 0, stdout: JSON.stringify(data), stderr: "" });

/** The `w-index` comment the live read needs; without one it reports "no nax item index". */
function indexComment(): unknown {
  const keys = [itemKey(CV)];
  return {
    id: 9,
    user: { login: "nax" },
    created_at: NOW,
    body: withNaxBotMarker(renderItemIndex({ keys }), "w-index"),
  };
}

/** One review thread on the CV item carrying a `fixed` ruling echo, as a ruled PR holds it. */
function ruledThread(): unknown {
  const key = itemKey(CV);
  const comment = (body: string) => ({ databaseId: 1, author: { login: "nax" }, body, createdAt: NOW });
  const echo = renderRulingEcho({
    itemKey: key,
    itemId: CV.id,
    disposition: "fixed",
    reason: "addressed",
    sha: "abcdef1",
    by: "alice",
  });
  return {
    id: key,
    isResolved: true,
    isOutdated: false,
    path: "a.ts",
    line: 1,
    originalLine: 1,
    comments: {
      nodes: [comment(withNaxBotMarker(renderItemOpener(CV), key)), comment(withNaxBotMarker(echo, `wr-fixed-${key}`))],
    },
  };
}

function threadsResponse(): unknown {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: { nodes: [ruledThread()], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
    },
  };
}

/** The forge stub: a failing live read throws on everything but the remote, a succeeding one answers. */
function forgeFor(live: "fails" | "succeeds"): ForgeDeps {
  return {
    readText: async () => null,
    run: async (argv) => {
      if (argv[0] === "git") return { exitCode: 0, stdout: "git@github.com:o/r.git", stderr: "" };
      if (live === "fails") throw new Error("forge offline");
      if (argv.includes("view")) return ok({ isDraft: false, body: "" });
      if (argv.includes("graphql")) return ok(threadsResponse());
      const endpoint = argv.at(-1) ?? "";
      if (endpoint === "user") return ok({ login: "nax", id: 1 });
      if (endpoint.includes("/issues/7/comments?")) return ok([indexComment()]);
      if (endpoint.includes("/reviews?")) return ok([]);
      throw new Error(`Unexpected forge command: ${argv.join(" ")}`);
    },
  };
}

/** The sidecar file the fixture writes, in the shape `newestSidecar` validates on read. */
async function writeSidecarFile(dir: string, options: Options): Promise<void> {
  const mode = options.sidecar ?? "valid";
  if (mode === "none") return;
  const path = join(runDirOf(dir), SIDECAR_NAME);
  if (mode === "broken") {
    await Bun.write(path, JSON.stringify({ feature: FEATURE, decisions: "not an array" }));
    return;
  }
  const sidecar: DecisionsSidecar = {
    artifact: `${RUN_ID}/result.json`,
    feature: FEATURE,
    resumedAt: NOW,
    reasons: [],
    decisions: options.decisions ?? WAIVED,
    outcome: options.sidecarOutcome ?? "pending",
    url: URL,
  };
  await writeSidecar(path, sidecar);
}

async function fixture(dir: string, options: Options = {}) {
  const runDir = runDirOf(dir);
  await mkdir(runDir, { recursive: true });
  await Bun.write(
    join(runDir, "result.json"),
    JSON.stringify({
      schemaVersion: 1,
      runId: RUN_ID,
      feature: FEATURE,
      stories: {},
      featureWorkflow: record(options.record ?? {}),
    }),
  );
  if (options.ledger === true) await Bun.write(join(runDir, "ledger.md"), "US-001: cannot-verify: Redis TTL\n");
  await writeSidecarFile(dir, options);
  const forgeDeps: WorkflowForgeDeps = {
    ..._workflowForgeDeps,
    forge: forgeFor(options.live ?? "fails"),
    resolveOutputDir: async () => join(dir, "out"),
  };
  async function invoke(json = true): Promise<{ code: number; out: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const deps: WorkflowCliDeps = {
      log: (text) => out.push(text),
      logErr: (text) => err.push(text),
      exit: () => {},
    };
    const code = await workflowStatusCommand({ dir, feature: FEATURE, json }, deps, forgeDeps);
    expect(err).toEqual([]);
    return { code, out };
  }
  async function report(): Promise<{ code: number; value: Record<string, unknown> }> {
    const { code, out } = await invoke();
    expect(out).toHaveLength(1);
    // JSON.parse is `any`; the declared return type narrows it, so no cast is needed.
    const value: Record<string, unknown> = JSON.parse(out[0] ?? "null");
    return { code, value };
  }
  return { invoke, report };
}

/** The ids one of the report's item lists holds, read out of the printed JSON. */
function idsIn(value: Record<string, unknown>, field: "openItems" | "supplementaryItems"): string[] {
  const listed = value[field];
  if (!Array.isArray(listed)) throw new Error(`${field} is not an array: ${JSON.stringify(listed)}`);
  return listed.map((item: unknown) => {
    if (typeof item !== "object" || item === null || !("id" in item)) {
      throw new Error(`${field} holds something with no id: ${JSON.stringify(item)}`);
    }
    return String(item.id);
  });
}

const itemIds = (value: Record<string, unknown>): string[] => idsIn(value, "openItems");

describe("nax workflow status — a settled run-record fallback", () => {
  test("AC-1: a waived sidecar entry settles the open item it names", async () => {
    await withTempDir(async (dir) => {
      const { code, value } = await (await fixture(dir)).report();
      expect(value.settledItems).toEqual([{ id: CV.id, disposition: "waived" }]);
      expect(itemIds(value)).toEqual([]);
      // The record's own outcome is untouched: a waiver settles an item, it does not promote the PR.
      expect(value.outcome).toBe("draft");
      expect(code).toBe(2);
    });
  });

  test("AC-2: the fallback keeps its source and error and names the sidecar it applied", async () => {
    await withTempDir(async (dir) => {
      const { value } = await (await fixture(dir)).report();
      expect(value.source).toBe("run-record");
      expect(value.liveError).toEqual(expect.stringContaining("forge offline"));
      expect(value.decisions).toBe(SIDECAR_REPORT_PATH);
    });
  });

  test("AC-3: a promoted sidecar reports the run as ready", async () => {
    await withTempDir(async (dir) => {
      const { value } = await (await fixture(dir, { sidecarOutcome: "promoted" })).report();
      expect(value.outcome).toBe("ready");
      expect(value.settledItems).toEqual([{ id: CV.id, disposition: "waived" }]);
      expect(itemIds(value)).toEqual([]);
    });
  });

  test.each([
    { sidecarOutcome: "verified-ready", expected: "ready" },
    { sidecarOutcome: "pending", expected: "draft" },
    { sidecarOutcome: "abandoned", expected: "draft" },
  ] as const)("AC-4: a $sidecarOutcome sidecar reports the outcome $expected", async ({ sidecarOutcome, expected }) => {
    await withTempDir(async (dir) => {
      const { value } = await (await fixture(dir, { sidecarOutcome })).report();
      expect(value.outcome).toBe(expected);
    });
  });

  test("AC-5: a sidecar entry settles a supplementary item out of supplementaryItems", async () => {
    await withTempDir(async (dir) => {
      const decisions = [entry("US-001:cv1", "cannot-verify", "waived")];
      const { value } = await (await fixture(dir, { ledger: true, decisions })).report();
      expect(idsIn(value, "supplementaryItems")).toEqual([]);
      expect(value.settledItems).toEqual([{ id: "US-001:cv1", disposition: "waived" }]);
      // The open item the sidecar says nothing about stays open.
      expect(itemIds(value)).toEqual([CV.id]);
    });
  });

  test("AC-6: an entry naming no item is ignored, and the report is the one without it", async () => {
    const ready = { outcome: "ready", passed: true } as const;
    const known = [entry(CV.id, "cannot-verify", "waived")];
    const withUnknown = await withTempDir(async (dir) => {
      const decisions = [...known, entry("_run:zzz", "cannot-verify", "waived")];
      return await (await fixture(dir, { record: ready, decisions })).report();
    });
    const withoutUnknown = await withTempDir(async (dir) =>
      (await fixture(dir, { record: ready, decisions: known })).report(),
    );
    expect(withUnknown.value).toEqual(withoutUnknown.value);
    expect(withUnknown.value.settledItems).toEqual([{ id: CV.id, disposition: "waived" }]);
    expect(itemIds(withUnknown.value)).toEqual([]);
    expect(withUnknown.code).toBe(withoutUnknown.code);
    expect(withUnknown.code).toBe(0);
  });

  test.each(["broken", "none"] as const)("AC-7: a %s sidecar leaves the run-record report alone", async (sidecar) => {
    await withTempDir(async (dir) => {
      const { value } = await (await fixture(dir, { sidecar })).report();
      expect(value.source).toBe("run-record");
      expect(value.liveError).toEqual(expect.stringContaining("forge offline"));
      expect(value).not.toHaveProperty("decisions");
      expect(value.settledItems).toEqual([]);
      expect(itemIds(value)).toEqual([CV.id]);
    });
  });

  test("AC-11: a promoted sidecar that settles the last open item leaves nothing open, and exits 0", async () => {
    await withTempDir(async (dir) => {
      const { code, value } = await (
        await fixture(dir, { record: { ci: "failed" }, sidecarOutcome: "promoted" })
      ).report();
      expect(value.settledItems).toEqual([{ id: CV.id, disposition: "waived" }]);
      // The CI item goes too: the sidecar's ready outcome is the live read's ready-PR rule.
      expect(itemIds(value)).toEqual([]);
      expect(value.outcome).toBe("ready");
      expect(code).toBe(0);
    });
  });

  test("AC-12: an entry whose kind is not the item's own settles nothing", async () => {
    await withTempDir(async (dir) => {
      const approval = { approved: false, rationale: ADVISOR.issue, decisionId: ADVISOR.id };
      // One mismatched entry for the CV item, one matching entry beside it: the mismatch is filtered,
      // not the whole file, so the matching entry still settles its own item.
      const decisions = [entry(CV.id, "finding", "waived"), entry(ADVISOR.id, "advisor", "confirmed")];
      const { value } = await (await fixture(dir, { record: { approval }, decisions })).report();
      expect(itemIds(value)).toEqual([CV.id]);
      expect(value.settledItems).toEqual([{ id: ADVISOR.id, disposition: "confirmed" }]);
    });
  });

  test("AC-13: a confirmed advisor entry settles the advisor item", async () => {
    await withTempDir(async (dir) => {
      const approval = { approved: false, rationale: ADVISOR.issue, decisionId: ADVISOR.id };
      const decisions = [entry(ADVISOR.id, "advisor", "confirmed")];
      // The held approval is the run's only open item, so settling it empties the list.
      const { value } = await (await fixture(dir, { record: { approval, cannotVerify: [] }, decisions })).report();
      expect(itemIds(value)).toEqual([]);
      expect(value.settledItems).toEqual([{ id: ADVISOR.id, disposition: "confirmed" }]);
    });
  });
});

describe("nax workflow status — the recorded missing item index", () => {
  test("AC-8: itemIndexMissing: true is reported with and without a live read", async () => {
    const published = await withTempDir(async (dir) =>
      (await fixture(dir, { record: { itemIndexMissing: true }, sidecar: "none" })).report(),
    );
    expect(published.value.itemIndexMissing).toBe(true);
    expect(published.value.source).toBe("run-record");
    const unpublished = await withTempDir(async (dir) =>
      (await fixture(dir, { record: { itemIndexMissing: true, url: undefined }, sidecar: "none" })).report(),
    );
    expect(unpublished.value.itemIndexMissing).toBe(true);
    expect(unpublished.value).not.toHaveProperty("liveError");
    // The flag is the record's, so a live read that succeeds reports it too.
    const live = await withTempDir(async (dir) =>
      (await fixture(dir, { record: { itemIndexMissing: true }, sidecar: "none", live: "succeeds" })).report(),
    );
    expect(live.value.source).toBe("live");
    expect(live.value.itemIndexMissing).toBe(true);
  });

  test("AC-9: the plain output names the feature and how to settle its items", async () => {
    await withTempDir(async (dir) => {
      const plain = await (
        await fixture(dir, { record: { itemIndexMissing: true, url: undefined, cannotVerify: [] }, sidecar: "none" })
      ).invoke(false);
      expect(plain.out).toEqual([`${FEATURE}: draft`, MISSING_INDEX_LINE, "No open items."]);
      expect(plain.code).toBe(2);
    });
  });

  test("AC-14: itemIndexMissing: false adds no key", async () => {
    await withTempDir(async (dir) => {
      const { value } = await (await fixture(dir, { record: { itemIndexMissing: false }, sidecar: "none" })).report();
      expect(value).not.toHaveProperty("itemIndexMissing");
    });
  });
});

describe("nax workflow status — a live read that succeeds", () => {
  test("AC-10: the live read stays authoritative and no sidecar is read", async () => {
    await withTempDir(async (dir) => {
      const { code, value } = await (await fixture(dir, { live: "succeeds" })).report();
      expect(value.source).toBe("live");
      expect(value).not.toHaveProperty("liveError");
      // The sidecar says waived; the PR's own ruling echo says fixed, and the live read wins.
      expect(value.settledItems).toEqual([{ id: CV.id, disposition: "fixed" }]);
      expect(value).not.toHaveProperty("decisions");
      expect(itemIds(value)).toEqual([]);
      expect(value.outcome).toBe("ready");
      expect(code).toBe(0);
    });
  });

  test("a live read ignores a sidecar that does not parse too", async () => {
    await withTempDir(async (dir) => {
      const { value } = await (await fixture(dir, { live: "succeeds", sidecar: "broken" })).report();
      expect(value.source).toBe("live");
      expect(value).not.toHaveProperty("decisions");
    });
  });
});
