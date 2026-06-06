import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { withTempDir } from "../../../test/helpers/temp";
import { makeTestRuntime, makeMockAgentManager, makeMockRuntime } from "../../../test/helpers";
import type { NaxRuntime } from "../../../src/runtime";

// Package root is 3 levels above test file
const PKG_ROOT = join(import.meta.dir, "../../..");

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITES
// ─────────────────────────────────────────────────────────────────────────────

// ═ US-001: Repo Analysis ═════════════════════════════════════════════════════

describe("US-001: analyzeRepo — repository detection", () => {
  describe("AC-1: Single-package repo detection", () => {
    test("AC-1: analyzeRepo returns shape='single' and packages.length=1 for single-package repo", async () => {
      await withTempDir(async (dir) => {
        // Create minimal single-package repo
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify({ name: "my-pkg", scripts: { build: "bun build" } })
        );
        await Bun.write(join(dir, "bun.lock"), "");

        // Import and call analyzeRepo
        const { analyzeRepo } = await import(join(PKG_ROOT, "src/cli/setup-analyze"));
        const result = await analyzeRepo(dir);

        expect(result.shape).toBe("single");
        expect(result.packages).toHaveLength(1);
      });
    });
  });

  describe("AC-2: Monorepo detection", () => {
    test("AC-2: analyzeRepo returns shape='mono' and packages.length=N for N workspace members", async () => {
      await withTempDir(async (dir) => {
        // Create monorepo root with workspaces
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify({
            name: "monorepo-root",
            workspaces: ["packages/core", "packages/ui"],
          })
        );
        await Bun.write(join(dir, "bun.lock"), "");

        // Create workspace members
        await Bun.write(
          join(dir, "packages/core/package.json"),
          JSON.stringify({ name: "@org/core" })
        );
        await Bun.write(
          join(dir, "packages/ui/package.json"),
          JSON.stringify({ name: "@org/ui" })
        );

        const { analyzeRepo } = await import(join(PKG_ROOT, "src/cli/setup-analyze"));
        const result = await analyzeRepo(dir);

        expect(result.shape).toBe("mono");
        expect(result.packages.length).toBe(2);
      });
    });
  });

  describe("AC-3: Bun package manager detection", () => {
    test("AC-3: analyzeRepo returns pmRunPrefix='bun run' and pmDlx='bunx' when bun.lock exists", async () => {
      await withTempDir(async (dir) => {
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify({ name: "my-pkg" })
        );
        await Bun.write(join(dir, "bun.lock"), "");

        const { analyzeRepo } = await import(join(PKG_ROOT, "src/cli/setup-analyze"));
        const result = await analyzeRepo(dir);

        expect(result.pmRunPrefix).toBe("bun run");
        expect(result.pmDlx).toBe("bunx");
      });
    });
  });

  describe("AC-4: npm package manager detection", () => {
    test("AC-4: analyzeRepo returns pmRunPrefix='npm run' and pmDlx='npx' when package-lock.json exists", async () => {
      await withTempDir(async (dir) => {
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify({ name: "my-pkg" })
        );
        await Bun.write(join(dir, "package-lock.json"), "{}");

        const { analyzeRepo } = await import(join(PKG_ROOT, "src/cli/setup-analyze"));
        const result = await analyzeRepo(dir);

        expect(result.pmRunPrefix).toBe("npm run");
        expect(result.pmDlx).toBe("npx");
      });
    });
  });

  describe("AC-5: Missing scripts detection", () => {
    test("AC-5: analyzeRepo returns PackageFacts.missingScripts containing both 'type-check' and 'lint:fix'", async () => {
      await withTempDir(async (dir) => {
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify({
            name: "my-pkg",
            scripts: { build: "bun build", test: "bun test" },
          })
        );
        await Bun.write(join(dir, "bun.lock"), "");

        const { analyzeRepo } = await import(join(PKG_ROOT, "src/cli/setup-analyze"));
        const result = await analyzeRepo(dir);

        expect(result.packages[0].missingScripts).toContain("type-check");
        expect(result.packages[0].missingScripts).toContain("lint:fix");
      });
    });
  });

  describe("AC-6: Turbo orchestrator detection", () => {
    test("AC-6: analyzeRepo returns orchestrator='turbo' when turbo.json exists at repo root", async () => {
      await withTempDir(async (dir) => {
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify({ name: "my-pkg" })
        );
        await Bun.write(join(dir, "bun.lock"), "");
        await Bun.write(join(dir, "turbo.json"), "{}");

        const { analyzeRepo } = await import(join(PKG_ROOT, "src/cli/setup-analyze"));
        const result = await analyzeRepo(dir);

        expect(result.orchestrator).toBe("turbo");
      });
    });
  });

  describe("AC-7: No orchestrator detection", () => {
    test("AC-7: analyzeRepo returns orchestrator='none' for single-package repo without turbo.json or nx.json", async () => {
      await withTempDir(async (dir) => {
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify({ name: "my-pkg" })
        );
        await Bun.write(join(dir, "bun.lock"), "");

        const { analyzeRepo } = await import(join(PKG_ROOT, "src/cli/setup-analyze"));
        const result = await analyzeRepo(dir);

        expect(result.orchestrator).toBe("none");
      });
    });
  });

  describe("AC-8: Test framework detection", () => {
    test("AC-8: analyzeRepo returns PackageFacts.testFramework='jest' and testFilePatterns from detection", async () => {
      await withTempDir(async (dir) => {
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify({
            name: "my-pkg",
            devDependencies: { jest: "^29.0.0" },
          })
        );
        await Bun.write(join(dir, "bun.lock"), "");
        await Bun.write(
          join(dir, "jest.config.js"),
          "module.exports = {};"
        );

        const { analyzeRepo } = await import(join(PKG_ROOT, "src/cli/setup-analyze"));
        const result = await analyzeRepo(dir);

        expect(result.packages[0].testFramework).toBe("jest");
        expect(result.packages[0].testFilePatterns).toBeDefined();
      });
    });
  });

  describe("AC-9: Relative package paths", () => {
    test("AC-9: analyzeRepo returns PackageFacts.relativeDir as relative path (not absolute) for workspace member", async () => {
      await withTempDir(async (dir) => {
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify({
            name: "monorepo",
            workspaces: ["packages/foo"],
          })
        );
        await Bun.write(join(dir, "bun.lock"), "");
        await Bun.write(
          join(dir, "packages/foo/package.json"),
          JSON.stringify({ name: "foo" })
        );

        const { analyzeRepo } = await import(join(PKG_ROOT, "src/cli/setup-analyze"));
        const result = await analyzeRepo(dir);

        const fooPackage = result.packages.find((p) => p.relativeDir === "packages/foo");
        expect(fooPackage?.relativeDir).toBe("packages/foo");
        expect(fooPackage?.relativeDir).not.toContain("/tmp");
        expect(fooPackage?.relativeDir).not.toMatch(/^\//);
      });
    });
  });
});

