/**
 * Unit tests for src/cli/init-detect.ts (INIT-001)
 *
 * Tests stack detection, quality command building, and integration
 * with initProject. All tests must fail until init-detect.ts is implemented.
 */

import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildInitConfig,
  buildQualityCommands,
  detectProjectStack,
} from "../../../src/cli/init-detect";
import { initProject } from "../../../src/cli/init";
import { withTempDir } from "../../helpers/temp";

// ---------------------------------------------------------------------------
// detectProjectStack — runtime detection
// ---------------------------------------------------------------------------

describe("detectProjectStack — runtime detection", () => {
  test("detects bun runtime from bun.lockb", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "bun.lockb"), "");
      const stack = detectProjectStack(dir);
      expect(stack.runtime).toBe("bun");
    });
  });

  test("detects bun runtime from bunfig.toml", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "bunfig.toml"), "");
      const stack = detectProjectStack(dir);
      expect(stack.runtime).toBe("bun");
    });
  });

  test("detects node runtime from package-lock.json", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "package-lock.json"), "{}");
      const stack = detectProjectStack(dir);
      expect(stack.runtime).toBe("node");
    });
  });

  test("detects node runtime from yarn.lock", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "yarn.lock"), "");
      const stack = detectProjectStack(dir);
      expect(stack.runtime).toBe("node");
    });
  });

  test("detects node runtime from pnpm-lock.yaml", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "pnpm-lock.yaml"), "");
      const stack = detectProjectStack(dir);
      expect(stack.runtime).toBe("node");
    });
  });

  test("bun takes priority over node when both lockfiles present", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "bun.lockb"), "");
      await Bun.write(join(dir, "package-lock.json"), "{}");
      const stack = detectProjectStack(dir);
      expect(stack.runtime).toBe("bun");
    });
  });

  test("returns unknown runtime when no lockfile found", async () => {
    await withTempDir(async (dir) => {
      const stack = detectProjectStack(dir);
      expect(stack.runtime).toBe("unknown");
    });
  });
});

// ---------------------------------------------------------------------------
// detectProjectStack — language detection
// ---------------------------------------------------------------------------

describe("detectProjectStack — language detection", () => {
  test("detects typescript from tsconfig.json", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "tsconfig.json"), "{}");
      const stack = detectProjectStack(dir);
      expect(stack.language).toBe("typescript");
    });
  });

  test("detects python from pyproject.toml", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "pyproject.toml"), "");
      const stack = detectProjectStack(dir);
      expect(stack.language).toBe("python");
    });
  });

  test("detects python from setup.py", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "setup.py"), "");
      const stack = detectProjectStack(dir);
      expect(stack.language).toBe("python");
    });
  });

  test("detects rust from Cargo.toml", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "Cargo.toml"), "");
      const stack = detectProjectStack(dir);
      expect(stack.language).toBe("rust");
    });
  });

  test("detects go from go.mod", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "go.mod"), "");
      const stack = detectProjectStack(dir);
      expect(stack.language).toBe("go");
    });
  });

  test("returns unknown language when no indicators found", async () => {
    await withTempDir(async (dir) => {
      const stack = detectProjectStack(dir);
      expect(stack.language).toBe("unknown");
    });
  });
});

// ---------------------------------------------------------------------------
// detectProjectStack — linter detection
// ---------------------------------------------------------------------------

describe("detectProjectStack — linter detection", () => {
  test("detects biome from biome.json", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "biome.json"), "{}");
      const stack = detectProjectStack(dir);
      expect(stack.linter).toBe("biome");
    });
  });

  test("detects biome from biome.jsonc", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "biome.jsonc"), "{}");
      const stack = detectProjectStack(dir);
      expect(stack.linter).toBe("biome");
    });
  });

  test("detects eslint from .eslintrc.json", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, ".eslintrc.json"), "{}");
      const stack = detectProjectStack(dir);
      expect(stack.linter).toBe("eslint");
    });
  });

  test("detects eslint from .eslintrc.js", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, ".eslintrc.js"), "module.exports = {}");
      const stack = detectProjectStack(dir);
      expect(stack.linter).toBe("eslint");
    });
  });

  test("detects eslint from eslint.config.js", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "eslint.config.js"), "export default []");
      const stack = detectProjectStack(dir);
      expect(stack.linter).toBe("eslint");
    });
  });

  test("biome takes priority over eslint when both present", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "biome.json"), "{}");
      await Bun.write(join(dir, ".eslintrc.json"), "{}");
      const stack = detectProjectStack(dir);
      expect(stack.linter).toBe("biome");
    });
  });

  test("returns unknown linter when no linter config found", async () => {
    await withTempDir(async (dir) => {
      const stack = detectProjectStack(dir);
      expect(stack.linter).toBe("unknown");
    });
  });
});

