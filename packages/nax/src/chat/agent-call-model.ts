/**
 * Annotates top-level `nax-agents__run` tool calls with the model the run would use and
 * where that model came from (`metadata.subagentModel`, `metadata.subagentModelSource`),
 * so the Agent card can name both. Every other event passes through.
 */
import type { SessionEvent } from "@nathapp/nax-agent";
import type { SubagentRuns } from "./subagent-runs";

const AGENT_RUN_TOOL = "nax-agents__run";

/**
 * What a `nax-agents__run` call asks `modelFor` about. An absent `agent` is the built-in
 * general agent; the call itself is `undefined` when the input asks for no model at all.
 */
interface AgentRunCall {
  /** The agent named by the call; undefined means the built-in general agent. */
  readonly agent: string | undefined;
  readonly override: string | undefined;
}

/**
 * The model request a `nax-agents__run` input carries, or undefined when the input asks
 * for neither a named agent nor a model — a present but non-string `agent` or `model` is
 * a malformed call, and annotating it would name a model that will never run.
 */
function agentRunCall(input: unknown): AgentRunCall | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const agent = Reflect.get(input, "agent");
  const model = Reflect.get(input, "model");
  const override = typeof model === "string" ? model : undefined;
  if (typeof agent === "string") return { agent, override };
  // A non-string agent is forwarded untouched, as before; an absent one is the general agent.
  if (agent !== undefined) return undefined;
  return override === undefined ? undefined : { agent: undefined, override };
}

export function withAgentCallModel(
  onEvent: (event: SessionEvent) => void,
  modelFor: SubagentRuns["modelFor"],
): (event: SessionEvent) => void {
  return (event) => {
    if (event.type !== "tool_call" || event.name !== AGENT_RUN_TOOL) return onEvent(event);
    const call = agentRunCall(event.input);
    const resolved = call === undefined ? undefined : modelFor(call.agent, call.override);
    if (resolved === undefined) return onEvent(event);
    onEvent({
      ...event,
      metadata: { ...event.metadata, subagentModel: resolved.model, subagentModelSource: resolved.label },
    });
  };
}
