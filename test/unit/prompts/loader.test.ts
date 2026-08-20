/**
 * loadOverride unit tests — PB-003
 *
 * Tests are expected to FAIL until src/prompts/loader.ts is implemented.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promptLoaderConfigSelector } from "@/config";
import type { NaxConfig } from "@/config";
import { loadOverride } from "@/prompts/loader";
import type { PromptRole } from "@/prompts/core/types";
import { fullTest } from "../../helpers/env";
import { makeTempDir } from "@test/helpers";
import { makeNaxConfig } from "@test/helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: DeepPartial<NaxConfig> = {}) {
  return makeNaxConfig(overrides);
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let createdFiles: string[] = [];

beforeEach(() => {
  tmpDir = makeTempDir("nax-loader-test-");
  createdFiles = [];
});

afterEach(() => {
  // Clean up any chmod'd files by restoring permissions first
  for (const f of createdFiles) {
    try {
      chmodSync(f, 0o644);
      unlinkSync(f);
    } catch {
      // best-effort
    }
  }
  try {
    Bun.spawnSync(["rm", "-rf", tmpDir]);
  } catch {
    // best-effort
  }
});

function writeOverrideFile(relPath: string, content: string): string {
  const abs = join(tmpDir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  createdFiles.push(abs);
  return relPath; // return relative path for use in config
}

// ---------------------------------------------------------------------------
// 1. Returns null when config.prompts is undefined
// ---------------------------------------------------------------------------

describe("loadOverride — config.prompts absent", () => {
  test("returns null when config has no prompts block", async () => {
    const config = makeConfig(); // no prompts field
    const result = await loadOverride("test-writer", tmpDir, config);
    expect(result).toBeNull();
  });

  test("returns null for every role when config.prompts is absent", async () => {
    const config = makeConfig();
    const roles: PromptRole[] = ["test-writer", "implementer", "verifier", "single-session"];
    for (const role of roles) {
      const result = await loadOverride(role, tmpDir, config);
      expect(result).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Returns null when prompts.overrides has no key for the role
// ---------------------------------------------------------------------------

describe("loadOverride — role key absent in overrides", () => {
  test("returns null when overrides map is empty", async () => {
    const config = makeConfig({ prompts: { overrides: {} } });
    const result = await loadOverride("implementer", tmpDir, config);
    expect(result).toBeNull();
  });

  test("returns null when only other roles are configured", async () => {
    const relPath = writeOverrideFile(".nax/prompts/implementer.md", "# Implementer");
    const config = makeConfig({
      prompts: { overrides: { implementer: relPath } },
    });
    // ask for test-writer — not configured
    const result = await loadOverride("test-writer", tmpDir, config);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Returns null when file path is set but file does not exist
// ---------------------------------------------------------------------------

describe("loadOverride — file missing", () => {
  test("returns null when file at configured path does not exist", async () => {
    const config = makeConfig({
      prompts: { overrides: { "test-writer": ".nax/prompts/missing.md" } },
    });
    const result = await loadOverride("test-writer", tmpDir, config);
    expect(result).toBeNull();
  });

  test("returns null for a deeply nested nonexistent path", async () => {
    const config = makeConfig({
      prompts: { overrides: { verifier: "deeply/nested/nonexistent/path/verifier.md" } },
    });
    const result = await loadOverride("verifier", tmpDir, config);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Returns file content when file exists
// ---------------------------------------------------------------------------

describe("loadOverride — file exists", () => {
  test("returns file content for test-writer", async () => {
    const content = "# Test Writer Override\nWrite tests first.";
    const relPath = writeOverrideFile(".nax/prompts/test-writer.md", content);
    const config = makeConfig({ prompts: { overrides: { "test-writer": relPath } } });

    const result = await loadOverride("test-writer", tmpDir, config);
    expect(result).toBe(content);
  });

  test("returns file content for implementer", async () => {
    const content = "# Implementer Override\nImplement the feature.";
    const relPath = writeOverrideFile(".nax/prompts/implementer.md", content);
    const config = makeConfig({ prompts: { overrides: { implementer: relPath } } });

    const result = await loadOverride("implementer", tmpDir, config);
    expect(result).toBe(content);
  });

  test("returns file content for verifier", async () => {
    const content = "# Verifier Override\nVerify correctness.";
    const relPath = writeOverrideFile(".nax/prompts/verifier.md", content);
    const config = makeConfig({ prompts: { overrides: { verifier: relPath } } });

    const result = await loadOverride("verifier", tmpDir, config);
    expect(result).toBe(content);
  });

  test("returns file content for single-session", async () => {
    const content = "# Single Session Override\nDo everything in one session.";
    const relPath = writeOverrideFile(".nax/prompts/single-session.md", content);
    const config = makeConfig({ prompts: { overrides: { "single-session": relPath } } });

    const result = await loadOverride("single-session", tmpDir, config);
    expect(result).toBe(content);
  });

  test("resolves path relative to workdir, not process.cwd()", async () => {
    const content = "RELATIVE_PATH_CONTENT";
    const relPath = writeOverrideFile("custom-override.md", content);
    const config = makeConfig({ prompts: { overrides: { implementer: relPath } } });

    // tmpDir is the workdir — file lives at join(tmpDir, relPath)
    const result = await loadOverride("implementer", tmpDir, config);
    expect(result).toBe(content);
  });

  test("reads multiline markdown correctly", async () => {
    const content = "# Title\n\n## Section\n\nSome content here.\n\n- item 1\n- item 2\n";
    const relPath = writeOverrideFile("multiline.md", content);
    const config = makeConfig({ prompts: { overrides: { verifier: relPath } } });

    const result = await loadOverride("verifier", tmpDir, config);
    expect(result).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// 5. Throws on unreadable file (permissions error)
// ---------------------------------------------------------------------------

describe("loadOverride — permission error", () => {
  // Requires file permission manipulation — skipped by default, run with FULL=1.
  const skipOnCI = fullTest;

  skipOnCI("throws a descriptive error when file is not readable", async () => {
    const content = "SECRET";
    const relPath = writeOverrideFile(".nax/prompts/locked.md", content);
    const absPath = join(tmpDir, relPath);

    // Remove read permission
    chmodSync(absPath, 0o000);

    const config = makeConfig({ prompts: { overrides: { "test-writer": relPath } } });

    expect(loadOverride("test-writer", tmpDir, config)).rejects.toThrow();
  });

  skipOnCI("error message mentions the role or path when unreadable", async () => {
    const content = "SECRET";
    const relPath = writeOverrideFile(".nax/prompts/locked2.md", content);
    const absPath = join(tmpDir, relPath);

    chmodSync(absPath, 0o000);

    const config = makeConfig({ prompts: { overrides: { implementer: relPath } } });

    let errorMessage = "";
    try {
      await loadOverride("implementer", tmpDir, config);
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    // Error should mention something meaningful (path or role)
    expect(errorMessage.length).toBeGreaterThan(0);
    const lowerMsg = errorMessage.toLowerCase();
    const mentionsSomethingUseful =
      lowerMsg.includes("locked2") ||
      lowerMsg.includes("implementer") ||
      lowerMsg.includes("unreadable") ||
      lowerMsg.includes("permission") ||
      lowerMsg.includes("cannot read") ||
      lowerMsg.includes("eacces");
    expect(mentionsSomethingUseful).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. NaxConfig accepts prompts field
// ---------------------------------------------------------------------------

describe("NaxConfig.prompts type shape", () => {
  test("config with prompts.overrides is accepted by makeConfig", () => {
    // If TypeScript compiles this without error, the type is correct
    const config = makeConfig({
      prompts: {
        overrides: {
          "test-writer": ".nax/prompts/tw.md",
          implementer: ".nax/prompts/impl.md",
        },
      },
    });
    expect(config.prompts?.overrides?.["test-writer"]).toBe(".nax/prompts/tw.md");
    expect(config.prompts?.overrides?.implementer).toBe(".nax/prompts/impl.md");
  });

  test("config without prompts block defaults to lite guardrails", () => {
    const config = makeConfig();
    expect(config.prompts).toEqual({ behavioralGuardrails: "lite" });
  });

  test("promptLoaderConfigSelector picks prompts, context, project", () => {
    const full = makeConfig();
    const sliced = promptLoaderConfigSelector.select(full);
    expect(Object.keys(sliced).sort()).toEqual(["context", "project", "prompts"]);
  });

  test("loadOverride accepts a Pick<NaxConfig, 'prompts'> literal (no NaxConfig cast)", async () => {
    const config = { prompts: { overrides: {}, behavioralGuardrails: "lite" as const } } satisfies Pick<NaxConfig, "prompts">;
    const result = await loadOverride("test-writer", "/tmp/nonexistent-loader-test", config);
    expect(result).toBeNull();
  });
});
