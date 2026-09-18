/**
 * Regression guard for nax#2126 — acceptance-setup's group config must inherit the
 * run's --profile chain.
 *
 * The stage resolves one config per package group and (since #2070) hands it to
 * `callOp` as `ctx.config`. It used to resolve that config without the profile
 * chain, so in a monorepo every group got the bare repo config. With the model map
 * supplied by a profile — the normal arrangement — dispatch then threw
 * `No model entry found for agent "native" ... at tier "fast"`, and the whole
 * pre-run acceptance pipeline failed before a single story ran.
 *
 * This exercises the REAL `loadGroupConfig` dep against a real repo on disk; a
 * stubbed one would pass no matter what the stage passes it.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeDispatchContext, makePRD, makeStory, makeTempDir } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { _clearRootConfigCache } from "@/config/loader";
import { _acceptanceSetupDeps, acceptanceSetupStage } from "@/pipeline/stages/acceptance-setup";
import type { PipelineContext } from "@/pipeline/types";

const PKG = "packages/core";
const PROFILE = "fixture-native";
const NATIVE_FAST = "minimax/MiniMax-M2.7";

const origDeps = { ..._acceptanceSetupDeps };

/** Repo config declares only `models.claude`; everything native arrives via the profile. */
function writeRepo(root: string): void {
  mkdirSync(join(root, ".nax", "profiles"), { recursive: true });
  mkdirSync(join(root, PKG), { recursive: true });
  writeFileSync(
    join(root, ".nax", "config.json"),
    JSON.stringify({ models: { claude: { fast: "haiku", balanced: "sonnet", powerful: "sonnet" } } }),
  );
  writeFileSync(
    join(root, ".nax", "profiles", `${PROFILE}.json`),
    JSON.stringify({
      // protocol "hybrid" is required by the schema for a `models.native` entry.
      agent: { default: "native", protocol: "hybrid" },
      models: {
        claude: { fast: "haiku", balanced: "sonnet", powerful: "sonnet" },
        native: { fast: NATIVE_FAST, balanced: NATIVE_FAST, powerful: "minimax/MiniMax-M3" },
      },
    }),
  );
}

describe("acceptance-setup: group config inherits the run's profile chain (nax#2126)", () => {
  let tempDir: string;
  let originalGlobalDir: string | undefined;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-accept-profile-");
    originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = join(tempDir, ".global-nax");
    writeRepo(tempDir);
    _clearRootConfigCache();
  });

  afterEach(() => {
    Object.assign(_acceptanceSetupDeps, origDeps);
    cleanupTempDir(tempDir);
    // Assigning `undefined` would store the STRING "undefined" and leak a bogus
    // path into every later test in this process.
    if (originalGlobalDir === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
    else process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
    _clearRootConfigCache();
    mock.restore();
  });

  test("the config handed to callOp for a package group carries the profile's model map", async () => {
    const seen: Array<{ packageDir: string; nativeFast: unknown }> = [];

    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.autoCommitIfDirty = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });
    _acceptanceSetupDeps.callOp = async (_ctx, packageDir, op, input, _storyId, config) => {
      seen.push({ packageDir, nativeFast: config?.models?.native?.fast });
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      return { testCode: 'import { test } from "bun:test";\ntest("AC-1", () => {});\n' };
    };

    const story = makeStory({ id: "US-001", workdir: PKG, acceptanceCriteria: ["AC-1: config surface"] });
    const prd = makePRD({ feature: "test-feature", userStories: [story] });
    const ctx: PipelineContext = {
      config: {
        ...DEFAULT_CONFIG,
        profileChain: [PROFILE],
        acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: true, refinement: true, redGate: true },
      },
      prd,
      story,
      stories: [story],
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
      rootConfig: DEFAULT_CONFIG,
      workdir: tempDir,
      projectDir: tempDir,
      featureDir: join(tempDir, ".nax", "features", "test-feature"),
      hooks: { hooks: {} },
      ...makeDispatchContext(),
    };

    await acceptanceSetupStage.execute(ctx);

    // Both the refine and the generate dispatch must see the profile-resolved map.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.packageDir === join(tempDir, PKG))).toBe(true);
    for (const s of seen) expect(s.nativeFast).toBe(NATIVE_FAST);
  });
});
