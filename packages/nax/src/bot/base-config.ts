import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitSpawnEnv } from "@nathapp/nax-agent/internal";
import { loadConfig, type NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import { gitWithTimeout } from "@/utils/git";

async function runCommand(argv: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, { cwd, env: gitSpawnEnv(), stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

export const _baseConfigDeps = {
  // Route git through the shared timeout so a wedged archive cannot stall the bot run.
  runGit: gitWithTimeout,
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
      await Bun.file(tar).delete();
    }
  },
  // Keep discovery away from the checkout and the home-scoped global .nax tree.
  mkdtemp: (): Promise<string> => mkdtemp(join(tmpdir(), "nax-bot-base-")),
  loadConfig,
};

/** Snapshot the base commit's .nax tree without ever decoding archive bytes as text. */
export async function snapshotBaseNax(repoRoot: string, baseSha: string, dest: string): Promise<boolean> {
  try {
    const result = await _baseConfigDeps.runGit(
      ["archive", "--format=tar", "--output", join(dest, "base.tar"), baseSha, ".nax"],
      repoRoot,
    );
    if (result.exitCode !== 0) {
      if (result.stderr.includes("did not match any files")) return false;
      throw new NaxError(`[bot] Failed to archive base config: ${result.stderr}`, "BOT_BASE_CONFIG_READ_FAILED", {
        stage: "bot",
        repoRoot,
        baseSha,
      });
    }
    await _baseConfigDeps.extractTar(join(dest, "base.tar"), dest);
    return true;
  } catch (cause) {
    throw new NaxError(`[bot] Could not snapshot base config at ${baseSha}`, "BOT_BASE_CONFIG_READ_FAILED", {
      stage: "bot",
      repoRoot,
      baseSha,
      dest,
      cause,
    });
  }
}

export async function loadBotConfig(input: { snapshotDir: string; profiles: readonly string[] }): Promise<NaxConfig> {
  const { snapshotDir, profiles } = input;
  return _baseConfigDeps.loadConfig(snapshotDir, profiles.length > 0 ? { profile: [...profiles] } : undefined);
}
