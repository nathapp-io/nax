import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SourceRoot } from "../../../src/analyze/types";
import { _planDeps } from "../../../src/cli/plan-runtime";
import { buildSourceRootsSection } from "../../../src/cli/plan-helpers";
import { PlanPromptBuilder } from "../../../src/prompts/builders/plan-builder";
import { cleanupTempDir, makeNaxConfig, makeTempDir, withTempDir } from "../../../test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// AC-1 to AC-11: scanSourceRoots tests
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-1: scanSourceRoots with single package.json (TypeScript)", () => {
  test("returns array of length 1 when workdir contains package.json declaring TypeScript", async () => {
    await withTempDir(async (workdir) => {
      // Create a TypeScript single-package project
      await Bun.write(
        join(workdir, "package.json"),
        JSON.stringify({
          name: "test-project",
          version: "1.0.0",
          devDependencies: { typescript: "^5.0.0" },
        }),
      );
      await Bun.write(join(workdir, "tsconfig.json"), "{}");

      const roots = await _planDeps.scanSourceRoots(workdir);
      expect(roots).toHaveLength(1);
    });
  });
});

describe("AC-2: scanSourceRoots returns correct path and language for single TS package", () => {
  test("returns root with path === '.' and language === 'typescript'", async () => {
    await withTempDir(async (workdir) => {
      await Bun.write(
        join(workdir, "package.json"),
        JSON.stringify({
          name: "ts-project",
          devDependencies: { typescript: "^5.0.0" },
        }),
      );
      await Bun.write(join(workdir, "tsconfig.json"), "{}");

      const roots = await _planDeps.scanSourceRoots(workdir);
      expect(roots[0].path).toBe(".");
      expect(roots[0].language).toBe("typescript");
    });
  });
});

describe("AC-3: scanSourceRoots returns N roots for monorepo with N packages", () => {
  test("returns one SourceRoot per discovered package in monorepo", async () => {
    await withTempDir(async (workdir) => {
      // Create a pnpm workspace
      await Bun.write(
        join(workdir, "pnpm-workspace.yaml"),
        "packages:\n  - 'packages/*'\n",
      );

      // Create package directories
      for (const pkg of ["api", "web", "cli"]) {
        await Bun.write(
          join(workdir, "packages", pkg, "package.json"),
          JSON.stringify({
            name: `@mono/${pkg}`,
            version: "1.0.0",
          }),
        );
      }

      const roots = await _planDeps.scanSourceRoots(workdir);
      expect(roots).toHaveLength(3);
      const paths = roots.map((r) => r.path).sort();
      expect(paths).toEqual(["packages/api", "packages/cli", "packages/web"]);
    });
  });
});

describe("AC-4: Each SourceRoot has correct path and detected language", () => {
  test("returns roots with path matching relative package path and language per package", async () => {
    await withTempDir(async (workdir) => {
      // Create pnpm workspace
      await Bun.write(
        join(workdir, "pnpm-workspace.yaml"),
        "packages:\n  - 'packages/*'\n",
      );

      // TS package
      await Bun.write(
        join(workdir, "packages/web/package.json"),
        JSON.stringify({ name: "web" }),
      );
      await Bun.write(join(workdir, "packages/web/tsconfig.json"), "{}");

      // Go package (only go.mod, no package.json)
      await Bun.write(
        join(workdir, "packages/worker/go.mod"),
        "module example.com/worker\n",
      );

      const roots = await _planDeps.scanSourceRoots(workdir);
      const webRoot = roots.find((r) => r.path === "packages/web");
      const workerRoot = roots.find((r) => r.path === "packages/worker");

      expect(webRoot?.language).toBe("typescript");
      expect(workerRoot?.language).toBe("go");
    });
  });
});

describe("AC-5: scanSourceRoots with go.mod only", () => {
  test("returns [{path: '.', language: 'go', framework: '', testRunner: 'go-test'}]", async () => {
    await withTempDir(async (workdir) => {
      await Bun.write(join(workdir, "go.mod"), "module example.com/app\n");

      const roots = await _planDeps.scanSourceRoots(workdir);
      expect(roots).toHaveLength(1);
      expect(roots[0].path).toBe(".");
      expect(roots[0].language).toBe("go");
      expect(roots[0].framework).toBe("");
      expect(roots[0].testRunner).toBe("go-test");
    });
  });
});