// ---------------------------------------------------------------------------
// detectProjectStack — monorepo detection
// ---------------------------------------------------------------------------

describe("detectProjectStack — monorepo detection", () => {
  test("detects turborepo from turbo.json", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "turbo.json"), "{}");
      const stack = detectProjectStack(dir);
      expect(stack.monorepo).toBe("turborepo");
    });
  });

  test("detects nx from nx.json", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "nx.json"), "{}");
      const stack = detectProjectStack(dir);
      expect(stack.monorepo).toBe("nx");
    });
  });

  test("detects pnpm-workspaces from pnpm-workspace.yaml", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
      const stack = detectProjectStack(dir);
      expect(stack.monorepo).toBe("pnpm-workspaces");
    });
  });

  test("detects bun-workspaces from package.json workspaces field", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
      const stack = detectProjectStack(dir);
      expect(stack.monorepo).toBe("bun-workspaces");
    });
  });

  test("turborepo takes priority over nx when both present", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "turbo.json"), "{}");
      await Bun.write(join(dir, "nx.json"), "{}");
      const stack = detectProjectStack(dir);
      expect(stack.monorepo).toBe("turborepo");
    });
  });

  test("returns none when no monorepo config found", async () => {
    await withTempDir(async (dir) => {
      const stack = detectProjectStack(dir);
      expect(stack.monorepo).toBe("none");
    });
  });
});

// ---------------------------------------------------------------------------
// buildQualityCommands — monorepo command generation
// ---------------------------------------------------------------------------

describe("buildQualityCommands — monorepo tools", () => {
  test("turborepo: generates turbo run commands with --filter=...[HEAD~1]", () => {
    const commands = buildQualityCommands({
      runtime: "node",
      language: "typescript",
      linter: "eslint",
      monorepo: "turborepo",
    });
    expect(commands.test).toBe("turbo run test --filter=...[HEAD~1]");
    expect(commands.lint).toBe("turbo run lint --filter=...[HEAD~1]");
    expect(commands.typecheck).toBe("turbo run typecheck --filter=...[HEAD~1]");
  });

  test("nx: generates nx affected commands", () => {
    const commands = buildQualityCommands({
      runtime: "node",
      language: "typescript",
      linter: "eslint",
      monorepo: "nx",
    });
    expect(commands.test).toBe("nx affected --target=test");
    expect(commands.lint).toBe("nx affected --target=lint");
    expect(commands.typecheck).toBe("nx affected --target=typecheck");
  });

  test("pnpm-workspaces: generates pnpm recursive commands", () => {
    const commands = buildQualityCommands({
      runtime: "node",
      language: "typescript",
      linter: "eslint",
      monorepo: "pnpm-workspaces",
    });
    expect(commands.test).toBe("pnpm run --recursive test");
  });

  test("bun-workspaces: generates bun filter commands", () => {
    const commands = buildQualityCommands({
      runtime: "bun",
      language: "typescript",
      linter: "biome",
      monorepo: "bun-workspaces",
    });
    expect(commands.test).toBe("bun run --filter '*' test");
  });
});

// ---------------------------------------------------------------------------
// buildQualityCommands — command mapping
// ---------------------------------------------------------------------------

describe("buildQualityCommands — bun + typescript", () => {
  test("returns bun typecheck command", () => {
    const commands = buildQualityCommands({
      runtime: "bun",
      language: "typescript",
      linter: "unknown",
      monorepo: "none",
    });
    expect(commands.typecheck).toBe("bun run tsc --noEmit");
  });

  test("returns bun test command", () => {
    const commands = buildQualityCommands({
      runtime: "bun",
      language: "typescript",
      linter: "unknown",
      monorepo: "none",
    });
    expect(commands.test).toBe("bun test");
  });

  test("returns bun lint command when linter unknown", () => {
    const commands = buildQualityCommands({
      runtime: "bun",
      language: "typescript",
      linter: "unknown",
      monorepo: "none",
    });
    expect(commands.lint).toBe("bun run lint");
  });

  test("returns biome check lint command when biome detected", () => {
    const commands = buildQualityCommands({
      runtime: "bun",
      language: "typescript",
      linter: "biome",
      monorepo: "none",
    });
    expect(commands.lint).toBe("biome check .");
  });

  test("returns eslint lint command when eslint detected", () => {
    const commands = buildQualityCommands({
      runtime: "bun",
      language: "typescript",
      linter: "eslint",
      monorepo: "none",
    });
    expect(commands.lint).toBe("eslint .");
  });
});

