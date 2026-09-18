/**
 * Tests for the profile-threading gate (nax#2126).
 *
 * A gate is only worth the line it occupies if it is known to fire. Each case
 * below is a shape that the first revision of this script got wrong: it decided
 * declaration-vs-call from the ARGUMENT text, so a real call carrying any inline
 * type annotation was skipped; it matched the function by literal name, so an
 * aliased import was invisible; and it recognised comments only at line start, so
 * prose and string literals mentioning the function were reported as defects.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blankNonCode, countArgs, findViolations, scan } from "@scripts/check-config-profile-threading";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

const FILE = "src/execution/probe.ts";

describe("findViolations — calls that must be flagged", () => {
  test("the nax#2126 defect shape: two arguments, overrides omitted", () => {
    const src = [
      'import { loadConfigForWorkdir } from "@/config";',
      "export const load = async (projectDir: string, relativeWorkdir: string) =>",
      '  loadConfigForWorkdir(path.join(projectDir, ".nax", "config.json"), relativeWorkdir || undefined);',
      "",
    ].join("\n");

    const violations = findViolations(FILE, src);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(3);
    expect(violations[0]?.argCount).toBe(2);
  });

  test("a call through a _deps object property", () => {
    const src = "const c = await _someDeps.loadConfigForWorkdir(rootConfigPath, relativeWorkdir);\n";

    expect(findViolations(FILE, src)).toHaveLength(1);
  });

  // The argument carries `workdir: string`, which the first revision read as a
  // parameter list and skipped. The cast idiom is already used in src/execution/.
  test("a real call whose argument contains an inline type annotation", () => {
    const src = [
      'import { loadConfigForWorkdir } from "@/config";',
      "export const b = (root: string, story: { workdir: string }) =>",
      "  loadConfigForWorkdir(root, (story as { workdir: string }).workdir);",
      "",
    ].join("\n");

    const violations = findViolations(FILE, src);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.argCount).toBe(2);
  });

  test("an aliased import — renaming the binding does not evade the gate", () => {
    const src = [
      'import { loadConfigForWorkdir as loadCfg } from "@/config";',
      "export const c = (root: string, pkg: string) => loadCfg(root, pkg);",
      "",
    ].join("\n");

    const violations = findViolations(FILE, src);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.callee).toBe("loadCfg");
  });

  test("a single-argument call", () => {
    expect(findViolations(FILE, "const c = await loadConfigForWorkdir(rootConfigPath);\n")).toHaveLength(1);
  });
});

describe("findViolations — shapes that must stay clean", () => {
  test("all three arguments, on one line", () => {
    const src = "const c = await loadConfigForWorkdir(rootConfigPath, pkg, profileOverride);\n";

    expect(findViolations(FILE, src)).toHaveLength(0);
  });

  // biome formats a long call across lines with a trailing comma; counting that
  // comma as an argument would make the gate pass everything.
  test("all three arguments, wrapped with a trailing comma", () => {
    const src = [
      "const effectiveConfig = await _parallelBatchDeps.loadConfigForWorkdir(",
      "  rootConfigPath,",
      "  storyPackageDir(story) as string,",
      "  profileOverride,",
      ");",
      "",
    ].join("\n");

    expect(findViolations(FILE, src)).toHaveLength(0);
  });

  test("an interface member declaration, not a call", () => {
    const src = [
      "export interface Deps {",
      "  loadConfigForWorkdir(rootConfigPath: string, workdir?: string): Promise<NaxConfig>;",
      "}",
      "",
    ].join("\n");

    expect(findViolations(FILE, src)).toHaveLength(0);
  });

  test("a function declaration, not a call", () => {
    const src = [
      "export async function loadConfigForWorkdir(",
      "  rootConfigPath: string,",
      "  packageDir?: string,",
      "): Promise<NaxConfig> {",
      "  return inner();",
      "}",
      "",
    ].join("\n");

    expect(findViolations(FILE, src)).toHaveLength(0);
  });

  test("the function named inside a string literal", () => {
    const src = 'export const msg = "loadConfigForWorkdir(rootPath, pkg) dropped the profile";\n';

    expect(findViolations(FILE, src)).toHaveLength(0);
  });

  test("the function named in a trailing comment", () => {
    const src = "export const g = 1; // historically loadConfigForWorkdir(rootPath, pkg)\n";

    expect(findViolations(FILE, src)).toHaveLength(0);
  });

  test("the function named inside a block comment", () => {
    const src = ["/**", " * Callers used loadConfigForWorkdir(root, pkg) before the helper existed.", " */", ""].join(
      "\n",
    );

    expect(findViolations(FILE, src)).toHaveLength(0);
  });

  test("a bare import with no call", () => {
    expect(findViolations(FILE, 'import { loadConfigForWorkdir } from "@/config";\n')).toHaveLength(0);
  });

  test("an allow marker on the line above", () => {
    const src = [
      "// nax-profile-threading-allow: intentionally reads the un-profiled root config",
      "const c = await loadConfigForWorkdir(rootConfigPath, pkg);",
      "",
    ].join("\n");

    expect(findViolations(FILE, src)).toHaveLength(0);
  });

  test("an allow marker trailing the call's own line", () => {
    const src = "const c = await loadConfigForWorkdir(root, pkg); // nax-profile-threading-allow: root read\n";

    expect(findViolations(FILE, src)).toHaveLength(0);
  });
});

describe("blankNonCode / countArgs", () => {
  test("blanking preserves length and line structure", () => {
    const src = 'const a = 1; // loadConfigForWorkdir(x)\nconst b = "loadConfigForWorkdir(y)";\n';

    const blanked = blankNonCode(src);

    expect(blanked).toHaveLength(src.length);
    expect(blanked.split("\n")).toHaveLength(src.split("\n").length);
    expect(blanked).not.toContain("loadConfigForWorkdir");
    expect(blanked).toContain("const a = 1;");
  });

  test("generics and nested calls do not split arguments", () => {
    expect(countArgs("root, resolve<A, B>(x, y), override")).toBe(3);
    expect(countArgs("root, pkg,")).toBe(2);
    expect(countArgs("")).toBe(0);
  });
});

describe("scan", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-config-profile-threading-check-");
    mkdirSync(join(tempDir, "src", "execution"), { recursive: true });
    mkdirSync(join(tempDir, "src", "config"), { recursive: true });
    mkdirSync(join(tempDir, "scripts"), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("exempts src/config/, where the primitive and its wrapper live", async () => {
    writeFileSync(
      join(tempDir, "src", "config", "package-config.ts"),
      "export const f = () => loadConfigForWorkdir(rootConfigPath, packageDir);\n",
    );

    expect(await scan(tempDir)).toHaveLength(0);
  });

  test("scans scripts/ as well as src/", async () => {
    writeFileSync(join(tempDir, "scripts", "tool.ts"), "const c = await loadConfigForWorkdir(root, pkg);\n");

    const violations = await scan(tempDir);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe("scripts/tool.ts");
  });

  test("a tree with only compliant call sites is clean", async () => {
    writeFileSync(
      join(tempDir, "src", "execution", "runner.ts"),
      "const c = await loadConfigForWorkdir(root, pkg, profileOverrideFromConfig(config));\n",
    );

    expect(await scan(tempDir)).toHaveLength(0);
  });
});
