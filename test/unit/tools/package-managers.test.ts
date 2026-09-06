import { describe, expect, test } from "bun:test";
import type { NormalizeInput } from "@/tools/package-managers";
import { classifyExec, isKnownManager, normalizeExec } from "@/tools/package-managers";

const base: Omit<NormalizeInput, "argv" | "target"> = {
  repoRoot: "/repo",
  packageWorkdir: "/repo/packages/foo",
  packageRelPath: "packages/foo",
  packageName: "@acme/foo",
  allowScripts: false,
};

describe("classifyExec", () => {
  test("a known manager with an install verb is install-shaped", () => {
    expect(classifyExec(["bun", "add", "x"])).toBe("install");
    expect(classifyExec(["npm", "ci"])).toBe("install");
    expect(classifyExec(["go", "mod", "download"])).toBe("install");
  });

  test("a known manager with a non-install verb is generic", () => {
    // The second thing the 2026-09-06 run's model reached for. If this is
    // "install", no grant can ever permit it.
    expect(classifyExec(["bun", "x", "tsc", "--noEmit"])).toBe("generic");
    expect(classifyExec(["npm", "run", "build"])).toBe("generic");
  });

  test("an unknown binary is generic", () => {
    expect(classifyExec(["make", "build"])).toBe("generic");
  });
});

describe("normalizeExec — install-shaped", () => {
  test("appends the no-scripts flag and runs a package-target bun add in the package dir", () => {
    expect(normalizeExec({ ...base, argv: ["bun", "add", "-d", "bun-types"], target: "package" })).toEqual({
      argv: ["bun", "add", "-d", "bun-types", "--ignore-scripts"],
      cwd: "/repo/packages/foo",
    });
  });

  test("runs a repoRoot-target bun add at the repo root", () => {
    expect(normalizeExec({ ...base, argv: ["bun", "add", "-d", "bun-types"], target: "repoRoot" })).toEqual({
      argv: ["bun", "add", "-d", "bun-types", "--ignore-scripts"],
      cwd: "/repo",
    });
  });

  test("pnpm filters by PATH with the mandatory ./ prefix", () => {
    // Bare "packages/foo" is parsed by pnpm as a package NAME and silently
    // selects nothing. The ./ prefix is what makes it a path.
    expect(normalizeExec({ ...base, argv: ["pnpm", "add", "bun-types"], target: "package" })).toEqual({
      argv: ["pnpm", "--filter", "./packages/foo", "add", "bun-types", "--ignore-scripts"],
      cwd: "/repo",
    });
  });

  test("npm scopes with -w", () => {
    expect(normalizeExec({ ...base, argv: ["npm", "install", "-D", "bun-types"], target: "package" })).toEqual({
      argv: ["npm", "-w", "packages/foo", "install", "-D", "bun-types", "--ignore-scripts"],
      cwd: "/repo",
    });
  });

  test("yarn 1 takes the flag; yarn 2+ takes the environment variable", () => {
    const classic = normalizeExec({
      ...base,
      argv: ["yarn", "add", "bun-types"],
      target: "package",
      yarnMajor: 1,
    });
    expect(classic).toEqual({
      argv: ["yarn", "workspace", "@acme/foo", "add", "bun-types", "--ignore-scripts"],
      cwd: "/repo",
    });

    const berry = normalizeExec({
      ...base,
      argv: ["yarn", "add", "bun-types"],
      target: "package",
      yarnMajor: 4,
    });
    expect(berry).toEqual({
      argv: ["yarn", "workspace", "@acme/foo", "add", "bun-types"],
      cwd: "/repo",
      env: { YARN_ENABLE_SCRIPTS: "false" },
    });
  });

  test("yarn and cargo deny when the package name cannot be resolved", () => {
    const noName: Omit<NormalizeInput, "argv" | "target"> = { ...base, packageName: undefined };
    expect(normalizeExec({ ...noName, argv: ["yarn", "add", "x"], target: "package", yarnMajor: 4 })).toHaveProperty(
      "error",
    );
    expect(normalizeExec({ ...noName, argv: ["cargo", "add", "serde"], target: "package" })).toHaveProperty("error");
  });

  test("cargo scopes by NAME, not path", () => {
    expect(normalizeExec({ ...base, packageName: "foo", argv: ["cargo", "add", "serde"], target: "package" })).toEqual({
      argv: ["cargo", "add", "-p", "foo", "serde"],
      cwd: "/repo",
    });
  });

  test("adds no mechanism for managers that run no install scripts", () => {
    expect(normalizeExec({ ...base, argv: ["go", "mod", "download"], target: "package" })).toEqual({
      argv: ["go", "mod", "download"],
      cwd: "/repo/packages/foo",
    });
  });

  test("omits the no-scripts mechanism when the project opted in", () => {
    expect(normalizeExec({ ...base, argv: ["bun", "add", "x"], target: "package", allowScripts: true })).toEqual({
      argv: ["bun", "add", "x"],
      cwd: "/repo/packages/foo",
    });
  });

  test("collapses both targets to one directory in a single-package repo", () => {
    const single: Omit<NormalizeInput, "argv" | "target" | "packageName"> = {
      repoRoot: "/repo",
      packageWorkdir: "/repo",
      packageRelPath: "",
      allowScripts: false,
    };
    expect(normalizeExec({ ...single, argv: ["bun", "add", "x"], target: "package" })).toEqual(
      normalizeExec({ ...single, argv: ["bun", "add", "x"], target: "repoRoot" }),
    );
  });
});

describe("normalizeExec — generic", () => {
  test("runs as given at the package dir, with no scoping and no mechanism", () => {
    expect(normalizeExec({ ...base, argv: ["bun", "x", "tsc", "--noEmit"], target: "package" })).toEqual({
      argv: ["bun", "x", "tsc", "--noEmit"],
      cwd: "/repo/packages/foo",
    });
  });

  test("runs at the repo root when the target says so", () => {
    expect(normalizeExec({ ...base, argv: ["make", "build"], target: "repoRoot" })).toEqual({
      argv: ["make", "build"],
      cwd: "/repo",
    });
  });
});

describe("isKnownManager", () => {
  test("knows the eight managers and nothing else", () => {
    for (const binary of ["npm", "bun", "pnpm", "yarn", "pip", "uv", "go", "cargo"]) {
      expect(isKnownManager(binary)).toBe(true);
    }
    expect(isKnownManager("make")).toBe(false);
  });
});