describe("buildQualityCommands — node + typescript", () => {
  test("returns npx typecheck command", () => {
    const commands = buildQualityCommands({
      runtime: "node",
      language: "typescript",
      linter: "unknown",
      monorepo: "none",
    });
    expect(commands.typecheck).toBe("npx tsc --noEmit");
  });

  test("returns npm test command", () => {
    const commands = buildQualityCommands({
      runtime: "node",
      language: "typescript",
      linter: "unknown",
      monorepo: "none",
    });
    expect(commands.test).toBe("npm test");
  });

  test("returns npm run lint command when linter unknown", () => {
    const commands = buildQualityCommands({
      runtime: "node",
      language: "typescript",
      linter: "unknown",
      monorepo: "none",
    });
    expect(commands.lint).toBe("npm run lint");
  });

  test("returns biome check lint command when biome detected", () => {
    const commands = buildQualityCommands({
      runtime: "node",
      language: "typescript",
      linter: "biome",
      monorepo: "none",
    });
    expect(commands.lint).toBe("biome check .");
  });

  test("returns eslint lint command when eslint detected", () => {
    const commands = buildQualityCommands({
      runtime: "node",
      language: "typescript",
      linter: "eslint",
      monorepo: "none",
    });
    expect(commands.lint).toBe("eslint .");
  });
});

describe("buildQualityCommands — python", () => {
  test("returns ruff lint command", () => {
    const commands = buildQualityCommands({
      runtime: "unknown",
      language: "python",
      linter: "unknown",
      monorepo: "none",
    });
    expect(commands.lint).toBe("ruff check .");
  });

  test("returns pytest test command", () => {
    const commands = buildQualityCommands({
      runtime: "unknown",
      language: "python",
      linter: "unknown",
      monorepo: "none",
    });
    expect(commands.test).toBe("pytest");
  });

  test("does not include typecheck command", () => {
    const commands = buildQualityCommands({
      runtime: "unknown",
      language: "python",
      linter: "unknown",
      monorepo: "none",
    });
    expect(commands.typecheck).toBeUndefined();
  });
});

describe("buildQualityCommands — rust", () => {
  test("returns cargo check typecheck command", () => {
    const commands = buildQualityCommands({
      runtime: "unknown",
      language: "rust",
      linter: "unknown",
      monorepo: "none",
    });
    expect(commands.typecheck).toBe("cargo check");
  });

  test("returns cargo clippy lint command", () => {
    const commands = buildQualityCommands({
      runtime: "unknown",
      language: "rust",
      linter: "unknown",
      monorepo: "none",
    });
    expect(commands.lint).toBe("cargo clippy");
  });

  test("returns cargo test command", () => {
    const commands = buildQualityCommands({
      runtime: "unknown",
      language: "rust",
      linter: "unknown",
      monorepo: "none",
    });
    expect(commands.test).toBe("cargo test");
  });
});

describe("buildQualityCommands — go", () => {
  test("returns go vet typecheck command", () => {
    const commands = buildQualityCommands({
      runtime: "unknown",
      language: "go",
      linter: "unknown",
      monorepo: "none",
    });
    expect(commands.typecheck).toBe("go vet ./...");
  });

  test("returns golangci-lint lint command", () => {
    const commands = buildQualityCommands({
      runtime: "unknown",
      language: "go",
      linter: "unknown",
      monorepo: "none",
    });
    expect(commands.lint).toBe("golangci-lint run");
  });

  test("returns go test command", () => {
    const commands = buildQualityCommands({
      runtime: "unknown",
      language: "go",
      linter: "unknown",
      monorepo: "none",
    });
    expect(commands.test).toBe("go test ./...");
  });
});

