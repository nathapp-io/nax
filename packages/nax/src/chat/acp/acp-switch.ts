/**
 * Which model changes an ACP chat session can take without a new process.
 *
 * ACP sets model and effort on a live session (`session/set-config-option`), so a
 * change inside one agent needs no reopen. A different agent is a different
 * process, and ACP has no value that means "your default", so a target that
 * names no model or no effort cannot be applied in place either.
 */
import type { SessionConfigureInput } from "@nathapp/nax-agent";
import { type ChatAcpModel, parseChatAcpModel } from "./acp-model";

/** A malformed `acp:` string counts as not ACP. */
function parsedAcp(model: string): ChatAcpModel | undefined {
  try {
    return parseChatAcpModel(model);
  } catch {
    // Not a valid ACP model: the caller reopens, which reports the real error.
    return undefined;
  }
}

/**
 * The configure input that turns the `from` session into `to`, or `undefined` when
 * the change needs a reopen: either side is not a valid ACP model, the agents
 * differ, nothing differs, or a differing part's target is the agent's own default.
 * A model change carries the target's effort, since an agent may reset effort on one.
 */
export function acpInPlaceChange(from: string, to: string): SessionConfigureInput | undefined {
  const source = parsedAcp(from);
  const target = parsedAcp(to);
  if (source === undefined || target === undefined || source.agent !== target.agent) return undefined;
  const modelChanged = source.model !== target.model;
  const effortChanged = source.effort !== target.effort;
  if (!modelChanged && !effortChanged) return undefined;
  if (modelChanged && target.model === undefined) return undefined;
  if (effortChanged && target.effort === undefined) return undefined;
  if (modelChanged) {
    return { model: target.model, ...(target.effort !== undefined ? { effort: target.effort } : {}) };
  }
  return { effort: target.effort };
}
