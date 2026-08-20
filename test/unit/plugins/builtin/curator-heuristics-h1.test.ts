/**
 * H1 heuristic — cross-feature recurrence (#1422) and the #942 bucket guards.
 *
 * Split from curator-heuristics.test.ts, which crossed the 800-line test limit.
 * Concern: how review findings are grouped into rule proposals.
 */

import { describe, expect, test } from "bun:test";
import type { Observation } from "@/plugins/builtin/curator";
import { runHeuristics } from "@/plugins/builtin/curator/heuristics";
import type { CuratorThresholds } from "@/plugins/builtin/curator/heuristics";

function makeReviewFindingObs942(
  storyId: string,
  ruleId: string,
  severity: string,
  message = "msg",
  category?: string,
): Observation {
  return {
    schemaVersion: 1,
    runId: "run-test",
    // One feature per story: H1 measures recurrence across FEATURES (#1422), so
    // fixtures that mean "this recurred" must spread across them.
    featureId: `feat-${storyId}`,
    storyId,
    stage: "review",
    ts: "2026-05-07T00:00:00.000Z",
    kind: "review-finding",
    payload: { ruleId, checkId: ruleId, severity, category, file: "src/foo.ts", line: 1, message },
  };
}

describe("H1 — sample messages in evidence", () => {
  test("evidence includes up to two sample messages drawn from the group", () => {
    const observations: Observation[] = [
      // Same defect, three phrasings that share the fingerprint prefix — that is
      // what "one group" now means (#1422). Only two samples may surface.
      makeReviewFindingObs942(
        "US-001",
        "input:listener-arg-not-validated",
        "warning",
        "Listener argument is not validated as a function (register path)",
      ),
      makeReviewFindingObs942(
        "US-002",
        "input:listener-arg-not-validated",
        "warning",
        "Listener argument is not validated as a function (handler path)",
      ),
      makeReviewFindingObs942(
        "US-003",
        "input:listener-arg-not-validated",
        "warning",
        "Listener argument is not validated as a function (third example should not appear)",
      ),
    ];

    const proposals = runHeuristics(observations, { repeatedFinding: 2 } as CuratorThresholds);
    const h1 = proposals.find((p) => p.id === "H1")!;

    expect(h1).toBeDefined();
    expect(h1.evidence).toContain("(register path)");
    expect(h1.evidence).toContain("(handler path)");
    expect(h1.evidence).not.toContain("third example should not appear");
  });

  test("evidence omits sample section when all messages are empty", () => {
    const observations: Observation[] = [
      makeReviewFindingObs942("US-001", "input:listener-arg-not-validated", "warning", ""),
      makeReviewFindingObs942("US-002", "input:listener-arg-not-validated", "warning", ""),
    ];

    const proposals = runHeuristics(observations, { repeatedFinding: 2 } as CuratorThresholds);
    const h1 = proposals.find((p) => p.id === "H1")!;
    expect(h1).toBeDefined();
    expect(h1.evidence).not.toContain("Examples:");
  });

  test("sample uses only the first line of a multi-line message", () => {
    const observations: Observation[] = [
      makeReviewFindingObs942(
        "US-001",
        "review:null-check",
        "warning",
        "Null check missing\n→ Add a guard before access",
      ),
      makeReviewFindingObs942(
        "US-002",
        "review:null-check",
        "warning",
        "Null check missing\n→ Add a guard before access",
      ),
    ];

    const proposals = runHeuristics(observations, { repeatedFinding: 2 } as CuratorThresholds);
    const h1 = proposals.find((p) => p.id === "H1")!;
    expect(h1.evidence).toContain("Null check missing");
    expect(h1.evidence).not.toContain("→ Add a guard");
  });

  test("a blank-looking first message does not suppress a later real sample", () => {
    // Still reachable, contrary to an earlier claim that the message being part
    // of the grouping key made it impossible: the key normalizes whitespace
    // (so a leading newline groups with the trimmed text) while the sample uses
    // the raw first line (which is empty). The `if (sample && …)` guard is what
    // keeps evidence correct here.
    const observations: Observation[] = [
      makeReviewFindingObs942("US-001", "review:null-check", "warning", "\nNull check missing"),
      makeReviewFindingObs942("US-002", "review:null-check", "warning", "Null check missing"),
    ];

    const h1 = runHeuristics(observations, { repeatedFinding: 2 } as CuratorThresholds).find((p) => p.id === "H1");
    expect(h1).toBeDefined();
    expect(h1?.evidence).toContain("Null check missing");
  });
});

