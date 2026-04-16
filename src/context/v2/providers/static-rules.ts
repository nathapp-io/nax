/**
 * Context Engine v2 — StaticRulesProvider
 *
 * Reads project-wide static rules (CLAUDE.md / .nax/rules/) and
 * returns them as "static" kind chunks with budget-floor guarantee.
 *
 * Phase 0: reads only CLAUDE.md (or equivalent agent config file).
 * Phase 5.1: extended to read .nax/rules/ canonical store.
 *
 * Chunks from this provider are always included in the push markdown
 * regardless of budget (floor behavior — see packing.ts).
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { getLogger } from "../../../logger";
import { errorMessage } from "../../../utils/errors";
import type { ContextProviderResult, ContextRequest, IContextProvider, RawChunk } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

export const _staticRulesDeps = {
  readFile: async (path: string): Promise<string> => Bun.file(path).text(),
  fileExists: async (path: string): Promise<boolean> => Bun.file(path).exists(),
};

// ─────────────────────────────────────────────────────────────────────────────
// Candidate files (in priority order)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Static rules candidate file names, checked in order.
 * The first file found in the workdir is used.
 */
const CANDIDATE_FILES = ["CLAUDE.md", ".cursorrules", "AGENTS.md"];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function contentHash8(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

export class StaticRulesProvider implements IContextProvider {
  readonly id = "static-rules";
  readonly kind = "static" as const;

  async fetch(request: ContextRequest): Promise<ContextProviderResult> {
    const logger = getLogger();
    const chunks: RawChunk[] = [];

    for (const fileName of CANDIDATE_FILES) {
      const filePath = join(request.workdir, fileName);

      try {
        const exists = await _staticRulesDeps.fileExists(filePath);
        if (!exists) continue;

        const content = await _staticRulesDeps.readFile(filePath);
        if (!content.trim()) continue;

        const hash = contentHash8(content);
        const tokens = estimateTokens(content);

        chunks.push({
          id: `static-rules:${hash}`,
          kind: "static",
          scope: "project",
          // Static rules apply to all roles — they are project-wide invariants
          role: ["all"],
          content: `### ${fileName}\n\n${content.trim()}`,
          tokens,
          // Full score — static rules are always relevant
          rawScore: 1.0,
        });

        logger.debug("static-rules", "Loaded static rules", {
          storyId: request.storyId,
          file: fileName,
          tokens,
        });

        // Only load the first candidate found
        break;
      } catch (err) {
        logger.warn("static-rules", `Failed to read ${fileName} — skipping`, {
          storyId: request.storyId,
          file: fileName,
          error: errorMessage(err),
        });
      }
    }

    return { chunks, pullTools: [] };
  }
}
