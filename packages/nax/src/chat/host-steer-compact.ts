/**
 * The host's `steer` — and, from US-005, its `compact` — kept out of `chat-host.ts`, which
 * sits against the 600-line source cap.
 *
 * Steering is a facade delegation and nothing else: the session owns whether a backend can
 * take mid-turn input, whether a turn is running, and what the text's `applied` promise
 * settles to. The host's only own decision is the one a screen's key handler cannot afford to
 * have thrown at it — asking about a host with no session open answers `no_turn` rather than
 * the facade's not-open error, so ctrl+s in an idle chat does nothing instead of drawing a
 * failure.
 */
import type { AgentSession, SteerResult } from "@nathapp/nax-agent";

export interface HostSteerInput {
  /** The session the host has open right now, or `undefined` when it has none. */
  readonly session: () => AgentSession | undefined;
}

/** The steering half of the host: what `ChatHost.steer` answers. */
export interface HostSteering {
  steer(text: string): SteerResult;
}

export function createHostSteering(input: HostSteerInput): HostSteering {
  return {
    steer(text: string): SteerResult {
      const session = input.session();
      if (session === undefined) return { status: "no_turn" };
      // A facade that is not the native one has no mid-turn input at all: the screen then
      // interrupts and sends, which is what an `unsupported` brain does too.
      return session.steer?.(text) ?? { status: "unsupported" };
    },
  };
}
