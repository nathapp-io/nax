/**
 * agent-renderer.ts — unit tests
 *
 * Covers renderForAgent() for all three framing styles:
 *   markdown-sections (claude), xml-tagged (codex), plain (unknown/conservative).
 *
 * Tests verify: scope section rendering, priorStageDigest preamble,
 * multi-scope ordering, empty-chunk handling, and cross-scope isolation.
 */

import { describe, test, expect } from "bun:test";
import { renderForAgent } from "../../../../src/context/engine/agent-renderer";
import type { PackedChunk } from "../../../../src/context/engine/packing";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeChunk(scope: PackedChunk["scope"], overrides: Partial<PackedChunk> = {}): PackedChunk {
  return {
    id: `test:${scope}`,
    providerId: "test",
    kind: "static",
    scope,
    role: ["all"],
    content: `Content for ${scope}`,
    tokens: 10,
    rawScore: 0.8,
    score: 0.8,
    roleFiltered: false,
    belowMinScore: false,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// claude → markdown-sections
// ─────────────────────────────────────────────────────────────────────────────

describe("renderForAgent — claude (markdown-sections)", () => {
  test("wraps project scope in ## Project Context header", () => {
    const chunks = [makeChunk("project", { content: "Use strict mode." })];
    const result = renderForAgent(chunks, "claude");
    expect(result).toContain("## Project Context");
    expect(result).toContain("Use strict mode.");
  });

  test("wraps session scope in ## Session History header", () => {
    const chunks = [makeChunk("session", { content: "Prior scratch." })];
    const result = renderForAgent(chunks, "claude");
    expect(result).toContain("## Session History");
  });

  test("does not produce xml-tagged wrappers", () => {
    const chunks = [makeChunk("project")];
    const result = renderForAgent(chunks, "claude");
    expect(result).not.toContain("<context_section");
    expect(result).not.toContain("</context_section>");
  });

  test("includes priorStageDigest under ## Prior Stage Summary", () => {
    const result = renderForAgent([], "claude", { priorStageDigest: "Plan done." });
    expect(result).toContain("## Prior Stage Summary");
    expect(result).toContain("Plan done.");
  });

  test("empty chunks with no digest returns empty string", () => {
    const result = renderForAgent([], "claude");
    expect(result).toBe("");
  });

  test("scopes are ordered project before feature before session", () => {
    const chunks = [
      makeChunk("session", { content: "Session content.", id: "test:s" }),
      makeChunk("project", { content: "Project content.", id: "test:p" }),
      makeChunk("feature", { content: "Feature content.", id: "test:f" }),
    ];
    const result = renderForAgent(chunks, "claude");
    const projectPos = result.indexOf("Project content.");
    const featurePos = result.indexOf("Feature content.");
    const sessionPos = result.indexOf("Session content.");
    expect(projectPos).toBeLessThan(featurePos);
    expect(featurePos).toBeLessThan(sessionPos);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// codex → xml-tagged
// ─────────────────────────────────────────────────────────────────────────────

describe("renderForAgent — codex (xml-tagged)", () => {
  test("wraps project scope in <context_section type=\"project\">", () => {
    const chunks = [makeChunk("project", { content: "Use async/await." })];
    const result = renderForAgent(chunks, "codex");
    expect(result).toContain('<context_section type="project">');
    expect(result).toContain("</context_section>");
    expect(result).toContain("Use async/await.");
  });

  test("wraps session scope in <context_section type=\"session\">", () => {
    const chunks = [makeChunk("session")];
    const result = renderForAgent(chunks, "codex");
    expect(result).toContain('<context_section type="session">');
  });

  test("does not produce ## headers", () => {
    const chunks = [makeChunk("project")];
    const result = renderForAgent(chunks, "codex");
    expect(result).not.toContain("## Project Context");
  });

  test("includes priorStageDigest in prior_stage_summary tag", () => {
    const result = renderForAgent([], "codex", { priorStageDigest: "Tests passed." });
    expect(result).toContain('<context_section type="prior_stage_summary">');
    expect(result).toContain("Tests passed.");
    expect(result).toContain("</context_section>");
  });

  test("empty chunks with no digest returns empty string", () => {
    const result = renderForAgent([], "codex");
    expect(result).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// unknown agent → plain (conservative default)
// ─────────────────────────────────────────────────────────────────────────────

describe("renderForAgent — unknown agent (plain)", () => {
  test("wraps project scope with [Project Context] label", () => {
    const chunks = [makeChunk("project", { content: "Follow patterns." })];
    const result = renderForAgent(chunks, "unknown-agent-xyz");
    expect(result).toContain("[Project Context]");
    expect(result).toContain("Follow patterns.");
  });

  test("does not produce ## or <context_section> syntax", () => {
    const chunks = [makeChunk("project")];
    const result = renderForAgent(chunks, "unknown-agent-xyz");
    expect(result).not.toContain("## Project Context");
    expect(result).not.toContain("<context_section");
  });

  test("includes priorStageDigest under [Prior Stage Summary]", () => {
    const result = renderForAgent([], "unknown-agent-xyz", { priorStageDigest: "Done." });
    expect(result).toContain("[Prior Stage Summary]");
    expect(result).toContain("Done.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-chunk sorting within scope
// ─────────────────────────────────────────────────────────────────────────────

describe("renderForAgent — score-based chunk ordering", () => {
  test("higher-scored chunk appears before lower-scored chunk in same scope", () => {
    const chunks = [
      makeChunk("project", { content: "Low score content.", score: 0.3, rawScore: 0.3, id: "test:low" }),
      makeChunk("project", { content: "High score content.", score: 0.9, rawScore: 0.9, id: "test:high" }),
    ];
    const result = renderForAgent(chunks, "claude");
    expect(result.indexOf("High score content.")).toBeLessThan(result.indexOf("Low score content."));
  });
});
