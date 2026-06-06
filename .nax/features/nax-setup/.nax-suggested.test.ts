import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { withTempDir } from "../../../test/helpers/temp";
import { makeTestRuntime } from "../../../test/helpers";
import type { NaxRuntime } from "../../../src/runtime";

// Package root is 3 levels above test file
const PKG_ROOT = join(import.meta.dir, "../../..");

// ─────────────────────────────────────────────────────────────────────────────
// SUGGESTED ACCEPTANCE CRITERIA (From PRD)
// ─────────────────────────────────────────────────────────────────────────────

// ═ US-001: Suggested Criteria ════════════════════════════════════════════════

describe("US-001: Suggested Criteria — Repo Analysis", () => {
  describe("AC-1: Empty workspace array yields single root package", () => {
    test("AC-1: analyzeRepo returns shape='single' with packages.length=1 when discoverWorkspacePackages returns empty", async () => {
      await withTempDir(async (dir) => {
        // Create minimal single-package repo
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify({ name: "my-pkg", scripts: { build: "bun build" } })
        );
        await Bun.write(join(dir, "bun.lock"), "");

        const { analyzeRepo, _analyzeRepoDeps } = await import(join(PKG_ROOT, "src/cli/setup-analyze"));

        // Override discoverWorkspacePackages to return empty array (edge case)
        const originalDiscover = _analyzeRepoDeps.discoverWorkspacePackages;
        _analyzeRepoDeps.discoverWorkspacePackages = async () => [];

        try {
          const result = await analyzeRepo(dir);

          // Must return single-package repo shape
          expect(result.shape).toBe("single");
          expect(result.packages).toHaveLength(1);

          // The single package must be the root with relativeDir="" (empty string for root)
          const root = result.packages[0];
          expect(root.relativeDir).toBe("");
          expect(root.testFilePatterns).toBeDefined();
          // testFramework may be undefined for packages without explicit framework detection
          expect("testFramework" in root).toBe(true);
          expect(root.missingScripts).toBeDefined();
          expect(Array.isArray(root.missingScripts)).toBe(true);
        } finally {
          _analyzeRepoDeps.discoverWorkspacePackages = originalDiscover;
        }
      });
    });
  });

  describe("AC-2: Package without package.json still included with empty scripts", () => {
    test("AC-2: analyzeRepo includes package lacking package.json with scripts={} in packages array", async () => {
      await withTempDir(async (dir) => {
        // Create monorepo structure
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify({ name: "root", workspaces: ["packages/missing-pkg"] })
        );
        await Bun.write(join(dir, "bun.lock"), "");
        // Do NOT create packages/missing-pkg/package.json — this is the test case

        const { analyzeRepo, _analyzeRepoDeps } = await import(join(PKG_ROOT, "src/cli/setup-analyze"));

        // Override workspace discovery to return the missing package
        const originalDiscover = _analyzeRepoDeps.discoverWorkspacePackages;
        _analyzeRepoDeps.discoverWorkspacePackages = async () => ["packages/missing-pkg"];

        try {
          const result = await analyzeRepo(dir);

          // Must detect as monorepo with one package
          expect(result.shape).toBe("mono");
          expect(result.packages).toHaveLength(1);

          // The missing package must still be in the analysis
          const missing = result.packages[0];
          expect(missing.relativeDir).toBe("packages/missing-pkg");
          expect(missing.testFilePatterns).toBeDefined();
          // testFramework may be undefined for packages without package.json — that's ok
          expect(missing.missingScripts).toBeDefined();
          expect(Array.isArray(missing.missingScripts)).toBe(true);
          // Key assertion: relativeDir and all mandatory fields are present or defined
          expect(missing.relativeDir).toBeTruthy();
          // All canonical scripts should be in missing scripts if package.json doesn't exist
          expect(missing.missingScripts.length).toBeGreaterThan(0);
        } finally {
          _analyzeRepoDeps.discoverWorkspacePackages = originalDiscover;
        }
      });
    });
  });
});

// ═ US-002: Suggested Criteria — LLM Setup Generation ════════════════════════

