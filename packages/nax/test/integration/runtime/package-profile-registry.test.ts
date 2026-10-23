import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeNaxConfig, makeTempDir, makeTestRuntime } from "@test/helpers";
import { createConfigLoader, loadConfigForWorkdir } from "@/config";
import { _clearRootConfigCache } from "@/config/loader";
import { NaxError } from "@/errors";
import { resolveGateCommands } from "@/finish/gates/quality";
import { resolveGateCwd } from "@/operations/gate-cwd";
import { lintCheckOp } from "@/operations/lint-check";
import { createPackageRegistry } from "@/runtime/packages";

describe("package profile registry integration", () => {
  let repo: string;
  const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
  const originalProfile = process.env.NAX_PROFILE;
  const runtimes: ReturnType<typeof makeTestRuntime>[] = [];
  const root = () =>
    makeNaxConfig({
      quality: { commands: { lint: "true" } },
      execution: { iterationDelayMs: 0, sandbox: { enabled: true } },
    });
  beforeEach(async () => {
    repo = makeTempDir("package-profile-registry");
    process.env.NAX_GLOBAL_CONFIG_DIR = join(repo, "global");
    delete process.env.NAX_PROFILE;
    mkdirSync(join(repo, "packages/web"), { recursive: true });
    await Bun.write(join(repo, ".nax/config.json"), "{}");
    await Bun.write(join(repo, ".nax/mono/packages/api/config.json"), JSON.stringify({ profile: "package-checks" }));
    await Bun.write(
      join(repo, "packages/api/.nax/profiles/package-checks.json"),
      JSON.stringify({
        quality: { commands: { lint: "false" } },
        execution: { sandbox: { enabled: false } },
      }),
    );
  });
  afterEach(async () => {
    await Promise.all(runtimes.map((runtime) => runtime.close()));
    runtimes.length = 0;
    _clearRootConfigCache();
    cleanupTempDir(repo);
    if (originalGlobalDir === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
    else process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
    if (originalProfile === undefined) delete process.env.NAX_PROFILE;
    else process.env.NAX_PROFILE = originalProfile;
  });

  test("AC-11/13/18 hydrates profile commands, inherits absent overlay, and pins sandbox", async () => {
    const config = root();
    const registry = createPackageRegistry(createConfigLoader(config), repo);
    await registry.hydrate(["packages/api", "packages/web"]);
    const view = registry.resolve("packages/api");
    expect(view.config.quality.commands.lint).toBe("false");
    expect(view.overlay?.quality?.commands?.lint).toBe("false");
    expect(view.overlay?.execution?.sandbox?.enabled).toBe(false);
    expect(view.config.execution.sandbox?.enabled).toBe(true);
    expect(registry.resolve("packages/web").config.quality.commands.lint).toBe("true");
    expect(
      resolveGateCwd({ commandName: "lint", detected: false, packageView: view, workdir: join(repo, "packages/api") }),
    ).toEqual({ cwd: join(repo, "packages/api"), provenance: "overlay" });
  });

  test("AC-12 real lint runner fails for profile command", async () => {
    const config = root();
    const registry = createPackageRegistry(createConfigLoader(config), repo);
    await registry.hydrate(["packages/api"]);
    const runtime = makeTestRuntime({ config, workdir: repo });
    runtimes.push(runtime);
    const result = await lintCheckOp.execute(
      { workdir: join(repo, "packages/api"), storyId: "US-007" },
      {
        runtime,
        storyId: "US-007",
        packageDir: "packages/api",
        agentName: "native",
        packageView: registry.resolve("packages/api"),
      },
    );
    expect(result.success).toBe(false);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  test("AC-14/15 workdir loader retains profile result and metadata", async () => {
    const config = await loadConfigForWorkdir(join(repo, ".nax/config.json"), "packages/api");
    expect(config.quality.commands.lint).toBe("false");
    expect(config.profileChain).toEqual(["package-checks"]);
  });

  test.each([false, true])(
    "partial profiles preserve inherited smart test settings (overlay: %s)",
    async (withOverlay) => {
      const inherited = {
        enabled: false,
        fallback: "full-suite" as const,
        testFilePatterns: ["**/*.custom.ts"],
        maxScanFiles: 123,
      };
      const rootFields = {
        execution: { smartTestRunner: inherited },
        quality: { commands: { test: "root-test" } },
      };
      const config = makeNaxConfig(rootFields);
      await Bun.write(join(repo, ".nax/config.json"), JSON.stringify(rootFields));
      await Bun.write(
        join(repo, ".nax/mono/packages/api/config.json"),
        JSON.stringify({
          profile: "package-checks,scan-limit",
          ...(withOverlay
            ? { execution: { smartTestRunner: { ...inherited, testFilePatterns: ["**/*.overlay.ts"] } } }
            : {}),
        }),
      );
      await Bun.write(
        join(repo, "packages/api/.nax/profiles/scan-limit.json"),
        JSON.stringify({ execution: { smartTestRunner: { maxScanFiles: 42 } } }),
      );
      const registry = createPackageRegistry(createConfigLoader(config), repo);
      await registry.hydrate(["packages/api"]);
      const workdir = await loadConfigForWorkdir(join(repo, ".nax/config.json"), "packages/api");
      const expected = {
        ...inherited,
        maxScanFiles: 42,
        testFilePatterns: withOverlay ? ["**/*.overlay.ts"] : inherited.testFilePatterns,
      };
      expect(workdir.execution.smartTestRunner).toEqual(expected);
      expect(registry.resolve("packages/api").config.execution.smartTestRunner).toEqual(expected);
      expect(registry.resolve("packages/api").overlay?.quality?.commands?.test).toBeUndefined();
    },
  );

  test.each([false, true])(
    "profile quality commands bridge over inherited review commands (explicit: %s)",
    async (explicit) => {
      const config = makeNaxConfig({
        review: { commands: { test: "root-test", lint: "root-lint" } },
        quality: { commands: { lint: "root-quality-lint" } },
      });
      await Bun.write(
        join(repo, "packages/api/.nax/profiles/package-checks.json"),
        JSON.stringify({
          quality: { commands: { test: "package-test" } },
          ...(explicit ? { review: { commands: { test: "package-review-test" } } } : {}),
        }),
      );
      const registry = createPackageRegistry(createConfigLoader(config), repo);
      await registry.hydrate(["packages/api"]);
      const view = registry.resolve("packages/api");
      expect(view.config.review.commands.test).toBe(explicit ? "package-review-test" : "package-test");
      expect(view.config.review.commands.lint).toBe("root-lint");
      expect(view.overlay?.quality?.commands?.test).toBe("package-test");
      expect(config.review.commands.test).toBe("root-test");
    },
  );

  test("AC-16 hydration propagates missing profile NaxError", async () => {
    await Bun.write(join(repo, ".nax/mono/packages/api/config.json"), JSON.stringify({ profile: "missing" }));
    const registry = createPackageRegistry(createConfigLoader(root()), repo);
    const result = registry.hydrate(["packages/api"]);
    await expect(result).rejects.toBeInstanceOf(NaxError);
    await expect(result).rejects.toHaveProperty("code", "PROFILE_NOT_FOUND");
  });

  test("AC-17 finish resolves profile-only package lint command", async () => {
    const gates = await resolveGateCommands(repo, ["packages/api"]);
    expect(gates).toContainEqual({ name: "lint@packages/api", command: "false", cwd: join(repo, "packages/api") });
  });
});
