/**
 * `nax context` CLI commands
 */

import { loadContextManifests } from "../context/engine";

export interface ContextInspectOptions {
  dir?: string;
  feature?: string;
  json?: boolean;
  storyId: string;
}

export async function contextInspectCommand(options: ContextInspectOptions): Promise<void> {
  const workdir = options.dir ?? process.cwd();
  const manifests = await loadContextManifests(workdir, options.storyId, options.feature);

  if (options.json) {
    console.log(JSON.stringify(manifests, null, 2));
    return;
  }

  if (manifests.length === 0) {
    console.log(`No context manifests found for story ${options.storyId}.`);
    return;
  }

  console.log(`Context manifests for ${options.storyId}:`);
  for (const item of manifests) {
    console.log(
      `- ${item.featureId} / ${item.stage}: included=${item.manifest.includedChunks.length}, excluded=${item.manifest.excludedChunks.length}, usedTokens=${item.manifest.usedTokens}, path=${item.path}`,
    );
  }
}