describe("US-002: Suggested Criteria — LLM Setup Generation", () => {
  let createdRuntimes: NaxRuntime[] = [];

  afterEach(async () => {
    await Promise.allSettled(createdRuntimes.map((r) => r.close()));
    createdRuntimes = [];
  });

  describe("AC-3: parseLLMJson extraction with narration", () => {
    test("AC-3: setupGenerateOp.parse extracts JSON from LLM output with narration via parseLLMJson", async () => {
      const { setupGenerateOp } = await import(join(PKG_ROOT, "src/operations/setup-generate"));

      const analysisInput = {
        shape: "single" as const,
        packages: [
          {
            relativeDir: ".",
            missingScripts: [],
            testFramework: undefined,
            testFilePatterns: [],
          },
        ],
        pmRunPrefix: "bun run",
        pmDlx: "bunx",
        orchestrator: "none" as const,
      };

      // Mock output with narration before and after JSON
      const mockOutput = `
        Here is the recommended configuration:
        \`\`\`json
        {
          "config": {
            "quality": { "commands": { "test": "bun test" } }
          }
        }
        \`\`\`
        This configuration includes all recommended quality gates.
      `;

      const runtime = makeTestRuntime();
      createdRuntimes.push(runtime);

      // Call parse — it should extract the JSON through parseLLMJson internally
      const result = setupGenerateOp.parse(mockOutput, analysisInput, { storyId: "US-002" } as any);

      expect(result.config).toBeDefined();
      expect(result.config.quality).toBeDefined();
      expect(result.config.quality.commands).toBeDefined();
      expect(result.config.quality.commands.test).toBe("bun test");
      expect(result.gaps).toBeDefined();
      expect(Array.isArray(result.gaps)).toBe(true);
    });
  });

  describe("AC-4: buildMonoConfigs excludes packages not in RepoAnalysis", () => {
    test("AC-4: buildMonoConfigs filters out monoConfigs entries for packages absent from RepoAnalysis", async () => {
      const { buildMonoConfigs } = await import(join(PKG_ROOT, "src/operations/setup-generate"));

      // RepoAnalysis with 2 packages
      const analysis = {
        shape: "mono" as const,
        packages: [
          { relativeDir: "packages/core", missingScripts: [], testFramework: undefined, testFilePatterns: [] },
          { relativeDir: "packages/ui", missingScripts: [], testFramework: undefined, testFilePatterns: [] },
        ],
        pmRunPrefix: "bun run",
        pmDlx: "bunx",
        orchestrator: "none" as const,
      };

      const result = buildMonoConfigs(analysis);

      // Must return exactly 2 monoConfigs, one per package in analysis
      expect(result).toHaveLength(2);
      expect(result[0].relativeDir).toBe("packages/core");
      expect(result[1].relativeDir).toBe("packages/ui");

      // Verify no spurious packages from outside the analysis are included
      const dirs = result.map((mc: any) => mc.relativeDir);
      expect(dirs).toContain("packages/core");
      expect(dirs).toContain("packages/ui");
      expect(dirs).not.toContain("packages/other");
      expect(dirs).not.toContain("packages/missing");
    });
  });
});

// ═ US-003: Suggested Criteria — CLI Command & Verification ═══════════════════

describe("US-003: Suggested Criteria — CLI Execution and Verification", () => {
  describe("AC-5: No viable verification gate → exit non-zero with diagnostic", () => {
    test("AC-5: setupCommand exits !== 0 when verification gate fails after config write", async () => {
      await withTempDir(async (dir) => {
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify({
            name: "test-pkg",
            scripts: { "type-check": "tsc --noEmit" }, // Has type-check
          })
        );
        await Bun.write(join(dir, "bun.lock"), "");

        const { setupCommand, _setupDeps } = await import(join(PKG_ROOT, "src/cli/setup"));
        const { NaxConfigSchema } = await import(join(PKG_ROOT, "src/config/schemas"));

        // Generate a valid plan
        const validConfig = NaxConfigSchema.parse({});
        const origGenerate = _setupDeps.generateSetupPlan;
        const origRunGate = _setupDeps.runGate;

        _setupDeps.generateSetupPlan = async (_analysis: any) => ({
          config: validConfig,
          monoConfigs: [],
          gaps: [],
        });

        // Make the verification gate return non-zero (simulating a failed gate)
        _setupDeps.runGate = async () => 1;

        try {
          const exitCode = await setupCommand({ dir });

          // Should propagate the gate's non-zero exit code
          expect(exitCode).not.toBe(0);
        } finally {
          _setupDeps.generateSetupPlan = origGenerate;
          _setupDeps.runGate = origRunGate;
        }
      });
    });
  });

  describe("AC-6: Dry-run on monorepo shows planned config", () => {
    test("AC-6: setupCommand --dry-run exits 0 and prints dry run message with root config to stdout", async () => {
      await withTempDir(async (dir) => {
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify({
            name: "root",
            workspaces: ["packages/core", "packages/ui"],
          })
        );
        await Bun.write(join(dir, "bun.lock"), "");
        await Bun.write(join(dir, "packages/core/package.json"), JSON.stringify({ name: "core" }));
        await Bun.write(join(dir, "packages/ui/package.json"), JSON.stringify({ name: "ui" }));

        const { setupCommand, _setupDeps } = await import(join(PKG_ROOT, "src/cli/setup"));
        const { NaxConfigSchema } = await import(join(PKG_ROOT, "src/config/schemas"));

        const validConfig = NaxConfigSchema.parse({});
        const capturedStdout: string[] = [];
        const origGenerate = _setupDeps.generateSetupPlan;
        const origStdout = _setupDeps.stdout;

        _setupDeps.generateSetupPlan = async (_analysis: any) => ({
          config: validConfig,
          monoConfigs: [
            { relativeDir: "packages/core", config: {} },
            { relativeDir: "packages/ui", config: {} },
          ],
          gaps: [],
        });

        _setupDeps.stdout = (msg: string) => { capturedStdout.push(msg); };

        try {
          const exitCode = await setupCommand({ dir, dryRun: true });
          expect(exitCode).toBe(0);

          const stdout = capturedStdout.join("\n");
          // Must indicate it's a dry run
          expect(stdout).toContain("Dry run");
          // Should include config details
          expect(stdout).toContain("config");
          // Should NOT create any files
          const naxDir = join(dir, ".nax");
          expect(await Bun.file(naxDir).exists()).toBe(false);
        } finally {
          _setupDeps.generateSetupPlan = origGenerate;
          _setupDeps.stdout = origStdout;
        }
      });
    });
  });
});

