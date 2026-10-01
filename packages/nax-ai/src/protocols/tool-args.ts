/**
 * Streamed tool-call argument accumulation.
 *
 * A pure helper rather than a method on a backend: every protocol receives
 * arguments as JSON fragments and must accumulate before parsing, so a
 * hand-written backend needs this same logic and should not re-derive it.
 */

interface PendingToolArgs {
  readonly name: string;
  readonly raw: string;
}

export interface ToolArgAccumulator {
  /** Appends a fragment and returns everything accumulated for `id` so far. */
  append(id: string, name: string, fragment: string): string;
  /** Removes and returns the accumulation, or undefined if `id` is unknown. */
  take(id: string): PendingToolArgs | undefined;
}

export function createToolArgAccumulator(): ToolArgAccumulator {
  const pending = new Map<string, PendingToolArgs>();

  return {
    append(id, name, fragment) {
      const current = pending.get(id);
      // The name arrives with the first fragment and is authoritative; later
      // fragments may not carry it.
      const next: PendingToolArgs = {
        name: current?.name ?? name,
        raw: (current?.raw ?? "") + fragment,
      };
      pending.set(id, next);
      return next.raw;
    },

    take(id) {
      const current = pending.get(id);
      pending.delete(id);
      return current;
    },
  };
}

/**
 * Parses an accumulated argument string.
 *
 * An empty accumulation means the provider sent a tool call with no arguments,
 * which is an empty object rather than an error.
 */
export function parseToolArgs(raw: string): unknown {
  return raw === "" ? {} : JSON.parse(raw);
}
