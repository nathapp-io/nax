/**
 * Unit tests for src/cli/init-context.ts (INIT-002)
 *
 * Tests filesystem scanning, template generation, LLM-powered generation,
 * and initContext orchestration. All tests must fail until init-context.ts
 * is implemented.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";
import {
  generateContextTemplate,
  initContext,
  scanProject,
} from "../../../src/cli/init-context";
import { withTempDir } from "../../helpers/temp";

// ---------------------------------------------------------------------------
// scanProject — file tree
// ---------------------------------------------------------------------------

describe("scanProject — file tree", () => {
  test("returns file paths relative to project root", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "src", "index.ts"), "export {}");
      await Bun.write(join(dir, "package.json"), "{}");

      const scan = await scanProject(dir);

      expect(scan.fileTree.some((f) => f.includes("package.json"))).toBe(true);
    });
  });

  test("excludes node_modules from file tree", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "node_modules", "some-pkg", "index.js"), "");
      await Bun.write(join(dir, "src", "index.ts"), "export {}");

      const scan = await scanProject(dir);

      expect(scan.fileTree.some((f) => f.includes("node_modules"))).toBe(false);
    });
  });

  test("excludes .git directory from file tree", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, ".git", "config"), "");
      await Bun.write(join(dir, "src", "index.ts"), "export {}");

      const scan = await scanProject(dir);

      expect(scan.fileTree.some((f) => f.includes(".git"))).toBe(false);
    });
  });

  test("excludes dist directory from file tree", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "dist", "bundle.js"), "");
      await Bun.write(join(dir, "src", "index.ts"), "export {}");

      const scan = await scanProject(dir);

      expect(scan.fileTree.some((f) => f.includes("dist"))).toBe(false);
    });
  });

  test("limits file tree to 200 entries", async () => {
    await withTempDir(async (dir) => {
      for (let i = 0; i < 250; i++) {
        await Bun.write(join(dir, `file-${i}.ts`), "");
      }

      const scan = await scanProject(dir);

      expect(scan.fileTree.length).toBeLessThanOrEqual(200);
    });
  });
});

// ---------------------------------------------------------------------------
// scanProject — package manifest
// ---------------------------------------------------------------------------

describe("scanProject — package manifest", () => {
  test("reads name from package.json", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ name: "my-project", version: "1.0.0" }),
      );

      const scan = await scanProject(dir);

      expect(scan.packageManifest?.name).toBe("my-project");
    });
  });

  test("reads description from package.json", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ name: "my-project", description: "A test project" }),
      );

      const scan = await scanProject(dir);

      expect(scan.packageManifest?.description).toBe("A test project");
    });
  });

  test("reads scripts from package.json", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ name: "proj", scripts: { build: "bun run build", test: "bun test" } }),
      );

      const scan = await scanProject(dir);

      expect(scan.packageManifest?.scripts?.build).toBe("bun run build");
    });
  });

  test("reads dependencies from package.json", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ name: "proj", dependencies: { zod: "^3.0.0" } }),
      );

      const scan = await scanProject(dir);

      expect(scan.packageManifest?.dependencies?.zod).toBe("^3.0.0");
    });
  });

  test("returns null packageManifest when no package.json", async () => {
    await withTempDir(async (dir) => {
      const scan = await scanProject(dir);

      expect(scan.packageManifest).toBeNull();
    });
  });

  test("derives projectName from package.json name", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "my-app" }));

      const scan = await scanProject(dir);

      expect(scan.projectName).toBe("my-app");
    });
  });

  test("falls back to directory name when no package.json", async () => {
    await withTempDir(async (dir) => {
      const scan = await scanProject(dir);

      // Should use the basename of the temp directory
      expect(scan.projectName).toBeTruthy();
      expect(typeof scan.projectName).toBe("string");
    });
  });
});

// ---------------------------------------------------------------------------
// scanProject — README
// ---------------------------------------------------------------------------

describe("scanProject — README", () => {
  test("reads first 100 lines of README.md", async () => {
    await withTempDir(async (dir) => {
      const lines = Array.from({ length: 120 }, (_, i) => `Line ${i + 1}`);
      await Bun.write(join(dir, "README.md"), lines.join("\n"));

      const scan = await scanProject(dir);

      const snippetLines = scan.readmeSnippet?.split("\n") ?? [];
      expect(snippetLines.length).toBeLessThanOrEqual(100);
    });
  });

  test("returns null readmeSnippet when no README.md", async () => {
    await withTempDir(async (dir) => {
      const scan = await scanProject(dir);

      expect(scan.readmeSnippet).toBeNull();
    });
  });

  test("returns full content when README.md is under 100 lines", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "README.md"), "# Short readme\n\nTwo lines.");

      const scan = await scanProject(dir);

      expect(scan.readmeSnippet).toContain("Short readme");
    });
  });
});

// ---------------------------------------------------------------------------
// scanProject — entry points
// ---------------------------------------------------------------------------

describe("scanProject — entry points", () => {
  test("detects src/index.ts as entry point", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "src", "index.ts"), "export {}");

      const scan = await scanProject(dir);

      expect(scan.entryPoints).toContain("src/index.ts");
    });
  });

  test("detects src/main.ts as entry point", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "src", "main.ts"), "");

      const scan = await scanProject(dir);

      expect(scan.entryPoints).toContain("src/main.ts");
    });
  });

  test("detects main.go as entry point", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "main.go"), "package main");

      const scan = await scanProject(dir);

      expect(scan.entryPoints).toContain("main.go");
    });
  });

  test("detects src/lib.rs as entry point", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "src", "lib.rs"), "");

      const scan = await scanProject(dir);

      expect(scan.entryPoints).toContain("src/lib.rs");
    });
  });

  test("returns empty array when no entry points found", async () => {
    await withTempDir(async (dir) => {
      const scan = await scanProject(dir);

      expect(scan.entryPoints).toEqual([]);
    });
  });

  test("detects multiple entry points when present", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "src", "index.ts"), "export {}");
      await Bun.write(join(dir, "src", "main.ts"), "");

      const scan = await scanProject(dir);

      expect(scan.entryPoints).toContain("src/index.ts");
      expect(scan.entryPoints).toContain("src/main.ts");
    });
  });
});

// ---------------------------------------------------------------------------
// scanProject — config files
// ---------------------------------------------------------------------------

describe("scanProject — config files", () => {
  test("lists tsconfig.json when present", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "tsconfig.json"), "{}");

      const scan = await scanProject(dir);

      expect(scan.configFiles).toContain("tsconfig.json");
    });
  });

  test("lists biome.json when present", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "biome.json"), "{}");

      const scan = await scanProject(dir);

      expect(scan.configFiles).toContain("biome.json");
    });
  });

  test("lists turbo.json when present", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "turbo.json"), "{}");

      const scan = await scanProject(dir);

      expect(scan.configFiles).toContain("turbo.json");
    });
  });

  test("lists .env.example when present", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, ".env.example"), "API_KEY=");

      const scan = await scanProject(dir);

      expect(scan.configFiles).toContain(".env.example");
    });
  });

  test("returns empty array when no config files present", async () => {
    await withTempDir(async (dir) => {
      const scan = await scanProject(dir);

      expect(scan.configFiles).toEqual([]);
    });
  });

  test("only lists names, not file contents", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "tsconfig.json"), '{"compilerOptions": {}}');

      const scan = await scanProject(dir);

      // configFiles should only have the name, not any file content
      expect(scan.configFiles).toContain("tsconfig.json");
      expect(scan.configFiles.join("")).not.toContain("compilerOptions");
    });
  });
});

// ---------------------------------------------------------------------------
// generateContextTemplate — output structure
// ---------------------------------------------------------------------------

describe("generateContextTemplate — output structure", () => {
  test("returns a non-empty markdown string", () => {
    const scan = {
      projectName: "test-project",
      fileTree: ["src/index.ts", "package.json"],
      packageManifest: null,
      readmeSnippet: null,
      entryPoints: [],
      configFiles: [],
    };

    const result = generateContextTemplate(scan);

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("includes project name in output", () => {
    const scan = {
      projectName: "my-awesome-project",
      fileTree: [],
      packageManifest: null,
      readmeSnippet: null,
      entryPoints: [],
      configFiles: [],
    };

    const result = generateContextTemplate(scan);

    expect(result).toContain("my-awesome-project");
  });

  test("includes file tree section in output", () => {
    const scan = {
      projectName: "proj",
      fileTree: ["src/index.ts", "package.json"],
      packageManifest: null,
      readmeSnippet: null,
      entryPoints: [],
      configFiles: [],
    };

    const result = generateContextTemplate(scan);

    expect(result).toContain("src/index.ts");
    expect(result).toContain("package.json");
  });

  test("includes entry points in output", () => {
    const scan = {
      projectName: "proj",
      fileTree: [],
      packageManifest: null,
      readmeSnippet: null,
      entryPoints: ["src/index.ts", "src/main.ts"],
      configFiles: [],
    };

    const result = generateContextTemplate(scan);

    expect(result).toContain("src/index.ts");
    expect(result).toContain("src/main.ts");
  });

  test("includes TODO placeholders where data is missing", () => {
    const scan = {
      projectName: "proj",
      fileTree: [],
      packageManifest: null,
      readmeSnippet: null,
      entryPoints: [],
      configFiles: [],
    };

    const result = generateContextTemplate(scan);

    expect(result).toContain("TODO");
  });

  test("includes package description when packageManifest has description", () => {
    const scan = {
      projectName: "proj",
      fileTree: [],
      packageManifest: {
        name: "proj",
        description: "A fantastic library for testing",
        scripts: {},
        dependencies: {},
      },
      readmeSnippet: null,
      entryPoints: [],
      configFiles: [],
    };

    const result = generateContextTemplate(scan);

    expect(result).toContain("A fantastic library for testing");
  });

  test("includes config files section when config files detected", () => {
    const scan = {
      projectName: "proj",
      fileTree: [],
      packageManifest: null,
      readmeSnippet: null,
      entryPoints: [],
      configFiles: ["tsconfig.json", "biome.json"],
    };

    const result = generateContextTemplate(scan);

    expect(result).toContain("tsconfig.json");
    expect(result).toContain("biome.json");
  });

  test("is valid markdown with at least one heading", () => {
    const scan = {
      projectName: "proj",
      fileTree: [],
      packageManifest: null,
      readmeSnippet: null,
      entryPoints: [],
      configFiles: [],
    };

    const result = generateContextTemplate(scan);

    expect(result).toMatch(/^#+ /m);
  });
});

// ---------------------------------------------------------------------------
// initContext — context.md creation
// ---------------------------------------------------------------------------

describe("initContext — creates context.md from template", () => {
  test("creates nax/context.md when it does not exist", async () => {
    await withTempDir(async (dir) => {
      await initContext(dir, { ai: false });

      expect(existsSync(join(dir, ".nax", "context.md"))).toBe(true);
    });
  });

  test(".nax/context.md is non-empty", async () => {
    await withTempDir(async (dir) => {
      await initContext(dir, { ai: false });

      const content = await Bun.file(join(dir, ".nax", "context.md")).text();
      expect(content.length).toBeGreaterThan(0);
    });
  });

  test("creates nax/ directory if it does not exist", async () => {
    await withTempDir(async (dir) => {
      await initContext(dir, { ai: false });

      expect(existsSync(join(dir, ".nax"))).toBe(true);
    });
  });

  test("does not overwrite existing context.md without --force", async () => {
    await withTempDir(async (dir) => {
      const contextPath = join(dir, ".nax", "context.md");
      await Bun.write(contextPath, "EXISTING_CONTENT");

      await initContext(dir, { ai: false });

      const content = await Bun.file(contextPath).text();
      expect(content).toBe("EXISTING_CONTENT");
    });
  });

  test("overwrites existing context.md with --force", async () => {
    await withTempDir(async (dir) => {
      const contextPath = join(dir, ".nax", "context.md");
      await Bun.write(contextPath, "EXISTING_CONTENT");

      await initContext(dir, { ai: false, force: true });

      const content = await Bun.file(contextPath).text();
      expect(content).not.toBe("EXISTING_CONTENT");
    });
  });

  test("template includes project name derived from directory", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "scan-test-proj" }));

      await initContext(dir, { ai: false });

      const content = await Bun.file(join(dir, ".nax", "context.md")).text();
      expect(content).toContain("scan-test-proj");
    });
  });

  test("template includes detected entry points", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "src", "index.ts"), "export {}");

      await initContext(dir, { ai: false });

      const content = await Bun.file(join(dir, ".nax", "context.md")).text();
      expect(content).toContain("src/index.ts");
    });
  });
});

// ---------------------------------------------------------------------------
// initContext — AI mode
// ---------------------------------------------------------------------------

describe("initContext — AI mode (--ai flag)", () => {
  test("falls back to template mode when LLM call throws", async () => {
    await withTempDir(async (dir) => {
      // Import _deps after withTempDir is called to allow overriding
      const mod = await import("../../../src/cli/init-context");
      const original = mod._initContextDeps.callLLM;

      mod._initContextDeps.callLLM = mock(async () => {
        throw new Error("LLM unavailable");
      });

      try {
        await mod.initContext(dir, { ai: true });

        // Should have fallen back — context.md must still be created
        expect(existsSync(join(dir, ".nax", "context.md"))).toBe(true);

        const content = await Bun.file(join(dir, ".nax", "context.md")).text();
        expect(content.length).toBeGreaterThan(0);
      } finally {
        mod._initContextDeps.callLLM = original;
      }
    });
  });

  test("calls LLM when --ai flag is set", async () => {
    await withTempDir(async (dir) => {
      const mod = await import("../../../src/cli/init-context");
      const original = mod._initContextDeps.callLLM;

      const callLLMMock = mock(async (_prompt: string) => "# AI Generated Context\n\nContent here.");
      mod._initContextDeps.callLLM = callLLMMock;

      try {
        await mod.initContext(dir, { ai: true });

        expect(callLLMMock).toHaveBeenCalledTimes(1);
      } finally {
        mod._initContextDeps.callLLM = original;
      }
    });
  });

  test("uses LLM output as context.md content when LLM succeeds", async () => {
    await withTempDir(async (dir) => {
      const mod = await import("../../../src/cli/init-context");
      const original = mod._initContextDeps.callLLM;

      mod._initContextDeps.callLLM = mock(async () => "# AI Generated\n\nRich narrative content.");

      try {
        await mod.initContext(dir, { ai: true });

        const content = await Bun.file(join(dir, ".nax", "context.md")).text();
        expect(content).toContain("AI Generated");
      } finally {
        mod._initContextDeps.callLLM = original;
      }
    });
  });

  test("does not call LLM when --ai flag is not set", async () => {
    await withTempDir(async (dir) => {
      const mod = await import("../../../src/cli/init-context");
      const original = mod._initContextDeps.callLLM;

      const callLLMMock = mock(async () => "# AI output");
      mod._initContextDeps.callLLM = callLLMMock;

      try {
        await mod.initContext(dir, { ai: false });

        expect(callLLMMock).not.toHaveBeenCalled();
      } finally {
        mod._initContextDeps.callLLM = original;
      }
    });
  });

  test("LLM prompt contains scan results", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "llm-test-proj" }));

      const mod = await import("../../../src/cli/init-context");
      const original = mod._initContextDeps.callLLM;

      let capturedPrompt = "";
      mod._initContextDeps.callLLM = mock(async (prompt: string) => {
        capturedPrompt = prompt;
        return "# Generated";
      });

      try {
        await mod.initContext(dir, { ai: true });

        expect(capturedPrompt).toContain("llm-test-proj");
      } finally {
        mod._initContextDeps.callLLM = original;
      }
    });
  });
});