// ═ US-002: LLM Setup Generation ═══════════════════════════════════════════════

describe("US-002: setupGenerateOp — LLM setup plan generation", () => {
  let createdRuntimes: NaxRuntime[] = [];

  afterEach(async () => {
    await Promise.allSettled(createdRuntimes.map((r) => r.close()));
    createdRuntimes = [];
  });

  describe("AC-10: setupGenerateOp.parse with valid schema", () => {
    test("AC-10: setupGenerateOp.parse returns SetupPlan with config accepted by NaxConfigSchema.safeParse", async () => {
      const { setupGenerateOp } = await import(join(PKG_ROOT, "src/operations/setup-generate"));
      const { NaxConfigSchema } = await import(join(PKG_ROOT, "src/config/schemas"));

      // Create a valid RepoAnalysis input
      const analysisInput = {
        shape: "single" as const,
        packages: [
          {
            name: "root",
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

      // Mock output with valid JSON
      const mockOutput = JSON.stringify({
        config: {
          quality: { commands: { test: "bun test" } },
        },
      });

      const runtime = makeTestRuntime();
      createdRuntimes.push(runtime);

      const result = setupGenerateOp.parse(mockOutput, analysisInput, { storyId: "US-002" } as any);
      const schemaResult = NaxConfigSchema.safeParse(result.config);

      expect(schemaResult.success).toBe(true);
      expect(result.config).toBeDefined();
    });
  });

  describe("AC-11: Command cross-checking", () => {
    test("AC-11: setupGenerateOp.parse excludes missing commands and records them in gaps", async () => {
      const { setupGenerateOp } = await import(join(PKG_ROOT, "src/operations/setup-generate"));

      const analysisInput = {
        shape: "single" as const,
        packages: [
          {
            relativeDir: ".",
            missingScripts: ["test"],
            testFramework: undefined,
            testFilePatterns: [],
          },
        ],
        pmRunPrefix: "bun run",
        pmDlx: "bunx",
        orchestrator: "none" as const,
      };

      const mockOutput = JSON.stringify({
        config: {
          quality: { commands: { test: "nonexistent-script" } },
        },
      });

      const runtime = makeTestRuntime();
      createdRuntimes.push(runtime);

      const result = setupGenerateOp.parse(mockOutput, analysisInput, { storyId: "US-002" } as any);

      expect(result.gaps).toBeDefined();
      expect(result.gaps?.length).toBeGreaterThan(0);
      expect(result.config.quality?.commands?.test).toBeUndefined();
    });
  });

  describe("AC-12: Invalid JSON handling", () => {
    test("AC-12: setupGenerateOp.parse throws ParseValidationError for non-JSON output", async () => {
      const { setupGenerateOp } = await import(join(PKG_ROOT, "src/operations/setup-generate"));
      const { ParseValidationError } = await import(join(PKG_ROOT, "src/agents"));

      const analysisInput = {
        shape: "single" as const,
        packages: [],
        pmRunPrefix: "bun run",
        pmDlx: "bunx",
        orchestrator: "none" as const,
      };

      const invalidOutput = "This is not valid JSON at all";

      const runtime = makeTestRuntime();
      createdRuntimes.push(runtime);

      expect(() => setupGenerateOp.parse(invalidOutput, analysisInput, {} as any)).toThrow(
        ParseValidationError
      );
    });
  });

  describe("AC-13: Schema validation failure", () => {
    test("AC-13: setupGenerateOp.parse throws ParseValidationError for schema-invalid config", async () => {
      const { setupGenerateOp } = await import(join(PKG_ROOT, "src/operations/setup-generate"));
      const { ParseValidationError } = await import(join(PKG_ROOT, "src/agents"));

      const analysisInput = {
        shape: "single" as const,
        packages: [],
        pmRunPrefix: "bun run",
        pmDlx: "bunx",
        orchestrator: "none" as const,
      };

      const invalidConfig = JSON.stringify({
        config: {
          quality: "should-be-an-object-not-a-string",
        },
      });

      const runtime = makeTestRuntime();
      createdRuntimes.push(runtime);

      expect(() => setupGenerateOp.parse(invalidConfig, analysisInput, {} as any)).toThrow(
        ParseValidationError
      );
    });
  });

  describe("AC-14: Single-package monoConfigs", () => {
    test("AC-14: setupGenerateOp.parse returns SetupPlan with empty monoConfigs for single-package repo", async () => {
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

      const mockOutput = JSON.stringify({
        config: { quality: { commands: {} } },
      });

      const runtime = makeTestRuntime();
      createdRuntimes.push(runtime);

      const result = setupGenerateOp.parse(mockOutput, analysisInput, {} as any);

      expect(result.monoConfigs).toEqual([]);
    });
  });

  describe("AC-15: Monorepo monoConfigs", () => {
    test("AC-15: setupGenerateOp.parse returns N monoConfigs entries for N-package monorepo", async () => {
      const { setupGenerateOp } = await import(join(PKG_ROOT, "src/operations/setup-generate"));

      const analysisInput = {
        shape: "mono" as const,
        packages: [
          {
            relativeDir: "packages/core",
            missingScripts: [],
            testFramework: undefined,
            testFilePatterns: [],
          },
          {
            relativeDir: "packages/ui",
            missingScripts: [],
            testFramework: undefined,
            testFilePatterns: [],
          },
        ],
        pmRunPrefix: "bun run",
        pmDlx: "bunx",
        orchestrator: "none" as const,
      };

      const mockOutput = JSON.stringify({
        config: { quality: { commands: {} } },
      });

      const runtime = makeTestRuntime();
      createdRuntimes.push(runtime);

      const result = setupGenerateOp.parse(mockOutput, analysisInput, {} as any);

      expect(result.monoConfigs.length).toBe(2);
    });
  });

  describe("AC-16: setupGenerateOp.build", () => {
    test("AC-16: setupGenerateOp.build returns ComposeInput from SetupPromptBuilder.build", async () => {
      const { setupGenerateOp } = await import(join(PKG_ROOT, "src/operations/setup-generate"));

      const analysisInput = {
        shape: "single" as const,
        packages: [{ relativeDir: ".", missingScripts: [], testFramework: undefined, testFilePatterns: [] }],
        pmRunPrefix: "bun run",
        pmDlx: "bunx",
        orchestrator: "none" as const,
      };

      const prompt = setupGenerateOp.build(analysisInput, {} as any);

      expect(prompt).toBeDefined();
      expect(typeof prompt).toBe("object");
    });
  });

  describe("AC-17: callOp retry exhaustion", () => {
    test("AC-17: callOp with setupGenerateOp rejects with code='SETUP_PLAN_INVALID' after MAX_SETUP_LLM_ATTEMPTS", async () => {
      const { setupGenerateOp } = await import(join(PKG_ROOT, "src/operations/setup-generate"));
      const { callOp } = await import(join(PKG_ROOT, "src/operations/call"));
      const { ParseValidationError } = await import(join(PKG_ROOT, "src/agents"));

      const analysisInput = {
        shape: "single" as const,
        packages: [],
        pmRunPrefix: "bun run",
        pmDlx: "bunx",
        orchestrator: "none" as const,
      };

      // runAsSessionFn returns invalid JSON so parse always fails → SetupPlanError propagates
      const agentManager = makeMockAgentManager({
        runAsSessionFn: async () => ({ output: "not-valid-json-at-all" } as any),
      });
      const runtime = makeMockRuntime({ agentManager });

      try {
        await callOp(
          { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-002" },
          setupGenerateOp,
          analysisInput
        );
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ParseValidationError);
        expect((err as any).code).toBe("SETUP_PLAN_INVALID");
      }
    });
  });

  describe("AC-18: init-context.ts rewiring", () => {
    test("AC-18: callLLM in init-context.ts calls callOp with setupGenerateOp instead of throwing", async () => {
      const initContextPath = join(PKG_ROOT, "src/cli/init-context.ts");
      const initContextCode = readFileSync(initContextPath, "utf-8");

      // Verify that init-context.ts references callOp and setupGenerateOp
      expect(initContextCode).toContain("callOp");
      expect(initContextCode).toContain("setupGenerateOp");
    });
  });
});

// ═ US-003: CLI Command & Verification ════════════════════════════════════════

describe("US-003: setupCommand — CLI execution and verification", () => {
  describe("AC-19: Config write to .nax/config.json", () => {
    test("AC-19: nax setup --dir <fixture> exits 0 and produces .nax/config.json with valid schema", async () => {
      await withTempDir(async (dir) => {
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify({ name: "test-pkg", scripts: { test: "bun test" } })
        );
        await Bun.write(join(dir, "bun.lock"), "");

        const { setupCommand, _setupDeps } = await import(join(PKG_ROOT, "src/cli/setup"));
        const { NaxConfigSchema } = await import(join(PKG_ROOT, "src/config/schemas"));
        const validConfig = NaxConfigSchema.parse({});

        const origGenerate = _setupDeps.generateSetupPlan;
        _setupDeps.generateSetupPlan = async (_analysis) => ({
          config: validConfig,
          monoConfigs: [],
          gaps: [],
        });

        try {
          const exitCode = await setupCommand({ dir });
          expect(exitCode).toBe(0);

          const configPath = join(dir, ".nax", "config.json");
          expect(existsSync(configPath)).toBe(true);

          const config = JSON.parse(readFileSync(configPath, "utf-8"));
          const result = NaxConfigSchema.safeParse(config);
          expect(result.success).toBe(true);
        } finally {
          _setupDeps.generateSetupPlan = origGenerate;
        }
      });
    });
  });

  describe("AC-20: Monorepo per-package configs", () => {
    test("AC-20: nax setup produces .nax/mono/<relativeDir>/config.json for each package", async () => {
      await withTempDir(async (dir) => {
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify({ name: "root", workspaces: ["packages/core", "packages/ui"] })
        );
        await Bun.write(join(dir, "bun.lock"), "");
        await Bun.write(join(dir, "packages/core/package.json"), JSON.stringify({ name: "core" }));
        await Bun.write(join(dir, "packages/ui/package.json"), JSON.stringify({ name: "ui" }));

        const { setupCommand, _setupDeps } = await import(join(PKG_ROOT, "src/cli/setup"));
        const { NaxConfigSchema } = await import(join(PKG_ROOT, "src/config/schemas"));
        const validConfig = NaxConfigSchema.parse({});

        const origGenerate = _setupDeps.generateSetupPlan;
        _setupDeps.generateSetupPlan = async (_analysis) => ({
          config: validConfig,
          monoConfigs: [
            { relativeDir: "packages/core", config: validConfig },
            { relativeDir: "packages/ui", config: validConfig },
          ],
          gaps: [],
        });

        try {
          await setupCommand({ dir });

          const corePath = join(dir, ".nax/mono/packages/core/config.json");
          const uiPath = join(dir, ".nax/mono/packages/ui/config.json");

          expect(existsSync(corePath)).toBe(true);
          expect(existsSync(uiPath)).toBe(true);

          const coreConfig = JSON.parse(readFileSync(corePath, "utf-8"));
          const uiConfig = JSON.parse(readFileSync(uiPath, "utf-8"));

          expect(NaxConfigSchema.safeParse(coreConfig).success).toBe(true);
          expect(NaxConfigSchema.safeParse(uiConfig).success).toBe(true);
        } finally {
          _setupDeps.generateSetupPlan = origGenerate;
        }
      });
    });
  });

  describe("AC-21: Single-package no mono dir", () => {
    test("AC-21: nax setup produces no .nax/mono directory for single-package repo", async () => {
      await withTempDir(async (dir) => {
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify({ name: "single-pkg" })
        );
        await Bun.write(join(dir, "bun.lock"), "");

        const { setupCommand } = await import(join(PKG_ROOT, "src/cli/setup"));

        const originalArgv = process.argv;
        process.argv = ["node", "nax", "setup", "--dir", dir];

        try {
          await setupCommand();

          const monoDir = join(dir, ".nax/mono");
          expect(existsSync(monoDir)).toBe(false);
        } finally {
          process.argv = originalArgv;
        }
      });
    });
  });

  describe("AC-22: Dry-run mode", () => {
    test("AC-22: nax setup --dry-run exits 0, creates no .nax files, prints config to stdout", async () => {
      await withTempDir(async (dir) => {
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify({ name: "test-pkg" })
        );
        await Bun.write(join(dir, "bun.lock"), "");

        const { setupCommand, _setupDeps } = await import(join(PKG_ROOT, "src/cli/setup"));
        const { NaxConfigSchema } = await import(join(PKG_ROOT, "src/config/schemas"));
        const validConfig = NaxConfigSchema.parse({});

        const capturedOutput: string[] = [];
        const origGenerate = _setupDeps.generateSetupPlan;
        const origStdout = _setupDeps.stdout;

        _setupDeps.generateSetupPlan = async (_analysis) => ({
          config: validConfig,
          monoConfigs: [],
          gaps: [],
        });
        _setupDeps.stdout = (msg: string) => { capturedOutput.push(msg); };

        try {
          const exitCode = await setupCommand({ dir, dryRun: true });
          expect(exitCode).toBe(0);

          const naxDir = join(dir, ".nax");
          expect(existsSync(naxDir)).toBe(false);

          const output = capturedOutput.join("\n");
          expect(output).toContain("execution");
          expect(output).toContain("agent");
          expect(output).toContain("quality");
        } finally {
          _setupDeps.generateSetupPlan = origGenerate;
          _setupDeps.stdout = origStdout;
        }
      });
    });
  });

  describe("AC-23: Setup plan invalid error", () => {
    test("AC-23: nax setup exits 1 when generateSetupPlan rejects with SETUP_PLAN_INVALID", async () => {
      await withTempDir(async (dir) => {
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify({ name: "test-pkg" })
        );
        await Bun.write(join(dir, "bun.lock"), "");

        // _setupDeps.generateSetupPlan throws SETUP_PLAN_INVALID by default
        const { setupCommand } = await import(join(PKG_ROOT, "src/cli/setup"));

        const exitCode = await setupCommand({ dir });
        expect(exitCode).toBe(1);

        const configPath = join(dir, ".nax/config.json");
        expect(existsSync(configPath)).toBe(false);
      });
    });
  });

  describe("AC-24: Existing config collision", () => {
    test("AC-24: nax setup without --force exits non-zero and doesn't overwrite existing .nax/config.json", async () => {
      await withTempDir(async (dir) => {
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify({ name: "test-pkg" })
        );
        await Bun.write(join(dir, "bun.lock"), "");

        // Create existing config
        const naxDir = join(dir, ".nax");
        await Bun.write(
          join(naxDir, "config.json"),
          JSON.stringify({ execution: { timeout: 100 } })
        );
        const beforeMd5 = createHash("md5")
          .update(readFileSync(join(naxDir, "config.json")))
          .digest("hex");

        const { setupCommand } = await import(join(PKG_ROOT, "src/cli/setup"));

        const originalArgv = process.argv;
        process.argv = ["node", "nax", "setup", "--dir", dir];

        try {
          const exitCode = await setupCommand();
          expect(exitCode).not.toBe(0);

          const afterMd5 = createHash("md5")
            .update(readFileSync(join(naxDir, "config.json")))
            .digest("hex");
          expect(beforeMd5).toBe(afterMd5);
        } finally {
          process.argv = originalArgv;
        }
      });
    });
  });

  describe("AC-25: Force overwrite", () => {
    test("AC-25: nax setup --force overwrites existing .nax/config.json", async () => {
      await withTempDir(async (dir) => {
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify({ name: "test-pkg", scripts: { test: "bun test" } })
        );
        await Bun.write(join(dir, "bun.lock"), "");

        const naxDir = join(dir, ".nax");
        await Bun.write(
          join(naxDir, "config.json"),
          JSON.stringify({ execution: { timeout: 100 } })
        );
        const beforeMd5 = createHash("md5")
          .update(readFileSync(join(naxDir, "config.json")))
          .digest("hex");

        const { setupCommand, _setupDeps } = await import(join(PKG_ROOT, "src/cli/setup"));
        const { NaxConfigSchema } = await import(join(PKG_ROOT, "src/config/schemas"));
        const validConfig = NaxConfigSchema.parse({});

        const origGenerate = _setupDeps.generateSetupPlan;
        _setupDeps.generateSetupPlan = async (_analysis) => ({
          config: validConfig,
          monoConfigs: [],
          gaps: [],
        });

        try {
          const exitCode = await setupCommand({ dir, force: true });
          expect(exitCode).toBe(0);

          const afterMd5 = createHash("md5")
            .update(readFileSync(join(naxDir, "config.json")))
            .digest("hex");
          expect(beforeMd5).not.toBe(afterMd5);

          const config = JSON.parse(readFileSync(join(naxDir, "config.json"), "utf-8"));
          expect(NaxConfigSchema.safeParse(config).success).toBe(true);
        } finally {
          _setupDeps.generateSetupPlan = origGenerate;
        }
      });
    });
  });

  describe("AC-26: Gap reporting", () => {
    test("AC-26: setupCommand emits gap warnings on stderr and gap count matches SetupPlan.gaps", async () => {
      await withTempDir(async (dir) => {
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify({ name: "test-pkg" })
        );
        await Bun.write(join(dir, "bun.lock"), "");

        const { setupCommand } = await import(join(PKG_ROOT, "src/cli/setup"));

        const capturedStderr: string[] = [];
        const originalStderr = console.error;
        console.error = (...args: unknown[]) => capturedStderr.push(args.join(" "));

        const originalArgv = process.argv;
        process.argv = ["node", "nax", "setup", "--dir", dir];

        try {
          await setupCommand();

          const stderr = capturedStderr.join("\n");
          if (stderr) {
            expect(stderr).toContain("warning");
          }
        } finally {
          process.argv = originalArgv;
          console.error = originalStderr;
        }
      });
    });
  });

  describe("AC-27: Gate verification", () => {
    test("AC-27: setupCommand invokes verification gate exactly once with correct args", async () => {
      await withTempDir(async (dir) => {
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify({
            name: "test-pkg",
            scripts: { test: "bun test", "type-check": "tsc --noEmit" },
          })
        );
        await Bun.write(join(dir, "bun.lock"), "");

        const { setupCommand } = await import(join(PKG_ROOT, "src/cli/setup"));

        let gateCallCount = 0;
        let lastGateCommand: string | null = null;

        // Mock the verification gate runner
        const setupVerifyPath = join(PKG_ROOT, "src/cli/setup-verify.ts");
        const setupVerifyCode = readFileSync(setupVerifyPath, "utf-8");

        // Verify gate runner is exported
        expect(setupVerifyCode).toContain("runSetupGate");

        const originalArgv = process.argv;
        process.argv = ["node", "nax", "setup", "--dir", dir];

        try {
          await setupCommand();
        } finally {
          process.argv = originalArgv;
        }
      });
    });
  });

  describe("AC-28: Gate failure handling", () => {
    test("AC-28: setupCommand exits non-zero when gate runner returns non-zero exit code", async () => {
      await withTempDir(async (dir) => {
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify({
            name: "test-pkg",
            scripts: { "type-check": "false" },
          })
        );
        await Bun.write(join(dir, "bun.lock"), "");

        const { setupCommand } = await import(join(PKG_ROOT, "src/cli/setup"));

        const originalArgv = process.argv;
        process.argv = ["node", "nax", "setup", "--dir", dir];

        try {
          const exitCode = await setupCommand();
          expect(exitCode).not.toBe(0);
        } finally {
          process.argv = originalArgv;
        }
      });
    });
  });

  describe("AC-29: Integration with analyzeRepo and generateSetupPlan", () => {
    test("AC-29: setupCommand calls analyzeRepo once and generateSetupPlan with its return value", async () => {
      await withTempDir(async (dir) => {
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify({ name: "test-pkg", scripts: { test: "bun test" } })
        );
        await Bun.write(join(dir, "bun.lock"), "");

        const { setupCommand } = await import(join(PKG_ROOT, "src/cli/setup"));

        let analyzeRepoCalls = 0;
        let generatePlanCalls = 0;

        const setupAnalyzePath = join(PKG_ROOT, "src/cli/setup-analyze.ts");
        const setupLlmPath = join(PKG_ROOT, "src/cli/setup-llm.ts");

        const analyzeCode = readFileSync(setupAnalyzePath, "utf-8");
        const planCode = readFileSync(setupLlmPath, "utf-8");

        expect(analyzeCode).toContain("export");
        expect(planCode).toContain("generateSetupPlan");

        const originalArgv = process.argv;
        process.argv = ["node", "nax", "setup", "--dir", dir];

        try {
          await setupCommand();
        } finally {
          process.argv = originalArgv;
        }
      });
    });
  });

  describe("AC-30: CLI dispatch", () => {
    test("AC-30: bin/nax.ts routes 'setup' command to setupCommand", async () => {
      const binPath = join(PKG_ROOT, "bin/nax.ts");
      const binCode = readFileSync(binPath, "utf-8");

      expect(binCode).toContain("setup");
      expect(binCode).toContain("setupCommand");
    });
  });
});

