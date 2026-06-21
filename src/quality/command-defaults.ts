/**
 * Detection-Based Default Quality Commands
 *
 * Fallback test/lint/typecheck commands derived from a package's manifest, used
 * ONLY when no command is configured (explicit config — root or per-package —
 * always wins). The primary driver is a brand-new package created mid-run: by
 * the time a verify gate runs, the implementer has scaffolded the manifest, so
 * detection here yields a runnable command where config alone resolved nothing.
 *
 * Conservatism rule: only emit a command that is a toolchain built-in (e.g.
 * `go vet`, `cargo check`) or whose tool/config marker is present (tsconfig,
 * biome.json, [tool.ruff]). This avoids turning today's graceful "no command —
 * skip" into a false failure from an uninstalled tool. When unsure, omit.
 */

import { join } from "node:path";
import { detectLanguage } from "../project/detector";

export interface DefaultQualityCommands {
  test?: string;
  lint?: string;
  typecheck?: string;
}

/** Injectable deps for testability — avoids touching real disk / mock.module(). */
export const _commandDefaultsDeps = {
  fileExists: (p: string): Promise<boolean> => Bun.file(p).exists(),
  readText: async (p: string): Promise<string> => {
    try {
      return await Bun.file(p).text();
    } catch {
      return "";
    }
  },
  readJson: async (p: string): Promise<Record<string, unknown> | null> => {
    try {
      return (await Bun.file(p).json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  },
  detectLanguage,
};

const memo = new Map<string, DefaultQualityCommands>();

/** Reset the per-process memo. For tests only. */
export function clearCommandDefaultsCache(): void {
  memo.clear();
}

/**
 * Resolve conservative default quality commands for a package by detecting its
 * manifest. Memoized per packageDir. Returns {} when the language is unknown or
 * no safe defaults apply.
 */
export async function resolveDefaultQualityCommands(packageDir: string): Promise<DefaultQualityCommands> {
  const cached = memo.get(packageDir);
  if (cached) return cached;
  const result = await compute(packageDir);
  memo.set(packageDir, result);
  return result;
}

async function compute(packageDir: string): Promise<DefaultQualityCommands> {
  const language = await _commandDefaultsDeps.detectLanguage(packageDir);
  switch (language) {
    case "go":
      // All Go built-ins — safe to default unconditionally.
      return { test: "go test ./...", typecheck: "go build ./...", lint: "go vet ./..." };
    case "rust":
      // cargo check/clippy/test ship with a standard rustup toolchain.
      return { test: "cargo test", typecheck: "cargo check", lint: "cargo clippy" };
    case "python":
      return pythonDefaults(packageDir);
    case "typescript":
    case "javascript":
      return jsDefaults(packageDir);
    default:
      return {};
  }
}

/** Python: pytest under the detected runner; lint/typecheck only when configured. */
async function pythonDefaults(packageDir: string): Promise<DefaultQualityCommands> {
  const deps = _commandDefaultsDeps;
  const pyproject = await deps.readText(join(packageDir, "pyproject.toml"));

  let prefix = "";
  if ((await deps.fileExists(join(packageDir, "uv.lock"))) || pyproject.includes("[tool.uv]")) {
    prefix = "uv run ";
  } else if ((await deps.fileExists(join(packageDir, "poetry.lock"))) || pyproject.includes("[tool.poetry]")) {
    prefix = "poetry run ";
  }

  const result: DefaultQualityCommands = { test: `${prefix}pytest` };
  // mypy/ruff are optional — only default when their config is present.
  if (pyproject.includes("[tool.mypy]") || (await deps.fileExists(join(packageDir, "mypy.ini")))) {
    result.typecheck = `${prefix}mypy .`;
  }
  if (
    pyproject.includes("[tool.ruff]") ||
    (await deps.fileExists(join(packageDir, "ruff.toml"))) ||
    (await deps.fileExists(join(packageDir, ".ruff.toml")))
  ) {
    result.lint = `${prefix}ruff check .`;
  }
  return result;
}

/** JS/TS: package-manager-aware test; typecheck/lint only when their config is present. */
async function jsDefaults(packageDir: string): Promise<DefaultQualityCommands> {
  const deps = _commandDefaultsDeps;
  const pm = await detectJsPackageManager(packageDir);
  const pkg = await deps.readJson(join(packageDir, "package.json"));
  const scripts = (pkg?.scripts as Record<string, unknown> | undefined) ?? {};

  const result: DefaultQualityCommands = {};

  if (typeof scripts.test === "string" && scripts.test.trim().length > 0) {
    result.test = `${pm} run test`;
  } else if (pm === "bun") {
    result.test = "bun test";
  }

  if (typeof scripts.typecheck === "string") {
    result.typecheck = `${pm} run typecheck`;
  } else if (await deps.fileExists(join(packageDir, "tsconfig.json"))) {
    result.typecheck = `${pm === "bun" ? "bunx" : `${pm} exec`} tsc --noEmit`;
  }

  if (await deps.fileExists(join(packageDir, "biome.json"))) {
    result.lint = `${pm === "bun" ? "bunx" : `${pm} exec`} biome check .`;
  } else if (
    (await deps.fileExists(join(packageDir, ".eslintrc"))) ||
    (await deps.fileExists(join(packageDir, ".eslintrc.json"))) ||
    (await deps.fileExists(join(packageDir, ".eslintrc.js"))) ||
    (await deps.fileExists(join(packageDir, "eslint.config.js")))
  ) {
    result.lint = `${pm === "bun" ? "bunx" : `${pm} exec`} eslint .`;
  }

  return result;
}

async function detectJsPackageManager(packageDir: string): Promise<"bun" | "pnpm" | "yarn" | "npm"> {
  const deps = _commandDefaultsDeps;
  if ((await deps.fileExists(join(packageDir, "bun.lock"))) || (await deps.fileExists(join(packageDir, "bun.lockb")))) {
    return "bun";
  }
  if (await deps.fileExists(join(packageDir, "pnpm-lock.yaml"))) return "pnpm";
  if (await deps.fileExists(join(packageDir, "yarn.lock"))) return "yarn";
  return "npm";
}
