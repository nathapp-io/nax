/** What the approval advisor is told about a feature before it rules on readiness. */
import { afterEach, describe, expect, test } from "bun:test";
import { makeAdviceDecision, makeFeatureContext } from "@test/helpers";
import type { Advisor } from "@/advisor";
import type { OpenOrPromoteArgs } from "@/finish/pr/open";
import type { ForgeDeps } from "@/forge";
import { _ciWaitDeps, type CiWaitResult } from "@/workflow/ci-wait";
import { _featureDeps } from "@/workflow/feature-deps";
import { newFeatureRecord } from "@/workflow/feature-record";
import { approvalEvidence, type ChangedFilesEvidence, type PublishInput, publish } from "@/workflow/finalize";
import { _workflowDeps } from "@/workflow/step-context";
import type { MinorItem } from "@/workflow/types";

const record = {
  ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
  reviewRan: true,
  finalGates: { ran: ["test"], failing: [] },
};
const ci = { outcome: "green", detail: "3/3" } as const;
const NO_FILES: ChangedFilesEvidence = { kind: "files", files: [] };
const UNRESOLVED: ChangedFilesEvidence = { kind: "unavailable", reason: "no base commit was resolved" };

const BASE_LINE =
  "Base commit: abc123. Diff against this sha (git diff abc123..HEAD), never against a branch name such as main.";
const UNRESOLVED_BASE_LINE =
  "Base commit: unresolved. Establish the diff base from the pull request itself, never from a local branch.";

/** The evidence list for one record seed, changed-file inventory and deferred-minor set. */
function evidenceFor(seed: string | null, changed: ChangedFilesEvidence, minorsLeft: readonly string[] = []): string[] {
  return approvalEvidence({ record: { ...record, seed }, stories: [] }, ci, minorsLeft, changed);
}

/** The index of the first line that starts with `prefix`; -1 when no line does. */
function indexOfLine(lines: readonly string[], prefix: string): number {
  return lines.findIndex((l) => l.startsWith(prefix));
}

/** The inventory line, whatever it says. */
function inventoryLine(lines: readonly string[]): string {
  const line = lines.find((l) => l.startsWith("Changed files since the base commit"));
  if (line === undefined) throw new Error(`no inventory line in ${JSON.stringify(lines)}`);
  return line;
}

describe("approvalEvidence", () => {
  test("a gate repair is named as an unreviewed diff (nax#2548)", () => {
    const lines = approvalEvidence({ record: { ...record, gateRepairRounds: 1 }, stories: [] }, ci, [], NO_FILES);
    expect(lines).toContain(
      "Gate repair: 1 round(s) after the final gates went red; the repair diff was not re-reviewed",
    );
  });

  test("no repair, no gate-repair line", () => {
    const lines = approvalEvidence({ record, stories: [] }, ci, [], NO_FILES);
    expect(lines.some((l) => l.startsWith("Gate repair"))).toBe(false);
  });

  // AC-1 (nax#2567): the advisor diffs the resolved base itself; it needs the sha, not a branch name.
  test("a resolved seed is named as the diff base", () => {
    const lines = evidenceFor("abc123", { kind: "files", files: ["a.ts", "b.ts"] });
    expect(lines).toContain(BASE_LINE);
  });

  // AC-2: the inventory lists every changed file since that base.
  test("the inventory names the changed files and their count", () => {
    const lines = evidenceFor("abc123", { kind: "files", files: ["a.ts", "b.ts"] });
    expect(lines).toContain("Changed files since the base commit (2): a.ts, b.ts");
  });

  // AC-3: no seed, no diff base to name — the advisor is told to take it from the PR.
  test("no seed is reported as unresolved", () => {
    const lines = evidenceFor(null, UNRESOLVED);
    expect(lines).toContain(UNRESOLVED_BASE_LINE);
  });

  // AC-4: the inventory carries the reason it is unavailable.
  test("an unavailable inventory carries its reason", () => {
    const lines = evidenceFor(null, UNRESOLVED);
    expect(lines).toContain("Changed files since the base commit: unavailable (no base commit was resolved)");
  });

  // AC-5: the inventory is bounded, so a stale base cannot flood the question.
  test("302 changed files list 300 paths and count the rest", () => {
    const files = Array.from({ length: 302 }, (_, i) => `f${i + 1}.ts`);
    const line = inventoryLine(evidenceFor("abc123", { kind: "files", files }));
    expect(line).toStartWith("Changed files since the base commit (302): f1.ts, ");
    expect(line).toContain("f300.ts");
    expect(line).not.toContain("f301.ts");
    expect(line).toEndWith(", and 2 more");
  });

  // AC-6: an empty inventory is stated, not left as a dangling header.
  test("no changed files reads as none", () => {
    const lines = evidenceFor("abc123", { kind: "files", files: [] });
    expect(lines).toContain("Changed files since the base commit (0): none");
  });

  // AC-7 (nax#2567): the advisor sees every deferred minor's text, not just how many there are.
  test("every deferred minor is spelled out after its count", () => {
    const lines = evidenceFor(null, NO_FILES, ["US-001: rename x", "unused import in y.ts"]);
    const count = indexOfLine(lines, "Deferred minors left: ");
    expect(lines[count]).toBe("Deferred minors left: 2");
    expect(lines[count + 1]).toBe("Deferred minor: US-001: rename x");
    expect(lines[count + 2]).toBe("Deferred minor: unused import in y.ts");
  });

  // AC-8: the diff facts sit together, directly after the review counts.
  test("the base and inventory lines follow the branch-review line, in that order", () => {
    const cases: readonly [string | null, ChangedFilesEvidence][] = [
      ["abc123", { kind: "files", files: ["a.ts"] }],
      ["abc123", { kind: "files", files: [] }],
      [null, UNRESOLVED],
    ];
    for (const [seed, changed] of cases) {
      const lines = evidenceFor(seed, changed);
      const review = indexOfLine(lines, "Branch review ran;");
      expect(review).toBeGreaterThanOrEqual(0);
      expect(lines[review + 1]).toStartWith("Base commit: ");
      expect(lines[review + 2]).toStartWith("Changed files since the base commit");
    }
  });
});

