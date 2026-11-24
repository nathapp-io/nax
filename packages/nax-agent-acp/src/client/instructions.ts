/**
 * The session instructions the agent has to be given: `nax generate`'s rendered
 * context, passed with the session options. nax-agent treats an empty string as
 * absent, so both sites that decide whether to send them and the one that records
 * their delivery share this predicate (US-003).
 */

/** Whether these session instructions carry anything to send. */
export function hasInstructions(instructions: string | undefined): instructions is string {
  return instructions !== undefined && instructions !== "";
}
