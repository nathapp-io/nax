/**
 * Agent text as a stream, scrubbed of the session's secret values (S4-5 D5-g). A
 * secret can arrive split across two chunks, so each push scrubs the held tail plus
 * the new chunk and then holds back the last (longest secret length - 1)
 * characters: any secret not yet complete must start inside them. flush() releases
 * the rest. With no secret of MIN_SECRET_LENGTH or more, nothing is held: each
 * chunk passes through unchanged.
 */
import { MIN_SECRET_LENGTH, scrubSecrets } from "#src/client/text";

export interface StreamScrubber {
  /** Adds a chunk; returns the text that is safe to emit now (possibly ""). */
  push(chunk: string): string;
  /** Returns everything held back, scrubbed, and empties the hold. */
  flush(): string;
}

const PASS_THROUGH: StreamScrubber = { push: (chunk) => chunk, flush: () => "" };

/** `at`, moved back one when it would split a surrogate pair. */
function safeCut(text: string, at: number): number {
  if (at <= 0) return 0;
  const code = text.charCodeAt(at - 1);
  return code >= 0xd800 && code <= 0xdbff ? at - 1 : at;
}

export function createStreamScrubber(secrets: readonly string[]): StreamScrubber {
  const active = secrets.filter((secret) => secret.length >= MIN_SECRET_LENGTH);
  if (active.length === 0) return PASS_THROUGH;
  const hold = Math.max(...active.map((secret) => secret.length)) - 1;
  let held = "";
  return {
    push(chunk) {
      const text = scrubSecrets(held + chunk, active);
      const cut = safeCut(text, text.length - hold);
      held = text.slice(cut);
      return text.slice(0, cut);
    },
    flush() {
      const rest = scrubSecrets(held, active);
      held = "";
      return rest;
    },
  };
}
