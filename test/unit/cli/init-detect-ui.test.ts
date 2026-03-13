/**
 * Unit tests for ACS-002: UI framework stack detection in src/cli/init-detect.ts
 *
 * Covers:
 * - StackInfo type shape (uiFramework, hasBin fields)
 * - detectStack() UI framework detection from package.json deps
 * - detectStack() bin field detection
 * - buildInitConfig acceptance section population
 * - initProject integration: acceptance.testStrategy / testFramework in config.json
 *
 * All tests must fail (RED) until the implementation is complete.
 */

import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildInitConfig,
  detectStack,
} from "../../../src/cli/init-detect";
import type { StackInfo } from "../../../src/cli/init-detect";
import { initProject } from "../../../src/cli/init";
import { withTempDir } from "../../helpers/temp";

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
  test("StackInfo accepts uiFramework: ink", () => {
    const info: StackInfo = {
      runtime: "bun",
      language: "typescript",
      linter: "unknown",
      monorepo: "none",
      uiFramework: "ink",
    };
    expect(info.uiFramework).toBe("ink");
  });

  test("StackInfo accepts uiFramework: react", () => {
    const info: StackInfo = {
      runtime: "node",
      language: "typescript",
      linter: "unknown",
      monorepo: "none",
      uiFramework: "react",
    };
    expect(info.uiFramework).toBe("react");
  });

  test("StackInfo accepts uiFramework: vue", () => {
    const info: StackInfo = {
      runtime: "node",
      language: "typescript",
      linter: "unknown",
      monorepo: "none",
      uiFramework: "vue",
    };
    expect(info.uiFramework).toBe("vue");
  });

  test("StackInfo accepts uiFramework: svelte", () => {
    const info: StackInfo = {
      runtime: "node",
      language: "typescript",
      linter: "unknown",
      monorepo: "none",
      uiFramework: "svelte",
    };
    expect(info.uiFramework).toBe("svelte");
  });

  test("StackInfo accepts uiFramework: undefined", () => {
    const info: StackInfo = {
      runtime: "bun",
      language: "typescript",
      linter: "unknown",
      monorepo: "none",
    };
    expect(info.uiFramework).toBeUndefined();
  });

  test("StackInfo accepts hasBin: true", () => {
    const info: StackInfo = {
      runtime: "bun",
      language: "typescript",
      linter: "unknown",
      monorepo: "none",
      hasBin: true,
    };
    expect(info.hasBin).toBe(true);
  });

  test("StackInfo accepts hasBin: false", () => {
    const info: StackInfo = {
      runtime: "bun",
      language: "typescript",
      linter: "unknown",
      monorepo: "none",
      hasBin: false,
    };
    expect(info.hasBin).toBe(false);
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

  test("returns uiFramework: ink when ink is in devDependencies", async () => {
    await withTempDir(async (dir) => {
      const pkg = {
        name: "test",
        version: "0.0.1",
        devDependencies: { ink: "^4.0.0" },
      };
      await Bun.write(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
      const stack = detectStack(dir);
      expect(stack.uiFramework).toBe("ink");
    });
  });

  test("returns uiFramework: ink when ink is in peerDependencies", async () => {
    await withTempDir(async (dir) => {
      const pkg = {
        name: "test",
        version: "0.0.1",
        peerDependencies: { ink: "^4.0.0" },
      };
      await Bun.write(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
      const stack = detectStack(dir);
      expect(stack.uiFramework).toBe("ink");
    });
  });
});

describe("detectStack() — react detection", () => {
  test("returns uiFramework: react when react is in dependencies", async () => {
    await withTempDir(async (dir) => {
      await writePackageJson(dir, { react: "^18.0.0" });
      const stack = detectStack(dir);
      expect(stack.uiFramework).toBe("react");
    });
  });

  test("returns uiFramework: react when next is in dependencies", async () => {
    await withTempDir(async (dir) => {
      await writePackageJson(dir, { next: "^14.0.0" });
      const stack = detectStack(dir);
      expect(stack.uiFramework).toBe("react");
    });
  });
});

describe("detectStack() — vue detection", () => {
  test("returns uiFramework: vue when vue is in dependencies", async () => {
    await withTempDir(async (dir) => {
      await writePackageJson(dir, { vue: "^3.0.0" });
      const stack = detectStack(dir);
      expect(stack.uiFramework).toBe("vue");
    });
  });

  test("returns uiFramework: vue when nuxt is in dependencies", async () => {
    await withTempDir(async (dir) => {
      await writePackageJson(dir, { nuxt: "^3.0.0" });
      const stack = detectStack(dir);
      expect(stack.uiFramework).toBe("vue");
    });
  });
});

describe("detectStack() — svelte detection", () => {
  test("returns uiFramework: svelte when svelte is in dependencies", async () => {
    await withTempDir(async (dir) => {
      await writePackageJson(dir, { svelte: "^4.0.0" });
      const stack = detectStack(dir);
      expect(stack.uiFramework).toBe("svelte");
    });
  });

  test("returns uiFramework: svelte when @sveltejs/kit is in dependencies", async () => {
    await withTempDir(async (dir) => {
      await writePackageJson(dir, { "@sveltejs/kit": "^2.0.0" });
      const stack = detectStack(dir);
      expect(stack.uiFramework).toBe("svelte");
    });
  });
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
// buildInitConfig — acceptance section
// ---------------------------------------------------------------------------

describe("buildInitConfig — acceptance section for ink", () => {
  test("includes acceptance.testStrategy: component for ink stack", () => {
    const config = buildInitConfig({
      runtime: "bun",
      language: "typescript",
      linter: "unknown",
      monorepo: "none",
      uiFramework: "ink",
    }) as Record<string, unknown>;
    const acceptance = config.acceptance as Record<string, unknown> | undefined;
    expect(acceptance?.testStrategy).toBe("component");
  });

  test("includes acceptance.testFramework: ink-testing-library for ink stack", () => {
    const config = buildInitConfig({
      runtime: "bun",
      language: "typescript",
      linter: "unknown",
      monorepo: "none",
      uiFramework: "ink",
    }) as Record<string, unknown>;
    const acceptance = config.acceptance as Record<string, unknown> | undefined;
    expect(acceptance?.testFramework).toBe("ink-testing-library");
  });
});

describe("buildInitConfig — acceptance section for react", () => {
  test("includes acceptance.testStrategy: component for react stack", () => {
    const config = buildInitConfig({
      runtime: "node",
      language: "typescript",
      linter: "unknown",
      monorepo: "none",
      uiFramework: "react",
    }) as Record<string, unknown>;
    const acceptance = config.acceptance as Record<string, unknown> | undefined;
    expect(acceptance?.testStrategy).toBe("component");
  });

  test("includes acceptance.testFramework: @testing-library/react for react stack", () => {
    const config = buildInitConfig({
      runtime: "node",
      language: "typescript",
      linter: "unknown",
      monorepo: "none",
      uiFramework: "react",
    }) as Record<string, unknown>;
    const acceptance = config.acceptance as Record<string, unknown> | undefined;
    expect(acceptance?.testFramework).toBe("@testing-library/react");
  });
});

describe("buildInitConfig — acceptance section for bin-only CLI project", () => {
  test("includes acceptance.testStrategy: cli when hasBin is true and no UI framework", () => {
    const config = buildInitConfig({
      runtime: "bun",
      language: "typescript",
      linter: "unknown",
      monorepo: "none",
      hasBin: true,
    }) as Record<string, unknown>;
    const acceptance = config.acceptance as Record<string, unknown> | undefined;
    expect(acceptance?.testStrategy).toBe("cli");
  });

  test("includes acceptance.testFramework: bun:test for bin-only project", () => {
    const config = buildInitConfig({
      runtime: "bun",
      language: "typescript",
      linter: "unknown",
      monorepo: "none",
      hasBin: true,
    }) as Record<string, unknown>;
    const acceptance = config.acceptance as Record<string, unknown> | undefined;
    expect(acceptance?.testFramework).toBe("bun:test");
  });
});

describe("buildInitConfig — no acceptance section when no UI or bin", () => {
  test("omits acceptance section when no uiFramework and no bin", () => {
    const config = buildInitConfig({
      runtime: "bun",
      language: "typescript",
      linter: "unknown",
      monorepo: "none",
    }) as Record<string, unknown>;
    const acceptance = config.acceptance as Record<string, unknown> | undefined;
    expect(acceptance?.testStrategy).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// initProject integration — acceptance config written to config.json
// ---------------------------------------------------------------------------

describe("initProject — acceptance.testStrategy for ink project", () => {
  test("config.json has acceptance.testStrategy: component for ink project", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "bun.lockb"), "");
      await Bun.write(join(dir, "tsconfig.json"), "{}");
      await writePackageJson(dir, { ink: "^4.0.0" });

      await initProject(dir);

      const configPath = join(dir, "nax", "config.json");
      const config = JSON.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
      const acceptance = config.acceptance as Record<string, unknown> | undefined;
      expect(acceptance?.testStrategy).toBe("component");
    });
  });

  test("config.json has acceptance.testFramework: ink-testing-library for ink project", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "bun.lockb"), "");
      await Bun.write(join(dir, "tsconfig.json"), "{}");
      await writePackageJson(dir, { ink: "^4.0.0" });

      await initProject(dir);

      const configPath = join(dir, "nax", "config.json");
      const config = JSON.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
      const acceptance = config.acceptance as Record<string, unknown> | undefined;
      expect(acceptance?.testFramework).toBe("ink-testing-library");
    });
  });
});

describe("initProject — acceptance.testStrategy for bin-only project", () => {
  test("config.json has acceptance.testStrategy: cli for bin-only project", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "bun.lockb"), "");
      await Bun.write(join(dir, "tsconfig.json"), "{}");
      await writePackageJson(dir, {}, { mycli: "./dist/cli.js" });

      await initProject(dir);

      const configPath = join(dir, "nax", "config.json");
      const config = JSON.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
      const acceptance = config.acceptance as Record<string, unknown> | undefined;
      expect(acceptance?.testStrategy).toBe("cli");
    });
  });
});

describe("initProject — no acceptance section for plain project", () => {
  test("config.json omits acceptance.testStrategy for plain bun+ts project", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "bun.lockb"), "");
      await Bun.write(join(dir, "tsconfig.json"), "{}");
      // No package.json with UI deps or bin

      await initProject(dir);

      const configPath = join(dir, "nax", "config.json");
      const config = JSON.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
      const acceptance = config.acceptance as Record<string, unknown> | undefined;
      expect(acceptance?.testStrategy).toBeUndefined();
    });
  });
});
