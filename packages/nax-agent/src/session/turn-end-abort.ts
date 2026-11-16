/**
 * US-003: the abort reason nax gives on purpose.
 *
 * The AbortError contract is a NAME, not a class: `session/manager.ts` and
 * `watchdog-turn-classification.ts` key on `err.name === "AbortError"`, and a
 * bare `abort()` already produces a `DOMException` with that name and the
 * runtime's own message. So a distinguishable reason cannot be a different
 * name — it is a nax-owned class whose name keeps the contract and whose
 * message says WHY the turn ended.
 *
 * `session/session-interaction.ts` reads exactly this class to render the
 * abandoned-tool text with its message; anything else (a runtime
 * `DOMException`, a bare `abort()`, an unrelated error) keeps the text that
 * says only that the turn ended.
 *
 * Internal to nax-agent: deliberately not exported from the package's `.`
 * entry, so the AbortError contract stays the only public promise.
 */
export class TurnEndAbort extends Error {
  override readonly name = "AbortError";
}
