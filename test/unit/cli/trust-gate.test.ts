import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _trustGateCliDeps, runTrustGate } from "@/cli/trust-gate";

describe("runTrustGate", () => {
  let globalDir: string;
  let projectDir: string;
  let originalGlobalDir: string | undefined;
  let originalInteractive: typeof _trustGateCliDeps.isInteractive;
  let originalError: typeof _trustGateCliDeps.error;
  let originalExit: typeof _trustGateCliDeps.exit;
  let errors: string[];
  let exits: number[];

  beforeEach(() => {
    globalDir = realpathSync(makeTempDir("nax-cli-trust-global-"));
    projectDir = realpathSync(makeTempDir("nax-cli-trust-project-"));
    originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
    originalInteractive = _trustGateCliDeps.isInteractive;
    originalError = _trustGateCliDeps.error;
    originalExit = _trustGateCliDeps.exit;
    errors = [];
    exits = [];
    _trustGateCliDeps.isInteractive = () => false;
    _trustGateCliDeps.error = (text) => errors.push(text);
    _trustGateCliDeps.exit = (code): never => {
      exits.push(code);
      throw new Error("exit sentinel");
    };
  });

  afterEach(() => {
    _trustGateCliDeps.isInteractive = originalInteractive;
    _trustGateCliDeps.error = originalError;
    _trustGateCliDeps.exit = originalExit;
    if (originalGlobalDir === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
    else process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
    cleanupTempDir(globalDir);
    cleanupTempDir(projectDir);
  });

  function writeTrustStore(path: string): void {
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(
      join(globalDir, "trust.json"),
      JSON.stringify({ version: 1, folders: [{ path, addedAt: "2026-09-30T00:00:00.000Z", via: "cli" }] }),
    );
  }

  test("US-003 AC1: exits with status 2 for an untrusted noninteractive project", async () => {
    await expect(runTrustGate(projectDir)).rejects.toThrow("exit sentinel");

    expect(exits).toEqual([2]);
  });

  test("US-003 AC2: reports the project root before the trust command hint", async () => {
    await expect(runTrustGate(projectDir)).rejects.toThrow("exit sentinel");

    expect(errors).toEqual([`Project not trusted: ${projectDir}`, `run: nax trust add ${projectDir}`]);
  });

  test("US-003 AC3: exits with status 2 when the trust store cannot be parsed", async () => {
    writeFileSync(join(globalDir, "trust.json"), "{not json");

    await expect(runTrustGate(projectDir)).rejects.toThrow("exit sentinel");

    expect(exits).toEqual([2]);
  });

  test("US-003 AC4: accepts a trusted project when called from a descendant", async () => {
    writeTrustStore(projectDir);
    mkdirSync(join(projectDir, ".nax"), { recursive: true });
    writeFileSync(join(projectDir, ".nax", "config.json"), "{}");
    mkdirSync(join(projectDir, "src"), { recursive: true });

    await expect(runTrustGate(join(projectDir, "src"))).resolves.toBeUndefined();

    expect(exits).toEqual([]);
  });
});
