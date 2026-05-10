import { describe, expect, test } from "bun:test";
import { parseFactsManifest, renderManifestSection } from "../../../src/debate/facts-manifest";

describe("parseFactsManifest", () => {
  test("returns ok:true for empty arrays (all defaults)", () => {
    const result = parseFactsManifest({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.repoFacts).toEqual([]);
      expect(result.manifest.specClaims).toEqual([]);
      expect(result.manifest.gaps).toEqual([]);
    }
  });

  test("returns ok:true for well-formed repoFact entry", () => {
    const result = parseFactsManifest({
      repoFacts: [
        {
          id: "F-001",
          kind: "file",
          evidence: "src/debate/runner.ts exists",
          summary: "The debate runner file",
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.repoFacts).toHaveLength(1);
      expect(result.manifest.repoFacts[0]?.id).toBe("F-001");
    }
  });

  test("returns ok:true for well-formed specClaim entry with optional fields absent", () => {
    const result = parseFactsManifest({
      specClaims: [
        {
          id: "S-001",
          specSpan: "The system shall authenticate users",
          claim: "Authentication is required",
          kind: "factual",
          verification: { status: "verified" },
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.specClaims[0]?.verification.factId).toBeUndefined();
      expect(result.manifest.specClaims[0]?.verification.evidence).toBeUndefined();
    }
  });

  test("returns ok:true for well-formed gap entry with optional evidence absent", () => {
    const result = parseFactsManifest({
      gaps: [
        {
          id: "G-001",
          kind: "missing-context",
          note: "No documentation for the API",
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.gaps[0]?.evidence).toBeUndefined();
    }
  });

  test("returns ok:true for full manifest with all optional fields present", () => {
    const result = parseFactsManifest({
      repoFacts: [{ id: "F-001", kind: "symbol", evidence: "exported function", summary: "foo()" }],
      specClaims: [
        {
          id: "S-001",
          specSpan: "span",
          claim: "some claim",
          kind: "intent",
          verification: {
            status: "partial",
            evidence: "some evidence",
            factId: "F-001",
          },
        },
      ],
      gaps: [{ id: "G-001", kind: "boundary-not-considered", note: "edge case", evidence: "see code" }],
    });
    expect(result.ok).toBe(true);
  });

  test("returns ok:false when repoFact id does not match /^F-\\d{3}$/", () => {
    const result = parseFactsManifest({
      repoFacts: [{ id: "X-001", kind: "file", evidence: "exists", summary: "summary" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeTruthy();
    }
  });

  test("returns ok:false when specClaim id does not match /^S-\\d{3}$/", () => {
    const result = parseFactsManifest({
      specClaims: [
        {
          id: "F-001",
          specSpan: "span",
          claim: "claim",
          kind: "factual",
          verification: { status: "verified" },
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  test("returns ok:false when gap id does not match /^G-\\d{3}$/", () => {
    const result = parseFactsManifest({
      gaps: [{ id: "G-1", kind: "missing-context", note: "note" }],
    });
    expect(result.ok).toBe(false);
  });

  test("returns ok:false when repoFact evidence is empty string", () => {
    const result = parseFactsManifest({
      repoFacts: [{ id: "F-001", kind: "file", evidence: "", summary: "summary" }],
    });
    expect(result.ok).toBe(false);
  });

  test("returns ok:false when repoFact summary is empty string", () => {
    const result = parseFactsManifest({
      repoFacts: [{ id: "F-001", kind: "schema", evidence: "evidence", summary: "" }],
    });
    expect(result.ok).toBe(false);
  });

  test("returns ok:false when repoFact kind is invalid enum value", () => {
    const result = parseFactsManifest({
      repoFacts: [{ id: "F-001", kind: "invalid-kind", evidence: "evidence", summary: "summary" }],
    });
    expect(result.ok).toBe(false);
  });

  test("returns ok:false when specClaim kind is invalid enum value", () => {
    const result = parseFactsManifest({
      specClaims: [
        {
          id: "S-001",
          specSpan: "span",
          claim: "claim",
          kind: "invalid",
          verification: { status: "verified" },
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  test("returns ok:false when verification status is invalid enum value", () => {
    const result = parseFactsManifest({
      specClaims: [
        {
          id: "S-001",
          specSpan: "span",
          claim: "claim",
          kind: "factual",
          verification: { status: "unknown" },
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  test("returns ok:false when gap note is empty string", () => {
    const result = parseFactsManifest({
      gaps: [{ id: "G-001", kind: "ignored-convention", note: "" }],
    });
    expect(result.ok).toBe(false);
  });
});

describe("renderManifestSection", () => {
  test("returns non-empty string for empty manifest", () => {
    const result = parseFactsManifest({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rendered = renderManifestSection(result.manifest);
    expect(typeof rendered).toBe("string");
    expect(rendered.length).toBeGreaterThan(0);
  });

  test("contains every repoFact id", () => {
    const result = parseFactsManifest({
      repoFacts: [
        { id: "F-001", kind: "file", evidence: "e", summary: "s" },
        { id: "F-002", kind: "symbol", evidence: "e2", summary: "s2" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rendered = renderManifestSection(result.manifest);
    expect(rendered).toContain("F-001");
    expect(rendered).toContain("F-002");
  });

  test("contains every specClaim id", () => {
    const result = parseFactsManifest({
      specClaims: [
        {
          id: "S-001",
          specSpan: "span",
          claim: "claim",
          kind: "factual",
          verification: { status: "verified" },
        },
        {
          id: "S-002",
          specSpan: "span2",
          claim: "claim2",
          kind: "intent",
          verification: { status: "unverified" },
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rendered = renderManifestSection(result.manifest);
    expect(rendered).toContain("S-001");
    expect(rendered).toContain("S-002");
  });

  test("contains every gap id", () => {
    const result = parseFactsManifest({
      gaps: [
        { id: "G-001", kind: "missing-context", note: "note1" },
        { id: "G-002", kind: "ignored-convention", note: "note2" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rendered = renderManifestSection(result.manifest);
    expect(rendered).toContain("G-001");
    expect(rendered).toContain("G-002");
  });

  test("contains all id types in a mixed manifest", () => {
    const result = parseFactsManifest({
      repoFacts: [{ id: "F-001", kind: "contract", evidence: "e", summary: "s" }],
      specClaims: [
        {
          id: "S-001",
          specSpan: "span",
          claim: "claim",
          kind: "factual",
          verification: { status: "contradicted" },
        },
      ],
      gaps: [{ id: "G-001", kind: "boundary-not-considered", note: "note" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rendered = renderManifestSection(result.manifest);
    expect(rendered).toContain("F-001");
    expect(rendered).toContain("S-001");
    expect(rendered).toContain("G-001");
  });
});
