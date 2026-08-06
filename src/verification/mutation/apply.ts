/**
 * Mutation apply/revert — file-editing helpers.
 *
 * Thin Bun-native helpers that mutate the line referenced by a `Mutant`
 * and restore it. The mutation spot-check pipeline uses these in pairs
 * (apply → regression → revert) so the file system is the source of
 * truth — no in-memory shadowing.
 */

import { NaxError } from "@/errors";
import type { Mutant } from "./types";

async function readLines(file: string): Promise<string[]> {
  const text = await Bun.file(file).text();
  return text.split("\n");
}

async function writeLines(file: string, lines: string[]): Promise<void> {
  await Bun.write(file, `${lines.join("\n")}`);
}

async function replaceLine(file: string, line: number, value: string): Promise<void> {
  const lines = await readLines(file);
  const idx = line - 1;
  if (idx < 0 || idx >= lines.length) {
    throw new NaxError(`[mutation-apply] line ${line} out of range for ${file}`, "MUTATION_LINE_OUT_OF_RANGE", {
      stage: "mutation-apply",
      file,
      line,
    });
  }
  lines[idx] = value;
  await writeLines(file, lines);
}

/**
 * Outcome of a revert attempt.
 *
 * `reverted: false` means the file was left EXACTLY as found — the caller must
 * assume the worktree still holds a mutation (or something else it cannot
 * account for) at that location.
 */
export type RevertResult =
  | { readonly reverted: true }
  | {
      readonly reverted: false;
      readonly reason: "out-of-range" | "content-mismatch";
      /** What the line actually held, or null when the line no longer exists. */
      readonly actual: string | null;
    };

export async function applyMutant(m: Mutant): Promise<void> {
  await replaceLine(m.file, m.line, m.after);
}

/**
 * Restore the line a mutant replaced — but only after confirming the line
 * still holds that exact mutant.
 *
 * The check is the whole point. Reverting positionally (writing `before` back
 * at `line` unconditionally) silently destroys whatever occupies the line if
 * anything shifted the file between apply and revert. Overwriting unknown
 * content is the one outcome nothing downstream can undo, so a mismatch
 * writes nothing at all and reports itself instead.
 */
export async function revertMutant(m: Mutant): Promise<RevertResult> {
  const lines = await readLines(m.file);
  const idx = m.line - 1;
  if (idx < 0 || idx >= lines.length) {
    return { reverted: false, reason: "out-of-range", actual: null };
  }
  const actual = lines[idx] ?? "";
  if (actual !== m.after) {
    return { reverted: false, reason: "content-mismatch", actual };
  }
  lines[idx] = m.before;
  await writeLines(m.file, lines);
  return { reverted: true };
}
