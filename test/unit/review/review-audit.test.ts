import { beforeEach, describe, expect, test } from "bun:test";
import {
  ReviewAuditor,
  _reviewAuditDeps,
  createNoOpReviewAuditor,
  toPersistedEntry,
  writeReviewAudit,
} from "@/review/review-audit";
import type { ReviewAuditEntry } from "@/review/review-audit";
import { NAX_COMMIT, NAX_VERSION } from "@/version";

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
    expect(content.sessionId).toBeNull();
    expect(content.recordId).toBeNull();
    expect(content.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("content includes ACP correlation fields when provided", async () => {
    const { deps, written } = makeDeps();
    Object.assign(_reviewAuditDeps, deps);

    await writeReviewAudit(makeEntry({ runId: "run-1", sessionId: "sid-1", recordId: "rid-1", agentName: "claude" }));
    Object.assign(_reviewAuditDeps, saved);

    const content = JSON.parse(written[0].content);
    expect(content.runId).toBe("run-1");
    expect(content.sessionId).toBe("sid-1");
    expect(content.recordId).toBe("rid-1");
    expect(content.agentName).toBe("claude");
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
    deps.writeFile = async () => {
      throw new Error("disk full");
    };
    Object.assign(_reviewAuditDeps, deps);

    // Should not throw
    await writeReviewAudit(makeEntry());
    Object.assign(_reviewAuditDeps, saved);
  });

  test("never throws when mkdir errors", async () => {
    const { deps } = makeDeps();
    deps.mkdir = async () => {
      throw new Error("permission denied");
    };
    Object.assign(_reviewAuditDeps, deps);

    await writeReviewAudit(makeEntry());
    Object.assign(_reviewAuditDeps, saved);
  });
});

describe("ReviewAuditor", () => {
  let saved: typeof _reviewAuditDeps;

  beforeEach(() => {
    saved = { ..._reviewAuditDeps };
  });

  test("merges review dispatch metadata into final decision audit", async () => {
    const { deps, written } = makeDeps();
    Object.assign(_reviewAuditDeps, deps);
    const auditor = new ReviewAuditor("run-1", "/tmp/workdir");

    auditor.recordDispatch({
      runId: "run-1",
      reviewer: "semantic",
      sessionName: "nax-reviewer-semantic",
      sessionId: "sid-1",
      recordId: "rid-1",
      workdir: "/tmp/workdir",
      projectDir: "/tmp/project",
      agentName: "claude",
      storyId: "US-001",
      featureName: "my-feature",
    });
    auditor.recordDecision({
      reviewer: "semantic",
      storyId: "US-001",
      parsed: true,
      passed: true,
      blockingThreshold: "error",
      result: { passed: true, findings: [] },
    });
    await auditor.flush();
    Object.assign(_reviewAuditDeps, saved);

    const content = JSON.parse(written[0].content);
    expect(written[0].path).toContain("review-audit/my-feature");
    expect(content.sessionName).toBe("nax-reviewer-semantic");
    expect(content.sessionId).toBe("sid-1");
    expect(content.recordId).toBe("rid-1");
    expect(content.agentName).toBe("claude");
    expect(content.passed).toBe(true);
    expect(content.blockingThreshold).toBe("error");
  });

  test("writes decision with fallback session name when dispatch metadata is absent", async () => {
    const { deps, written } = makeDeps();
    Object.assign(_reviewAuditDeps, deps);
    const auditor = new ReviewAuditor("run-1", "/tmp/workdir");

    auditor.recordDecision({
      reviewer: "adversarial",
      storyId: "US-404",
      parsed: false,
      looksLikeFail: false,
      failOpen: true,
      passed: true,
      result: null,
    });
    await auditor.flush();
    Object.assign(_reviewAuditDeps, saved);

    const content = JSON.parse(written[0].content);
    expect(content.sessionName).toBe("review-adversarial-US-404");
    expect(content.sessionId).toBeNull();
    expect(content.recordId).toBeNull();
    expect(content.failOpen).toBe(true);
  });

  test("does not reuse dispatch metadata after a decision is recorded", async () => {
    const { deps, written } = makeDeps();
    Object.assign(_reviewAuditDeps, deps);
    const auditor = new ReviewAuditor("run-1", "/tmp/workdir");

    auditor.recordDispatch({
      runId: "run-1",
      reviewer: "semantic",
      sessionName: "nax-old-review",
      sessionId: "sid-old",
      recordId: "rid-old",
      storyId: "US-001",
      featureName: "my-feature",
    });
    auditor.recordDecision({
      reviewer: "semantic",
      storyId: "US-001",
      parsed: true,
      passed: true,
      result: { passed: true, findings: [] },
    });
    auditor.recordDecision({
      reviewer: "semantic",
      storyId: "US-001",
      parsed: false,
      looksLikeFail: false,
      failOpen: true,
      passed: true,
      result: null,
    });
    await auditor.flush();
    Object.assign(_reviewAuditDeps, saved);

    const first = JSON.parse(written[0].content);
    const second = JSON.parse(written[1].content);
    expect(first.sessionName).toBe("nax-old-review");
    expect(first.sessionId).toBe("sid-old");
    expect(second.sessionName).toBe("review-semantic-US-001");
    expect(second.sessionId).toBeNull();
    expect(second.recordId).toBeNull();
  });
});

