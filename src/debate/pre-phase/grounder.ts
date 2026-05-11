/**
 * Grounder pre-debate phase strategy.
 *
 * Invokes the grounder operation to extract facts from codebase context and spec.
 * Writes the resulting manifest to .nax/runs/<runId>/plan/<storyId>/facts-manifest.json.
 */

import { join } from "node:path";
import { scanCodebase } from "@/analyze";
import { callOp } from "@/operations";
import { groundOp } from "@/operations/ground";
import type { FactsManifest } from "../facts-manifest";
import { renderManifestSection } from "../facts-manifest";
import type { PreDebatePhase, PreDebatePhaseContext } from "./types";

export const _grounderDeps = {
  scanCodebase,
  write: (path: string, data: string) => Bun.write(path, data),
};

async function buildCodebaseContext(workdir: string): Promise<string> {
  const scan = await _grounderDeps.scanCodebase(workdir);
  const sections: string[] = [];

  if (scan.fileTree) {
    sections.push(`## Codebase Structure\n\`\`\`\n${scan.fileTree}\n\`\`\``);
  }

  const allDeps = { ...scan.dependencies, ...scan.devDependencies };
  const depList = Object.entries(allDeps)
    .map(([name, version]) => `- ${name}@${version}`)
    .join("\n");

  if (depList) {
    sections.push(`## Dependencies\n${depList}`);
  }

  return sections.join("\n\n");
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
