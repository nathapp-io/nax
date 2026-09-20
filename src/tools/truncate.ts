/**
 * Shared model-facing truncation policy — US-001.
 *
 * The single byte-safe implementation that `after_tool` will apply, replacing
 * the per-tool `truncate(body, ctx.maxBytes)` helpers. Constants, direction
 * lookup, and the core algorithm all live here so a future regression that
 * resuscitates a per-tool slicer sits behind one import rather than 5+.
 *
 * STUBS ONLY — see test/unit/tools/truncate.test.ts for the contracts.
 *
 * The stubs return placeholders guaranteed to fail any equality/length
 * assertion, so each test reaches its assertion line and demonstrates
 * missing behaviour rather than dying before it.
 */

export const READ_CEILING = 2_000_000;
export const MODEL_MAX_BYTES = 40_000;
export const MODEL_MAX_LINES = 1_000;
export const MODEL_MAX_LINE_CHARS = 2_000;

export type TruncationDirection = "head" | "tail-with-first-line";

/** Result of `truncateForModel`: the rewritten body and whether any stage changed it. */
export interface TruncationResult {
  readonly content: string;
  readonly truncated: boolean;
  /** Full UTF-8 byte length of the input, regardless of whether anything was truncated. */
  readonly originalBytes: number;
}

/** Options passed to `truncateForModel`. Direction is determined by tool name via `truncationDirectionFor`. */
export interface TruncateForModelOptions {
  readonly direction: TruncationDirection;
}

/** Stub: returns a placeholder that fails any equality/length assertion. Implementer replaces. */
export function truncateForModel(body: string, _opts: TruncateForModelOptions): TruncationResult {
  void body;
  void _opts;
  return { content: "__STUB__", truncated: false, originalBytes: -1 };
}

/** Stub: returns an empty string (not a valid direction). Implementer replaces. */
export function truncationDirectionFor(toolName: string): TruncationDirection {
  void toolName;
  return "" as TruncationDirection;
}
