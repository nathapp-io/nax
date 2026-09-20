/**
 * Shared ranged file-read core — US-001.
 *
 * A single implementation that backs both `readTool` and (under US-003)
 * `ScratchpadRead`. The `readCeiling` parameter is the tool-layer I/O bound,
 * distinct from `maxFileBytes` which remains the whole-file Edit/Write cap.
 */

import { open } from "node:fs/promises";
import { cutToByteCap, READ_CEILING } from "./truncate";

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
  // file exceeds the ceiling without reading past it. That stat is also why
  // this reads exactly `ceiling` bytes rather than `readPrefix`'s
  // ceiling-plus-one: the overshoot exists to infer "there was more" from the
  // read itself, and here the stat already answers that — so the extra byte
  // would only carry the read past the bound it is meant to enforce.
  const fileSize = Bun.file(target).size;
  const readBudget = Math.min(ceiling, fileSize);
  const handle = await open(target, "r");
  let body = "";
  try {
    const buffer = Buffer.alloc(readBudget);
    const { bytesRead } = await handle.read(buffer, 0, readBudget, 0);
    // The bound can land inside a codepoint, and a partial tail decodes to
    // U+FFFD (3 bytes) — which would put the returned body back over the
    // ceiling it was just capped at. Trim to a clean boundary so the byte
    // budget holds for the caller.
    body = cutToByteCap(buffer.subarray(0, bytesRead).toString("utf8"), ceiling);
  } finally {
    await handle.close();
  }

  const bounded = fileSize > ceiling;

  // Trailing-newline convention: strip the trailing "\n" before splitting,
  // so "a\nb\n" yields two lines, not three.
  const trailingNewline = body.endsWith("\n");
  const lines = trailingNewline ? body.slice(0, -1).split("\n") : body === "" ? [] : body.split("\n");
  // When bounded, we read exactly `ceiling` bytes — there are more lines past
  // what we observed. The "lines.length + 1" floor captures that: a bounded
  // file's last visible line either is truncated (a partial line continuing
  // past the ceiling) or ended with the trailing "\n" we already stripped, so
  // at least one more line lives beyond what we read.
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
  // Joined with no synthesised terminator, mirroring `readTool`'s offset/limit
  // path (src/tools/read.ts): a caller asking for lines 3-4 gets lines 3 and 4,
  // not a newline it did not ask for. The whole-file path above stays verbatim,
  // trailing newline included, because there the caller asked for the file.
  const content = lines.slice(startIndex, endLine).join("\n");
  return { content, bounded, totalLines };
}
