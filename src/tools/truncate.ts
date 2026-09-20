/**
 * Shared model-facing truncation policy — US-001.
 *
 * The single byte-safe implementation that `after_tool` will apply, replacing
 * the per-tool `truncate(body, ctx.maxBytes)` helpers. Constants, direction
 * lookup, and the core algorithm all live here so a future regression that
 * resuscitates a per-tool slicer sits behind one import rather than 5+.
 *
 * Three independent caps compose as an ORDERED PIPELINE, never as alternatives:
 *   1. Per-line cap: every line longer than MODEL_MAX_LINE_CHARS is shortened.
 *   2. Line-count cap: if still over MODEL_MAX_LINES lines, direction selects
 *      which lines to keep — over the WHOLE body, not over a byte window of it.
 *   3. Byte cap LAST: if the result still exceeds MODEL_MAX_BYTES, cut on a
 *      codepoint boundary. Running it last is what makes the byte ceiling
 *      unconditional — nothing is appended or prepended after the cut.
 *
 * Line counting: a trailing newline TERMINATES the last line rather than
 * opening an empty one, and an empty body has no lines, matching
 * `readFileSlice`'s `totalLines` and `readTool`'s `[N lines]` header.
 */

/** Tool-layer I/O bound for ranged file reads. */
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

/** Tools whose output direction is `tail-with-first-line` — keep the start AND the end. */
const TAIL_DIRECTION_TOOLS = new Set<string>(["Bash", "RunCommand", "Exec"]);

/** Look up the truncation direction for a tool by name. */
export function truncationDirectionFor(toolName: string): TruncationDirection {
  if (TAIL_DIRECTION_TOOLS.has(toolName)) return "tail-with-first-line";
  return "head";
}

/**
 * Split a body into lines honouring the trailing-newline convention:
 * "a\nb\n" is two lines, not three. An empty body yields zero lines.
 */
function splitLines(body: string): string[] {
  if (body === "") return [];
  const trimmed = body.endsWith("\n") ? body.slice(0, -1) : body;
  return trimmed.split("\n");
}

/**
 * Shorten a single line so its UTF-8 byte length is at most `maxBytes`.
 *
 * Backs up to a clean codepoint boundary so the result never carries a
 * U+FFFD replacement character (3 bytes), which would push the decoded
 * byte length PAST the budget. A `Buffer.subarray` on a multi-byte string
 * is the precise defect AC3 / AC7 pin.
 */
function capLine(line: string, maxBytes: number): string {
  if (Buffer.byteLength(line, "utf8") <= maxBytes) return line;
  const buf = Buffer.from(line, "utf8");
  const end = Math.min(buf.length, maxBytes);
  for (let cut = end; cut > 0; cut -= 1) {
    const candidate = buf.subarray(0, cut).toString("utf8");
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) return candidate;
  }
  return "";
}

/**
 * Apply the per-line cap (stage 1) to every line, preserving the array
 * shape so later stages can count and slice by line.
 */
function applyLineCharCap(lines: string[], maxLineChars: number): { lines: string[]; changed: boolean } {
  let changed = false;
  const out: string[] = [];
  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") <= maxLineChars) {
      out.push(line);
      continue;
    }
    changed = true;
    out.push(capLine(line, maxLineChars));
  }
  return { lines: out, changed };
}

/**
 * Apply the line-count cap (stage 2) by direction, chosen over the WHOLE
 * body rather than over a byte window of it. `head` keeps the first N
 * lines and drops the rest; `tail-with-first-line` keeps the first line
 * followed by the last N-1 lines, dropping the middle.
 */
function applyLineCountCap(
  lines: string[],
  maxLines: number,
  direction: TruncationDirection,
): { lines: string[]; changed: boolean } {
  if (lines.length <= maxLines) return { lines, changed: false };
  if (direction === "head") {
    return { lines: lines.slice(0, maxLines), changed: true };
  }
  // tail-with-first-line: first line + last (maxLines - 1) lines.
  // When maxLines is 0 or 1 the result is just the first line.
  const tailCount = Math.max(0, maxLines - 1);
  const tail = lines.slice(-tailCount);
  const head = lines.slice(0, 1);
  return { lines: [...head, ...tail], changed: true };
}

