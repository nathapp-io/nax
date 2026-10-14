/**
 * nax#2500 R9: a reviewer-shaped declaration (command tools, no file-write
 * tools) keeps its command tools only when the dispatch sandbox is usable.
 * Otherwise nax withholds them so the reviewer runs read-only.
 */

import type { CodingToolName, CommandLauncher } from "@nathapp/nax-agent";
import { getSafeLogger } from "@/logger";
import { ACP_COMMAND_TOOLS, isReviewerShaped } from "./acp/profile-map";
import type { AgentRunOptions } from "./types";

/**
 * Returns `declared` unchanged unless it is reviewer-shaped and the launcher
 * is not `available`; then returns it without the command tools (one warn).
 */
export function withheldReviewerCommands(
  declared: readonly CodingToolName[],
  launcher: CommandLauncher | undefined,
  options: Pick<AgentRunOptions, "storyId" | "sessionRole">,
): readonly CodingToolName[] {
  if (!isReviewerShaped(declared)) return declared;
  const state = launcher?.state;
  if (state?.kind === "available") return declared;
  getSafeLogger()?.warn("tools", "Reviewer commands withheld: no usable sandbox", {
    storyId: options.storyId ?? "_dispatch",
    sessionRole: options.sessionRole,
    sandbox: state?.kind ?? "none",
    ...(state?.kind === "unavailable" ? { reason: state.reason } : {}),
  });
  return declared.filter((tool) => !ACP_COMMAND_TOOLS.has(tool));
}
