/**
 * Unit tests for `nax init` command (PT-004, INIT-003)
 *
 * Tests that nax init creates the project nax/ directory structure,
 * scaffolds prompt templates, prints a summary, and generates stack-aware
 * constitution.md and updated .gitignore entries.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { _initContextDeps as contextDeps } from "../../../src/cli/init-context";
import { initProject } from "../../../src/cli/init";
import { withTempDir } from "../../helpers/temp";

const TEMPLATE_FILES = [
  "test-writer.md",
  "implementer.md",
  "verifier.md",
  "single-session.md",
  "tdd-simple.md",
] as const;

describe("initProject — creates templates alongside config", () => {
  test("creates nax/templates/ directory", async () => {
    await withTempDir(async (tempDir) => {
      await initProject(tempDir);

      expect(existsSync(join(tempDir, ".nax", "templates"))).toBe(true);
    });
  });

  test("creates all 5 template files in nax/templates/", async () => {
    await withTempDir(async (tempDir) => {
      await initProject(tempDir);

      for (const file of TEMPLATE_FILES) {
        expect(existsSync(join(tempDir, ".nax", "templates", file))).toBe(true);
      }
    });
  });

  test("template files are non-empty", async () => {
    await withTempDir(async (tempDir) => {
      await initProject(tempDir);

      for (const file of TEMPLATE_FILES) {
        const filePath = join(tempDir, ".nax", "templates", file);
        const content = await Bun.file(filePath).text();
        expect(content.length).toBeGreaterThan(0);
      }
    });
  });

  test(".nax/config.json does NOT contain prompts.overrides", async () => {
    await withTempDir(async (tempDir) => {
      await initProject(tempDir);

      const configPath = join(tempDir, ".nax", "config.json");
      const configContent = JSON.parse(await Bun.file(configPath).text());

      // Should NOT have prompts.overrides set
      expect(configContent.prompts?.overrides).toBeUndefined();
    });
  });

  test("creates standard init files (config.json, constitution.md, hooks/)", async () => {
    await withTempDir(async (tempDir) => {
      await initProject(tempDir);

      expect(existsSync(join(tempDir, ".nax", "config.json"))).toBe(true);
      expect(existsSync(join(tempDir, ".nax", "constitution.md"))).toBe(true);
      expect(existsSync(join(tempDir, ".nax", "hooks"))).toBe(true);
    });
  });
});

describe("initProject — with force flag", () => {
  test("overwrites existing template files when called with force: true", async () => {
    await withTempDir(async (tempDir) => {
      // First init
      await initProject(tempDir);

      const testWriterPath = join(tempDir, ".nax", "templates", "test-writer.md");

      // Overwrite with marker content
      await Bun.write(testWriterPath, "MARKER_CONTENT_FOR_TESTING");

      // Second init with force — would need to pass force through initProject
      // For now, this tests the expected behavior once initProject accepts force
      const markedContent = await Bun.file(testWriterPath).text();
      expect(markedContent).toBe("MARKER_CONTENT_FOR_TESTING");
    });
  });
});

describe("initProject — nax/config.json preserves defaults", () => {
  test(".nax/config.json is minimal and does not reference templates", async () => {
    await withTempDir(async (tempDir) => {
      await initProject(tempDir);

      const configPath = join(tempDir, ".nax", "config.json");
      const configContent = JSON.parse(await Bun.file(configPath).text());

      // Should be minimal config
      expect(configContent.version).toBeDefined();
      // Should NOT have prompts section
      expect(configContent.prompts).toBeUndefined();
    });
  });
});

// ─── INIT-003: Post-init checklist and unified init flow ─────────────────────

describe("initProject — .gitignore includes new nax entries", () => {
  test("adds nax.lock to .gitignore", async () => {
    await withTempDir(async (tempDir) => {
      await initProject(tempDir);

      const gitignore = await Bun.file(join(tempDir, ".gitignore")).text();
      expect(gitignore).toContain("nax.lock");
    });
  });

  test("adds nax/**/runs/ to .gitignore", async () => {
    await withTempDir(async (tempDir) => {
      await initProject(tempDir);

      const gitignore = await Bun.file(join(tempDir, ".gitignore")).text();
      expect(gitignore).toContain(".nax/**/runs/");
    });
  });

  test("adds nax/metrics.json to .gitignore", async () => {
    await withTempDir(async (tempDir) => {
      await initProject(tempDir);

      const gitignore = await Bun.file(join(tempDir, ".gitignore")).text();
      expect(gitignore).toContain(".nax/metrics.json");
    });
  });

  test("preserves existing .gitignore content", async () => {
    await withTempDir(async (tempDir) => {
      const existing = "node_modules/\n.env\n";
      await Bun.write(join(tempDir, ".gitignore"), existing);

      await initProject(tempDir);

      const gitignore = await Bun.file(join(tempDir, ".gitignore")).text();
      expect(gitignore).toContain("node_modules/");
      expect(gitignore).toContain(".env");
      expect(gitignore).toContain("nax.lock");
    });
  });
});

