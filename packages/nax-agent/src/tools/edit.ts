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
import { composeEditRegion, replaceUniqueLiteral } from "./edit-region";
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";

/** The file I/O `editTool` performs, behind one seam so a test can make a read or a write fail. */
export interface EditDeps {
  stat(path: string): Promise<{ readonly size: number }>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
}

/**
 * Injectable fs seam, mirroring `_grepDeps` / `_promptLoaderDeps`: the
 * read/write error arms of `Edit` must be reachable deterministically —
 * permission bits cannot deny a write to root, and never to a Windows ACL.
 */
export const _editDeps: EditDeps = {
  stat: (path) => stat(path),
  readFile: (path, encoding) => readFile(path, encoding),
  writeFile: (path, data, encoding) => writeFile(path, data, encoding),
};

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
    "Replace one exact occurrence of old_string with new_string in a repository file. Fails if the match is absent or ambiguous. On success the result shows the edited lines with up to 3 lines of context and their line range, so you do not need to Read the file again to check the edit.",
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
      const { size } = await _editDeps.stat(target);
      if (size > ctx.maxFileBytes) {
        return {
          // The reason leads and the path trails, matching Write's and
          // ScratchpadWrite's refusal shape. A tool result is capped before the
          // model reads it, and a head cut keeps the leading bytes: a message
          // that opens with a long path has its diagnosis cut away first, which
          // is the one sentence the model needs (src/tools/grep.ts states the
          // same rule for its literal-search caveat).
          content: `the file is ${size} bytes, which exceeds the ${ctx.maxFileBytes}-byte file ceiling -- refusing to edit ${target}`,
          isError: true,
        };
      }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }

    let source: string;
    try {
      source = await _editDeps.readFile(target, "utf8");
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
      // Literal composition, NOT `source.replace(oldString, newString)`: a
      // string replacement is read as a template, so the dollar-substitution
      // patterns it recognises (a dollar sign followed by a dollar sign, an
      // ampersand, a backtick, or an apostrophe) inside new_string would be
      // expanded instead of written -- see src/tools/edit-region.ts. The
      // uniqueness checks above proved there is exactly one match, so
      // `indexOf` is that match.
      const matchIndex = source.indexOf(oldString);
      const updated = replaceUniqueLiteral(source, oldString, newString, matchIndex);
      await _editDeps.writeFile(target, updated, "utf8");
      // The view is composed only after the write resolves: a write error
      // returns the error, never a view. It is a bounded Read-compatible
      // slice of the region that changed, so the model does not have to
      // Read the file back to see where its edit landed.
      const region = composeEditRegion({ updated, matchIndex, newStringLength: newString.length });
      return { content: `edited ${target}\n${region}` };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
