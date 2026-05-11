/**
 * Plan-checklist post-debate verifier — US-004
 *
 * Performs five mechanical checks on synthesized PRD:
 * 1. files-exist — all contextFiles exist on disk
 * 2. ac-anchored — each AC has verifiedBy or intent=true
 * 3. claims-cited — citation rate above threshold
 * 4. no-contradictions — no PRD spec claims reference contradicted factIds
 * 5. spec-coverage — all unverified factual spec claims addressed
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { VerifierFinding } from "@/plan/spec-deltas";
import { formatSpecDeltas } from "@/plan/spec-deltas";
import { validatePlanOutput } from "@/prd/schema";
import type { PRD } from "@/prd/types";
import type { FactsManifest } from "../facts-manifest";
import { parseFactsManifest } from "../facts-manifest";
import type { PostDebateVerifier, PostDebateVerifierContext, PostDebateVerifierResult } from "./types";

export const _planChecklistDeps = {
  existsSync,
  write: (path: string, data: string) => Bun.write(path, data),
  readFile: async (path: string): Promise<string | null> => {
    try {
      return await Bun.file(path).text();
    } catch {
      return null;
    }
  },
};

const DEFAULT_CITATION_THRESHOLD = 0.5;

function parsePrd(output: string | undefined): PRD | null {
  if (!output) return null;
  try {
    return validatePlanOutput(output, "", "");
  } catch {
    return null;
  }
}

async function loadManifest(ctx: PostDebateVerifierContext): Promise<FactsManifest | null> {
  const manifestPath = join(
    ctx.workdir,
    ".nax",
    "runs",
    ctx.ctx.runtime.runId,
    "plan",
    ctx.storyId,
    "facts-manifest.json",
  );
  const raw = await _planChecklistDeps.readFile(manifestPath);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const result = parseFactsManifest(parsed);
    return result.ok ? result.manifest : null;
  } catch {
    return null;
  }
}

function checkFilesExist(prd: PRD, workdir: string): VerifierFinding[] {
  const findings: VerifierFinding[] = [];
  for (const story of prd.userStories) {
    if (!story.contextFiles) continue;
    for (const entry of story.contextFiles) {
      const filePath = typeof entry === "string" ? entry : entry.path;
      const absPath = join(workdir, filePath);
      if (!_planChecklistDeps.existsSync(absPath)) {
        findings.push({
          checklistItem: "files-exist",
          severity: "blocker",
          message: `Context file does not exist on disk: ${filePath}`,
          path: filePath,
          storyId: story.id,
        });
      }
    }
  }
  return findings;
}

function checkAcAnchored(prd: PRD): VerifierFinding[] {
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

function checkClaimsCited(manifest: FactsManifest | null, threshold: number): VerifierFinding[] {
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

function checkNoContradictions(prd: PRD, manifest: FactsManifest | null): VerifierFinding[] {
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

function checkSpecCoverage(manifest: FactsManifest | null): VerifierFinding[] {
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

async function emitSpecDeltas(
  ctx: PostDebateVerifierContext,
  blockers: VerifierFinding[],
  manifest: FactsManifest | null,
): Promise<string> {
  const artifactPath = join(ctx.workdir, ".nax", "runs", ctx.ctx.runtime.runId, "plan", ctx.storyId, "spec-deltas.md");
  const content = formatSpecDeltas(blockers, manifest ?? { repoFacts: [], specClaims: [], gaps: [] });
  await _planChecklistDeps.write(artifactPath, content);
  return artifactPath;
}

export const planChecklistVerifier: PostDebateVerifier = async (
  ctx: PostDebateVerifierContext,
): Promise<PostDebateVerifierResult> => {
  const prd = parsePrd(ctx.selectorResult.output);
  if (!prd) {
    return { outcome: "failed", costUsd: 0 };
  }

  const manifest = await loadManifest(ctx);
  const threshold =
    (ctx.stageConfig as { postDebateVerifier?: { citationThreshold?: number } }).postDebateVerifier
      ?.citationThreshold ?? DEFAULT_CITATION_THRESHOLD;

  const findings: VerifierFinding[] = [
    ...checkFilesExist(prd, ctx.workdir),
    ...checkAcAnchored(prd),
    ...checkClaimsCited(manifest, threshold),
    ...checkNoContradictions(prd, manifest),
    ...checkSpecCoverage(manifest),
  ];

  const blockers = findings.filter((f) => f.severity === "blocker");

  if (blockers.length > 0) {
    const artifactPath = await emitSpecDeltas(ctx, blockers, manifest);
    const onBlocker = ctx.stageConfig.postDebateVerifier?.onBlocker ?? "block";
    if (onBlocker === "tag-expert") {
      return { outcome: "passed", findings, output: artifactPath, costUsd: 0 };
    }
    return { outcome: "failed", findings, output: artifactPath, costUsd: 0 };
  }

  return { outcome: "passed", findings, costUsd: 0 };
};