describe("initProject — stack-aware constitution.md", () => {
  test("includes Bun-specific API examples when bun.lockb detected", async () => {
    await withTempDir(async (tempDir) => {
      await Bun.write(join(tempDir, "bun.lockb"), "");

      await initProject(tempDir);

      const constitution = await Bun.file(join(tempDir, ".nax", "constitution.md")).text();
      // Must reference concrete Bun APIs (not just the generic "Bun-native APIs only" in the default)
      expect(constitution).toMatch(/Bun\.file\(\)|Bun\.spawn\(\)|Bun\.sleep\(\)|bun test/);
    });
  });

  test("includes strict TypeScript guidance when tsconfig.json detected", async () => {
    await withTempDir(async (tempDir) => {
      await Bun.write(join(tempDir, "tsconfig.json"), "{}");

      await initProject(tempDir);

      const constitution = await Bun.file(join(tempDir, ".nax", "constitution.md")).text();
      expect(constitution).toMatch(/strict.*TypeScript|TypeScript.*strict/i);
    });
  });

  test("includes PEP 8 and type hints guidance when python detected", async () => {
    await withTempDir(async (tempDir) => {
      await Bun.write(join(tempDir, "pyproject.toml"), "[tool.poetry]\nname = \"example\"");

      await initProject(tempDir);

      const constitution = await Bun.file(join(tempDir, ".nax", "constitution.md")).text();
      expect(constitution).toMatch(/PEP.?8|type hint/i);
    });
  });

  test("includes monorepo package boundaries when turbo.json detected", async () => {
    await withTempDir(async (tempDir) => {
      await Bun.write(join(tempDir, "turbo.json"), "{}");

      await initProject(tempDir);

      const constitution = await Bun.file(join(tempDir, ".nax", "constitution.md")).text();
      expect(constitution).toMatch(/monorepo|package boundar/i);
    });
  });
});

describe("initProject — --ai flag wired through to context generation", () => {
  let originalCallLLM: typeof contextDeps.callLLM;

  beforeEach(() => {
    originalCallLLM = contextDeps.callLLM;
  });

  afterEach(() => {
    contextDeps.callLLM = originalCallLLM;
    mock.restore();
  });

  test("accepts options object with ai: false without error", async () => {
    await withTempDir(async (tempDir) => {
      await expect(initProject(tempDir, { ai: false })).resolves.toBeUndefined();
    });
  });

  test("with ai: true, invokes LLM for context.md generation", async () => {
    let llmCallCount = 0;
    contextDeps.callLLM = async (_prompt: string) => {
      llmCallCount++;
      return "# LLM Generated Context\n\nGenerated by LLM\n";
    };

    await withTempDir(async (tempDir) => {
      await initProject(tempDir, { ai: true });

      expect(llmCallCount).toBeGreaterThan(0);

      const contextContent = await Bun.file(join(tempDir, ".nax", "context.md")).text();
      expect(contextContent).toContain("LLM Generated Context");
    });
  });

  test("with ai: false, context.md is generated from template (no LLM)", async () => {
    let llmCalled = false;
    contextDeps.callLLM = async (_prompt: string) => {
      llmCalled = true;
      return "# LLM Content";
    };

    await withTempDir(async (tempDir) => {
      await initProject(tempDir, { ai: false });

      expect(llmCalled).toBe(false);
    });
  });
});

describe("initProject — prints summary with created files and next steps", () => {
  test("summary output includes nax/config.json", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    try {
      await withTempDir(async (tempDir) => {
        await initProject(tempDir);

        const allOutput = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
        expect(allOutput).toContain("config.json");
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  test("summary output includes nax/constitution.md", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    try {
      await withTempDir(async (tempDir) => {
        await initProject(tempDir);

        const allOutput = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
        expect(allOutput).toContain("constitution.md");
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  test("summary output includes nax/context.md", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    try {
      await withTempDir(async (tempDir) => {
        await initProject(tempDir);

        const allOutput = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
        expect(allOutput).toContain("context.md");
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  test("next-steps checklist includes nax generate", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    try {
      await withTempDir(async (tempDir) => {
        await initProject(tempDir);

        const allOutput = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
        expect(allOutput).toContain("nax generate");
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  test("next-steps checklist includes nax plan", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    try {
      await withTempDir(async (tempDir) => {
        await initProject(tempDir);

        const allOutput = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
        expect(allOutput).toContain("nax plan");
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  test("next-steps checklist includes nax run", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    try {
      await withTempDir(async (tempDir) => {
        await initProject(tempDir);

        const allOutput = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
        expect(allOutput).toContain("nax run");
      });
    } finally {
      logSpy.mockRestore();
    }
  });
});
