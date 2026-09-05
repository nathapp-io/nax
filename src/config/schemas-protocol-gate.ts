/**
 * The `agent.protocol` cross-section gate.
 *
 * Extracted from schemas.ts, which reached its 600-line limit. This is one
 * coherent concern: everything here answers "given the declared protocol, is
 * this `models` block reachable, and are its ids in the form that path
 * accepts?" — questions no single field can answer on its own, which is why
 * they live in a superRefine rather than on the field schemas.
 *
 * protocol does not route; the agent name does (ADR-027 §2). It is a
 * capability gate, because native calls bill on a different path and must be
 * opted into rather than reached by a typo in `models`.
 */

import type { z } from "zod";
// Relative, not `@/agents`: the barrel would pull the whole agents tree into
// config (which agents itself imports). model-spec.ts is a dependency-free
// leaf, so this edge closes no cycle. See project-conventions.md § Path Aliases.
import { parseModelSpec } from "../agents/model-spec";

const NATIVE = "native";
const DEFAULT_PROTOCOL = "acp";
const DEFAULT_AGENT = "claude";

/**
 * Structural, not the parsed `NaxConfig`: this runs *during* that type's own
 * validation, so the value in hand is still partially-checked input.
 */
interface ProtocolGateInput {
  readonly agent?: { readonly protocol?: string; readonly default?: string };
  readonly models?: Record<string, Record<string, unknown> | undefined>;
}

/** A `ModelDef`-shaped entry. The string shorthand is the other form. */
function asModelDef(entry: unknown): { model?: unknown; provider?: unknown } | null {
  return typeof entry === "object" && entry !== null ? (entry as { model?: unknown; provider?: unknown }) : null;
}

export function validateProtocolGate(data: ProtocolGateInput, ctx: z.RefinementCtx): void {
  const protocol = data.agent?.protocol ?? DEFAULT_PROTOCOL;
  const modelAgents = Object.keys(data.models ?? {});

  if (protocol === DEFAULT_PROTOCOL && modelAgents.includes(NATIVE)) {
    ctx.addIssue({
      code: "custom",
      path: ["models", NATIVE],
      message:
        'models.native requires agent.protocol "hybrid" or "native" (it is "acp"). Set agent.protocol, or remove the native entry.',
    });
  }

  if (protocol === NATIVE) {
    for (const agent of modelAgents) {
      if (agent === NATIVE) continue;
      ctx.addIssue({
        code: "custom",
        path: ["models", agent],
        message: `agent.protocol "native" permits only models.native; "${agent}" is an acpx agent. Use "hybrid" to run both.`,
      });
    }
    if ((data.agent?.default ?? DEFAULT_AGENT) !== NATIVE) {
      ctx.addIssue({
        code: "custom",
        path: ["agent", "default"],
        message: 'agent.protocol "native" requires agent.default "native".',
      });
    }
  }

  validateNativeModelIds(data, ctx);
}

/**
 * Every `models.native` id must carry its provider (nax#1851).
 *
 * The native path reads the provider out of the model STRING and deliberately
 * ignores `ModelDef.provider`: `resolveModel` INFERS that field from the model
 * name, and a billed call must not route on a guess (see
 * `src/agents/native/adapter.ts`). Nothing said so at config load, so the
 * natural object form — `{ provider: "anthropic", model: "claude-sonnet-5" }`,
 * which validates cleanly against the documented `ModelDef` — parsed fine and
 * then died 74ms into a run that had already paid for its acceptance stage.
 */
function validateNativeModelIds(data: ProtocolGateInput, ctx: z.RefinementCtx): void {
  for (const [tier, entry] of Object.entries(data.models?.[NATIVE] ?? {})) {
    if (entry === undefined) continue;
    const def = asModelDef(entry);
    const modelId = def ? def.model : entry;
    if (typeof modelId !== "string" || modelId.length === 0) continue;
    // Strip the trailing [effort] suffix before the slash test. The suffix is
    // trailing, so testing the raw string would accept "m[a/b]" as qualified.
    if (parseModelSpec(modelId).model.includes("/")) continue;

    const sibling = def && typeof def.provider === "string" ? def.provider.trim() : "";
    ctx.addIssue({
      code: "custom",
      path: ["models", NATIVE, tier, ...(def ? ["model"] : [])],
      message:
        sibling.length > 0
          ? `models.${NATIVE}.${tier}.model "${modelId}" must be written "provider/model". The sibling "provider" field is not used on the native path — put it in the model id: "${sibling}/${modelId}".`
          : `models.${NATIVE}.${tier} "${modelId}" must be written "provider/model" (e.g. "openai/gpt-5.4-mini"). There is no default provider.`,
    });
  }
}
