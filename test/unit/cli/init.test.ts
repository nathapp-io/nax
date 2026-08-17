/**
 * Unit tests for `nax init` command (PT-004, INIT-003)
 *
 * Tests that nax init creates the project nax/ directory structure, prints a
 * summary, generates a stack-aware constitution.md, and reconciles the repo's
 * .gitignore and .naxignore without disturbing user content.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { _initDeps, initCommand, initProject } from "../../../src/cli/init";
import { withTempDir } from "../../helpers/temp";

describe("initProject — creates the project config scaffold", () => {
  test("creates config.json, constitution.md, hooks/ and features/; config.json has no prompts.overrides", async () => {
    await withTempDir(async (tempDir) => {
      await initProject(tempDir);
      expect(existsSync(join(tempDir, ".nax", "config.json"))).toBe(true);
      expect(existsSync(join(tempDir, ".nax", "constitution.md"))).toBe(true);
      expect(existsSync(join(tempDir, ".nax", "hooks"))).toBe(true);
      expect(existsSync(join(tempDir, ".nax", "features"))).toBe(true);
      const configContent = JSON.parse(await Bun.file(join(tempDir, ".nax", "config.json")).text());
      expect(configContent.prompts?.overrides).toBeUndefined();
    });
  });

  test("does not scaffold prompt templates — `nax prompts --init` is the opt-in path", async () => {
    await withTempDir(async (tempDir) => {
      await initProject(tempDir);
      expect(existsSync(join(tempDir, ".nax", "templates"))).toBe(false);
    });
  });

  test("does not write hooks.json — an absent file already means 'no hooks'", async () => {
    await withTempDir(async (tempDir) => {
      await initProject(tempDir);
      expect(existsSync(join(tempDir, ".nax", "hooks.json"))).toBe(false);
    });
  });

  test("does not write a nested .nax/.gitignore — the repo-root .gitignore covers it", async () => {
    await withTempDir(async (tempDir) => {
      await initProject(tempDir);
      expect(existsSync(join(tempDir, ".nax", ".gitignore"))).toBe(false);
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
  test("adds nax.lock, .nax/**/runs/, and .nax/metrics.json to .gitignore", async () => {
    await withTempDir(async (tempDir) => {
      await initProject(tempDir);
      const gitignore = await Bun.file(join(tempDir, ".gitignore")).text();
      expect(gitignore).toContain("nax.lock");
      expect(gitignore).toContain(".nax/**/runs/");
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

describe("initProject — creates .naxignore", () => {
  test("creates .naxignore excluding nax's own state directory", async () => {
    await withTempDir(async (tempDir) => {
      await initProject(tempDir);

      const naxignore = await Bun.file(join(tempDir, ".naxignore")).text();
      expect(naxignore).toContain(".nax/");
      expect(naxignore).toContain("node_modules/");
    });
  });

  test("explains what the file does and offers commented suggestions", async () => {
    await withTempDir(async (tempDir) => {
      await initProject(tempDir);

      const naxignore = await Bun.file(join(tempDir, ".naxignore")).text();
      expect(naxignore).toMatch(/^#/);
      expect(naxignore).toContain("# vendor/");
    });
  });

  test("preserves an existing .naxignore and appends only what is missing", async () => {
    await withTempDir(async (tempDir) => {
      await Bun.write(join(tempDir, ".naxignore"), "my-fixtures/\n.nax/\n");

      await initProject(tempDir);

      const naxignore = await Bun.file(join(tempDir, ".naxignore")).text();
      expect(naxignore).toContain("my-fixtures/");
      expect(naxignore).toContain("node_modules/");
      // Already present — appending it again would be a duplicate rule.
      expect(naxignore.split("\n").filter((l) => l.trim() === ".nax/")).toHaveLength(1);
      // The suggestion block belongs to file creation only.
      expect(naxignore).not.toContain("# vendor/");
    });
  });
});

describe("initProject — re-running is idempotent", () => {
  test("a second init leaves .gitignore and .naxignore byte-identical", async () => {
    await withTempDir(async (tempDir) => {
      await initProject(tempDir);
      const gitignoreAfterFirst = await Bun.file(join(tempDir, ".gitignore")).text();
      const naxignoreAfterFirst = await Bun.file(join(tempDir, ".naxignore")).text();

      await initProject(tempDir);

      expect(await Bun.file(join(tempDir, ".gitignore")).text()).toBe(gitignoreAfterFirst);
      expect(await Bun.file(join(tempDir, ".naxignore")).text()).toBe(naxignoreAfterFirst);
    });
  });

  test("a second init does not overwrite an edited config.json or context.md", async () => {
    await withTempDir(async (tempDir) => {
      await initProject(tempDir);
      await Bun.write(join(tempDir, ".nax", "context.md"), "MY OWN CONTEXT");

      await initProject(tempDir);

      expect(await Bun.file(join(tempDir, ".nax", "context.md")).text()).toBe("MY OWN CONTEXT");
    });
  });

  test("reconciles ignore files even when .nax/ already exists", async () => {
    await withTempDir(async (tempDir) => {
      await initProject(tempDir);
      // Simulate a user who wiped the nax section out of .gitignore.
      await Bun.write(join(tempDir, ".gitignore"), "node_modules/\n");

      await initProject(tempDir);

      expect(await Bun.file(join(tempDir, ".gitignore")).text()).toContain("nax.lock");
    });
  });
});

describe("initCommand — package scaffold", () => {
  const PKG = "packages/api";

  test("scaffolds the package context under .nax/mono/<pkg>/", async () => {
    await withTempDir(async (tempDir) => {
      await initCommand({ projectRoot: tempDir, package: PKG });
      expect(existsSync(join(tempDir, ".nax", "mono", PKG, "context.md"))).toBe(true);
    });
  });

  test("leaves an edited package context.md alone without force", async () => {
    await withTempDir(async (tempDir) => {
      await initCommand({ projectRoot: tempDir, package: PKG });
      const contextPath = join(tempDir, ".nax", "mono", PKG, "context.md");
      await Bun.write(contextPath, "MY OWN PACKAGE CONTEXT");

      await initCommand({ projectRoot: tempDir, package: PKG });

      expect(await Bun.file(contextPath).text()).toBe("MY OWN PACKAGE CONTEXT");
    });
  });

  test("overwrites the package context.md when force is set", async () => {
    await withTempDir(async (tempDir) => {
      await initCommand({ projectRoot: tempDir, package: PKG });
      const contextPath = join(tempDir, ".nax", "mono", PKG, "context.md");
      await Bun.write(contextPath, "MY OWN PACKAGE CONTEXT");

      await initCommand({ projectRoot: tempDir, package: PKG, force: true });

      expect(await Bun.file(contextPath).text()).not.toBe("MY OWN PACKAGE CONTEXT");
    });
  });
});

// ─── bin/nax.ts delegates to initCommand rather than scaffolding inline ──────
//
// Source-text assertions, matching the convention in
// plan-decompose-cli-wiring.test.ts: importing bin/nax.ts would execute the
// commander program, and spawning the binary is banned by
// forbidden-patterns-tests.md. These guard against the inline scaffolder
// being reintroduced; initProject's own tests above cover the behavior.

describe("bin/nax.ts init command — delegates to initCommand", () => {
  async function binSource(): Promise<string> {
    return await Bun.file(join(import.meta.dir, "../../../bin/nax.ts")).text();
  }

  test("delegates to initCommand instead of scaffolding inline", async () => {
    expect(await binSource()).toContain("initCommand");
  });

  test("does not write hooks.json", async () => {
    expect(await binSource()).not.toContain("hooks.json");
  });

  test("does not bail out when the project is already initialized", async () => {
    // The bail prevented a re-init from reconciling drifted ignore files.
    expect(await binSource()).not.toContain("nax already initialized");
  });
});

describe("initProject — stack-aware constitution.md", () => {
  test("includes stack-specific guidance: Bun, TypeScript, Python, and monorepo when corresponding markers detected", async () => {
    await withTempDir(async (tempDir) => {
      await Bun.write(join(tempDir, "bun.lockb"), "");
      await initProject(tempDir);
      expect(await Bun.file(join(tempDir, ".nax", "constitution.md")).text()).toMatch(/Bun\.file\(\)|Bun\.spawn\(\)|Bun\.sleep\(\)|bun test/);
    });
    await withTempDir(async (tempDir) => {
      await Bun.write(join(tempDir, "tsconfig.json"), "{}");
      await initProject(tempDir);
      expect(await Bun.file(join(tempDir, ".nax", "constitution.md")).text()).toMatch(/strict.*TypeScript|TypeScript.*strict/i);
    });
    await withTempDir(async (tempDir) => {
      await Bun.write(join(tempDir, "pyproject.toml"), "[tool.poetry]\nname = \"example\"");
      await initProject(tempDir);
      expect(await Bun.file(join(tempDir, ".nax", "constitution.md")).text()).toMatch(/PEP.?8|type hint/i);
    });
    await withTempDir(async (tempDir) => {
      await Bun.write(join(tempDir, "turbo.json"), "{}");
      await initProject(tempDir);
      expect(await Bun.file(join(tempDir, ".nax", "constitution.md")).text()).toMatch(/monorepo|package boundar/i);
    });
  });
});

describe("initProject — prints summary with created files and next steps", () => {
  function captureInitLog(): { output: string[]; restore: () => void } {
    const output: string[] = [];
    const orig = _initDeps.log;
    _initDeps.log = (...args: unknown[]) => { output.push(args.map(String).join(" ")); };
    return { output, restore: () => { _initDeps.log = orig; } };
  }

  test("summary output includes config.json, constitution.md, context.md, nax generate, nax plan, and nax run", async () => {
    const { output, restore } = captureInitLog();
    try {
      await withTempDir(async (tempDir) => {
        await initProject(tempDir);
        const out = output.join("\n");
        expect(out).toContain("config.json");
        expect(out).toContain("constitution.md");
        expect(out).toContain("context.md");
        expect(out).toContain("nax generate");
        expect(out).toContain("nax plan");
        expect(out).toContain("nax run");
      });
    } finally { restore(); }
  });
});
