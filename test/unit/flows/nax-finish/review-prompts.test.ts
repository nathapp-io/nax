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

  test("spec prompt carries the classifier + strict JSON contract", () => {
    const p = buildReviewPrompt("spec", { base: "origin/main", specPath: ".nax/features/x/prd.json" });
    expect(p).toContain("git diff origin/main...HEAD");
    expect(p).toContain(".nax/features/x/prd.json");
    expect(p).toContain('"route": "proceed" | "escalate"');
    expect(p).toContain("spec conflict"); // escalate trigger
    expect(p).toContain("recommended fix"); // proceed trigger
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
