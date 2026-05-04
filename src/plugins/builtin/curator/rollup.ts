/**
 * Curator Rollup — Phase 3
 *
 * Append-only rollup writer for cross-run observation aggregation.
 */

import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import type { Observation } from "./types";

/**
 * Append observations to a rollup file (JSONL format).
 *
 * Creates parent directory if needed. Appends one JSON line per observation.
 * Never throws on write errors — logs warning and continues.
 *
 * @param observations - Array of observations to append
 * @param rollupPath - Absolute path to the rollup JSONL file
 */
export async function appendToRollup(observations: Observation[], rollupPath: string): Promise<void> {
  try {
    const dir = path.dirname(rollupPath);
    await mkdir(dir, { recursive: true });

    if (observations.length === 0) {
      const f = Bun.file(rollupPath);
      if (!(await f.exists())) {
        await Bun.write(rollupPath, "");
      }
      return;
    }

    let existing = "";
    const f = Bun.file(rollupPath);
    if (await f.exists()) {
      existing = await f.text();
    }

    const newLines = `${observations.map((o) => JSON.stringify(o)).join("\n")}\n`;
    await Bun.write(rollupPath, existing + newLines);
  } catch {
    // Write errors are logged but never thrown — curator must not affect run exit code
  }
}
