/** The feature workflow's I/O seam (forge, repo gates, push, PR, CI). Tests replace fields; production uses these. */
import { commitAndPush, openDraftFinishPr, openOrPromotePr, resolveGateCommands, runQualityGates } from "@/finish";
import { defaultForgeDeps, detectForge, type ForgeDeps, type ForgeKind } from "@/forge";
import { waitForChecks } from "./ci-wait";

export const _featureDeps = {
  forge: defaultForgeDeps as ForgeDeps,
  detectForge: (projectDir: string): Promise<ForgeKind | null> => detectForge(defaultForgeDeps, projectDir),
  resolveGateCommands,
  runQualityGates,
  commitAndPush,
  openDraftFinishPr,
  openOrPromotePr,
  waitForChecks,
};
