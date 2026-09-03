/**
 * Replace one exact occurrence in a file.
 *
 * old_string/new_string rather than a line range (design section 10, question
 * 3): the contract verifies itself. A stale match fails loudly, where a line
 * range would silently overwrite whatever had moved into those lines.
 *
 * Like Write, this has no production consumer in C1.
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export const editTool: CodingTool = {
  name: "Edit",
  description:
    "Replace one exact occurrence of old_string with new_string in a repository file. Fails if the match is absent or ambiguous.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the repository root" },
      old_string: { type: "string", description: "Exact text to replace; must occur exactly once" },
      new_string: { type: "string", description: "Replacement text" },
    },
    required: ["path", "old_string", "new_string"],
  },
  scope: { pathFields: ["path"] },

  async run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
    const [target] = ctx.resolvedPaths;
    if (target === undefined) return { content: "no path supplied", isError: true };
    const oldString = input.old_string;
    const newString = input.new_string;
    if (typeof oldString !== "string" || typeof newString !== "string") {
      return { content: "old_string and new_string must be strings", isError: true };
    }

    // Checked before reading, not after: Edit must hold the whole file to
    // replace within it, so the only way to bound the memory is to refuse.
    try {
      const { size } = await stat(target);
      if (size > ctx.maxFileBytes) {
        return {
          content: `${target} is ${size} bytes, which exceeds the ${ctx.maxFileBytes}-byte file ceiling`,
          isError: true,
        };
      }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }

    let source: string;
    try {
      source = await readFile(target, "utf8");
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }

    const occurrences = countOccurrences(source, oldString);
    if (occurrences === 0) {
      return { content: `old_string not found in ${target}; the file may have changed`, isError: true };
    }
    if (occurrences > 1) {
      return {
        content: `old_string is ambiguous: found ${occurrences} times. Include more surrounding context.`,
        isError: true,
      };
    }

    try {
      await writeFile(target, source.replace(oldString, newString), "utf8");
      return { content: `edited ${target}` };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
