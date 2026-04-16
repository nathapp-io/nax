import { describe, test, expect } from "bun:test";
import { renderChunks } from "../../../../src/context/v2/render";
import type { PackedChunk } from "../../../../src/context/v2/packing";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makePacked(overrides: Partial<PackedChunk> = {}): PackedChunk {
  return {
    id: "chunk:1",
    kind: "feature",
    scope: "project",
    role: ["all"],
    content: "chunk content",
    tokens: 50,
    rawScore: 0.9,
    score: 0.9,
    roleFiltered: false,
    belowMinScore: false,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// renderChunks
// ─────────────────────────────────────────────────────────────────────────────

describe("renderChunks", () => {
  test("empty chunks: returns empty string", () => {
    expect(renderChunks([])).toBe("");
  });

  test("single project chunk: renders project section", () => {
    const chunk = makePacked({ scope: "project", content: "CLAUDE.md rules" });
    const md = renderChunks([chunk]);
    expect(md).toContain("## Project Context");
    expect(md).toContain("CLAUDE.md rules");
  });

  test("scope ordering: Project before Feature before Story before Session before Retrieved", () => {
    const chunks = [
      makePacked({ id: "r:1", scope: "retrieved", content: "retrieved chunk" }),
      makePacked({ id: "s:1", scope: "story", content: "story chunk" }),
      makePacked({ id: "p:1", scope: "project", content: "project chunk" }),
      makePacked({ id: "f:1", scope: "feature", content: "feature chunk" }),
      makePacked({ id: "se:1", scope: "session", content: "session chunk" }),
    ];
    const md = renderChunks(chunks);
    const pIdx = md.indexOf("## Project Context");
    const fIdx = md.indexOf("## Feature Context");
    const sIdx = md.indexOf("## Story Context");
    const seIdx = md.indexOf("## Session History");
    const rIdx = md.indexOf("## Retrieved Context");
    expect(pIdx).toBeLessThan(fIdx);
    expect(fIdx).toBeLessThan(sIdx);
    expect(sIdx).toBeLessThan(seIdx);
    expect(seIdx).toBeLessThan(rIdx);
  });

  test("empty scopes are omitted", () => {
    const chunk = makePacked({ scope: "feature", content: "feature only" });
    const md = renderChunks([chunk]);
    expect(md).not.toContain("## Project Context");
    expect(md).not.toContain("## Story Context");
    expect(md).toContain("## Feature Context");
  });

  test("multiple chunks in same scope: separated by divider", () => {
    const chunks = [
      makePacked({ id: "a:1", scope: "feature", content: "first chunk", score: 0.9 }),
      makePacked({ id: "b:1", scope: "feature", content: "second chunk", score: 0.7 }),
    ];
    const md = renderChunks(chunks);
    expect(md).toContain("first chunk");
    expect(md).toContain("second chunk");
    expect(md).toContain("---");
  });

  test("within scope: highest score rendered first", () => {
    const chunks = [
      makePacked({ id: "low:1", scope: "project", content: "low score chunk", score: 0.3 }),
      makePacked({ id: "high:1", scope: "project", content: "high score chunk", score: 0.9 }),
    ];
    const md = renderChunks(chunks);
    const highIdx = md.indexOf("high score chunk");
    const lowIdx = md.indexOf("low score chunk");
    expect(highIdx).toBeLessThan(lowIdx);
  });

  test("priorStageDigest: prepended before scope sections", () => {
    const chunk = makePacked({ scope: "feature", content: "feature content" });
    const digest = "Prior stage did X and Y.";
    const md = renderChunks([chunk], { priorStageDigest: digest });
    expect(md).toContain("## Prior Stage Summary");
    expect(md).toContain(digest);
    const summaryIdx = md.indexOf("## Prior Stage Summary");
    const featureIdx = md.indexOf("## Feature Context");
    expect(summaryIdx).toBeLessThan(featureIdx);
  });

  test("empty priorStageDigest: no preamble section", () => {
    const chunk = makePacked({ scope: "project", content: "rules" });
    const md = renderChunks([chunk], { priorStageDigest: "" });
    expect(md).not.toContain("## Prior Stage Summary");
  });

  test("content is trimmed before rendering", () => {
    const chunk = makePacked({ scope: "project", content: "  trimmed  \n\n" });
    const md = renderChunks([chunk]);
    expect(md).toContain("trimmed");
    expect(md).not.toMatch(/  trimmed  /);
  });
});
