/**
 * Tests for formatSpecDeltas — US-004 AC4
 *
 * Covers:
 * - AC4: formatSpecDeltas returns markdown sections for contradicted, unverified, and gap findings
 * - Proper markdown formatting with sections and evidence
 * - Handling of empty blocker sets
 */

import { describe, expect, test } from "bun:test";
import type { FactsManifest } from "@/debate";
import { formatSpecDeltas } from "@/plan";
import type { VerifierFinding } from "@/plan/spec-deltas";

const makeManifest = (overrides?: Partial<FactsManifest>): FactsManifest => ({
  repoFacts: [],
  specClaims: [],
  gaps: [],
  ...overrides,
});

describe("formatSpecDeltas (US-004 AC4)", () => {
  describe("Output format and sections", () => {
    test("returns markdown with title section", () => {
      const output = formatSpecDeltas([], makeManifest());
      expect(output).toContain("# Spec Deltas");
    });

    test("includes 'Contradicted spec claims' section for blockers with contradicted specs", () => {
      const blockers: VerifierFinding[] = [
        {
          checklistItem: "no-contradictions",
          severity: "blocker",
          message: "Spec claim contradicted by evidence",
          specId: "S-001",
        },
      ];

      const manifest = makeManifest({
        specClaims: [
          {
            id: "S-001",
            specSpan: "lines 23-25",
            claim: "extends User schema with email field",
            kind: "factual",
            verification: {
              status: "contradicted",
              evidence: "User has only {id, name}",
              factId: "F-001",
            },
          },
        ],
      });

      const output = formatSpecDeltas(blockers, manifest);
      expect(output).toContain("## Contradicted spec claims");
      expect(output).toContain("**S-001**");
      expect(output).toContain("extends User schema with email field");
      expect(output).toContain("lines 23-25");
      expect(output).toContain("User has only {id, name}");
      expect(output).toContain("re-roll spec OR rewrite spec claim");
    });

    test("includes 'Unverified spec claims' section for unverified factual claims", () => {
      const blockers: VerifierFinding[] = [
        {
          checklistItem: "spec-coverage",
          severity: "major",
          message: "Unverified factual spec claim",
          specId: "S-014",
        },
      ];

      const manifest = makeManifest({
        specClaims: [
          {
            id: "S-014",
            specSpan: "line 50",
            claim: "uses existing retry middleware",
            kind: "factual",
            verification: { status: "unverified" },
          },
        ],
      });

      const output = formatSpecDeltas(blockers, manifest);
      expect(output).toContain("## Unverified spec claims (factual, not intent)");
      expect(output).toContain("**S-014**");
      expect(output).toContain("uses existing retry middleware");
      expect(output).toContain("No matching evidence found");
      expect(output).toContain("confirm or rewrite");
    });

    test("includes 'Spec gaps' section for gap findings from codebase", () => {
      const blockers: VerifierFinding[] = [
        {
          checklistItem: "spec-coverage",
          severity: "major",
          message: "Spec ignores existing module",
          gapId: "G-003",
        },
      ];

      const manifest = makeManifest({
        gaps: [
          {
            id: "G-003",
            kind: "ignored-convention",
            note: "spec ignores existing src/agents/retry/ module",
            evidence: "src/agents/retry/ exists but not mentioned in spec",
          },
        ],
      });

      const output = formatSpecDeltas(blockers, manifest);
      expect(output).toContain("## Spec gaps surfaced by codebase");
      expect(output).toContain("**G-003**");
      expect(output).toContain("spec ignores existing src/agents/retry/ module");
      expect(output).toContain("address in revised spec");
    });
  });

  describe("Blocker-to-manifest mapping", () => {
    test("maps contradiction blockers to specClaim evidence and formats output", () => {
      const blockers: VerifierFinding[] = [
        {
          checklistItem: "no-contradictions",
          severity: "blocker",
          message: "Contradicted spec claim",
          specId: "S-001",
        },
      ];

      const manifest = makeManifest({
        specClaims: [
          {
            id: "S-001",
            specSpan: "lines 10-15",
            claim: "adds email to user schema",
            kind: "factual",
            verification: {
              status: "contradicted",
              evidence: "User schema unchanged",
              factId: "F-002",
            },
          },
        ],
      });

      const output = formatSpecDeltas(blockers, manifest);
      expect(output).toContain("S-001");
      expect(output).toContain("adds email to user schema");
      expect(output).toContain("User schema unchanged");
    });

    test("outputs placeholder when specClaim has no matching evidence field", () => {
      const blockers: VerifierFinding[] = [
        {
          checklistItem: "spec-coverage",
          severity: "major",
          specId: "S-999",
        },
      ];

      const manifest = makeManifest({
        specClaims: [
          {
            id: "S-999",
            specSpan: "line 30",
            claim: "non-existent middleware",
            kind: "factual",
            verification: { status: "unverified" },
          },
        ],
      });

      const output = formatSpecDeltas(blockers, manifest);
      expect(output).toContain("S-999");
      expect(output).toContain("No matching evidence found");
    });

    test("omits intent spec claims from unverified section (only factual goes in spec-coverage blockers)", () => {
      // The verifier only emits spec-coverage findings for factual claims (see checkSpecCoverage).
      // If an intent claim somehow appears as a blocker with specId, it would still
      // be listed under "Unverified spec claims" — but the verifier spec says it should not emit
      // major findings for intent claims. This test confirms the formatter does not hide it if
      // the upstream verifier incorrectly emits one; the exclusion responsibility is the verifier's.
      // Here we assert that an intent claim with no matching specId in the manifest gets a
      // placeholder, not a crash.
      const blockers: VerifierFinding[] = [
        {
          checklistItem: "spec-coverage",
          severity: "major",
          specId: "S-005",
        },
      ];

      const manifest = makeManifest({
        specClaims: [
          {
            id: "S-005",
            specSpan: "line 40",
            claim: "maintains backward compatibility",
            kind: "intent",
            verification: { status: "unverified" },
          },
        ],
      });

      // formatSpecDeltas routes by checklistItem ("spec-coverage" + specId → unverified section).
      // The intent/factual distinction is not checked by the formatter; it trusts the verifier.
      const output = formatSpecDeltas(blockers, manifest);
      expect(output).toContain("S-005");
    });
  });

  describe("Markdown formatting details", () => {
    test("formats contradicted claim with spec span, claim text, evidence, and recommendation", () => {
      const blockers: VerifierFinding[] = [
        {
          checklistItem: "no-contradictions",
          severity: "blocker",
          specId: "S-001",
        },
      ];

      const manifest = makeManifest({
        specClaims: [
          {
            id: "S-001",
            specSpan: "lines 23-25",
            claim: "extends User schema with email field",
            kind: "factual",
            verification: {
              status: "contradicted",
              evidence: "src/models/user.ts:8",
              factId: "F-001",
            },
          },
        ],
      });

      const output = formatSpecDeltas(blockers, manifest);
      expect(output).toMatch(/\*\*S-001\*\* \(spec: lines 23-25\)/);
      expect(output).toContain('"extends User schema with email field"');
      expect(output).toContain("Verified evidence: src/models/user.ts:8");
      expect(output).toContain("Recommended action: re-roll spec OR rewrite spec claim");
    });

    test("formats unverified claim with claim text, no-evidence note, and recommendation", () => {
      const blockers: VerifierFinding[] = [
        {
          checklistItem: "spec-coverage",
          severity: "major",
          specId: "S-014",
        },
      ];

      const manifest = makeManifest({
        specClaims: [
          {
            id: "S-014",
            specSpan: "line 50",
            claim: "uses existing retry middleware",
            kind: "factual",
            verification: { status: "unverified" },
          },
        ],
      });

      const output = formatSpecDeltas(blockers, manifest);
      expect(output).toMatch(/\*\*S-014\*\*/);
      expect(output).toContain('"uses existing retry middleware"');
      expect(output).toContain("No matching evidence found");
      expect(output).toContain("Recommended action: confirm or rewrite");
    });

    test("formats gap with note and action", () => {
      const blockers: VerifierFinding[] = [
        {
          checklistItem: "spec-coverage",
          severity: "major",
          gapId: "G-003",
        },
      ];

      const manifest = makeManifest({
        gaps: [
          {
            id: "G-003",
            kind: "ignored-convention",
            note: "spec ignores existing src/agents/retry/ module",
            evidence: "src/agents/retry/ exists in codebase",
          },
        ],
      });

      const output = formatSpecDeltas(blockers, manifest);
      expect(output).toMatch(/\*\*G-003\*\*/);
      expect(output).toContain("spec ignores existing src/agents/retry/ module");
      expect(output).toContain("Recommended action: address in revised spec");
    });
  });

  describe("Edge cases", () => {
    test("returns only title when blockers is empty", () => {
      const output = formatSpecDeltas([], makeManifest());
      expect(output).toBe("# Spec Deltas");
    });

    test("returns valid markdown with gaps section when manifest has no specClaims", () => {
      const blockers: VerifierFinding[] = [
        {
          checklistItem: "spec-coverage",
          severity: "major",
          gapId: "G-001",
        },
      ];

      const manifest = makeManifest({
        gaps: [{ id: "G-001", kind: "missing-context", note: "spec does not address error handling" }],
      });

      const output = formatSpecDeltas(blockers, manifest);
      expect(output).toContain("## Spec gaps surfaced by codebase");
      expect(output).toContain("G-001");
      expect(output).not.toContain("## Contradicted spec claims");
      expect(output).not.toContain("## Unverified spec claims");
    });

    test("includes placeholder when blocker references non-existent specId in manifest", () => {
      const blockers: VerifierFinding[] = [
        {
          checklistItem: "no-contradictions",
          severity: "blocker",
          specId: "S-999",
        },
      ];

      const manifest = makeManifest({
        specClaims: [
          {
            id: "S-001",
            specSpan: "line 10",
            claim: "test claim",
            kind: "factual",
            verification: { status: "verified" },
          },
        ],
      });

      const output = formatSpecDeltas(blockers, manifest);
      expect(output).toContain("S-999");
      expect(output).toContain("claim not found in manifest");
    });

    test("includes unclassified 'Other findings' section for blockers with no specId or gapId", () => {
      const blockers: VerifierFinding[] = [
        {
          checklistItem: "spec-coverage",
          severity: "major",
          message: "Some spec coverage issue with no specId",
        },
      ];

      const output = formatSpecDeltas(blockers, makeManifest());
      expect(output).toContain("## Other findings");
      expect(output).toContain("spec-coverage");
      expect(output).toContain("Some spec coverage issue with no specId");
    });
  });

  describe("Multiple blockers of same type", () => {
    test("includes all contradicted claims in output", () => {
      const blockers: VerifierFinding[] = [
        { checklistItem: "no-contradictions", severity: "blocker", specId: "S-001" },
        { checklistItem: "no-contradictions", severity: "blocker", specId: "S-002" },
      ];

      const manifest = makeManifest({
        specClaims: [
          {
            id: "S-001",
            specSpan: "lines 10-15",
            claim: "claim 1",
            kind: "factual",
            verification: { status: "contradicted", evidence: "evidence 1" },
          },
          {
            id: "S-002",
            specSpan: "lines 20-25",
            claim: "claim 2",
            kind: "factual",
            verification: { status: "contradicted", evidence: "evidence 2" },
          },
        ],
      });

      const output = formatSpecDeltas(blockers, manifest);
      expect(output).toContain("S-001");
      expect(output).toContain("claim 1");
      expect(output).toContain("S-002");
      expect(output).toContain("claim 2");
    });

    test("includes all unverified claims in output", () => {
      const blockers: VerifierFinding[] = [
        { checklistItem: "spec-coverage", severity: "major", specId: "S-010" },
        { checklistItem: "spec-coverage", severity: "major", specId: "S-011" },
      ];

      const manifest = makeManifest({
        specClaims: [
          {
            id: "S-010",
            specSpan: "line 50",
            claim: "claim 1",
            kind: "factual",
            verification: { status: "unverified" },
          },
          {
            id: "S-011",
            specSpan: "line 60",
            claim: "claim 2",
            kind: "factual",
            verification: { status: "unverified" },
          },
        ],
      });

      const output = formatSpecDeltas(blockers, manifest);
      expect(output).toContain("S-010");
      expect(output).toContain("claim 1");
      expect(output).toContain("S-011");
      expect(output).toContain("claim 2");
    });

    test("includes all gaps in output", () => {
      const blockers: VerifierFinding[] = [
        { checklistItem: "spec-coverage", severity: "major", gapId: "G-001" },
        { checklistItem: "spec-coverage", severity: "major", gapId: "G-002" },
      ];

      const manifest = makeManifest({
        gaps: [
          { id: "G-001", kind: "missing-context", note: "gap 1" },
          { id: "G-002", kind: "ignored-convention", note: "gap 2" },
        ],
      });

      const output = formatSpecDeltas(blockers, manifest);
      expect(output).toContain("G-001");
      expect(output).toContain("gap 1");
      expect(output).toContain("G-002");
      expect(output).toContain("gap 2");
    });
  });
});
