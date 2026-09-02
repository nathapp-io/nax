/**
 * Unit tests for src/cli/plan-runtime.ts
 *
 * Tests _planDeps object and its shape (AC-14).
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeMockCallContext, makeNaxConfig, makeTempDir, withTempDir } from "@test/helpers";
import { _planDeps, detectProjectName } from "@/cli";
import { resolvePlanModelSelection } from "@/cli/plan-runtime";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config";
import type { DebateStageConfig } from "@/debate/types";

describe("resolvePlanModelSelection", () => {
  test("resolves the configured tier for a real agent+config", () => {
    const config = makeNaxConfig();
    const result = resolvePlanModelSelection(config, "claude");
    expect(result).toHaveProperty("agent");
    expect(result).toHaveProperty("modelDef");
    expect(result).toHaveProperty("modelTier");
  });

  test("falls back to DEFAULT_CONFIG.models when the configured models map cannot resolve the tier", () => {
    const badConfig: NaxConfig = { ...DEFAULT_CONFIG, models: {} };
    // resolveConfiguredModel throws MODEL_NOT_FOUND against the empty map; the
    // catch path must still return a usable resolution from DEFAULT_CONFIG.
    const result = resolvePlanModelSelection(badConfig, "claude");
    expect(result).toHaveProperty("agent");
    expect(result).toHaveProperty("modelDef");
  });
});

describe("detectProjectName — fallback to 'unknown'", () => {
  test("returns 'unknown' when git remote lookup exits non-zero", () => {
    const original = _planDeps.spawnSync;
    _planDeps.spawnSync = () => ({ stdout: Buffer.from(""), exitCode: 1 });
    try {
      expect(detectProjectName("/tmp/no-remote", null)).toBe("unknown");
    } finally {
      _planDeps.spawnSync = original;
    }
  });

  test("returns 'unknown' when the remote URL does not match the expected shape", () => {
    const original = _planDeps.spawnSync;
    _planDeps.spawnSync = () => ({ stdout: Buffer.from("\n"), exitCode: 0 });
    try {
      expect(detectProjectName("/tmp/blank-remote", null)).toBe("unknown");
    } finally {
      _planDeps.spawnSync = original;
    }
  });
});

describe("_planDeps — real implementations", () => {
  test("readFile and writeFile round-trip through the real Bun file APIs", async () => {
    const dir = makeTempDir("nax-plan-runtime-");
    try {
      const path = join(dir, "note.txt");
      await _planDeps.writeFile(path, "hello");
      expect(await _planDeps.readFile(path)).toBe("hello");
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("readPackageJson reads package.json from the given workdir, or null when absent", async () => {
    const dir = makeTempDir("nax-plan-runtime-");
    try {
      expect(await _planDeps.readPackageJson(dir)).toBeNull();
      await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "pkg" }));
      expect(await _planDeps.readPackageJson(dir)).toEqual({ name: "pkg" });
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("readPackageJsonAt reads an arbitrary package.json path, or null when unreadable", async () => {
    const dir = makeTempDir("nax-plan-runtime-");
    try {
      const path = join(dir, "package.json");
      await Bun.write(path, JSON.stringify({ name: "pkg-at" }));
      expect(await _planDeps.readPackageJsonAt(path)).toEqual({ name: "pkg-at" });
      expect(await _planDeps.readPackageJsonAt(join(dir, "missing.json"))).toBeNull();
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("mkdirp creates a nested directory and existsSync reports it", async () => {
    const dir = makeTempDir("nax-plan-runtime-");
    try {
      const nested = join(dir, "a", "b", "c");
      expect(_planDeps.existsSync(nested)).toBe(false);
      await _planDeps.mkdirp(nested);
      expect(_planDeps.existsSync(nested)).toBe(true);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("discoverWorkspacePackages returns an array for a real repo root", async () => {
    const dir = makeTempDir("nax-plan-runtime-");
    try {
      const result = await _planDeps.discoverWorkspacePackages(dir);
      expect(Array.isArray(result)).toBe(true);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("createInteractionBridge returns detectQuestion and onQuestionDetected functions", () => {
    const bridge = _planDeps.createInteractionBridge();
    expect(typeof bridge.detectQuestion).toBe("function");
    expect(typeof bridge.onQuestionDetected).toBe("function");
  });

  test("initInteractionChain returns null in headless mode with no interaction config", async () => {
    const result = await _planDeps.initInteractionChain(makeNaxConfig(), true);
    expect(result).toBeNull();
  });

  test("createDebateRunner constructs a real DebateRunner instance", () => {
    const stageConfig: DebateStageConfig = {
      enabled: true,
      resolver: { type: "majority-fail-closed" },
      sessionMode: "one-shot",
      rounds: 1,
      debaters: [{ agent: "claude", model: "claude-3-5-haiku-20241022" }],
    };
    const runner = _planDeps.createDebateRunner({
      ctx: makeMockCallContext({ packageDir: "/tmp/work", storyId: "US-001", featureName: "f" }),
      stage: "plan",
      stageConfig,
      config: makeNaxConfig(),
      workdir: "/tmp",
      featureName: "f",
    });
    expect(runner).toBeDefined();
    expect(typeof runner.run).toBe("function");
  });

  test("getLogger returns the process logger", () => {
    expect(_planDeps.getLogger()).toBeDefined();
  });

  test("planDecompose dynamically imports and delegates to planDecomposeCommand", async () => {
    const dir = makeTempDir("nax-plan-runtime-");
    try {
      // No prd.json exists in this temp dir — planDecomposeCommand throws
      // PRD_NOT_FOUND, which is enough to prove the dynamic import and
      // delegation actually happened rather than being a no-op stub.
      await expect(
        _planDeps.planDecompose(dir, makeNaxConfig(), {
          feature: "nonexistent-feature",
          storyId: "US-none",
        }),
      ).rejects.toMatchObject({ code: "PRD_NOT_FOUND" });
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("_planDeps", () => {
  // ──────────────────────────────────────────────────────────────────────────
  // AC-14: _planDeps exposes scanSourceRoots and does NOT expose scanCodebase
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-14: _planDeps exposes scanSourceRoots property", () => {
    expect(_planDeps).toHaveProperty("scanSourceRoots");
    expect(typeof _planDeps.scanSourceRoots).toBe("function");
  });

  test("AC-14: _planDeps does NOT expose scanCodebase property", () => {
    expect(_planDeps).not.toHaveProperty("scanCodebase");
  });

  test("AC-14: scanSourceRoots returns an array for a real workdir", async () => {
    await withTempDir(async (tmpDir) => {
      const roots = await _planDeps.scanSourceRoots(tmpDir);
      expect(Array.isArray(roots)).toBe(true);
    });
  });
});

describe("resolvePlanModelSelection unknown-literal guard (spec §3)", () => {
  test("garbage object-form plan.model self-rescues to default balanced", () => {
    const config = makeNaxConfig({ plan: { model: { agent: "claude", model: "turbo" } } });
    const r = resolvePlanModelSelection(config, "claude");
    expect(r.modelTier).toBe("balanced");
  });

  test("legitimate provider-qualified pin passes through untouched", () => {
    const config = makeNaxConfig({ plan: { model: { agent: "claude", model: "opencode-go/qwen-4" } } });
    const r = resolvePlanModelSelection(config, "claude");
    expect(r.modelTier).toBeUndefined();
    expect(r.modelDef.model).toBe("opencode-go/qwen-4");
  });
});
