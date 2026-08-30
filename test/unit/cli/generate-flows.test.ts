/**
 * Unit tests for src/cli/generate.ts — the --all-packages, --package, missing
 * context.md, auto-discovered per-package generation, and top-level error
 * paths that generate-package.test.ts (validation only) and the integration
 * suite (single/all-agent happy paths) don't exercise.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { generateCommand } from "@/cli/generate";
import { _generatorDeps } from "@/context/generator";

let tmpDir: string;
let originalExit: typeof process.exit;
let logs: string[];
let errors: string[];
let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalWarn: typeof console.warn;

beforeEach(() => {
  tmpDir = makeTempDir("nax-gen-flows-test-");
  mkdirSync(join(tmpDir, ".nax"), { recursive: true });
  writeFileSync(join(tmpDir, ".nax/context.md"), "# Context\n\nSome project context.");

  originalExit = process.exit;
  logs = [];
  errors = [];
  originalLog = console.log;
  originalError = console.error;
  originalWarn = console.warn;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  process.exit = originalExit;
  console.log = originalLog;
  console.error = originalError;
  console.warn = originalWarn;
  cleanupTempDir(tmpDir);
});

function mockProcessExit(): void {
  process.exit = mock((code?: number): never => {
    throw new Error(`process.exit(${code ?? 1})`);
  }) as typeof process.exit;
}

async function withDep<K extends keyof typeof _generatorDeps>(
  key: K,
  impl: (typeof _generatorDeps)[K],
  fn: () => Promise<void>,
): Promise<void> {
  const orig = _generatorDeps[key];
  _generatorDeps[key] = impl;
  try {
    await fn();
  } finally {
    _generatorDeps[key] = orig;
  }
}

describe("generateCommand — missing context.md", () => {
  test("exits 1 and prints a helpful message when .nax/context.md is absent", async () => {
    mockProcessExit();
    const emptyDir = makeTempDir("nax-gen-flows-nocontext-");
    mkdirSync(join(emptyDir, ".nax"), { recursive: true });
    try {
      let caught: unknown;
      try {
        await generateCommand({ dir: emptyDir });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("process.exit(1)");
      expect(errors.join("\n")).toContain("Context file not found");
    } finally {
      cleanupTempDir(emptyDir);
    }
  });
});

describe("generateCommand — --all-packages", () => {
  test("logs 'No packages found' and returns when no .nax/mono packages exist", async () => {
    await generateCommand({ dir: tmpDir, allPackages: true });

    expect(logs.join("\n")).toContain("No packages found");
  });

  test("dry run logs the dry-run warning before discovering packages", async () => {
    await generateCommand({ dir: tmpDir, allPackages: true, dryRun: true });

    expect(logs.join("\n")).toContain("Dry run");
  });

  test("generates and logs success for each discovered package", async () => {
    mkdirSync(join(tmpDir, ".nax", "mono", "pkg-a"), { recursive: true });
    writeFileSync(join(tmpDir, ".nax", "mono", "pkg-a", "context.md"), "# Pkg A");

    await generateCommand({ dir: tmpDir, allPackages: true });

    expect(logs.join("\n")).toContain("Generating agent files for 1 package(s)");
    expect(logs.join("\n")).toMatch(/CLAUDE\.md/);
  });

  test("exits 1 when a package's generation fails", async () => {
    mkdirSync(join(tmpDir, ".nax", "mono", "pkg-a"), { recursive: true });
    writeFileSync(join(tmpDir, ".nax", "mono", "pkg-a", "context.md"), "# Pkg A");
    mockProcessExit();

    await withDep(
      "writeFile",
      () => {
        throw new Error("disk full");
      },
      async () => {
        let caught: unknown;
        try {
          await generateCommand({ dir: tmpDir, allPackages: true });
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toContain("process.exit(1)");
      },
    );

    expect(errors.join("\n")).toContain("generation(s) failed");
  });
});

describe("generateCommand — --package", () => {
  test("generates the requested package and logs success", async () => {
    mkdirSync(join(tmpDir, ".nax", "mono", "svc"), { recursive: true });
    writeFileSync(join(tmpDir, ".nax", "mono", "svc", "context.md"), "# Svc");

    await generateCommand({ dir: tmpDir, package: "svc" });

    expect(logs.join("\n")).toContain("Generating agent files for package: svc");
    expect(logs.join("\n")).toMatch(/CLAUDE\.md/);
  });

  test("dry run for --package logs the dry-run warning", async () => {
    mkdirSync(join(tmpDir, ".nax", "mono", "svc"), { recursive: true });
    writeFileSync(join(tmpDir, ".nax", "mono", "svc", "context.md"), "# Svc");

    await generateCommand({ dir: tmpDir, package: "svc", dryRun: true });

    expect(logs.join("\n")).toContain("Dry run");
  });

  test("exits 1 when the package's own context.md is missing", async () => {
    mockProcessExit();

    let caught: unknown;
    try {
      await generateCommand({ dir: tmpDir, package: "does-not-exist" });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("process.exit(1)");
    expect(errors.join("\n")).toContain("context.md not found");
  });
});

describe("generateCommand — auto-discovered per-package generation after root generate", () => {
  test("discovers and generates per-package files after the root-level generate succeeds", async () => {
    mkdirSync(join(tmpDir, ".nax", "mono", "pkg-b"), { recursive: true });
    writeFileSync(join(tmpDir, ".nax", "mono", "pkg-b", "context.md"), "# Pkg B");

    await generateCommand({ dir: tmpDir });

    expect(logs.join("\n")).toContain("Discovered 1 package(s)");
    expect(logs.join("\n")).toContain("pkg-b/CLAUDE.md");
  });

  test("exits 1 when a discovered package fails to generate", async () => {
    mkdirSync(join(tmpDir, ".nax", "mono", "pkg-b"), { recursive: true });
    writeFileSync(join(tmpDir, ".nax", "mono", "pkg-b", "context.md"), "# Pkg B");
    mockProcessExit();

    await withDep(
      "writeFile",
      (path: string, content: string) => {
        if (path.includes("pkg-b")) {
          throw new Error("disk full");
        }
        return Bun.write(path, content);
      },
      async () => {
        let caught: unknown;
        try {
          await generateCommand({ dir: tmpDir });
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toContain("process.exit(1)");
      },
    );

    expect(errors.join("\n")).toContain("package generation(s) failed");
  });
});

describe("generateCommand — top-level catch", () => {
  test("catches an error thrown mid-generation and exits 1 with a 'Generation failed' message", async () => {
    mockProcessExit();

    await withDep(
      "readTextFile",
      () => {
        throw new Error("context file vanished mid-read");
      },
      async () => {
        let caught: unknown;
        try {
          await generateCommand({ dir: tmpDir });
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toContain("process.exit(1)");
      },
    );

    expect(errors.join("\n")).toContain("Generation failed");
  });
});
