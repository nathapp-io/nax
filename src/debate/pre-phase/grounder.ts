/**
 * Grounder pre-debate phase strategy.
 *
 * Invokes the grounder operation to extract facts from codebase context and spec.
 */

import type { PreDebatePhase } from "./types";

export const grounderStrategy: PreDebatePhase = async (ctx) => {
  if (!ctx.specContent) {
    return { manifestSection: "", costUsd: 0 };
  }

  // TODO: Implement grounder strategy
  // 1. Call buildCodebaseContext(ctx.workdir)
  // 2. Call callOp(ctx.ctx, groundOp, { specContent, codebaseContext, workdir })
  // 3. Write manifest to .nax/runs/<runId>/plan/<storyId>/facts-manifest.json
  // 4. Return renderManifestSection(result)

  return { manifestSection: "", costUsd: 0 };
};
