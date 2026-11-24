/**
 * The job panel's line reader (review-e684 finding 13): a bounded tail of a job log read backward
 * from the end of the file, so a log of tens of megabytes costs a chunk or two instead of a
 * whole-file read. Splitting on the newline BYTE before decoding keeps a multi-byte UTF-8
 * character whole when a chunk boundary falls inside it.
 */
export const LOG_TAIL_CHUNK_BYTES = 64 * 1024;
const NEWLINE_BYTE = 10;
const EMPTY: Uint8Array = new Uint8Array(0);
const decoder = new TextDecoder();

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

async function collectTailLines(path: string, limit: number, nonEmpty: boolean): Promise<string> {
  const size = await _logTailDeps.size(path);
  if (!Number.isFinite(size) || size < 1) return "";
  const kept: string[] = [];
  let carry = EMPTY;
  let atEnd = true;
  let end = size;
  while (end > 0 && kept.length < limit) {
    const start = Math.max(0, end - LOG_TAIL_CHUNK_BYTES);
    const chunk = await _logTailDeps.readRange(path, start, end);
    // One trailing line break ends no line of its own, the same as the whole-file read held.
    const bytes = concatBytes(atEnd && isLineBreak(chunk[chunk.length - 1]) ? chunk.subarray(0, -1) : chunk, carry);
    atEnd = false;
    const pieces = splitAtNewline(bytes);
    // The piece starting at the chunk boundary is the tail of a line whose head is earlier on.
    carry = start === 0 ? EMPTY : (pieces[0] ?? EMPTY);
    collectChunk(start === 0 ? pieces : pieces.slice(1), kept, limit, nonEmpty);
    end = start;
  }
  return kept.reverse().join("\n");
}

/**
 * The last `lines` lines of `path`, or with `nonEmpty` the last `lines` that hold more than
 * whitespace. A trailing `\r` is stripped, nothing else is trimmed, and the lines come back in
 * file order joined with `\n`.
 */
export async function readTailLines(
  path: string,
  lines: number,
  opts: { readonly nonEmpty?: boolean } = {},
): Promise<string> {
  const limit = Math.floor(lines);
  // An unreadable line count is no tail: the same answer the whole-file read gave.
  if (!Number.isFinite(limit) || limit < 1) return "";
  try {
    return await collectTailLines(path, limit, opts.nonEmpty === true);
  } catch (cause) {
    if (isMissingFile(cause)) return "";
    throw cause;
  }
}
