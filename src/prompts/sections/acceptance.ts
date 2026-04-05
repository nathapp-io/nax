/**
 * Acceptance Section
 *
 * Builds the acceptance test context section for the implementer prompt.
 * Shows generated test file content so the implementer can match API surface.
 */

export interface AcceptanceEntry {
  testPath: string;
  content: string;
}

/** Maximum total test content in bytes before truncation kicks in (50 KB) */
export const ACCEPTANCE_SECTION_MAX_BYTES = 50 * 1024;

/**
 * Build a markdown section containing acceptance test file content.
 *
 * - Each entry renders as a `## <testPath>` heading followed by a fenced
 *   TypeScript code block containing the file content.
 * - When total content across all entries exceeds 50 KB, the longest entry
 *   is truncated first and `[truncated — full file at <path>]` is appended.
 * - Returns an empty string when `entries` is empty.
 *
 * @param entries - Array of { testPath, content } pairs
 * @returns Markdown string or empty string
 */
export function buildAcceptanceSection(_entries: AcceptanceEntry[]): string {
  return "";
}
