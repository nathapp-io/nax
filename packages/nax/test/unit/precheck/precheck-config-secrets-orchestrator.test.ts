/**
 * US-002 — precheck orchestrator wiring for the config-secrets warning.
 *
 * `runEnvironmentPrecheck` and `runPrecheck` must file `checkConfigSecrets`
 * under `warnings` even when a Tier-1 blocker already failed, so a dirty
 * non-git working tree still surfaces the finding.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeNaxConfig, makePRD, makeTempDir } from "@test/helpers";
import { runEnvironmentPrecheck, runPrecheck } from "@/precheck";

const LITERAL_AUTHORIZATION_HEADER = {
  reporters: { webhook: { headers: { Authorization: "Bearer abc12345xyz" } } },
};

/** Write the fixture's project config — a literal header the scanner flags. */
function writeRootConfig(root: string, value: unknown): void {
  const naxDir = join(root, ".nax");
  mkdirSync(naxDir, { recursive: true });
  writeFileSync(join(naxDir, "config.json"), JSON.stringify(value));
}

describe("runEnvironmentPrecheck — config-secrets warning", () => {
  let root: string;

  beforeEach(() => {
    // Deliberately a plain, non-git directory: git-repo-exists is a Tier-1
    // blocker, so config-secrets only appears if it runs regardless.
    root = makeTempDir("nax-env-precheck-secrets-");
  });

  afterEach(() => {
    cleanupTempDir(root);
  });

  test("AC5: reports config-secrets under warnings alongside a failed blocker", async () => {
    writeRootConfig(root, LITERAL_AUTHORIZATION_HEADER);

    const result = await runEnvironmentPrecheck(makeNaxConfig(), root, { format: "json", silent: true });

    expect(result.blockers.some((check) => check.name === "git-repo-exists")).toBe(true);
    expect(result.warnings.some((check) => check.name === "config-secrets")).toBe(true);
  });

  test("AC5 boundary: a clean root config leaves config-secrets out of warnings", async () => {
    writeRootConfig(root, {});

    const result = await runEnvironmentPrecheck(makeNaxConfig(), root, { format: "json", silent: true });

    expect(result.blockers.some((check) => check.name === "git-repo-exists")).toBe(true);
    expect(result.warnings.some((check) => check.name === "config-secrets")).toBe(false);
  });
});

describe("runPrecheck — config-secrets warning", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir("nax-precheck-secrets-");
  });

  afterEach(() => {
    cleanupTempDir(root);
  });

  test("AC6: resolves with a config-secrets entry in result.warnings", async () => {
    writeRootConfig(root, LITERAL_AUTHORIZATION_HEADER);

    const { result } = await runPrecheck(makeNaxConfig(), makePRD(), {
      workdir: root,
      format: "json",
      silent: true,
    });

    expect(result.warnings.some((check) => check.name === "config-secrets")).toBe(true);
  });

  test("AC6 boundary: does not warn when the project config carries no literal secret", async () => {
    writeRootConfig(root, {});

    const { result } = await runPrecheck(makeNaxConfig(), makePRD(), {
      workdir: root,
      format: "json",
      silent: true,
    });

    expect(result.warnings.some((check) => check.name === "config-secrets")).toBe(false);
  });
});
