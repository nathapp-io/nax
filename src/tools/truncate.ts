/**
 * Shared model-facing truncation policy — US-001.
 *
 * The single byte-safe implementation that `after_tool` will apply, replacing
 * the per-tool `truncate(body, ctx.maxBytes)` helpers. Constants, direction
 * lookup, and the core algorithm all live here so a future regression that
 * resuscitates a per-tool slicer sits behind one import rather than 5+.
 *
 * Three independent caps compose as an ORDERED PIPELINE, never as alternatives:
 *   1. Per-line cap: every line longer than MODEL_MAX_LINE_CHARS (UTF-16
 *      code units) is shortened.
 *   2. Line-count cap: if still over MODEL_MAX_LINES lines, direction selects
 *      which lines to keep — over the WHOLE body, not over a byte window of it.
 *   3. Byte cap LAST: if the result still exceeds MODEL_MAX_BYTES, cut on a
 *      codepoint boundary. Running it last is what makes the byte ceiling
 *      unconditional — nothing is appended or prepended after the cut. Under
 *      `tail-with-first-line` the first line is retained INSIDE that budget,
 *      with the trailing slice taken against what remains after the first line
 *      and its newline; if the first line alone does not fit, it is itself cut.
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
 * Shorten a single line so its UTF-16 code-unit length is at most
 * `maxCodeUnits`. Backs up one code unit if the cut would land on a high
 * surrogate (the lead of a surrogate pair), so the result never carries
 * a lone surrogate that would re-encode as U+FFFD in a downstream stage.
 */
function capLine(line: string, maxCodeUnits: number): string {
  if (line.length <= maxCodeUnits) return line;
  let cut = maxCodeUnits;
  // Avoid splitting a surrogate pair: if the last code unit kept is a
  // high surrogate, back up one so the pair stays whole.
  if (cut > 0) {
    const last = line.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  }
  return line.slice(0, cut);
}

/**
 * Apply the per-line cap (stage 1) to every line, preserving the array
 * shape so later stages can count and slice by line.
 */