describe("H1 — issue #942 AC-5: ruleId buckets are not single-word collapses", () => {
  test("findings sharing a category but different issues yield distinct buckets", () => {
    const observations: Observation[] = [
      makeReviewFindingObs942(
        "US-001",
        "input:listener-arg",
        "warning",
        "Listener argument is not validated as a function",
        "input",
      ),
      makeReviewFindingObs942(
        "US-002",
        "input:listener-arg",
        "warning",
        "Listener argument is not validated as a function",
        "input",
      ),
      makeReviewFindingObs942(
        "US-003",
        "input:timeout-bound",
        "error",
        "Timeout value has no upper bound and can hang the run",
        "input",
      ),
      makeReviewFindingObs942(
        "US-004",
        "input:timeout-bound",
        "error",
        "Timeout value has no upper bound and can hang the run",
        "input",
      ),
    ];

    const proposals = runHeuristics(observations, { repeatedFinding: 2 } as CuratorThresholds);
    const h1s = proposals.filter((p) => p.id === "H1");

    expect(h1s.length).toBe(2);
    // Buckets are per-defect, not per-category. Both findings carry category
    // "input", so a category-only description would render them identically —
    // the #942 collapse. Assert they are actually distinguishable.
    expect(h1s[0].description).not.toBe(h1s[1].description);
    for (const p of h1s) {
      expect(p.description).not.toMatch(/^Recurring across \d+ features — input: ?$/);
      expect(p.evidence).toContain("Examples:");
    }
    expect(h1s.some((p) => p.evidence.includes("Listener argument"))).toBe(true);
    expect(h1s.some((p) => p.evidence.includes("Timeout value"))).toBe(true);
  });
});

// ─── #1422: cross-feature recurrence ──────────────────────────────────────────

