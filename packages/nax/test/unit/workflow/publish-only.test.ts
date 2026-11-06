import { describe, expect, test } from "bun:test";
import { newFeatureRecord } from "@/workflow/feature-record";
import { publishOnlyStart } from "@/workflow/publish-only";
import type { WorkflowFeatureRecord } from "@/workflow/types";

function finished(over: Partial<WorkflowFeatureRecord> = {}): WorkflowFeatureRecord {
  return {
    ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
    step: "done",
    head: "headX",
    outcome: "local-only",
    ...over,
  };
}

describe("publishOnlyStart (#2819)", () => {
  test("a feature with no workflow run is refused", () => {
    const start = publishOnlyStart(null, "headX");
    expect(start).toEqual({ kind: "refused", reason: expect.stringContaining("no finished workflow run") });
  });

  test("a workflow that stopped before done is refused and points at nax run", () => {
    const start = publishOnlyStart(finished({ step: "branch-fix" }), "headX");
    expect(start).toEqual({ kind: "refused", reason: expect.stringContaining("stopped at branch-fix") });
  });

  test("a HEAD that moved since the workflow finished is refused", () => {
    const start = publishOnlyStart(finished(), "headY");
    expect(start).toEqual({ kind: "refused", reason: expect.stringContaining("HEAD moved") });
  });

  test("an unreadable HEAD is refused rather than trusted", () => {
    expect(publishOnlyStart(finished(), undefined).kind).toBe("refused");
  });

  test.each(["ready", "draft"] as const)("a %s PR has nothing left to publish", (outcome) => {
    expect(publishOnlyStart(finished({ outcome, url: "https://x/pull/1" }), "headX")).toEqual({
      kind: "published",
    });
  });

  test.each(["local-only", "pushed"] as const)("a %s run resumes its own record at publish", (outcome) => {
    const prior = finished({ outcome, reasons: ["publish disabled"] });
    const start = publishOnlyStart(prior, "headX");
    expect(start).toEqual({ kind: "resume", record: { ...prior, step: "publish" } });
  });
});