function applyLineCharCap(lines: string[], maxLineChars: number): { lines: string[]; changed: boolean } {
  let changed = false;
  const out: string[] = [];
  for (const line of lines) {
    if (line.length <= maxLineChars) {
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
 * True when `byte` is a UTF-8 continuation byte (`10xxxxxx`) — meaning the
 * position it sits at is INSIDE a multi-byte codepoint, not at its start.
 */
function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

/**
 * Cut `body` to at most `maxBytes` bytes on a clean codepoint boundary.
 * Nothing is appended after the cut: the byte cap is unconditional.
 *
 * The one codepoint-boundary slicer in the tool layer (its original is
 * `sliceByteBudget` in scratchpad.ts). `readFileSlice` needs the same
 * guarantee for its own I/O bound, so it shares this rather than growing a
 * second copy.
 *
 * The boundary is found STRUCTURALLY, by walking back over continuation bytes,
 * not by measuring the decoded candidate's byte length. Measurement is unsound:
 * a slice that ends mid-codepoint decodes into a U+FFFD, and that replacement
 * costs 3 bytes — exactly what a truncated 4-byte codepoint contributed when
 * three of its four bytes were included. The length check then passes while the
 * output carries a replacement character, which is the outcome the codepoint
 * boundary exists to prevent. Walking back stops where a codepoint starts, so
 * the slice is always whole codepoints and re-encodes to exactly `cut` bytes.
 */
export function cutToByteCap(body: string, maxBytes: number): string {
  const buf = Buffer.from(body, "utf8");
  if (buf.length <= maxBytes) return body;
  let cut = maxBytes;
  while (cut > 0 && isContinuationByte(buf[cut])) cut -= 1;
  return buf.subarray(0, cut).toString("utf8");
}

/**
 * Cut `body` down to its LAST `maxBytes` bytes, on a clean codepoint boundary.
 * The mirror of `cutToByteCap`: that one backs up over the continuation bytes a
 * cut-inside-a-codepoint would end on, this one skips forward over the
 * continuation bytes such a start would begin on. Same structural rule, same
 * reason — measuring the decoded candidate would accept a tail that opens with
 * a U+FFFD whenever the replacement costs no more bytes than the partial
 * codepoint it replaced.
 */
function tailWithinBytes(body: string, maxBytes: number): string {
  const buf = Buffer.from(body, "utf8");
  if (buf.length <= maxBytes) return body;
  let start = buf.length - maxBytes;
  while (start < buf.length && isContinuationByte(buf[start])) start += 1;
  return buf.subarray(start).toString("utf8");
}

/**
 * Cut a `tail-with-first-line` body to `maxBytes`: the body's first line, then
 * its LAST bytes, dropping the middle. The byte stage's half of the same choice
 * the line-count stage makes — a body cut for length should lose its middle,
 * not its end, when the direction says the end is what matters.
 *
 * The first line is retained INSIDE the budget, not on top of it: the trailing
 * slice is measured against what remains once the first line and its newline
 * are paid for. If the first line alone does not fit, it is itself cut. Either
 * way nothing is appended after the cut — the trailing slice is what fills the
 * remaining budget, never an extra.
 */
function cutKeepingFirstLine(body: string, maxBytes: number): string {
  const lineEnd = body.indexOf("\n");
  // No newline: the body is one line, so there is no tail distinct from its head.
  if (lineEnd === -1) return cutToByteCap(body, maxBytes);
  const firstLine = body.slice(0, lineEnd);
  const firstLineBytes = Buffer.byteLength(firstLine, "utf8");
  // Paying for the first line and its newline leaves no room for a tail.
  if (firstLineBytes + 1 >= maxBytes) return cutToByteCap(firstLine, maxBytes);
  const tail = tailWithinBytes(body.slice(lineEnd + 1), maxBytes - firstLineBytes - 1);
  return `${firstLine}\n${tail}`;
}

/**
 * Apply the model-facing truncation policy to a tool result body.
 *
 * Three stages, in order, each independently reachable: per-line cap,
 * line-count cap, byte cap. The pipeline reports `truncated: true` when
 * any stage changed the content. `originalBytes` always reports the
 * input's full UTF-8 byte length, regardless of which stages fired.
 *
 * Direction governs both stages that drop content: the line-count cap keeps
 * the first N lines (`head`) or the first line plus the last N-1 lines
 * (`tail-with-first-line`), and the byte cap keeps the leading bytes or the
 * first line plus the trailing bytes the same way. Within-cap bodies are
 * returned unchanged regardless of direction.
 */
export function truncateForModel(body: string, opts: TruncateForModelOptions): TruncationResult {
  const originalBytes = Buffer.byteLength(body, "utf8");

  // Split the body into lines once; every cap is checked against the
  // line-aware view, so we don't pay for `split("\n")` three times.
  const lines = splitLines(body);
  // Per-line cap is measured in UTF-16 code units — the same metric
  // `String#length` reports — so a 2_000-character line of single-unit
  // codepoints is at the cap, not over it.
  const perLineOver = lines.some((l) => l.length > MODEL_MAX_LINE_CHARS);

  let working = lines;
  let changed = false;

  // Stage 1: per-line cap.
  if (perLineOver) {
    const capped = applyLineCharCap(working, MODEL_MAX_LINE_CHARS);
    working = capped.lines;
    if (capped.changed) changed = true;
  }

  // Stage 2: line-count cap. The cap fires only when the body is strictly
  // over MODEL_MAX_LINES — within-cap bodies must be returned unchanged
  // per AC1, so no preview is allowed at smaller scales.
  if (working.length > MODEL_MAX_LINES) {
    const trimmed = applyLineCountCap(working, MODEL_MAX_LINES, opts.direction);
    working = trimmed.lines;
    if (trimmed.changed) changed = true;
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
  // nothing is appended after the cut. The direction decides which bytes
  // survive the cut, exactly as it decided which lines survived stage 2:
  // `head` keeps the leading bytes, `tail-with-first-line` keeps the first
  // line plus the trailing bytes and drops the middle.
  if (Buffer.byteLength(rebuilt, "utf8") > MODEL_MAX_BYTES) {
    const cut =
      opts.direction === "tail-with-first-line"
        ? cutKeepingFirstLine(rebuilt, MODEL_MAX_BYTES)
        : cutToByteCap(rebuilt, MODEL_MAX_BYTES);
    return { content: cut, truncated: true, originalBytes };
  }
  return { content: rebuilt, truncated: changed, originalBytes };
}
