/**
 * Annotates top-level `nax-agents__run` tool calls with the model the run would use
 * (`metadata.subagentModel`), so the Agent card can name it. Every other event passes through.
 */
import type { SessionEvent } from "@nathapp/nax-agent";
import type { SubagentRuns } from "./subagent-runs";

const AGENT_RUN_TOOL = "nax-agents__run";

function agentInput(input: unknown): { agent: string; model?: string } | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const agent = Reflect.get(input, "agent");
  if (typeof agent !== "string") return undefined;
  const model = Reflect.get(input, "model");
  return typeof model === "string" ? { agent, model } : { agent };
}

export function withAgentCallModel(
  onEvent: (event: SessionEvent) => void,
  modelFor: SubagentRuns["modelFor"],
): (event: SessionEvent) => void {
  return (event) => {
    if (event.type !== "tool_call" || event.name !== AGENT_RUN_TOOL) return onEvent(event);
    const call = agentInput(event.input);
    const model = call === undefined ? undefined : modelFor(call.agent, call.model);
    if (model === undefined) return onEvent(event);
    onEvent({ ...event, metadata: { ...event.metadata, subagentModel: model } });
  };
}
