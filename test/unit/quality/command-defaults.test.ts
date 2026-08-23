/**
 * Tests for detection-based default quality commands — the fallback used when no
 * test/lint/typecheck command is configured. Conservative: only emits commands
 * that are toolchain built-ins or whose tool/config marker is present.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _commandDefaultsDeps, clearCommandDefaultsCache, resolveDefaultQualityCommands } from "@/quality";

type Lang = "go" | "rust" | "python" | "typescript" | "javascript" | undefined;

const original = { ..._commandDefaultsDeps };

/** Configure deps: a set of existing files, pyproject text, package.json, and detected language. */
function setup(opts: {
  language: Lang;
  files?: string[];
  pyproject?: string;
  pkgJson?: Record<string, unknown> | null;
}) {
  const files = new Set((opts.files ?? []).map((f) => `/pkg/${f}`));
  _commandDefaultsDeps.detectLanguage = async () => opts.language;
  _commandDefaultsDeps.fileExists = async (p: string) => files.has(p);
  _commandDefaultsDeps.readText = async (p: string) => (p.endsWith("pyproject.toml") ? (opts.pyproject ?? "") : "");
  _commandDefaultsDeps.readJson = async () => opts.pkgJson ?? null;
}

describe("resolveDefaultQualityCommands", () => {
  beforeEach(() => clearCommandDefaultsCache());
  afterEach(() => {
    Object.assign(_commandDefaultsDeps, original);
    clearCommandDefaultsCache();
  });

  test("go uses built-in commands for all three", async () => {
    setup({ language: "go" });
    expect(await resolveDefaultQualityCommands("/pkg")).toEqual({
      test: "go test ./...",
      typecheck: "go build ./...",
      lint: "go vet ./...",
    });
  });

  test("rust uses cargo commands", async () => {
    setup({ language: "rust" });
    expect(await resolveDefaultQualityCommands("/pkg")).toEqual({
      test: "cargo test",
      typecheck: "cargo check",
      lint: "cargo clippy",
    });
  });

  test("python with uv.lock prefixes uv run; mypy/ruff only when configured", async () => {
    setup({ language: "python", files: ["uv.lock"], pyproject: "[tool.uv]\n[tool.mypy]\n[tool.ruff]" });
    expect(await resolveDefaultQualityCommands("/pkg")).toEqual({
      test: "uv run pytest",
      typecheck: "uv run mypy .",
      lint: "uv run ruff check .",
    });
  });

  test("plain python defaults to bare pytest and omits lint/typecheck", async () => {
    setup({ language: "python", pyproject: "[project]\nname='x'" });
    expect(await resolveDefaultQualityCommands("/pkg")).toEqual({ test: "pytest" });
  });

  test("poetry python prefixes poetry run", async () => {
    setup({ language: "python", files: ["poetry.lock"], pyproject: "[tool.poetry]" });
    expect((await resolveDefaultQualityCommands("/pkg")).test).toBe("poetry run pytest");
  });

  test("typescript with bun + scripts.test + tsconfig + biome", async () => {
    setup({
      language: "typescript",
      files: ["bun.lock", "tsconfig.json", "biome.json"],
      pkgJson: { scripts: { test: "bun test" } },
    });
    expect(await resolveDefaultQualityCommands("/pkg")).toEqual({
      test: "bun run test",
      typecheck: "bunx tsc --noEmit",
      lint: "bunx biome check .",
    });
  });

  test("typescript with pnpm and no test script omits test; tsconfig drives typecheck", async () => {
    setup({ language: "typescript", files: ["pnpm-lock.yaml", "tsconfig.json"], pkgJson: { scripts: {} } });
    expect(await resolveDefaultQualityCommands("/pkg")).toEqual({ typecheck: "pnpm exec tsc --noEmit" });
  });

  test("unknown language yields no defaults", async () => {
    setup({ language: undefined });
    expect(await resolveDefaultQualityCommands("/pkg")).toEqual({});
  });

  test("memoizes per packageDir", async () => {
    let calls = 0;
    setup({ language: "go" });
    _commandDefaultsDeps.detectLanguage = async () => {
      calls++;
      return "go";
    };
    await resolveDefaultQualityCommands("/pkg-memo");
    await resolveDefaultQualityCommands("/pkg-memo");
    expect(calls).toBe(1);
  });
});
