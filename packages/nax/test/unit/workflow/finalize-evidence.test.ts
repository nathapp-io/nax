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
const NO_FILES: ChangedFilesEvidence = { kind: "files", files: [] };
const UNRESOLVED: ChangedFilesEvidence = { kind: "unavailable", reason: "no base commit was resolved" };

const BASE_LINE =
  "Base commit: abc123. Diff against this sha (git diff abc123..HEAD), never against a branch name such as main.";
const UNRESOLVED_BASE_LINE =
  "Base commit: unresolved. Establish the diff base from the pull request itself, never from a local branch.";

/** The evidence list for one record seed, changed-file inventory and deferred-minor set. */
function evidenceFor(seed: string | null, changed: ChangedFilesEvidence, minorsLeft: readonly string[] = []): string[] {
  return approvalEvidence({ record: { ...record, seed }, stories: [] }, minorsLeft, changed);
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
  test.each([{ reviewUnread: undefined }, { reviewUnread: [] }])(
    "AC-1: complete coverage with %p",
    ({ reviewUnread }) => {
      const lines = approvalEvidence({ record: { ...record, reviewUnread }, stories: [] }, [], NO_FILES);
      expect(lines).toContain(
        "Branch review ran; it read every changed file it must review (0 unread); open findings after the fix pass: 0; branch rulings: 0",
      );
    },
  );

  test("AC-2: coverage preserves open finding and ruling counts", () => {
    const lines = approvalEvidence(
      {
        record: {
          ...record,
          reviewOpen: [
            { id: "F-1", kind: "quality", severity: "important", issue: "first" },
            { id: "F-2", kind: "quality", severity: "important", issue: "second" },
          ],
          rulings: [{ action: "waive", text: "parked", why: "out of scope", costIfWrong: "low", source: "advisor" }],
        },
        stories: [],
      },
      [],
      NO_FILES,
    );
    expect(lines).toContain(
      "Branch review ran; it read every changed file it must review (0 unread); open findings after the fix pass: 2; branch rulings: 1",
    );
  });

  // AC-15 (nax#2666): the question is asked before the push, so it reports no CI result — and says
  // when CI runs and what it gates, in the position the CI line has always held.
  test("AC-15: the CI line says CI has not run yet, directly after the final gates", () => {
    const lines = approvalEvidence({ record, stories: [] }, [], NO_FILES);
    const gates = indexOfLine(lines, "Final gates: ");
    expect(gates).toBeGreaterThanOrEqual(0);
    expect(lines[gates + 1]).toBe(
      "CI: not run yet. It runs on the pushed head after this ruling, and the PR is ready only when it is green.",
    );
  });

  test("AC-3/4: unread paths never claim complete coverage", () => {
    const lines = approvalEvidence(
      { record: { ...record, reviewUnread: ["a.ts", "b.ts"] }, stories: [] },
      [],
      NO_FILES,
    );
    expect(lines.find((line) => line.startsWith("Branch review ran;"))).toStartWith(
      "Branch review ran; it did not read 2 changed file(s);",
    );
    expect(lines.some((line) => line.includes("read every changed file"))).toBe(false);
  });
  test("a gate repair is named as an unreviewed diff (nax#2548)", () => {
    const lines = approvalEvidence({ record: { ...record, gateRepairRounds: 1 }, stories: [] }, [], NO_FILES);
    expect(lines).toContain(
      "Gate repair: 1 round(s) after the final gates went red; the repair diff was not re-reviewed",
    );
  });

  test("no repair, no gate-repair line", () => {
    const lines = approvalEvidence({ record, stories: [] }, [], NO_FILES);
    expect(lines.some((l) => l.startsWith("Gate repair"))).toBe(false);
  });

  // AC-11 (US-008): a CI repair commits after the re-review too, so its diff is unreviewed as well.
  test("AC-11: a CI repair is named as an unreviewed diff", () => {
    const lines = approvalEvidence({ record: { ...record, ciRepairRounds: 1 }, stories: [] }, [], NO_FILES);
    expect(lines).toContain("CI repair: 1 round(s) after CI failed on the PR; the repair diff was not re-reviewed");
  });

  test("AC-11 control: no CI repair, no CI-repair line", () => {
    const lines = approvalEvidence({ record, stories: [] }, [], NO_FILES);
    expect(lines.some((l) => l.startsWith("CI repair"))).toBe(false);
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
  /** The stories the run reports; the default is one complete story. */
  readonly stories?: PublishInput["stories"];
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
    stories: opts.stories ?? [
      { id: "US-001", title: "A", state: "complete", rounds: 1, unreviewed: false, flagged: 0 },
    ],
    flagged: 0,
    advisor,
    preflight: null,
  };
  return { input, asked, evidence, gitCalls, updated };
}

const GREEN: CiWaitResult = { outcome: "green", detail: "all checks passed" };
const TWO_FILES = "src/a.ts\nsrc/b.ts\n";
/** The one diff the resolved seed asks for (AC-9): any other base is answered as if the diff were empty. */
const DIFF_ARGS = ["diff", "--name-only", "abc123..HEAD"] as const;
const DIFF_CALL = [...DIFF_ARGS];

function answersDiff(args: readonly string[]): boolean {
  return args.length === DIFF_ARGS.length && args.every((a, i) => a === DIFF_ARGS[i]);
}

const diffAnswer = (args: readonly string[]): GitResult =>
  answersDiff(args) ? { exitCode: 0, stdout: TWO_FILES, stderr: "" } : CLEAN_GIT;

describe("publish finish-approval evidence (US-001)", () => {
  // AC-9/AC-10: the advisor is handed the files behind the resolved base, and the diff is asked for
  // that seed and no other — `diffAnswer` only answers `abc123..HEAD`.
  test("the question carries the inventory of the resolved base", async () => {
    const { input, asked, evidence, gitCalls } = wire({ ci: GREEN, seed: "abc123", git: diffAnswer });
    await publish(makeFeatureContext(), input);
    expect(gitCalls.filter((args) => args[0] === "diff" && args[1] === "--name-only")).toEqual([DIFF_CALL]);
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

  // AC-13: a deterministic reason known before the push means the advisor is never asked, so nothing
  // is diffed for it. A failed CI cannot carry this AC any more (US-001, nax#2666): the ruling is taken
  // before the push, so the diff has already run by the time CI is observed.
  test("a deterministic non-CI reason never runs the changed-file diff", async () => {
    const { input, asked, gitCalls } = wire({
      ci: GREEN,
      seed: "abc123",
      stories: [{ id: "US-001", title: "A", state: "complete-gate-open", rounds: 1, unreviewed: false, flagged: 0 }],
    });
    const result = await publish(makeFeatureContext(), input);
    expect(result.outcome).toBe("draft");
    expect(result.reasons).toEqual(["stories gate-open: US-001"]);
    expect(asked).toEqual([]);
    expect(gitCalls.filter((args) => args[0] === "diff" && args[1] === "--name-only")).toEqual([]);
  });
});
