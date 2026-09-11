/**
 * Tests for AC10 / AC11 — `runPrecheck` integration with the model-resolution
 * check.
 *
 * Verifies that:
 *  - AC10: a native catalog resolver stub that reports every id unresolvable
 *    causes `runPrecheck` to invoke the stubbed resolver, and the returned
 *    `blockers` includes the model-resolution check.
 *  - AC11: when every configured model id resolves, the returned `blockers`
 *    contains no model-resolution check.
 *
 * Reuses the temp-dir + git-init scaffold from precheck-run-story-size-gate
 * so the surrounding environment checks pass.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeNaxConfig, makePRD, makeSpawn, makeTempDir } from "@test/helpers";
import { _modelResolutionDeps, runPrecheck } from "@/precheck";
import { _checkCliDeps } from "@/precheck/checks-cli";

// ─────────────────────────────────────────────────────────────────────────────
// Temp repo — clean git repo with node_modules so tier 1 env checks pass
// ─────────────────────────────────────────────────────────────────────────────

let tempDir: string;

beforeAll(() => {
  tempDir = makeTempDir("nax-precheck-model-resolution-");
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: tempDir, stdout: "ignore", stderr: "ignore" });
  git(["init"]);
  git(["config", "user.email", "test@test.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(tempDir, "README.md"), "# test");
  mkdirSync(join(tempDir, "node_modules"), { recursive: true });
  git(["add", "."]);
  git(["commit", "-m", "init"]);
});

afterAll(() => {
  cleanupTempDir(tempDir);
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeConfigWithNativeModel(): ReturnType<typeof makeNaxConfig> {
  return makeNaxConfig({
    models: {
      native: {
        powerful: "anthropic/never-shipped-model",
      },
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock setup — stub CLI spawn so checkAgentCLI doesn't shell out
// ─────────────────────────────────────────────────────────────────────────────

let origSpawn: typeof _checkCliDeps.spawn;
let origResolveNative: typeof _modelResolutionDeps.resolveNative;

beforeEach(() => {
  origSpawn = _checkCliDeps.spawn;
  origResolveNative = _modelResolutionDeps.resolveNative;

  _checkCliDeps.spawn = makeSpawn(() => ({ exitCode: 0 })).spawn;
});

afterEach(() => {
  _checkCliDeps.spawn = origSpawn;
  _modelResolutionDeps.resolveNative = origResolveNative;
});

// ─────────────────────────────────────────────────────────────────────────────
// AC10: stubbed resolver is invoked, blockers include model-resolution
// ─────────────────────────────────────────────────────────────────────────────

describe("runPrecheck model-resolution integration (US-1984 AC10)", () => {
  test("AC10: invokes the stubbed resolver and the returned blockers include the model-resolution check", async () => {
    let nativeCalls = 0;
    _modelResolutionDeps.resolveNative = async () => {
      nativeCalls += 1;
      return { status: "unresolved" };
    };

    const config = makeConfigWithNativeModel();
    const { result } = await runPrecheck(config, makePRD(), {
      workdir: tempDir,
      format: "json",
      silent: true,
    });

    // The resolver was actually invoked.
    expect(nativeCalls).toBeGreaterThan(0);

    // The model-resolution check is among the blockers.
    const modelResolutionBlocker = result.blockers.find((c) => c.name === "model-resolution");
    expect(modelResolutionBlocker).toBeDefined();
    expect(modelResolutionBlocker?.passed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC11: all ids resolve → no model-resolution blocker
// ─────────────────────────────────────────────────────────────────────────────

describe("runPrecheck model-resolution integration (US-1984 AC11)", () => {
  test("AC11: when every configured model id resolves, blockers contains no model-resolution check", async () => {
    _modelResolutionDeps.resolveNative = async () => ({ status: "resolved" });

    const config = makeConfigWithNativeModel();
    const { result } = await runPrecheck(config, makePRD(), {
      workdir: tempDir,
      format: "json",
      silent: true,
    });

    const modelResolution = result.blockers.find((c) => c.name === "model-resolution");
    expect(modelResolution).toBeUndefined();
  });
});
