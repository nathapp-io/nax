/**
 * Unit tests for src/project/detector.ts (US-002)
 *
 * Tests detectProjectProfile() for language/type/testFramework/lintTool detection.
 * All tests must fail until detector.ts is implemented.
 */

import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { detectProjectProfile } from "../../../src/project";
import { withTempDir } from "../../helpers/temp";

// ---------------------------------------------------------------------------
// Language detection — Go
// ---------------------------------------------------------------------------

describe("detectProjectProfile — language: go", () => {
  test("returns language: 'go' when go.mod exists and no other manifests", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "go.mod"), "module example.com/myapp\n\ngo 1.21\n");
      const profile = await detectProjectProfile(dir, {});
      expect(profile.language).toBe("go");
    });
  });

  test("returns language: 'go' when go.mod and package.json both exist (go wins)", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "go.mod"), "module example.com/myapp\n\ngo 1.21\n");
      await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "test" }));
      const profile = await detectProjectProfile(dir, {});
      expect(profile.language).toBe("go");
    });
  });

  test("returns testFramework: 'go-test' and lintTool: 'golangci-lint' when language resolves to go", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "go.mod"), "module example.com/myapp\n\ngo 1.21\n");
      const profile = await detectProjectProfile(dir, {});
      expect(profile.testFramework).toBe("go-test");
      expect(profile.lintTool).toBe("golangci-lint");
    });
  });
});

// ---------------------------------------------------------------------------
// Language detection — Rust
// ---------------------------------------------------------------------------

describe("detectProjectProfile — language: rust", () => {
  test("returns language: 'rust' when Cargo.toml exists and no go.mod", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "Cargo.toml"),
        '[package]\nname = "myapp"\nversion = "0.1.0"\n',
      );
      const profile = await detectProjectProfile(dir, {});
      expect(profile.language).toBe("rust");
    });
  });

  test("go takes priority over rust when both manifests present", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "go.mod"), "module example.com/myapp\n\ngo 1.21\n");
      await Bun.write(
        join(dir, "Cargo.toml"),
        '[package]\nname = "myapp"\nversion = "0.1.0"\n',
      );
      const profile = await detectProjectProfile(dir, {});
      expect(profile.language).toBe("go");
    });
  });
});

// ---------------------------------------------------------------------------
// Language detection — TypeScript / JavaScript
// ---------------------------------------------------------------------------

describe("detectProjectProfile — language: typescript/javascript", () => {
  test.each(["devDependencies", "dependencies"] as const)("returns language: 'typescript' when typescript in %s", async (depKey) => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "myapp", [depKey]: { typescript: "^5.0.0" } }));
      const profile = await detectProjectProfile(dir, {});
      expect(profile.language).toBe("typescript");
    });
  });

  test("returns language: 'javascript' when package.json exists without typescript dep", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ name: "myapp", dependencies: { express: "^4.0.0" } }),
      );
      const profile = await detectProjectProfile(dir, {});
      expect(profile.language).toBe("javascript");
    });
  });
});

// ---------------------------------------------------------------------------
// Language detection — Python
// ---------------------------------------------------------------------------

describe("detectProjectProfile — language: python", () => {
  test("returns language: 'python' when pyproject.toml exists", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "pyproject.toml"),
        "[tool.poetry]\nname = \"myapp\"\nversion = \"0.1.0\"\n",
      );
      const profile = await detectProjectProfile(dir, {});
      expect(profile.language).toBe("python");
    });
  });

  test("returns language: 'python' when requirements.txt exists and no higher-priority manifest", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "requirements.txt"), "pytest>=7.0\nrequests>=2.28\n");
      const profile = await detectProjectProfile(dir, {});
      expect(profile.language).toBe("python");
    });
  });

  test("returns testFramework: 'pytest' and lintTool: 'ruff' when language resolves to python", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "pyproject.toml"), "[build-system]\n");
      const profile = await detectProjectProfile(dir, {});
      expect(profile.testFramework).toBe("pytest");
      expect(profile.lintTool).toBe("ruff");
    });
  });

  test("go takes priority over python when both manifests present", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "go.mod"), "module example.com/myapp\n\ngo 1.21\n");
      await Bun.write(join(dir, "pyproject.toml"), "[build-system]\n");
      const profile = await detectProjectProfile(dir, {});
      expect(profile.language).toBe("go");
    });
  });

  test("rust takes priority over python when both manifests present", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "Cargo.toml"),
        '[package]\nname = "myapp"\nversion = "0.1.0"\n',
      );
      await Bun.write(join(dir, "requirements.txt"), "pytest\n");
      const profile = await detectProjectProfile(dir, {});
      expect(profile.language).toBe("rust");
    });
  });
});