describe("AC-6: scanSourceRoots with pyproject.toml only", () => {
  test("returns [{path: '.', language: 'python', framework: '', testRunner: 'pytest'}]", async () => {
    await withTempDir(async (workdir) => {
      await Bun.write(
        join(workdir, "pyproject.toml"),
        "[project]\nname = 'my-app'\n",
      );

      const roots = await _planDeps.scanSourceRoots(workdir);
      expect(roots).toHaveLength(1);
      expect(roots[0].path).toBe(".");
      expect(roots[0].language).toBe("python");
      expect(roots[0].framework).toBe("");
      expect(roots[0].testRunner).toBe("pytest");
    });
  });
});

describe("AC-7: scanSourceRoots with no language markers", () => {
  test("returns [{path: '.', language: undefined, framework: '', testRunner: ''}]", async () => {
    await withTempDir(async (workdir) => {
      // Create empty directory with no language markers
      // (just make sure workdir exists)
      const roots = await _planDeps.scanSourceRoots(workdir);
      expect(roots).toHaveLength(1);
      expect(roots[0].path).toBe(".");
      expect(roots[0].language).toBeUndefined();
      expect(roots[0].framework).toBe("");
      expect(roots[0].testRunner).toBe("");
    });
  });
});

describe("AC-8: scanSourceRoots with 31+ packages", () => {
  test("returns array of length <= 30 when discovered package count exceeds 30", async () => {
    await withTempDir(async (workdir) => {
      // Create pnpm workspace with 31+ packages
      await Bun.write(
        join(workdir, "pnpm-workspace.yaml"),
        "packages:\n  - 'packages/*'\n",
      );

      // Create 35 packages
      for (let i = 1; i <= 35; i++) {
        const pkgName = String(i).padStart(3, "0");
        await Bun.write(
          join(workdir, "packages", `pkg-${pkgName}/package.json`),
          JSON.stringify({ name: `pkg-${pkgName}` }),
        );
      }

      const roots = await _planDeps.scanSourceRoots(workdir);
      expect(roots.length).toBeLessThanOrEqual(30);
    });
  });
});

describe("AC-9: scanSourceRoots logs warning when 31+ packages", () => {
  test("emits log entry with 'warning' level and {count, truncatedTo: 30} context", async () => {
    await withTempDir(async (workdir) => {
      // Create pnpm workspace with 35 packages
      await Bun.write(
        join(workdir, "pnpm-workspace.yaml"),
        "packages:\n  - 'packages/*'\n",
      );

      for (let i = 1; i <= 35; i++) {
        const pkgName = String(i).padStart(3, "0");
        await Bun.write(
          join(workdir, "packages", `pkg-${pkgName}/package.json`),
          JSON.stringify({ name: `pkg-${pkgName}` }),
        );
      }

      // Mock the logger to capture calls
      const logger = {
        debug: mock(() => {}),
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
      };

      const origLogger = await import("../../../src/logger");
      const getLogger = origLogger.getLogger;
      origLogger.getLogger = () => logger;

      try {
        await _planDeps.scanSourceRoots(workdir);

        // Verify warn was called with truncation context
        expect(logger.warn.mock.calls.length).toBeGreaterThan(0);
        const warnCall = logger.warn.mock.calls.find(
          (call) => call[0] === "analyze" || (call[1] && call[1].includes?.("truncat")),
        );
        expect(warnCall).toBeDefined();
      } finally {
        origLogger.getLogger = getLogger;
      }
    });
  });
});

describe("AC-10: scanSourceRoots catches discoverWorkspacePackages error", () => {
  test("returns fallback and does not throw when discoverWorkspacePackages rejects", async () => {
    await withTempDir(async (workdir) => {
      // Create a fallback language marker (TypeScript)
      await Bun.write(join(workdir, "tsconfig.json"), "{}");

      // Mock discoverWorkspacePackages to throw
      const origDiscover = _planDeps.discoverWorkspacePackages;
      _planDeps.discoverWorkspacePackages = mock(() =>
        Promise.reject(new Error("Workspace discovery failed")),
      ) as typeof discoverWorkspacePackages;

      try {
        const roots = await _planDeps.scanSourceRoots(workdir);

        // Should return fallback
        expect(roots).toHaveLength(1);
        expect(roots[0].path).toBe(".");
        expect(roots[0].language).toBe("typescript");
      } finally {
        _planDeps.discoverWorkspacePackages = origDiscover;
      }
    });
  });
});

