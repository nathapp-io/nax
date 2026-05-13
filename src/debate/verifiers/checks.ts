/**
 * Pure check functions for plan-checklist verification — US-002
 *
 * Extracted from plan-checklist.ts so pipeline stages and debate verifiers
 * can share the same logic without duplication.
 */

import { existsSync as defaultExistsSync } from "node:fs";
import { join } from "node:path";
import type { VerifierFinding } from "@/plan/spec-deltas";
import type { PRD } from "@/prd/types";
import type { FactsManifest } from "../facts-manifest";

export interface CheckDeps {
  existsSync: (path: string) => boolean;
}

export function checkFilesExist(prd: PRD, workdir: string, deps?: CheckDeps): VerifierFinding[] {
  const existsSync = deps?.existsSync ?? defaultExistsSync;
  const findings: VerifierFinding[] = [];
  for (const story of prd.userStories) {
    if (!story.contextFiles) continue;
    for (const entry of story.contextFiles) {
      const filePath = typeof entry === "string" ? entry : entry.path;
      const factId = typeof entry === "string" ? undefined : entry.factId;
      const absPath = join(workdir, filePath);
      if (existsSync(absPath)) continue;

      // An entry citing a manifest factId claims to be grounded in existing repo state.
      // If the path doesn't exist, grounding is broken — that's a blocker.
      if (factId) {
        findings.push({
          checklistItem: "files-exist",
          severity: "blocker",
          message: `Context file cites manifest fact ${factId} but path does not exist on disk: ${filePath}`,
          path: filePath,
          storyId: story.id,
        });
        continue;
      }

      // Uncited entry: legitimately may be a file the story will CREATE. Demote to
      // `major` so hallucinated paths are still surfaced without blocking valid new-file
      // plans. (Planners should put new files in the description, but cheap models leak.)
      findings.push({
        checklistItem: "files-exist",
        severity: "major",
        message: `Context file not on disk — if this is a new file the story creates, move it from "contextFiles" to the description's "Files touched" section: ${filePath}`,
        path: filePath,
        storyId: story.id,
      });
    }
  }
  return findings;
}

export function checkAcAnchored(prd: PRD): VerifierFinding[] {
  const findings: VerifierFinding[] = [];
  for (const story of prd.userStories) {
    const hasVerifiedBy = !!story.verifiedBy;
    const hasIntent = story.intent === true;
    if (!hasVerifiedBy && !hasIntent) {
      findings.push({
        checklistItem: "ac-anchored",
        severity: "major",
        message: `Story ${story.id} has no verifiedBy anchor and intent is not true`,
        storyId: story.id,
      });
    }
  }
  return findings;
}

export function checkClaimsCited(manifest: FactsManifest | null, threshold: number): VerifierFinding[] {
  if (!manifest || manifest.specClaims.length === 0) return [];
  const verified = manifest.specClaims.filter(
    (c) => c.verification.status === "verified" || c.verification.status === "partial",
  );
  const rate = verified.length / manifest.specClaims.length;
  if (rate < threshold) {
    return [
      {
        checklistItem: "claims-cited",
        severity: "major",
        message: `Citation rate ${(rate * 100).toFixed(0)}% is below threshold ${(threshold * 100).toFixed(0)}%`,
        citationRate: rate,
        threshold,
      },
    ];
  }
  return [];
}

export function checkNoContradictions(prd: PRD, manifest: FactsManifest | null): VerifierFinding[] {
  if (!manifest || manifest.specClaims.length === 0) return [];
  const contradictedIds = new Set(
    manifest.specClaims.filter((c) => c.verification.status === "contradicted").map((c) => c.id),
  );
  if (contradictedIds.size === 0) return [];

  const findings: VerifierFinding[] = [];
  for (const story of prd.userStories) {
    if (!story.contextFiles) continue;
    for (const entry of story.contextFiles) {
      const factId = typeof entry === "string" ? undefined : entry.factId;
      if (factId && contradictedIds.has(factId)) {
        findings.push({
          checklistItem: "no-contradictions",
          severity: "blocker",
          message: `Story ${story.id} references contradicted spec claim ${factId}`,
          specId: factId,
          storyId: story.id,
        });
      }
    }
  }
  return findings;
}

export function checkSpecCoverage(manifest: FactsManifest | null): VerifierFinding[] {
  if (!manifest || manifest.specClaims.length === 0) return [];
  const findings: VerifierFinding[] = [];
  for (const claim of manifest.specClaims) {
    if (claim.kind === "factual" && claim.verification.status === "unverified") {
      findings.push({
        checklistItem: "spec-coverage",
        severity: "major",
        message: `Unverified factual spec claim: ${claim.id} — "${claim.claim}"`,
        specId: claim.id,
      });
    }
  }
  for (const gap of manifest.gaps) {
    findings.push({
      checklistItem: "spec-coverage",
      severity: "major",
      message: `Spec gap: ${gap.id} — ${gap.note}`,
      gapId: gap.id,
    });
  }
  return findings;
}
