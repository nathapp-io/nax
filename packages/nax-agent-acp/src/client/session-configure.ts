/**
 * OpenedBackend.configure over ACP (chat-acp-switch-and-replay US-002): the model and
 * the effort are set on the live agent session with session/set_config_option, the
 * same request open sends (open.ts applyModel / applyEffort). The model goes first;
 * the effort option is then looked up in the options the model response returned, so
 * an agent whose effort choices depend on the model is handled. An unoffered model or
 * effort refuses before any request (open skips an unoffered effort instead). Each
 * request is bounded by `timeoutMs` and the session's open signal, as an open step is,
 * and a JSON-RPC error is classified by openRequestError. `onApplied` hears each part
 * the moment its request succeeds, so a later failure never hides what the live agent
 * already holds. Only config options are used: the legacy session/set_model is not.
 */
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { SessionConfigureInput } from "@nathapp/nax-agent";
import { effortOptionId, MODEL_ID_MAX_CHARS, modelOptionId, resolveModelValue } from "#src/client/capabilities";
import type { AcpLink } from "#src/client/connection";
import {
  agentTextExcerpt,
  backendUnavailable,
  capabilityUnsupported,
  closedDuringOpen,
  openRequestError,
  rpcErrorOf,
} from "#src/client/errors";
import { configModelIds } from "#src/client/open";
import { race } from "#src/client/race";
import { cleanLabel } from "#src/client/text";

const STEP = "session/set_config_option";

/** At most this many offered ids go into a model refusal (agent-supplied text). */
const MAX_OFFERED_MODELS = 50;

/** One part of a configure that the agent has accepted. `model` is the value sent (resolved). */
export type AppliedPart = { readonly model: string } | { readonly effort: string };

export interface ConfigureAcpInput {
  readonly link: AcpLink;
  readonly agentSessionId: string;
  readonly agentName: string;
  readonly secrets: readonly string[];
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly sessionId: string;
  /** The session's current config options. */
  readonly configOptions: readonly SessionConfigOption[];
  readonly change: SessionConfigureInput;
}

/**
 * Applies `change`; resolves with the config options after the last request sent (the
 * input's when none was). `onApplied(part, configOptions)` runs right after each request succeeds.
 */
export async function configureAcpSession(
  input: ConfigureAcpInput,
  onApplied: (part: AppliedPart, configOptions: readonly SessionConfigOption[]) => void = () => {},
): Promise<readonly SessionConfigOption[]> {
  let options = input.configOptions;
  const { model, effort } = input.change;
  if (model !== undefined) {
    const value = resolveModel(input, options, model);
    const configId = modelOptionId(options, value);
    if (configId === undefined) throw modelRefusal(input, options, value);
    options = await setOption(input, options, configId, value);
    onApplied({ model: value }, options);
  }
  if (effort !== undefined) {
    const configId = effortOptionId(options, input.agentName, effort);
    if (configId === undefined) {
      throw capabilityUnsupported("effort", `the agent offers no effort option "${effort}"`);
    }
    options = await setOption(input, options, configId, effort);
    onApplied({ effort }, options);
  }
  return options;
}

function resolveModel(input: ConfigureAcpInput, options: readonly SessionConfigOption[], model: string): string {
  return resolveModelValue(input.agentName, configModelIds(options), model, input.secrets);
}

function modelRefusal(input: ConfigureAcpInput, options: readonly SessionConfigOption[], model: string) {
  const ids = configModelIds(options)
    .slice(0, MAX_OFFERED_MODELS)
    .map((id) => cleanLabel(id, input.secrets, MODEL_ID_MAX_CHARS) ?? "")
    .filter((id) => id !== "");
  return capabilityUnsupported(
    "model",
    `the agent offers no model option "${model}"; offered: ${ids.length === 0 ? "(none)" : ids.join(", ")}`,
    { offered: ids },
  );
}

/** One bounded session/set_config_option; the options its answer carries, else the ones it was sent against. */
async function setOption(
  input: ConfigureAcpInput,
  current: readonly SessionConfigOption[],
  configId: string,
  value: string,
): Promise<readonly SessionConfigOption[]> {
  const result = await race(input.link.setConfigOption({ sessionId: input.agentSessionId, configId, value }), {
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  switch (result.kind) {
    case "ok":
      return result.value.configOptions ?? current;
    case "aborted":
      throw closedDuringOpen(input.sessionId);
    case "timeout":
      throw backendUnavailable(`${STEP} timed out after ${input.timeoutMs} ms`, { during: STEP });
    case "failed": {
      const rpc = rpcErrorOf(result.error);
      if (rpc !== undefined) throw openRequestError(STEP, rpc, input.secrets);
      const message = result.error instanceof Error ? result.error.message : String(result.error);
      throw backendUnavailable(`${STEP} failed: ${agentTextExcerpt(message, input.secrets)}`, { step: STEP });
    }
  }
}
