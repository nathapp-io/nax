/**
 * session/update -> TurnEvent (S4 spec §6.7, S4-5). Agent text is a text_delta and
 * a thought a thinking_delta, round 0. Both are scrubbed of the session's secret
 * values, holding back only the tail that could start a secret (D5-g); a delta of
 * one stream, and any tool event, first flushes what the other stream holds, so the
 * order is kept. Tool calls and results come from tool-events.ts (D5-c to D5-f);
 * usage_update costs feed the session's cost meter (D5-b). User chunks, plans, mode,
 * config and command updates, and anything unknown are dropped. finish() flushes
 * held text and answers unanswered tool calls; settle(response) does that and then
 * emits the turn's one usage event (D5-h). Nothing is emitted after finish(). The
 * sink is the facade's; a throw from it is contained.
 */
import type { PromptResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import type { TurnEvent, TurnEventSink } from "@nathapp/nax-agent";
import { createStreamScrubber } from "#src/client/stream-scrub";
import { scrubSecrets } from "#src/client/text";
import { createToolEvents } from "#src/client/tool-events";
import { type CostMeter, createCostMeter, type TurnSpend, turnSpend, usageEvent } from "#src/client/usage";

export interface CollectorOptions {
  /** The session's secret values: env secrets and the tool host's token. */
  readonly secrets?: readonly string[];
  /** The session's cost meter; a fresh one when absent. */
  readonly meter?: CostMeter;
}

export interface TurnCollector {
  onUpdate(update: SessionUpdate): void;
  /** A permission request names this tool call: its tool_call event goes out now (D5-c). */
  announce(toolCall: unknown): void;
  /** Flushes held text and answers announced calls without a result. Idempotent. */
  finish(): void;
  /** finish(), then the turn's one usage event; returns the turn's spend. */
  settle(response: PromptResponse): TurnSpend;
  /** The turn's agent message text, scrubbed (turn_end.output). */
  output(): string;
}

type DeltaType = "text_delta" | "thinking_delta";

interface Deltas {
  push(type: DeltaType, text: string): void;
  flushAll(): void;
}

function createDeltas(send: (event: TurnEvent) => void, secrets: readonly string[]): Deltas {
  const streams = { text_delta: createStreamScrubber(secrets), thinking_delta: createStreamScrubber(secrets) };
  const out = (type: DeltaType, text: string): void => {
    if (text !== "") send({ type, round: 0, text });
  };
  const flush = (type: DeltaType): void => out(type, streams[type].flush());
  return {
    push(type, text) {
      flush(type === "text_delta" ? "thinking_delta" : "text_delta");
      out(type, streams[type].push(text));
    },
    flushAll() {
      flush("thinking_delta");
      flush("text_delta");
    },
  };
}

function containedSink(emit: TurnEventSink | undefined): (event: TurnEvent) => void {
  return (event) => {
    try {
      emit?.(event);
    } catch {
      // The sink is the facade's event channel; a broken consumer must not break the turn.
    }
  };
}

export function createTurnCollector(emit: TurnEventSink | undefined, options: CollectorOptions = {}): TurnCollector {
  const secrets = options.secrets ?? [];
  const meter = options.meter ?? createCostMeter();
  meter.beginTurn();
  const send = containedSink(emit);
  const deltas = createDeltas(send, secrets);
  const tools = createToolEvents((event) => {
    deltas.flushAll();
    send(event);
  }, secrets);
  const parts: string[] = [];
  let done = false;
  let spend: TurnSpend | undefined;
  const route = (update: SessionUpdate): void => {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type !== "text") return;
        parts.push(update.content.text);
        deltas.push("text_delta", update.content.text);
        return;
      case "agent_thought_chunk":
        if (update.content.type === "text") deltas.push("thinking_delta", update.content.text);
        return;
      case "tool_call":
      case "tool_call_update":
        tools.onUpdate(update);
        return;
      case "usage_update":
        meter.observe(update.cost);
        return;
      default:
        return;
    }
  };
  const finish = (): void => {
    if (done) return;
    done = true;
    deltas.flushAll();
    tools.flush();
  };
  return {
    onUpdate(update) {
      if (!done) route(update);
    },
    announce(toolCall) {
      if (!done) tools.announce(toolCall);
    },
    finish,
    settle(response) {
      finish();
      if (spend === undefined) {
        spend = turnSpend(response, meter);
        send(usageEvent(spend));
      }
      return spend;
    },
    output: () => scrubSecrets(parts.join(""), secrets),
  };
}
