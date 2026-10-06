/** Driving a facade session's turn and reading its events, for backend tests. */
import type { AgentSession, SessionEvent } from "@nathapp/nax-agent";

/** Runs one turn; `onEvent` sees each event as it arrives (answer or cancel from it). */
export async function driveTurn(
  session: AgentSession,
  message: string,
  onEvent: (event: SessionEvent) => void = () => {},
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of session.send(message)) {
    events.push(event);
    onEvent(event);
  }
  return events;
}

export function endOf(events: readonly SessionEvent[]) {
  const last = events.at(-1);
  if (last?.type !== "turn_end") throw new Error("the turn did not end");
  return last;
}

export function indexOfType(events: readonly SessionEvent[], type: SessionEvent["type"]): number {
  return events.findIndex((event) => event.type === type);
}
