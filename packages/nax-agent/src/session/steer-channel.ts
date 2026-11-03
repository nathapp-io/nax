/**
 * Per-turn steering (US-001). The facade owns each session's pending steers:
 * `steer()` appends to the ACTIVE turn claim's queue, the native turn loop
 * drains it through `take()` at a safe boundary, and the queue closes when the
 * claim settles so a steer can never carry into the next `send()`.
 *
 * Ordering is arrival order and every pending text is handed over on one
 * `take()`: the loop injects them as consecutive user messages, so splitting a
 * drain across calls would interleave model output between them.
 *
 * The queue is deliberately transport-neutral: ACP has no mid-turn user input,
 * so its backend never declares `steerable` and never receives a channel.
 */
import { _agentSessionDeps } from "./agent-session-deps.ts";

/**
 * What `AgentSession.steer` answers (US-001).
 *
 * `accepted` is not "injected": the text is pending until the turn reaches a
 * boundary. `applied` resolves `true` when the loop took the text, and `false`
 * when the turn ended with it still pending — a cancelled, stopped, timed-out
 * or failed turn, or a turn that finished before the steer arrived.
 */
export type SteerResult =
  | { readonly status: "accepted"; readonly steerId: string; readonly applied: Promise<boolean> }
  | { readonly status: "unsupported" }
  | { readonly status: "no_turn" };

/**
 * What a turn's `sendTurn` options carry (US-001). The loop reads it; nothing
 * in the loop writes to it.
 */
export interface SteerChannel {
  /** Removes every pending steer, in arrival order. `[]` once the channel closed. */
  take(): readonly string[];
}

/** The facade's side of a turn's channel. */
export interface SteerQueue extends SteerChannel {
  /** Appends one text, in arrival order. */
  add(text: string): { readonly steerId: string; readonly applied: Promise<boolean> };
  /** Closes the channel: everything still pending resolves `false` and is discarded. */
  close(): void;
}

interface PendingSteer {
  readonly text: string;
  readonly resolve: (applied: boolean) => void;
  readonly applied: Promise<boolean>;
}

export function createSteerQueue(): SteerQueue {
  let pending: PendingSteer[] = [];
  let closed = false;

  /** Hand over everything pending, resolving each entry with `applied`. */
  function drain(applied: boolean): readonly string[] {
    const taken = pending;
    pending = [];
    for (const steer of taken) steer.resolve(applied);
    return taken.map((steer) => steer.text);
  }

  return {
    add(text) {
      const steerId = _agentSessionDeps.randomUUID();
      const settled = Promise.withResolvers<boolean>();
      pending = [...pending, { text, resolve: settled.resolve, applied: settled.promise }];
      return { steerId, applied: settled.promise };
    },
    take: () => (closed ? [] : drain(true)),
    close: () => {
      closed = true;
      drain(false);
    },
  };
}
