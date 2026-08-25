/**
 * Grounder pre-debate phase strategy.
 *
 * Invokes the grounder operation to extract facts from codebase context and spec.
 * Writes the resulting manifest to .nax/runs/<runId>/plan/<storyId>/facts-manifest.json.
 */

import { join } from "node:path";
import { type SourceRoot, scanSourceRoots } from "@/analyze";
import { callOp, groundOp } from "@/operations";
import { buildSourceRootsSection } from "@/prompts";
import type { FactsManifest } from "../facts-manifest";
import { renderManifestSection } from "../facts-manifest";
import type { PreDebatePhase, PreDebatePhaseContext } from "./types";

export const _grounderDeps = {
  scanSourceRoots,
  write: (path: string, data: string) => Bun.write(path, data),
};

async function buildCodebaseContext(workdir: string): Promise<string> {
  const roots = await _grounderDeps.scanSourceRoots(workdir);
  return buildSourceRootsSection(normalizeRoots(workdir, roots));
}

function normalizeRoots(workdir: string, roots: SourceRoot[]): SourceRoot[] {
  return roots.map((root) => ({
    ...root,
    path: root.path.startsWith("/") ? root.path.replace(`${workdir}/`, "") : root.path,
  }));
}

async function writeManifestArtifact(ctx: PreDebatePhaseContext, manifest: FactsManifest): Promise<void> {
  const manifestPath = join(
    ctx.workdir,
    ".nax",
    "runs",
    ctx.ctx.runtime.runId,
    "plan",
    ctx.storyId,
    "facts-manifest.json",
  );
  await _grounderDeps.write(manifestPath, JSON.stringify(manifest, null, 2));
}

export const grounderStrategy: PreDebatePhase = async (ctx) => {
  if (!ctx.specContent) {
    return { manifestSection: "", costUsd: 0 };
  }

  const codebaseContext = await buildCodebaseContext(ctx.workdir);
  const result = await callOp(ctx.ctx, groundOp, {
    specContent: ctx.specContent,
    codebaseContext,
    workdir: ctx.workdir,
  });

  await writeManifestArtifact(ctx, result);

  return {
    manifestSection: renderManifestSection(result),
    costUsd: 0,
  };
};
