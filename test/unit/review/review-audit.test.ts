import { beforeEach, describe, expect, test } from "bun:test";
import { formatAdvisorySummary } from "@/log-format/summary";
import { toAdversarialReviewFindings } from "@/review/adversarial-helpers";
import { tagCoverageGap } from "@/review/recurrence-demotion";
import type { ReviewAuditEntry } from "@/review/review-audit";
import {
  _reviewAuditDeps,
  createNoOpReviewAuditor,
  ReviewAuditor,
  toPersistedEntry,
  writeReviewAudit,
} from "@/review/review-audit";
import { toReviewFindings } from "@/review/semantic-helpers";
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
      advisoryFindings: toAdversarialReviewFindings([
        {
          severity: "warning",
          category: "correctness",
          file: "src/foo.ts",
          line: 3,
          issue: "off-AC bug",
          suggestion: "",
        },
      ]),
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
        ...tagCoverageGap(
          toAdversarialReviewFindings([
            { severity: "error", category: "assumption", file: "lib/s.ts", line: 1, issue: "demoted", suggestion: "" },
          ]),
        ),
        ...toAdversarialReviewFindings([
          {
            severity: "warning",
            category: "correctness",
            file: "lib/s.ts",
            line: 2,
            issue: "ordinary",
            suggestion: "",
          },
        ]),
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
      advisoryFindings: toAdversarialReviewFindings([
        {
          severity: "warning",
          category: "out-of-scope",
          file: "lib/s.ts",
          line: 1,
          issue: "compliance",
          suggestion: "",
          actionRequired: false,
        },
        { severity: "warning", category: "correctness", file: "lib/s.ts", line: 2, issue: "ordinary", suggestion: "" },
      ]),
    });
    await auditor.flush();
    Object.assign(_reviewAuditDeps, saved);

    const summary = auditor.getAdvisoryFindings();
    // Excluded from the fix pass, still present in the report.
    expect(summary.find((s) => s.issue === "compliance")?.actionRequired).toBe(false);
    expect(summary.find((s) => s.issue === "ordinary")?.actionRequired).toBeUndefined();
  });

  // #1816 — the summary mapper read `f.issue`, a field NO producer emits, so every
  // advisory finding rendered as "(no description)" while the audit file held the text.
  // The bug survived because the fixtures above were hand-authored in a shape that only
  // the (unreachable, #1859) legacy reviewer path ever produced. These two tests feed the
  // REAL projection functions instead, so the seam is asserted against what actually flows.
  test("carries the reviewer's text through from the adversarial producer (#1816)", async () => {
    const { deps } = makeDeps();
    Object.assign(_reviewAuditDeps, deps);
    const auditor = new ReviewAuditor("run-1816-adv", "/tmp/workdir");

    const advisoryFindings = toAdversarialReviewFindings([
      {
        severity: "warning",
        category: "error-path",
        file: "src/session-token.ts",
        line: 54,
        issue: "JSON.parse(decoded) throws a raw SyntaxError on an invalid payload",
        suggestion: "Wrap the parse and surface a typed error",
      },
    ]);

    auditor.recordDecision({
      reviewer: "adversarial",
      storyId: "US-001",
      featureName: "my-feature",
      parsed: true,
      passed: true,
      blockingThreshold: "error",
      result: { passed: true, findings: [] },
      advisoryFindings,
    });
    await auditor.flush();
    Object.assign(_reviewAuditDeps, saved);

    const summary = auditor.getAdvisoryFindings();
    expect(summary).toHaveLength(1);
    expect(summary[0]?.issue).toBe("JSON.parse(decoded) throws a raw SyntaxError on an invalid payload");

    // The rendered block is the actual deliverable — assert the operator sees the text.
    const rendered = formatAdvisorySummary(summary, { mode: "normal", useColor: false });
    expect(rendered).toContain("JSON.parse(decoded) throws a raw SyntaxError on an invalid payload");
    expect(rendered).not.toContain("(no description)");
  });

  test("carries the reviewer's text through from the semantic producer (#1816)", async () => {
    const { deps } = makeDeps();
    Object.assign(_reviewAuditDeps, deps);
    const auditor = new ReviewAuditor("run-1816-sem", "/tmp/workdir");

    const advisoryFindings = toReviewFindings([
      {
        severity: "info",
        category: "incomplete",
        file: "src/auth.ts",
        line: 10,
        issue: "AC-2's expiry boundary is never exercised",
        suggestion: "Add a test at exactly expiresAt",
      },
    ]);

    auditor.recordDecision({
      reviewer: "semantic",
      storyId: "US-002",
      featureName: "my-feature",
      parsed: true,
      passed: true,
      blockingThreshold: "error",
      result: { passed: true, findings: [] },
      advisoryFindings,
    });
    await auditor.flush();
    Object.assign(_reviewAuditDeps, saved);

    const summary = auditor.getAdvisoryFindings();
    expect(summary).toHaveLength(1);
    expect(summary[0]?.issue).toBe("AC-2's expiry boundary is never exercised");

    const rendered = formatAdvisorySummary(summary, { mode: "normal", useColor: false });
    expect(rendered).toContain("AC-2's expiry boundary is never exercised");
    expect(rendered).not.toContain("(no description)");
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
      advisoryFindings: toAdversarialReviewFindings([
        { severity: "info", category: "input", file: "a.ts", line: 1, issue: "a", suggestion: "" },
      ]),
    });
    auditor.recordDecision({
      reviewer: "semantic",
      storyId: "US-002",
      parsed: true,
      passed: true,
      result: { passed: true, findings: [] },
      advisoryFindings: toReviewFindings([
        { severity: "warning", category: "incomplete", file: "b.ts", line: 1, issue: "b", suggestion: "" },
        { severity: "warning", category: "incomplete", file: "c.ts", line: 1, issue: "c", suggestion: "" },
      ]),
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

  // Was "resolves blockingThreshold to 'error' when unset (never null)" — a
  // deliberate choice (ac856989c, "resolve blockingThreshold in review audit") to
  // make each record self-describing by applying the config default here.
  //
  // Its premise was that an entry lacking the field was a genuine default-config
  // review. That was false: the only live emitter never forwarded the field at all
  // (nax#1907), so the fallback fired on every record and "resolved" silently meant
  // "always error". Measured over a 5,367-record corpus: 2,938 non-null values, all
  // of them "error", not one "warning" or "info". Analyses keyed on the field were
  // reading a constant (nax#1889).
  //
  // Resolution now happens in the op's verify(), which knows the threshold it
  // actually applied, and the emitter forwards it. A second guess here can only be
  // less informed than the first — so an absent threshold stays visibly absent.
  test("writes blockingThreshold: null when unset — never fabricates the default", () => {
    const json = JSON.parse(toPersistedEntry(base, 1_700_000_000_000));
    expect(json.blockingThreshold).toBeNull();
  });

  test("preserves an explicit blockingThreshold", () => {
    const json = JSON.parse(toPersistedEntry({ ...base, blockingThreshold: "warning" }, 1_700_000_000_000));
    expect(json.blockingThreshold).toBe("warning");
  });
});
