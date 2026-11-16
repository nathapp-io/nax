/**
 * The facade's turn deadline timer (#2962). A session opened with `turnTimeoutSeconds: "none"`
 * has no deadline, so nothing is armed and nothing needs clearing; any other value arms one
 * timer for that many seconds. Turns, `!` commands and manual compaction all share it.
 */
import { _agentSessionDeps } from "./agent-session-deps.ts";
import type { TurnTimeoutSeconds } from "./agent-session-types.ts";

/** Stops a deadline timer; a no-op when none was armed. */
export type DisarmDeadline = () => void;

export function armTurnDeadline(seconds: TurnTimeoutSeconds, onDeadline: () => void): DisarmDeadline {
  if (seconds === "none") return () => {};
  const timer = _agentSessionDeps.setTimeout(onDeadline, seconds * 1000);
  return () => _agentSessionDeps.clearTimeout(timer);
}
