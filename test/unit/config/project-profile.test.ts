/**
 * Unit tests for ProjectProfile — US-001
 *
 * Covers:
 * - AC-1: ProjectProfile interface shape (language union, all fields optional)
 * - AC-2: NaxConfig.project field typed as ProjectProfile | undefined
 * - AC-3: NaxConfigSchema accepts valid project config
 * - AC-4: NaxConfigSchema rejects unsupported language values (ZodError)
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { NaxConfigSchema } from "../../../src/config/schemas";
import type { NaxConfig, ProjectProfile } from "../../../src/config/schema";

// ── AC-1 helpers ──────────────────────────────────────────────────────────────

const SUPPORTED_LANGUAGES: ProjectProfile["language"][] = [
  "typescript",
  "javascript",
  "go",
  "rust",
  "python",
  "ruby",
  "java",
  "kotlin",
  "php",
];

// ── Shared fixture ────────────────────────────────────────────────────────────

/** Base config without project field — must be schema-valid */
function baseConfig(): object {
  // Use DEFAULT_CONFIG cast to plain object so we can add unknown fields
  return { ...DEFAULT_CONFIG } as unknown as object;
}

// ── AC-1: ProjectProfile shape ────────────────────────────────────────────────

describe("ProjectProfile interface", () => {
  test("all fields are optional — empty object is assignable", () => {
    const profile: ProjectProfile = {};
    expect(profile).toBeDefined();
  });

  test("language field accepts all supported language values", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const profile: ProjectProfile = { language: lang };
      expect(profile.language).toBe(lang);
    }
  });

  test("type field is optional string", () => {
    const profile: ProjectProfile = { type: "cli" };
    expect(profile.type).toBe("cli");
  });

  test("testFramework field is optional string", () => {
    const profile: ProjectProfile = { testFramework: "bun:test" };
    expect(profile.testFramework).toBe("bun:test");
  });

  test("lintTool field is optional string", () => {
    const profile: ProjectProfile = { lintTool: "biome" };
    expect(profile.lintTool).toBe("biome");
  });
});

// ── AC-2: NaxConfig.project field ────────────────────────────────────────────

describe("NaxConfig.project field", () => {
  test("project field is absent by default (undefined)", () => {
    const config: NaxConfig = DEFAULT_CONFIG;
    expect(config.project).toBeUndefined();
  });

  test("project field accepts a ProjectProfile value", () => {
    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      project: { language: "go", type: "cli" },
    };
    expect(config.project?.language).toBe("go");
    expect(config.project?.type).toBe("cli");
  });
});

// ── AC-3: NaxConfigSchema accepts valid project config ────────────────────────

describe("NaxConfigSchema — valid project config", () => {
  test("parse succeeds when project has valid language and type", () => {
    const input = {
      ...baseConfig(),
      project: { language: "go", type: "cli" },
    };

    let parsed: ReturnType<typeof NaxConfigSchema.parse> | undefined;
    expect(() => {
      parsed = NaxConfigSchema.parse(input);
    }).not.toThrow();

    // project must be preserved in the parsed output
    expect(parsed?.project?.language).toBe("go");
    expect(parsed?.project?.type).toBe("cli");
  });

  test("parse succeeds when project has only language", () => {
    const input = {
      ...baseConfig(),
      project: { language: "typescript" },
    };

    let parsed: ReturnType<typeof NaxConfigSchema.parse> | undefined;
    expect(() => {
      parsed = NaxConfigSchema.parse(input);
    }).not.toThrow();

    expect(parsed?.project?.language).toBe("typescript");
  });

  test("parse succeeds when project is absent", () => {
    const input = baseConfig();
    let parsed: ReturnType<typeof NaxConfigSchema.parse> | undefined;
    expect(() => {
      parsed = NaxConfigSchema.parse(input);
    }).not.toThrow();
    expect(parsed?.project).toBeUndefined();
  });

  test.each(SUPPORTED_LANGUAGES.filter((l): l is NonNullable<typeof l> => l !== undefined))(
    "parse succeeds for supported language '%s'",
    (lang) => {
      const input = { ...baseConfig(), project: { language: lang } };
      expect(() => NaxConfigSchema.parse(input)).not.toThrow();
    },
  );
});

// ── AC-4: NaxConfigSchema rejects unsupported language ───────────────────────

describe("NaxConfigSchema — invalid project config", () => {
  test("parse throws ZodError when language is 'cobol' (unsupported)", () => {
    const input = {
      ...baseConfig(),
      project: { language: "cobol" },
    };

    expect(() => NaxConfigSchema.parse(input)).toThrow();
  });

  test("parse throws ZodError when language is an empty string", () => {
    const input = {
      ...baseConfig(),
      project: { language: "" },
    };

    expect(() => NaxConfigSchema.parse(input)).toThrow();
  });

  test("parse throws ZodError when language is a number", () => {
    const input = {
      ...baseConfig(),
      project: { language: 42 },
    };

    expect(() => NaxConfigSchema.parse(input)).toThrow();
  });
});
