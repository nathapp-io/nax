import { describe, test, expect } from "bun:test";
import { PromptAuditor, _promptAuditorDeps, type PromptAuditEntry } from "../../../src/runtime/prompt-auditor";
import { withTempDir } from "../../helpers/temp";
import { join } from "node:path";

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
  test("flush() does nothing when no entries", async () => {
    const writes: string[] = [];
    const orig = _promptAuditorDeps.write;
    _promptAuditorDeps.write = async (p) => { writes.push(p); return 0; };
    const aud = new PromptAuditor("r-001", "/tmp/audit");
    await aud.flush();
    expect(writes).toHaveLength(0);
    _promptAuditorDeps.write = orig;
  });

  test("flush() writes one JSONL line per entry in insertion order", async () => {
    await withTempDir(async (dir) => {
      const flushDir = join(dir, "audit");
      let captured = "";
      const orig = _promptAuditorDeps.write;
      _promptAuditorDeps.write = async (_p, d) => { captured = String(d); return 0; };
      const aud = new PromptAuditor("r-test", flushDir);
      aud.record(makeEntry({ prompt: "first" }));
      aud.record(makeEntry({ prompt: "second" }));
      await aud.flush();
      const lines = captured.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).prompt).toBe("first");
      expect(JSON.parse(lines[1]).prompt).toBe("second");
      _promptAuditorDeps.write = orig;
    });
  });

  test("flush() writes to <flushDir>/<runId>.jsonl", async () => {
    await withTempDir(async (dir) => {
      const flushDir = join(dir, "audit");
      let capturedPath = "";
      const orig = _promptAuditorDeps.write;
      _promptAuditorDeps.write = async (p, _d) => { capturedPath = p; return 0; };
      const aud = new PromptAuditor("my-run", flushDir);
      aud.record(makeEntry());
      await aud.flush();
      expect(capturedPath).toBe(join(flushDir, "my-run.jsonl"));
      _promptAuditorDeps.write = orig;
    });
  });

  test("recordError() entries appear in flush output", async () => {
    await withTempDir(async (dir) => {
      let captured = "";
      const orig = _promptAuditorDeps.write;
      _promptAuditorDeps.write = async (_p, d) => { captured = String(d); return 0; };
      const aud = new PromptAuditor("r-001", join(dir, "audit"));
      aud.recordError({ ts: Date.now(), runId: "r-001", agentName: "claude", errorCode: "TIMEOUT", durationMs: 50 });
      await aud.flush();
      const parsed = JSON.parse(captured.trim());
      expect(parsed.errorCode).toBe("TIMEOUT");
      _promptAuditorDeps.write = orig;
    });
  });
});