// ---------------------------------------------------------------------------
// Type detection — web
// ---------------------------------------------------------------------------

describe("detectProjectProfile — type: web", () => {
  test.each([
    { dep: "react", version: "^18.0.0" },
    { dep: "next", version: "^14.0.0" },
    { dep: "vue", version: "^3.0.0" },
    { dep: "nuxt", version: "^3.0.0" },
  ])("returns type: 'web' when package.json deps include $dep", async ({ dep, version }) => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ name: "myapp", dependencies: { [dep]: version } }),
      );
      const profile = await detectProjectProfile(dir, {});
      expect(profile.type).toBe("web");
    });
  });
});

// ---------------------------------------------------------------------------
// Type detection — api
// ---------------------------------------------------------------------------

describe("detectProjectProfile — type: api", () => {
  test.each([
    { dep: "express", version: "^4.0.0" },
    { dep: "fastify", version: "^4.0.0" },
    { dep: "hono", version: "^4.0.0" },
  ])("returns type: 'api' when package.json deps include $dep", async ({ dep, version }) => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ name: "myapp", dependencies: { [dep]: version } }),
      );
      const profile = await detectProjectProfile(dir, {});
      expect(profile.type).toBe("api");
    });
  });

  test("web deps take priority over api deps", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({
          name: "myapp",
          dependencies: { react: "^18.0.0", express: "^4.0.0" },
        }),
      );
      const profile = await detectProjectProfile(dir, {});
      expect(profile.type).toBe("web");
    });
  });
});

// ---------------------------------------------------------------------------
// Type detection — cli
// ---------------------------------------------------------------------------

describe("detectProjectProfile — type: cli", () => {
  test.each([
    ["object", { myapp: "./dist/cli.js" }],
    ["string", "./dist/cli.js"],
  ] as const)("returns type: 'cli' when bin is %s and no web deps", async (_form, bin) => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "myapp", bin }));
      const profile = await detectProjectProfile(dir, {});
      expect(profile.type).toBe("cli");
    });
  });

  test("web type takes priority over cli when both signals present", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({
          name: "myapp",
          bin: "./dist/cli.js",
          dependencies: { react: "^18.0.0" },
        }),
      );
      const profile = await detectProjectProfile(dir, {});
      expect(profile.type).toBe("web");
    });
  });
});

// ---------------------------------------------------------------------------
// Type detection — monorepo
// ---------------------------------------------------------------------------

describe("detectProjectProfile — type: monorepo", () => {
  test.each([
    ["array", ["packages/*"]],
    ["object", { packages: ["packages/*"] }],
  ] as const)("returns type: 'monorepo' when workspaces is %s", async (_form, workspaces) => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "myapp", workspaces }));
      const profile = await detectProjectProfile(dir, {});
      expect(profile.type).toBe("monorepo");
    });
  });

  test("monorepo takes priority over web type when both signals present", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({
          name: "myapp",
          workspaces: ["packages/*"],
          dependencies: { react: "^18.0.0" },
        }),
      );
      const profile = await detectProjectProfile(dir, {});
      expect(profile.type).toBe("monorepo");
    });
  });
});

// ---------------------------------------------------------------------------
// Type detection — tui
// ---------------------------------------------------------------------------

describe("detectProjectProfile — type: tui", () => {
  test("returns type: 'tui' when package.json deps include ink", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ name: "myapp", dependencies: { ink: "^4.0.0" } }),
      );
      const profile = await detectProjectProfile(dir, {});
      expect(profile.type).toBe("tui");
    });
  });
});

// ---------------------------------------------------------------------------
// Test framework inference from deps
// ---------------------------------------------------------------------------

