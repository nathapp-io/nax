/**
 * CLI startup wiring for `NAX_FORGE_KIND` (US-001).
 *
 * The entry-point wiring cannot be observed any other way, so these cases spawn
 * `bin/nax.ts` — the documented exception to the rule against spawning a full
 * `nax` process. A refused kind must stop the process *before* any command
 * runs, which is exactly what `--version` cannot mask: a later command would
 * have acted on the wrong forge.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { NAX_VERSION } from "@/version";

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

let projectDir: string;
let globalDir: string;
let previousGlobalDir: string | undefined;

beforeEach(() => {
  projectDir = realpathSync(makeTempDir("nax-cli-forge-kind-"));
  globalDir = realpathSync(makeTempDir("nax-cli-forge-kind-global-"));
  previousGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
  process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
});

afterEach(() => {
  if (previousGlobalDir === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
  else process.env.NAX_GLOBAL_CONFIG_DIR = previousGlobalDir;
  cleanupTempDir(projectDir);
  cleanupTempDir(globalDir);
});

/**
 * The ambient environment minus any forge injection, so a developer's own
 * variables cannot decide the outcome of these cases.
 */
function runEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("NAX_FORGE_")) continue;
    if (value !== undefined) env[key] = value;
  }
  return { ...env, NAX_GLOBAL_CONFIG_DIR: globalDir, ...overrides };
}

async function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  const entrypoint = join(process.cwd(), "bin", "nax.ts");
  const proc = Bun.spawn(["bun", entrypoint, ...args], {
    cwd: projectDir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
    signal: AbortSignal.timeout(30_000),
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("CLI startup forge kind", () => {
  test("AC-20: an unknown NAX_FORGE_KIND refuses to start and names the accepted values", async () => {
    const { exitCode, stderr } = await runCli(["--version"], runEnv({ NAX_FORGE_KIND: "bitbucket" }));

    expect(exitCode).toBe(1);
    expect(stderr).toContain("expected github or gitlab");
  }, 60_000);

  test("AC-21: an accepted NAX_FORGE_KIND starts the CLI", async () => {
    const { exitCode, stdout } = await runCli(["--version"], runEnv({ NAX_FORGE_KIND: "gitlab" }));

    expect(exitCode).toBe(0);
    expect(stdout).toContain(NAX_VERSION);
  }, 60_000);
});
