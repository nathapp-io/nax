/**
 * Unit tests for `nax init` command (PT-004, INIT-003)
 *
 * Tests that nax init creates the project nax/ directory structure, prints a
 * summary, generates a stack-aware constitution.md, and reconciles the repo's
 * .gitignore and .naxignore without disturbing user content. Also carries the
 * name-validation/collision guard and the package-scaffold (MW-005) suites.
 */

import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir, withTempDir } from "@test/helpers";
import { _initDeps, checkInitCollision, initCommand, initProject, validateProjectName } from "@/cli/init";
import { generatePackageContextTemplate, initPackage } from "@/cli/init-context";
import { globalConfigDir } from "@/config/paths";
import { writeProjectIdentity } from "@/runtime";

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
      expect(await Bun.file(join(tempDir, ".nax", "constitution.md")).text()).toMatch(
        /Bun\.file\(\)|Bun\.spawn\(\)|Bun\.sleep\(\)|bun test/,
      );
    });
    await withTempDir(async (tempDir) => {
      await Bun.write(join(tempDir, "tsconfig.json"), "{}");
      await initProject(tempDir);
      expect(await Bun.file(join(tempDir, ".nax", "constitution.md")).text()).toMatch(
        /strict.*TypeScript|TypeScript.*strict/i,
      );
    });
    await withTempDir(async (tempDir) => {
      await Bun.write(join(tempDir, "pyproject.toml"), '[tool.poetry]\nname = "example"');
      await initProject(tempDir);
      expect(await Bun.file(join(tempDir, ".nax", "constitution.md")).text()).toMatch(/PEP.?8|type hint/i);
    });
    await withTempDir(async (tempDir) => {
      await Bun.write(join(tempDir, "turbo.json"), "{}");
      await initProject(tempDir);
      expect(await Bun.file(join(tempDir, ".nax", "constitution.md")).text()).toMatch(/monorepo|package boundar/i);
    });
  });

  test("names nx's own task-scoping command when nx.json is present", async () => {
    await withTempDir(async (tempDir) => {
      await Bun.write(join(tempDir, "nx.json"), "{}");
      await initProject(tempDir);
      expect(await Bun.file(join(tempDir, ".nax", "constitution.md")).text()).toContain("nx run <package>:<task>");
    });
  });

  test("names pnpm's own task-scoping command when pnpm-workspace.yaml is present", async () => {
    await withTempDir(async (tempDir) => {
      await Bun.write(join(tempDir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
      await initProject(tempDir);
      expect(await Bun.file(join(tempDir, ".nax", "constitution.md")).text()).toContain(
        "pnpm --filter <package> run <task>",
      );
    });
  });

  test("names bun's own task-scoping command when package.json declares workspaces", async () => {
    await withTempDir(async (tempDir) => {
      await Bun.write(join(tempDir, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
      await initProject(tempDir);
      expect(await Bun.file(join(tempDir, ".nax", "constitution.md")).text()).toContain(
        "bun run --filter <package> <task>",
      );
    });
  });
});

describe("initProject — name validation and collision guard", () => {
  test("throws INIT_INVALID_NAME for a name that fails validateProjectName", async () => {
    await withTempDir(async (tempDir) => {
      await expect(initProject(tempDir, { name: "Invalid Name!" })).rejects.toMatchObject({
        code: "INIT_INVALID_NAME",
      });
    });
  });

  const COLLISION_KEY = "nax-test-init-project-collision";
  const identityDir = join(globalConfigDir(), COLLISION_KEY);

  test("throws INIT_NAME_COLLISION when the name is already claimed by a different workdir", async () => {
    await writeProjectIdentity(COLLISION_KEY, {
      name: COLLISION_KEY,
      workdir: "/tmp/some-other-project",
      remoteUrl: null,
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });
    try {
      await withTempDir(async (tempDir) => {
        await expect(initProject(tempDir, { name: COLLISION_KEY })).rejects.toMatchObject({
          code: "INIT_NAME_COLLISION",
        });
      });
    } finally {
      await Bun.$`rm -rf ${identityDir}`.quiet().nothrow();
    }
  });

  test("force bypasses the collision guard even when the name is claimed elsewhere", async () => {
    await writeProjectIdentity(COLLISION_KEY, {
      name: COLLISION_KEY,
      workdir: "/tmp/some-other-project",
      remoteUrl: null,
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });
    try {
      await withTempDir(async (tempDir) => {
        await initProject(tempDir, { name: COLLISION_KEY, force: true });
        expect(existsSync(join(tempDir, ".nax", "config.json"))).toBe(true);
      });
    } finally {
      await Bun.$`rm -rf ${identityDir}`.quiet().nothrow();
    }
  });
});

describe("initProject — detects a real git remote", () => {
  async function git(cwd: string, args: string[]): Promise<void> {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
  }

  test("succeeds when the project has a configured origin remote", async () => {
    await withTempDir(async (tempDir) => {
      await git(tempDir, ["init"]);
      await git(tempDir, ["remote", "add", "origin", "git@example.com:org/repo.git"]);
      await initProject(tempDir);
      expect(existsSync(join(tempDir, ".nax", "config.json"))).toBe(true);
    });
  });
});

describe("initCommand — global config scaffold", () => {
  test("initializes ~/.nax (redirected to the isolated test global dir by test/preload.ts)", async () => {
    await initCommand({ global: true });
    const globalDir = globalConfigDir();
    expect(existsSync(join(globalDir, "config.json"))).toBe(true);
    expect(existsSync(join(globalDir, "constitution.md"))).toBe(true);
    expect(existsSync(join(globalDir, "hooks"))).toBe(true);
  });
});

describe("initCommand — default branch delegates to initProject", () => {
  test("initializes the project scaffold when neither global nor package is set", async () => {
    await withTempDir(async (tempDir) => {
      await initCommand({ projectRoot: tempDir });
      expect(existsSync(join(tempDir, ".nax", "config.json"))).toBe(true);
    });
  });
});

describe("initProject — prints summary with created files and next steps", () => {
  function captureInitLog(): { output: string[]; restore: () => void } {
    const output: string[] = [];
    const orig = _initDeps.log;
    _initDeps.log = (...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    };
    return {
      output,
      restore: () => {
        _initDeps.log = orig;
      },
    };
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
    } finally {
      restore();
    }
  });
});

