import type { NaxConfig } from "../config";
import { getLogger } from "../logger";

export const _setupVerifyDeps = {
  spawn: Bun.spawn.bind(Bun) as typeof Bun.spawn,
};

/**
 * Runs the configured quality.commands.test command to verify the generated
 * .nax config produces a working setup. Returns the process exit code.
 */
export async function runSetupGate(workdir: string, config: NaxConfig): Promise<number> {
  const logger = getLogger();
  const quality = config.quality as { commands?: Record<string, string> } | undefined;
  const testCmd = quality?.commands?.test;

  if (!testCmd) {
    logger.info("setup-verify", "No test command configured — skipping verification gate", {
      storyId: "setup",
    });
    return 0;
  }

  logger.info("setup-verify", "Running verification gate", { storyId: "setup", cmd: testCmd });
  const parts = testCmd.split(" ") as [string, ...string[]];
  const proc = _setupVerifyDeps.spawn(parts, { cwd: workdir });
  return await proc.exited;
}