// ---------------------------------------------------------------------------
// publish-level: what the advisor is actually sent (US-001, nax#2567)
// ---------------------------------------------------------------------------

const saved = { feature: { ..._featureDeps }, workflow: { ..._workflowDeps }, ci: { ..._ciWaitDeps } };
afterEach(() => {
  Object.assign(_featureDeps, saved.feature);
  Object.assign(_workflowDeps, saved.workflow);
  Object.assign(_ciWaitDeps, saved.ci);
});

interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const CLEAN_GIT: GitResult = { exitCode: 0, stdout: "", stderr: "" };

interface WireOptions {
  readonly ci: CiWaitResult;
  readonly seed?: string | null;
  readonly minors?: readonly MinorItem[];
  readonly newMinors?: readonly string[];
  /** Answers one git call; the default is an empty, successful one. Throw to fail the call. */
  readonly git?: (args: readonly string[]) => GitResult | Promise<GitResult>;
}

/** The `wire()` harness of finalize-ci-gate.test.ts, keeping the evidence the advisor was sent. */
function wire(opts: WireOptions) {
  const updated: OpenOrPromoteArgs[] = [];
  const asked: string[] = [];
  const evidence: string[] = [];
  const gitCalls: string[][] = [];
  _featureDeps.detectForge = async () => "github";
  _featureDeps.commitLedger = async () => false;
  _featureDeps.commitAndPush = async () => ({ committed: false, pushed: true });
  _featureDeps.openDraftFinishPr = async () => ({ url: "https://gh/pr/7" });
  _featureDeps.waitForChecks = async () => opts.ci;
  _featureDeps.forge = { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }), readText: async () => null };
  _workflowDeps.git = async (args) => {
    gitCalls.push([...args]);
    return opts.git ? await opts.git(args) : CLEAN_GIT;
  };
  _workflowDeps.readTrustedDecisions = async () => [];
  _workflowDeps.resolveFeatureSpec = async () => ({ specSource: null });
  type Kept = { status: "draft"; url: string };
  type Ready = { status: "promoted"; url: string };
  async function promote(args: OpenOrPromoteArgs & { keepDraft: true }, deps: ForgeDeps): Promise<Kept>;
  async function promote(args: OpenOrPromoteArgs & { keepDraft?: false }, deps: ForgeDeps): Promise<Ready>;
  async function promote(args: OpenOrPromoteArgs, deps: ForgeDeps): Promise<Kept | Ready>;
  async function promote(args: OpenOrPromoteArgs): Promise<Kept | Ready> {
    updated.push(args);
    return args.keepDraft
      ? { status: "draft", url: "https://gh/pr/7" }
      : { status: "promoted", url: "https://gh/pr/7" };
  }
  _featureDeps.openOrPromotePr = promote;
  const advisor: Advisor = {
    advise: async (q) => {
      asked.push(q.kind);
      evidence.push(...q.evidence.map((e) => e.text));
      return { decision: makeAdviceDecision({ action: { type: "approve" }, rationale: "clean" }) };
    },
    recordReuse: async () => null,
    adviseBatch: async () => ({ kind: "residual", items: [], diagnoses: {} }),
  };
  const input: PublishInput = {
    record: {
      ...newFeatureRecord({
        now: "t",
        seed: opts.seed === undefined ? "abc123" : opts.seed,
        minors: opts.minors ?? [],
      }),
      ...(opts.newMinors ? { newMinors: opts.newMinors } : {}),
      reviewRan: true,
      finalGates: { ran: ["test"], failing: [] },
    },
    stories: [{ id: "US-001", title: "A", state: "complete", rounds: 1, unreviewed: false, flagged: 0 }],
    flagged: 0,
    advisor,
    preflight: null,
  };
  return { input, asked, evidence, gitCalls, updated };
}

