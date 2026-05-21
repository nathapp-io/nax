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
  test.each([
    { lockfile: "bun.lockb", runtime: "bun" },
    { lockfile: "bunfig.toml", runtime: "bun" },
    { lockfile: "package-lock.json", runtime: "node" },
    { lockfile: "yarn.lock", runtime: "node" },
    { lockfile: "pnpm-lock.yaml", runtime: "node" },
    { lockfile: "bun.lockb+package-lock.json", runtime: "bun", extraFiles: ["package-lock.json"] },
  ])("detects $lockfile → $runtime runtime", async ({ lockfile, runtime, extraFiles }) => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, lockfile.split("+")[0]!), lockfile.endsWith(".json") ? "{}" : "");
      if (extraFiles) {
        for (const f of extraFiles) await Bun.write(join(dir, f), "{}");
      }
      const stack = detectProjectStack(dir);
      expect(stack.runtime).toBe(runtime);
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
  test.each([
    { file: "tsconfig.json", lang: "typescript" },
    { file: "pyproject.toml", lang: "python" },
    { file: "setup.py", lang: "python" },
    { file: "Cargo.toml", lang: "rust" },
    { file: "go.mod", lang: "go" },
  ])("detects $file → $lang language", async ({ file, lang }) => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, file), file.endsWith(".json") ? "{}" : "");
      const stack = detectProjectStack(dir);
      expect(stack.language).toBe(lang);
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
  test.each([
    { file: "biome.json", linter: "biome" },
    { file: "biome.jsonc", linter: "biome" },
    { file: ".eslintrc.json", linter: "eslint" },
    { file: ".eslintrc.js", linter: "eslint", content: "module.exports = {}" },
    { file: "eslint.config.js", linter: "eslint", content: "export default []" },
    { file: "biome.json+.eslintrc.json", linter: "biome", extraFiles: [".eslintrc.json"] },
  ])("detects $file → $linter linter", async ({ file, linter, content, extraFiles }) => {
    await withTempDir(async (dir) => {
      const [primary] = file.split("+");
      await Bun.write(join(dir, primary), content ?? (primary.endsWith(".json") ? "{}" : ""));
      if (extraFiles) {
        for (const f of extraFiles) await Bun.write(join(dir, f), "{}");
      }
      const stack = detectProjectStack(dir);
      expect(stack.linter).toBe(linter);
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
  test.each([
    { file: "turbo.json", mono: "turborepo" },
    { file: "nx.json", mono: "nx" },
    { file: "pnpm-workspace.yaml", mono: "pnpm-workspaces", content: "packages:\n  - 'packages/*'\n" },
    { file: "package.json", mono: "bun-workspaces", content: JSON.stringify({ workspaces: ["packages/*"] }) },
    { file: "turbo.json+nx.json", mono: "turborepo", extraFiles: ["nx.json"] },
  ])("detects $file → $mono monorepo", async ({ file, mono, content, extraFiles }) => {
    await withTempDir(async (dir) => {
      const [primary] = file.split("+");
      await Bun.write(join(dir, primary), content ?? "{}");
      if (extraFiles) {
        for (const f of extraFiles) await Bun.write(join(dir, f), "{}");
      }
      const stack = detectProjectStack(dir);
      expect(stack.monorepo).toBe(mono);
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

      const configPath = join(dir, ".nax", "config.json");
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

      const configPath = join(dir, ".nax", "config.json");
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

      const configPath = join(dir, ".nax", "config.json");
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

      const configPath = join(dir, ".nax", "config.json");
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

      const configPath = join(dir, ".nax", "config.json");
      const config = JSON.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
      const quality = config.quality as Record<string, unknown> | undefined;
      const commands = quality?.commands as Record<string, unknown> | undefined;

      expect(commands?.typecheck).toBe("go vet ./...");
      expect(commands?.test).toBe("go test ./...");
    });
  });
});