describe("ReviewAuditor.getAdvisoryFindings", () => {
  let saved: typeof _reviewAuditDeps;

  beforeEach(() => {
    saved = { ..._reviewAuditDeps };
  });

  test("aggregates advisory findings from recorded decisions", async () => {
    const { deps } = makeDeps();
    Object.assign(_reviewAuditDeps, deps);
    const auditor = new ReviewAuditor("run-1", "/tmp/workdir");

    auditor.recordDecision({
      reviewer: "adversarial",
      storyId: "US-001",
      featureName: "my-feature",
      parsed: true,
      passed: true,
      blockingThreshold: "error",
      result: { passed: true, findings: [] },
      advisoryFindings: [{ severity: "warning", category: "correctness", file: "src/foo.ts", issue: "off-AC bug" }],
    });
    await auditor.flush();
    Object.assign(_reviewAuditDeps, saved);

    const summary = auditor.getAdvisoryFindings();
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      storyId: "US-001",
      reviewer: "adversarial",
      severity: "warning",
      category: "correctness",
      file: "src/foo.ts",
      issue: "off-AC bug",
    });
  });

  test("preserves meta.coverageGap as a coverageGap flag on the summary entry", async () => {
    const { deps } = makeDeps();
    Object.assign(_reviewAuditDeps, deps);
    const auditor = new ReviewAuditor("run-cg", "/tmp/workdir");

    auditor.recordDecision({
      reviewer: "adversarial",
      storyId: "US-004",
      featureName: "f",
      parsed: true,
      passed: true,
      blockingThreshold: "error",
      result: { passed: true, findings: [] },
      advisoryFindings: [
        { severity: "error", category: "assumption", file: "lib/s.ts", issue: "demoted", meta: { coverageGap: true } },
        { severity: "warning", category: "correctness", file: "lib/s.ts", issue: "ordinary" },
      ],
    });
    await auditor.flush();
    Object.assign(_reviewAuditDeps, saved);

    const summary = auditor.getAdvisoryFindings();
    expect(summary.find((s) => s.issue === "demoted")?.coverageGap).toBe(true);
    expect(summary.find((s) => s.issue === "ordinary")?.coverageGap).toBeUndefined();
  });

  test("preserves actionRequired:false on the summary entry (#1359)", async () => {
    const { deps } = makeDeps();
    Object.assign(_reviewAuditDeps, deps);
    const auditor = new ReviewAuditor("run-ar", "/tmp/workdir");

    auditor.recordDecision({
      reviewer: "adversarial",
      storyId: "US-004",
      featureName: "f",
      parsed: true,
      passed: true,
      blockingThreshold: "error",
      result: { passed: true, findings: [] },
      advisoryFindings: [
        { severity: "warning", category: "out-of-scope", file: "lib/s.ts", issue: "compliance", actionRequired: false },
        { severity: "warning", category: "correctness", file: "lib/s.ts", issue: "ordinary" },
      ],
    });
    await auditor.flush();
    Object.assign(_reviewAuditDeps, saved);

    const summary = auditor.getAdvisoryFindings();
    // Excluded from the fix pass, still present in the report.
    expect(summary.find((s) => s.issue === "compliance")?.actionRequired).toBe(false);
    expect(summary.find((s) => s.issue === "ordinary")?.actionRequired).toBeUndefined();
  });

  test("decisions with no advisory findings contribute nothing", async () => {
    const { deps } = makeDeps();
    Object.assign(_reviewAuditDeps, deps);
    const auditor = new ReviewAuditor("run-1", "/tmp/workdir");

    auditor.recordDecision({
      reviewer: "semantic",
      storyId: "US-002",
      parsed: true,
      passed: true,
      result: { passed: true, findings: [] },
    });
    await auditor.flush();
    Object.assign(_reviewAuditDeps, saved);

    expect(auditor.getAdvisoryFindings()).toHaveLength(0);
  });

  test("accumulates advisory findings across multiple stories", async () => {
    const { deps } = makeDeps();
    Object.assign(_reviewAuditDeps, deps);
    const auditor = new ReviewAuditor("run-1", "/tmp/workdir");

    auditor.recordDecision({
      reviewer: "adversarial",
      storyId: "US-001",
      parsed: true,
      passed: true,
      result: { passed: true, findings: [] },
      advisoryFindings: [{ severity: "info", issue: "a" }],
    });
    auditor.recordDecision({
      reviewer: "semantic",
      storyId: "US-002",
      parsed: true,
      passed: true,
      result: { passed: true, findings: [] },
      advisoryFindings: [
        { severity: "warning", issue: "b" },
        { severity: "warning", issue: "c" },
      ],
    });
    await auditor.flush();
    Object.assign(_reviewAuditDeps, saved);

    const summary = auditor.getAdvisoryFindings();
    expect(summary).toHaveLength(3);
    expect(summary.map((f) => f.storyId)).toEqual(["US-001", "US-002", "US-002"]);
  });

  test("no-op auditor returns an empty advisory findings list", () => {
    const auditor = createNoOpReviewAuditor();
    expect(auditor.getAdvisoryFindings()).toEqual([]);
  });
});

