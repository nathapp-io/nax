/**
 * A `process.stdin` double for driving the real confirmation prompt in a test.
 *
 * `promptForConfirmation` reads one keypress through the `_confirmDeps.stdin` seam, so a test
 * that wants the production prompt — rather than a stubbed `confirm` — answers it here. The key
 * is delivered as soon as the prompt listens for `data`, one microtask later so the prompt has
 * finished attaching its listeners.
 *
 * The richer double `test/unit/cli/confirm.test.ts` keeps for itself records raw-mode calls and
 * lets a test emit any event: that is what the prompt's terminal-state contract is measured with.
 * This one exists for the callers — `nax memory compact`, `nax memory mirrors --prune` — whose
 * question is asked once and whose answer is all a test needs to vary.
 */
import type { ConfirmStdin } from "@/cli";

/**
 * Stdin that answers the first prompt with `key`.
 *
 * @param key - The byte a keypress delivers: `"y"`, `"\\r"` for Enter, and so on
 * @param isTTY - Whether the double reports a terminal; a non-TTY prompt never listens at all
 */
export function answeringStdin(key: string, isTTY = true): ConfirmStdin {
  return {
    isTTY,
    setRawMode: () => undefined,
    resume: () => undefined,
    pause: () => undefined,
    setEncoding: () => undefined,
    on: (_event, listener) => {
      queueMicrotask(() => listener(key));
    },
    once: () => undefined,
    removeListener: () => undefined,
  };
}
