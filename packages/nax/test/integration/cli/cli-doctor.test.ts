import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
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
  projectDir = realpathSync(makeTempDir("nax-doctor-project-"));
  globalDir = realpathSync(makeTempDir("nax-doctor-global-"));
  previousGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
  process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
  mkdirSync(join(projectDir, ".nax"), { recursive: true });
  writeFileSync(
    join(projectDir, ".nax", "config.json"),
    JSON.stringify({ reporters: { webhook: { headers: { Authorization: "Bearer abc12345xyz" } } } }),
  );
  writeFileSync(
    join(globalDir, "trust.json"),
    JSON.stringify({
      version: 1,
      folders: [{ path: projectDir, addedAt: "2026-09-30T00:00:00.000Z", via: "cli" }],
    }),
  );
});

afterEach(() => {
  if (previousGlobalDir === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
  else process.env.NAX_GLOBAL_CONFIG_DIR = previousGlobalDir;
  cleanupTempDir(projectDir);
  cleanupTempDir(globalDir);
});

async function runCli(args: string[]): Promise<CliResult> {
  const entrypoint = join(process.cwd(), "bin", "nax.ts");
  const proc = Bun.spawn(["bun", entrypoint, ...args], {
    cwd: projectDir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NAX_GLOBAL_CONFIG_DIR: globalDir },
    signal: AbortSignal.timeout(30_000),
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function parsePayload(result: CliResult): Record<string, unknown> {
  expect(result.exitCode).not.toBe(2);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim()).not.toBe("");
  const payload: unknown = JSON.parse(result.stdout);
  if (!isRecord(payload)) throw new Error("Expected JSON object payload");
  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function warningNames(payload: Record<string, unknown>): string[] {
  const warnings = payload.warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || !("name" in entry)) return [];
    return [String(entry.name)];
  });
}

describe("doctor CLI", () => {
  test("--json reports config-secrets and matches light precheck", async () => {
    const doctor = await runCli(["doctor", "--json", "-d", projectDir]);
    const precheck = await runCli(["precheck", "--light", "--json", "-d", projectDir]);
    const doctorPayload = parsePayload(doctor);
    const precheckPayload = parsePayload(precheck);

    expect(warningNames(doctorPayload)).toContain("config-secrets");
    expect(doctorPayload).toEqual(precheckPayload);
    expect(doctor.exitCode).toBe(precheck.exitCode);
  }, 60_000);
});