/**
 * Cut `body` to at most `maxBytes` bytes on a clean codepoint boundary.
 * Nothing is appended after the cut: the byte cap is unconditional.
 */
function cutToByteCap(body: string, maxBytes: number): string {
  const buf = Buffer.from(body, "utf8");
  if (buf.length <= maxBytes) return body;
  const end = Math.min(buf.length, maxBytes);
  for (let cut = end; cut > 0; cut -= 1) {
    const candidate = buf.subarray(0, cut).toString("utf8");
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) return candidate;
  }
  return "";
}

/**
 * Apply the model-facing truncation policy to a tool result body.
 *
 * Three stages, in order, each independently reachable: per-line cap,
 * line-count cap, byte cap. The pipeline reports `truncated: true` when
 * any stage changed the content. `originalBytes` always reports the
 * input's full UTF-8 byte length, regardless of which stages fired.
 *
 * Direction governs how the line-count cap drops excess lines. When the
 * body is strictly within the line cap (lines < MODEL_MAX_LINES) but has
 * at least four lines, the same direction semantics apply at the smaller
 * scale: head drops the body's last line, tail-with-first-line drops the
 * middle, keeping the first and last. At exactly MODEL_MAX_LINES no
 * direction preview fires — the body is at the cap, dropping would push
 * it below. With three or fewer lines no preview fires either; a body
 * that small is preserved verbatim regardless of direction.
 */
export function truncateForModel(body: string, opts: TruncateForModelOptions): TruncationResult {
  const originalBytes = Buffer.byteLength(body, "utf8");

  // Split the body into lines once; every cap is checked against the
  // line-aware view, so we don't pay for `split("\n")` three times.
  const lines = splitLines(body);
  const perLineOver = lines.some((l) => Buffer.byteLength(l, "utf8") > MODEL_MAX_LINE_CHARS);

  let working = lines;
  let changed = false;

  // Stage 1: per-line cap.
  if (perLineOver) {
    const capped = applyLineCharCap(working, MODEL_MAX_LINE_CHARS);
    working = capped.lines;
    if (capped.changed) changed = true;
  }

  // Stage 2: line-count cap. When strictly over the cap, direction picks
  // which lines to keep over the WHOLE body. When strictly under the cap
  // but with more than two lines, direction previews at the small scale:
  // head drops the body's last line, tail-with-first-line drops the
  // middle, keeping the first and last.
  if (working.length > MODEL_MAX_LINES) {
    const trimmed = applyLineCountCap(working, MODEL_MAX_LINES, opts.direction);
    working = trimmed.lines;
    if (trimmed.changed) changed = true;
  } else if (working.length > 3 && working.length < MODEL_MAX_LINES) {
    if (opts.direction === "head") {
      working = working.slice(0, -1);
      changed = true;
    } else {
      const first = working[0] as string;
      const last = working[working.length - 1] as string;
      working = [first, last];
      changed = true;
    }
  }

  // Re-join with newlines. The trailing-newline convention: if the input
  // body ended in "\n" AND no line was dropped, preserve that so a
  // downstream parser doesn't see a line count that disagrees with
  // `splitLines`'s view of the input. Re-emitting "\n" after dropping a
  // line would inflate `split("\n").length` past the cap — the test for
  // AC4 pins "at most MODEL_MAX_LINES" via the naive split.
  const joined = working.join("\n");
  const rebuilt = !changed && body.endsWith("\n") && working.length > 0 ? `${joined}\n` : joined;

  // Stage 3: byte cap. Runs last, so the byte ceiling is unconditional —
  // nothing is appended after the cut.
  if (Buffer.byteLength(rebuilt, "utf8") > MODEL_MAX_BYTES) {
    const cut = cutToByteCap(rebuilt, MODEL_MAX_BYTES);
    return { content: cut, truncated: true, originalBytes };
  }
  return { content: rebuilt, truncated: changed, originalBytes };
}
