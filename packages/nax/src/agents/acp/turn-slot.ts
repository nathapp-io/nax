/**
 * The adapter's current-turn slot (S4b spec §6.1 step 2, §6.2 step 3.2). The
 * turn loop sets it around each backend prompt; the backend reads its signal and
 * turn id through BackendOpenContext, and the ask port reads the rest. Between
 * prompts it holds nothing and the signal never aborts.
 */
import type { InteractionHandler } from "@nathapp/nax-agent";
import type { CallBridge } from "./stream-bridge";

export interface RunningTurn {
  readonly signal: AbortSignal;
  readonly turnId: string;
  readonly interactionHandler: InteractionHandler;
  readonly call: CallBridge;
  /** Takes one unit of the loop's shared interaction budget; false when it is spent (§6.3). */
  readonly consumeInteraction: () => boolean;
  /** Records an answered question in the loop's TurnResult.interactions. */
  readonly recordExchange: (question: string, reply: string) => void;
}

export interface TurnSlot {
  current(): RunningTurn | undefined;
  set(turn: RunningTurn): void;
  clear(): void;
  /** The running prompt's signal, or a never-aborting one between prompts. */
  signal(): AbortSignal;
  turnId(): string | undefined;
}

/** Never aborted: what the backend reads between prompts. */
const IDLE_SIGNAL: AbortSignal = new AbortController().signal;

export function createTurnSlot(): TurnSlot {
  let running: RunningTurn | undefined;
  return {
    current: () => running,
    set: (turn) => {
      running = turn;
    },
    clear: () => {
      running = undefined;
    },
    signal: () => running?.signal ?? IDLE_SIGNAL,
    turnId: () => running?.turnId,
  };
}
