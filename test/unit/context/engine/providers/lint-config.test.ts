/**
 * LintConfigProvider (US-004) — surface package lint configuration.
 *
 * `LintConfigProvider` reads lint config from `request.packageDir` via the
 * public `detectProjectProfile()` detector and surfaces a `lint-config`
 * kind chunk at project scope. It never throws on missing/malformed config.
 *
 * Acceptance criteria mapping (provider scope):
 *  AC1   — constructor with no arguments succeeds
 *  AC2   — id = "lint-config", kind = "lint-config"
 *  AC5   — biome.json in packageDir → one chunk naming biome
 *  AC6   — biome.json indentWidth setting → chunk reports that indent width
 *  AC7   — detected lint configuration without a distiller → chunk names the detected tool
 *  AC8   — no lint config source file → empty chunks, never throws
 *  AC9   — no lint tool detectable for a package → empty chunks, never throws
 *  AC10  — malformed lint config file → chunk naming the tool, never throws
 *  AC11  — chunk has kind=lint-config and scope=project
 *  AC12  — packageDir contains lint config but repoRoot does not → one chunk
 *  AC13  — detectProjectProfile stubbed → fetch invokes it with request.packageDir
 *
 * Factory / stage-config wiring is covered by sibling tests:
 *  - lint-config-factory.test.ts (AC14)
 *  - lint-config-stage-config.test.ts (AC15, AC16)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectProfile } from "@/config";
import { LintConfigProvider, _lintConfigProviderDeps } from "@/context/engine";
import type { ContextRequest } from "@/context/engine/types";
import { cleanupTempDir, makeTempDir, withTempDir } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    storyId: "US-004",
    repoRoot: "/repo",
    packageDir: "/repo",
    stage: "rectify",
    role: "implementer",
    budgetTokens: 8_000,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Saved deps for restoration
// ─────────────────────────────────────────────────────────────────────────────

let origDetectProjectProfile: typeof _lintConfigProviderDeps.detectProjectProfile;
let origFileExists: typeof _lintConfigProviderDeps.fileExists;
let origReadFile: typeof _lintConfigProviderDeps.readFile;

beforeEach(() => {
  origDetectProjectProfile = _lintConfigProviderDeps.detectProjectProfile;
  origFileExists = _lintConfigProviderDeps.fileExists;
  origReadFile = _lintConfigProviderDeps.readFile;
  // Default: detector returns the package's detected lint tool; no files exist.
  _lintConfigProviderDeps.detectProjectProfile = async (_workdir, existing) =>
    ({ lintTool: "biome", ...existing }) as ProjectProfile;
  _lintConfigProviderDeps.fileExists = async () => false;
  _lintConfigProviderDeps.readFile = async () => "";
});

afterEach(() => {
  _lintConfigProviderDeps.detectProjectProfile = origDetectProjectProfile;
  _lintConfigProviderDeps.fileExists = origFileExists;
  _lintConfigProviderDeps.readFile = origReadFile;
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1 + AC2 — construction & identity
// ─────────────────────────────────────────────────────────────────────────────

describe("LintConfigProvider — AC1 + AC2 construction & identity", () => {
  test("AC1: construction succeeds with no arguments", () => {
    expect(() => new LintConfigProvider()).not.toThrow();
  });

  test("AC2: id is 'lint-config'", () => {
    const provider = new LintConfigProvider();
    expect(provider.id).toBe("lint-config");
  });

  test("AC2: kind is 'lint-config'", () => {
    const provider = new LintConfigProvider();
    expect(provider.kind).toBe("lint-config");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — biome.json present → one chunk naming biome
// ─────────────────────────────────────────────────────────────────────────────

describe("LintConfigProvider — AC5 biome.json present", () => {
  test("AC5: returns one chunk naming biome when biome.json exists in packageDir", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "biome.json"), JSON.stringify({}), "utf8");
      _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: "biome" });
      // Wire fileExists/readFile to read from real disk so we exercise the
      // file-read path (the default beforeEach state suppresses I/O).
      _lintConfigProviderDeps.fileExists = async (path) => {
        try {
          return await Bun.file(path).exists();
        } catch {
          return false;
        }
      };
      _lintConfigProviderDeps.readFile = async (path) => await Bun.file(path).text();

      const provider = new LintConfigProvider();
      const result = await provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }));

      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0].content.toLowerCase()).toContain("biome");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6 — biome.json indentWidth → chunk reports that indent width
// ─────────────────────────────────────────────────────────────────────────────

describe("LintConfigProvider — AC6 biome indentWidth distiller", () => {
  // Wire deps to read from real disk so the distiller sees actual JSON content.
  async function wireRealDisk() {
    _lintConfigProviderDeps.fileExists = async (path) => {
      try {
        return await Bun.file(path).exists();
      } catch {
        return false;
      }
    };
    _lintConfigProviderDeps.readFile = async (path) => await Bun.file(path).text();
  }

  test("AC6: chunk reports the indent width configured in biome.json", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "biome.json"), JSON.stringify({ indentWidth: 4 }), "utf8");
      _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: "biome" });
      await wireRealDisk();

      const provider = new LintConfigProvider();
      const result = await provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }));

      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0].content).toContain("4");
    });
  });

  test("AC6: chunk reports indent width 2 when configured (default in this repo)", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "biome.json"), JSON.stringify({ indentWidth: 2 }), "utf8");
      _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: "biome" });
      await wireRealDisk();

      const provider = new LintConfigProvider();
      const result = await provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }));

      expect(result.chunks[0].content).toContain("2");
    });
  });

  test("AC6: chunk reports formatter.indentWidth under formatter block", async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        join(dir, "biome.json"),
        JSON.stringify({ formatter: { indentWidth: 3, indentStyle: "tab" } }),
        "utf8",
      );
      _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: "biome" });
      await wireRealDisk();

      const provider = new LintConfigProvider();
      const result = await provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }));

      expect(result.chunks[0].content).toContain("3");
      expect(result.chunks[0].content).toContain("tab");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7 — detected lint configuration without a distiller
// ─────────────────────────────────────────────────────────────────────────────

describe("LintConfigProvider — AC7 degrade to detected tool name when no distiller", () => {
  async function wireRealDisk() {
    _lintConfigProviderDeps.fileExists = async (path) => {
      try {
        return await Bun.file(path).exists();
      } catch {
        return false;
      }
    };
    _lintConfigProviderDeps.readFile = async (path) => await Bun.file(path).text();
  }

  test("AC7: returns a chunk naming eslint when eslint config is detected but no distiller exists", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, ".eslintrc.json"), JSON.stringify({ rules: {} }), "utf8");
      _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: "eslint" });
      await wireRealDisk();

      const provider = new LintConfigProvider();
      const result = await provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }));

      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0].content.toLowerCase()).toContain("eslint");
    });
  });

  test("AC7: returns a chunk naming ruff when ruff config (pyproject.toml) is detected but no distiller exists", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "pyproject.toml"), "[tool.ruff]\nline-length = 100\n", "utf8");
      _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: "ruff" });
      await wireRealDisk();

      const provider = new LintConfigProvider();
      const result = await provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }));

      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0].content.toLowerCase()).toContain("ruff");
    });
  });

  test("AC7: returns a chunk naming golangci-lint when .golangci.yml is detected but no distiller exists", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, ".golangci.yml"), "run:\n  timeout: 5m\n", "utf8");
      _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: "golangci-lint" });
      await wireRealDisk();

      const provider = new LintConfigProvider();
      const result = await provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }));

      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0].content.toLowerCase()).toContain("golangci-lint");
    });
  });

  test("AC7/AC8: returns empty chunks when ruff is detected but no config file exists", async () => {
    await withTempDir(async (dir) => {
      _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: "ruff" });
      await wireRealDisk();

      const provider = new LintConfigProvider();
      const result = await provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }));

      expect(result.chunks).toEqual([]);
    });
  });

  test("AC7: returns a chunk naming clippy when Cargo.toml is present (clippy's lint config)", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "Cargo.toml"), '[package]\nname = "x"\n[lints.clippy]\nwarn = []\n', "utf8");
      _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: "clippy" });
      await wireRealDisk();

      const provider = new LintConfigProvider();
      const result = await provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }));

      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0].content.toLowerCase()).toContain("clippy");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC8 — no lint config source file → empty chunks, never throws
// ─────────────────────────────────────────────────────────────────────────────

describe("LintConfigProvider — AC8 no lint config source file", () => {
  test("AC8: returns empty chunks without throwing when a lint tool is detected but no config file exists", async () => {
    await withTempDir(async (dir) => {
      // AC8: lintTool IS detected (biome) but biome.json is absent in packageDir.
      // Per AC8, fetch must return empty chunks — not a chunk that just names the tool.
      _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: "biome" });
      const provider = new LintConfigProvider();
      await expect(provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }))).resolves.toBeDefined();
      const result = await provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }));
      expect(result.chunks).toEqual([]);
    });
  });

  test("AC8: returns empty chunks without throwing when no lint config file exists and no lint tool is detected", async () => {
    await withTempDir(async (dir) => {
      _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: undefined });
      const provider = new LintConfigProvider();
      await expect(provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }))).resolves.toBeDefined();
      const result = await provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }));
      expect(result.chunks).toEqual([]);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC9 — no lint tool detectable → empty chunks, never throws
// ─────────────────────────────────────────────────────────────────────────────

describe("LintConfigProvider — AC9 no lint tool detectable", () => {
  test("AC9: returns empty chunks without throwing when no lint tool is detected", async () => {
    await withTempDir(async (dir) => {
      _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: undefined });
      const provider = new LintConfigProvider();
      await expect(provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }))).resolves.toBeDefined();
      const result = await provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }));
      expect(result.chunks).toEqual([]);
    });
  });

  test("AC9: returns empty chunks when detectProjectProfile returns a profile with no lintTool", async () => {
    _lintConfigProviderDeps.detectProjectProfile = async () => ({
      language: "typescript",
      type: "cli",
    });
    const provider = new LintConfigProvider();
    const result = await provider.fetch(makeRequest());
    expect(result.chunks).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC10 — malformed lint config file → chunk naming the tool, never throws
// ─────────────────────────────────────────────────────────────────────────────

describe("LintConfigProvider — AC10 malformed lint config file", () => {
  async function wireRealDisk() {
    _lintConfigProviderDeps.fileExists = async (path) => {
      try {
        return await Bun.file(path).exists();
      } catch {
        return false;
      }
    };
    _lintConfigProviderDeps.readFile = async (path) => await Bun.file(path).text();
  }

  test("AC10: returns a chunk naming biome when biome.json is malformed JSON", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "biome.json"), "{ not valid json", "utf8");
      _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: "biome" });
      await wireRealDisk();

      const provider = new LintConfigProvider();
      await expect(provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }))).resolves.toBeDefined();
      const result = await provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }));
      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0].content.toLowerCase()).toContain("biome");
    });
  });

  test("AC10: does not throw when biome.json is valid JSON 'null' (defensive against non-object literals)", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "biome.json"), "null", "utf8");
      _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: "biome" });
      await wireRealDisk();

      const provider = new LintConfigProvider();
      await expect(provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }))).resolves.toBeDefined();
      const result = await provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }));
      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0].content.toLowerCase()).toContain("biome");
    });
  });

  test("AC10: does not throw when biome.json is a JSON array (defensive against non-object literals)", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "biome.json"), "[]", "utf8");
      _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: "biome" });
      await wireRealDisk();

      const provider = new LintConfigProvider();
      await expect(provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }))).resolves.toBeDefined();
      const result = await provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }));
      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0].content.toLowerCase()).toContain("biome");
    });
  });

  test("AC10: does not throw when biome.json is a JSON primitive (defensive against non-object literals)", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "biome.json"), "42", "utf8");
      _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: "biome" });
      await wireRealDisk();

      const provider = new LintConfigProvider();
      await expect(provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }))).resolves.toBeDefined();
      const result = await provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }));
      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0].content.toLowerCase()).toContain("biome");
    });
  });

  test("AC10: does not throw when detectProjectProfile itself rejects", async () => {
    _lintConfigProviderDeps.detectProjectProfile = async () => {
      throw new Error("detector failed");
    };
    const provider = new LintConfigProvider();
    await expect(provider.fetch(makeRequest())).resolves.toBeDefined();
    const result = await provider.fetch(makeRequest());
    expect(result.chunks).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC11 — chunk has kind=lint-config and scope=project
// ─────────────────────────────────────────────────────────────────────────────

describe("LintConfigProvider — AC11 chunk shape", () => {
  async function wireRealDisk() {
    _lintConfigProviderDeps.fileExists = async (path) => {
      try {
        return await Bun.file(path).exists();
      } catch {
        return false;
      }
    };
    _lintConfigProviderDeps.readFile = async (path) => await Bun.file(path).text();
  }

  test("AC11: every returned chunk has kind='lint-config' and scope='project'", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "biome.json"), JSON.stringify({}), "utf8");
      _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: "biome" });
      await wireRealDisk();

      const provider = new LintConfigProvider();
      const result = await provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }));

      for (const chunk of result.chunks) {
        expect(chunk.kind).toBe("lint-config");
        expect(chunk.scope).toBe("project");
      }
    });
  });

  test("AC11: emitted chunk has tokens > 0", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "biome.json"), JSON.stringify({}), "utf8");
      _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: "biome" });
      await wireRealDisk();

      const provider = new LintConfigProvider();
      const result = await provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }));

      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0].tokens).toBeGreaterThan(0);
    });
  });

  test("AC11: pullTools is always empty (push-only provider)", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "biome.json"), JSON.stringify({}), "utf8");
      _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: "biome" });
      await wireRealDisk();

      const provider = new LintConfigProvider();
      const result = await provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }));

      expect(result.pullTools).toEqual([]);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC12 — packageDir contains lint config but repoRoot does not → one chunk
// ─────────────────────────────────────────────────────────────────────────────

describe("LintConfigProvider — AC12 package-scoped detection", () => {
  async function wireRealDisk() {
    _lintConfigProviderDeps.fileExists = async (path) => {
      try {
        return await Bun.file(path).exists();
      } catch {
        return false;
      }
    };
    _lintConfigProviderDeps.readFile = async (path) => await Bun.file(path).text();
  }

  test("AC12: returns one chunk when packageDir has biome.json but repoRoot does not", async () => {
    const packageDir = makeTempDir("nax-lint-config-pkg-");
    const repoRoot = makeTempDir("nax-lint-config-repo-");
    try {
      await writeFile(join(packageDir, "biome.json"), JSON.stringify({}), "utf8");
      _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: "biome" });
      await wireRealDisk();

      const provider = new LintConfigProvider();
      const result = await provider.fetch(makeRequest({ packageDir, repoRoot }));

      expect(result.chunks).toHaveLength(1);
    } finally {
      cleanupTempDir(packageDir);
      cleanupTempDir(repoRoot);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC13 — detectProjectProfile stubbed → fetch invokes it with request.packageDir
// ─────────────────────────────────────────────────────────────────────────────

describe("LintConfigProvider — AC13 detectProjectProfile called with packageDir", () => {
  test("AC13: invokes detectProjectProfile with the request's packageDir", async () => {
    await withTempDir(async (dir) => {
      let capturedWorkdir: string | undefined;
      _lintConfigProviderDeps.detectProjectProfile = async (workdir, existing) => {
        capturedWorkdir = workdir;
        return { lintTool: "biome", ...existing };
      };

      const provider = new LintConfigProvider();
      await provider.fetch(makeRequest({ packageDir: dir, repoRoot: "/elsewhere" }));

      expect(capturedWorkdir).toBe(dir);
    });
  });

  test("AC13: invokes detectProjectProfile with the existing profile when passed via constructor", async () => {
    await withTempDir(async (dir) => {
      let capturedExisting: ProjectProfile | undefined;
      _lintConfigProviderDeps.detectProjectProfile = async (workdir, existing) => {
        capturedExisting = existing as ProjectProfile;
        return { lintTool: "biome", ...(existing as ProjectProfile) };
      };

      const existing: ProjectProfile = { language: "typescript" };
      const provider = new LintConfigProvider(existing);
      await provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }));

      expect(capturedExisting).toBe(existing);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Real-filesystem integration (mirror of the spec's "lint-config reads the
// path it claims to read" guard against fragments-defect regressions)
// ─────────────────────────────────────────────────────────────────────────────

describe("LintConfigProvider — real-filesystem integration", () => {
  test("reads biome.json from the real packageDir", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "biome.json"), JSON.stringify({ indentWidth: 4, lineWidth: 100 }), "utf8");

      // Wire deps to read from real disk so we exercise the read path,
      // not the mock. detector is the real public detector.
      const { detectProjectProfile } = await import("@/project");
      _lintConfigProviderDeps.detectProjectProfile = async (workdir, existing) =>
        detectProjectProfile(workdir, existing);
      _lintConfigProviderDeps.fileExists = async (path) => {
        try {
          return await Bun.file(path).exists();
        } catch {
          return false;
        }
      };
      _lintConfigProviderDeps.readFile = async (path) => await Bun.file(path).text();

      const provider = new LintConfigProvider();
      const result = await provider.fetch(makeRequest({ packageDir: dir, repoRoot: dir }));

      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0].content.toLowerCase()).toContain("biome");
      expect(result.chunks[0].content).toContain("4");
    });
  });
});
