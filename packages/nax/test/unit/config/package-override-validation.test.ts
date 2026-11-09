/**
 * US-004 — per-package config validation through the shared package layer.
 *
 * The runtime registry hydrates a package's `.nax/mono/<pkg>/config.json`
 * through `loadPackageOverrideWithConfig`, which used to merge the package's
 * fields over the root config WITHOUT running the validation the
 * `loadConfigForWorkdir` path runs. A package config naming an impossible
 * value (`execution.costLimit: -5`) therefore reached the run as a live
 * override.
 *
 * These tests pin the shared behaviour: both entry points prepare the package
 * layer the same way, both validate the merged result the same way, and the
 * registry's `hydrate` hydrates every package it can before rejecting with
 * the first failure.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeNaxConfig, makeTempDir } from "@test/helpers";
import { createConfigLoader, loadConfigForWorkdir, loadPackageOverrideWithConfig } from "@/config";
import { createConfigWarnDedupe } from "@/config/compat-shims";
import { _clearRootConfigCache } from "@/config/loader";
import { validatePackageConfig } from "@/config/package-layer";
import { NaxError } from "@/errors";
import { addSink, initLogger, resetLogger } from "@/logger";
import { createPackageRegistry } from "@/runtime/packages";

interface CapturedWarning {
  stage: string;
  message: string;
  data?: Record<string, unknown>;
}

describe("per-package config validation (US-004)", () => {
  let repo: string;
  const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;

  beforeEach(async () => {
    repo = makeTempDir("package-override-validation");
    // Isolate the global config so a developer's ~/.nax/config.json cannot
    // change what the root chain resolves (loadConfigForWorkdir reads it).
    process.env.NAX_GLOBAL_CONFIG_DIR = join(repo, "global");
    await Bun.write(join(repo, ".nax/config.json"), "{}");
  });

  afterEach(() => {
    _clearRootConfigCache();
    cleanupTempDir(repo);
    if (originalGlobalDir === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
    else process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
  });

  /** Write `.nax/mono/<packageDir>/config.json` in the temp repo. */
  async function writePackageConfig(packageDir: string, config: unknown): Promise<void> {
    await Bun.write(join(repo, ".nax", "mono", packageDir, "config.json"), JSON.stringify(config));
  }

  /** Write `<packageDir>/.nax/profiles/<profile>.json` in the temp repo. */
  async function writePackageProfile(packageDir: string, profile: string, config: unknown): Promise<void> {
    await Bun.write(join(repo, packageDir, ".nax", "profiles", `${profile}.json`), JSON.stringify(config));
  }

  /** Resolve a package's overlay + config through the registry's own entry point. */
  function loadOverride(packageDir = "packages/api", rootConfig = makeNaxConfig()) {
    return loadPackageOverrideWithConfig({ repoRoot: repo, packageDir, rootConfig });
  }

  /** Run `fn` and return the NaxError it rejected with. */
  async function captureError(run: () => Promise<unknown>): Promise<NaxError> {
    try {
      await run();
    } catch (err) {
      if (err instanceof NaxError) return err;
      throw err;
    }
    throw new Error("expected the call to reject, but it resolved");
  }

  /** Run `fn` with a logger attached and return every warning it logged. */
  async function captureWarnings(run: () => Promise<unknown>): Promise<CapturedWarning[]> {
    const captured: CapturedWarning[] = [];
    resetLogger();
    initLogger({ level: "warn", suppressConsole: true });
    const removeSink = addSink((entry) =>
      captured.push({ stage: entry.stage, message: entry.message, data: entry.data }),
    );
    try {
      await run();
    } finally {
      removeSink();
      resetLogger();
    }
    return captured;
  }

  test("AC-1: an invalid package config rejects with PER_PACKAGE_PROFILE_INVALID", async () => {
    await writePackageConfig("packages/api", { execution: { costLimit: -5 } });

    const err = await captureError(() => loadOverride());

    expect(err).toBeInstanceOf(NaxError);
    expect(err.code).toBe("PER_PACKAGE_PROFILE_INVALID");
  });

  test("AC-2: the rejection names the package and the offending path", async () => {
    await writePackageConfig("packages/api", { execution: { costLimit: -5 } });

    const err = await captureError(() => loadOverride());

    expect(err.message).toContain("packages/api");
    expect(err.message).toContain("execution.costLimit");
  });

  test("AC-3: loadConfigForWorkdir rejects with the same code and message", async () => {
    await writePackageConfig("packages/api", { execution: { costLimit: -5 } });

    const fromWorkdir = await captureError(() => loadConfigForWorkdir(join(repo, ".nax/config.json"), "packages/api"));
    const fromOverride = await captureError(() => loadOverride());

    expect(fromWorkdir.code).toBe(fromOverride.code);
    expect(fromWorkdir.message).toBe(fromOverride.message);
  });

  test("AC-4: a permissions block with both allow aliases keeps its own error code", async () => {
    await writePackageConfig("packages/api", {
      execution: { permissions: { run: { allowedTools: ["Bash(ls *)"], allow: ["Bash(echo *)"] } } },
    });

    const err = await captureError(() => loadOverride());

    expect(err.code).toBe("CONFIG_PERMISSIONS_ALLOW_ALIAS_CONFLICT");
  });

  test("AC-5: an env-var reference in a package command resolves", async () => {
    process.env.NAX_F4_TEST_CMD = "bun run test:pkg";
    try {
      await writePackageConfig("packages/api", { quality: { commands: { test: "$NAX_F4_TEST_CMD" } } });

      const result = await loadOverride();

      expect(result?.config.quality.commands.test).toBe("bun run test:pkg");
    } finally {
      delete process.env.NAX_F4_TEST_CMD;
    }
  });

  test("AC-6: a removed routing strategy is migrated, not rejected", async () => {
    await writePackageConfig("packages/api", { routing: { strategy: "manual" } });

    const result = await loadOverride();

    expect(result?.config.routing.strategy).toBe("keyword");
  });

  test("both entry points resolve an env reference and apply the same shim", async () => {
    process.env.NAX_F4_TEST_CMD = "bun run test:pkg";
    try {
      await writePackageConfig("packages/api", {
        quality: { commands: { test: "$NAX_F4_TEST_CMD" } },
        routing: { strategy: "manual" },
      });

      const fromWorkdir = await loadConfigForWorkdir(join(repo, ".nax/config.json"), "packages/api");
      const fromOverride = await loadOverride();

      expect(fromWorkdir.quality.commands.test).toBe("bun run test:pkg");
      expect(fromWorkdir.routing.strategy).toBe("keyword");
      expect(fromOverride?.config.quality.commands.test).toBe("bun run test:pkg");
      expect(fromOverride?.config.routing.strategy).toBe("keyword");
    } finally {
      delete process.env.NAX_F4_TEST_CMD;
    }
  });

  test("AC-7: the removed-strategy warning is emitted once", async () => {
    await writePackageConfig("packages/api", { routing: { strategy: "manual" } });

    const warnings = await captureWarnings(() => loadOverride());

    const matching = warnings.filter((w) => w.message.includes('routing.strategy="manual" was removed'));
    expect(matching).toHaveLength(1);
  });

  test("AC-8: a valid package config reaches both the overlay and the config", async () => {
    await writePackageConfig("packages/api", { quality: { commands: { test: "bun run test:pkg" } } });

    const result = await loadOverride();

    expect(result?.overlay.quality?.commands?.test).toBe("bun run test:pkg");
    expect(result?.config.quality.commands.test).toBe("bun run test:pkg");
  });

  test("AC-9: a package profile with an invalid value is rejected", async () => {
    await writePackageConfig("packages/api", { profile: "pkg-cost" });
    await writePackageProfile("packages/api", "pkg-cost", { execution: { costLimit: -1 } });

    const err = await captureError(() => loadOverride());

    expect(err.code).toBe("PER_PACKAGE_PROFILE_INVALID");
  });

  test("AC-10: review commands stay bridged from the package's own declarations", async () => {
    const config = makeNaxConfig({ review: { commands: { test: "root-test", lint: "root-lint" } } });
    await writePackageConfig("packages/api", { review: { commands: { test: "pkg-test" } } });

    const result = await loadOverride("packages/api", config);

    expect(result?.config.review.commands.test).toBe("pkg-test");
    expect(result?.config.review.commands.lint).toBe("root-lint");
  });

  test("AC-11: hydrate rejects an invalid package config", async () => {
    await writePackageConfig("packages/api", { execution: { costLimit: -5 } });
    const registry = createPackageRegistry(createConfigLoader(makeNaxConfig()), repo);

    const err = await captureError(() => registry.hydrate(["packages/api"]));

    expect(err.code).toBe("PER_PACKAGE_PROFILE_INVALID");
  });

  test("AC-12: a package that failed to hydrate falls back to the root config", async () => {
    await writePackageConfig("packages/api", { execution: { costLimit: -5 } });
    const registry = createPackageRegistry(createConfigLoader(makeNaxConfig()), repo);

    await captureError(() => registry.hydrate(["packages/api"]));

    expect(registry.resolve("packages/api").hasOverride).toBe(false);
  });

  test("AC-13: an unset env var is left unresolved", async () => {
    delete process.env.NAX_F4_UNSET;
    await writePackageConfig("packages/api", { quality: { commands: { test: "$NAX_F4_UNSET" } } });

    const result = await loadOverride();

    expect(result?.config.quality.commands.test).toBe("$NAX_F4_UNSET");
  });

  test("AC-14: the unset env var warns once, naming the package", async () => {
    delete process.env.NAX_F4_UNSET;
    await writePackageConfig("packages/api", { quality: { commands: { test: "$NAX_F4_UNSET" } } });

    const warnings = await captureWarnings(() => loadOverride());

    const matching = warnings.filter((w) => w.message.includes('per-package config "packages/api"'));
    expect(matching).toHaveLength(1);
  });

  test("AC-15/16: hydrate hydrates the healthy package and rejects with the first error", async () => {
    await writePackageConfig("packages/api", { execution: { costLimit: -5 } });
    await writePackageConfig("packages/web", { quality: { commands: { test: "bun run test:web" } } });
    const registry = createPackageRegistry(createConfigLoader(makeNaxConfig()), repo);

    const err = await captureError(() => registry.hydrate(["packages/api", "packages/web"]));

    expect(err.code).toBe("PER_PACKAGE_PROFILE_INVALID");
    expect(registry.resolve("packages/web").config.quality.commands.test).toBe("bun run test:web");
    expect(registry.resolve("packages/web").hasOverride).toBe(true);
  });

  test("AC-17: a valid package config hydrates", async () => {
    await writePackageConfig("packages/api", { quality: { commands: { test: "bun run test:pkg" } } });
    const registry = createPackageRegistry(createConfigLoader(makeNaxConfig()), repo);

    await registry.hydrate(["packages/api"]);

    expect(registry.resolve("packages/api").config.quality.commands.test).toBe("bun run test:pkg");
  });

  test("AC-18: validatePackageConfig rejects an invalid merged config", async () => {
    const base = makeNaxConfig();
    const merged: Record<string, unknown> = { ...base, execution: { ...base.execution, costLimit: -5 } };

    const err = await captureError(async () =>
      validatePackageConfig(merged, "packages/api", [], createConfigWarnDedupe()),
    );

    expect(err.code).toBe("PER_PACKAGE_PROFILE_INVALID");
  });

  test("AC-19: validatePackageConfig returns the parsed config", async () => {
    const base = makeNaxConfig();
    const merged: Record<string, unknown> = { ...base, execution: { ...base.execution, costLimit: 7 } };

    const validated = validatePackageConfig(merged, "packages/api", [], createConfigWarnDedupe());

    expect(validated.execution.costLimit).toBe(7);
  });

  test("AC-20: a root-only execution key is dropped and the root's value kept", async () => {
    const config = makeNaxConfig();
    await writePackageConfig("packages/api", { execution: { approvalTimeout: 5 } });

    const result = await loadOverride("packages/api", config);

    expect(result?.config.execution.approvalTimeout).toBe(config.execution.approvalTimeout);
  });

  test("AC-21: the dropped root-only key warns once, naming the package", async () => {
    await writePackageConfig("packages/api", { execution: { approvalTimeout: 5 } });

    const warnings = await captureWarnings(() => loadOverride());

    const matching = warnings.filter(
      (w) => w.message.includes("execution.approvalTimeout is root-only") && w.message.includes("packages/api"),
    );
    expect(matching).toHaveLength(1);
  });

  test("AC-22: two failing packages reject with the first package's error", async () => {
    await writePackageConfig("packages/api", { execution: { costLimit: -5 } });
    await writePackageConfig("packages/web", { execution: { costLimit: -5 } });
    const registry = createPackageRegistry(createConfigLoader(makeNaxConfig()), repo);

    const err = await captureError(() => registry.hydrate(["packages/api", "packages/web"]));

    expect(err.message).toContain("packages/api");
  });

  test("AC-23: the second failure is logged on the packages stage with its package dir", async () => {
    await writePackageConfig("packages/api", { execution: { costLimit: -5 } });
    await writePackageConfig("packages/web", { execution: { costLimit: -5 } });
    const registry = createPackageRegistry(createConfigLoader(makeNaxConfig()), repo);

    const warnings = await captureWarnings(async () => {
      await captureError(() => registry.hydrate(["packages/api", "packages/web"]));
    });

    const matching = warnings.filter((w) => w.stage === "packages" && w.data?.packageDir === "packages/web");
    expect(matching).toHaveLength(1);
  });
});
