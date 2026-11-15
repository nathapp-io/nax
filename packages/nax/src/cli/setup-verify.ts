import type { NaxConfig } from "../config";
import { getLogger } from "../logger";
import { runQualityCommand } from "../quality/runner";
import { type GateStallPolicy, resolveStallDetection } from "../utils/gate-stall";

/** The verification command's shape: `quality.commands.test`, plus the run's policy. */
type SetupQuality = {
  readonly commands?: Record<string, string>;
  readonly stallDetection?: Partial<GateStallPolicy>;
};

/**
 * Runs the configured quality.commands.test command to verify the generated
 * .nax config produces a working setup. Returns the process exit code.
 *
 * CLI-1: previously spawned via a bare whitespace split (breaking quoted
 * commands like `bun test "test dir/"`) with no timeout, so a hung test
 * command hung `nax setup` forever. Delegates to runQualityCommand, the
 * shared shell-quoting-safe, timeout-enforced runner every other quality
 * command in nax uses.
 *
 * US-008: the run's resolved stall policy goes with the command, so a
 * verification step that endlessly repeats one line stops on the detector
 * instead of waiting out its wall-clock limit. The policy is completed here
 * rather than passed sparse, so the same default the schema resolves applies
 * to a config that predates the field.
 */
export async function runSetupGate(workdir: string, config: NaxConfig): Promise<number> {
  const logger = getLogger();
  const quality = config.quality as SetupQuality | undefined;
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
    stallDetection: resolveStallDetection(quality?.stallDetection),
  });
  return result.exitCode;
}
