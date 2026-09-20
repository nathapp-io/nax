/**
 * Shared ranged file-read core — US-001.
 *
 * A single implementation that backs both `readTool` and (under US-003)
 * `ScratchpadRead`. The `readCeiling` parameter is the tool-layer I/O bound,
 * distinct from `maxFileBytes` which remains the whole-file Edit/Write cap.
 */

import { open } from "node:fs/promises";
import { READ_CEILING } from "./truncate";

export interface ReadFileSliceOptions {
  /** Tool-layer I/O bound. Omit to default to `READ_CEILING`. */
  readonly readCeiling?: number;
  /** 1-based line number to start reading from. Omit to start at the first line. */
  readonly offset?: number;
  /** Maximum number of lines to return. Omit to read until the end of the file. */
  readonly limit?: number;
}

export interface ReadFileSliceResult {
  /** The slice body (empty string when the offset is past the end). */
  readonly content: string;
  /** True when the file is larger than the supplied `readCeiling`. */
  readonly bounded: boolean;
  /** Total number of lines the file holds (a floor when `bounded` is true). */
  readonly totalLines: number;
}

/** Reject offset/limit values that would silently drift to the file's last line. */
function validateRange(opts: ReadFileSliceOptions): void {
  if (opts.offset !== undefined && (!Number.isInteger(opts.offset) || opts.offset <= 0)) {
    throw new RangeError(`offset must be a positive integer (1-based); got ${JSON.stringify(opts.offset)}`);
  }
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit <= 0)) {
    throw new RangeError(`limit must be a positive integer; got ${JSON.stringify(opts.limit)}`);
  }
}

/**
 * Read a ranged slice of a UTF-8 file.
 *
 * Honours the trailing-newline convention: a body ending in "\n" has that
 * newline TERMINATE the last line rather than open an empty one, so the
 * returned `totalLines` agrees with `readTool`'s `[N lines]` header and the
 * model's mental model of a file. An empty body has zero lines.
 */
export async function readFileSlice(target: string, opts: ReadFileSliceOptions = {}): Promise<ReadFileSliceResult> {
  validateRange(opts);

  const ceiling = opts.readCeiling ?? READ_CEILING;

  // Probe the file size with `Bun.file(target).size` so we know whether the
  // file exceeds the ceiling without a second read. Reading more than the
  // ceiling is a deliberate over-fetch (one extra byte), and that byte is
  // what lets us tell "this is the whole thing" from "there was more"
  // without a stat.
  const fileSize = Bun.file(target).size;
  const readBudget = Math.min(ceiling, fileSize);
  const handle = await open(target, "r");
  let body = "";
  try {
    const buffer = Buffer.alloc(readBudget + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    body = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }

  const bounded = fileSize > ceiling;

  // Trailing-newline convention: strip the trailing "\n" before splitting,
  // so "a\nb\n" yields two lines, not three.
  const trailingNewline = body.endsWith("\n");
  const lines = trailingNewline ? body.slice(0, -1).split("\n") : body === "" ? [] : body.split("\n");
  // When bounded, we read at most `ceiling + 1` bytes — there are more
  // lines past what we observed. The "lines.length + 1" floor captures
  // that: a bounded file's last visible line either is truncated (a
  // partial line that continues past the ceiling) or ends with the
  // trailing "\n" we already stripped, so there is at least one more
  // line living beyond what we read.
  const totalLines = bounded ? lines.length + 1 : lines.length;

  // Offset/limit slicing.
  if (opts.offset !== undefined && opts.offset > totalLines) {
    return { content: "", bounded, totalLines };
  }

  if (opts.offset === undefined && opts.limit === undefined) {
    // Whole-file path: return the read body verbatim so callers see the
    // same trailing newline the file holds.
    return { content: body, bounded, totalLines };
  }

  const startIndex = (opts.offset ?? 1) - 1;
  const endLine = opts.limit === undefined ? lines.length : Math.min(startIndex + opts.limit, lines.length);
  const selected = lines.slice(startIndex, endLine);
  const joined = selected.join("\n");
  // Preserve a trailing newline when the source body ended with one: the
  // slice should read as "lines 3 and 4, just like the source", not as
  // "lines 3 and 4 with the file terminator stripped off".
  const content = trailingNewline && selected.length > 0 ? `${joined}\n` : joined;
  return { content, bounded, totalLines };
}
