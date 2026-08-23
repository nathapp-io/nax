/**
 * Tests for the legacy config deprecation shim (US-005c, #1146)
 *
 * When a project config contains removed keys (execution.inlineReview,
 * review.dialogue.enabled) or legacy values (review.pluginMode "per-story"), the loader must:
 * - Log a warn-level message per removed key containing the key name and "removed"
 * - Not surface those keys in the loaded config
 *
 * Note: review.pluginMode itself is a valid field since #1146 (values: "observational"|"gating").
 * Only the legacy "per-story" value triggers the shim.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  _applyLegacyReviewExecutionShim,
  _applyRemovedRoutingKeysShim,
  _applyRemovedWorktreeInheritShim,
} from "@/config/compat-shims";
import { _clearRootConfigCache, loadConfig, loadConfigForWorkdir } from "@/config/loader";
import { addSink, initLogger, resetLogger } from "@/logger";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

describe("_applyRemovedRoutingKeysShim — routing keys removed with ROUTE-001", () => {
  test("warns and strips routing.customStrategyPath", () => {
    const captured: string[] = [];
    const result = _applyRemovedRoutingKeysShim(
      { routing: { strategy: "keyword", customStrategyPath: "./my-strategy.ts" } },
      (msg) => captured.push(msg),
    );

    expect(captured.length).toBe(1);
    expect(captured[0]).toContain("routing.customStrategyPath");
    expect(captured[0]).toContain("removed");
    expect(result.routing as Record<string, unknown>).not.toHaveProperty("customStrategyPath");
  });

  test("warns and strips routing.adaptive", () => {
    const captured: string[] = [];
    const result = _applyRemovedRoutingKeysShim(
      { routing: { strategy: "keyword", adaptive: { costThreshold: 0.5, minSamples: 10 } } },
      (msg) => captured.push(msg),
    );

    expect(captured.length).toBe(1);
    expect(captured[0]).toContain("routing.adaptive");
    expect(captured[0]).toContain("removed");
    expect(result.routing as Record<string, unknown>).not.toHaveProperty("adaptive");
  });

  test("warns once per removed key when both are present", () => {
    const captured: string[] = [];
    _applyRemovedRoutingKeysShim(
      { routing: { strategy: "keyword", adaptive: {}, customStrategyPath: "./x.ts" } },
      (msg) => captured.push(msg),
    );

    expect(captured.length).toBe(2);
  });

  test("leaves a routing config without removed keys untouched and silent", () => {
    const captured: string[] = [];
    const input = { routing: { strategy: "llm", llm: { model: "sonnet" } } };
    const result = _applyRemovedRoutingKeysShim(input, (msg) => captured.push(msg));

    expect(captured.length).toBe(0);
    expect(result.routing).toEqual({ strategy: "llm", llm: { model: "sonnet" } });
  });

  test("does not mutate the input config", () => {
    const input = { routing: { strategy: "keyword", customStrategyPath: "./x.ts" } };
    _applyRemovedRoutingKeysShim(input, () => {});

    expect(input.routing).toHaveProperty("customStrategyPath", "./x.ts");
  });

  test("tolerates a config with no routing section", () => {
    const captured: string[] = [];
    const result = _applyRemovedRoutingKeysShim({ execution: {} }, (msg) => captured.push(msg));

    expect(captured.length).toBe(0);
    expect(result).toEqual({ execution: {} });
  });
});

describe("_applyRemovedWorktreeInheritShim — worktreeDependencies mode removed with #574", () => {
  test("warns and maps mode=inherit to off", () => {
    const captured: string[] = [];
    const result = _applyRemovedWorktreeInheritShim(
      { execution: { worktreeDependencies: { mode: "inherit", setupCommand: null } } },
      (msg) => captured.push(msg),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("execution.worktreeDependencies.mode");
    expect(captured[0]).toContain("removed");
    const execution = result.execution as Record<string, unknown>;
    expect(execution.worktreeDependencies).toEqual({ mode: "off", setupCommand: null });
  });

  test("leaves provision and off untouched without warning", () => {
    for (const mode of ["provision", "off"]) {
      const captured: string[] = [];
      const conf = { execution: { worktreeDependencies: { mode } } };
      const result = _applyRemovedWorktreeInheritShim(conf, (msg) => captured.push(msg));

      expect(captured).toHaveLength(0);
      expect(result).toBe(conf);
    }
  });

  test("does not mutate the input config", () => {
    const conf = { execution: { worktreeDependencies: { mode: "inherit" } } };
    _applyRemovedWorktreeInheritShim(conf, () => {});

    expect(conf.execution.worktreeDependencies.mode).toBe("inherit");
  });
});

describe("loadConfig — legacy key deprecation shim", () => {
  let tempDir: string;
  let originalGlobalDir: string | undefined;

  beforeEach(() => {
    tempDir = makeTempDir("nax-loader-legacy-shim-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });
    originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = join(tempDir, ".global-nax");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    if (originalGlobalDir === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
    }
  });

  async function writeProjectConfig(config: Record<string, unknown>): Promise<void> {
    await Bun.write(join(tempDir, ".nax", "config.json"), JSON.stringify(config));
  }

  test("AC7: logs warn for execution.inlineReview when present in project config", () => {
    const captured: string[] = [];
    const result = _applyLegacyReviewExecutionShim(
      { execution: { inlineReview: true } } as Record<string, unknown>,
      (msg) => captured.push(msg),
    );

    expect(captured.length).toBe(1);
    expect(captured[0]).toContain("execution.inlineReview");
    expect(captured[0]).toContain("removed");
    expect(result.execution as Record<string, unknown>).not.toHaveProperty("inlineReview");
  });

  test("AC7: logs warn for review.pluginMode when value is legacy 'per-story'", () => {
    const captured: string[] = [];
    const result = _applyLegacyReviewExecutionShim(
      { review: { pluginMode: "per-story" } } as Record<string, unknown>,
      (msg) => captured.push(msg),
    );

    expect(captured.length).toBe(1);
    expect(captured[0]).toContain("review.pluginMode");
    expect(captured[0]).toContain("removed");
    expect(result.review as Record<string, unknown>).not.toHaveProperty("pluginMode");
  });

  test("AC7: does NOT strip review.pluginMode when value is valid ('observational')", () => {
    const captured: string[] = [];
    const result = _applyLegacyReviewExecutionShim(
      { review: { pluginMode: "observational" } } as Record<string, unknown>,
      (msg) => captured.push(msg),
    );

    expect(captured.length).toBe(0);
    expect(result.review as Record<string, unknown>).toHaveProperty("pluginMode", "observational");
  });

  test("AC7: does NOT strip review.pluginMode when value is valid ('gating')", () => {
    const captured: string[] = [];
    const result = _applyLegacyReviewExecutionShim(
      { review: { pluginMode: "gating" } } as Record<string, unknown>,
      (msg) => captured.push(msg),
    );

    expect(captured.length).toBe(0);
    expect(result.review as Record<string, unknown>).toHaveProperty("pluginMode", "gating");
  });

  test("AC7: logs warn for review.dialogue.enabled:true when present in project config", () => {
    const captured: string[] = [];
    const result = _applyLegacyReviewExecutionShim(
      { review: { dialogue: { enabled: true } } } as Record<string, unknown>,
      (msg) => captured.push(msg),
    );

    expect(captured.length).toBe(1);
    expect(captured[0]).toContain("review.dialogue.enabled");
    expect(captured[0]).toContain("removed");
    expect(result.review as Record<string, unknown>).not.toHaveProperty("dialogue");
  });

  test("AC7: logs one warn per removed key when multiple legacy keys are present", () => {
    const captured: string[] = [];
    const result = _applyLegacyReviewExecutionShim(
      {
        execution: { inlineReview: true },
        review: { pluginMode: "per-story", dialogue: { enabled: true } },
      } as Record<string, unknown>,
      (msg) => captured.push(msg),
    );

    expect(captured.length).toBe(3);
    expect(captured.some((m) => m.includes("execution.inlineReview") && m.includes("removed"))).toBe(true);
    expect(captured.some((m) => m.includes("review.pluginMode") && m.includes("removed"))).toBe(true);
    expect(captured.some((m) => m.includes("review.dialogue.enabled") && m.includes("removed"))).toBe(true);
    expect(result.execution as Record<string, unknown>).not.toHaveProperty("inlineReview");
    expect(result.review as Record<string, unknown>).not.toHaveProperty("pluginMode");
    expect(result.review as Record<string, unknown>).not.toHaveProperty("dialogue");
  });

  test("AC7: does not warn when no legacy keys are present", () => {
    const captured: string[] = [];
    _applyLegacyReviewExecutionShim({ quality: { commands: { test: "bun test" } } } as Record<string, unknown>, (msg) =>
      captured.push(msg),
    );
    expect(captured.length).toBe(0);
  });

  test("AC7: does not warn for dialogue when enabled is false", () => {
    const captured: string[] = [];
    const result = _applyLegacyReviewExecutionShim(
      { review: { dialogue: { enabled: false } } } as Record<string, unknown>,
      (msg) => captured.push(msg),
    );
    expect(captured.length).toBe(0);
    expect(result.review as Record<string, unknown>).toHaveProperty("dialogue");
  });

  test("AC7: loadConfig strips legacy keys from loaded config end-to-end", async () => {
    await writeProjectConfig({
      execution: { inlineReview: true },
      review: { pluginMode: "per-story", dialogue: { enabled: true } },
    });

    const config = await loadConfig(tempDir);

    expect(config.execution as unknown as Record<string, unknown>).not.toHaveProperty("inlineReview");
    // pluginMode "per-story" is stripped; the field reappears with the default "observational"
    // because pluginMode is now a valid field with default (#1146).
    expect(config.review as unknown as Record<string, unknown>).toHaveProperty("pluginMode", "observational");
    expect(config.review as unknown as Record<string, unknown>).not.toHaveProperty("dialogue");
  });

  test("loadConfig warns about removed routing keys end-to-end (proves the shim is wired)", async () => {
    await writeProjectConfig({ routing: { strategy: "keyword", adaptive: { costThreshold: 0.5 } } });

    const captured: string[] = [];
    resetLogger();
    initLogger({ level: "warn" });
    const removeSink = addSink((entry) => captured.push(entry.message));
    try {
      await loadConfig(tempDir);
    } finally {
      removeSink();
      resetLogger();
    }

    expect(captured.some((m) => m.includes("routing.adaptive") && m.includes("removed"))).toBe(true);
  });

  test("AC7: loadConfig preserves valid pluginMode 'gating' end-to-end", async () => {
    await writeProjectConfig({
      review: { pluginMode: "gating" },
    });

    const config = await loadConfig(tempDir);

    expect(config.review as unknown as Record<string, unknown>).toHaveProperty("pluginMode", "gating");
  });

  // BUG-51: profile/CLI config layers must run through the same compat-shim chain as
  // file-based layers (global/project config), or a legacy value set via a profile
  // (or CLI override) hard-fails Zod validation instead of being remapped.
  test("BUG-51: loadConfig remaps a removed routing.strategy set via a profile instead of failing", async () => {
    await Bun.write(
      join(tempDir, ".nax", "profiles", "legacy-manual.json"),
      JSON.stringify({ routing: { strategy: "manual" } }),
    );

    const config = await loadConfig(tempDir, { profile: "legacy-manual" });

    // "manual" was removed in ROUTE-001 and mapped to "keyword" by applyRemovedStrategyCompat.
    expect(config.routing.strategy).toBe("keyword");
  });

  test("BUG-51: loadConfig remaps a removed routing.strategy set via a CLI override instead of failing", async () => {
    const config = await loadConfig(tempDir, { routing: { strategy: "adaptive" } });

    expect(config.routing.strategy).toBe("keyword");
  });

  // BUG-51's fix routed every layer (global, project, profile, CLI) through the
  // same compat-shim chain. Correct, but it made the deprecation warning fire
  // once per layer that carries the key — the same advice repeated up to four
  // times reads as four distinct problems.
  async function captureLoadWarnings(load: () => Promise<unknown>): Promise<string[]> {
    const captured: string[] = [];
    resetLogger();
    initLogger({ level: "warn" });
    const removeSink = addSink((entry) => captured.push(entry.message));
    try {
      await load();
    } finally {
      removeSink();
      resetLogger();
    }
    return captured;
  }

  test("a deprecation warning is emitted once even when several config layers carry the same legacy key", async () => {
    await Bun.write(
      join(tempDir, ".global-nax", "config.json"),
      JSON.stringify({ routing: { strategy: "keyword", adaptive: { costThreshold: 0.1 } } }),
    );
    await writeProjectConfig({ routing: { strategy: "keyword", adaptive: { costThreshold: 0.5 } } });
    await Bun.write(
      join(tempDir, ".nax", "profiles", "legacy.json"),
      JSON.stringify({ routing: { adaptive: { costThreshold: 0.7 } } }),
    );

    const captured = await captureLoadWarnings(() =>
      loadConfig(tempDir, { profile: "legacy", routing: { adaptive: { costThreshold: 0.9 } } }),
    );

    const hits = captured.filter((m) => m.includes("routing.adaptive"));
    expect(hits).toHaveLength(1);
  });

  test("distinct deprecation warnings are all still emitted", async () => {
    await writeProjectConfig({
      routing: { strategy: "keyword", adaptive: { costThreshold: 0.5 }, customStrategyPath: "./x.ts" },
    });

    const captured = await captureLoadWarnings(() => loadConfig(tempDir));

    expect(captured.filter((m) => m.includes("routing.adaptive"))).toHaveLength(1);
    expect(captured.filter((m) => m.includes("routing.customStrategyPath"))).toHaveLength(1);
  });

  // Dedupe must collapse genuine repeats, not distinct diagnostics that happen
  // to share a message string. The testPattern shim emits fixed text with the
  // offending value in its structured data, so keying on the message alone
  // would hide the second layer's differing value entirely.
  test("the same deprecated key with different values in two layers reports both", async () => {
    await Bun.write(
      join(tempDir, ".global-nax", "config.json"),
      JSON.stringify({ context: { testCoverage: { testPattern: "**/*.spec.ts" } } }),
    );
    await writeProjectConfig({ context: { testCoverage: { testPattern: "**/*.test.ts" } } });

    const captured = await captureLoadWarnings(() => loadConfig(tempDir));

    expect(captured.filter((m) => m.includes("context.testCoverage.testPattern"))).toHaveLength(2);
  });

  test("dedupe is scoped per load — a second loadConfig warns again", async () => {
    await writeProjectConfig({ routing: { strategy: "keyword", adaptive: { costThreshold: 0.5 } } });

    const first = await captureLoadWarnings(() => loadConfig(tempDir));
    const second = await captureLoadWarnings(() => loadConfig(tempDir));

    expect(first.filter((m) => m.includes("routing.adaptive"))).toHaveLength(1);
    expect(second.filter((m) => m.includes("routing.adaptive"))).toHaveLength(1);
  });

  // SEC-2 / D-2: project config still wins the merge (no precedence change). The
  // loader must warn — once, via the same warnDedupe — when the project layer
  // changes a security-sensitive key from the global-resolved value.
  test("SEC-2: warns once when project config changes execution.permissionProfile from the global value", async () => {
    await Bun.write(
      join(tempDir, ".global-nax", "config.json"),
      JSON.stringify({ execution: { permissionProfile: "safe" } }),
    );
    await writeProjectConfig({ execution: { permissionProfile: "unrestricted" } });

    const captured = await captureLoadWarnings(() => loadConfig(tempDir));

    const hits = captured.filter((m) => m.includes("execution.permissionProfile"));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("safe");
    expect(hits[0]).toContain("unrestricted");

    // Merge precedence is unchanged — project still wins.
    const config = await loadConfig(tempDir);
    expect(config.execution.permissionProfile).toBe("unrestricted");
  });

  test("SEC-2: warns once when project config changes quality.stripEnvVars from the global value", async () => {
    await Bun.write(
      join(tempDir, ".global-nax", "config.json"),
      JSON.stringify({ quality: { stripEnvVars: ["GITHUB_TOKEN"] } }),
    );
    await writeProjectConfig({ quality: { stripEnvVars: [] } });

    const captured = await captureLoadWarnings(() => loadConfig(tempDir));

    const hits = captured.filter((m) => m.includes("quality.stripEnvVars"));
    expect(hits).toHaveLength(1);

    const config = await loadConfig(tempDir);
    expect(config.quality.stripEnvVars).toEqual([]);
  });

  test("SEC-2: does not warn when project config does not touch the security-sensitive keys", async () => {
    await Bun.write(
      join(tempDir, ".global-nax", "config.json"),
      JSON.stringify({ execution: { permissionProfile: "safe" } }),
    );
    await writeProjectConfig({ routing: { strategy: "keyword" } });

    const captured = await captureLoadWarnings(() => loadConfig(tempDir));

    expect(captured.some((m) => m.includes("execution.permissionProfile"))).toBe(false);
    expect(captured.some((m) => m.includes("quality.stripEnvVars"))).toBe(false);
  });

  test("SEC-2: does not warn when project config sets the same value as the global config", async () => {
    await Bun.write(
      join(tempDir, ".global-nax", "config.json"),
      JSON.stringify({ execution: { permissionProfile: "safe" } }),
    );
    await writeProjectConfig({ execution: { permissionProfile: "safe" } });

    const captured = await captureLoadWarnings(() => loadConfig(tempDir));

    expect(captured.some((m) => m.includes("execution.permissionProfile"))).toBe(false);
  });

  // SEC-2 follow-up fix: the pre-project-merge snapshot used to be defaults + global
  // merged, so with NO global config file at all, "the global value" the project
  // layer was compared against was just the built-in schema default — not anything
  // the user configured. Opting INTO a safer profile (e.g. "safe") from an unset
  // default must not be reported as an override.
  test("SEC-2: does not warn when there is no global config and project config sets execution.permissionProfile (opting into a default-unset value)", async () => {
    // Deliberately no ~/.nax/config.json written for this test.
    await writeProjectConfig({ execution: { permissionProfile: "safe" } });

    const captured = await captureLoadWarnings(() => loadConfig(tempDir));

    expect(captured.some((m) => m.includes("execution.permissionProfile"))).toBe(false);

    const config = await loadConfig(tempDir);
    expect(config.execution.permissionProfile).toBe("safe");
  });

  test("SEC-2: does not warn when there is no global config and project config sets quality.stripEnvVars", async () => {
    await writeProjectConfig({ quality: { stripEnvVars: ["GITHUB_TOKEN"] } });

    const captured = await captureLoadWarnings(() => loadConfig(tempDir));

    expect(captured.some((m) => m.includes("quality.stripEnvVars"))).toBe(false);
  });

  // SEC-2 follow-up fix: profile overlays and CLI overrides merge AFTER the project
  // layer and can undo a security-sensitive setting just as easily — profiles live
  // outside the repo (invisible to code review), so this is arguably higher-risk
  // than the original project-layer case.
  test("SEC-2: warns once when a profile overlay changes execution.permissionProfile after the project layer set it safely, naming the profile", async () => {
    await writeProjectConfig({ execution: { permissionProfile: "safe" } });
    await Bun.write(
      join(tempDir, ".nax", "profiles", "loose.json"),
      JSON.stringify({ execution: { permissionProfile: "unrestricted" } }),
    );

    const captured = await captureLoadWarnings(() => loadConfig(tempDir, { profile: "loose" }));

    const hits = captured.filter((m) => m.includes("execution.permissionProfile"));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("safe");
    expect(hits[0]).toContain("unrestricted");
    expect(hits[0]).toContain("profile:loose");

    const config = await loadConfig(tempDir, { profile: "loose" });
    expect(config.execution.permissionProfile).toBe("unrestricted");
  });

  test("SEC-2: does not warn when a profile overlay does not touch a security-sensitive key", async () => {
    await writeProjectConfig({ execution: { permissionProfile: "safe" } });
    await Bun.write(
      join(tempDir, ".nax", "profiles", "neutral.json"),
      JSON.stringify({ routing: { strategy: "keyword" } }),
    );

    const captured = await captureLoadWarnings(() => loadConfig(tempDir, { profile: "neutral" }));

    expect(captured.some((m) => m.includes("execution.permissionProfile"))).toBe(false);
  });

  test("SEC-2: warns once when a CLI override changes execution.permissionProfile, naming the CLI override", async () => {
    await writeProjectConfig({ execution: { permissionProfile: "safe" } });

    const captured = await captureLoadWarnings(() =>
      loadConfig(tempDir, { execution: { permissionProfile: "unrestricted" } }),
    );

    const hits = captured.filter((m) => m.includes("execution.permissionProfile"));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("safe");
    expect(hits[0]).toContain("unrestricted");
    expect(hits[0]).toContain("CLI override");

    const config = await loadConfig(tempDir, { execution: { permissionProfile: "unrestricted" } });
    expect(config.execution.permissionProfile).toBe("unrestricted");
  });

  test("SEC-2: does not warn when a CLI override does not touch a security-sensitive key", async () => {
    await writeProjectConfig({ execution: { permissionProfile: "safe" } });

    const captured = await captureLoadWarnings(() => loadConfig(tempDir, { routing: { strategy: "keyword" } }));

    expect(captured.some((m) => m.includes("execution.permissionProfile"))).toBe(false);
  });

  // #574: proves the shim is wired into the chain, not merely callable. Without it
  // the removed value reaches Zod, whose enum no longer accepts it, and the whole
  // config load hard-fails instead of migrating.
  // #574 follow-up from code review: loadConfigForWorkdir merges per-package
  // overlays and goes straight to safeParse without the compat-shim chain, so
  // narrowing the enum turned a per-package `inherit` into a hard
  // PER_PACKAGE_PROFILE_INVALID — on the very path that feeds
  // prepareWorktreeDependencies for a monorepo story.
  test("loadConfigForWorkdir maps a removed inherit mode in a per-package overlay instead of throwing", async () => {
    await writeProjectConfig({ execution: { worktreeDependencies: { mode: "off" } } });
    const pkgDir = join(tempDir, ".nax", "mono", "packages", "app");
    mkdirSync(pkgDir, { recursive: true });
    await Bun.write(
      join(pkgDir, "config.json"),
      JSON.stringify({ execution: { worktreeDependencies: { mode: "inherit" } } }),
    );

    const config = await loadConfigForWorkdir(join(tempDir, ".nax", "config.json"), "packages/app");

    expect(config.execution.worktreeDependencies.mode).toBe("off");
  });

  test("loadConfig maps a removed worktreeDependencies inherit mode to off end-to-end", async () => {
    await writeProjectConfig({ execution: { worktreeDependencies: { mode: "inherit" } } });

    const captured = await captureLoadWarnings(() => loadConfig(tempDir));
    expect(captured.filter((m) => m.includes("execution.worktreeDependencies.mode"))).toHaveLength(1);

    const config = await loadConfig(tempDir);
    expect(config.execution.worktreeDependencies.mode).toBe("off");
  });
});

