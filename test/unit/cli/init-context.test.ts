/**
 * Unit tests for src/cli/init-context.ts (INIT-002)
 *
 * Tests filesystem scanning, template generation, LLM-powered generation,
 * and initContext orchestration. All tests must fail until init-context.ts
 * is implemented.
 */

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

  test.each([
    ["node_modules", "node_modules/some-pkg/index.js"],
    [".git", ".git/config"],
    ["dist", "dist/bundle.js"],
  ])("excludes %s directory from file tree", async (excludedDir, fileToWrite) => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, fileToWrite), "");
      await Bun.write(join(dir, "src", "index.ts"), "export {}");
      const scan = await scanProject(dir);
      expect(scan.fileTree.some((f) => f.includes(excludedDir))).toBe(false);
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
  test.each([
    ["name", { name: "my-project", version: "1.0.0" }, (m: any) => m?.name, "my-project"],
    ["description", { name: "my-project", description: "A test project" }, (m: any) => m?.description, "A test project"],
    ["scripts.build", { name: "proj", scripts: { build: "bun run build" } }, (m: any) => m?.scripts?.build, "bun run build"],
    ["dependencies.zod", { name: "proj", dependencies: { zod: "^3.0.0" } }, (m: any) => m?.dependencies?.zod, "^3.0.0"],
  ] as const)("reads %s from package.json", async (_field, pkgJson, getField, expected) => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "package.json"), JSON.stringify(pkgJson));
      const scan = await scanProject(dir);
      expect(getField(scan.packageManifest)).toBe(expected);
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

  test("returns null readmeSnippet when absent; full content when short README present", async () => {
    await withTempDir(async (dir) => {
      expect((await scanProject(dir)).readmeSnippet).toBeNull();
    });
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "README.md"), "# Short readme\n\nTwo lines.");
      expect((await scanProject(dir)).readmeSnippet).toContain("Short readme");
    });
  });
});

// ---------------------------------------------------------------------------
// scanProject — entry points
// ---------------------------------------------------------------------------

describe("scanProject — entry points", () => {
  test.each([
    ["src/index.ts", "export {}"],
    ["src/main.ts", ""],
    ["main.go", "package main"],
    ["src/lib.rs", ""],
  ])("detects %s as entry point", async (file, content) => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, file), content);
      const scan = await scanProject(dir);
      expect(scan.entryPoints).toContain(file);
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
  test.each([
    ["tsconfig.json", "{}"],
    ["biome.json", "{}"],
    ["turbo.json", "{}"],
    [".env.example", "API_KEY="],
  ])("lists %s when present", async (file, content) => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, file), content);
      const scan = await scanProject(dir);
      expect(scan.configFiles).toContain(file);
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
  test("returns non-empty markdown string with heading and project name", () => {
    const result = generateContextTemplate({
      projectName: "my-awesome-project",
      fileTree: ["src/index.ts", "package.json"],
      packageManifest: null,
      readmeSnippet: null,
      entryPoints: [],
      configFiles: [],
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/^#+ /m);
    expect(result).toContain("my-awesome-project");
  });

  test("includes file tree and entry points in output", () => {
    const result = generateContextTemplate({
      projectName: "proj",
      fileTree: ["src/index.ts", "package.json"],
      packageManifest: null,
      readmeSnippet: null,
      entryPoints: ["src/main.ts"],
      configFiles: [],
    });
    expect(result).toContain("src/index.ts");
    expect(result).toContain("package.json");
    expect(result).toContain("src/main.ts");
  });

  test("includes TODO when data missing; includes config files when present", () => {
    const emptyResult = generateContextTemplate({ projectName: "proj", fileTree: [], packageManifest: null, readmeSnippet: null, entryPoints: [], configFiles: [] });
    expect(emptyResult).toContain("TODO");
    const withConfig = generateContextTemplate({ projectName: "proj", fileTree: [], packageManifest: null, readmeSnippet: null, entryPoints: [], configFiles: ["tsconfig.json", "biome.json"] });
    expect(withConfig).toContain("tsconfig.json");
    expect(withConfig).toContain("biome.json");
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

});

// ---------------------------------------------------------------------------
// initContext — context.md creation
// ---------------------------------------------------------------------------

describe("initContext — creates context.md from template", () => {
  test("creates .nax/ directory and non-empty context.md when they do not exist", async () => {
    await withTempDir(async (dir) => {
      await initContext(dir, { ai: false });

      expect(await Bun.file(join(dir, ".nax", "context.md")).exists()).toBe(true);
      const content = await Bun.file(join(dir, ".nax", "context.md")).text();
      expect(content.length).toBeGreaterThan(0);
    });
  });

  test.each([
    [false, true],
    [true, false],
  ] as const)("force=%s: content unchanged=%s when context.md exists", async (force, contentUnchanged) => {
    await withTempDir(async (dir) => {
      const contextPath = join(dir, ".nax", "context.md");
      await Bun.write(contextPath, "EXISTING_CONTENT");

      await initContext(dir, { ai: false, ...(force ? { force } : {}) });

      const content = await Bun.file(contextPath).text();
      if (contentUnchanged) {
        expect(content).toBe("EXISTING_CONTENT");
      } else {
        expect(content).not.toBe("EXISTING_CONTENT");
      }
    });
  });

  test("template includes project name and detected entry points", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "scan-test-proj" }));
      await Bun.write(join(dir, "src", "index.ts"), "export {}");
      await initContext(dir, { ai: false });
      const content = await Bun.file(join(dir, ".nax", "context.md")).text();
      expect(content).toContain("scan-test-proj");
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
        expect(await Bun.file(join(dir, ".nax", "context.md")).exists()).toBe(true);

        const content = await Bun.file(join(dir, ".nax", "context.md")).text();
        expect(content.length).toBeGreaterThan(0);
      } finally {
        mod._initContextDeps.callLLM = original;
      }
    });
  });

  test.each([
    [true, 1],
    [false, 0],
  ] as const)("calls LLM %d time(s) when ai=%s", async (ai, expectedCalls) => {
    await withTempDir(async (dir) => {
      const mod = await import("../../../src/cli/init-context");
      const original = mod._initContextDeps.callLLM;
      const callLLMMock = mock(async () => "# AI output");
      mod._initContextDeps.callLLM = callLLMMock;
      try {
        await mod.initContext(dir, { ai });
        expect(callLLMMock).toHaveBeenCalledTimes(expectedCalls);
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

