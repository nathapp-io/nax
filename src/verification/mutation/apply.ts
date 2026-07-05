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

export async function applyMutant(m: Mutant): Promise<void> {
  await replaceLine(m.file, m.line, m.after);
}

export async function revertMutant(m: Mutant): Promise<void> {
  await replaceLine(m.file, m.line, m.before);
}
