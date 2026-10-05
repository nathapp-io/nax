/**
 * session/update -> TurnEvent (S4 spec §6.7). S4-2 maps agent text only: each
 * agent_message_chunk text is a text_delta (round 0) and joins the turn's output.
 * S4-5 adds thoughts, tool calls, tool results and usage; every other update is
 * dropped until then (D-e). The sink is the facade's; a throw from it is contained.
 */
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { TurnEvent, TurnEventSink } from "@nathapp/nax-agent";

export interface TurnCollector {
  onUpdate(update: SessionUpdate): void;
  /** The turn's concatenated agent message text (turn_end.output). */
  output(): string;
}

export function createTurnCollector(emit: TurnEventSink | undefined): TurnCollector {
  const parts: string[] = [];
  const send = (event: TurnEvent): void => {
    try {
      emit?.(event);
    } catch {
      // The sink is the facade's event channel; a broken consumer must not break the turn.
    }
  };
  return {
    onUpdate(update) {
      if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") return;
      parts.push(update.content.text);
      send({ type: "text_delta", round: 0, text: update.content.text });
    },
    output: () => parts.join(""),
  };
}
