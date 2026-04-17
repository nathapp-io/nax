/**
 * StaticRulesProvider — unit tests
 *
 * Tests for both the canonical store path (Phase 5.1) and the legacy
 * CLAUDE.md fallback path. Filesystem calls are intercepted via
 * _staticRulesDeps injection. _staticRulesDeps.loadCanonicalRules is
 * mocked to return empty by default so all legacy-path tests are unaffected.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { NaxError } from "../../../../../src/errors";
import { StaticRulesProvider, _staticRulesDeps } from "../../../../../src/context/engine/providers/static-rules";
import { NeutralityLintError } from "../../../../../src/context/rules/canonical-loader";
import type { ContextRequest } from "../../../../../src/context/engine/types";
import type { CanonicalRule } from "../../../../../src/context/rules/canonical-loader";

// ─────────────────────────────────────────────────────────────────────────────
// Dep injection helpers
// ─────────────────────────────────────────────────────────────────────────────

let origReadFile: typeof _staticRulesDeps.readFile;
let origFileExists: typeof _staticRulesDeps.fileExists;
let origLoadCanonicalRules: typeof _staticRulesDeps.loadCanonicalRules;

beforeEach(() => {
  origReadFile = _staticRulesDeps.readFile;
  origFileExists = _staticRulesDeps.fileExists;
  origLoadCanonicalRules = _staticRulesDeps.loadCanonicalRules;
  // Default: no canonical rules (so legacy tests run the legacy path)
  _staticRulesDeps.loadCanonicalRules = async () => [];
  _staticRulesDeps.fileExists = async () => false;
  _staticRulesDeps.readFile = async () => "";
});

afterEach(() => {
  _staticRulesDeps.readFile = origReadFile;
  _staticRulesDeps.fileExists = origFileExists;
  _staticRulesDeps.loadCanonicalRules = origLoadCanonicalRules;
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const BASE_REQUEST: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 8000,
};

function setupLegacyFiles(files: Record<string, string | undefined>) {
  _staticRulesDeps.fileExists = async (path: string) => path in files && files[path] !== undefined;
  _staticRulesDeps.readFile = async (path: string) => {
    const content = files[path];
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return content;
  };
}

function setupCanonical(rules: CanonicalRule[]) {
  _staticRulesDeps.loadCanonicalRules = async () => rules;
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider identity", () => {
  test("id and kind are correct", () => {
    const provider = new StaticRulesProvider();
    expect(provider.id).toBe("static-rules");
    expect(provider.kind).toBe("static");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5.1: canonical store path
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — canonical store (Phase 5.1)", () => {
  test("returns one chunk per canonical rule file", async () => {
    setupCanonical([
      { fileName: "coding-style.md", content: "## Style\n\nUse immutable data." },
      { fileName: "testing.md", content: "## Testing\n\nWrite tests first." },
    ]);
    const provider = new StaticRulesProvider();
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks).toHaveLength(2);
  });

  test("canonical chunk has static kind, project scope, role all", async () => {
    setupCanonical([{ fileName: "style.md", content: "## Style\n\nContent." }]);
    const provider = new StaticRulesProvider();
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks[0]?.kind).toBe("static");
    expect(result.chunks[0]?.scope).toBe("project");
    expect(result.chunks[0]?.role).toContain("all");
    expect(result.chunks[0]?.rawScore).toBe(1.0);
  });

  test("canonical chunk content is prefixed with ### <fileName>", async () => {
    setupCanonical([{ fileName: "coding-style.md", content: "Use async/await." }]);
    const provider = new StaticRulesProvider();
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks[0]?.content).toMatch(/### coding-style\.md/);
    expect(result.chunks[0]?.content).toContain("Use async/await.");
  });

  test("canonical chunk ID is stable for same content", async () => {
    const rule = { fileName: "style.md", content: "## Style\n\nContent." };
    setupCanonical([rule]);
    const provider = new StaticRulesProvider();
    const r1 = await provider.fetch(BASE_REQUEST);
    const r2 = await provider.fetch(BASE_REQUEST);
    expect(r1.chunks[0]?.id).toBe(r2.chunks[0]?.id);
  });

  test("canonical path takes precedence over legacy files", async () => {
    setupCanonical([{ fileName: "canonical.md", content: "Canonical rules." }]);
    setupLegacyFiles({ "/project/CLAUDE.md": "Legacy rules." });
    const provider = new StaticRulesProvider();
    const result = await provider.fetch(BASE_REQUEST);
    // Only canonical chunk
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toContain("Canonical rules.");
    expect(result.chunks[0]?.content).not.toContain("Legacy rules.");
  });

  test("propagates NeutralityLintError without falling back to legacy", async () => {
    _staticRulesDeps.loadCanonicalRules = async () => {
      throw new NeutralityLintError([
        { file: "bad.md", lineNumber: 1, line: "CLAUDE.md", pattern: "agent-specific" },
      ]);
    };
    setupLegacyFiles({ "/project/CLAUDE.md": "Legacy rules." });
    const provider = new StaticRulesProvider();
    let threw: unknown;
    try {
      await provider.fetch(BASE_REQUEST);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(NaxError);
    expect((threw as NaxError).code).toBe("NEUTRALITY_LINT_FAILED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5.1: allowLegacyClaudeMd
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — allowLegacyClaudeMd", () => {
  test("returns empty when allowLegacyClaudeMd is false and no canonical rules", async () => {
    setupLegacyFiles({ "/project/CLAUDE.md": "Legacy rules." });
    const provider = new StaticRulesProvider({ allowLegacyClaudeMd: false });
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks).toHaveLength(0);
  });

  test("reads legacy files when allowLegacyClaudeMd is true and no canonical rules", async () => {
    setupLegacyFiles({ "/project/CLAUDE.md": "# Project Rules\n\nUse bun." });
    const provider = new StaticRulesProvider({ allowLegacyClaudeMd: true });
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toContain("Use bun.");
  });

  test("default allowLegacyClaudeMd is true (migration period)", async () => {
    setupLegacyFiles({ "/project/CLAUDE.md": "# Project Rules\n\nLegacy." });
    const provider = new StaticRulesProvider(); // no option — defaults to true
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Legacy path (Phase 0 behavior preserved)
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — legacy path", () => {
  let provider: StaticRulesProvider;

  beforeEach(() => {
    provider = new StaticRulesProvider({ allowLegacyClaudeMd: true });
  });

  test("returns empty when no candidate file exists", async () => {
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks).toHaveLength(0);
    expect(result.pullTools).toHaveLength(0);
  });

  test("reads CLAUDE.md when present", async () => {
    setupLegacyFiles({ "/project/CLAUDE.md": "# Project Rules\n\nUse bun, not node." });
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.kind).toBe("static");
    expect(result.chunks[0]?.scope).toBe("project");
    expect(result.chunks[0]?.role).toContain("all");
    expect(result.chunks[0]?.content).toContain("Use bun, not node.");
    expect(result.chunks[0]?.rawScore).toBe(1.0);
  });

  test("chunk ID is stable for same content", async () => {
    const content = "# Rules\n\nDo not mutate.";
    setupLegacyFiles({ "/project/CLAUDE.md": content });
    const r1 = await provider.fetch(BASE_REQUEST);
    const r2 = await provider.fetch(BASE_REQUEST);
    expect(r1.chunks[0]?.id).toBe(r2.chunks[0]?.id);
  });

  test("chunk ID changes when content changes", async () => {
    setupLegacyFiles({ "/project/CLAUDE.md": "version 1" });
    const r1 = await provider.fetch(BASE_REQUEST);
    setupLegacyFiles({ "/project/CLAUDE.md": "version 2" });
    const r2 = await provider.fetch(BASE_REQUEST);
    expect(r1.chunks[0]?.id).not.toBe(r2.chunks[0]?.id);
  });

  test("skips CLAUDE.md if empty, falls through to .cursorrules", async () => {
    setupLegacyFiles({
      "/project/CLAUDE.md": "   ",
      "/project/.cursorrules": "cursor rules here",
    });
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toContain("cursor rules here");
  });

  test("reads only the first candidate found (CLAUDE.md wins over .cursorrules)", async () => {
    setupLegacyFiles({
      "/project/CLAUDE.md": "claude rules",
      "/project/.cursorrules": "cursor rules",
    });
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toContain("claude rules");
  });

  test("soft failure: read error is logged and returns empty", async () => {
    _staticRulesDeps.fileExists = async () => true;
    _staticRulesDeps.readFile = async () => { throw new Error("permission denied"); };
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks).toHaveLength(0);
  });

  test("token estimate is proportional to content length", async () => {
    const content = "A".repeat(400); // 400 chars / 4 = 100 tokens
    setupLegacyFiles({ "/project/CLAUDE.md": content });
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks[0]?.tokens).toBeGreaterThanOrEqual(100);
  });
});
