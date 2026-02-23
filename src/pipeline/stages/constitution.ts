/**
 * Constitution Stage
 *
 * Loads the project constitution (if enabled) and stores it in context.
 * Constitution defines coding standards, architectural rules, and forbidden patterns.
 *
 * @returns
 * - `continue`: Always continues (soft failure if constitution missing)
 *
 * @example
 * ```ts
 * // Constitution enabled and found
 * await constitutionStage.execute(ctx);
 * // ctx.constitution: { content: "...", tokens: 500, truncated: false }
 *
 * // Constitution enabled but not found
 * await constitutionStage.execute(ctx);
 * // ctx.constitution: undefined (stage logs warning and continues)
 * ```
 */

import { dirname } from "node:path";
import { loadConstitution } from "../../constitution";
import { getLogger } from "../../logger";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

export const constitutionStage: PipelineStage = {
  name: "constitution",
  enabled: (ctx) => ctx.config.constitution.enabled,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();

    // Constitution file is in nax/constitution.md
    // featureDir is nax/features/<name>/, so we need to go up two levels
    const ngentDir = ctx.featureDir ? dirname(dirname(ctx.featureDir)) : `${ctx.workdir}/nax`;

    const result = await loadConstitution(ngentDir, ctx.config.constitution);

    if (result) {
      ctx.constitution = result;

      logger.debug("constitution", "Constitution loaded", {
        tokens: result.tokens,
        truncated: result.truncated,
      });

      if (result.truncated) {
        logger.warn("constitution", "Constitution truncated", {
          originalTokens: result.originalTokens,
          tokens: result.tokens,
          maxTokens: ctx.config.constitution.maxTokens,
        });
      }
    } else {
      // SOFT FAILURE: Constitution missing or failed to load — continue without it
      // This is acceptable because constitution is optional project governance
      logger.debug("constitution", "Constitution not found or failed to load");
    }

    return { action: "continue" };
  },
};