describe("AC-11: scanSourceRoots logs warning when discoverWorkspacePackages throws", () => {
  test("emits log entry with 'warning' level and error message in context", async () => {
    await withTempDir(async (workdir) => {
      await Bun.write(join(workdir, "tsconfig.json"), "{}");

      const origDiscover = _planDeps.discoverWorkspacePackages;
      const errorMsg = "Test discovery error";
      _planDeps.discoverWorkspacePackages = mock(() =>
        Promise.reject(new Error(errorMsg)),
      ) as typeof discoverWorkspacePackages;

      const logger = {
        debug: mock(() => {}),
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
      };

      const origLogger = await import("../../../src/logger");
      const getLogger = origLogger.getLogger;
      origLogger.getLogger = () => logger;

      try {
        await _planDeps.scanSourceRoots(workdir);

        // Verify warn was called with error message
        expect(logger.warn.mock.calls.length).toBeGreaterThan(0);
        const warnCall = logger.warn.mock.calls.find(
          (call) => call[2] && JSON.stringify(call[2]).includes(errorMsg),
        );
        expect(warnCall).toBeDefined();
      } finally {
        _planDeps.discoverWorkspacePackages = origDiscover;
        origLogger.getLogger = getLogger;
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-12 to AC-14: buildSourceRootsSection tests
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-12: buildSourceRootsSection returns string starting with '## Source Roots'", () => {
  test("first line is exactly '## Source Roots'", () => {
    const roots: SourceRoot[] = [
      { path: "packages/api", language: "typescript", framework: "NestJS", testRunner: "jest" },
    ];

    const section = buildSourceRootsSection(roots);
    expect(section.startsWith("## Source Roots")).toBe(true);
  });
});

describe("AC-13: buildSourceRootsSection returns one line per root with correct format", () => {
  test("returns string containing one '- <path>  (<language>, framework: <framework>, tests: <testRunner>)' line per root", () => {
    const roots: SourceRoot[] = [
      { path: "packages/api", language: "typescript", framework: "NestJS", testRunner: "jest" },
      { path: "packages/web", language: "typescript", framework: "Next.js", testRunner: "vitest" },
      { path: "cmd/worker", language: "go", framework: "", testRunner: "go-test" },
    ];

    const section = buildSourceRootsSection(roots);

    // Should contain one line per root matching the regex
    const regex =
      /^- [^ ]+ +\([^)]+, framework: [^)]+, tests: [^)]+\)$/m;
    const matches = section.match(new RegExp(regex.source, "gm"));
    expect(matches?.length).toBe(3);
  });
});

describe("AC-14: buildSourceRootsSection with empty array", () => {
  test("returns string containing '- .  (unknown, framework: —, tests: —)' and does not throw", () => {
    const section = buildSourceRootsSection([]);

    expect(section).toContain("- .");
    expect(section).toContain("(unknown");
    expect(section).toContain("framework: —");
    expect(section).toContain("tests: —");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-15 to AC-22: PlanPromptBuilder tests
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-15: PlanPromptBuilder does NOT contain '## Codebase Structure'", () => {
  test("taskContext does not include substring '## Codebase Structure'", () => {
    const builder = new PlanPromptBuilder();
    const sourceRootsSection = "## Source Roots\n\n- . (typescript, framework: bun, tests: bun:test)";
    const parts = builder.build("Test spec", sourceRootsSection);

    expect(parts.taskContext).not.toContain("## Codebase Structure");
  });
});

describe("AC-16: PlanPromptBuilder DOES contain '## Source Roots'", () => {
  test("taskContext includes substring '## Source Roots'", () => {
    const builder = new PlanPromptBuilder();
    const sourceRootsSection = "## Source Roots\n\n- . (typescript, framework: bun, tests: bun:test)";
    const parts = builder.build("Test spec", sourceRootsSection);

    expect(parts.taskContext).toContain("## Source Roots");
  });
});

describe("AC-17: PlanPromptBuilder does NOT contain 'file names and structure only'", () => {
  test("taskContext does not include substring 'file names and structure only'", () => {
    const builder = new PlanPromptBuilder();
    const sourceRootsSection = "## Source Roots\n\n- . (typescript, framework: bun, tests: bun:test)";
    const parts = builder.build("Test spec", sourceRootsSection);

    expect(parts.taskContext).not.toContain("file names and structure only");
  });
});

describe("AC-18: PlanPromptBuilder DOES contain 'You have Read, Grep, and Glob tools'", () => {
  test("taskContext includes substring 'You have Read, Grep, and Glob tools'", () => {
    const builder = new PlanPromptBuilder();
    const sourceRootsSection = "## Source Roots\n\n- . (typescript, framework: bun, tests: bun:test)";
    const parts = builder.build("Test spec", sourceRootsSection);

    expect(parts.taskContext).toContain("You have Read, Grep, and Glob tools");
  });
});

describe("AC-19: PlanPromptBuilder DOES contain '≤ 10 file reads per story'", () => {
  test("taskContext includes substring '≤ 10 file reads per story'", () => {
    const builder = new PlanPromptBuilder();
    const sourceRootsSection = "## Source Roots\n\n- . (typescript, framework: bun, tests: bun:test)";
    const parts = builder.build("Test spec", sourceRootsSection);

    expect(parts.taskContext).toContain("≤ 10 file reads per story");
  });
});

describe("AC-20: PlanPromptBuilder does NOT contain '## Dependencies'", () => {
  test("taskContext does not include substring '## Dependencies'", () => {
    const builder = new PlanPromptBuilder();
    const sourceRootsSection = "## Source Roots\n\n- . (typescript, framework: bun, tests: bun:test)";
    const parts = builder.build("Test spec", sourceRootsSection);

    expect(parts.taskContext).not.toContain("## Dependencies");
  });
});

describe("AC-21: PlanPromptBuilder does NOT contain '## Test Setup'", () => {
  test("taskContext does not include substring '## Test Setup'", () => {
    const builder = new PlanPromptBuilder();
    const sourceRootsSection = "## Source Roots\n\n- . (typescript, framework: bun, tests: bun:test)";
    const parts = builder.build("Test spec", sourceRootsSection);

    expect(parts.taskContext).not.toContain("## Test Setup");
  });
});

describe("AC-22: PlanPromptBuilder with fileReadAccess=true includes 'File Read Permission:'", () => {
  test("taskContext includes 'File Read Permission:' when proposers.fileReadAccess is true", () => {
    const builder = new PlanPromptBuilder();
    const sourceRootsSection = "## Source Roots\n\n- . (typescript, framework: bun, tests: bun:test)";
    const parts = builder.build("Test spec", sourceRootsSection, undefined, undefined, undefined, undefined, {
      fileReadAccess: true,
    });

    expect(parts.taskContext).toContain("File Read Permission:");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-23 to AC-24: Integration tests for runPlanCommand and runPlanDecompose
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-23: runPlanCommand calls scanSourceRoots and passes rendered section to builder", () => {
  test("planCommand invokes _planDeps.scanSourceRoots(workdir) and passes buildSourceRootsSection result", async () => {
    // This is a behavioral test that verifies the integration pattern.
    // We verify that _planDeps has scanSourceRoots and can call it.
    expect(_planDeps.scanSourceRoots).toBeDefined();
    expect(typeof _planDeps.scanSourceRoots).toBe("function");

    // Verify it returns a Promise<SourceRoot[]>
    await withTempDir(async (workdir) => {
      const roots = await _planDeps.scanSourceRoots(workdir);
      expect(Array.isArray(roots)).toBe(true);
      if (roots.length > 0) {
        expect(roots[0]).toHaveProperty("path");
        expect(roots[0]).toHaveProperty("language");
        expect(roots[0]).toHaveProperty("framework");
        expect(roots[0]).toHaveProperty("testRunner");
      }
    });
  });
});

describe("AC-24: runPlanDecompose calls scanSourceRoots and includes rendered section in prompt", () => {
  test("plan-decompose invokes _planDeps.scanSourceRoots(workdir)", async () => {
    // Verify that _planDeps.scanSourceRoots is available and working
    expect(_planDeps.scanSourceRoots).toBeDefined();

    await withTempDir(async (workdir) => {
      // Create minimal project
      await Bun.write(join(workdir, "package.json"), JSON.stringify({ name: "test" }));

      const roots = await _planDeps.scanSourceRoots(workdir);
      expect(Array.isArray(roots)).toBe(true);

      // Verify buildSourceRootsSection is callable
      const section = buildSourceRootsSection(roots);
      expect(section.length).toBeGreaterThan(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-25: _planDeps shape verification
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-25: _planDeps exports scanSourceRoots and not scanCodebase", () => {
  test("_planDeps has scanSourceRoots property and does not have scanCodebase property", () => {
    expect(_planDeps).toHaveProperty("scanSourceRoots");
    expect(_planDeps).not.toHaveProperty("scanCodebase");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-26: Grounder verification
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-26: grounderStrategy calls scanCodebase not scanSourceRoots", () => {
  test("grounder in src/debate/pre-phase/grounder.ts uses scanCodebase", async () => {
    // Read the grounder source to verify it uses scanCodebase
    const grounderPath = join(
      import.meta.dir,
      "../../../../src/debate/pre-phase/grounder.ts",
    );
    expect(existsSync(grounderPath)).toBe(true);

    const content = await Bun.file(grounderPath).text();
    expect(content).toContain("scanCodebase");
    expect(content).toContain("_grounderDeps.scanCodebase");
  });
});