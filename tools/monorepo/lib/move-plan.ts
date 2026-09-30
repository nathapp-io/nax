// tools/monorepo/lib/move-plan.ts
import { KEEP_AT_ROOT } from "./constants";

export function planMoves(trackedTopLevel: readonly string[]): { move: string[]; keep: string[] } {
  if (trackedTopLevel.includes("packages")) throw new Error("planMoves: repo already has a packages/ entry");
  const sorted = [...trackedTopLevel].sort();
  return {
    move: sorted.filter((e) => !KEEP_AT_ROOT.has(e)),
    keep: sorted.filter((e) => KEEP_AT_ROOT.has(e)),
  };
}
