import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorMessage, gitSpawnEnv } from "@nathapp/nax-agent/internal";
import { loadConfig, type NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";
import { botGit } from "./git";

async function runCommand(argv: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, { cwd, env: gitSpawnEnv(), stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function removeTar(tar: string): Promise<void> {
  try {
    await rm(tar, { force: true });
  } catch (cause) {
    getSafeLogger()?.warn("bot", "Could not remove base archive", { tar, error: errorMessage(cause) });
  }
}

export const _baseConfigDeps = {
  // Route git through the shared timeout so a wedged archive cannot stall the bot run.
  runGit: botGit,
  async extractTar(tar: string, dest: string): Promise<void> {
    try {
      const result = await runCommand(["tar", "-xf", tar, "-C", dest], dest);
      if (result.exitCode !== 0) {
        throw new NaxError(`[bot] Failed to extract base config: ${result.stderr}`, "BOT_BASE_CONFIG_READ_FAILED", {
          stage: "bot",
          dest,
        });
      }
    } finally {
      await removeTar(tar);
    }
  },
  // Keep discovery away from the checkout and the home-scoped global .nax tree.
  mkdtemp: (): Promise<string> => mkdtemp(join(tmpdir(), "nax-bot-base-")),
  loadConfig,
};

/** Snapshot the base commit's .nax tree without ever decoding archive bytes as text. */
export async function snapshotBaseNax(repoRoot: string, baseSha: string, dest: string): Promise<boolean> {
  const tar = join(dest, "base.tar");
  try {
    // ls-tree distinguishes a missing path from an invalid commit without localized stderr matching.
    const tree = await _baseConfigDeps.runGit(["ls-tree", "--name-only", "-z", baseSha, "--", ".nax"], repoRoot);
    if (tree.exitCode !== 0)
      throw new NaxError(
        `[bot] Failed to inspect base config: ${tree.timedOut ? "git timed out" : tree.stderr}`,
        "BOT_BASE_CONFIG_READ_FAILED",
        { stage: "bot", baseSha, timedOut: tree.timedOut },
      );
    if (!tree.stdout.split("\0").includes(".nax")) return false;
    const result = await _baseConfigDeps.runGit(
      ["archive", "--format=tar", "--output", join(dest, "base.tar"), baseSha, ".nax"],
      repoRoot,
    );
    if (result.exitCode !== 0) {
      throw new NaxError(
        `[bot] Failed to archive base config: ${result.timedOut ? "git timed out" : result.stderr}`,
        "BOT_BASE_CONFIG_READ_FAILED",
        {
          stage: "bot",
          repoRoot,
          baseSha,
          timedOut: result.timedOut,
        },
      );
    }
    await _baseConfigDeps.extractTar(join(dest, "base.tar"), dest);
    return true;
  } catch (cause) {
    if (cause instanceof NaxError) throw cause;
    throw new NaxError(
      `[bot] Could not snapshot base config at ${baseSha}: ${errorMessage(cause)}`,
      "BOT_BASE_CONFIG_READ_FAILED",
      {
        stage: "bot",
        repoRoot,
        baseSha,
        dest,
        cause,
      },
    );
  } finally {
    await removeTar(tar);
  }
}

export async function loadBotConfig(input: { snapshotDir: string; profiles: readonly string[] }): Promise<NaxConfig> {
  const { snapshotDir, profiles } = input;
  return _baseConfigDeps.loadConfig(snapshotDir, profiles.length > 0 ? { profile: [...profiles] } : undefined);
}
