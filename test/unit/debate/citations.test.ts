import { describe, expect, test } from "bun:test";
import type { FactsManifest } from "@/debate";
import { citationDistribution, citationRate, extractClaims, type ParsedClaim } from "@/debate";

// ─── extractClaims ────────────────────────────────────────────────────────────

describe("extractClaims", () => {
  test("returns empty array for empty string", () => {
    expect(extractClaims("")).toEqual([]);
  });

  test("marks claim as cited when inline [F-001] marker present", () => {
    const claims = extractClaims("The function handles null inputs [F-001].");
    expect(claims.length).toBeGreaterThan(0);
    const cited = claims.some((c) => c.cited && c.factIds.includes("F-001"));
    expect(cited).toBe(true);
  });

  test("marks claim as cited with S-xxx spec span marker", () => {
    const claims = extractClaims("Per the spec [S-001] this should return null.");
    expect(claims.some((c) => c.cited && c.factIds.includes("S-001"))).toBe(true);
  });

  test("marks claim as cited with (F-001, S-002) parenthesis notation", () => {
    const claims = extractClaims("Claim text (F-001, S-002) supports this.");
    expect(claims.some((c) => c.cited && c.factIds.includes("F-001") && c.factIds.includes("S-002"))).toBe(true);
  });

  test("marks uncited prose with cited === false", () => {
    const claims = extractClaims("This is pure prose with no citations whatsoever.");
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((c) => !c.cited)).toBe(true);
  });

  test("does not throw on malformed input", () => {
    expect(() => extractClaims("garbage {{{invalid")).not.toThrow();
    expect(() => extractClaims("{invalid json}")).not.toThrow();
    expect(() => extractClaims("")).not.toThrow();
  });

  test("parses structured JSON claims array when present", () => {
    const structured = JSON.stringify({
      claims: [
        { text: "claim one", factIds: ["F-001"] },
        { text: "claim two", factIds: [] },
      ],
    });
    const claims = extractClaims(structured);
    expect(claims).toHaveLength(2);
    expect(claims[0]!.factIds).toEqual(["F-001"]);
    expect(claims[0]!.cited).toBe(true);
    expect(claims[1]!.cited).toBe(false);
  });

  test("falls back to regex when JSON has no claims array", () => {
    const json = JSON.stringify({ someOtherField: "value" });
    const claims = extractClaims(`${json} Claim citing [F-001].`);
    expect(claims.some((c) => c.factIds.includes("F-001"))).toBe(true);
  });

  test("structured JSON with missing factIds field treats as uncited", () => {
    const structured = JSON.stringify({
      claims: [{ text: "claim without factIds" }],
    });
    const claims = extractClaims(structured);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.cited).toBe(false);
    expect(claims[0]!.factIds).toEqual([]);
  });

  test("multiple paragraphs each become separate claims in regex mode", () => {
    const text = "First paragraph with [F-001].\n\nSecond paragraph uncited.";
    const claims = extractClaims(text);
    expect(claims.length).toBeGreaterThanOrEqual(2);
    expect(claims.some((c) => c.cited)).toBe(true);
    expect(claims.some((c) => !c.cited)).toBe(true);
  });
});

// ─── citationRate ─────────────────────────────────────────────────────────────

describe("citationRate", () => {
  test("returns 0 for empty claims array", () => {
    expect(citationRate([])).toBe(0);
  });

  test("returns 1 when all claims are cited", () => {
    const claims: ParsedClaim[] = [
      { text: "a", factIds: ["F-001"], cited: true },
      { text: "b", factIds: ["F-002"], cited: true },
    ];
    expect(citationRate(claims)).toBe(1);
  });

  test("returns 0 when no claims are cited", () => {
    const claims: ParsedClaim[] = [
      { text: "a", factIds: [], cited: false },
      { text: "b", factIds: [], cited: false },
    ];
    expect(citationRate(claims)).toBe(0);
  });

  test("returns fraction of cited claims", () => {
    const claims: ParsedClaim[] = [
      { text: "a", factIds: ["F-001"], cited: true },
      { text: "b", factIds: [], cited: false },
    ];
    expect(citationRate(claims)).toBe(0.5);
  });

  test("returns correct fraction for 1 of 3 cited", () => {
    const claims: ParsedClaim[] = [
      { text: "a", factIds: ["F-001"], cited: true },
      { text: "b", factIds: [], cited: false },
      { text: "c", factIds: [], cited: false },
    ];
    expect(citationRate(claims)).toBeCloseTo(1 / 3);
  });
});

// ─── citationDistribution ─────────────────────────────────────────────────────

describe("citationDistribution", () => {
  const manifest: FactsManifest = {
    repoFacts: [{ id: "F-001", kind: "file", evidence: "evidence text", summary: "a repo fact" }],
    specClaims: [
      {
        id: "S-001",
        specSpan: "the spec span",
        claim: "some claim",
        kind: "factual",
        verification: { status: "verified" },
      },
      {
        id: "S-002",
        specSpan: "another span",
        claim: "another claim",
        kind: "intent",
        verification: { status: "unverified" },
      },
    ],
    gaps: [],
  };

  test("returns all zeros for empty claims", () => {
    expect(citationDistribution([], manifest)).toEqual({ verifiedFacts: 0, specSpans: 0, uncited: 0 });
  });

  test("counts uncited claims correctly", () => {
    const claims: ParsedClaim[] = [
      { text: "a", factIds: [], cited: false },
      { text: "b", factIds: [], cited: false },
    ];
    expect(citationDistribution(claims, manifest).uncited).toBe(2);
  });

  test("counts verifiedFacts only for S-xxx with status verified", () => {
    const claims: ParsedClaim[] = [
      { text: "a", factIds: ["S-001"], cited: true }, // verified
      { text: "b", factIds: ["S-002"], cited: true }, // unverified
      { text: "c", factIds: [], cited: false },
    ];
    const dist = citationDistribution(claims, manifest);
    expect(dist.verifiedFacts).toBe(1);
    expect(dist.uncited).toBe(1);
  });

  test("counts specSpans for all specClaim citations", () => {
    const claims: ParsedClaim[] = [
      { text: "a", factIds: ["S-001"], cited: true },
      { text: "b", factIds: ["S-002"], cited: true },
    ];
    const dist = citationDistribution(claims, manifest);
    expect(dist.specSpans).toBe(2);
  });

  test("F-xxx citations not counted in verifiedFacts or specSpans", () => {
    const claims: ParsedClaim[] = [{ text: "a", factIds: ["F-001"], cited: true }];
    const dist = citationDistribution(claims, manifest);
    expect(dist.verifiedFacts).toBe(0);
    expect(dist.specSpans).toBe(0);
    expect(dist.uncited).toBe(0);
  });

  test("unknown factIds are not counted", () => {
    const claims: ParsedClaim[] = [{ text: "a", factIds: ["S-999"], cited: true }];
    const dist = citationDistribution(claims, manifest);
    expect(dist.verifiedFacts).toBe(0);
    expect(dist.specSpans).toBe(0);
  });
});
