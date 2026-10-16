import { afterEach, describe, expect, test } from "bun:test";
import { makeFeatureContext } from "@test/helpers";
import { _featureDeps } from "@/workflow/feature-deps";
import { newFeatureRecord } from "@/workflow/feature-record";
import { isPublishableBranch, publish } from "@/workflow/finalize";
import { readDefaultBranch } from "@/workflow/git";
import { _workflowDeps } from "@/workflow/step-context";

const original = { ..._workflowDeps };
const featureOriginal = { ..._featureDeps };
afterEach(() => {
  Object.assign(_workflowDeps, original);
  Object.assign(_featureDeps, featureOriginal);
});

describe("US-002 default branch protection", () => {
  test("AC-10 reads origin HEAD via symbolic-ref", async () => {
    _workflowDeps.git = async (args, cwd) => {
      expect(args).toEqual(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
      expect(cwd).toBe("/repo");
      return { exitCode: 0, stdout: "origin/develop\n" };
    };
    expect(await readDefaultBranch("/repo")).toBe("develop");
  });
  test.each([false, true])("AC-11/21 failed lookup (throws %s) retains static protections", async (throws) => {
    _workflowDeps.git = async () => {
      if (throws) throw new Error("git unavailable");
      return { exitCode: 1, stdout: "" };
    };
    const base = await readDefaultBranch("/repo");
    expect(base).toBeUndefined();
    for (const branch of ["", "main", "master"]) expect(isPublishableBranch(branch, base)).toBe(false);
    expect(isPublishableBranch("develop", base)).toBe(true);
  });
  test.each([
    ["AC-12", "develop", "develop", false],
    ["AC-13", "feat/x", "develop", true],
    ["AC-14", "main", undefined, false],
  ] as const)("%s", (_ac, branch, base, expected) => {
    expect(isPublishableBranch(branch, base)).toBe(expected);
  });
  test("AC-15 publishing the default branch opens no PR", async () => {
    const calls: string[] = [];
    _workflowDeps.git = async (args) => ({ exitCode: 0, stdout: args[0] === "symbolic-ref" ? "origin/develop\n" : "" });
    _featureDeps.commitLedger = async () => false;
    _featureDeps.detectForge = async () => {
      calls.push("forge");
      return "github";
    };
    _featureDeps.openDraftFinishPr = async () => {
      calls.push("PR");
      return null;
    };
    _featureDeps.commitAndPush = async () => {
      calls.push("push");
      return { committed: false, pushed: true };
    };
    const out = await publish(makeFeatureContext({ branch: "develop" }), {
      record: newFeatureRecord({ now: "t", seed: "s", minors: [] }),
      stories: [],
      flagged: 0,
      preflight: null,
      advisor: {
        advise: async () => ({ decision: null }),
        recordReuse: async () => null,
        adviseBatch: async () => ({ kind: "residual", items: [], diagnoses: {} }),
      },
    });
    expect(out.outcome).toBe("local-only");
    expect(out.reasons.join(";")).toContain("develop");
    expect(calls).toEqual([]);
  });
});
