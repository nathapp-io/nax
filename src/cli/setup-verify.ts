import type { NaxConfig } from "../config";
import { getLogger } from "../logger";
import { runQualityCommand } from "../quality/runner";

/**
 * Runs the configured quality.commands.test command to verify the generated
 * .nax config produces a working setup. Returns the process exit code.
 *
 * CLI-1: previously spawned via a bare whitespace split (breaking quoted
 * commands like `bun test "test dir/"`) with no timeout, so a hung test
 * command hung `nax setup` forever. Delegates to runQualityCommand, the
 * shared shell-quoting-safe, timeout-enforced runner every other quality
 * command in nax uses.
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
  const result = await runQualityCommand({
    commandName: "setup-verify",
    command: testCmd,
    workdir,
    storyId: "setup",
  });
  return result.exitCode;
}
