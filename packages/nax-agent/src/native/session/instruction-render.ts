import type { InstructionSource } from "./repository-instructions.ts";

const BUDGET_NOTICE =
  "Repository instruction budget reached; some sources were omitted. Read applicable instruction files before further changes.";
export const MIN_INSTRUCTION_NOTICE_BYTES = Buffer.byteLength(BUDGET_NOTICE, "utf8") + 32;

/** Keep whole guidance sources: partial instructions could reverse a requirement. */
export function renderRepositoryInstructions(
  sources: readonly (InstructionSource & { readonly text: string })[],
  limited: boolean,
  maxBytes: number,
): string {
  const parts: string[] = [];
  let used = 0;
  let omitted = 0;
  const contentBudget = Math.max(0, maxBytes - MIN_INSTRUCTION_NOTICE_BYTES);
  for (const source of sources) {
    const body = `Repository instructions: ${source.path} (scope: ${source.scope}; sha256: ${source.hash})\nApply these instructions only within their directory scope. On conflicts, instructions from a deeper directory override ancestor instructions.\n${source.text}`;
    const bytes = Buffer.byteLength(body, "utf8") + 2;
    if (used + bytes > contentBudget) {
      omitted++;
      continue;
    }
    parts.push(body);
    used += bytes;
  }
  if (limited || omitted > 0) parts.push(`${BUDGET_NOTICE} (${omitted} loaded sources omitted.)`);
  return parts.join("\n\n");
}
