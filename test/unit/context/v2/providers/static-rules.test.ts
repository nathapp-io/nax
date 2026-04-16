import { describe, test, expect, beforeEach } from "bun:test";
import { StaticRulesProvider, _staticRulesDeps } from "../../../../../src/context/v2/providers/static-rules";
import type { ContextRequest } from "../../../../../src/context/v2/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const BASE_REQUEST: ContextRequest = {
  storyId: "US-001",
  workdir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 8000,
};

function setupDeps(files: Record<string, string | undefined>) {
  _staticRulesDeps.fileExists = async (path: string) => path in files && files[path] !== undefined;
  _staticRulesDeps.readFile = async (path: string) => {
    const content = files[path];
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return content;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider", () => {
  let provider: StaticRulesProvider;

  beforeEach(() => {
    provider = new StaticRulesProvider();
  });

  test("id and kind are correct", () => {
    expect(provider.id).toBe("static-rules");
    expect(provider.kind).toBe("static");
  });

  test("returns empty when no candidate file exists", async () => {
    setupDeps({});
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks).toHaveLength(0);
    expect(result.pullTools).toHaveLength(0);
  });

  test("reads CLAUDE.md when present", async () => {
    setupDeps({ "/project/CLAUDE.md": "# Project Rules\n\nUse bun, not node." });
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].kind).toBe("static");
    expect(result.chunks[0].scope).toBe("project");
    expect(result.chunks[0].role).toContain("all");
    expect(result.chunks[0].content).toContain("Use bun, not node.");
    expect(result.chunks[0].rawScore).toBe(1.0);
  });

  test("chunk ID is stable for same content", async () => {
    const content = "# Rules\n\nDo not mutate.";
    setupDeps({ "/project/CLAUDE.md": content });
    const r1 = await provider.fetch(BASE_REQUEST);
    const r2 = await provider.fetch(BASE_REQUEST);
    expect(r1.chunks[0].id).toBe(r2.chunks[0].id);
  });

  test("chunk ID changes when content changes", async () => {
    setupDeps({ "/project/CLAUDE.md": "version 1" });
    const r1 = await provider.fetch(BASE_REQUEST);
    setupDeps({ "/project/CLAUDE.md": "version 2" });
    const r2 = await provider.fetch(BASE_REQUEST);
    expect(r1.chunks[0].id).not.toBe(r2.chunks[0].id);
  });

  test("skips CLAUDE.md if empty, falls through to next candidate", async () => {
    setupDeps({
      "/project/CLAUDE.md": "   ",                // empty after trim
      "/project/.cursorrules": "cursor rules here",
    });
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].content).toContain("cursor rules here");
  });

  test("reads only the first candidate found (CLAUDE.md wins over .cursorrules)", async () => {
    setupDeps({
      "/project/CLAUDE.md": "claude rules",
      "/project/.cursorrules": "cursor rules",
    });
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].content).toContain("claude rules");
  });

  test("soft failure: read error is logged and returns empty", async () => {
    _staticRulesDeps.fileExists = async () => true;
    _staticRulesDeps.readFile = async () => { throw new Error("permission denied"); };
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks).toHaveLength(0);
  });

  test("token estimate is proportional to content length", async () => {
    const content = "A".repeat(400); // 400 chars / 4 = 100 tokens
    setupDeps({ "/project/CLAUDE.md": content });
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks[0].tokens).toBeGreaterThanOrEqual(100);
  });
});