describe("detectProjectProfile — testFramework inference from deps", () => {
  test.each([
    ["jest", "^29.0.0"],
    ["vitest", "^1.0.0"],
  ] as const)("returns testFramework: '%s' when %s is in devDependencies", async (dep, version) => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "myapp", devDependencies: { [dep]: version } }));
      const profile = await detectProjectProfile(dir, {});
      expect(profile.testFramework).toBe(dep);
    });
  });

  test("returns testFramework: 'cargo-test' when language is rust", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "Cargo.toml"),
        '[package]\nname = "myapp"\nversion = "0.1.0"\n',
      );
      const profile = await detectProjectProfile(dir, {});
      expect(profile.testFramework).toBe("cargo-test");
    });
  });
});

// ---------------------------------------------------------------------------
// Lint tool inference from config files
// ---------------------------------------------------------------------------

describe("detectProjectProfile — lintTool inference from config files", () => {
  test.each([
    ["biome", "biome.json", JSON.stringify({ $schema: "./node_modules/@biomejs/biome/configuration_schema.json" })],
    ["eslint", ".eslintrc", JSON.stringify({ rules: {} })],
  ] as const)("returns lintTool: '%s' when config file exists", async (lintTool, configFile, configContent) => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "myapp" }));
      await Bun.write(join(dir, configFile), configContent);
      const profile = await detectProjectProfile(dir, {});
      expect(profile.lintTool).toBe(lintTool);
    });
  });

  test("returns lintTool: 'clippy' when language is rust", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "Cargo.toml"),
        '[package]\nname = "myapp"\nversion = "0.1.0"\n',
      );
      const profile = await detectProjectProfile(dir, {});
      expect(profile.lintTool).toBe("clippy");
    });
  });
});

// ---------------------------------------------------------------------------
// Existing values are respected (override / partial existing)
// ---------------------------------------------------------------------------

describe("detectProjectProfile — respects existing overrides", () => {
  test("does not overwrite type when already set in existing", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "myapp", dependencies: { react: "^18.0.0" } }));
      const profile = await detectProjectProfile(dir, { type: "api" });
      expect(profile.type).toBe("api");
    });
  });

  test.each([
    ["language", { language: "typescript" } as object, (p: Awaited<ReturnType<typeof detectProjectProfile>>) => p.language, "typescript"],
    ["testFramework", { testFramework: "custom-test" } as object, (p: Awaited<ReturnType<typeof detectProjectProfile>>) => p.testFramework, "custom-test"],
    ["lintTool", { lintTool: "custom-lint" } as object, (p: Awaited<ReturnType<typeof detectProjectProfile>>) => p.lintTool, "custom-lint"],
  ])("does not overwrite %s when already set in existing", async (_field, existing, getField, expected) => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "go.mod"), "module example.com/myapp\n\ngo 1.21\n");
      const profile = await detectProjectProfile(dir, existing);
      expect(getField(profile)).toBe(expected);
    });
  });

  test("detects unset fields while preserving set ones", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "go.mod"), "module example.com/myapp\n\ngo 1.21\n");
      const profile = await detectProjectProfile(dir, { language: "rust" });
      // language preserved, but testFramework and lintTool still auto-detected for go
      expect(profile.language).toBe("rust");
      // testFramework and lintTool should still be detected (they were not set)
      expect(profile.testFramework).toBeDefined();
      expect(profile.lintTool).toBeDefined();
    });
  });

  test("(AC-3) returns exact fields: language=go, type=cli with auto-detected testFramework and lintTool", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "go.mod"), "module example.com/myapp\n\ngo 1.21\n");
      const profile = await detectProjectProfile(dir, { language: "go", type: "cli" });
      expect(profile.language).toBe("go");
      expect(profile.type).toBe("cli");
      expect(profile.testFramework).toBe("go-test");
      expect(profile.lintTool).toBe("golangci-lint");
    });
  });
});

// ---------------------------------------------------------------------------
// Empty / unknown workdir
// ---------------------------------------------------------------------------

describe("detectProjectProfile — no manifest files", () => {
  test("returns defined object when no manifest files found", async () => {
    await withTempDir(async (dir) => {
      const profile = await detectProjectProfile(dir, {});
      expect(profile).toBeDefined();
      expect(typeof profile).toBe("object");
    });
  });

  test("language is undefined when no manifest files found", async () => {
    await withTempDir(async (dir) => {
      const profile = await detectProjectProfile(dir, {});
      expect(profile.language).toBeUndefined();
    });
  });
});
