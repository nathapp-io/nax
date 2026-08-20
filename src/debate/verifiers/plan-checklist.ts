/**
 * Plan-checklist post-debate verifier — US-004
 *
 * Thin adapter: delegates all mechanical checks to checks.ts and
 * handles debate-specific concerns (manifest loading, artifact emission,
 * outcome determination, onBlocker policy).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { VerifierFinding } from "@/plan/spec-deltas";
import { validatePlanOutput } from "@/prd";
import type { PRD } from "@/prd/types";
// Leaf import (not the `src/plan` barrel): the barrel re-exports `./strategies`
// which transitively depends on `src/cli`, `src/agents`, `src/operations` —
// closing 20+ cycles through `src/debate/verifiers/plan-checklist.ts`. The
// leaf `formatSpecDeltas` has no internal imports so it's cycle-free
// (#Phase C escalation).
import { formatSpecDeltas } from "../../plan/spec-deltas";
import type { FactsManifest } from "../facts-manifest";
import { parseFactsManifest } from "../facts-manifest";
import { checkAcAnchored, checkClaimsCited, checkFilesExist, checkNoContradictions, checkSpecCoverage } from "./checks";
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
    ...checkFilesExist(prd, ctx.workdir, { existsSync: _planChecklistDeps.existsSync }),
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
