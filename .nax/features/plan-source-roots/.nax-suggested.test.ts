import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, mock, afterEach, beforeEach } from "bun:test";
import type { SourceRoot } from "../../../src/analyze/types";
import { _scannerDeps, scanSourceRoots } from "../../../src/analyze/scanner";
import { buildSourceRootsSection } from "../../../src/cli/plan-helpers";
import { PlanPromptBuilder } from "../../../src/prompts/builders/plan-builder";
import { withTempDir } from "../../../test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// AC-1: scanSourceRoots returns typescript root when tsconfig.json exists (no package.json)
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-1: scanSourceRoots with tsconfig.json (no package.json)", () => {
  test("returns array containing SourceRoot with path: '.' and language: 'typescript'", async () => {
    await withTempDir(async (workdir) => {
      // Create tsconfig.json without package.json
      await Bun.write(join(workdir, "tsconfig.json"), "{}");

      const roots = await scanSourceRoots(workdir);

      expect(roots).toHaveLength(1);
      expect(roots[0].path).toBe(".");
      expect(roots[0].language).toBe("typescript");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2: scanSourceRoots returns rust root when Cargo.toml exists (no package.json)
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-2: scanSourceRoots with Cargo.toml (no package.json)", () => {
  test("returns array containing SourceRoot with path: '.' and language: 'rust'", async () => {
    await withTempDir(async (workdir) => {
      // Create Cargo.toml without package.json
      await Bun.write(join(workdir, "Cargo.toml"), "[package]\nname = \"test\"\n");

      const roots = await scanSourceRoots(workdir);

      expect(roots).toHaveLength(1);
      expect(roots[0].path).toBe(".");
      expect(roots[0].language).toBe("rust");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3: scanSourceRoots skips non-existent packages without throwing
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-3: scanSourceRoots skips non-existent package paths", () => {
  beforeEach(() => {
    // Will be restored by withDepsRestore pattern in test
  });

  test("when discoverWorkspacePackages returns non-existent path, skips it and returns valid packages only", async () => {
    await withTempDir(async (workdir) => {
      // Create real packages
      await Bun.write(
        join(workdir, "packages/api/package.json"),
        JSON.stringify({ name: "api", devDependencies: { typescript: "^5.0.0" } }),
      );
      await Bun.write(join(workdir, "packages/api/tsconfig.json"), "{}");

      // Mock discoverWorkspacePackages to return both existing and non-existent paths
      const origDiscover = _scannerDeps.discoverWorkspacePackages;
      _scannerDeps.discoverWorkspacePackages = mock(() =>
        Promise.resolve(["packages/api", "packages/nonexistent", "packages/also-missing"]),
      );

      try {
        const roots = await scanSourceRoots(workdir);

        // Should only include the valid package, not throw
        expect(roots.length).toBeGreaterThan(0);
        const validRoot = roots.find((r) => r.path === "packages/api");
        expect(validRoot).toBeDefined();
        expect(validRoot?.language).toBe("typescript");
      } finally {
        _scannerDeps.discoverWorkspacePackages = origDiscover;
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-4: scanSourceRoots truncates to 30 packages and sorts alphabetically
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-4: scanSourceRoots truncates to exactly 30 packages with alphabetical sorting", () => {
  beforeEach(() => {
    // Deps will be restored per-test
  });

  test("returns exactly 30 SourceRoots sorted alphabetically by path when 31+ packages exist", async () => {
    await withTempDir(async (workdir) => {
      // Mock discoverWorkspacePackages to return 35 packages with mixed ordering
      const packages = [
        "packages/zebra",
        "packages/alpha",
        "packages/bravo",
        ...Array.from({ length: 32 }, (_, i) => `packages/pkg${String(i).padStart(2, "0")}`),
      ];

      const origDiscover = _scannerDeps.discoverWorkspacePackages;
      _scannerDeps.discoverWorkspacePackages = mock(() => Promise.resolve(packages));

      const origDetect = _scannerDeps.detectLanguage;
      _scannerDeps.detectLanguage = mock(() => Promise.resolve(undefined));

      const origReadPkg = _scannerDeps.readPackageJson;
      _scannerDeps.readPackageJson = mock(() => Promise.resolve(null));

      try {
        const roots = await scanSourceRoots(workdir);

        // Should return exactly 30
        expect(roots).toHaveLength(30);

        // Should be sorted alphabetically by path
        const paths = roots.map((r) => r.path);
        const sortedPaths = [...paths].sort();
        expect(paths).toEqual(sortedPaths);
      } finally {
        _scannerDeps.discoverWorkspacePackages = origDiscover;
        _scannerDeps.detectLanguage = origDetect;
        _scannerDeps.readPackageJson = origReadPkg;
      }
    });
  });

  test("logs warning containing original count and truncatedTo: 30 when 31+ packages exist", async () => {
    await withTempDir(async (workdir) => {
      const packages = Array.from({ length: 35 }, (_, i) => `packages/pkg${String(i).padStart(2, "0")}`);

      const origDiscover = _scannerDeps.discoverWorkspacePackages;
      _scannerDeps.discoverWorkspacePackages = mock(() => Promise.resolve(packages));

      const origDetect = _scannerDeps.detectLanguage;
      _scannerDeps.detectLanguage = mock(() => Promise.resolve(undefined));

      const origReadPkg = _scannerDeps.readPackageJson;
      _scannerDeps.readPackageJson = mock(() => Promise.resolve(null));

      // Capture logger calls
      const logCalls: { level: string; module: string; message: string; data: unknown }[] = [];
      const origLogger = _scannerDeps.logger;
      _scannerDeps.logger = mock(() => ({
        debug: (module: string, msg: string, data: unknown) => logCalls.push({ level: "debug", module, message: msg, data }),
        info: (module: string, msg: string, data: unknown) => logCalls.push({ level: "info", module, message: msg, data }),
        warn: (module: string, msg: string, data: unknown) => logCalls.push({ level: "warn", module, message: msg, data }),
        error: (module: string, msg: string, data: unknown) => logCalls.push({ level: "error", module, message: msg, data }),
      })) as any;

      try {
        await scanSourceRoots(workdir);

        const warnCall = logCalls.find((c) => c.level === "warn");
        expect(warnCall).toBeDefined();
        expect(warnCall?.data).toMatchObject({ count: 35, truncatedTo: 30 });
      } finally {
        _scannerDeps.discoverWorkspacePackages = origDiscover;
        _scannerDeps.detectLanguage = origDetect;
        _scannerDeps.readPackageJson = origReadPkg;
        _scannerDeps.logger = origLogger;
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5: scanSourceRoots handles detectLanguage throws gracefully
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-5: scanSourceRoots handles detectLanguage exceptions", () => {
  test("when detectLanguage throws for one package, logs warning and emits SourceRoot with language: undefined", async () => {
    await withTempDir(async (workdir) => {
      // Create packages
      await Bun.write(
        join(workdir, "packages/api/package.json"),
        JSON.stringify({ name: "api", devDependencies: { typescript: "^5.0.0" } }),
      );
      await Bun.write(join(workdir, "packages/api/tsconfig.json"), "{}");
      await Bun.write(join(workdir, "packages/bad/package.json"), JSON.stringify({ name: "bad" }));

      const origDiscover = _scannerDeps.discoverWorkspacePackages;
      _scannerDeps.discoverWorkspacePackages = mock(() => Promise.resolve(["packages/api", "packages/bad"]));

      // Mock detectLanguage to throw for packages/bad
      const origDetect = _scannerDeps.detectLanguage;
      let detectCallCount = 0;
      _scannerDeps.detectLanguage = mock((pkgDir: string) => {
        detectCallCount++;
        if (pkgDir.includes("bad")) {
          return Promise.reject(new Error("Language detection failed"));
        }
        return Promise.resolve("typescript");
      });

      // Capture logger calls
      const logCalls: any[] = [];
      const origLogger = _scannerDeps.logger;
      _scannerDeps.logger = mock(() => ({
        debug: () => {},
        info: () => {},
        warn: (module: string, msg: string, data: unknown) => logCalls.push({ level: "warn", module, message: msg, data }),
        error: () => {},
      })) as any;

      try {
        const roots = await scanSourceRoots(workdir);

        // Should continue processing and return both roots
        expect(roots.length).toBeGreaterThanOrEqual(2);

        // Should have emitted a warning
        expect(logCalls.length).toBeGreaterThan(0);

        // Should have logged package path in the warning
        const warningWithPath = logCalls.find((c) => c.data && JSON.stringify(c.data).includes("packages/bad"));
        expect(warningWithPath).toBeDefined();

        // Should include root with undefined language for the failed package
        const badRoot = roots.find((r) => r.path === "packages/bad");
        expect(badRoot?.language).toBeUndefined();
      } finally {
        _scannerDeps.discoverWorkspacePackages = origDiscover;
        _scannerDeps.detectLanguage = origDetect;
        _scannerDeps.logger = origLogger;
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-6: buildSourceRootsSection includes file read budget guidance
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-6: buildSourceRootsSection includes file read budget", () => {
  test("returns string containing substring 'aim for ≤ 10 file reads per story'", () => {
    const roots: SourceRoot[] = [{ path: ".", language: "typescript", framework: "bun", testRunner: "bun:test" }];

    const section = buildSourceRootsSection(roots);

    expect(section).toContain("≤ 10 file reads per story");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-7: buildSourceRootsSection renders undefined language as 'unknown'
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-7: buildSourceRootsSection renders undefined language as 'unknown'", () => {
  test("returns string containing '(unknown,' and not '(undefined,'", () => {
    const roots: SourceRoot[] = [{ path: ".", language: undefined, framework: "bun", testRunner: "bun:test" }];

    const section = buildSourceRootsSection(roots);

    expect(section).toContain("(unknown,");
    expect(section).not.toContain("(undefined,");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-8: buildSourceRootsSection renders empty framework/testRunner as '—'
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-8: buildSourceRootsSection renders empty fields as '—'", () => {
  test("returns string containing 'framework: —' and 'tests: —' without empty values", () => {
    const roots: SourceRoot[] = [{ path: ".", language: "typescript", framework: "", testRunner: "" }];

    const section = buildSourceRootsSection(roots);

    expect(section).toContain("framework: —");
    expect(section).toContain("tests: —");
    // Should not have bare "framework: " followed by only whitespace
    expect(section).not.toMatch(/framework:\s*\n/);
    expect(section).not.toMatch(/tests:\s*\n/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-9: PlanPromptBuilder excludes 'File Read Permission:' when fileReadAccess=false
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-9: PlanPromptBuilder with fileReadAccess=false", () => {
  test("returns taskContext WITHOUT 'File Read Permission:' when fileReadAccess is false", () => {
    const builder = new PlanPromptBuilder();
    const parts = builder.build(
      "Test spec",
      "## Source Roots\n\n- . (typescript, framework: bun, tests: bun:test)",
      undefined,
      undefined,
      undefined,
      undefined,
      { fileReadAccess: false },
    );

    expect(parts.taskContext).not.toContain("File Read Permission:");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-10: plan-decompose.ts does not import buildCodebaseContext
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-10: plan-decompose.ts source code verification", () => {
  test("does not contain 'import { buildCodebaseContext }' from plan-helpers", async () => {
    const planDecomposePath = join(import.meta.dir, "../../../src/cli/plan-decompose.ts");
    expect(existsSync(planDecomposePath)).toBe(true);

    const content = await Bun.file(planDecomposePath).text();

    // Should not import buildCodebaseContext from plan-helpers
    expect(content).not.toContain('import { buildCodebaseContext }');
    expect(content).not.toMatch(/buildCodebaseContext\s*\(/);
  });

  test("does not contain any call to 'buildCodebaseContext('", async () => {
    const planDecomposePath = join(import.meta.dir, "../../../src/cli/plan-decompose.ts");
    const content = await Bun.file(planDecomposePath).text();

    // Should not call buildCodebaseContext
    expect(content).not.toMatch(/buildCodebaseContext\s*\(/);
  });
});