import { describe, expect, test } from "bun:test";
import {
  QUALITY_REVIEW_DIMENSIONS,
  SPEC_REVIEW_DIMENSIONS,
  buildReviewPrompt,
  fixPrompt,
} from "@flows/nax-finish/review-prompts";

describe("review prompts", () => {
  test("spec dimensions copied verbatim (key markers present)", () => {
    expect(SPEC_REVIEW_DIMENSIONS).toContain("Map external touchpoints first");
    expect(SPEC_REVIEW_DIMENSIONS).toContain("Convention Compliance");
    expect(SPEC_REVIEW_DIMENSIONS).toContain("≥80% confident");
  });

  test("quality dimensions copied verbatim (key markers present)", () => {
    expect(QUALITY_REVIEW_DIMENSIONS).toContain("enumerate before you conclude");
    expect(QUALITY_REVIEW_DIMENSIONS).toContain("≥60% confident");
  });

  test("spec prompt carries the classifier and the three-section output contract", () => {
    const p = buildReviewPrompt("spec", { base: "origin/main", specPath: ".nax/features/x/prd.json" });
    expect(p).toContain("git diff origin/main...HEAD");
    expect(p).toContain(".nax/features/x/prd.json");
    expect(p).toContain("## TOUCHPOINTS");
    expect(p).toContain("## WALK");
    expect(p).toContain("## FINDINGS");
    expect(p).toContain("Judgment: yes");
    expect(p).not.toContain("First char `{`");
  });

  test("the quality prompt asks for a per-function walk, the spec prompt for a per-AC walk", () => {
    const spec = buildReviewPrompt("spec", { base: "origin/main", specPath: "s.md" });
    const quality = buildReviewPrompt("quality", { base: "origin/main", specPath: "s.md" });
    expect(spec).toContain("one line per AC");
    expect(quality).toContain("one line per function");
  });
});

describe("fixPrompt", () => {
  test("gate phase pulls quality_gates.output and demands re-verify + proceed contract", () => {
    const p = fixPrompt("gate", { outputs: { quality_gates: { output: "lint failed on foo.ts" } } });
    expect(p).toContain("lint failed on foo.ts");
    expect(p).toContain('{"route":"proceed"}');
    expect(p).toContain("re-run the feature's acceptance tests");
  });

  test("acceptance phase pulls acceptance.output", () => {
    const p = fixPrompt("acceptance", { outputs: { acceptance: { output: "test XYZ failed" } } });
    expect(p).toContain("test XYZ failed");
  });

  test("spec phase pulls review_spec.findings as JSON", () => {
    const p = fixPrompt("spec", { outputs: { review_spec: { findings: [{ severity: "HIGH", title: "t" }] } } });
    expect(p).toContain('"severity":"HIGH"');
  });

  test("quality phase pulls review_quality.findings as JSON", () => {
    const p = fixPrompt("quality", { outputs: { review_quality: { findings: [{ severity: "LOW", title: "q" }] } } });
    expect(p).toContain('"severity":"LOW"');
  });
});

// Reviews were 58% of the flow's wall clock on rs-stock/pipeline-run-outcome
// (7 calls, 1306s of 2232s), most of it re-reading code an earlier round had
// already cleared.
describe("buildReviewPrompt — incremental re-review", () => {
  const PRIOR = [{ severity: "HIGH" as const, title: "T", problem: "P", fix: "F" }];

  test("round 1 (no since) reviews the whole branch diff", () => {
    const p = buildReviewPrompt("spec", { base: "origin/main", specPath: "s.md" });
    expect(p).toContain("git diff origin/main...HEAD");
    expect(p).not.toContain("continuing a review you already started");
  });

  test("a re-review scopes the verdict to the fix diff", () => {
    const p = buildReviewPrompt("spec", {
      base: "origin/main",
      specPath: "s.md",
      since: "abc123",
      priorFindings: PRIOR,
    });
    expect(p).toContain("git diff abc123..HEAD");
    expect(p).toContain("continuing a review you already started");
    expect(p).toContain("do not re-derive a verdict on it");
  });

  test("a re-review carries the prior findings forward, so the fix can be checked against them", () => {
    const p = buildReviewPrompt("quality", {
      base: "origin/main",
      specPath: "s.md",
      since: "abc123",
      priorFindings: PRIOR,
    });
    expect(p).toContain('"title": "T"');
  });

  // The saving must come from narrowing what is *judged*, never from blinding
  // the reviewer — a fix's real damage is often in the unchanged code it calls.
  test("a re-review may still read anything, and is told so explicitly", () => {
    const p = buildReviewPrompt("spec", { base: "origin/main", specPath: "s.md", since: "abc", priorFindings: PRIOR });
    expect(p).toContain("the whole repo is available");
    expect(p).toContain("Scope means *what you judge*, not *what you may read*");
  });

  test("a re-review refuses papered-over fixes rather than accepting a green gate", () => {
    const p = buildReviewPrompt("spec", { base: "origin/main", specPath: "s.md", since: "abc", priorFindings: PRIOR });
    expect(p).toContain("assertion weakened, test deleted, check disabled");
  });

  test("both rounds keep the full dimensions and the output contract", () => {
    for (const since of [null, "abc123"]) {
      const p = buildReviewPrompt("quality", { base: "origin/main", specPath: "s.md", since, priorFindings: PRIOR });
      expect(p).toContain("Confidence threshold");
      expect(p).toContain("## FINDINGS");
    }
  });
});