// ═ US-004: Suggested Criteria — Optional fill-scripts ═══════════════════════

describe("US-004: Suggested Criteria — fillScripts", () => {
  describe("AC-7: fillScripts preserves existing lint:fix script", () => {
    test("AC-7: fillScripts leaves existing scripts.lint:fix unchanged when script already present", async () => {
      await withTempDir(async (dir) => {
        const originalLintFixValue = "custom-lint-fix-command";
        const pkgPath = join(dir, "package.json");
        await Bun.write(
          pkgPath,
          JSON.stringify({
            name: "test",
            scripts: {
              build: "bun build",
              "lint:fix": originalLintFixValue, // Explicitly set lint:fix
            },
          })
        );

        const { fillScripts } = await import(join(PKG_ROOT, "src/cli/setup-fill"));

        await fillScripts(dir, {
          shape: "single",
          packages: [
            {
              relativeDir: ".",
              missingScripts: ["type-check", "lint:fix"], // lint:fix is "missing" per analysis
              testFramework: undefined,
              testFilePatterns: [],
            },
          ],
          pmRunPrefix: "bun run",
          pmDlx: "bunx",
          orchestrator: "none",
        });

        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

        // lint:fix should still have the original value
        expect(pkg.scripts["lint:fix"]).toBe(originalLintFixValue);
        // Other scripts should be preserved
        expect(pkg.scripts.build).toBe("bun build");
      });
    });
  });

  describe("AC-8: fillScripts doesn't create turbo.json if missing", () => {
    test("AC-8: fillScripts on monorepo root without turbo.json creates no new turbo.json file", async () => {
      await withTempDir(async (dir) => {
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify({
            name: "root",
            workspaces: ["packages/core"],
          })
        );
        await Bun.write(join(dir, "bun.lock"), "");
        await Bun.write(join(dir, "packages/core/package.json"), JSON.stringify({ name: "core" }));

        // Verify turbo.json doesn't exist initially
        const turboPath = join(dir, "turbo.json");
        expect(await Bun.file(turboPath).exists()).toBe(false);

        const { fillScripts } = await import(join(PKG_ROOT, "src/cli/setup-fill"));

        // Invoke fillScripts with mono shape and no turbo orchestrator
        await fillScripts(dir, {
          shape: "mono",
          packages: [
            {
              relativeDir: "packages/core",
              missingScripts: ["type-check"],
              testFramework: undefined,
              testFilePatterns: [],
            },
          ],
          pmRunPrefix: "bun run",
          pmDlx: "bunx",
          orchestrator: "none", // No turbo
        });

        // turbo.json should still not exist
        expect(await Bun.file(turboPath).exists()).toBe(false);

        // But package.json should have been updated with type-check
        const pkgPath = join(dir, "packages/core/package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        expect(pkg.scripts).toBeDefined();
      });
    });
  });
});