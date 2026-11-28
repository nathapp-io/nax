/**
 * The job panel's line reader (review-e684 finding 13, review-0942 finding 12): a bounded tail
 * of a job log read backward from the end of the file, so a log of tens of megabytes costs a
 * chunk or two instead of a whole-file read. Splitting on the newline BYTE before decoding keeps
 * a multi-byte UTF-8 character whole when a chunk boundary falls inside it. A caller that passes
 * `maxBytes` — the panel, which refreshes every two seconds — also bounds the bytes one read may
 * scan, and the line that budget cut into comes back behind `LOG_TAIL_TRUNCATION_MARK`.
 */
export const LOG_TAIL_CHUNK_BYTES = 64 * 1024;
/** What a line the byte budget cut into starts with: the bytes before the fragment were not read. */
export const LOG_TAIL_TRUNCATION_MARK = "…";
const NEWLINE_BYTE = 10;
const EMPTY: Uint8Array = new Uint8Array(0);
/** The decoder's report of a character the read boundary split in two. */
const PARTIAL_CHARACTER = /^\uFFFD+/;
const decoder = new TextDecoder();

/** How one tail read may look at the log: which lines it keeps, and the most bytes it may scan. */
export interface LogTailOptions {
  readonly nonEmpty?: boolean;
  /**
   * The most file bytes one read may scan. Absent reads back until the lines are found, which
   * is what a caller that wants whole long lines asks for; a panel bounds it per refresh.
   */
  readonly maxBytes?: number;
}

export const _logTailDeps = {
  size: async (path: string): Promise<number> => Bun.file(path).size,
  readRange: async (path: string, start: number, end: number): Promise<Uint8Array> =>
    new Uint8Array(await Bun.file(path).slice(start, end).arrayBuffer()),
};

/** A log removed with its process is an empty tail, not a read failure. */
function isMissingFile(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

function isLineBreak(byte: number | undefined): boolean {
  return byte === NEWLINE_BYTE;
}

function concatBytes(chunk: Uint8Array, carry: Uint8Array): Uint8Array {
  if (carry.length === 0) return chunk;
  const bytes = new Uint8Array(chunk.length + carry.length);
  bytes.set(chunk);
  bytes.set(carry, chunk.length);
  return bytes;
}

/** Every piece between two newline bytes; the first and last may be partial lines. */
function splitAtNewline(bytes: Uint8Array): Uint8Array[] {
  const pieces: Uint8Array[] = [];
  let from = 0;
  for (let at = bytes.indexOf(NEWLINE_BYTE); at !== -1; at = bytes.indexOf(NEWLINE_BYTE, from)) {
    pieces.push(bytes.subarray(from, at));
    from = at + 1;
  }
  pieces.push(bytes.subarray(from));
  return pieces;
}

/** A line's own text; only the `\r` a `\r\n` break left behind is removed. */
function decodeLine(bytes: Uint8Array): string {
  const text = decoder.decode(bytes);
  return text.endsWith("\r") ? text.slice(0, -1) : text;
}

/** Keep the qualifying lines of one chunk, newest first, up to `limit` in total. */
function collectChunk(pieces: readonly Uint8Array[], kept: string[], limit: number, nonEmpty: boolean): void {
  for (let index = pieces.length - 1; index >= 0 && kept.length < limit; index--) {
    const line = decodeLine(pieces[index] ?? EMPTY);
    if (!nonEmpty || line.trim() !== "") kept.push(line);
  }
}

/** The bytes one read may spend: a chunk, clamped to what the read budget has left. */
function chunkBudget(spent: number, budget: number): number {
  return Math.min(LOG_TAIL_CHUNK_BYTES, budget - spent);
}

/** The most bytes one read may scan; an absent or unreadable budget is no budget at all. */
function byteBudget(maxBytes: number | undefined): number {
  if (maxBytes === undefined || !Number.isFinite(maxBytes)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor(maxBytes));
}

/** One read's pieces in file order, and the fragment of a line the read's own start cut off. */
function readPieces(
  chunk: Uint8Array,
  carry: Uint8Array,
  at: { readonly atEnd: boolean; readonly start: number },
): { readonly pieces: readonly Uint8Array[]; readonly carry: Uint8Array } {
  // One trailing line break ends no line of its own, the same as the whole-file read held.
  const body = at.atEnd && isLineBreak(chunk[chunk.length - 1]) ? chunk.subarray(0, -1) : chunk;
  const pieces = splitAtNewline(concatBytes(body, carry));
  // The piece starting at the read boundary is the tail of a line whose head is earlier on.
  return { pieces, carry: at.start === 0 ? EMPTY : (pieces[0] ?? EMPTY) };
}

/**
 * The fragment a budget cut off, as the oldest line: a character the cut split is dropped
 * rather than drawn as a replacement glyph, and the mark says the line's head is not shown.
 */
function pushCutLine(kept: string[], carry: Uint8Array, nonEmpty: boolean): void {
  const text = decodeLine(carry).replace(PARTIAL_CHARACTER, "");
  if (nonEmpty && text.trim() === "") return;
  kept.push(`${LOG_TAIL_TRUNCATION_MARK}${text}`);
}

async function collectTailLines(path: string, limit: number, opts: LogTailOptions): Promise<string> {
  const size = await _logTailDeps.size(path);
  if (!Number.isFinite(size) || size < 1) return "";
  const budget = byteBudget(opts.maxBytes);
  const nonEmpty = opts.nonEmpty === true;
  const kept: string[] = [];
  let carry = EMPTY;
  let atEnd = true;
  let spent = 0;
  let end = size;
  let exhausted = false;
  while (end > 0 && kept.length < limit) {
    const wanted = chunkBudget(spent, budget);
    if (wanted <= 0) {
      exhausted = true;
      break;
    }
    const start = Math.max(0, end - wanted);
    const chunk = await _logTailDeps.readRange(path, start, end);
    spent += end - start;
    const read = readPieces(chunk, carry, { atEnd, start });
    atEnd = false;
    carry = read.carry;
    collectChunk(start === 0 ? read.pieces : read.pieces.slice(1), kept, limit, nonEmpty);
    end = start;
  }
  // A line the budget cut into is the one line shown that is not whole: complete lines stay unmarked.
  if (exhausted && carry.length > 0) pushCutLine(kept, carry, nonEmpty);
  return kept.reverse().join("\n");
}

/**
 * The last `lines` lines of `path`, or with `nonEmpty` the last `lines` that hold more than
 * whitespace. A trailing `\r` is stripped, nothing else is trimmed, and the lines come back in
 * file order joined with `\n`. With `maxBytes` the read scans at most that many bytes, and the
 * line it cut into — the oldest one — starts with `LOG_TAIL_TRUNCATION_MARK`.
 */
export async function readTailLines(path: string, lines: number, opts: LogTailOptions = {}): Promise<string> {
  const limit = Math.floor(lines);
  // An unreadable line count is no tail: the same answer the whole-file read gave.
  if (!Number.isFinite(limit) || limit < 1) return "";
  try {
    return await collectTailLines(path, limit, opts);
  } catch (cause) {
    if (isMissingFile(cause)) return "";
    throw cause;
  }
}
