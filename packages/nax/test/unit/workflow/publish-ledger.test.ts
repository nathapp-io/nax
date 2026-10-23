/**
 * `commitApprovalRuling` was `pr` mode's post-push commit of the approval ruling (nax#2646). US-001
 * (nax#2666) moved the advisor before the single ledger commit, so nothing calls it any more; the
 * function and these cases are retired together in US-002. Until then it stays a public function of
 * this module, and a public function keeps its contract pinned.
 *
 * `ledgerCommit` / `ledgerReasons` are exercised through `publish` in
 * `test/unit/workflow/finalize.test.ts` (US-003 / US-007), where they are called.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { makeFeatureContext, withWarnSpy } from "@test/helpers";
import { _featureDeps } from "@/workflow/feature-deps";
import { commitApprovalRuling } from "@/workflow/publish-ledger";

const saved = { ..._featureDeps };
afterEach(() => Object.assign(_featureDeps, saved));

const SHA = "a".repeat(40);
const APPROVED = { approved: true, rationale: "clean", decisionId: "D-1" } as const;

/** Wires `_featureDeps.commitLedger` and counts its calls. */
function wire(commit: () => Promise<boolean>): number[] {
  const calls: number[] = [];
  _featureDeps.commitLedger = async () => {
    calls.push(calls.length + 1);
    return commit();
  };
  return calls;
}

describe("commitApprovalRuling (nax#2646, retired by US-002)", () => {
  test("AC-1: a ruling with a known pushed head is committed, and the commit is reported", async () => {
    const calls = wire(async () => true);
    await expect(commitApprovalRuling(makeFeatureContext(), APPROVED, SHA)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
  });

  test.each([
    ["a dry run", makeFeatureContext({ dryRun: true }), APPROVED, SHA],
    ["no pushed head", makeFeatureContext(), APPROVED, undefined],
    ["an advisor that decided nothing", makeFeatureContext(), null, SHA],
    ["a decision with no id", makeFeatureContext(), { approved: false, rationale: "advisor unavailable: x" }, SHA],
  ] as const)("%s commits nothing", async (_label, fc, approval, pushedHead) => {
    const calls = wire(async () => true);
    await expect(commitApprovalRuling(fc, approval, pushedHead)).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  test("a commit that changed nothing reports false", async () => {
    wire(async () => false);
    await expect(commitApprovalRuling(makeFeatureContext(), APPROVED, SHA)).resolves.toBe(false);
  });

  test("a failing commit is fail-open, warns, and leaves the ruling in the working tree", async () => {
    wire(async () => {
      throw new Error("index.lock exists");
    });
    const kept = await withWarnSpy(async (warn) => {
      const result = await commitApprovalRuling(makeFeatureContext(), APPROVED, SHA);
      expect(warn).toHaveBeenCalledWith(
        "workflow",
        "Advisor approval ruling not committed — it stays in the working tree",
        { storyId: "_run", error: "index.lock exists" },
      );
      return result;
    });
    expect(kept).toBe(false);
  });
});
