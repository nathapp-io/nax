/**
 * `nax mcp lock --global` — the lock lands in the global config dir, and the
 * project's own `.nax/mcp-lock.json` is left alone.
 *
 * The lock's destination is the whole point of the flag, so the assertions are
 * about which FILE appears (and which does not), not about its contents.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _mcpLockCommandDeps, runMcpLockCommand } from "@/cli/mcp";

const FIXTURE = resolve(import.meta.dir, "../../fixtures/mcp/fake-server.ts");

let projectDir: string;
let globalDir: string;
let claudeDir: string;
let previousGlobalDir: string | undefined;
const originalLockEnv = _mcpLockCommandDeps.env;

function writeProjectConfig(): void {
  mkdirSync(join(projectDir, ".nax"), { recursive: true });
  writeFileSync(
    join(projectDir, ".nax", "config.json"),
    JSON.stringify({
      name: "probe",
      mcp: { servers: { memory: { command: "bun", args: [FIXTURE], stages: ["*"] } } },
    }),
  );
}

beforeEach(() => {
  projectDir = realpathSync(makeTempDir("nax-cli-mcp-lock-project-"));
  globalDir = realpathSync(makeTempDir("nax-cli-mcp-lock-global-"));
  // Isolate Claude Code discovery from the developer's real ~/.claude and ~/.claude.json.
  claudeDir = realpathSync(makeTempDir("nax-cli-mcp-lock-claude-"));
  _mcpLockCommandDeps.env = { CLAUDE_CONFIG_DIR: claudeDir };
  previousGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
  process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
  writeProjectConfig();
});

afterEach(() => {
  _mcpLockCommandDeps.env = originalLockEnv;
  cleanupTempDir(claudeDir);
  if (previousGlobalDir === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
  else process.env.NAX_GLOBAL_CONFIG_DIR = previousGlobalDir;
  cleanupTempDir(projectDir);
  cleanupTempDir(globalDir);
});

const globalLockPath = (): string => join(globalDir, "mcp-lock.json");
const projectLockPath = (): string => join(projectDir, ".nax", "mcp-lock.json");

describe("runMcpLockCommand --global", () => {
  test("AC-11: writes the lock to globalMcpLockPath()", async () => {
    await runMcpLockCommand(projectDir, { global: true });

    expect(existsSync(globalLockPath())).toBe(true);
    expect(Object.keys(JSON.parse(await Bun.file(globalLockPath()).text()).servers.memory)).toEqual(["echo"]);
  }, 30_000);

  test("AC-12: leaves the project lock unwritten", async () => {
    await runMcpLockCommand(projectDir, { global: true });

    expect(existsSync(projectLockPath())).toBe(false);
  }, 30_000);
});

interface CliResult {
  exitCode: number;
  stdout: string;
}

async function runCli(args: string[]): Promise<CliResult> {
  const entrypoint = join(process.cwd(), "bin", "nax.ts");
  const proc = Bun.spawn(["bun", entrypoint, ...args], {
    cwd: projectDir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NAX_GLOBAL_CONFIG_DIR: globalDir, CLAUDE_CONFIG_DIR: claudeDir },
    signal: AbortSignal.timeout(30_000),
  });
  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return { exitCode, stdout };
}

/**
 * Trust lives in the GLOBAL dir, so the temp project is trusted by this entry
 * alone — nothing in the developer's real `~/.nax/trust.json` participates.
 */
function writeTrustStore(): void {
  writeFileSync(
    join(globalDir, "trust.json"),
    JSON.stringify({ version: 1, folders: [{ path: projectDir, addedAt: "2026-09-30T00:00:00.000Z", via: "cli" }] }),
  );
}

describe("nax mcp lock --global", () => {
  test("AC-14: writes <globalDir>/mcp-lock.json in a trusted project", async () => {
    writeTrustStore();

    const { exitCode, stdout } = await runCli(["mcp", "lock", "--global"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain(globalLockPath());
    expect(existsSync(globalLockPath())).toBe(true);
  }, 60_000);

  test("AC-15: leaves <cwd>/.nax/mcp-lock.json unwritten", async () => {
    writeTrustStore();

    await runCli(["mcp", "lock", "--global"]);

    expect(existsSync(projectLockPath())).toBe(false);
  }, 60_000);
});
