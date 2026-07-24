import type { FinishResult } from "../types";

export function resultPath(repoRoot: string): string {
  return `${repoRoot}/.nax/nax-finish-result.json`;
}

export const _resultDeps: { writeText: (p: string, s: string) => Promise<void> } = {
  writeText: async (p, s) => {
    await Bun.write(p, s);
  },
};

export async function writeResult(repoRoot: string, result: FinishResult): Promise<void> {
  await _resultDeps.writeText(resultPath(repoRoot), `${JSON.stringify(result, null, 2)}\n`);
}
