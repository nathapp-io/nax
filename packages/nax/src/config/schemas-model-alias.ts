/**
 * `agent.modelAliases` schema: a Claude Code model name mapped to a nax model id.
 * Split from schemas-infra.ts to keep that file within the 600-line limit.
 */

import { z } from "zod";

/**
 * A nax model id as `parseNativeModel` reads one: `provider/model` with an
 * optional trailing `[effort]`. Shape only — provider catalogs are not
 * consulted. The provider ends at the FIRST slash; the model may hold more.
 */
const MODEL_ALIAS_TARGET = /^[^\s/[\]]+\/[^\s[\]]+(\[[^\s[\]]+\])?$/;

const ModelAliasTargetSchema = z
  .string()
  .regex(
    MODEL_ALIAS_TARGET,
    'agent.modelAliases values must be "provider/model" with an optional [effort] suffix and no whitespace (e.g. "anthropic/claude-sonnet-5-5")',
  );

export const ModelAliasesSchema = z.record(
  z.string().trim().min(1, "agent.modelAliases keys must be non-empty"),
  ModelAliasTargetSchema,
);