describe("H1 — cross-feature recurrence (#1422)", () => {
  const thresholds: CuratorThresholds = {
    repeatedFinding: 3,
    emptyKeyword: 2,
    rectifyAttempts: 3,
    escalationChain: 2,
    staleChunkRuns: 2,
    unchangedOutcome: 3,
  };

  function finding(
    featureId: string,
    storyId: string,
    over: Partial<{ category: string; file: string; message: string }> = {},
  ): Observation {
    return {
      schemaVersion: 1,
      runId: "run-1",
      featureId,
      storyId,
      stage: "review",
      ts: "2026-08-01T00:00:00Z",
      kind: "review-finding",
      payload: {
        ruleId: "test-gap:missing-runtime-assertion",
        category: over.category ?? "test-gap",
        severity: "error",
        file: over.file ?? "src/api.ts",
        line: 10,
        message: over.message ?? "Test asserts a pattern exists in the file instead of invoking the code",
      },
    };
  }

  test("proposes when the same finding recurs across enough DISTINCT features", () => {
    const obs = [finding("feat-a", "US-001"), finding("feat-b", "US-002"), finding("feat-c", "US-003")];
    const h1 = runHeuristics(obs, thresholds).find((p) => p.id === "H1");
    expect(h1).toBeDefined();
    expect(h1?.description).toContain("3 features");
    expect(h1?.evidence).toContain("feat-a");
    expect(h1?.evidence).toContain("feat-c");
  });

  test("fires when the SAME defect appears in DIFFERENT files across features", () => {
    // The whole point of H1. Different features touch different files by
    // definition, so a file-led identity key can never see this — which is what
    // reusing recurrence-demotion's `fingerprintFor` verbatim did.
    const obs = [
      finding("feat-a", "US-001", { file: "src/auth.ts" }),
      finding("feat-b", "US-002", { file: "src/billing.ts" }),
      finding("feat-c", "US-003", { file: "src/cart.ts" }),
    ];
    const h1 = runHeuristics(obs, thresholds).find((p) => p.id === "H1");
    expect(h1).toBeDefined();
    expect(h1?.description).toContain("3 features");
    // The files are evidence, not identity.
    expect(h1?.evidence).toContain("src/auth.ts");
    expect(h1?.evidence).toContain("src/cart.ts");
  });

  test("description never collapses to a bare category (#942 regression guard)", () => {
    // A finding with no file must still produce a distinguishable checkbox line:
    // `nax curator commit` ticks are made against that line alone.
    const obs = ["a", "b", "c"].map((f) =>
      finding(`feat-${f}`, "US-001", { file: "", message: "Assumes the env var is always set before boot" }),
    );
    const h1 = runHeuristics(obs, thresholds).find((p) => p.id === "H1");
    expect(h1).toBeDefined();
    expect(h1?.description).toContain("Assumes the env var is always set");
    expect(h1?.description).not.toMatch(/^Recurring review finding \(test-gap\)$/);
  });

  test("two distinct defects in the same file produce distinguishable descriptions", () => {
    const a = ["a", "b", "c"].map((f) =>
      finding(`feat-${f}`, "US-001", { message: "Placeholder assertion expect(true) covers AC 2" }),
    );
    const b = ["a", "b", "c"].map((f) =>
      finding(`feat-${f}`, "US-002", { message: "Source-inspection test reads the file instead of running it" }),
    );
    const h1s = runHeuristics([...a, ...b], thresholds).filter((p) => p.id === "H1");
    expect(h1s).toHaveLength(2);
    expect(h1s[0].description).not.toBe(h1s[1].description);
  });

  test("story IDs are qualified by feature, since US-001 exists in every feature", () => {
    const obs = ["a", "b", "c"].map((f) => finding(`feat-${f}`, "US-001"));
    const h1 = runHeuristics(obs, thresholds).find((p) => p.id === "H1");
    expect(h1?.storyIds).toEqual(["feat-a/US-001", "feat-b/US-001", "feat-c/US-001"]);
  });

  test("does NOT propose when one feature repeats the same finding many times", () => {
    // A rule is worth writing when a defect crosses features. One feature
    // repeating itself is a story problem, and was the old behaviour's main
    // source of noise ("test-gap appeared 1008x" from a single 7-story run).
    const obs = Array.from({ length: 12 }, (_, i) => finding("feat-a", `US-${i}`));
    expect(runHeuristics(obs, thresholds).find((p) => p.id === "H1")).toBeUndefined();
  });

  test("separates distinct defects that share a category and file", () => {
    const a = [1, 2, 3].map((i) => finding(`feat-${i}`, "US-001", { message: "Placeholder assertion expect(true)" }));
    const b = [1, 2, 3].map((i) =>
      finding(`feat-${i}`, "US-002", { message: "Source-inspection test reads the file" }),
    );
    const h1s = runHeuristics([...a, ...b], thresholds).filter((p) => p.id === "H1");
    expect(h1s).toHaveLength(2);
  });

  test("groups the same defect reported at different lines and stories", () => {
    const obs = ["feat-a", "feat-b", "feat-c"].map((f) => finding(f, "US-001"));
    expect(runHeuristics(obs, thresholds).filter((p) => p.id === "H1")).toHaveLength(1);
  });

  test("severity is relative to the configured threshold, not a fixed spread", () => {
    // A fixed constant pinned every proposal to HIGH once the threshold was
    // raised past it, making severity carry no information.
    const spread = (n: number) => Array.from({ length: n }, (_, i) => finding(`feat-${i}`, "US-001"));
    expect(runHeuristics(spread(3), thresholds).find((p) => p.id === "H1")?.severity).toBe("MED");
    expect(runHeuristics(spread(6), thresholds).find((p) => p.id === "H1")?.severity).toBe("HIGH");

    const strict = { ...thresholds, repeatedFinding: 8 };
    expect(runHeuristics(spread(8), strict).find((p) => p.id === "H1")?.severity).toBe("MED");
    expect(runHeuristics(spread(16), strict).find((p) => p.id === "H1")?.severity).toBe("HIGH");
  });

  test("acknowledgement-shaped findings cannot form a proposal on their own", () => {
    // Belt and braces with #1423: even if a stale ack leaks into findings,
    // it carries no category/file locus worth writing a rule about.
    const obs = ["a", "b", "c"].map((f) =>
      finding(`feat-${f}`, "US-001", {
        category: "",
        file: "",
        message: "Prior finding 1: addressed. No action required.",
      }),
    );
    expect(runHeuristics(obs, thresholds).find((p) => p.id === "H1")).toBeUndefined();
  });
});