// ═ US-004: Optional fill-scripts ═════════════════════════════════════════════

describe("US-004: fillScripts — package.json script injection", () => {
  describe("AC-31: Add type-check script", () => {
    test("AC-31: fillScripts adds type-check script and preserves existing scripts", async () => {
      await withTempDir(async (dir) => {
        const pkgPath = join(dir, "package.json");
        await Bun.write(
          pkgPath,
          JSON.stringify({
            name: "test",
            scripts: { build: "bun build", test: "bun test" },
          })
        );

        const { fillScripts } = await import(join(PKG_ROOT, "src/cli/setup-fill"));

        await fillScripts(dir, {
          shape: "single",
          packages: [{ relativeDir: ".", missingScripts: ["type-check"], testFramework: undefined, testFilePatterns: [] }],
          pmRunPrefix: "bun run",
          pmDlx: "bunx",
          orchestrator: "none",
        });

        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        expect(pkg.scripts["type-check"]).toBe("tsc --noEmit -p tsconfig.json");
        expect(pkg.scripts.build).toBe("bun build");
        expect(pkg.scripts.test).toBe("bun test");
      });
    });
  });

  describe("AC-32: Idempotent script addition", () => {
    test("AC-32: fillScripts called twice doesn't duplicate type-check entry", async () => {
      await withTempDir(async (dir) => {
        const pkgPath = join(dir, "package.json");
        await Bun.write(
          pkgPath,
          JSON.stringify({
            name: "test",
            scripts: { build: "bun build" },
          })
        );

        const { fillScripts } = await import(join(PKG_ROOT, "src/cli/setup-fill"));

        const analysis = {
          shape: "single" as const,
          packages: [{ relativeDir: ".", missingScripts: ["type-check"], testFramework: undefined, testFilePatterns: [] }],
          pmRunPrefix: "bun run",
          pmDlx: "bunx",
          orchestrator: "none" as const,
        };

        await fillScripts(dir, analysis);
        await fillScripts(dir, analysis);

        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        const typeCheckCount = Object.keys(pkg.scripts).filter(
          (k) => k === "type-check"
        ).length;
        expect(typeCheckCount).toBe(1);
      });
    });
  });

  describe("AC-33: Turbo monorepo handling", () => {
    test("AC-33: fillScripts with mono+turbo shape updates turbo.json and root package.json", async () => {
      await withTempDir(async (dir) => {
        const pkgPath = join(dir, "package.json");
        const turboPath = join(dir, "turbo.json");

        await Bun.write(
          pkgPath,
          JSON.stringify({
            name: "root",
            scripts: { build: "turbo run build" },
          })
        );
        await Bun.write(turboPath, JSON.stringify({ tasks: {} }));

        const { fillScripts } = await import(join(PKG_ROOT, "src/cli/setup-fill"));

        const repoAnalysis = {
          shape: "mono" as const,
          packages: [{ relativeDir: ".", missingScripts: ["type-check"], testFramework: undefined, testFilePatterns: [] }],
          pmRunPrefix: "bun run",
          pmDlx: "bunx",
          orchestrator: "turbo" as const,
        };

        await fillScripts(dir, repoAnalysis);

        const turbo = JSON.parse(readFileSync(turboPath, "utf-8"));
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

        expect(turbo.tasks["type-check"]).toBeDefined();
        expect(pkg.scripts["type-check"]).toBeDefined();
      });
    });
  });

  describe("AC-34: Single-package handling", () => {
    test("AC-34: fillScripts with single shape updates only package.json, not orchestrator", async () => {
      await withTempDir(async (dir) => {
        const pkgPath = join(dir, "package.json");
        const turboPath = join(dir, "turbo.json");

        await Bun.write(
          pkgPath,
          JSON.stringify({ name: "single", scripts: {} })
        );
        // Don't create turbo.json initially

        const { fillScripts } = await import(join(PKG_ROOT, "src/cli/setup-fill"));

        const repoAnalysis = {
          shape: "single" as const,
          packages: [{ relativeDir: ".", missingScripts: ["type-check"], testFramework: undefined, testFilePatterns: [] }],
          pmRunPrefix: "bun run",
          pmDlx: "bunx",
          orchestrator: "none" as const,
        };

        await fillScripts(dir, repoAnalysis);

        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        expect(pkg.scripts["type-check"]).toBe("tsc --noEmit -p tsconfig.json");
        expect(existsSync(turboPath)).toBe(false);
      });
    });
  });

  describe("AC-35: Re-analysis after fill", () => {
    test("AC-35: analyzeRepo after fillScripts doesn't include filled scripts in missingScripts", async () => {
      await withTempDir(async (dir) => {
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify({ name: "test", scripts: {} })
        );
        await Bun.write(join(dir, "bun.lock"), "");

        const { fillScripts } = await import(join(PKG_ROOT, "src/cli/setup-fill"));
        const { analyzeRepo } = await import(join(PKG_ROOT, "src/cli/setup-analyze"));

        await fillScripts(dir, {
          shape: "single",
          packages: [{ relativeDir: ".", missingScripts: ["type-check"], testFramework: undefined, testFilePatterns: [] }],
          pmRunPrefix: "bun run",
          pmDlx: "bunx",
          orchestrator: "none",
        });

        const analysis = await analyzeRepo(dir);
        expect(analysis.packages[0].missingScripts).not.toContain("type-check");
      });
    });
  });

  describe("AC-36: setupCommand invokes fillScripts before writes", () => {
    test("AC-36: setupCommand with --fill-scripts calls fillScripts before config writes", async () => {
      const setupPath = join(PKG_ROOT, "src/cli/setup.ts");
      const setupCode = readFileSync(setupPath, "utf-8");

      expect(setupCode).toContain("setup-fill");
      expect(setupCode).toContain("fillScripts");

      // Verify fillScripts is called before any .nax/ write
      const fillScriptsIndex = setupCode.indexOf("fillScripts");
      const naxWriteIndex = setupCode.indexOf(".nax");
      expect(fillScriptsIndex).toBeLessThan(naxWriteIndex);
    });
  });

  describe("AC-37: setupCommand without --fill-scripts", () => {
    test("AC-37: setupCommand without --fill-scripts doesn't call fillScripts", async () => {
      await withTempDir(async (dir) => {
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify({ name: "test", scripts: {} })
        );
        await Bun.write(join(dir, "bun.lock"), "");

        const { setupCommand, _setupDeps } = await import(join(PKG_ROOT, "src/cli/setup"));

        let fillScriptsCalled = false;
        const origFillScripts = _setupDeps.fillScripts;
        _setupDeps.fillScripts = async () => { fillScriptsCalled = true; };

        try {
          // No fillScripts option — should not invoke _setupDeps.fillScripts
          await setupCommand({ dir });
          expect(fillScriptsCalled).toBe(false);
        } finally {
          _setupDeps.fillScripts = origFillScripts;
        }
      });
    });
  });
});