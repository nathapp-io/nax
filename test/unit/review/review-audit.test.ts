import { describe, expect, test, beforeEach } from "bun:test";
import { writeReviewAudit, _reviewAuditDeps } from "../../../src/review/review-audit";
import type { ReviewAuditEntry } from "../../../src/review/review-audit";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<ReviewAuditEntry> = {}): ReviewAuditEntry {
  return {
    reviewer: "adversarial",
    sessionName: "nax-abc12345-my-feature-us-001-reviewer-adversarial",
    workdir: "/tmp/workdir",
    storyId: "US-001",
    featureName: "my-feature",
    parsed: true,
    result: { passed: false, findings: [{ severity: "error", file: "src/foo.ts", line: 1 }] },
    ...overrides,
  };
}

function makeDeps() {
  const written: Array<{ path: string; content: string }> = [];
  const mkdirCalls: string[] = [];

  const deps = {
    mkdir: async (path: string) => {
      mkdirCalls.push(path);
    },
    writeFile: async (path: string, content: string) => {
      written.push({ path, content });
    },
    now: () => 1700000000000,
    findNaxProjectRoot: async (dir: string) => dir,
  };

  return { deps, written, mkdirCalls };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("writeReviewAudit", () => {
  let saved: typeof _reviewAuditDeps;

  beforeEach(() => {
    saved = { ..._reviewAuditDeps };
  });

  test("writes to .nax/review-audit/<featureName>/ under project root", async () => {
    const { deps, mkdirCalls, written } = makeDeps();
    Object.assign(_reviewAuditDeps, deps);

    await writeReviewAudit(makeEntry());
    Object.assign(_reviewAuditDeps, saved);

    expect(mkdirCalls[0]).toContain(".nax/review-audit/my-feature");
    expect(written[0].path).toContain(".nax/review-audit/my-feature");
  });

  test("filename is <epochMs>-<sessionName>.json", async () => {
    const { deps, written } = makeDeps();
    Object.assign(_reviewAuditDeps, deps);

    await writeReviewAudit(makeEntry());
    Object.assign(_reviewAuditDeps, saved);

    const parts = written[0].path.split("/");
    const filename = parts[parts.length - 1];
    expect(filename).toBe("1700000000000-nax-abc12345-my-feature-us-001-reviewer-adversarial.json");
  });

  test("successful parse — content includes parsed:true and result", async () => {
    const { deps, written } = makeDeps();
    Object.assign(_reviewAuditDeps, deps);

    await writeReviewAudit(makeEntry({ parsed: true, result: { passed: false, findings: [{ file: "src/foo.ts" }] } }));
    Object.assign(_reviewAuditDeps, saved);

    const content = JSON.parse(written[0].content);
    expect(content.parsed).toBe(true);
    expect(content.result.passed).toBe(false);
    expect(content.result.findings).toHaveLength(1);
    expect(content).not.toHaveProperty("looksLikeFail");
  });

  test("parse failure — content includes parsed:false and looksLikeFail", async () => {
    const { deps, written } = makeDeps();
    Object.assign(_reviewAuditDeps, deps);

    await writeReviewAudit(makeEntry({ parsed: false, looksLikeFail: true, result: null }));
    Object.assign(_reviewAuditDeps, saved);

    const content = JSON.parse(written[0].content);
    expect(content.parsed).toBe(false);
    expect(content.looksLikeFail).toBe(true);
    expect(content.result).toBeNull();
  });

  test("parse failure with looksLikeFail:false", async () => {
    const { deps, written } = makeDeps();
    Object.assign(_reviewAuditDeps, deps);

    await writeReviewAudit(makeEntry({ parsed: false, looksLikeFail: false, result: null }));
    Object.assign(_reviewAuditDeps, saved);

    const content = JSON.parse(written[0].content);
    expect(content.parsed).toBe(false);
    expect(content.looksLikeFail).toBe(false);
  });

  test("content includes metadata fields", async () => {
    const { deps, written } = makeDeps();
    Object.assign(_reviewAuditDeps, deps);

    await writeReviewAudit(makeEntry({ reviewer: "semantic", storyId: "US-002", featureName: "my-feature" }));
    Object.assign(_reviewAuditDeps, saved);

    const content = JSON.parse(written[0].content);
    expect(content.reviewer).toBe("semantic");
    expect(content.storyId).toBe("US-002");
    expect(content.featureName).toBe("my-feature");
    expect(content.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("falls back to _unknown subfolder when featureName is absent", async () => {
    const { deps, mkdirCalls } = makeDeps();
    Object.assign(_reviewAuditDeps, deps);

    await writeReviewAudit(makeEntry({ featureName: undefined }));
    Object.assign(_reviewAuditDeps, saved);

    expect(mkdirCalls[0]).toContain("_unknown");
  });

  test("never throws when writeFile errors", async () => {
    const { deps } = makeDeps();
    deps.writeFile = async () => { throw new Error("disk full"); };
    Object.assign(_reviewAuditDeps, deps);

    // Should not throw
    await writeReviewAudit(makeEntry());
    Object.assign(_reviewAuditDeps, saved);
  });

  test("never throws when mkdir errors", async () => {
    const { deps } = makeDeps();
    deps.mkdir = async () => { throw new Error("permission denied"); };
    Object.assign(_reviewAuditDeps, deps);

    await writeReviewAudit(makeEntry());
    Object.assign(_reviewAuditDeps, saved);
  });
});
