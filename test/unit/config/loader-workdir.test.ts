/**
 * Unit tests for loadConfigForWorkdir (MW-008, BUG-134)
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "@test/helpers";
import { _clearRootConfigCache, loadConfigForWorkdir } from "@/config/loader";
import { addSink, getLogger, initLogger, resetLogger } from "@/logger";

describe("loadConfigForWorkdir", () => {
  let tempDir: string;
  let originalGlobalDir: string | undefined;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-workdir-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });
    originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = join(tempDir, ".global-nax");
    _clearRootConfigCache();
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    if (originalGlobalDir === undefined) {
      process.env.NAX_GLOBAL_CONFIG_DIR = undefined;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
    }
  });

  test("returns root config when no packageDir provided", async () => {
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun test" } } }),
    );

    const rootConfigPath = join(tempDir, ".nax", "config.json");
    const result = await loadConfigForWorkdir(rootConfigPath);

    expect(result.quality.commands.test).toBe("bun test");
  });

  test("returns root config when package config does not exist", async () => {
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun test" } } }),
    );

    const rootConfigPath = join(tempDir, ".nax", "config.json");
    const result = await loadConfigForWorkdir(rootConfigPath, "packages/api");

    expect(result.quality.commands.test).toBe("bun test");
  });

  test("merges package quality.commands when package config exists", async () => {
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun test", typecheck: "bun run typecheck" } } }),
    );

    // Create package config at new location: .nax/mono/<packageDir>/config.json
    mkdirSync(join(tempDir, ".nax", "mono", "packages", "api"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "mono", "packages", "api", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun run test:unit" } } }),
    );

    const rootConfigPath = join(tempDir, ".nax", "config.json");
    const result = await loadConfigForWorkdir(rootConfigPath, "packages/api");

    // Package test command overrides root
    expect(result.quality.commands.test).toBe("bun run test:unit");
    // Root typecheck preserved
    expect(result.quality.commands.typecheck).toBe("bun run typecheck");
  });

  test("story without workdir (no packageDir) uses root test command", async () => {
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun test" } } }),
    );
    mkdirSync(join(tempDir, ".nax", "mono", "packages", "api"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "mono", "packages", "api", "config.json"),
      JSON.stringify({ quality: { commands: { test: "npm test" } } }),
    );

    const rootConfigPath = join(tempDir, ".nax", "config.json");
    const result = await loadConfigForWorkdir(rootConfigPath);

    expect(result.quality.commands.test).toBe("bun test");
  });

  test("BUG-134: logs info when package config not found (fallback to root)", async () => {
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun test" } } }),
    );

    const logger = getLogger();
    const infoSpy = spyOn(logger, "info");

    const rootConfigPath = join(tempDir, ".nax", "config.json");
    await loadConfigForWorkdir(rootConfigPath, "packages/missing");

    const fallbackCall = infoSpy.mock.calls.find(
      (args) => typeof args[1] === "string" && args[1].includes("Per-package config not found"),
    );
    expect(fallbackCall).toBeDefined();
    expect(fallbackCall?.[2]).toMatchObject({ packageDir: "packages/missing" });

    infoSpy.mockRestore();
  });

  test("BUG-134: logs debug when packageDir is undefined (no per-package resolution)", async () => {
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun test" } } }),
    );

    const logger = getLogger();
    const debugSpy = spyOn(logger, "debug");

    const rootConfigPath = join(tempDir, ".nax", "config.json");
    await loadConfigForWorkdir(rootConfigPath);

    const noWorkdirCall = debugSpy.mock.calls.find(
      (args) => typeof args[1] === "string" && args[1].includes("No packageDir"),
    );
    expect(noWorkdirCall).toBeDefined();

    debugSpy.mockRestore();
  });

  test("package config without quality.commands does not change test command", async () => {
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun test" } } }),
    );
    mkdirSync(join(tempDir, ".nax", "mono", "packages", "web"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "mono", "packages", "web", "config.json"),
      JSON.stringify({ routing: { strategy: "keyword" } }),
    );

    const rootConfigPath = join(tempDir, ".nax", "config.json");
    const result = await loadConfigForWorkdir(rootConfigPath, "packages/web");

    expect(result.quality.commands.test).toBe("bun test");
  });

  test("caches root config: second call with same path skips I/O (same promise)", async () => {
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun test" } } }),
    );
    mkdirSync(join(tempDir, ".nax", "mono", "packages", "api"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "mono", "packages", "api", "config.json"),
      JSON.stringify({ quality: { commands: { test: "npm test" } } }),
    );
    mkdirSync(join(tempDir, ".nax", "mono", "packages", "web"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "mono", "packages", "web", "config.json"),
      JSON.stringify({ quality: { commands: { test: "yarn test" } } }),
    );

    const rootConfigPath = join(tempDir, ".nax", "config.json");
    // Two different packages load config with the same root path
    const [api, web] = await Promise.all([
      loadConfigForWorkdir(rootConfigPath, "packages/api"),
      loadConfigForWorkdir(rootConfigPath, "packages/web"),
    ]);

    expect(api.quality.commands.test).toBe("npm test");
    expect(web.quality.commands.test).toBe("yarn test");
  });

  test("caches root config: clearing cache allows fresh load after config file changes", async () => {
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun test v1" } } }),
    );

    const rootConfigPath = join(tempDir, ".nax", "config.json");
    const first = await loadConfigForWorkdir(rootConfigPath);
    expect(first.quality.commands.test).toBe("bun test v1");

    // Simulate config file change + cache clear
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun test v2" } } }),
    );
    _clearRootConfigCache();

    const second = await loadConfigForWorkdir(rootConfigPath);
    expect(second.quality.commands.test).toBe("bun test v2");
  });

  test("per-package agent.protocol override is applied", async () => {
    writeFileSync(join(tempDir, ".nax", "config.json"), JSON.stringify({ agent: { protocol: "acp" } }));
    mkdirSync(join(tempDir, ".nax", "mono", "packages", "pkg-a"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "mono", "packages", "pkg-a", "config.json"),
      JSON.stringify({ agent: { maxInteractionTurns: 5 } }),
    );

    const rootConfigPath = join(tempDir, ".nax", "config.json");
    const result = await loadConfigForWorkdir(rootConfigPath, "packages/pkg-a");

    expect(result.agent?.protocol).toBe("acp");
    expect(result.agent?.maxInteractionTurns).toBe(5);
  });

  test("per-package routing.strategy override is applied", async () => {
    writeFileSync(join(tempDir, ".nax", "config.json"), JSON.stringify({ routing: { strategy: "keyword" } }));
    mkdirSync(join(tempDir, ".nax", "mono", "packages", "ml"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "mono", "packages", "ml", "config.json"),
      JSON.stringify({ routing: { strategy: "llm" } }),
    );

    const rootConfigPath = join(tempDir, ".nax", "config.json");
    const result = await loadConfigForWorkdir(rootConfigPath, "packages/ml");

    expect(result.routing?.strategy).toBe("llm");
  });

  // BUG-05: same gap for the legacy-rectification-key guard on the no-profile
  // path. `quality` is a mergeable (not root-only) section for per-package
  // overlays, so this key actually reaches the merged config, unlike
  // root-only sections such as autoMode.
  test("BUG-05: per-package overlay with no profile still rejects legacy quality.autofix.maxTotalAttempts", async () => {
    writeFileSync(join(tempDir, ".nax", "config.json"), JSON.stringify({}));
    mkdirSync(join(tempDir, ".nax", "mono", "packages", "api"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "mono", "packages", "api", "config.json"),
      JSON.stringify({ quality: { autofix: { maxTotalAttempts: 3 } } }),
    );

    const rootConfigPath = join(tempDir, ".nax", "config.json");
    await expect(loadConfigForWorkdir(rootConfigPath, "packages/api")).rejects.toThrow(
      /quality\.autofix\.maxTotalAttempts/,
    );
  });

  // nax#1990 fix round 1 — a root-level chained command must warn exactly
  // once across an entire run, not once per `loadConfigForWorkdir` call.
  // `loadConfigForWorkdir` is called once per package/story
  // (iteration-runner.ts, parallel-batch.ts, runner-completion.ts,
  // acceptance-setup.ts), and the root config load it wraps is cached per
  // `cacheKey` — but the per-package overlay validation used to re-run the
  // check against the ROOT-inherited value on every call, producing one
  // warning per story instead of one per run.
  describe("nax#1990 — quality.commands chain warning dedup across loadConfigForWorkdir calls", () => {
    async function captureWarnings(load: () => Promise<unknown>): Promise<string[]> {
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

    test("a root-level-only chained command warns exactly once across multiple package resolutions", async () => {
      writeFileSync(
        join(tempDir, ".nax", "config.json"),
        JSON.stringify({ quality: { commands: { typecheck: "tsc --noEmit && tsc -p tsconfig.test.json" } } }),
      );
      mkdirSync(join(tempDir, ".nax", "mono", "packages", "api"), { recursive: true });
      writeFileSync(
        join(tempDir, ".nax", "mono", "packages", "api", "config.json"),
        JSON.stringify({ routing: { strategy: "keyword" } }),
      );
      mkdirSync(join(tempDir, ".nax", "mono", "packages", "web"), { recursive: true });
      writeFileSync(
        join(tempDir, ".nax", "mono", "packages", "web", "config.json"),
        JSON.stringify({ routing: { strategy: "keyword" } }),
      );

      const rootConfigPath = join(tempDir, ".nax", "config.json");
      const captured = await captureWarnings(async () => {
        // Simulates a run resolving the same root-level chain across
        // several stories in several packages, as the real call sites do.
        await loadConfigForWorkdir(rootConfigPath, "packages/api");
        await loadConfigForWorkdir(rootConfigPath, "packages/api");
        await loadConfigForWorkdir(rootConfigPath, "packages/web");
      });

      const chainWarnings = captured.filter((msg) => msg.includes("quality.commands.typecheck"));
      expect(chainWarnings).toHaveLength(1);
    });

    test("a package-only chained command override is still caught", async () => {
      writeFileSync(
        join(tempDir, ".nax", "config.json"),
        JSON.stringify({ quality: { commands: { typecheck: "tsc --noEmit" } } }),
      );
      mkdirSync(join(tempDir, ".nax", "mono", "packages", "api"), { recursive: true });
      writeFileSync(
        join(tempDir, ".nax", "mono", "packages", "api", "config.json"),
        JSON.stringify({ quality: { commands: { lint: "biome check && biome format" } } }),
      );

      const rootConfigPath = join(tempDir, ".nax", "config.json");
      const captured = await captureWarnings(() => loadConfigForWorkdir(rootConfigPath, "packages/api"));

      const chainWarnings = captured.filter((msg) => msg.includes("quality.commands.lint"));
      expect(chainWarnings).toHaveLength(1);
    });

    test("a package profile's own chained command is still caught", async () => {
      writeFileSync(join(tempDir, ".nax", "config.json"), JSON.stringify({}));
      mkdirSync(join(tempDir, ".nax", "mono", "packages", "api"), { recursive: true });
      writeFileSync(join(tempDir, ".nax", "mono", "packages", "api", "config.json"), JSON.stringify({ profile: "ci" }));
      const profilesDir = join(tempDir, "packages", "api", ".nax", "profiles");
      mkdirSync(profilesDir, { recursive: true });
      writeFileSync(join(profilesDir, "ci.json"), JSON.stringify({ quality: { commands: { test: "a && b" } } }));

      const rootConfigPath = join(tempDir, ".nax", "config.json");
      const captured = await captureWarnings(() => loadConfigForWorkdir(rootConfigPath, "packages/api"));

      const chainWarnings = captured.filter((msg) => msg.includes("quality.commands.test"));
      expect(chainWarnings).toHaveLength(1);
    });
  });
});
