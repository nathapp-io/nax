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
export function buildAcceptanceSection(entries: AcceptanceEntry[]): string {
  if (entries.length === 0) return "";

  const encoder = new TextEncoder();

  const totalBytes = entries.reduce((sum, e) => sum + encoder.encode(e.content).length, 0);

  let working: AcceptanceEntry[];

  if (totalBytes > ACCEPTANCE_SECTION_MAX_BYTES) {
    // Find the longest entry index
    let longestIdx = 0;
    let longestBytes = 0;
    for (let i = 0; i < entries.length; i++) {
      const bytes = encoder.encode(entries[i].content).length;
      if (bytes > longestBytes) {
        longestBytes = bytes;
        longestIdx = i;
      }
    }
    const entry = entries[longestIdx];
    const suffix = `\n[truncated — full file at ${entry.testPath}]`;
    const otherBytes = totalBytes - longestBytes;
    const allowedBytes = Math.max(0, ACCEPTANCE_SECTION_MAX_BYTES - otherBytes - encoder.encode(suffix).length);
    const truncated = entry.content.slice(0, allowedBytes);
    working = entries.map((e, i) =>
      i === longestIdx ? { testPath: e.testPath, content: truncated + suffix } : { ...e },
    );
  } else {
    working = entries.map((e) => ({ ...e }));
  }

  const parts = working.map((e) => `## ${e.testPath}\n\n\`\`\`typescript\n${e.content}\n\`\`\``);
  return parts.join("\n\n");
}
