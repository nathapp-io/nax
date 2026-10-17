/**
 * What a session/new, session/resume or session/load answer offers a profile
 * (S4 spec §6.3 step 5). An agent may offer its modes and models as config
 * options (`configOptions`, the ACP 1.x way) or as the legacy `modes` and
 * `models` blocks (Gemini); a mode or model the agent offers only in a legacy
 * block is set with `session/set_mode` / `session/set_model` (open.ts). The
 * answer is agent data, so every read here is checked: a missing, malformed or
 * non-string block offers nothing.
 */
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { isRecord } from "#src/client/text";

export interface SessionOffers {
  readonly configOptions: readonly SessionConfigOption[];
  /** `modes.availableModes[].id`: the mode ids set with session/set_mode. */
  readonly modeIds: readonly string[];
  /** `models.availableModels[].modelId`: the model ids set with session/set_model. */
  readonly modelIds: readonly string[];
}

const NOTHING: SessionOffers = Object.freeze({
  configOptions: Object.freeze([]),
  modeIds: Object.freeze([]),
  modelIds: Object.freeze([]),
});

function configOptionsOf(response: Readonly<Record<string, unknown>>): readonly SessionConfigOption[] {
  const value = response.configOptions;
  return Array.isArray(value) ? (value as readonly SessionConfigOption[]) : [];
}

/** The non-empty string ids of `block[listKey][idKey]`, skipping anything else. */
function idsOf(block: unknown, listKey: string, idKey: string): readonly string[] {
  if (!isRecord(block)) return [];
  const list = block[listKey];
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const id: unknown = isRecord(entry) ? entry[idKey] : undefined;
    return typeof id === "string" && id !== "" ? [id] : [];
  });
}

export function sessionOffers(response: unknown): SessionOffers {
  if (!isRecord(response)) return NOTHING;
  const configOptions = configOptionsOf(response);
  const modeIds = idsOf(response.modes, "availableModes", "id");
  const modelIds = idsOf(response.models, "availableModels", "modelId");
  if (configOptions.length === 0 && modeIds.length === 0 && modelIds.length === 0) return NOTHING;
  return { configOptions, modeIds, modelIds };
}
