/**
 * Shared ranged file-read core — US-001.
 *
 * A single implementation that backs both `readTool` and (under US-003)
 * `ScratchpadRead`. The `readCeiling` parameter is the tool-layer I/O bound,
 * distinct from `maxFileBytes` which remains the whole-file Edit/Write cap.
 *
 * STUBS ONLY — see test/unit/tools/read-file.test.ts for the contracts.
 *
 * The stub resolves with a placeholder that fails every shape assertion
 * (AC16–AC20) and that the rejection-shape AC (AC21) catches via `try/catch`
 * — the assertion `rejected === true` then fails at its `expect` line. Every
 * test therefore reaches an assertion rather than dying on a thrown error.
 */

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

/**
 * Read a ranged slice of a UTF-8 file.
 *
 * Stub: resolves with `{ content: "__STUB__", bounded: true, totalLines: -1 }`.
 * Implementer supplies the ranged read, the line-count header, the
 * codepoint-safe cut, and the offset/limit validation in the same shape
 * the existing `readTool` inline implementation pinned.
 */
export function readFileSlice(target: string, opts: ReadFileSliceOptions = {}): Promise<ReadFileSliceResult> {
  void target;
  void opts;
  return Promise.resolve({ content: "__STUB__", bounded: true, totalLines: -1 });
}
