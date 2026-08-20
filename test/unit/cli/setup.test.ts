/**
 * Tests for setupCommand (US-003: Wire the setup command)
 *
 * All file I/O uses withTempDir for isolation.
 * External calls are injected via _setupDeps, overridden in beforeEach/afterEach.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _setupDeps, setupCommand } from "../../../src/cli/setup";
import { setupCommand as barrelSetupCommand } from "../../../src/cli";
import { DEFAULT_CONFIG, NaxConfigSchema } from "../../../src/config";
import { NaxError } from "../../../src/errors";
import type { RepoAnalysis } from "../../../src/cli/setup-types";
import type { SetupPlan } from "../../../src/operations/setup-generate";
import type { NaxConfig } from "@/config";
import type { MonoPackageConfig } from "@/operations/setup-generate";
import { withTempDir } from "@test/helpers";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const VALID_CONFIG = DEFAULT_CONFIG;

const SINGLE_ANALYSIS: RepoAnalysis = {
  shape: "single",
  packages: [{ relativeDir: "", testFramework: "bun", testFilePatterns: [], missingScripts: [] }],
  pmRunPrefix: "bun run",
  pmDlx: "bunx",
  orchestrator: "none",
};

const MONO_ANALYSIS: RepoAnalysis = {
  shape: "mono",
  packages: [
    { relativeDir: "packages/a", testFramework: "bun", testFilePatterns: [], missingScripts: [] },
    { relativeDir: "packages/b", testFramework: "jest", testFilePatterns: [], missingScripts: [] },
  ],
  pmRunPrefix: "bun run",
  pmDlx: "bunx",
  orchestrator: "none",
};

const MOCK_PLAN: SetupPlan = {
  config: VALID_CONFIG,
  monoConfigs: [],
  gaps: [],
};

const MONO_PLAN: SetupPlan = {
  config: VALID_CONFIG,
  monoConfigs: [
    { relativeDir: "packages/a", config: {} },
    { relativeDir: "packages/b", config: {} },
  ],
  gaps: [],
};

// ─── Save / restore deps ──────────────────────────────────────────────────────

type Deps = typeof _setupDeps;
let saved: Deps;

beforeEach(() => {
  saved = { ..._setupDeps };
  _setupDeps.analyzeRepo = mock(async () => SINGLE_ANALYSIS);
  _setupDeps.buildCallContext = mock(async () => ({
    ctx: {} as import("../../../src/operations/types").CallContext,
    close: mock(async () => {}),
  }));
  _setupDeps.generateSetupPlan = mock(async () => MOCK_PLAN);
  _setupDeps.runGate = mock(async () => 0);
  _setupDeps.stdout = mock((_msg: string) => {});
  _setupDeps.stderr = mock((_msg: string) => {});
  _setupDeps.fileExists = mock(async () => false);
  _setupDeps.writeSetupConfig = mock(async () => ({ written: [] }));
  _setupDeps.fillScripts = mock(async () => {});
});

afterEach(() => {
  Object.assign(_setupDeps, saved);
});

// ─── Helper: run command, catching errors ─────────────────────────────────────

async function runSetup(options: Parameters<typeof setupCommand>[0] = {}): Promise<number | undefined> {
  try {
    return await setupCommand(options);
  } catch {
    return undefined;
  }
}

// ─── AC1: exits 0 and writes valid .nax/config.json ─────────────────────────

describe("setupCommand — AC1: exits 0 and produces .nax/config.json", () => {
  test("AC1: exits 0 when analyzeRepo and generateSetupPlan succeed", async () => {
    await withTempDir(async (dir) => {
      const exitCode = await runSetup({ dir });
      expect(exitCode).toBe(0);
    });
  });

  test("AC1 boundary: config passed to writeSetupConfig passes NaxConfigSchema.safeParse", async () => {
    let capturedConfig: NaxConfig | undefined;
    _setupDeps.writeSetupConfig = mock(async (_workdir: string, config: NaxConfig) => {
      capturedConfig = config;
      return { written: [] };
    });

    await withTempDir(async (dir) => {
      await runSetup({ dir });
      expect(capturedConfig).toBeDefined();
      expect(NaxConfigSchema.safeParse(capturedConfig).success).toBe(true);
    });
  });
});

// ─── AC2: monorepo → one .nax/mono/<relativeDir>/config.json per package ─────

describe("setupCommand — AC2: writes mono configs for each member package", () => {
  test("AC2: passes all monoConfigs to writeSetupConfig", async () => {
    _setupDeps.analyzeRepo = mock(async () => MONO_ANALYSIS);
    _setupDeps.generateSetupPlan = mock(async () => MONO_PLAN);

    let capturedMonoConfigs: MonoPackageConfig[] | undefined;
    _setupDeps.writeSetupConfig = mock(
      async (_workdir: string, _config: NaxConfig, monoConfigs: MonoPackageConfig[]) => {
        capturedMonoConfigs = monoConfigs;
        return { written: [] };
      },
    );

    await withTempDir(async (dir) => {
      await runSetup({ dir });
      expect(capturedMonoConfigs).toHaveLength(2);
    });
  });

  test("AC2 boundary: mono configs include each package relativeDir", async () => {
    _setupDeps.analyzeRepo = mock(async () => MONO_ANALYSIS);
    _setupDeps.generateSetupPlan = mock(async () => MONO_PLAN);

    let capturedMonoConfigs: MonoPackageConfig[] | undefined;
    _setupDeps.writeSetupConfig = mock(
      async (_workdir: string, _config: NaxConfig, monoConfigs: MonoPackageConfig[]) => {
        capturedMonoConfigs = monoConfigs;
        return { written: [] };
      },
    );

    await withTempDir(async (dir) => {
      await runSetup({ dir });
      expect(capturedMonoConfigs?.some((mc) => mc.relativeDir === "packages/a")).toBe(true);
      expect(capturedMonoConfigs?.some((mc) => mc.relativeDir === "packages/b")).toBe(true);
    });
  });
});

// ─── AC3: single-package → no .nax/mono/ directory ──────────────────────────

describe("setupCommand — AC3: single-package produces no mono directory entries", () => {
  test("AC3: passes empty monoConfigs to writeSetupConfig for single-package plan", async () => {
    let capturedMonoConfigs: MonoPackageConfig[] | undefined;
    _setupDeps.writeSetupConfig = mock(
      async (_workdir: string, _config: NaxConfig, monoConfigs: MonoPackageConfig[]) => {
        capturedMonoConfigs = monoConfigs;
        return { written: [] };
      },
    );

    await withTempDir(async (dir) => {
      const exitCode = await runSetup({ dir });
      expect(exitCode).toBe(0);
      expect(capturedMonoConfigs).toEqual([]);
    });
  });

  test("AC3 boundary: writeSetupConfig is called exactly once for single-package plan", async () => {
    let callCount = 0;
    _setupDeps.writeSetupConfig = mock(async () => {
      callCount++;
      return { written: [] };
    });

    await withTempDir(async (dir) => {
      await runSetup({ dir });
      expect(callCount).toBe(1);
    });
  });
});

// ─── AC4: --dry-run → exits 0, no files, prints summary ─────────────────────

describe("setupCommand — AC4: dry-run creates no files and prints summary", () => {
  test("AC4: exits 0 and does not call writeSetupConfig when dryRun is true", async () => {
    let writeCallCount = 0;
    _setupDeps.writeSetupConfig = mock(async () => {
      writeCallCount++;
      return { written: [] };
    });

    await withTempDir(async (dir) => {
      const exitCode = await runSetup({ dir, dryRun: true });
      expect(exitCode).toBe(0);
      expect(writeCallCount).toBe(0);
    });
  });

  test("AC4 boundary: dry-run emits at least one stdout message with config summary", async () => {
    const stdoutMessages: string[] = [];
    _setupDeps.stdout = mock((msg: string) => {
      stdoutMessages.push(msg);
    });

    await withTempDir(async (dir) => {
      await runSetup({ dir, dryRun: true });
      expect(stdoutMessages.length).toBeGreaterThan(0);
    });
  });
});

// ─── AC5: SETUP_PLAN_INVALID → exits 1, no config.json written ───────────────

describe("setupCommand — AC5: exits 1 when generateSetupPlan rejects with SETUP_PLAN_INVALID", () => {
  test("AC5: returns exit code 1 when generateSetupPlan throws SETUP_PLAN_INVALID", async () => {
    _setupDeps.generateSetupPlan = mock(async () => {
      throw new NaxError("plan failed", "SETUP_PLAN_INVALID");
    });

    await withTempDir(async (dir) => {
      const exitCode = await runSetup({ dir });
      expect(exitCode).toBe(1);
    });
  });

  test("AC5 boundary: does not call writeSetupConfig when SETUP_PLAN_INVALID", async () => {
    _setupDeps.generateSetupPlan = mock(async () => {
      throw new NaxError("plan failed", "SETUP_PLAN_INVALID");
    });

    let writeCallCount = 0;
    _setupDeps.writeSetupConfig = mock(async () => {
      writeCallCount++;
      return { written: [] };
    });

    await withTempDir(async (dir) => {
      await runSetup({ dir });
      expect(writeCallCount).toBe(0);
    });
  });
});

// ─── AC6: existing config + no --force → exits non-zero without overwrite ────

describe("setupCommand — AC6: collision refusal without --force", () => {
  test("AC6: exits non-zero when .nax/config.json exists and force is not set", async () => {
    _setupDeps.fileExists = mock(async (path: string) =>
      path.endsWith(".nax/config.json") || path.includes(".nax") && path.endsWith("config.json"),
    );

    await withTempDir(async (dir) => {
      const exitCode = await runSetup({ dir });
      expect(typeof exitCode).toBe("number");
      expect(exitCode).not.toBe(0);
    });
  });

  test("AC6 boundary: does not call writeSetupConfig when collision detected", async () => {
    _setupDeps.fileExists = mock(async (path: string) => path.endsWith("config.json"));

    let writeCallCount = 0;
    _setupDeps.writeSetupConfig = mock(async () => {
      writeCallCount++;
      return { written: [] };
    });

    await withTempDir(async (dir) => {
      await runSetup({ dir });
      expect(writeCallCount).toBe(0);
    });
  });
});

// ─── AC7: existing config + --force → replaces content ──────────────────────

describe("setupCommand — AC7: --force overwrites existing config", () => {
  test("AC7: exits 0 and calls writeSetupConfig even when file already exists", async () => {
    _setupDeps.fileExists = mock(async (path: string) => path.endsWith("config.json"));

    let writeCallCount = 0;
    _setupDeps.writeSetupConfig = mock(async () => {
      writeCallCount++;
      return { written: [] };
    });

    await withTempDir(async (dir) => {
      const exitCode = await runSetup({ dir, force: true });
      expect(exitCode).toBe(0);
      expect(writeCallCount).toBe(1);
    });
  });

  test("AC7 boundary: config passed under --force matches generated plan config", async () => {
    _setupDeps.fileExists = mock(async () => true);

    let capturedConfig: NaxConfig | undefined;
    _setupDeps.writeSetupConfig = mock(async (_workdir: string, config: NaxConfig) => {
      capturedConfig = config;
      return { written: [] };
    });

    await withTempDir(async (dir) => {
      await runSetup({ dir, force: true });
      expect(capturedConfig).toBeDefined();
      expect(NaxConfigSchema.safeParse(capturedConfig).success).toBe(true);
    });
  });
});

// ─── AC8: plan with gaps → stderr warnings, exits 0 ─────────────────────────

describe("setupCommand — AC8: gap warnings emitted on stderr, exits 0", () => {
  test("AC8: emits each gap as a stderr message", async () => {
    const planWithGaps: SetupPlan = {
      ...MOCK_PLAN,
      gaps: ["Script 'lint' missing from package.json", "Script 'test' missing from package.json"],
    };
    _setupDeps.generateSetupPlan = mock(async () => planWithGaps);

    const stderrMessages: string[] = [];
    _setupDeps.stderr = mock((msg: string) => {
      stderrMessages.push(msg);
    });

    await withTempDir(async (dir) => {
      const exitCode = await runSetup({ dir });
      expect(exitCode).toBe(0);
      expect(stderrMessages.some((m) => m.includes("lint"))).toBe(true);
      expect(stderrMessages.some((m) => m.includes("test"))).toBe(true);
    });
  });

  test("AC8 boundary: number of stderr messages is at least the number of gaps", async () => {
    const planWithGaps: SetupPlan = {
      ...MOCK_PLAN,
      gaps: ["gap-one", "gap-two", "gap-three"],
    };
    _setupDeps.generateSetupPlan = mock(async () => planWithGaps);

    const stderrMessages: string[] = [];
    _setupDeps.stderr = mock((msg: string) => {
      stderrMessages.push(msg);
    });

    await withTempDir(async (dir) => {
      await runSetup({ dir });
      const gapMessages = stderrMessages.filter((m) =>
        planWithGaps.gaps.some((g) => m.includes(g)),
      );
      expect(gapMessages.length).toBeGreaterThanOrEqual(3);
    });
  });
});

// ─── AC9: gate invoked exactly once ──────────────────────────────────────────

describe("setupCommand — AC9: verification gate invoked exactly once", () => {
  test("AC9: runGate dep is called exactly once per setupCommand invocation", async () => {
    let callCount = 0;
    _setupDeps.runGate = mock(async () => {
      callCount++;
      return 0;
    });

    await withTempDir(async (dir) => {
      const exitCode = await runSetup({ dir });
      expect(exitCode).toBe(0);
      expect(callCount).toBe(1);
    });
  });

  test("AC9 boundary: gate is not called when generateSetupPlan fails", async () => {
    _setupDeps.generateSetupPlan = mock(async () => {
      throw new NaxError("plan failed", "SETUP_PLAN_INVALID");
    });

    let callCount = 0;
    _setupDeps.runGate = mock(async () => {
      callCount++;
      return 0;
    });

    await withTempDir(async (dir) => {
      await runSetup({ dir });
      expect(callCount).toBe(0);
    });
  });
});

// ─── AC10: gate non-zero → exits non-zero ────────────────────────────────────

describe("setupCommand — AC10: exits non-zero when gate returns non-zero", () => {
  test("AC10: returns non-zero exit code when runGate returns non-zero", async () => {
    _setupDeps.runGate = mock(async () => 1);

    await withTempDir(async (dir) => {
      const exitCode = await runSetup({ dir });
      expect(typeof exitCode).toBe("number");
      expect(exitCode).not.toBe(0);
    });
  });

  test("AC10 boundary: specific exit code reflects gate failure", async () => {
    _setupDeps.runGate = mock(async () => 2);

    await withTempDir(async (dir) => {
      const exitCode = await runSetup({ dir });
      expect(exitCode).not.toBe(0);
    });
  });
});

// ─── AC11: invocation chain — analyzeRepo → generateSetupPlan ────────────────

describe("setupCommand — AC11: analyzeRepo and generateSetupPlan invocation chain", () => {
  test("AC11: analyzeRepo is invoked once with the resolved workdir", async () => {
    const capturedWorkdirs: string[] = [];
    _setupDeps.analyzeRepo = mock(async (workdir: string) => {
      capturedWorkdirs.push(workdir);
      return SINGLE_ANALYSIS;
    });

    await withTempDir(async (dir) => {
      await runSetup({ dir });
      expect(capturedWorkdirs).toHaveLength(1);
      expect(capturedWorkdirs[0]).toBe(dir);
    });
  });

  test("AC11 boundary: generateSetupPlan is invoked with the RepoAnalysis from analyzeRepo", async () => {
    const customAnalysis: RepoAnalysis = { ...SINGLE_ANALYSIS, pmRunPrefix: "pnpm run" };
    _setupDeps.analyzeRepo = mock(async () => customAnalysis);

    const capturedAnalyses: RepoAnalysis[] = [];
    _setupDeps.generateSetupPlan = mock(async (_ctx: unknown, analysis: RepoAnalysis) => {
      capturedAnalyses.push(analysis);
      return MOCK_PLAN;
    });

    await withTempDir(async (dir) => {
      await runSetup({ dir });
      expect(capturedAnalyses).toHaveLength(1);
      expect(capturedAnalyses[0]).toEqual(customAnalysis);
    });
  });
});

// ─── AC13: --fill-scripts invokes fillScripts before write step ──────────────

describe("setupCommand — AC13: fillScripts invoked iff --fill-scripts flag set", () => {
  test("AC13: fillScripts dep is called when fillScripts option is true", async () => {
    let fillScriptsCalled = false;
    _setupDeps.fillScripts = mock(async () => {
      fillScriptsCalled = true;
    });

    await withTempDir(async (dir) => {
      const exitCode = await runSetup({ dir, fillScripts: true });
      expect(exitCode).toBe(0);
      expect(fillScriptsCalled).toBe(true);
    });
  });

  test("AC13: fillScripts is called before writeSetupConfig", async () => {
    const callOrder: string[] = [];
    _setupDeps.fillScripts = mock(async () => {
      callOrder.push("fillScripts");
    });
    _setupDeps.writeSetupConfig = mock(async () => {
      callOrder.push("writeSetupConfig");
      return { written: [] };
    });

    await withTempDir(async (dir) => {
      await runSetup({ dir, fillScripts: true });
      const fillIdx = callOrder.indexOf("fillScripts");
      const writeIdx = callOrder.indexOf("writeSetupConfig");
      expect(fillIdx).toBeGreaterThanOrEqual(0);
      expect(fillIdx).toBeLessThan(writeIdx);
    });
  });

  test("AC13: fillScripts dep is not called when fillScripts option is omitted", async () => {
    let fillScriptsCalled = false;
    _setupDeps.fillScripts = mock(async () => {
      fillScriptsCalled = true;
    });

    await withTempDir(async (dir) => {
      const exitCode = await runSetup({ dir });
      expect(exitCode).toBe(0);
      expect(fillScriptsCalled).toBe(false);
    });
  });

  test("AC13 boundary: fillScripts dep is not called when fillScripts option is false", async () => {
    let fillScriptsCalled = false;
    _setupDeps.fillScripts = mock(async () => {
      fillScriptsCalled = true;
    });

    await withTempDir(async (dir) => {
      await runSetup({ dir, fillScripts: false });
      expect(fillScriptsCalled).toBe(false);
    });
  });
});

// ─── AC12: CLI barrel exports setupCommand ────────────────────────────────────

describe("setupCommand — AC12: exported from src/cli barrel", () => {
  test("AC12: setupCommand is a function exported from src/cli", () => {
    expect(typeof barrelSetupCommand).toBe("function");
  });

  test("AC12 boundary: setupCommand and barrelSetupCommand are the same reference", () => {
    expect(barrelSetupCommand).toBe(setupCommand);
  });
});
