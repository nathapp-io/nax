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

  test("skips unusable entries instead of dropping the whole array", () => {
    const acks = extractAcks([null, 42, { priorFinding: "src/a.ts:4", status: "addressed" }]);
    expect(acks).toEqual([{ priorFinding: "src/a.ts:4", status: "addressed" }]);
  });

  test("an unrecognized status is recorded as 'unknown', never coerced to 'addressed'", () => {
    // Coercing would let the audit certify an unfixed defect as resolved.
    const ack = extractAcks([{ priorFinding: "x", status: "banana" }])[0];
    expect(ack.status).toBe("unknown");
    expect(ack.rawStatus).toBe("banana");
  });

  test("a `still-blocking` verdict misfiled into acks stays visibly unknown", () => {
    // The realistic misuse: the reviewer puts a live blocker in `acks` instead
    // of re-flagging it. It must remain detectable in the audit corpus.
    const ack = extractAcks([{ priorFinding: "src/a.ts:4", status: "still-blocking" }])[0];
    expect(ack.status).toBe("unknown");
    expect(ack.rawStatus).toBe("still-blocking");
  });

  test("a bare string entry is kept as the referent rather than dropped", () => {
    expect(extractAcks(["fixed the null check"])).toEqual([
      { priorFinding: "fixed the null check", status: "unknown" },
    ]);
  });

  test("caps ack count and note length so one reviewer cannot bloat every audit record", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ priorFinding: `f${i}`, status: "addressed" }));
    expect(extractAcks(many)).toHaveLength(50);
    const longNote = extractAcks([{ priorFinding: "x", status: "addressed", note: "z".repeat(2000) }])[0].note;
    expect(longNote?.length).toBe(500);
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
