/**
 * Unit tests for ACS-002: UI framework stack detection in src/cli/init-detect.ts
 *
 * Covers:
 * - StackInfo type shape (uiFramework, hasBin fields)
 * - detectStack() UI framework detection from package.json deps
 * - detectStack() bin field detection
 * - buildInitConfig builds only the quality section (AC-4/AC-5)
 * - initProject integration: the config.json it writes
 *
 * All tests must fail (RED) until the implementation is complete.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { initProject } from "@/cli/init";
import type { StackInfo, UIFramework } from "@/cli/init-detect";
import { buildInitConfig, detectStack } from "@/cli/init-detect";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a minimal package.json with given dependencies and optional bin */
async function writePackageJson(
  dir: string,
  deps: Record<string, string>,
  bin?: Record<string, string> | string,
): Promise<void> {
  const pkg: Record<string, unknown> = {
    name: "test-project",
    version: "0.0.1",
    dependencies: deps,
  };
  if (bin !== undefined) {
    pkg.bin = bin;
  }
  await Bun.write(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
}

// ---------------------------------------------------------------------------
// StackInfo type — shape contracts
// ---------------------------------------------------------------------------

describe("StackInfo type — shape contracts", () => {
  test.each<UIFramework | undefined>(["ink", "react", "vue", "svelte", undefined])(
    "StackInfo accepts uiFramework: %s",
    (uiFramework) => {
      const info: StackInfo = {
        runtime: "bun",
        language: "typescript",
        linter: "unknown",
        monorepo: "none",
        uiFramework,
      };
      expect(info.uiFramework).toBe(uiFramework);
    },
  );

  test.each([true, false])("StackInfo accepts hasBin: %s", (hasBin) => {
    const info: StackInfo = { runtime: "bun", language: "typescript", linter: "unknown", monorepo: "none", hasBin };
    expect(info.hasBin).toBe(hasBin);
  });
});

// ---------------------------------------------------------------------------
// detectStack() — UI framework detection
// ---------------------------------------------------------------------------

describe("detectStack() — ink detection", () => {
  test("returns uiFramework: ink when ink is in dependencies", async () => {
    await withTempDir(async (dir) => {
      await writePackageJson(dir, { ink: "^4.0.0" });
      const stack = detectStack(dir);
      expect(stack.uiFramework).toBe("ink");
    });
  });

  test.each(["devDependencies", "peerDependencies"])("returns uiFramework: ink when ink is in %s", async (depField) => {
    await withTempDir(async (dir) => {
      const pkg = { name: "test", version: "0.0.1", [depField]: { ink: "^4.0.0" } };
      await Bun.write(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
      const stack = detectStack(dir);
      expect(stack.uiFramework).toBe("ink");
    });
  });
});

describe("detectStack() — react detection", () => {
  test.each([
    [{ react: "^18.0.0" }, "react"],
    [{ next: "^14.0.0" }, "next"],
  ])("returns react when %s is in dependencies", async (deps) => {
    await withTempDir(async (dir) => {
      await writePackageJson(dir, deps);
      const stack = detectStack(dir);
      expect(stack.uiFramework).toBe("react");
    });
  });
});

describe("detectStack() — vue detection", () => {
  test.each([[{ vue: "^3.0.0" }], [{ nuxt: "^3.0.0" }]])("returns vue when %s is in dependencies", async (deps) => {
    await withTempDir(async (dir) => {
      await writePackageJson(dir, deps);
      const stack = detectStack(dir);
      expect(stack.uiFramework).toBe("vue");
    });
  });
});

describe("detectStack() — svelte detection", () => {
  test.each([[{ svelte: "^4.0.0" }], [{ "@sveltejs/kit": "^2.0.0" }]])(
    "returns svelte when %s is in dependencies",
    async (deps) => {
      await withTempDir(async (dir) => {
        await writePackageJson(dir, deps);
        const stack = detectStack(dir);
        expect(stack.uiFramework).toBe("svelte");
      });
    },
  );
});

describe("detectStack() — no UI framework", () => {
  test("returns uiFramework: undefined when no UI deps in package.json", async () => {
    await withTempDir(async (dir) => {
      await writePackageJson(dir, { lodash: "^4.0.0" });
      const stack = detectStack(dir);
      expect(stack.uiFramework).toBeUndefined();
    });
  });

  test("returns uiFramework: undefined when no package.json present", async () => {
    await withTempDir(async (dir) => {
      const stack = detectStack(dir);
      expect(stack.uiFramework).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// detectStack() — bin field detection
// ---------------------------------------------------------------------------

describe("detectStack() — hasBin detection", () => {
  test("returns hasBin: true when bin is an object in package.json", async () => {
    await withTempDir(async (dir) => {
      await writePackageJson(dir, {}, { mycli: "./dist/cli.js" });
      const stack = detectStack(dir);
      expect(stack.hasBin).toBe(true);
    });
  });

  test("returns hasBin: true when bin is a string in package.json", async () => {
    await withTempDir(async (dir) => {
      const pkg = {
        name: "test",
        version: "0.0.1",
        bin: "./dist/cli.js",
      };
      await Bun.write(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
      const stack = detectStack(dir);
      expect(stack.hasBin).toBe(true);
    });
  });

  test("returns hasBin: false or undefined when no bin in package.json", async () => {
    await withTempDir(async (dir) => {
      await writePackageJson(dir, { lodash: "^4.0.0" });
      const stack = detectStack(dir);
      expect(stack.hasBin).toBeFalsy();
    });
  });

  test("returns hasBin: false or undefined when no package.json", async () => {
    await withTempDir(async (dir) => {
      const stack = detectStack(dir);
      expect(stack.hasBin).toBeFalsy();
    });
  });
});

// ---------------------------------------------------------------------------
// detectStack() — priority: ink wins over react when both present
// ---------------------------------------------------------------------------

describe("detectStack() — framework priority", () => {
  test("ink takes priority over react when both present", async () => {
    await withTempDir(async (dir) => {
      await writePackageJson(dir, { ink: "^4.0.0", react: "^18.0.0" });
      const stack = detectStack(dir);
      expect(stack.uiFramework).toBe("ink");
    });
  });
});

// ---------------------------------------------------------------------------
// buildInitConfig — the quality section is the only section it builds
// ---------------------------------------------------------------------------

describe("buildInitConfig — a detected stack with commands", () => {
  test("AC-4: a bun + typescript stack with a bin has exactly the version and quality keys", () => {
    const config = buildInitConfig({
      runtime: "bun",
      language: "typescript",
      linter: "unknown",
      monorepo: "none",
      hasBin: true,
    }) as Record<string, unknown>;

    expect(Object.keys(config).sort()).toEqual(["quality", "version"]);
    expect(config.version).toBe(1);
    expect(Object.keys(config.quality as Record<string, unknown>)).toEqual(["commands"]);
  });
});

describe("buildInitConfig — an undetected stack", () => {
  test("AC-5: an undetected runtime and language with an ink dependency returns only the version", () => {
    expect(
      buildInitConfig({
        runtime: "unknown",
        language: "unknown",
        linter: "unknown",
        monorepo: "none",
        uiFramework: "ink",
      }),
    ).toEqual({ version: 1 });
  });
});

// ---------------------------------------------------------------------------
// initProject integration — the config written to config.json
// ---------------------------------------------------------------------------

describe("initProject — the written config carries the detected quality commands", () => {
  test("config.json has version 1 and quality.commands, and no acceptance section", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "bun.lockb"), "");
      await Bun.write(join(dir, "tsconfig.json"), "{}");
      await writePackageJson(dir, { ink: "^4.0.0" });

      await initProject(dir);

      const configPath = join(dir, ".nax", "config.json");
      const config = JSON.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
      expect(config.version).toBe(1);
      expect(config.quality).toHaveProperty("commands");
      expect(config).not.toHaveProperty("acceptance");
    });
  });
});
