/**
 * Context Engine v2 — StaticRulesProvider
 *
 * Reads project-wide static rules and returns them as "static" kind chunks
 * with budget-floor guarantee.
 *
 * Phase 0: reads only CLAUDE.md (or equivalent agent config file).
 * Phase 5.1: reads from .nax/rules/ canonical store first. Falls back to
 *   CLAUDE.md / .cursorrules / AGENTS.md when allowLegacyClaudeMd is true
 *   and no canonical rules exist, emitting a deprecation warning.
 *
 * Chunks from this provider are always included in the push markdown
 * regardless of budget (floor behavior — see packing.ts).
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { getLogger } from "../../../logger";
import { errorMessage } from "../../../utils/errors";
import { loadCanonicalRules } from "../../rules/canonical-loader";
import type { ContextProviderResult, ContextRequest, IContextProvider, RawChunk } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

export const _staticRulesDeps = {
  readFile: async (path: string): Promise<string> => Bun.file(path).text(),
  fileExists: async (path: string): Promise<boolean> => Bun.file(path).exists(),
  loadCanonicalRules,
};

// ─────────────────────────────────────────────────────────────────────────────
// Legacy candidate files (Phase 0 / allowLegacyClaudeMd fallback)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Legacy static rules candidate file names, checked in order.
 * Only used when .nax/rules/ is absent and allowLegacyClaudeMd is true.
 */
const LEGACY_CANDIDATE_FILES = ["CLAUDE.md", ".cursorrules", "AGENTS.md"];

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

export interface StaticRulesProviderOptions {
  /**
   * Fall back to reading CLAUDE.md / .cursorrules / AGENTS.md when
   * .nax/rules/ is absent. Default: true (migration period).
   * Set false to enforce strict canonical-only rules loading.
   */
  allowLegacyClaudeMd?: boolean;
}

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

  private readonly allowLegacyClaudeMd: boolean;

  constructor(options: StaticRulesProviderOptions = {}) {
    this.allowLegacyClaudeMd = options.allowLegacyClaudeMd ?? true;
  }

  async fetch(request: ContextRequest): Promise<ContextProviderResult> {
    const logger = getLogger();

    // Phase 5.1: try canonical store first
    try {
      const canonicalRules = await _staticRulesDeps.loadCanonicalRules(request.projectDir ?? request.workdir);
      if (canonicalRules.length > 0) {
        const chunks = canonicalRules.map((rule) => {
          const hash = contentHash8(rule.content);
          const tokens = estimateTokens(rule.content);
          return {
            id: `static-rules:${hash}`,
            kind: "static" as const,
            scope: "project" as const,
            role: ["all"] as ["all"],
            content: `### ${rule.fileName}\n\n${rule.content}`,
            tokens,
            rawScore: 1.0,
          } satisfies RawChunk;
        });

        logger.debug("static-rules", "Loaded canonical rules", {
          storyId: request.storyId,
          fileCount: chunks.length,
        });

        return { chunks, pullTools: [] };
      }
    } catch (err) {
      // NeutralityLintError or other loader error — propagate so the operator sees it
      logger.warn("static-rules", "Canonical rules loader failed", {
        storyId: request.storyId,
        error: errorMessage(err),
      });
      // Re-throw: linter violations must not silently fall back to legacy rules.
      throw err;
    }

    // No canonical rules found. Apply legacy fallback policy.
    if (!this.allowLegacyClaudeMd) {
      logger.warn("static-rules", "No .nax/rules/ found and allowLegacyClaudeMd is false — loading zero rules", {
        storyId: request.storyId,
      });
      return { chunks: [], pullTools: [] };
    }

    // allowLegacyClaudeMd: true — emit deprecation warning and fall back to legacy files
    logger.warn(
      "static-rules",
      "No .nax/rules/ found — falling back to legacy rule files (deprecation warning). " +
        "Run `nax rules migrate` to create the canonical store.",
      {
        storyId: request.storyId,
      },
    );

    return this.fetchLegacy(request);
  }

  /**
   * Legacy Phase 0 path: reads the first of CLAUDE.md / .cursorrules / AGENTS.md.
   * Only called when .nax/rules/ is absent and allowLegacyClaudeMd is true.
   */
  private async fetchLegacy(request: ContextRequest): Promise<ContextProviderResult> {
    const logger = getLogger();
    const chunks: RawChunk[] = [];
    const rootDir = request.projectDir ?? request.workdir;

    // Detect multiple candidates so operators know which one was chosen when more than one exists.
    const existingCandidates: string[] = [];
    for (const fileName of LEGACY_CANDIDATE_FILES) {
      try {
        if (await _staticRulesDeps.fileExists(join(rootDir, fileName))) {
          existingCandidates.push(fileName);
        }
      } catch {
        // ignore probe failures; the main loop will surface real errors.
      }
    }
    if (existingCandidates.length > 1) {
      logger.warn("static-rules", "Multiple legacy candidate files found — preferring the first in precedence order", {
        storyId: request.storyId,
        candidates: existingCandidates,
        chosen: existingCandidates[0],
      });
    }

    for (const fileName of LEGACY_CANDIDATE_FILES) {
      const filePath = join(rootDir, fileName);

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
          role: ["all"],
          content: `### ${fileName}\n\n${content.trim()}`,
          tokens,
          rawScore: 1.0,
        });

        logger.debug("static-rules", "Loaded legacy static rules", {
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
