/**
 * Tests for writePromptAudit() — audit-writer helper
 * Migrated from test/unit/agents/acp/prompt-audit.test.ts (#523).
 *
 * Covers:
 * - run-turn filename uses epochMs prefix and -t01 suffix
 * - complete filename uses epochMs prefix, no turn suffix
 * - File content contains all 7 header fields + raw prompt (incl. Resumed field)
 * - stableSessionId (sess-<uuid>) appears in content and enables cross-hop correlation
 * - Custom absolute dir is used verbatim without joining workdir
 * - Absent dir defaults to <workdir>/.nax/prompt-audit/
 * - writeFile throwing → warns via getSafeLogger(), does not throw upstream
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import {
  _promptAuditDeps,
  buildAuditFilename,
  writePromptAudit,
} from "../../../src/session/audit-writer";
import type { PromptAuditEntry } from "../../../src/session/audit-writer";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const WORKDIR = "/tmp/nax-test-workdir";
const SESSION = "nax-abc12345-my-feature-us001";
const EPOCH = 1744038000123;
const STABLE_ID = "sess-550e8400-e29b-41d4-a716-446655440000";

function makeEntry(overrides: Partial<PromptAuditEntry> = {}): PromptAuditEntry {
  return {
    prompt: "Write a failing test for the fibonacci function.",
    sessionName: SESSION,
    workdir: WORKDIR,
    storyId: "us-001",
    featureName: "my-feature",
    pipelineStage: "run",
    callType: "run",
    turn: 1,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildAuditFilename
// ─────────────────────────────────────────────────────────────────────────────

describe("buildAuditFilename()", () => {
  test("run turn — contains epochMs prefix, session name, stage, and t01 suffix", () => {
    const entry = makeEntry({ callType: "run", turn: 1, pipelineStage: "run" });
    const filename = buildAuditFilename(entry, EPOCH);
    expect(filename).toBe(`${EPOCH}-${SESSION}-run-t01.txt`);
  });

  test("run turn 2 — pads turn to 2 digits", () => {
    const entry = makeEntry({ callType: "run", turn: 2, pipelineStage: "run" });
    const filename = buildAuditFilename(entry, EPOCH);
    expect(filename).toBe(`${EPOCH}-${SESSION}-run-t02.txt`);
  });

  test("run turn 10 — no extra padding needed", () => {
    const entry = makeEntry({ callType: "run", turn: 10, pipelineStage: "run" });
    const filename = buildAuditFilename(entry, EPOCH);
    expect(filename).toBe(`${EPOCH}-${SESSION}-run-t10.txt`);
  });

  test("complete — no turn suffix", () => {
    const entry = makeEntry({ callType: "complete", turn: undefined, pipelineStage: "complete" });
    const filename = buildAuditFilename(entry, EPOCH);
    expect(filename).toBe(`${EPOCH}-${SESSION}-complete.txt`);
  });

  test("falls back to callType when pipelineStage is absent", () => {
    const entry = makeEntry({ callType: "complete", turn: undefined, pipelineStage: undefined });
    const filename = buildAuditFilename(entry, EPOCH);
    expect(filename).toBe(`${EPOCH}-${SESSION}-complete.txt`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// writePromptAudit() — file content
// ─────────────────────────────────────────────────────────────────────────────

describe("writePromptAudit() — file content", () => {
  const origMkdir = _promptAuditDeps.mkdir;
  const origWrite = _promptAuditDeps.writeFile;
  const origNow = _promptAuditDeps.now;

  beforeEach(() => {
    _promptAuditDeps.mkdir = mock(async (_path: string) => {});
    _promptAuditDeps.now = mock(() => EPOCH);
  });

  afterEach(() => {
    _promptAuditDeps.mkdir = origMkdir;
    _promptAuditDeps.writeFile = origWrite;
    _promptAuditDeps.now = origNow;
    mock.restore();
  });

  test("writes file with all header fields present", async () => {
    let capturedContent = "";
    _promptAuditDeps.writeFile = mock(async (_path: string, content: string) => {
      capturedContent = content;
    });

    await writePromptAudit(makeEntry());

    expect(capturedContent).toContain(`Timestamp: ${new Date(EPOCH).toISOString()}`);
    expect(capturedContent).toContain(`Session:   ${SESSION}`);
    expect(capturedContent).toContain("Type:      run / turn 1");
    expect(capturedContent).toContain("StoryId:   us-001");
    expect(capturedContent).toContain("Feature:   my-feature");
    expect(capturedContent).toContain("Stage:     run");
    expect(capturedContent).toContain("Resumed:   no");
  });

  test("stableSessionId appears in content as StableId field", async () => {
    let capturedContent = "";
    _promptAuditDeps.writeFile = mock(async (_path: string, content: string) => {
      capturedContent = content;
    });

    await writePromptAudit(makeEntry({ stableSessionId: STABLE_ID }));

    expect(capturedContent).toContain(`StableId:  ${STABLE_ID}`);
  });

  test("stableSessionId is omitted from content when not set", async () => {
    let capturedContent = "";
    _promptAuditDeps.writeFile = mock(async (_path: string, content: string) => {
      capturedContent = content;
    });

    await writePromptAudit(makeEntry({ stableSessionId: undefined }));

    expect(capturedContent).not.toContain("StableId:");
  });

  test("same stableSessionId across two hops (audit continuity)", async () => {
    const captured: string[] = [];
    _promptAuditDeps.writeFile = mock(async (_path: string, content: string) => {
      captured.push(content);
    });

    await writePromptAudit(makeEntry({ stableSessionId: STABLE_ID, turn: 1 }));
    await writePromptAudit(
      makeEntry({ stableSessionId: STABLE_ID, sessionName: "nax-xyz-hop2-agent", turn: 2 }),
    );

    expect(captured).toHaveLength(2);
    expect(captured[0]).toContain(`StableId:  ${STABLE_ID}`);
    expect(captured[1]).toContain(`StableId:  ${STABLE_ID}`);
    // sessionName changes across hops; stableSessionId stays the same
    expect(captured[1]).toContain("Session:   nax-xyz-hop2-agent");
    expect(captured[1]).toContain(`StableId:  ${STABLE_ID}`);
  });

  test("writes raw prompt text after the separator", async () => {
    const prompt = "Implement the fibonacci function with memoization.";
    let capturedContent = "";
    _promptAuditDeps.writeFile = mock(async (_path: string, content: string) => {
      capturedContent = content;
    });

    await writePromptAudit(makeEntry({ prompt }));

    const parts = capturedContent.split("---\n");
    expect(parts.length).toBe(2);
    expect(parts[1]).toBe(prompt);
  });

  test("complete type label — shows 'complete' not 'run / turn'", async () => {
    let capturedContent = "";
    _promptAuditDeps.writeFile = mock(async (_path: string, content: string) => {
      capturedContent = content;
    });

    await writePromptAudit(makeEntry({ callType: "complete", turn: undefined, pipelineStage: "complete" }));

    expect(capturedContent).toContain("Type:      complete");
  });

  test("absent storyId/featureName renders as (none)", async () => {
    let capturedContent = "";
    _promptAuditDeps.writeFile = mock(async (_path: string, content: string) => {
      capturedContent = content;
    });

    await writePromptAudit(makeEntry({ storyId: undefined, featureName: undefined }));

    expect(capturedContent).toContain("StoryId:   (none)");
    expect(capturedContent).toContain("Feature:   (none)");
  });

  test("resumed:true renders as 'Resumed:   yes'", async () => {
    let capturedContent = "";
    _promptAuditDeps.writeFile = mock(async (_path: string, content: string) => {
      capturedContent = content;
    });

    await writePromptAudit(makeEntry({ resumed: true }));

    expect(capturedContent).toContain("Resumed:   yes");
  });

  test("resumed:false renders as 'Resumed:   no'", async () => {
    let capturedContent = "";
    _promptAuditDeps.writeFile = mock(async (_path: string, content: string) => {
      capturedContent = content;
    });

    await writePromptAudit(makeEntry({ resumed: false }));

    expect(capturedContent).toContain("Resumed:   no");
  });

  test("resumed:undefined renders as 'Resumed:   no'", async () => {
    let capturedContent = "";
    _promptAuditDeps.writeFile = mock(async (_path: string, content: string) => {
      capturedContent = content;
    });

    await writePromptAudit(makeEntry({ resumed: undefined }));

    expect(capturedContent).toContain("Resumed:   no");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// writePromptAudit() — directory resolution
// ─────────────────────────────────────────────────────────────────────────────

describe("writePromptAudit() — directory resolution", () => {
  const origMkdir = _promptAuditDeps.mkdir;
  const origWrite = _promptAuditDeps.writeFile;
  const origNow = _promptAuditDeps.now;
  const origExists = _promptAuditDeps.exists;

  beforeEach(() => {
    _promptAuditDeps.now = mock(() => EPOCH);
    _promptAuditDeps.writeFile = mock(async () => {});
    // Default: no .nax/config.json found anywhere — findNaxProjectRoot falls back to workdir.
    _promptAuditDeps.exists = mock(async () => false);
  });

  afterEach(() => {
    _promptAuditDeps.mkdir = origMkdir;
    _promptAuditDeps.writeFile = origWrite;
    _promptAuditDeps.now = origNow;
    _promptAuditDeps.exists = origExists;
    mock.restore();
  });

  test("absent auditDir defaults to <workdir>/.nax/prompt-audit/<featureName>/", async () => {
    let capturedDir = "";
    _promptAuditDeps.mkdir = mock(async (path: string) => {
      capturedDir = path;
    });

    await writePromptAudit(makeEntry({ auditDir: undefined, featureName: "my-feature" }));

    expect(capturedDir).toBe(join(WORKDIR, ".nax", "prompt-audit", "my-feature"));
  });

  test("absent featureName falls back to _unknown subfolder", async () => {
    let capturedDir = "";
    _promptAuditDeps.mkdir = mock(async (path: string) => {
      capturedDir = path;
    });

    await writePromptAudit(makeEntry({ auditDir: undefined, featureName: undefined }));

    expect(capturedDir).toBe(join(WORKDIR, ".nax", "prompt-audit", "_unknown"));
  });

  test("absolute auditDir is combined with featureName", async () => {
    let capturedDir = "";
    _promptAuditDeps.mkdir = mock(async (path: string) => {
      capturedDir = path;
    });

    await writePromptAudit(makeEntry({ auditDir: "/custom/absolute/audit", featureName: "my-feature" }));

    expect(capturedDir).toBe("/custom/absolute/audit/my-feature");
  });

  test("relative auditDir is joined with workdir then featureName", async () => {
    let capturedDir = "";
    _promptAuditDeps.mkdir = mock(async (path: string) => {
      capturedDir = path;
    });

    await writePromptAudit(makeEntry({ auditDir: "my-audit", featureName: "my-feature" }));

    expect(capturedDir).toBe(join(WORKDIR, "my-audit", "my-feature"));
  });

  test("monorepo package subdir — walks up to find nax project root", async () => {
    const projectRoot = "/project/koda";
    const packageWorkdir = `${projectRoot}/apps/api`;
    let capturedDir = "";
    _promptAuditDeps.mkdir = mock(async (path: string) => {
      capturedDir = path;
    });
    const origExistsLocal = _promptAuditDeps.exists;
    _promptAuditDeps.exists = mock(async (path: string) => path === `${projectRoot}/.nax/config.json`);

    await writePromptAudit(makeEntry({ workdir: packageWorkdir, auditDir: undefined, featureName: "my-feature" }));

    _promptAuditDeps.exists = origExistsLocal;
    expect(capturedDir).toBe(join(projectRoot, ".nax", "prompt-audit", "my-feature"));
  });

  test("monorepo — no .nax/config.json found anywhere, falls back to workdir", async () => {
    const packageWorkdir = "/project/koda/apps/web";
    let capturedDir = "";
    _promptAuditDeps.mkdir = mock(async (path: string) => {
      capturedDir = path;
    });

    await writePromptAudit(makeEntry({ workdir: packageWorkdir, auditDir: undefined, featureName: "my-feature" }));

    expect(capturedDir).toBe(join(packageWorkdir, ".nax", "prompt-audit", "my-feature"));
  });

  test("worktree workdir — strips /.nax-wt/<story>/ and writes to project root", async () => {
    const projectRoot = "/project/my-app";
    const worktreeWorkdir = `${projectRoot}/.nax-wt/vcs-p2-001`;
    let capturedDir = "";
    _promptAuditDeps.mkdir = mock(async (path: string) => {
      capturedDir = path;
    });

    await writePromptAudit(makeEntry({ workdir: worktreeWorkdir, auditDir: undefined, featureName: "my-feature" }));

    expect(capturedDir).toBe(join(projectRoot, ".nax", "prompt-audit", "my-feature"));
  });

  test("worktree workdir with no auditDir — falls back to project root not worktree", async () => {
    const projectRoot = "/home/user/project";
    const worktreeWorkdir = `${projectRoot}/.nax-wt/feat-story-id`;
    let capturedDir = "";
    _promptAuditDeps.mkdir = mock(async (path: string) => {
      capturedDir = path;
    });

    await writePromptAudit(makeEntry({ workdir: worktreeWorkdir, auditDir: undefined, featureName: undefined }));

    expect(capturedDir).toBe(join(projectRoot, ".nax", "prompt-audit", "_unknown"));
  });

  test("absolute auditDir in worktree context — still uses the explicit absolute dir", async () => {
    const worktreeWorkdir = "/project/.nax-wt/some-story";
    let capturedDir = "";
    _promptAuditDeps.mkdir = mock(async (path: string) => {
      capturedDir = path;
    });

    await writePromptAudit(
      makeEntry({ workdir: worktreeWorkdir, auditDir: "/custom/audit", featureName: "my-feature" }),
    );

    expect(capturedDir).toBe("/custom/audit/my-feature");
  });

  test("writeFile is called with path inside resolved dir", async () => {
    let capturedPath = "";
    _promptAuditDeps.mkdir = mock(async () => {});
    _promptAuditDeps.writeFile = mock(async (path: string) => {
      capturedPath = path;
    });

    await writePromptAudit(makeEntry({ callType: "run", turn: 1, pipelineStage: "run", featureName: "my-feature" }));

    const expectedDir = join(WORKDIR, ".nax", "prompt-audit", "my-feature");
    expect(capturedPath.startsWith(expectedDir)).toBe(true);
    expect(capturedPath).toContain("-t01.txt");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// writePromptAudit() — enabled:false guard
// ─────────────────────────────────────────────────────────────────────────────

describe("writePromptAudit() — always-writes contract", () => {
  test("direct call always writes (enabled check is at the call-site level)", async () => {
    const origWrite = _promptAuditDeps.writeFile;
    const origMkdir = _promptAuditDeps.mkdir;
    const origNow = _promptAuditDeps.now;
    let writeCalls = 0;
    _promptAuditDeps.writeFile = mock(async () => {
      writeCalls++;
    });
    _promptAuditDeps.mkdir = mock(async () => {});
    _promptAuditDeps.now = mock(() => EPOCH);

    await writePromptAudit(makeEntry());
    expect(writeCalls).toBe(1);

    _promptAuditDeps.writeFile = origWrite;
    _promptAuditDeps.mkdir = origMkdir;
    _promptAuditDeps.now = origNow;
    mock.restore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// writePromptAudit() — error resilience
// ─────────────────────────────────────────────────────────────────────────────

describe("writePromptAudit() — error resilience", () => {
  test("writeFile throwing does not throw to caller", async () => {
    const origWrite = _promptAuditDeps.writeFile;
    const origMkdir = _promptAuditDeps.mkdir;
    const origNow = _promptAuditDeps.now;
    _promptAuditDeps.mkdir = mock(async () => {});
    _promptAuditDeps.now = mock(() => EPOCH);
    _promptAuditDeps.writeFile = mock(async () => {
      throw new Error("disk full");
    });

    expect(await writePromptAudit(makeEntry())).toBeUndefined();

    _promptAuditDeps.writeFile = origWrite;
    _promptAuditDeps.mkdir = origMkdir;
    _promptAuditDeps.now = origNow;
    mock.restore();
  });

  test("mkdir throwing does not throw to caller", async () => {
    const origWrite = _promptAuditDeps.writeFile;
    const origMkdir = _promptAuditDeps.mkdir;
    const origNow = _promptAuditDeps.now;
    _promptAuditDeps.now = mock(() => EPOCH);
    _promptAuditDeps.mkdir = mock(async () => {
      throw new Error("permission denied");
    });
    _promptAuditDeps.writeFile = mock(async () => {});

    expect(await writePromptAudit(makeEntry())).toBeUndefined();

    _promptAuditDeps.writeFile = origWrite;
    _promptAuditDeps.mkdir = origMkdir;
    _promptAuditDeps.now = origNow;
    mock.restore();
  });
});
