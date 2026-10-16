import type { IAgentManager, LoggerLike } from "../agents/manager-types";

/** Repeat still-relevant hints after finish has had its last chance to dispatch. */
export function reportAuthRelogins(
  agentManager: IAgentManager | undefined,
  logger: LoggerLike | null | undefined,
): readonly string[] {
  const notices = agentManager?.authRelogins() ?? [];
  for (const { providerId, message } of notices) {
    logger?.warn("execution", message, { storyId: "_run", providerId });
  }
  return notices.map(({ message }) => message);
}
