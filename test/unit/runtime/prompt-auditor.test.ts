import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { PromptAuditor, _promptAuditorDeps, type PromptAuditEntry } from "../../../src/runtime/prompt-auditor";
import { withTempDir } from "../../helpers/temp";

const FEATURE = "my-feature";

function makeEntry(overrides: Partial<PromptAuditEntry> = {}): PromptAuditEntry {
  return {
    ts: Date.now(),
    runId: "r-001",
    agentName: "claude",
    permissionProfile: "approve-reads",
    prompt: "Do the thing",
    response: "Done",
    durationMs: 100,
    ...overrides,
  };
}

describe("PromptAuditor", () => {
  test("record() persists entry to JSONL immediately without waiting for flush()", async () => {
    await withTempDir(async (dir) => {
      const flushDir = join(dir, "audit");
      const appendedLines: string[] = [];
      const orig = _promptAuditorDeps.appendLine;
      _promptAuditorDeps.appendLine = async (_p: string, d: string) => { appendedLines.push(d); };
      const aud = new PromptAuditor("r-001", flushDir, FEATURE);
      aud.record(makeEntry({ prompt: "immediate" }));
      // wait for microtask queue to process the enqueued write
      await new Promise((r) => setTimeout(r, 0));
      expect(appendedLines.length).toBeGreaterThan(0);
      expect(appendedLines[0]).toContain('"immediate"');
      _promptAuditorDeps.appendLine = orig;
    });
  });

  test("flush() does nothing when no entries", async () => {
    const writes: string[] = [];
    const appends: string[] = [];
    const origWrite = _promptAuditorDeps.write;
    const origAppend = _promptAuditorDeps.appendLine;
    _promptAuditorDeps.write = async (p) => { writes.push(p); return 0; };
    _promptAuditorDeps.appendLine = async (p) => { appends.push(p); };
    const aud = new PromptAuditor("r-001", "/tmp/audit", FEATURE);
    await aud.flush();
    expect(writes).toHaveLength(0);
    expect(appends).toHaveLength(0);
    _promptAuditorDeps.write = origWrite;
    _promptAuditorDeps.appendLine = origAppend;
  });

  test("flush() writes one JSONL line per entry in insertion order", async () => {
    await withTempDir(async (dir) => {
      const flushDir = join(dir, "audit");
      const appendedData: string[] = [];
      const origAppend = _promptAuditorDeps.appendLine;
      _promptAuditorDeps.appendLine = async (_p: string, d: string) => { appendedData.push(d); };
      const orig = _promptAuditorDeps.write;
      _promptAuditorDeps.write = async () => 0;
      const aud = new PromptAuditor("r-test", flushDir, FEATURE);
      aud.record(makeEntry({ prompt: "first" }));
      aud.record(makeEntry({ prompt: "second" }));
      await aud.flush();
      expect(appendedData).toHaveLength(2);
      expect(JSON.parse(appendedData[0].trim()).prompt).toBe("first");
      expect(JSON.parse(appendedData[1].trim()).prompt).toBe("second");
      _promptAuditorDeps.appendLine = origAppend;
      _promptAuditorDeps.write = orig;
    });
  });

  test("flush() appends JSONL to <flushDir>/<featureName>/<runId>.jsonl", async () => {
    await withTempDir(async (dir) => {
      const flushDir = join(dir, "audit");
      let capturedPath = "";
      const origAppend = _promptAuditorDeps.appendLine;
      _promptAuditorDeps.appendLine = async (p: string) => { capturedPath = p; };
      const orig = _promptAuditorDeps.write;
      _promptAuditorDeps.write = async () => 0;
      const aud = new PromptAuditor("my-run", flushDir, FEATURE);
      aud.record(makeEntry());
      await aud.flush();
      expect(capturedPath).toBe(join(flushDir, FEATURE, "my-run.jsonl"));
      _promptAuditorDeps.appendLine = origAppend;
      _promptAuditorDeps.write = orig;
    });
  });

  test("flush() writes <ts>-<sessionName>.txt alongside JSONL for entries with sessionName", async () => {
    await withTempDir(async (dir) => {
      const flushDir = join(dir, "audit");
      const txtPaths: string[] = [];
      const origWrite = _promptAuditorDeps.write;
      const origAppend = _promptAuditorDeps.appendLine;
      _promptAuditorDeps.write = async (p: string) => { txtPaths.push(p); return 0; };
      _promptAuditorDeps.appendLine = async () => {};
      const aud = new PromptAuditor("my-run", flushDir, FEATURE);
      aud.record(makeEntry({ ts: 1234567890000, sessionName: "nax-abc12345-my-feature-us-000-run" }));
      await aud.flush();
      expect(txtPaths).toHaveLength(1);
      expect(txtPaths[0]).toBe(join(flushDir, FEATURE, "1234567890000-nax-abc12345-my-feature-us-000-run.txt"));
      _promptAuditorDeps.write = origWrite;
      _promptAuditorDeps.appendLine = origAppend;
    });
  });

  test("flush() txt content includes prompt and response separated by === RESPONSE ===", async () => {
    await withTempDir(async (dir) => {
      const flushDir = join(dir, "audit");
      let txtContent = "";
      const orig = _promptAuditorDeps.write;
      const origAppend = _promptAuditorDeps.appendLine;
      _promptAuditorDeps.write = async (p, d) => {
        if (p.endsWith(".txt")) txtContent = String(d);
        return 0;
      };
      _promptAuditorDeps.appendLine = async () => {};
      const aud = new PromptAuditor("my-run", flushDir, FEATURE);
      aud.record(makeEntry({ sessionName: "nax-abc-my-feature-us-000-run", prompt: "hello", response: "world" }));
      await aud.flush();
      expect(txtContent).toContain("hello");
      expect(txtContent).toContain("=== RESPONSE ===");
      expect(txtContent).toContain("world");
      _promptAuditorDeps.write = orig;
      _promptAuditorDeps.appendLine = origAppend;
    });
  });

  test("recordError() entries appear in JSONL but produce no txt file", async () => {
    await withTempDir(async (dir) => {
      const appends: string[] = [];
      const paths: string[] = [];
      const origAppend = _promptAuditorDeps.appendLine;
      const origWrite = _promptAuditorDeps.write;
      _promptAuditorDeps.appendLine = async (p: string, d: string) => { appends.push(d); };
      _promptAuditorDeps.write = async (p: string) => { paths.push(p); return 0; };
      const aud = new PromptAuditor("r-001", join(dir, "audit"), FEATURE);
      aud.recordError({ ts: Date.now(), runId: "r-001", agentName: "claude", errorCode: "TIMEOUT", durationMs: 50 });
      await aud.flush();
      expect(paths).toHaveLength(0);
      expect(appends).toHaveLength(1);
      const parsed = JSON.parse(appends[0].trim());
      expect(parsed.errorCode).toBe("TIMEOUT");
      _promptAuditorDeps.appendLine = origAppend;
      _promptAuditorDeps.write = origWrite;
    });
  });
});
