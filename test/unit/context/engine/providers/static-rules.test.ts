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
let origGlobInDir: typeof _staticRulesDeps.globInDir;
let origLoadCanonicalRules: typeof _staticRulesDeps.loadCanonicalRules;

beforeEach(() => {
  origReadFile = _staticRulesDeps.readFile;
  origFileExists = _staticRulesDeps.fileExists;
  origGlobInDir = _staticRulesDeps.globInDir;
  origLoadCanonicalRules = _staticRulesDeps.loadCanonicalRules;
  // Default: no canonical rules (so legacy tests run the legacy path)
  _staticRulesDeps.loadCanonicalRules = async () => [];
  _staticRulesDeps.fileExists = async () => false;
  _staticRulesDeps.readFile = async () => "";
  _staticRulesDeps.globInDir = () => [];
});

afterEach(() => {
  _staticRulesDeps.readFile = origReadFile;
  _staticRulesDeps.fileExists = origFileExists;
  _staticRulesDeps.globInDir = origGlobInDir;
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
  const nestedRules = Object.keys(files).filter((path) => path.includes("/.claude/rules/") && path.endsWith(".md"));
  _staticRulesDeps.fileExists = async (path: string) => path in files && files[path] !== undefined;
  _staticRulesDeps.readFile = async (path: string) => {
    const content = files[path];
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return content;
  };
  _staticRulesDeps.globInDir = () => nestedRules;
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

  test("filters canonical rules by appliesTo when touchedFiles are present", async () => {
    setupCanonical([
      { fileName: "agents.md", content: "Agent-specific coding rules", appliesTo: ["src/agents/**"] },
      { fileName: "global.md", content: "Global rules" },
    ]);
    const provider = new StaticRulesProvider();
    const result = await provider.fetch({
      ...BASE_REQUEST,
      touchedFiles: ["src/review/runner.ts"],
    });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toContain("Global rules");
  });

  test("includes appliesTo-scoped rule when touchedFiles match", async () => {
    setupCanonical([
      { fileName: "agents.md", content: "Agent-specific coding rules", appliesTo: ["src/agents/**"] },
    ]);
    const provider = new StaticRulesProvider();
    const result = await provider.fetch({
      ...BASE_REQUEST,
      touchedFiles: ["src/agents/acp/adapter.ts"],
    });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toContain("Agent-specific coding rules");
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

  test("applies rules budget truncation tail-biased by priority", async () => {
    setupCanonical([
      { fileName: "a.md", id: "a", content: "A".repeat(800), tokens: 200, priority: 1 },
      { fileName: "b.md", id: "b", content: "B".repeat(800), tokens: 200, priority: 2 },
      { fileName: "c.md", id: "c", content: "C".repeat(800), tokens: 200, priority: 3 },
    ]);
    const provider = new StaticRulesProvider({ budgetTokens: 400 });
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[0]?.id).toContain("a");
    expect(result.chunks[1]?.id).toContain("b");
  });

  test("propagates NeutralityLintError without falling back to legacy", async () => {
    _staticRulesDeps.loadCanonicalRules = async () => {
      throw new NeutralityLintError([
        { file: "bad.md", lineNumber: 1, line: "CLAUDE.md", ruleId: "claude-reference", pattern: "agent-specific" },
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
    expect(threw).toBeInstanceOf(NeutralityLintError);
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
    setupLegacyFiles({
      "/project/CLAUDE.md": "# Project Rules\n\nUse bun.",
      "/project/.claude/rules/testing.md": "Always write tests.",
    });
    const provider = new StaticRulesProvider({ allowLegacyClaudeMd: true });
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks.map((c) => c.content).join("\n")).toContain("Use bun.");
    expect(result.chunks.map((c) => c.content).join("\n")).toContain("Always write tests.");
  });

  test("default allowLegacyClaudeMd is false — no legacy fallback without opt-in", async () => {
    setupLegacyFiles({ "/project/CLAUDE.md": "# Project Rules\n\nLegacy." });
    const provider = new StaticRulesProvider(); // no option — defaults to false
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks).toHaveLength(0);
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

  test("reads all legacy candidate files when present", async () => {
    setupLegacyFiles({
      "/project/CLAUDE.md": "claude rules",
      "/project/.cursorrules": "cursor rules",
      "/project/AGENTS.md": "agent rules",
    });
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks).toHaveLength(3);
    const all = result.chunks.map((c) => c.content).join("\n");
    expect(all).toContain("claude rules");
    expect(all).toContain("cursor rules");
    expect(all).toContain("agent rules");
  });

  test("loads .claude/rules/*.md in legacy mode", async () => {
    setupLegacyFiles({
      "/project/.claude/rules/testing.md": "testing rules",
      "/project/.claude/rules/typescript/style.md": "typescript style",
    });
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks).toHaveLength(2);
    const all = result.chunks.map((c) => c.content).join("\n");
    expect(all).toContain(".claude/rules/testing.md");
    expect(all).toContain(".claude/rules/typescript/style.md");
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

// ─────────────────────────────────────────────────────────────────────────────
// AC-57: per-package canonical rules overlay
// ─────────────────────────────────────────────────────────────────────────────

const MONOREPO_REQUEST: ContextRequest = {
  storyId: "US-002",
  repoRoot: "/repo",
  packageDir: "/repo/packages/api",
  stage: "execution",
  role: "implementer",
  budgetTokens: 8000,
};

describe("StaticRulesProvider — AC-57 per-package overlay", () => {
  test("non-monorepo: loadCanonicalRules called once with repoRoot", async () => {
    const calls: string[] = [];
    _staticRulesDeps.loadCanonicalRules = async (workdir: string) => {
      calls.push(workdir);
      return [{ fileName: "style.md", content: "Repo rules." }];
    };
    const provider = new StaticRulesProvider();
    await provider.fetch(BASE_REQUEST); // packageDir === repoRoot === "/project"
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("/project");
  });

  test("monorepo: package rules overlay repo rules — same filename: package wins", async () => {
    _staticRulesDeps.loadCanonicalRules = async (workdir: string) => {
      if (workdir === "/repo") return [{ fileName: "style.md", content: "Repo style." }];
      if (workdir === "/repo/packages/api") return [{ fileName: "style.md", content: "Package style." }];
      return [];
    };
    const provider = new StaticRulesProvider();
    const result = await provider.fetch(MONOREPO_REQUEST);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toContain("Package style.");
    expect(result.chunks[0]?.content).not.toContain("Repo style.");
  });

  test("monorepo: package-only file is added alongside repo rules", async () => {
    _staticRulesDeps.loadCanonicalRules = async (workdir: string) => {
      if (workdir === "/repo") return [{ fileName: "testing.md", content: "Repo testing." }];
      if (workdir === "/repo/packages/api") return [{ fileName: "api-conventions.md", content: "API conventions." }];
      return [];
    };
    const provider = new StaticRulesProvider();
    const result = await provider.fetch(MONOREPO_REQUEST);
    expect(result.chunks).toHaveLength(2);
    const fileNames = result.chunks.map((c) => c.content).join("\n");
    expect(fileNames).toContain("Repo testing.");
    expect(fileNames).toContain("API conventions.");
  });

  test("monorepo: repo-only file included when package has no override", async () => {
    _staticRulesDeps.loadCanonicalRules = async (workdir: string) => {
      if (workdir === "/repo") return [
        { fileName: "style.md", content: "Repo style." },
        { fileName: "security.md", content: "Repo security." },
      ];
      if (workdir === "/repo/packages/api") return [{ fileName: "style.md", content: "Package style." }];
      return [];
    };
    const provider = new StaticRulesProvider();
    const result = await provider.fetch(MONOREPO_REQUEST);
    expect(result.chunks).toHaveLength(2);
    const contents = result.chunks.map((c) => c.content).join("\n");
    expect(contents).toContain("Package style.");
    expect(contents).toContain("Repo security.");
    expect(contents).not.toContain("Repo style.");
  });

  test("monorepo: NeutralityLintError from repo-level rules propagates without fallback", async () => {
    _staticRulesDeps.loadCanonicalRules = async (workdir: string) => {
      if (workdir === "/repo") {
        throw new NeutralityLintError([
          { file: "bad.md", lineNumber: 1, line: "CLAUDE.md", ruleId: "claude-reference", pattern: "agent-specific" },
        ]);
      }
      return [];
    };
    setupLegacyFiles({ "/repo/CLAUDE.md": "Legacy." });
    const provider = new StaticRulesProvider();
    let threw: unknown;
    try {
      await provider.fetch(MONOREPO_REQUEST);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(NeutralityLintError);
    expect((threw as NaxError).code).toBe("NEUTRALITY_LINT_FAILED");
  });

  test("monorepo: NeutralityLintError from package-level rules propagates", async () => {
    _staticRulesDeps.loadCanonicalRules = async (workdir: string) => {
      if (workdir === "/repo") return [{ fileName: "style.md", content: "Repo style." }];
      if (workdir === "/repo/packages/api") {
        throw new NeutralityLintError([
          { file: "pkg.md", lineNumber: 2, line: "AGENTS.md", ruleId: "codex-reference", pattern: "agent-specific" },
        ]);
      }
      return [];
    };
    const provider = new StaticRulesProvider();
    let threw: unknown;
    try {
      await provider.fetch(MONOREPO_REQUEST);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(NeutralityLintError);
    expect((threw as NaxError).code).toBe("NEUTRALITY_LINT_FAILED");
  });

  test("monorepo: empty package rules falls through to repo rules only", async () => {
    _staticRulesDeps.loadCanonicalRules = async (workdir: string) => {
      if (workdir === "/repo") return [{ fileName: "style.md", content: "Repo style." }];
      return []; // package has no rules
    };
    const provider = new StaticRulesProvider();
    const result = await provider.fetch(MONOREPO_REQUEST);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toContain("Repo style.");
  });

  test("monorepo: loadCanonicalRules is called exactly twice (repo + package)", async () => {
    const calls: string[] = [];
    _staticRulesDeps.loadCanonicalRules = async (workdir: string) => {
      calls.push(workdir);
      if (workdir === "/repo") return [{ fileName: "style.md", content: "Repo style." }];
      return [{ fileName: "pkg.md", content: "Pkg style." }];
    };
    const provider = new StaticRulesProvider();
    await provider.fetch(MONOREPO_REQUEST);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe("/repo");
    expect(calls[1]).toBe("/repo/packages/api");
  });

  test("chunk IDs include fileName to prevent dedup collision for same-content rules", async () => {
    const sharedContent = "Identical content.";
    _staticRulesDeps.loadCanonicalRules = async (workdir: string) => {
      if (workdir === "/repo") return [{ fileName: "rule-a.md", content: sharedContent }];
      if (workdir === "/repo/packages/api") return [{ fileName: "rule-b.md", content: sharedContent }];
      return [];
    };
    const provider = new StaticRulesProvider();
    const result = await provider.fetch(MONOREPO_REQUEST);
    // Overlay: map has rule-a.md and rule-b.md — both kept since different filenames
    expect(result.chunks).toHaveLength(2);
    const ids = result.chunks.map((c) => c.id);
    expect(ids.some((id) => id.includes("rule-a"))).toBe(true);
    expect(ids.some((id) => id.includes("rule-b"))).toBe(true);
    // IDs must be distinct even though content hashes are identical
    expect(ids[0]).not.toBe(ids[1]);
  });
});
