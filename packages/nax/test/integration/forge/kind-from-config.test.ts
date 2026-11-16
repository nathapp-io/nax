/**
 * `forge.kind` from a project's `.nax/config.json` reaches `detectForge` (US-001).
 *
 * This is the integration case: nothing is stubbed but the subprocess runner and
 * the global config dir, so the real `loadConfig` path — global layer, project
 * layer, schema validation — is what answers. `_forgeKindDeps` is left alone,
 * which is the point: `defaultForgeDeps.explicitKind` has to find the config by
 * itself.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _forgeKind, defaultForgeDeps, detectForge, type ForgeDeps } from "@/forge";

/** A host that names neither forge, so only the declared kind can answer. */
const NEUTRAL_REMOTE = "https://git.corp.example/group/app.git";

let repoRoot: string;
let globalDir: string;
let previousGlobalDir: string | undefined;

beforeEach(() => {
  repoRoot = makeTempDir("nax-forge-kind-repo-");
  globalDir = makeTempDir("nax-forge-kind-global-");
  previousGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
  process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
  _forgeKind.current = undefined;
});

afterEach(() => {
  if (previousGlobalDir === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
  else process.env.NAX_GLOBAL_CONFIG_DIR = previousGlobalDir;
  _forgeKind.current = undefined;
  cleanupTempDir(repoRoot);
  cleanupTempDir(globalDir);
});

/** Write the repo's own `.nax/config.json`. */
function writeProjectConfig(config: unknown): void {
  const naxDir = join(repoRoot, ".nax");
  mkdirSync(naxDir, { recursive: true });
  writeFileSync(join(naxDir, "config.json"), JSON.stringify(config));
}

/** Both forge CLIs installed and an unresolvable host — today's null. */
function fakeRun(cmd: string[]): { exitCode: number; stdout: string; stderr: string } {
  if (cmd[0] === "git") return { exitCode: 0, stdout: `${NEUTRAL_REMOTE}\n`, stderr: "" };
  return { exitCode: 0, stdout: "", stderr: "" };
}

describe("detectForge — forge.kind from the project config", () => {
  test("AC-15: returns gitlab from a repo whose .nax/config.json declares forge.kind", async () => {
    writeProjectConfig({ forge: { kind: "gitlab" } });
    const deps: ForgeDeps = { ...defaultForgeDeps, run: async (cmd) => fakeRun(cmd) };

    expect(await detectForge(deps, repoRoot)).toBe("gitlab");
  });

  test("AC-15: a repo with no forge.kind still detects exactly as before", async () => {
    writeProjectConfig({ version: 1 });
    const deps: ForgeDeps = { ...defaultForgeDeps, run: async (cmd) => fakeRun(cmd) };

    expect(await detectForge(deps, repoRoot)).toBeNull();
  });
});
