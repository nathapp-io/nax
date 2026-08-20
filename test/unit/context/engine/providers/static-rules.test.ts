/**
 * StaticRulesProvider — unit tests
 *
 * Tests for both the canonical store path (Phase 5.1) and the legacy
 * CLAUDE.md fallback path. Filesystem calls are intercepted via
 * _staticRulesDeps injection. _staticRulesDeps.loadCanonicalRules is
 * mocked to return empty by default so all legacy-path tests are unaffected.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StaticRulesProvider, _staticRulesDeps } from "@/context/engine/providers/static-rules";
import type { ContextRequest } from "@/context/engine/types";
import { NeutralityLintError } from "@/context/rules/canonical-loader";
import type { CanonicalRule } from "@/context/rules/canonical-loader";
import type { NaxError } from "@/errors";

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

  test("canonical chunk has static kind, project scope, role all, score 1.0, and ### fileName prefix", async () => {
    setupCanonical([{ fileName: "coding-style.md", content: "Use async/await." }]);
    const provider = new StaticRulesProvider();
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks[0]?.kind).toBe("static");
    expect(result.chunks[0]?.scope).toBe("project");
    expect(result.chunks[0]?.role).toContain("all");
    expect(result.chunks[0]?.rawScore).toBe(1.0);
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

  test("appliesTo: filters out non-matching scopeFiles; includes scoped rule when scopeFiles match", async () => {
    // Non-matching: only global rule included
    setupCanonical([
      { fileName: "agents.md", content: "Agent-specific coding rules", appliesTo: ["src/agents/**"] },
      { fileName: "global.md", content: "Global rules" },
    ]);
    const provider = new StaticRulesProvider();
    const r1 = await provider.fetch({ ...BASE_REQUEST, scopeFiles: ["src/review/runner.ts"] });
    expect(r1.chunks).toHaveLength(1);
    expect(r1.chunks[0]?.content).toContain("Global rules");

    // Matching: scoped rule included
    setupCanonical([{ fileName: "agents.md", content: "Agent-specific coding rules", appliesTo: ["src/agents/**"] }]);
    const r2 = await provider.fetch({ ...BASE_REQUEST, scopeFiles: ["src/agents/acp/adapter.ts"] });
    expect(r2.chunks).toHaveLength(1);
    expect(r2.chunks[0]?.content).toContain("Agent-specific coding rules");
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
    const provider = new StaticRulesProvider({ budgetTokens: 400, enforceBudget: true });
    const result = await provider.fetch(BASE_REQUEST);
    // 2 retained rule chunks + 1 standalone budget-drop notice chunk (#1610).
    expect(result.chunks).toHaveLength(3);
    expect(result.chunks[0]?.id).toContain("a");
    expect(result.chunks[1]?.id).toContain("b");
    expect(result.chunks[2]?.id).toContain("__budget-notice__");
  });

  test("[US-002 AC 5] emits chunks only for the surviving leading run and none for the dropped tail when budget is smaller than the store", async () => {
    // Case 1: the first rule alone exceeds the budget — section-level fail-open keeps
    // the first section whole even when it exceeds the budget, so one chunk is emitted.
    setupCanonical([
      { fileName: "huge.md", id: "huge", content: "H".repeat(4000), tokens: 1000, priority: 1 },
      { fileName: "tiny.md", id: "tiny", content: "T".repeat(40), tokens: 10, priority: 2 },
      { fileName: "tiny2.md", id: "tiny2", content: "T2".repeat(40), tokens: 10, priority: 3 },
    ]);
    const provider = new StaticRulesProvider({ budgetTokens: 500, enforceBudget: true });
    const r1 = await provider.fetch(BASE_REQUEST);
    // 1 retained rule chunk (fail-open) + 1 notice chunk for the dropped tiny/tiny2 tail.
    expect(r1.chunks).toHaveLength(2);
    expect(r1.chunks[0]?.id).toContain("huge");

    // Case 2: a non-empty leading run survives, the dropped tail is excluded
    setupCanonical([
      { fileName: "a.md", id: "a", content: "A".repeat(40), tokens: 10, priority: 1 },
      { fileName: "b.md", id: "b", content: "B".repeat(40), tokens: 10, priority: 2 },
      { fileName: "c.md", id: "c", content: "C".repeat(400), tokens: 100, priority: 3 },
      { fileName: "d.md", id: "d", content: "D".repeat(40), tokens: 10, priority: 4 },
    ]);
    const provider2 = new StaticRulesProvider({ budgetTokens: 30, enforceBudget: true });
    const r2 = await provider2.fetch(BASE_REQUEST);
    // Extract the rule-id segment from each chunk id (format: static-rules:<ruleId>:<hash>).
    // The trailing "__budget-notice__" chunk reports the dropped c/d tail (#1610).
    const ruleIds = r2.chunks.map((c) => c.id.split(":")[1]);
    expect(ruleIds).toEqual(["a", "b", "__budget-notice__"]);
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
  test.each([
    ["false", new StaticRulesProvider({ allowLegacyClaudeMd: false })],
    ["unset (default)", new StaticRulesProvider()],
  ])("returns empty when allowLegacyClaudeMd is %s and no canonical rules", async (_label, provider) => {
    setupLegacyFiles({ "/project/CLAUDE.md": "Legacy rules." });
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
});

// ─────────────────────────────────────────────────────────────────────────────
// Legacy path (Phase 0 behavior preserved)
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — legacy path", () => {
  let provider: StaticRulesProvider;

  beforeEach(() => {
    provider = new StaticRulesProvider({ allowLegacyClaudeMd: true });
  });

  test("returns empty when no candidate exists; reads CLAUDE.md with correct chunk properties when present", async () => {
    const r1 = await provider.fetch(BASE_REQUEST);
    expect(r1.chunks).toHaveLength(0);
    expect(r1.pullTools).toHaveLength(0);

    setupLegacyFiles({ "/project/CLAUDE.md": "# Project Rules\n\nUse bun, not node." });
    const r2 = await provider.fetch(BASE_REQUEST);
    expect(r2.chunks).toHaveLength(1);
    expect(r2.chunks[0]?.kind).toBe("static");
    expect(r2.chunks[0]?.scope).toBe("project");
    expect(r2.chunks[0]?.role).toContain("all");
    expect(r2.chunks[0]?.content).toContain("Use bun, not node.");
    expect(r2.chunks[0]?.rawScore).toBe(1.0);
  });

  test("chunk ID is stable for same content and changes when content changes", async () => {
    const content = "# Rules\n\nDo not mutate.";
    setupLegacyFiles({ "/project/CLAUDE.md": content });
    const r1 = await provider.fetch(BASE_REQUEST);
    const r2 = await provider.fetch(BASE_REQUEST);
    expect(r1.chunks[0]?.id).toBe(r2.chunks[0]?.id);
    setupLegacyFiles({ "/project/CLAUDE.md": "version 2" });
    const r3 = await provider.fetch(BASE_REQUEST);
    expect(r1.chunks[0]?.id).not.toBe(r3.chunks[0]?.id);
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

  test("reads all legacy candidate files; loads .claude/rules/*.md in legacy mode", async () => {
    setupLegacyFiles({
      "/project/CLAUDE.md": "claude rules",
      "/project/.cursorrules": "cursor rules",
      "/project/AGENTS.md": "agent rules",
    });
    const r1 = await provider.fetch(BASE_REQUEST);
    expect(r1.chunks).toHaveLength(3);
    const all1 = r1.chunks.map((c) => c.content).join("\n");
    expect(all1).toContain("claude rules");
    expect(all1).toContain("cursor rules");
    expect(all1).toContain("agent rules");

    setupLegacyFiles({
      "/project/.claude/rules/testing.md": "testing rules",
      "/project/.claude/rules/typescript/style.md": "typescript style",
    });
    const r2 = await provider.fetch(BASE_REQUEST);
    expect(r2.chunks).toHaveLength(2);
    const all2 = r2.chunks.map((c) => c.content).join("\n");
    expect(all2).toContain(".claude/rules/testing.md");
    expect(all2).toContain(".claude/rules/typescript/style.md");
  });

  test("soft failure: read error is logged and returns empty", async () => {
    _staticRulesDeps.fileExists = async () => true;
    _staticRulesDeps.readFile = async () => {
      throw new Error("permission denied");
    };
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
      if (workdir === "/repo")
        return [
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

  test.each([
    [
      "repo-level",
      (workdir: string) => {
        if (workdir === "/repo")
          throw new NeutralityLintError([
            { file: "bad.md", lineNumber: 1, line: "CLAUDE.md", ruleId: "claude-reference", pattern: "agent-specific" },
          ]);
        return [];
      },
    ],
    [
      "package-level",
      (workdir: string) => {
        if (workdir === "/repo") return [{ fileName: "style.md", content: "Repo style." }];
        if (workdir === "/repo/packages/api")
          throw new NeutralityLintError([
            { file: "pkg.md", lineNumber: 2, line: "AGENTS.md", ruleId: "codex-reference", pattern: "agent-specific" },
          ]);
        return [];
      },
    ],
  ] as const)("monorepo: NeutralityLintError from %s rules propagates", async (_level, loadFn) => {
    _staticRulesDeps.loadCanonicalRules = async (workdir: string) => loadFn(workdir) as CanonicalRule[];
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

  test("monorepo: empty package falls through to repo only; loadCanonicalRules called exactly twice", async () => {
    // Empty package falls through to repo rules
    _staticRulesDeps.loadCanonicalRules = async (workdir: string) => {
      if (workdir === "/repo") return [{ fileName: "style.md", content: "Repo style." }];
      return [];
    };
    const provider = new StaticRulesProvider();
    const r1 = await provider.fetch(MONOREPO_REQUEST);
    expect(r1.chunks).toHaveLength(1);
    expect(r1.chunks[0]?.content).toContain("Repo style.");

    // Called exactly twice with correct paths
    const calls: string[] = [];
    _staticRulesDeps.loadCanonicalRules = async (workdir: string) => {
      calls.push(workdir);
      if (workdir === "/repo") return [{ fileName: "style.md", content: "Repo style." }];
      return [{ fileName: "pkg.md", content: "Pkg style." }];
    };
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

// ─────────────────────────────────────────────────────────────────────────────
// US-004 AC 6-8: real .nax/rules store scope filtering by scopeFiles
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — real .nax/rules store scope filtering (US-004)", () => {
  // A large explicit budget isolates the scoping behavior under test from
  // priority-ordered budget trimming, which is a separate, out-of-scope concern.
  const REAL_REPO_REQUEST: ContextRequest = {
    storyId: "US-004",
    repoRoot: process.cwd(),
    packageDir: process.cwd(),
    stage: "execution",
    role: "implementer",
    budgetTokens: 8000,
  };

  beforeEach(() => {
    _staticRulesDeps.loadCanonicalRules = origLoadCanonicalRules;
  });

  test("[US-004 AC 6] emits no static-rules:test-writing: chunk when scopeFiles are non-test source files", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({
      ...REAL_REPO_REQUEST,
      scopeFiles: ["src/context/rules/canonical-loader.ts"],
    });
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:test-writing:"))).toBe(false);
  });

  test("[US-004 AC 7] emits a static-rules:test-writing: chunk when scopeFiles include a path under test/", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({
      ...REAL_REPO_REQUEST,
      scopeFiles: ["test/unit/context/rules/canonical-loader.test.ts"],
    });
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:test-writing:"))).toBe(true);
  });

  // US-004 AC 8, corrected. The shipped version asserted adapter-wiring does NOT
  // load for `src/pipeline/stages/verify.ts` — but src/pipeline is one of the 13
  // directories the rule declares. The original spec transcribed only the first
  // two globs (a truncated read of the source), the restore matched the spec, and
  // this test then codified the narrowed scope as intended behaviour.
  test("[US-004 AC 8] emits no static-rules:adapter-wiring: chunk for a path outside every declared glob", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({ ...REAL_REPO_REQUEST, scopeFiles: ["src/config/loader.ts"] });
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:adapter-wiring:"))).toBe(false);
  });

  test("[US-004 AC 8] emits a static-rules:adapter-wiring: chunk for src/pipeline, which the rule declares", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({ ...REAL_REPO_REQUEST, scopeFiles: ["src/pipeline/stages/verify.ts"] });
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:adapter-wiring:"))).toBe(true);
  });

  test("emits a static-rules:retry-strategy: chunk for src/operations, which the rule declares", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({ ...REAL_REPO_REQUEST, scopeFiles: ["src/operations/call.ts"] });
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:retry-strategy:"))).toBe(true);
  });

  test("emits a static-rules:test-helpers: chunk for a test file, which the rule declares", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({
      ...REAL_REPO_REQUEST,
      scopeFiles: ["test/unit/context/engine/packing.test.ts"],
    });
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:test-helpers:"))).toBe(true);
  });

  // The positive cases above pass whether the rule is correctly scoped OR has no
  // scope at all — ruleMatchesScopeFiles early-returns true for an unscoped
  // rule, so it loads everywhere. These negatives are what actually pin scope,
  // and they fail on the exact regression this change repairs.
  test("emits no static-rules:retry-strategy: chunk for a path outside its declared globs", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({ ...REAL_REPO_REQUEST, scopeFiles: ["src/config/loader.ts"] });
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:retry-strategy:"))).toBe(false);
  });

  test("emits no static-rules:test-helpers: chunk for a non-test source path", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({ ...REAL_REPO_REQUEST, scopeFiles: ["src/agents/manager.ts"] });
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:test-helpers:"))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scoping-drift guard.
//
// `.nax/rules/` (nax engine) and `.claude/rules/` (Claude Code, natively) must
// declare the same file globs for the same rule, or a rule silently reaches one
// consumer and not the other. This exact drift shipped once: adapter-wiring lost
// 11 of 13 globs and retry-strategy / test-helpers lost theirs entirely, because
// the spec transcribed a truncated read of the source. Nothing detected it.
//
// nax spells the file glob `appliesTo:`; Claude spells it `paths:`. nax's own
// `paths:` means PACKAGE scope and has no Claude equivalent, so it is ignored here.
// ─────────────────────────────────────────────────────────────────────────────

describe("rule scoping parity — .nax/rules vs .claude/rules", () => {
  // Parse with the SAME engine the loader uses (canonical-loader.ts uses
  // Bun.YAML.parse). A hand-rolled regex is weaker than the parser it guards:
  // unquoted / single-quoted / flow-style / CRLF frontmatter all read as [] on
  // both sides, so the guard would pass green while the stores fully disagree.
  function fileGlobs(text: string, key: string): string[] {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
    if (!fm?.[1]) return [];
    let doc: unknown;
    try {
      doc = Bun.YAML.parse(fm[1]);
    } catch {
      return [];
    }
    const value = (doc as Record<string, unknown> | null)?.[key];
    const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
    return list
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .sort();
  }

  test("every rule present in both stores declares the same file globs", async () => {
    const mismatches: string[] = [];
    let compared = 0;
    let scopedPairs = 0;
    for (const name of [...new Bun.Glob("*.md").scanSync({ cwd: ".nax/rules", absolute: false })].sort()) {
      const claudePath = `.claude/rules/${name}`;
      if (!(await Bun.file(claudePath).exists())) continue;
      compared++;
      const nax = fileGlobs(await Bun.file(`.nax/rules/${name}`).text(), "appliesTo");
      const claude = fileGlobs(await Bun.file(claudePath).text(), "paths");
      if (nax.length > 0 || claude.length > 0) scopedPairs++;
      if (JSON.stringify(nax) !== JSON.stringify(claude)) {
        mismatches.push(`${name}: .nax/rules appliesTo=[${nax}] vs .claude/rules paths=[${claude}]`);
      }
    }
    expect(mismatches).toEqual([]);
    // Without these the guard passes vacuously if .claude/rules/ is ever removed
    // or renamed — the loop would compare nothing and stay green forever.
    expect(compared).toBeGreaterThan(0);
    expect(scopedPairs).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003: provider budget pressure — surface canonical-rule budget pressure
// via ContextProviderResult.budgetPressure.
//
// The pressure object is ProviderBudgetPressure (declared in manifest-types.ts):
//   { overageTokens, droppedCount, droppedTokens, droppedIds }
// Pressure is emitted in soft mode (overage only, no drops) and in enforced
// mode (full drops + ids). It is OMITTED when the canonical-rule total fits
// inside budgetTokens. NeutralityLintError still propagates unchanged.
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — US-003 budget pressure (soft, enforceBudget=false)", () => {
  test("[US-003 AC 1] returns one chunk per canonical rule, including rules beyond the budget", async () => {
    setupCanonical([
      { fileName: "a.md", id: "a", content: "A".repeat(40), tokens: 200, priority: 1 },
      { fileName: "b.md", id: "b", content: "B".repeat(40), tokens: 200, priority: 2 },
      { fileName: "c.md", id: "c", content: "C".repeat(40), tokens: 200, priority: 3 },
    ]);
    const provider = new StaticRulesProvider({ budgetTokens: 400 });
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks).toHaveLength(3);
  });

  test("[US-003 AC 2] budgetPressure.overageTokens equals store total minus budgetTokens", async () => {
    // Section-level tokens inherit rule.tokens proportionally (each rule with no
    // H2 splits into a single section, so section.tokens === rule.tokens).
    // Three rules of tokens 10 → three sections of 10 tokens → 30 total.
    // Budget 20 → overage 10, and one section is reported as dropped.
    setupCanonical([
      { fileName: "a.md", id: "a", content: "A".repeat(40), tokens: 10, priority: 1 },
      { fileName: "b.md", id: "b", content: "B".repeat(40), tokens: 10, priority: 2 },
      { fileName: "c.md", id: "c", content: "C".repeat(40), tokens: 10, priority: 3 },
    ]);
    const provider = new StaticRulesProvider({ budgetTokens: 20 });
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.budgetPressure).toBeDefined();
    expect(result.budgetPressure?.overageTokens).toBe(10); // 30 total − 20 budget
    // Soft mode — all sections still emitted as chunks
    expect(result.chunks).toHaveLength(3);
  });

  test("[US-003 AC 3] budgetPressure.droppedCount reflects section-level potential drops in soft mode", async () => {
    // Sections inherit rule.tokens proportionally. With 3 rules of 10, 10, 20
    // and budget 20: section a(10) and b(10) fit (10 + 10 = 20 ≤ 20), section
    // c(20) overflows → dropped. droppedCount=1, soft mode keeps all 3 chunks.
    setupCanonical([
      { fileName: "a.md", id: "a", content: "A".repeat(40), tokens: 10, priority: 1 },
      { fileName: "b.md", id: "b", content: "B".repeat(40), tokens: 10, priority: 2 },
      { fileName: "c.md", id: "c", content: "C".repeat(40), tokens: 20, priority: 3 },
    ]);
    const provider = new StaticRulesProvider({ budgetTokens: 20 });
    const result = await provider.fetch(BASE_REQUEST);
    // Soft mode: applySectionBudget reports 1 potential drop, but all 3 chunks are emitted
    expect(result.budgetPressure?.droppedCount).toBe(1);
    expect(result.chunks).toHaveLength(3);
  });
});

describe("StaticRulesProvider — US-003 budget pressure (enforced, enforceBudget=true)", () => {
  test("[US-003 AC 4] budgetPressure.droppedCount equals the number of rules omitted from chunks", async () => {
    setupCanonical([
      { fileName: "a.md", id: "a", content: "A".repeat(40), tokens: 10, priority: 1 },
      { fileName: "b.md", id: "b", content: "B".repeat(40), tokens: 10, priority: 2 },
      { fileName: "c.md", id: "c", content: "C".repeat(400), tokens: 100, priority: 3 },
      { fileName: "d.md", id: "d", content: "D".repeat(40), tokens: 10, priority: 4 },
    ]);
    const provider = new StaticRulesProvider({ budgetTokens: 30, enforceBudget: true });
    const result = await provider.fetch(BASE_REQUEST);
    // Leading run that fits inside 30: a(10) + b(10) → kept. c would push past → drop.
    // Dropped tail: c, d. Plus 1 standalone notice chunk reporting the drop (#1610).
    expect(result.budgetPressure?.droppedCount).toBe(2);
    expect(result.chunks).toHaveLength(3);
  });

  test("[US-003 AC 5] budgetPressure.droppedTokens equals the token total of rules omitted from chunks", async () => {
    setupCanonical([
      { fileName: "a.md", id: "a", content: "A".repeat(40), tokens: 10, priority: 1 },
      { fileName: "b.md", id: "b", content: "B".repeat(40), tokens: 10, priority: 2 },
      { fileName: "c.md", id: "c", content: "C".repeat(400), tokens: 100, priority: 3 },
      { fileName: "d.md", id: "d", content: "D".repeat(40), tokens: 10, priority: 4 },
    ]);
    const provider = new StaticRulesProvider({ budgetTokens: 30, enforceBudget: true });
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.budgetPressure?.droppedTokens).toBe(110); // c(100) + d(10)
  });

  test("[US-003 AC 6] budgetPressure.droppedIds contains the canonical rule id of every omitted rule", async () => {
    setupCanonical([
      { fileName: "a.md", id: "a", content: "A".repeat(40), tokens: 10, priority: 1 },
      { fileName: "b.md", id: "b", content: "B".repeat(40), tokens: 10, priority: 2 },
      { fileName: "c.md", id: "c", content: "C".repeat(400), tokens: 100, priority: 3 },
      { fileName: "d.md", id: "d", content: "D".repeat(40), tokens: 10, priority: 4 },
    ]);
    const provider = new StaticRulesProvider({ budgetTokens: 30, enforceBudget: true });
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.budgetPressure?.droppedIds).toEqual(["c#c", "d#d"]);
  });
});

describe("StaticRulesProvider — US-003 budget pressure (within budget)", () => {
  test("[US-003 AC 7] omits budgetPressure when canonical-rule total is within budgetTokens", async () => {
    setupCanonical([
      { fileName: "a.md", id: "a", content: "A".repeat(40), tokens: 50, priority: 1 },
      { fileName: "b.md", id: "b", content: "B".repeat(40), tokens: 50, priority: 2 },
    ]);
    const provider = new StaticRulesProvider({ budgetTokens: 1000 });
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.budgetPressure).toBeUndefined();
    expect(result.chunks).toHaveLength(2);
  });
});

describe("StaticRulesProvider — US-003 NeutralityLintError propagation", () => {
  test("[US-003 AC 8] throws NeutralityLintError instead of returning an empty chunk list", async () => {
    _staticRulesDeps.loadCanonicalRules = async () => {
      throw new NeutralityLintError([
        { file: "bad.md", lineNumber: 1, line: "CLAUDE.md", ruleId: "claude-reference", pattern: "agent-specific" },
      ]);
    };
    const provider = new StaticRulesProvider();
    let threw: unknown;
    try {
      await provider.fetch(BASE_REQUEST);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(NeutralityLintError);
    expect((threw as NaxError).code).toBe("NEUTRALITY_LINT_FAILED");
    expect((threw as NaxError).context?.stage).toBe("canonical-loader");
  });
});

describe("StaticRulesProvider — US-003 real .nax/rules store under default configuration", () => {
  // Use a real temp directory so the canonical loader's file/glob path runs end-to-end
  // (not just the mocked one). The default budget is 8192.
  const REAL_REPO_REQUEST: ContextRequest = {
    storyId: "US-003",
    repoRoot: process.cwd(),
    packageDir: process.cwd(),
    stage: "execution",
    role: "implementer",
    budgetTokens: 8000,
  };

  test("[US-003 AC 9] returns one chunk per rule section (not per rule file) under default configuration", async () => {
    _staticRulesDeps.loadCanonicalRules = origLoadCanonicalRules;
    const provider = new StaticRulesProvider({ budgetTokens: 100_000_000 });
    const result = await provider.fetch({ ...REAL_REPO_REQUEST, budgetTokens: 100_000_000 });
    const ruleCount = [...new Bun.Glob("*.md").scanSync({ cwd: ".nax/rules", absolute: false })].length;
    expect(ruleCount).toBeGreaterThan(0);
    // Section-level chunking: one chunk per section, which is ≥ rule count
    expect(result.chunks.length).toBeGreaterThanOrEqual(ruleCount);
    // scopingReport.sectionCount should match chunks (within budget, all sections emitted)
    expect(result.scopingReport?.sectionCount).toBe(result.chunks.length);
  });

  test("[US-003 AC 10] no sections dropped under generous budget", async () => {
    _staticRulesDeps.loadCanonicalRules = origLoadCanonicalRules;
    const provider = new StaticRulesProvider({ budgetTokens: 100_000_000 });
    const result = await provider.fetch({ ...REAL_REPO_REQUEST, budgetTokens: 100_000_000 });
    expect(result.budgetPressure?.droppedCount ?? 0).toBe(0);
  });
});

describe("StaticRulesProvider — US-003 empty canonical store with allowLegacyClaudeMd=false", () => {
  test("[US-003 AC 11] returns an empty chunk list and does not use legacy rule files", async () => {
    setupCanonical([]);
    setupLegacyFiles({
      "/project/CLAUDE.md": "Legacy rules.",
      "/project/.claude/rules/testing.md": "Legacy testing.",
    });
    const provider = new StaticRulesProvider({ allowLegacyClaudeMd: false });
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks).toHaveLength(0);
    expect(result.budgetPressure).toBeUndefined();
  });
});