// ─── MW-005: package context scaffold ────────────────────────────────────────

describe("generatePackageContextTemplate (MW-005)", () => {
  test("uses the last path segment as package name; includes root context.md reference comment; includes a Commands table with bun test", () => {
    const content = generatePackageContextTemplate("packages/api");
    expect(content).toContain("# api — Context");
    expect(content).toContain("Root context.md");
    expect(content).toContain("bun test");
  });

  test("uses single-segment path as package name", () => {
    const content = generatePackageContextTemplate("api");
    expect(content).toContain("# api — Context");
  });

  test("includes Tech Stack and Development Guidelines sections", () => {
    const content = generatePackageContextTemplate("packages/web");
    expect(content).toContain("## Tech Stack");
    expect(content).toContain("## Development Guidelines");
  });
});

describe("initPackage (MW-005)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-test-");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates nax/context.md in the package directory", async () => {
    await initPackage(tmpDir, "packages/api");
    const contextPath = join(tmpDir, ".nax/mono/packages/api/context.md");
    expect(await Bun.file(contextPath).exists()).toBe(true);
  });

  test("content includes package name from path", async () => {
    await initPackage(tmpDir, "packages/api");
    const content = await Bun.file(join(tmpDir, ".nax/mono/packages/api/context.md")).text();
    expect(content).toContain("# api — Context");
  });

  test("does not overwrite existing file when force=false", async () => {
    const contextPath = join(tmpDir, ".nax/mono/packages/api/context.md");
    await Bun.write(contextPath, "# Existing content");
    await initPackage(tmpDir, "packages/api", false);
    const content = await Bun.file(contextPath).text();
    expect(content).toBe("# Existing content");
  });

  test("overwrites existing file when force=true", async () => {
    const contextPath = join(tmpDir, ".nax/mono/packages/api/context.md");
    await Bun.write(contextPath, "# Existing content");
    await initPackage(tmpDir, "packages/api", true);
    const content = await Bun.file(contextPath).text();
    expect(content).not.toBe("# Existing content");
    expect(content).toContain("# api — Context");
  });

  test("creates intermediate directories", async () => {
    await initPackage(tmpDir, "apps/backend/service");
    const contextPath = join(tmpDir, ".nax/mono/apps/backend/service/context.md");
    expect(await Bun.file(contextPath).exists()).toBe(true);
  });

  test("rejects a packagePath that escapes the repo via '..' before creating any directory (US-002 AC #3)", async () => {
    await expect(initPackage(tmpDir, "../../evil")).rejects.toMatchObject({
      name: "NaxError",
      code: "INVALID_PACKAGE_PATH",
    });
    // The directory must NOT be created when validation rejects.
    expect(await Bun.file(join(tmpDir, ".nax/mono/evil/context.md")).exists()).toBe(false);
  });

  test("rejects an empty packagePath rather than resolving to the repo root (US-002 AC #6)", async () => {
    await expect(initPackage(tmpDir, "")).rejects.toMatchObject({
      name: "NaxError",
      code: "INVALID_PACKAGE_PATH",
    });
    const rootContext = join(tmpDir, ".nax", "context.md");
    // The pre-existing initContext file at <repoRoot>/.nax/context.md must NOT
    // be created by a stray empty packagePath.
    expect(await Bun.file(rootContext).exists()).toBe(false);
  });

  test("rejects an absolute packagePath before creating any directory", async () => {
    await expect(initPackage(tmpDir, "/etc")).rejects.toMatchObject({
      name: "NaxError",
      code: "INVALID_PACKAGE_PATH",
    });
  });

  test("rejects with NaxError code INIT_ERROR when an ancestor of the package .nax dir is a regular file", async () => {
    // .nax/mono/packages exists as a regular file, so mkdir(..., { recursive: true })
    // for .nax/mono/packages/api throws ENOTDIR instead of creating the directory.
    await Bun.write(join(tmpDir, ".nax", "mono", "packages"), "not a directory");
    await expect(initPackage(tmpDir, "packages/api")).rejects.toMatchObject({
      name: "NaxError",
      code: "INIT_ERROR",
    });
  });

  test("rejects with NaxError code INIT_ERROR when the package .nax dir itself is a regular file", async () => {
    // naxDir (.nax/mono/api) is itself a regular file. Bun.file(naxDir).exists()
    // is true for a regular file, so a bunFileExists(naxDir) guard would wrongly
    // skip bunMkdirp here — this pins that bunMkdirp always runs.
    await Bun.write(join(tmpDir, ".nax", "mono", "api"), "not a directory");
    await expect(initPackage(tmpDir, "api")).rejects.toMatchObject({
      name: "NaxError",
      code: "INIT_ERROR",
    });
  });
});

