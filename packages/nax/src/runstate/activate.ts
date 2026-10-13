/** One run-state keeper per run, scoped to the run's feature (#2497). */
import { join } from "node:path";
import { featureDir } from "@/config/paths";
import { registerBeforeAutoCommit } from "../utils/git";
import { repairRunState } from "./repair";
import { classifyRunStatePath, RunStateKeeper, registerKeeper, unregisterKeeper } from "./store";

const SEEDED = ["prd.json", "status.json", "decisions.jsonl"] as const;

export interface RunStateHandle {
  readonly keeper: RunStateKeeper;
  deactivate(): void;
}

async function seed(keeper: RunStateKeeper, root: string): Promise<void> {
  for (const name of SEEDED) {
    const path = join(featureDir(root, keeper.feature), name);
    const classified = classifyRunStatePath(path);
    const file = Bun.file(path);
    if (classified && (await file.exists())) keeper.record(path, classified, await file.text());
  }
}

export async function activateRunState(input: {
  runId: string;
  feature: string;
  root: string;
}): Promise<RunStateHandle> {
  const keeper = new RunStateKeeper(input.runId, input.feature);
  await seed(keeper, input.root);
  registerKeeper(keeper);
  const unhook = registerBeforeAutoCommit(async (c) => {
    await repairRunState({ trigger: "pre-commit", storyId: c.storyId, stage: c.stage, workdir: c.workdir });
  });
  return {
    keeper,
    deactivate: () => {
      unhook();
      unregisterKeeper(keeper);
    },
  };
}
