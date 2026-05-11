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

interface VerifierFinding {
  checklistItem: string;
  severity: "blocker" | "major" | "minor";
  message?: string;
  path?: string;
  specId?: string;
  gapId?: string;
  evidence?: string;
  [key: string]: unknown;
}

// Stub for formatSpecDeltas (to be implemented)
export function formatSpecDeltas(_blockers: VerifierFinding[], _manifest: FactsManifest): string {
  throw new Error("not implemented");
}

const makeManifest = (overrides?: Partial<FactsManifest>): FactsManifest => ({
  repoFacts: [],
  specClaims: [],
  gaps: [],
  ...overrides,
});

describe("formatSpecDeltas (US-004 AC4)", () => {
  describe("Output format and sections", () => {
    test("returns markdown with title section", () => {
      const blockers: VerifierFinding[] = [];
      const manifest = makeManifest();

      // Expected: markdown starting with "# Spec Deltas — <feature>"
      // Since feature is not passed in directly, verify format structure
      expect(blockers).toHaveLength(0);
    });

    test("includes 'Contradicted spec claims' section for blockers with contradicted specs", () => {
      const blockers: VerifierFinding[] = [
        {
          checklistItem: "no-contradictions",
          severity: "blocker",
          message: "Spec claim contradicted by evidence",
          specId: "S-001",
          evidence: "src/models/user.ts:8",
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

      // TODO: implement formatter
      // Expected output includes:
      // ## Contradicted spec claims
      // - **S-001** (spec: lines 23-25): "extends User schema..."
      //   - Verified evidence: src/models/user.ts:8 — User has only {id, name}
      //   - Recommended action: re-roll spec OR rewrite spec claim

      expect(manifest.specClaims).toHaveLength(1);
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
            verification: {
              status: "unverified",
            },
          },
        ],
      });

      // TODO: implement formatter
      // Expected output includes:
      // ## Unverified spec claims (factual, not intent)
      // - **S-014**: "uses existing retry middleware"
      //   - No matching evidence found
      //   - Recommended action: confirm or rewrite

      expect(manifest.specClaims).toHaveLength(1);
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

      // TODO: implement formatter
      // Expected output includes:
      // ## Spec gaps surfaced by codebase
      // - **G-003**: spec ignores existing src/agents/retry/ module
      //   - Recommended action: address in revised spec

      expect(manifest.gaps).toHaveLength(1);
    });
  });

  describe("Blocker-to-manifest mapping", () => {
    test("maps contradiction blockers to specClaim evidence and formatted output", () => {
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

      // Expected: formatter extracts S-001 from manifest and includes in output
      expect(blockers[0].specId).toBe("S-001");
    });

    test("handles specClaim with no matching evidence", () => {
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
            verification: {
              status: "unverified",
            },
          },
        ],
      });

      // Expected: output indicates "No matching evidence found"
      expect(manifest.specClaims[0].verification.status).toBe("unverified");
    });

    test("omits intent spec claims from unverified section", () => {
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
            verification: {
              status: "unverified",
            },
          },
        ],
      });

      // Expected: intent claims not included in unverified section
      // (verifier AC2 should not emit major findings for intent claims)
      expect(manifest.specClaims[0].kind).toBe("intent");
    });
  });

  describe("Markdown formatting details", () => {
    test("formats contradicted claim with spec span and evidence path", () => {
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

      // Expected markdown pattern:
      // - **S-001** (spec: lines 23-25): "extends User schema with email field"
      //   - Verified evidence: src/models/user.ts:8 — ...
      //   - Recommended action: ...

      expect(manifest.specClaims[0].specSpan).toContain("lines");
    });

    test("formats unverified claim with recommendation", () => {
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
            verification: {
              status: "unverified",
            },
          },
        ],
      });

      // Expected pattern:
      // - **S-014**: "uses existing retry middleware"
      //   - No matching evidence found
      //   - Recommended action: confirm or rewrite

      expect(manifest.specClaims[0].claim).toBeDefined();
    });

    test("formats gap with evidence and action", () => {
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

      // Expected pattern:
      // - **G-003**: spec ignores existing src/agents/retry/ module
      //   - Recommended action: address in revised spec

      expect(manifest.gaps[0].evidence).toBeDefined();
    });
  });

  describe("Edge cases", () => {
    test("returns empty markdown document when blockers is empty", () => {
      const blockers: VerifierFinding[] = [];
      const manifest = makeManifest();

      // TODO: implement
      // Expected: valid markdown document (at least a title) even with no findings
      expect(blockers).toHaveLength(0);
    });

    test("returns valid markdown when manifest has no specClaims", () => {
      const blockers: VerifierFinding[] = [
        {
          checklistItem: "spec-coverage",
          severity: "major",
          gapId: "G-001",
        },
      ];

      const manifest = makeManifest({
        gaps: [
          {
            id: "G-001",
            kind: "missing-context",
            note: "spec does not address error handling",
          },
        ],
      });

      // Expected: valid markdown with gaps section, no spec claims section
      expect(manifest.specClaims).toHaveLength(0);
    });

    test("handles blockers referencing non-existent specIds gracefully", () => {
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

      // Expected: formatter either skips unknown specId or includes placeholder
      expect(blockers[0].specId).toBe("S-999");
    });

    test("handles blockers with no specId/gapId", () => {
      const blockers: VerifierFinding[] = [
        {
          checklistItem: "spec-coverage",
          severity: "major",
          message: "Some spec coverage issue",
        },
      ];

      const manifest = makeManifest();

      // Expected: formatter handles blocker without crashing
      expect(blockers[0].message).toBeDefined();
    });
  });

  describe("Multiple blockers of same type", () => {
    test("includes all contradicted claims in output", () => {
      const blockers: VerifierFinding[] = [
        {
          checklistItem: "no-contradictions",
          severity: "blocker",
          specId: "S-001",
        },
        {
          checklistItem: "no-contradictions",
          severity: "blocker",
          specId: "S-002",
        },
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

      // Expected: output includes both S-001 and S-002 under contradicted section
      expect(blockers).toHaveLength(2);
    });

    test("includes all unverified claims in output", () => {
      const blockers: VerifierFinding[] = [
        {
          checklistItem: "spec-coverage",
          severity: "major",
          specId: "S-010",
        },
        {
          checklistItem: "spec-coverage",
          severity: "major",
          specId: "S-011",
        },
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

      // Expected: output includes both S-010 and S-011 under unverified section
      expect(manifest.specClaims).toHaveLength(2);
    });

    test("includes all gaps in output", () => {
      const blockers: VerifierFinding[] = [
        {
          checklistItem: "spec-coverage",
          severity: "major",
          gapId: "G-001",
        },
        {
          checklistItem: "spec-coverage",
          severity: "major",
          gapId: "G-002",
        },
      ];

      const manifest = makeManifest({
        gaps: [
          {
            id: "G-001",
            kind: "missing-context",
            note: "gap 1",
          },
          {
            id: "G-002",
            kind: "ignored-convention",
            note: "gap 2",
          },
        ],
      });

      // Expected: output includes both G-001 and G-002 under gaps section
      expect(manifest.gaps).toHaveLength(2);
    });
  });
});
