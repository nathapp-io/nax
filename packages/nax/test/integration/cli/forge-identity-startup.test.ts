/**
 * CLI startup wiring for the injected forge identity (US-002).
 *
 * The entry-point wiring cannot be observed any other way, so these two cases
 * spawn `bin/nax.ts` — the documented exception to the rule against spawning a
 * full `nax` process. They are the only spawn cases in the forge-identity
 * feature; every validation rule is covered by the unit tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { NAX_VERSION } from "@/version";

const TOKEN = "tok-7f3a9c";
const LOGIN = "acme-bot[bot]";
const INVALID_PREFIX = "[forge] Invalid injected forge identity:";

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

let projectDir: string;
let globalDir: string;
let previousGlobalDir: string | undefined;

beforeEach(() => {
  projectDir = realpathSync(makeTempDir("nax-cli-forge-identity-"));
  globalDir = realpathSync(makeTempDir("nax-cli-forge-global-"));
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
 * The ambient environment minus any forge identity, so a developer's own
 * injection cannot decide the outcome of these cases.
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

function writeTokenFile(contents: string): string {
  const path = join(projectDir, "forge-token");
  writeFileSync(path, contents);
  return path;
}

describe("CLI startup forge identity", () => {
  test("AC-21: a login without a token file refuses to start and names the reason", async () => {
    const { exitCode, stderr } = await runCli(["--version"], runEnv({ NAX_FORGE_LOGIN: LOGIN }));

    expect(exitCode).toBe(1);
    expect(stderr.split("\n").some((line) => line.startsWith(INVALID_PREFIX))).toBe(true);
    expect(stderr).toContain("NAX_FORGE_LOGIN requires NAX_FORGE_TOKEN_FILE");
  }, 60_000);

  test("AC-22: a valid token file starts the CLI and is deleted before the command runs", async () => {
    const tokenPath = writeTokenFile(`${TOKEN}\n`);

    const { exitCode, stdout } = await runCli(
      ["--version"],
      runEnv({ NAX_FORGE_TOKEN_FILE: tokenPath, NAX_FORGE_LOGIN: LOGIN }),
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain(NAX_VERSION);
    expect(existsSync(tokenPath)).toBe(false);
  }, 60_000);
});
