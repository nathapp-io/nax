import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FinishResult } from "../types";

export function resultPath(repoRoot: string): string {
  return `${repoRoot}/.nax/nax-finish-result.json`;
}

export const _resultDeps: { writeText: (p: string, s: string) => Promise<void> } = {
  // node:fs, not Bun.write — this module runs inside acpx's Node process, where
  // the `Bun` global does not exist (see the header of `../exec.ts`). The mkdir
  // is not redundant: Bun.write creates missing parent directories implicitly,
  // writeFile does not, and this is the one artifact the plugin needs on disk to
  // report an outcome at all.
  writeText: async (p, s) => {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, s, "utf8");
  },
};

export async function writeResult(repoRoot: string, result: FinishResult): Promise<void> {
  await _resultDeps.writeText(resultPath(repoRoot), `${JSON.stringify(result, null, 2)}\n`);
}
