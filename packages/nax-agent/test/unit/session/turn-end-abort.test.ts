/**
 * US-003: the abort reason nax gives on purpose.
 *
 * A bare `abort()` already yields a runtime-native `DOMException` named
 * `AbortError`, so carrying a reason that the abandoned-tool message can read
 * needs a distinct class — one whose NAME still satisfies the AbortError
 * contract (`session/manager.ts`, `watchdog-turn-classification.ts` key on it)
 * while its MESSAGE says why the turn ended, and whose identity tells nax's
 * own reason apart from a runtime one.
 */
import { describe, expect, test } from "bun:test";
import { TurnEndAbort } from "#src/session/turn-end-abort";

describe("TurnEndAbort", () => {
  test('AC-1: is an Error whose name is "AbortError" and whose message is the turn-end reason', () => {
    const abort = new TurnEndAbort("x");
    expect(abort).toBeInstanceOf(Error);
    expect(abort.name).toBe("AbortError");
    expect(abort.message).toBe("x");
  });
});