// #1620: `loadConfigForWorkdir` ran no compat-shim chain, so a legacy value the
// root config migrates with a warning instead hard-failed with
// PER_PACKAGE_PROFILE_INVALID when it appeared in a per-package overlay — on the
// config path story execution actually uses (iteration-runner resolves a story's
// effective config through here whenever the story has a `workdir`). The chain
// now runs per overlay layer, mirroring the root loader's per-layer placement.
describe("loadConfigForWorkdir — compat-shim chain on per-package overlays (#1620)", () => {
  let tempDir: string;
  let originalGlobalDir: string | undefined;

  beforeEach(() => {
    tempDir = makeTempDir("nax-workdir-shim-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });
    originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = join(tempDir, ".global-nax");
    _clearRootConfigCache();
  });

  afterEach(() => {
    _clearRootConfigCache();
    cleanupTempDir(tempDir);
    if (originalGlobalDir === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
    }
  });

  const PKG = "packages/app";

  async function writeRootConfig(config: Record<string, unknown>): Promise<void> {
    await Bun.write(join(tempDir, ".nax", "config.json"), JSON.stringify(config));
  }

  async function writePackageOverride(override: Record<string, unknown>): Promise<void> {
    const pkgDir = join(tempDir, ".nax", "mono", ...PKG.split("/"));
    mkdirSync(pkgDir, { recursive: true });
    await Bun.write(join(pkgDir, "config.json"), JSON.stringify(override));
  }

  async function writePackageProfile(name: string, data: Record<string, unknown>): Promise<void> {
    const profilesDir = join(tempDir, ...PKG.split("/"), ".nax", "profiles");
    mkdirSync(profilesDir, { recursive: true });
    await Bun.write(join(profilesDir, `${name}.json`), JSON.stringify(data));
  }

  function loadForPackage() {
    return loadConfigForWorkdir(join(tempDir, ".nax", "config.json"), PKG);
  }

  async function captureWorkdirWarnings(load: () => Promise<unknown>): Promise<string[]> {
    const captured: string[] = [];
    resetLogger();
    initLogger({ level: "warn" });
    const removeSink = addSink((entry) => captured.push(entry.message));
    try {
      await load();
    } finally {
      removeSink();
      resetLogger();
    }
    return captured;
  }

  test("applyRemovedStrategyCompat: a removed routing.strategy in an overlay maps to keyword instead of throwing", async () => {
    await writeRootConfig({});
    await writePackageOverride({ routing: { strategy: "manual" } });

    const config = await loadForPackage();

    expect(config.routing.strategy).toBe("keyword");
  });

  test("applyRemovedStrategyCompat: the removed value in a per-package PROFILE maps to keyword too", async () => {
    await writeRootConfig({});
    await writePackageOverride({ profile: "legacy", routing: { strategy: "keyword" } });
    // `maxIterations` is a non-legacy companion value: it pins that the profile layer
    // really merged, so a future regression that drops package profiles entirely
    // cannot make the strategy assertion below pass vacuously.
    await writePackageProfile("legacy", { routing: { strategy: "adaptive" }, execution: { maxIterations: 7 } });

    const config = await loadForPackage();

    expect(config.execution.maxIterations).toBe(7);
    expect(config.routing.strategy).toBe("keyword");
  });

  test("_applyRemovedRoutingKeysShim: routing.adaptive in an overlay is stripped WITH a warning", async () => {
    await writeRootConfig({});
    await writePackageOverride({ routing: { adaptive: { costThreshold: 0.5 } } });

    const captured = await captureWorkdirWarnings(loadForPackage);

    expect(captured.filter((m) => m.includes("routing.adaptive") && m.includes("removed"))).toHaveLength(1);
  });

  test("_applyRemovedRoutingKeysShim: routing.customStrategyPath in an overlay is stripped WITH a warning", async () => {
    await writeRootConfig({});
    await writePackageOverride({ routing: { customStrategyPath: "./x.ts" } });

    const captured = await captureWorkdirWarnings(loadForPackage);

    expect(captured.filter((m) => m.includes("routing.customStrategyPath"))).toHaveLength(1);
  });

  test("applyBatchModeCompat: routing.llm.batchMode in an overlay maps to routing.llm.mode", async () => {
    await writeRootConfig({});
    await writePackageOverride({ routing: { llm: { batchMode: true } } });

    const config = await loadForPackage();

    // Root config always carries a resolved routing.llm.mode ("hybrid" by default),
    // so the mapping only happens if the shim runs on the overlay LAYER, before merge.
    expect(config.routing.llm?.mode).toBe("one-shot");
  });

  test("applyRoutingRetryDeprecationWarning: routing.llm.retries in an overlay warns", async () => {
    await writeRootConfig({});
    await writePackageOverride({ routing: { llm: { retries: 3 } } });

    const captured = await captureWorkdirWarnings(loadForPackage);

    expect(captured.filter((m) => m.includes("routing.llm.retries"))).toHaveLength(1);
  });

  test("migrateLegacyTestPattern: context.testCoverage.testPattern in an overlay migrates to smartTestRunner.testFilePatterns", async () => {
    await writeRootConfig({});
    await writePackageOverride({ context: { testCoverage: { testPattern: "**/*.spec.ts" } } });

    const config = await loadForPackage();

    const smartTestRunner = config.execution.smartTestRunner as { testFilePatterns?: unknown };
    expect(smartTestRunner.testFilePatterns).toEqual(["**/*.spec.ts"]);
    expect(config.context?.testCoverage).not.toHaveProperty("testPattern");
  });

  test("migrateLegacyReviewModelKey: review.semantic.modelTier in an overlay migrates to review.semantic.model", async () => {
    await writeRootConfig({});
    await writePackageOverride({ review: { semantic: { enabled: true, modelTier: "fast" } } });

    const config = await loadForPackage();

    expect(config.review.semantic?.model).toBe("fast");
    expect(config.review.semantic).not.toHaveProperty("modelTier");
  });

  test("_applyLegacyReviewExecutionShim: execution.inlineReview in an overlay is stripped WITH a warning", async () => {
    await writeRootConfig({});
    await writePackageOverride({ execution: { inlineReview: true } });

    const captured = await captureWorkdirWarnings(loadForPackage);

    expect(captured.filter((m) => m.includes("execution.inlineReview"))).toHaveLength(1);
  });

  test("a legacy key carried by BOTH the overlay and a per-package profile warns once per resolution", async () => {
    await writeRootConfig({});
    await writePackageOverride({ profile: "legacy", routing: { adaptive: { costThreshold: 0.5 } } });
    await writePackageProfile("legacy", {
      routing: { adaptive: { costThreshold: 0.9 } },
      execution: { maxIterations: 7 },
    });

    const captured = await captureWorkdirWarnings(loadForPackage);

    expect(captured.filter((m) => m.includes("routing.adaptive"))).toHaveLength(1);
    // Guards against a vacuous pass: one warning must mean "deduped across two
    // layers", not "the profile layer was never merged".
    expect((await loadForPackage()).execution.maxIterations).toBe(7);
  });

  // The two `stripRemovedNoOpKeys` calls on this path are two layers of ONE
  // resolution, but each got the bare `defaultConfigWarn` sink — so a no-op key
  // in both the overlay and a package profile warned twice, where the root path
  // warns once per resolved config. They now share the per-resolution dedupe.
  test("a removed no-op key in both the overlay and a per-package profile warns once, not twice", async () => {
    await writeRootConfig({});
    await writePackageOverride({ profile: "legacy", acceptance: { generateTests: false } });
    await writePackageProfile("legacy", {
      acceptance: { generateTests: false },
      execution: { maxIterations: 7 },
    });

    const captured = await captureWorkdirWarnings(loadForPackage);

    expect(captured.filter((m) => m.includes("generateTests"))).toHaveLength(1);
    expect((await loadForPackage()).execution.maxIterations).toBe(7);
  });
});