describe("buildQualityCommands — unknown stack", () => {
  test("returns no commands when stack is fully unknown", () => {
    const commands = buildQualityCommands({
      runtime: "unknown",
      language: "unknown",
      linter: "unknown",
      monorepo: "none",
    });
    expect(commands.typecheck).toBeUndefined();
    expect(commands.lint).toBeUndefined();
    expect(commands.test).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildInitConfig — config object shape
// ---------------------------------------------------------------------------

describe("buildInitConfig — detected stack", () => {
  test("includes version field", () => {
    const config = buildInitConfig({
      runtime: "bun",
      language: "typescript",
      linter: "biome",
      monorepo: "none",
    }) as Record<string, unknown>;
    expect(config.version).toBeDefined();
  });

  test("includes quality.commands when stack detected", () => {
    const config = buildInitConfig({
      runtime: "bun",
      language: "typescript",
      linter: "biome",
      monorepo: "none",
    }) as Record<string, unknown>;
    const quality = config.quality as Record<string, unknown>;
    expect(quality).toBeDefined();
    expect(quality.commands).toBeDefined();
  });

  test("quality.commands.typecheck is bun command for bun+ts", () => {
    const config = buildInitConfig({
      runtime: "bun",
      language: "typescript",
      linter: "unknown",
      monorepo: "none",
    }) as Record<string, unknown>;
    const quality = config.quality as Record<string, unknown>;
    const commands = quality.commands as Record<string, unknown>;
    expect(commands.typecheck).toBe("bun run tsc --noEmit");
  });

  test("quality.commands.lint uses biome when biome detected", () => {
    const config = buildInitConfig({
      runtime: "bun",
      language: "typescript",
      linter: "biome",
      monorepo: "none",
    }) as Record<string, unknown>;
    const quality = config.quality as Record<string, unknown>;
    const commands = quality.commands as Record<string, unknown>;
    expect(commands.lint).toBe("biome check .");
  });
});

describe("buildInitConfig — unknown stack fallback", () => {
  test("returns minimal config with version but no quality.commands", () => {
    const config = buildInitConfig({
      runtime: "unknown",
      language: "unknown",
      linter: "unknown",
      monorepo: "none",
    }) as Record<string, unknown>;
    expect(config.version).toBeDefined();
    // No quality.commands when nothing detected
    const quality = config.quality as Record<string, unknown> | undefined;
    const hasCommands = quality?.commands !== undefined;
    expect(hasCommands).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// initProject integration — uses detected stack
// ---------------------------------------------------------------------------

describe("initProject — uses detected stack for quality.commands", () => {
  test("config.json includes quality.commands when bun+ts detected", async () => {
    await withTempDir(async (dir) => {
      // Plant stack indicators
      await Bun.write(join(dir, "bun.lockb"), "");
      await Bun.write(join(dir, "tsconfig.json"), "{}");

      await initProject(dir);

      const configPath = join(dir, "nax", "config.json");
      const config = JSON.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
      const quality = config.quality as Record<string, unknown> | undefined;
      const commands = quality?.commands as Record<string, unknown> | undefined;

      expect(commands?.typecheck).toBe("bun run tsc --noEmit");
      expect(commands?.test).toBe("bun test");
    });
  });

  test("config.json uses biome lint command when biome.json present", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "bun.lockb"), "");
      await Bun.write(join(dir, "tsconfig.json"), "{}");
      await Bun.write(join(dir, "biome.json"), "{}");

      await initProject(dir);

      const configPath = join(dir, "nax", "config.json");
      const config = JSON.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
      const quality = config.quality as Record<string, unknown> | undefined;
      const commands = quality?.commands as Record<string, unknown> | undefined;

      expect(commands?.lint).toBe("biome check .");
    });
  });

  test("config.json falls back to minimal when no stack detected", async () => {
    await withTempDir(async (dir) => {
      // No stack indicators in tempDir
      await initProject(dir);

      const configPath = join(dir, "nax", "config.json");
      const config = JSON.parse(await Bun.file(configPath).text()) as Record<string, unknown>;

      expect(config.version).toBeDefined();
      // No quality.commands in fallback
      const quality = config.quality as Record<string, unknown> | undefined;
      expect(quality?.commands).toBeUndefined();
    });
  });

  test("config.json includes quality.commands for python stack", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "pyproject.toml"), "[project]\nname = 'test'");

      await initProject(dir);

      const configPath = join(dir, "nax", "config.json");
      const config = JSON.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
      const quality = config.quality as Record<string, unknown> | undefined;
      const commands = quality?.commands as Record<string, unknown> | undefined;

      expect(commands?.lint).toBe("ruff check .");
      expect(commands?.test).toBe("pytest");
    });
  });

  test("config.json includes quality.commands for go stack", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "go.mod"), "module example.com/foo\n\ngo 1.21");

      await initProject(dir);

      const configPath = join(dir, "nax", "config.json");
      const config = JSON.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
      const quality = config.quality as Record<string, unknown> | undefined;
      const commands = quality?.commands as Record<string, unknown> | undefined;

      expect(commands?.typecheck).toBe("go vet ./...");
      expect(commands?.test).toBe("go test ./...");
    });
  });
});
