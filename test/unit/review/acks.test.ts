/**
 * Review acknowledgements (#1423).
 *
 * The carry-forward verdict template asks the reviewer to classify every prior
 * finding. Only `still-blocking` is a defect; `addressed` and `never-an-issue`
 * are bookkeeping and belong in `acks`. These tests pin the read path for both
 * reviewers — the extractor's tolerance for a reviewer that ignores or mangles
 * the field, and the fact that acks never leak into findings.
 */

import { describe, expect, test } from "bun:test";
import { extractAcks, parseLLMResponse, validateAdversarialShape } from "@/review";

describe("extractAcks()", () => {
  test("normalizes a well-formed acks array", () => {
    expect(
      extractAcks([
        { priorFinding: "src/a.ts:4", status: "addressed", note: "fixed at line 6" },
        { priorFinding: "the layout claim", status: "never-an-issue", note: "misread markup" },
      ]),
    ).toEqual([
      { priorFinding: "src/a.ts:4", status: "addressed", note: "fixed at line 6" },
      { priorFinding: "the layout claim", status: "never-an-issue", note: "misread markup" },
    ]);
  });

  test.each([[undefined], [null], ["not-an-array"], [{}], [42]])(
    "a missing or non-array value (%p) yields no acknowledgements rather than throwing",
    (raw) => {
      expect(extractAcks(raw)).toEqual([]);
    },
  );

  test("skips non-object entries instead of dropping the whole array", () => {
    const acks = extractAcks(["junk", null, { priorFinding: "src/a.ts:4", status: "addressed" }]);
    expect(acks).toEqual([{ priorFinding: "src/a.ts:4", status: "addressed" }]);
  });

  test("an unrecognized status falls back to 'addressed' — benign, and still out of findings", () => {
    expect(extractAcks([{ priorFinding: "x", status: "banana" }])[0].status).toBe("addressed");
  });

  test("omits an empty note rather than persisting an empty string", () => {
    expect(extractAcks([{ priorFinding: "x", status: "addressed", note: "" }])[0]).not.toHaveProperty("note");
  });
});

describe("acks on the reviewer parse paths", () => {
  const wire = {
    passed: false,
    acks: [{ priorFinding: "src/a.ts:4", status: "addressed", note: "fixed at line 6" }],
    findings: [
      { severity: "error", category: "input", file: "src/a.ts", line: 9, issue: "unvalidated", suggestion: "guard" },
    ],
  };

  test("adversarial: acks are captured and findings are untouched", () => {
    const parsed = validateAdversarialShape(wire);
    expect(parsed?.acks).toHaveLength(1);
    expect(parsed?.findings).toHaveLength(1);
    expect(parsed?.findings[0].issue).toBe("unvalidated");
  });

  test("semantic: acks are captured and findings are untouched", () => {
    const parsed = parseLLMResponse(JSON.stringify(wire));
    expect(parsed?.acks).toHaveLength(1);
    expect(parsed?.findings).toHaveLength(1);
  });

  test.each([
    ["adversarial", (w: unknown) => validateAdversarialShape(w)],
    ["semantic", (w: unknown) => parseLLMResponse(JSON.stringify(w))],
  ])("%s: a response without acks leaves the field absent", (_name, parse) => {
    const parsed = parse({ passed: true, findings: [] });
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("acks");
  });
});
