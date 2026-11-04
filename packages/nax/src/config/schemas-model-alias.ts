/**
 * `agent.modelAliases` schema: a Claude Code model name mapped to either a nax
 * model id or an ACP agent target.
 * Split from schemas-infra.ts to keep that file within the 600-line limit.
 */

import { z } from "zod";

const ACP_PREFIX = "acp:";

/**
 * A nax model id as `parseNativeModel` reads one: `provider/model` with an
 * optional trailing `[effort]`. Shape only — provider catalogs are not
 * consulted. The provider ends at the FIRST slash; the model may hold more.
 */
const MODEL_ALIAS_TARGET = /^[^\s/[\]]+\/[^\s[\]]+(\[[^\s[\]]+\])?$/;

/**
 * An ACP target as `parseChatAcpModel` reads one: `acp:<agent>`, optionally
 * `/<model>`, optionally `[effort]`. Kept here as its own copy because config
 * must not import from `src/chat`; `agent-schema.test.ts` pins it against
 * `parseChatAcpModel` so the two cannot drift apart silently.
 */
const ACP_ALIAS_TARGET = /^acp:(claude|codex|cursor)(\/[^\s[\]]+)?(\[[^\s[\]]+\])?$/;

const ALIAS_TARGET_MESSAGE =
  'agent.modelAliases values must be "provider/model" or "acp:<agent>[/<model>]" (agent: claude, codex, cursor), each with an optional [effort] suffix and no whitespace';

/**
 * An `acp:` value is held to the ACP shape alone. Without that split the
 * provider/model branch would read `acp:bogus/x` as provider `acp:bogus`.
 */
function isAliasTarget(value: string): boolean {
  return value.startsWith(ACP_PREFIX) ? ACP_ALIAS_TARGET.test(value) : MODEL_ALIAS_TARGET.test(value);
}

const ModelAliasTargetSchema = z.string().refine(isAliasTarget, { message: ALIAS_TARGET_MESSAGE });

export const ModelAliasesSchema = z.record(
  z.string().trim().min(1, "agent.modelAliases keys must be non-empty"),
  ModelAliasTargetSchema,
);