const GREEN: CiWaitResult = { outcome: "green", detail: "all checks passed" };
const TWO_FILES = "src/a.ts\nsrc/b.ts\n";
const diffAnswer = (args: readonly string[]): GitResult =>
  args[0] === "diff" && args[1] === "--name-only" ? { exitCode: 0, stdout: TWO_FILES, stderr: "" } : CLEAN_GIT;

describe("publish finish-approval evidence (US-001)", () => {
  // AC-9/AC-10: the advisor is handed the files behind the resolved base.
  test("the question carries the inventory of the resolved base", async () => {
    const { input, asked, evidence } = wire({ ci: GREEN, seed: "abc123", git: diffAnswer });
    await publish(makeFeatureContext(), input);
    expect(asked).toEqual(["finish-approval"]);
    expect(evidence).toContain("Changed files since the base commit (2): src/a.ts, src/b.ts");
    expect(evidence).toContain(BASE_LINE);
  });

  // AC-15: a failed diff still asks the advisor, naming the error.
  test("a failing diff asks the advisor with the reason and keeps the base line", async () => {
    const { input, asked, evidence } = wire({
      ci: GREEN,
      seed: "abc123",
      git: (args) => {
        if (args[0] === "diff" && args[1] === "--name-only") throw new Error("git diff blew up");
        return CLEAN_GIT;
      },
    });
    await publish(makeFeatureContext(), input);
    expect(asked).toEqual(["finish-approval"]);
    expect(evidence).toContain("Changed files since the base commit: unavailable (git diff blew up)");
    expect(evidence).toContain(BASE_LINE);
  });

  // AC-11: a git failure (not a throw) is reported the same way.
  test("a diff that exits non-zero asks the advisor with the git error", async () => {
    const { input, asked, evidence } = wire({
      ci: GREEN,
      seed: "abc123",
      git: (args) =>
        args[0] === "diff" && args[1] === "--name-only"
          ? { exitCode: 128, stdout: "", stderr: "bad revision" }
          : CLEAN_GIT,
    });
    const result = await publish(makeFeatureContext(), input);
    expect(result.outcome).toBe("ready");
    expect(asked).toEqual(["finish-approval"]);
    expect(evidence).toContain(
      "Changed files since the base commit: unavailable (git diff --name-only failed: bad revision)",
    );
    expect(evidence).toContain(BASE_LINE);
  });

  // AC-14: no seed — the advisor is told to take the base from the PR and that no inventory exists.
  test("an unresolved seed asks the advisor to use the pull request as the base", async () => {
    const { input, asked, evidence } = wire({ ci: GREEN, seed: null });
    await publish(makeFeatureContext(), input);
    expect(asked).toEqual(["finish-approval"]);
    expect(evidence).toContain(UNRESOLVED_BASE_LINE);
    expect(evidence).toContain("Changed files since the base commit: unavailable (no base commit was resolved)");
  });

  // AC-12: both kinds of deferred minor reach the question by name.
  test("every deferred minor reaches the question by name", async () => {
    const { input, asked, evidence } = wire({
      ci: GREEN,
      seed: "abc123",
      git: diffAnswer,
      minors: [{ id: "M1", storyId: "US-002", text: "tidy helper", triage: "leave" }],
      newMinors: ["late note"],
    });
    await publish(makeFeatureContext(), input);
    expect(asked).toEqual(["finish-approval"]);
    expect(evidence).toContain("Deferred minor: US-002: tidy helper");
    expect(evidence).toContain("Deferred minor: late note");
  });

  // AC-13: a deterministic reason means the advisor is never asked, so nothing is diffed for it.
  test("a failed CI never runs the changed-file diff", async () => {
    const { input, asked, gitCalls } = wire({ ci: { outcome: "failed", detail: "test failed" }, seed: "abc123" });
    const result = await publish(makeFeatureContext(), input);
    expect(result.outcome).toBe("draft");
    expect(asked).toEqual([]);
    expect(gitCalls.filter((args) => args[0] === "diff" && args[1] === "--name-only")).toEqual([]);
  });
});
