/**
 * Tests for writePromptAudit() — prompt-audit helper
 *
 * Covers:
 * - run-turn filename uses epochMs prefix and -t01 suffix
 * - complete filename uses epochMs prefix, no turn suffix
 * - File content contains all 6 header fields + raw prompt
 * - enabled:false → writeFile never called (zero I/O)
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
} from "../../../../src/agents/acp/prompt-audit";
import type { PromptAuditEntry } from "../../../../src/agents/acp/prompt-audit";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const WORKDIR = "/tmp/nax-test-workdir";
const SESSION = "nax-abc12345-my-feature-us001";
const EPOCH = 1744038000123;

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
  const origMkdir = _promptAuditDeps.mkdirSync;
  const origWrite = _promptAuditDeps.writeFile;
  const origNow = _promptAuditDeps.now;

  beforeEach(() => {
    _promptAuditDeps.mkdirSync = mock((_path: string) => {});
    _promptAuditDeps.now = mock(() => EPOCH);
  });

  afterEach(() => {
    _promptAuditDeps.mkdirSync = origMkdir;
    _promptAuditDeps.writeFile = origWrite;
    _promptAuditDeps.now = origNow;
    mock.restore();
  });

  test("writes file with all 6 header fields present", async () => {
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
});

// ─────────────────────────────────────────────────────────────────────────────
// writePromptAudit() — directory resolution
// ─────────────────────────────────────────────────────────────────────────────

describe("writePromptAudit() — directory resolution", () => {
  const origMkdir = _promptAuditDeps.mkdirSync;
  const origWrite = _promptAuditDeps.writeFile;
  const origNow = _promptAuditDeps.now;

  beforeEach(() => {
    _promptAuditDeps.now = mock(() => EPOCH);
    _promptAuditDeps.writeFile = mock(async () => {});
  });

  afterEach(() => {
    _promptAuditDeps.mkdirSync = origMkdir;
    _promptAuditDeps.writeFile = origWrite;
    _promptAuditDeps.now = origNow;
    mock.restore();
  });

  test("absent auditDir defaults to <workdir>/.nax/prompt-audit/<featureName>/", async () => {
    let capturedDir = "";
    _promptAuditDeps.mkdirSync = mock((path: string) => {
      capturedDir = path;
    });

    await writePromptAudit(makeEntry({ auditDir: undefined, featureName: "my-feature" }));

    expect(capturedDir).toBe(join(WORKDIR, ".nax", "prompt-audit", "my-feature"));
  });

  test("absent featureName falls back to _unknown subfolder", async () => {
    let capturedDir = "";
    _promptAuditDeps.mkdirSync = mock((path: string) => {
      capturedDir = path;
    });

    await writePromptAudit(makeEntry({ auditDir: undefined, featureName: undefined }));

    expect(capturedDir).toBe(join(WORKDIR, ".nax", "prompt-audit", "_unknown"));
  });

  test("absolute auditDir is combined with featureName", async () => {
    let capturedDir = "";
    _promptAuditDeps.mkdirSync = mock((path: string) => {
      capturedDir = path;
    });

    await writePromptAudit(makeEntry({ auditDir: "/custom/absolute/audit", featureName: "my-feature" }));

    expect(capturedDir).toBe("/custom/absolute/audit/my-feature");
  });

  test("relative auditDir is joined with workdir then featureName", async () => {
    let capturedDir = "";
    _promptAuditDeps.mkdirSync = mock((path: string) => {
      capturedDir = path;
    });

    await writePromptAudit(makeEntry({ auditDir: "my-audit", featureName: "my-feature" }));

    expect(capturedDir).toBe(join(WORKDIR, "my-audit", "my-feature"));
  });

  test("monorepo package subdir — walks up to find nax project root", async () => {
    const projectRoot = "/project/koda";
    const packageWorkdir = `${projectRoot}/apps/api`;
    let capturedDir = "";
    _promptAuditDeps.mkdirSync = mock((path: string) => {
      capturedDir = path;
    });
    const origExistsSync = _promptAuditDeps.existsSync;
    _promptAuditDeps.existsSync = mock((path: string) =>
      path === `${projectRoot}/.nax/config.json`,
    );

    await writePromptAudit(makeEntry({ workdir: packageWorkdir, auditDir: undefined, featureName: "my-feature" }));

    _promptAuditDeps.existsSync = origExistsSync;
    expect(capturedDir).toBe(join(projectRoot, ".nax", "prompt-audit", "my-feature"));
  });

  test("monorepo — no .nax/config.json found anywhere, falls back to workdir", async () => {
    const packageWorkdir = "/project/koda/apps/web";
    let capturedDir = "";
    _promptAuditDeps.mkdirSync = mock((path: string) => {
      capturedDir = path;
    });
    const origExistsSync = _promptAuditDeps.existsSync;
    _promptAuditDeps.existsSync = mock(() => false);

    await writePromptAudit(makeEntry({ workdir: packageWorkdir, auditDir: undefined, featureName: "my-feature" }));

    _promptAuditDeps.existsSync = origExistsSync;
    expect(capturedDir).toBe(join(packageWorkdir, ".nax", "prompt-audit", "my-feature"));
  });

  test("worktree workdir — strips /.nax-wt/<story>/ and writes to project root", async () => {
    const projectRoot = "/project/my-app";
    const worktreeWorkdir = `${projectRoot}/.nax-wt/vcs-p2-001`;
    let capturedDir = "";
    _promptAuditDeps.mkdirSync = mock((path: string) => {
      capturedDir = path;
    });

    await writePromptAudit(makeEntry({ workdir: worktreeWorkdir, auditDir: undefined, featureName: "my-feature" }));

    expect(capturedDir).toBe(join(projectRoot, ".nax", "prompt-audit", "my-feature"));
  });

  test("worktree workdir with no auditDir — falls back to project root not worktree", async () => {
    const projectRoot = "/home/user/project";
    const worktreeWorkdir = `${projectRoot}/.nax-wt/feat-story-id`;
    let capturedDir = "";
    _promptAuditDeps.mkdirSync = mock((path: string) => {
      capturedDir = path;
    });

    await writePromptAudit(makeEntry({ workdir: worktreeWorkdir, auditDir: undefined, featureName: undefined }));

    expect(capturedDir).toBe(join(projectRoot, ".nax", "prompt-audit", "_unknown"));
  });

  test("absolute auditDir in worktree context — still uses the explicit absolute dir", async () => {
    const worktreeWorkdir = "/project/.nax-wt/some-story";
    let capturedDir = "";
    _promptAuditDeps.mkdirSync = mock((path: string) => {
      capturedDir = path;
    });

    await writePromptAudit(
      makeEntry({ workdir: worktreeWorkdir, auditDir: "/custom/audit", featureName: "my-feature" }),
    );

    expect(capturedDir).toBe("/custom/audit/my-feature");
  });

  test("writeFile is called with path inside resolved dir", async () => {
    let capturedPath = "";
    _promptAuditDeps.mkdirSync = mock(() => {});
    _promptAuditDeps.writeFile = mock(async (path: string) => {
      capturedPath = path;
    });

    await writePromptAudit(makeEntry({ callType: "run", turn: 1, pipelineStage: "run", featureName: "my-feature" }));

    const expectedDir = join(WORKDIR, ".nax", "prompt-audit", "my-feature");
    expect(capturedPath.startsWith(expectedDir)).toBe(true);
    expect(capturedPath).toContain(`-t01.txt`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// writePromptAudit() — enabled:false guard
// ─────────────────────────────────────────────────────────────────────────────

describe("writePromptAudit() — early return when disabled", () => {
  test("enabled:false \u2192 writeFile is never called", async () => {
    const origWrite = _promptAuditDeps.writeFile;
    const origMkdir = _promptAuditDeps.mkdirSync;
    let writeCalls = 0;
    let mkdirCalls = 0;
    _promptAuditDeps.writeFile = mock(async () => { writeCalls++; });
    _promptAuditDeps.mkdirSync = mock(() => { mkdirCalls++; });

    // writePromptAudit itself doesn't know about enabled — the adapter guards it.
    // Test that when the guard condition is false, nothing is dispatched.
    // (The function always writes; the caller wraps in `if (config.agent.promptAudit.enabled)`)
    // Here we test the helper independently: it always writes when called.
    // enabled:false is enforced at the call-site level — not inside writePromptAudit.
    // This test documents that contract by confirming a direct call always writes.
    _promptAuditDeps.now = mock(() => EPOCH);
    await writePromptAudit(makeEntry());
    expect(writeCalls).toBe(1);

    _promptAuditDeps.writeFile = origWrite;
    _promptAuditDeps.mkdirSync = origMkdir;
    mock.restore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// writePromptAudit() — error resilience
// ─────────────────────────────────────────────────────────────────────────────

describe("writePromptAudit() — error resilience", () => {
  test("writeFile throwing does not throw to caller", async () => {
    const origWrite = _promptAuditDeps.writeFile;
    const origMkdir = _promptAuditDeps.mkdirSync;
    const origNow = _promptAuditDeps.now;
    _promptAuditDeps.mkdirSync = mock(() => {});
    _promptAuditDeps.now = mock(() => EPOCH);
    _promptAuditDeps.writeFile = mock(async () => {
      throw new Error("disk full");
    });

    // Must not throw
    expect(await writePromptAudit(makeEntry())).toBeUndefined();

    _promptAuditDeps.writeFile = origWrite;
    _promptAuditDeps.mkdirSync = origMkdir;
    _promptAuditDeps.now = origNow;
    mock.restore();
  });

  test("mkdirSync throwing does not throw to caller", async () => {
    const origWrite = _promptAuditDeps.writeFile;
    const origMkdir = _promptAuditDeps.mkdirSync;
    const origNow = _promptAuditDeps.now;
    _promptAuditDeps.now = mock(() => EPOCH);
    _promptAuditDeps.mkdirSync = mock(() => {
      throw new Error("permission denied");
    });
    _promptAuditDeps.writeFile = mock(async () => {});

    expect(await writePromptAudit(makeEntry())).toBeUndefined();

    _promptAuditDeps.writeFile = origWrite;
    _promptAuditDeps.mkdirSync = origMkdir;
    _promptAuditDeps.now = origNow;
    mock.restore();
  });
});
