/**
 * Spec-deltas markdown formatter — US-004 AC4
 *
 * Formats blocker findings from plan-checklist verifier into
 * human-readable markdown with sections for:
 * - Contradicted spec claims
 * - Unverified spec claims (factual, not intent)
 * - Spec gaps surfaced by codebase
 */

import type { FactsManifest } from "@/debate/facts-manifest";

export interface VerifierFinding {
  checklistItem: string;
  severity: "blocker" | "major" | "minor";
  message?: string;
  specId?: string;
  gapId?: string;
  [key: string]: unknown;
}

export function formatSpecDeltas(blockers: VerifierFinding[], manifest: FactsManifest): string {
  const lines: string[] = ["# Spec Deltas"];

  const contradicted = blockers.filter((b) => b.checklistItem === "no-contradictions" && b.specId);
  const unverified = blockers.filter((b) => b.checklistItem === "spec-coverage" && b.specId);
  const gaps = blockers.filter((b) => b.checklistItem === "spec-coverage" && b.gapId);

  if (contradicted.length > 0) {
    lines.push("", "## Contradicted spec claims");
    for (const blocker of contradicted) {
      const claim = manifest.specClaims.find((c) => c.id === blocker.specId);
      if (!claim) {
        lines.push(`- **${blocker.specId}**: (claim not found in manifest)`);
        continue;
      }
      lines.push(`- **${claim.id}** (spec: ${claim.specSpan}): "${claim.claim}"`);
      if (claim.verification.evidence) {
        lines.push(`  - Verified evidence: ${claim.verification.evidence}`);
      }
      lines.push("  - Recommended action: re-roll spec OR rewrite spec claim");
    }
  }

  if (unverified.length > 0) {
    lines.push("", "## Unverified spec claims (factual, not intent)");
    for (const blocker of unverified) {
      const claim = manifest.specClaims.find((c) => c.id === blocker.specId);
      if (!claim) {
        lines.push(`- **${blocker.specId}**: (claim not found in manifest)`);
        continue;
      }
      lines.push(`- **${claim.id}**: "${claim.claim}"`);
      lines.push("  - No matching evidence found");
      lines.push("  - Recommended action: confirm or rewrite");
    }
  }

  if (gaps.length > 0) {
    lines.push("", "## Spec gaps surfaced by codebase");
    for (const blocker of gaps) {
      const gap = manifest.gaps.find((g) => g.id === blocker.gapId);
      if (!gap) {
        lines.push(`- **${blocker.gapId}**: (gap not found in manifest)`);
        continue;
      }
      lines.push(`- **${gap.id}**: ${gap.note}`);
      lines.push("  - Recommended action: address in revised spec");
    }
  }

  const unclassified = blockers.filter(
    (b) => !contradicted.includes(b) && !unverified.includes(b) && !gaps.includes(b),
  );
  if (unclassified.length > 0) {
    lines.push("", "## Other findings");
    for (const blocker of unclassified) {
      lines.push(`- ${blocker.checklistItem}: ${blocker.message ?? "(no message)"}`);
    }
  }

  return lines.join("\n");
}
