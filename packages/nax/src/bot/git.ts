import { gitWithTimeout } from "@/utils/git";

/** Bot git never runs hooks: a PR head can supply them through a relative core.hooksPath. */
export const BOT_GIT_HOOKS_OFF = ["-c", "core.hooksPath=/dev/null"] as const;

export function botGit(
  args: string[],
  workdir: string,
  timeoutMs?: number,
  maxBytes?: number,
): ReturnType<typeof gitWithTimeout> {
  // nax-git-env-allow: handed to gitWithTimeout, which hardens it
  return gitWithTimeout(args, workdir, timeoutMs, maxBytes, ["git", ...BOT_GIT_HOOKS_OFF, ...args]);
}