// ─── name validation + collision guard ───────────────────────────────────────

describe("validateProjectName", () => {
  it("accepts 'my-project'", () => {
    const r = validateProjectName("my-project");
    expect(r.valid).toBe(true);
  });

  it("rejects empty string", () => {
    const r = validateProjectName("");
    expect(r.valid).toBe(false);
    expect(r.error).toContain("non-empty");
  });

  it("rejects 'global'", () => {
    const r = validateProjectName("global");
    expect(r.valid).toBe(false);
    expect(r.error).toContain("reserved");
  });

  it("rejects name with uppercase", () => {
    const r = validateProjectName("MyProject");
    expect(r.valid).toBe(false);
  });

  it("rejects name starting with '_'", () => {
    const r = validateProjectName("_archive");
    expect(r.valid).toBe(false);
    expect(r.error).toContain("reserved");
  });

  it("rejects name longer than 64 chars", () => {
    const r = validateProjectName("a".repeat(65));
    expect(r.valid).toBe(false);
  });
});

const TEST_KEY = "__nax_test_init_collision__";

describe("checkInitCollision", () => {
  const identityDir = join(globalConfigDir(), TEST_KEY);

  beforeEach(async () => {
    await rm(identityDir, { recursive: true, force: true });
    await mkdir(identityDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(identityDir, { recursive: true, force: true });
  });

  it("returns no collision when identity does not exist", async () => {
    const result = await checkInitCollision(TEST_KEY, "/tmp/my-project", null);
    expect(result.collision).toBe(false);
  });

  it("returns no collision when workdir matches (no-remote case)", async () => {
    await writeProjectIdentity(TEST_KEY, {
      name: TEST_KEY,
      workdir: "/tmp/my-project",
      remoteUrl: null,
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });
    const result = await checkInitCollision(TEST_KEY, "/tmp/my-project", null);
    expect(result.collision).toBe(false);
  });

  it("returns no collision when remote URL matches", async () => {
    const remote = "git@github.com:org/repo.git";
    await writeProjectIdentity(TEST_KEY, {
      name: TEST_KEY,
      workdir: "/tmp/other-project",
      remoteUrl: remote,
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });
    const result = await checkInitCollision(TEST_KEY, "/tmp/my-project", remote);
    expect(result.collision).toBe(false);
  });

  it("returns collision when different workdir and no remote", async () => {
    await writeProjectIdentity(TEST_KEY, {
      name: TEST_KEY,
      workdir: "/tmp/other-project",
      remoteUrl: null,
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });
    const result = await checkInitCollision(TEST_KEY, "/tmp/my-project", null);
    expect(result.collision).toBe(true);
    expect(result.existing?.workdir).toBe("/tmp/other-project");
  });
});
