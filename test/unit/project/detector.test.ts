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

  test("returns testFramework: 'go-test' when language resolves to go", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "go.mod"), "module example.com/myapp\n\ngo 1.21\n");
      const profile = await detectProjectProfile(dir, {});
      expect(profile.testFramework).toBe("go-test");
    });
  });

  test("returns lintTool: 'golangci-lint' when language resolves to go", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "go.mod"), "module example.com/myapp\n\ngo 1.21\n");
      const profile = await detectProjectProfile(dir, {});
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
  test("returns language: 'typescript' when package.json has typescript in devDependencies", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ name: "myapp", devDependencies: { typescript: "^5.0.0" } }),
      );
      const profile = await detectProjectProfile(dir, {});
      expect(profile.language).toBe("typescript");
    });
  });

  test("returns language: 'typescript' when package.json has typescript in dependencies", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ name: "myapp", dependencies: { typescript: "^5.0.0" } }),
      );
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

  test("returns testFramework: 'pytest' when language resolves to python", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "pyproject.toml"), "[build-system]\n");
      const profile = await detectProjectProfile(dir, {});
      expect(profile.testFramework).toBe("pytest");
    });
  });

  test("returns lintTool: 'ruff' when language resolves to python", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "pyproject.toml"), "[build-system]\n");
      const profile = await detectProjectProfile(dir, {});
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
  test("returns type: 'web' when package.json deps include react", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ name: "myapp", dependencies: { react: "^18.0.0" } }),
      );
      const profile = await detectProjectProfile(dir, {});
      expect(profile.type).toBe("web");
    });
  });

  test("returns type: 'web' when package.json deps include next", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ name: "myapp", dependencies: { next: "^14.0.0" } }),
      );
      const profile = await detectProjectProfile(dir, {});
      expect(profile.type).toBe("web");
    });
  });

  test("returns type: 'web' when package.json deps include vue", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ name: "myapp", dependencies: { vue: "^3.0.0" } }),
      );
      const profile = await detectProjectProfile(dir, {});
      expect(profile.type).toBe("web");
    });
  });

  test("returns type: 'web' when package.json deps include nuxt", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ name: "myapp", dependencies: { nuxt: "^3.0.0" } }),
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
  test("returns type: 'api' when package.json deps include express", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ name: "myapp", dependencies: { express: "^4.0.0" } }),
      );
      const profile = await detectProjectProfile(dir, {});
      expect(profile.type).toBe("api");
    });
  });

  test("returns type: 'api' when package.json deps include fastify", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ name: "myapp", dependencies: { fastify: "^4.0.0" } }),
      );
      const profile = await detectProjectProfile(dir, {});
      expect(profile.type).toBe("api");
    });
  });

  test("returns type: 'api' when package.json deps include hono", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ name: "myapp", dependencies: { hono: "^4.0.0" } }),
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
  test("returns type: 'cli' when package.json has a bin field and no web deps", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ name: "myapp", bin: { myapp: "./dist/cli.js" } }),
      );
      const profile = await detectProjectProfile(dir, {});
      expect(profile.type).toBe("cli");
    });
  });

  test("returns type: 'cli' when package.json bin is a string and no web deps", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ name: "myapp", bin: "./dist/cli.js" }),
      );
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
  test("returns type: 'monorepo' when package.json has a workspaces array", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ name: "myapp", workspaces: ["packages/*"] }),
      );
      const profile = await detectProjectProfile(dir, {});
      expect(profile.type).toBe("monorepo");
    });
  });

  test("returns type: 'monorepo' when package.json has a workspaces object", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ name: "myapp", workspaces: { packages: ["packages/*"] } }),
      );
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
  test("returns testFramework: 'jest' when jest is in devDependencies", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ name: "myapp", devDependencies: { jest: "^29.0.0" } }),
      );
      const profile = await detectProjectProfile(dir, {});
      expect(profile.testFramework).toBe("jest");
    });
  });

  test("returns testFramework: 'vitest' when vitest is in devDependencies", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ name: "myapp", devDependencies: { vitest: "^1.0.0" } }),
      );
      const profile = await detectProjectProfile(dir, {});
      expect(profile.testFramework).toBe("vitest");
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
  test("returns lintTool: 'biome' when biome.json exists", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "myapp" }));
      await Bun.write(join(dir, "biome.json"), JSON.stringify({ $schema: "./node_modules/@biomejs/biome/configuration_schema.json" }));
      const profile = await detectProjectProfile(dir, {});
      expect(profile.lintTool).toBe("biome");
    });
  });

  test("returns lintTool: 'eslint' when .eslintrc exists", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "myapp" }));
      await Bun.write(join(dir, ".eslintrc"), JSON.stringify({ rules: {} }));
      const profile = await detectProjectProfile(dir, {});
      expect(profile.lintTool).toBe("eslint");
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
  test("does not overwrite language when already set in existing", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "go.mod"), "module example.com/myapp\n\ngo 1.21\n");
      const profile = await detectProjectProfile(dir, { language: "typescript" });
      expect(profile.language).toBe("typescript");
    });
  });

  test("does not overwrite type when already set in existing", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ name: "myapp", dependencies: { react: "^18.0.0" } }),
      );
      const profile = await detectProjectProfile(dir, { type: "api" });
      expect(profile.type).toBe("api");
    });
  });

  test("does not overwrite testFramework when already set in existing", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "go.mod"), "module example.com/myapp\n\ngo 1.21\n");
      const profile = await detectProjectProfile(dir, { testFramework: "custom-test" });
      expect(profile.testFramework).toBe("custom-test");
    });
  });

  test("does not overwrite lintTool when already set in existing", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "go.mod"), "module example.com/myapp\n\ngo 1.21\n");
      const profile = await detectProjectProfile(dir, { lintTool: "custom-lint" });
      expect(profile.lintTool).toBe("custom-lint");
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
