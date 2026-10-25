import { homedir } from "node:os";
import { join } from "node:path";

export const _claudePathsDeps = { homedir };

/** Claude Code's user-scoped config root, independent of nax's config root. */
export function claudeConfigDir(env: Readonly<Record<string, string | undefined>>): string {
  return env.CLAUDE_CONFIG_DIR ?? join(_claudePathsDeps.homedir(), ".claude");
}
