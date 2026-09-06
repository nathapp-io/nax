import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";
import { resolvePackageName } from "@/agents/exec-package-name";

describe("buildCodingToolSupport with Exec", () => {
  test("does not advertise a tool named Exec", () => {
    const support = buildCodingToolSupport({
      root: "/repo/packages/foo",
      repoRoot: "/repo",
      grants: [
        { tool: "RunCommand", patterns: ["*"] },
        { tool: "Exec", patterns: ["bun add*"] },
      ],
      declared: ["RunCommand", "Exec"],
      declaredCommands: new Map([["test", "bun test"]]),
    });
    const names = (support?.tools ?? []).map((t) => t.name);
    expect(names).toContain("RunCommand");
    expect(names).not.toContain("Exec");
  });

  test("still returns undefined when Exec is the only declared tool and nothing else is granted", () => {
    const support = buildCodingToolSupport({
      root: "/repo",
      repoRoot: "/repo",
      grants: [{ tool: "RunCommand", patterns: ["*"] }],
      declared: ["Exec"],
    });
    expect(support).toBeUndefined();
  });
});

describe("resolvePackageName", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "nax-exec-package-name-"));
  });

  afterEach(() => {
    rmSync(join(root, "package.json"), { force: true });
    rmSync(join(root, "Cargo.toml"), { force: true });
    rmSync(join(root, "pyproject.toml"), { force: true });
  });

  test("returns undefined when no manifest is present", async () => {
    expect(await resolvePackageName(root)).toBeUndefined();
  });

  test("reads the name from package.json", async () => {
    await Bun.write(join(root, "package.json"), JSON.stringify({ name: "@scope/widget" }));
    expect(await resolvePackageName(root)).toBe("@scope/widget");
  });

  test("reads the name from Cargo.toml's [package] section, not a later [dependencies] entry", async () => {
    await Bun.write(
      join(root, "Cargo.toml"),
      [
        "[package]",
        'name = "widget-crate"',
        'version = "0.1.0"',
        "",
        "[dependencies]",
        'name = "not-the-package-name"',
      ].join("\n"),
    );
    expect(await resolvePackageName(root)).toBe("widget-crate");
  });

  test("reads the name from pyproject.toml's [project] section", async () => {
    await Bun.write(join(root, "pyproject.toml"), ["[project]", 'name = "widget-py"', 'version = "0.1.0"'].join("\n"));
    expect(await resolvePackageName(root)).toBe("widget-py");
  });

  test("package.json wins over Cargo.toml when both are present", async () => {
    await Bun.write(join(root, "package.json"), JSON.stringify({ name: "node-name" }));
    await Bun.write(join(root, "Cargo.toml"), ["[package]", 'name = "rust-name"'].join("\n"));
    expect(await resolvePackageName(root)).toBe("node-name");
  });
});
