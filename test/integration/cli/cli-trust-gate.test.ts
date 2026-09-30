import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

let projectDir: string;
let globalDir: string;
let previousGlobalDir: string | undefined;

beforeEach(() => {
  projectDir = realpathSync(makeTempDir("nax-cli-trust-project-"));
  globalDir = realpathSync(makeTempDir("nax-cli-trust-global-"));
  previousGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
  process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
  mkdirSync(join(projectDir, ".nax"), { recursive: true });
  writeFileSync(join(projectDir, ".nax", "config.json"), "{}");
  const featureDir = join(projectDir, ".nax", "features", "demo");
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(
    join(featureDir, "prd.json"),
    JSON.stringify({
      project: "test",
      feature: "demo",
      branchName: "test",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      userStories: [{
        id: "US-001",
        title: "Test",
        description: "Test description",
        acceptanceCriteria: [],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
      }],
    }),
  );
});

afterEach(() => {
  if (previousGlobalDir === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
  else process.env.NAX_GLOBAL_CONFIG_DIR = previousGlobalDir;
  cleanupTempDir(projectDir);
  cleanupTempDir(globalDir);
});

async function runCli(args: string[], cwd = process.cwd()): Promise<CliResult> {
  const entrypoint = join(process.cwd(), "bin", "nax.ts");
  const proc = Bun.spawn(["bun", entrypoint, ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NAX_GLOBAL_CONFIG_DIR: globalDir },
    signal: AbortSignal.timeout(10_000),
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function writeTrustStore(path: string): void {
  writeFileSync(
    join(globalDir, "trust.json"),
    JSON.stringify({ version: 1, folders: [{ path, addedAt: "2026-09-30T00:00:00.000Z", via: "cli" }] }),
  );
}

describe("CLI trust gate entry points", () => {
  test("US-003 AC5: rejects an untrusted run with exit status 2", async () => {
    const { exitCode } = await runCli(["run", "-f", "demo", "-d", projectDir, "--headless"]);

    expect(exitCode).toBe(2);
  }, 60_000);

  test("US-003 AC6: prints the trust-add hint for an untrusted run", async () => {
    const { stderr } = await runCli(["run", "-f", "demo", "-d", projectDir, "--headless"]);

    expect(stderr).toContain(`run: nax trust add ${projectDir}`);
  }, 60_000);

  test("US-003 AC7: refuses an untrusted run before importing project plugins", async () => {
    const pluginsDir = join(projectDir, ".nax", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(join(pluginsDir, "sentinel.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(projectDir, "imported"))}, "imported"); export default {};`);

    const { exitCode } = await runCli(["run", "-f", "demo", "-d", projectDir, "--headless"]);

    expect(exitCode).toBe(2);
    expect(existsSync(join(projectDir, "imported"))).toBe(false);
  }, 60_000);

  test("US-003 AC8: rejects a scheduled untrusted run before waiting", async () => {
    const startedAt = Date.now();
    const { exitCode } = await runCli(["run", "-f", "demo", "-d", projectDir, "--headless", "--schedule", "1h"]);

    expect(exitCode).toBe(2);
    expect(Date.now() - startedAt).toBeLessThan(30_000);
  }, 60_000);

  test("US-003 AC9: rejects an untrusted resume", async () => {
    const { exitCode } = await runCli(["resume", "-f", "demo", "-d", projectDir]);

    expect(exitCode).toBe(2);
  }, 60_000);

  test("US-003 AC10: rejects an untrusted plan with an existing spec", async () => {
    const specPath = join(projectDir, "spec.md");
    writeFileSync(specPath, "# Existing spec\n");

    const { exitCode } = await runCli(["plan", "-f", "demo", "--from", specPath, "-d", projectDir]);

    expect(exitCode).toBe(2);
  }, 60_000);

  test("US-003 AC11: rejects an untrusted plugins list", async () => {
    const { exitCode } = await runCli(["plugins", "list", "-d", projectDir]);

    expect(exitCode).toBe(2);
  }, 60_000);

  test("US-003 AC12: rejects untrusted setup even in dry-run mode", async () => {
    const { exitCode } = await runCli(["setup", "-d", projectDir, "--dry-run"]);

    expect(exitCode).toBe(2);
  }, 60_000);

  test("US-003 AC13: rejects an untrusted precheck", async () => {
    const { exitCode } = await runCli(["precheck", "-f", "demo", "-d", projectDir]);

    expect(exitCode).toBe(2);
  }, 60_000);

  test("US-003 AC14: rejects regular prompts for an untrusted project", async () => {
    const { exitCode } = await runCli(["prompts", "-f", "demo", "-d", projectDir]);

    expect(exitCode).toBe(2);
  }, 60_000);

  test("US-003 AC15: allows prompts export for an untrusted project", async () => {
    const { exitCode } = await runCli(["prompts", "--export", "implementer", "-d", projectDir]);

    expect(exitCode).toBe(0);
  }, 60_000);

  test("US-003 AC16: rejects mcp lock in an untrusted current directory", async () => {
    const { exitCode } = await runCli(["mcp", "lock"], projectDir);

    expect(exitCode).toBe(2);
  }, 60_000);

  test("US-003 AC17: allows plugins list when the project is in the trust store", async () => {
    writeTrustStore(projectDir);

    const { exitCode } = await runCli(["plugins", "list", "-d", projectDir]);

    expect(exitCode).toBe(0);
  }, 60_000);

  test("US-003 AC18: leaves config available in an untrusted current directory", async () => {
    const { exitCode } = await runCli(["config", "--json"], projectDir);

    expect(exitCode).toBe(0);
  }, 60_000);
});