describe("toPersistedEntry", () => {
  const base: ReviewAuditEntry = {
    reviewer: "adversarial",
    sessionName: "s",
    workdir: "/tmp/workdir",
    parsed: true,
    result: { passed: false, findings: [] },
  };

  test("stamps naxVersion and naxCommit", () => {
    const json = JSON.parse(toPersistedEntry(base, 1_700_000_000_000));
    expect(json.naxVersion).toBe(NAX_VERSION);
    expect(json.naxCommit).toBe(NAX_COMMIT);
  });

  test("persists acks to the audit JSON, outside result.findings (#1423)", () => {
    const json = JSON.parse(
      toPersistedEntry(
        { ...base, acks: [{ priorFinding: "src/a.ts:4", status: "addressed", note: "fixed at line 6" }] },
        1_700_000_000_000,
      ),
    );
    expect(json.acks).toEqual([{ priorFinding: "src/a.ts:4", status: "addressed", note: "fixed at line 6" }]);
    expect(json.result.findings).toEqual([]);
  });

  test("writes acks: null when the reviewer acknowledged nothing", () => {
    expect(JSON.parse(toPersistedEntry(base, 1_700_000_000_000)).acks).toBeNull();
  });

  test("resolves blockingThreshold to 'error' when unset (never null)", () => {
    const json = JSON.parse(toPersistedEntry(base, 1_700_000_000_000));
    expect(json.blockingThreshold).toBe("error");
  });

  test("preserves an explicit blockingThreshold", () => {
    const json = JSON.parse(toPersistedEntry({ ...base, blockingThreshold: "warning" }, 1_700_000_000_000));
    expect(json.blockingThreshold).toBe("warning");
  });
});
