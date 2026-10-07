/**
 * nax's SessionAskPort for the ACP backend (S4b spec §6.3). nax never maps a
 * session to profile `ask`, so requestApproval is a logged deny. An agent's ACP
 * question (elicitation) goes to the run's interaction handler as a question,
 * on the same budget as the loop's own interactions, with the awaiting-human
 * beat running so the idle watchdog does not cancel a turn waiting on a person.
 * recordAutoDecision only logs in S4b-2; S4b-3 writes the tool-audit row (D2-k).
 */
import type { SessionAskPort } from "@nathapp/nax-agent";
import { getSafeLogger } from "@/logger";
import { awaitInteractionReply } from "../interaction";
import type { RunningTurn, TurnSlot } from "./turn-slot";

const STAGE = "acp-sdk";

/** How often a pending ACP question tells the idle watchdog the turn waits on a person (900 s idle default). */
export const AWAITING_HUMAN_BEAT_MS = 30_000;

/**
 * Emits agent.awaiting_human now and every beatMs until stopped. setTimeout, not
 * Bun.sleep: the pending timer is cleared the moment the reply settles.
 */
function beatWhileWaiting(turn: RunningTurn, beatMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const beat = (): void => {
    turn.call.awaitingHuman();
    timer = setTimeout(beat, beatMs);
  };
  beat();
  return () => clearTimeout(timer);
}

async function askQuestion(
  slot: TurnSlot,
  text: string,
  extra: AbortSignal | undefined,
  beatMs: number,
): Promise<string | null> {
  const turn = slot.current();
  if (turn === undefined || !turn.consumeInteraction()) return null;
  const signal = extra === undefined ? turn.signal : AbortSignal.any([turn.signal, extra]);
  const stopBeats = beatWhileWaiting(turn, beatMs);
  try {
    const reply = await awaitInteractionReply(
      { interactionHandler: turn.interactionHandler, signal, stage: STAGE },
      { kind: "question", text },
      ": ",
    );
    if (reply.kind !== "answered") return null;
    turn.recordExchange(text, reply.answer);
    return reply.answer;
  } finally {
    stopBeats();
  }
}

export function createAskPort(slot: TurnSlot, beatMs: number = AWAITING_HUMAN_BEAT_MS): SessionAskPort {
  return {
    requestApproval: async (req) => {
      getSafeLogger()?.warn(STAGE, "ACP approval requested, but nax never opens a session under profile ask; denied", {
        tool: req.tool,
      });
      return { decision: "deny", decidedBy: "profile" };
    },
    recordAutoDecision: (req, decision) => {
      if (decision === "deny") {
        getSafeLogger()?.debug(STAGE, "ACP request denied by the session profile", {
          tool: req.tool,
          reason: req.reason,
        });
      }
    },
    askQuestion: (text, opts) => askQuestion(slot, text, opts?.signal, beatMs),
    noteQuestion: (text) => {
      getSafeLogger()?.debug(STAGE, "ACP agent note", { text });
    },
  };
}
