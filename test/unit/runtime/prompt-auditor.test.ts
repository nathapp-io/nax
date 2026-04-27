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
  test("flush() does nothing when no entries", async () => {
    const writes: string[] = [];
    const orig = _promptAuditorDeps.write;
    _promptAuditorDeps.write = async (p) => { writes.push(p); return 0; };
    const aud = new PromptAuditor("r-001", "/tmp/audit", FEATURE);
    await aud.flush();
    expect(writes).toHaveLength(0);
    _promptAuditorDeps.write = orig;
  });

  test("flush() writes one JSONL line per entry in insertion order", async () => {
    await withTempDir(async (dir) => {
      const flushDir = join(dir, "audit");
      // Entries without sessionName produce no txt files — only one JSONL write
      let capturedJsonl = "";
      const orig = _promptAuditorDeps.write;
      _promptAuditorDeps.write = async (p, d) => {
        if (p.endsWith(".jsonl")) capturedJsonl = String(d);
        return 0;
      };
      const aud = new PromptAuditor("r-test", flushDir, FEATURE);
      aud.record(makeEntry({ prompt: "first" }));
      aud.record(makeEntry({ prompt: "second" }));
      await aud.flush();
      const lines = capturedJsonl.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).prompt).toBe("first");
      expect(JSON.parse(lines[1]).prompt).toBe("second");
      _promptAuditorDeps.write = orig;
    });
  });

  test("flush() writes JSONL to <flushDir>/<featureName>/<runId>.jsonl", async () => {
    await withTempDir(async (dir) => {
      const flushDir = join(dir, "audit");
      let capturedPath = "";
      const orig = _promptAuditorDeps.write;
      _promptAuditorDeps.write = async (p, _d) => { capturedPath = p; return 0; };
      const aud = new PromptAuditor("my-run", flushDir, FEATURE);
      aud.record(makeEntry());
      await aud.flush();
      expect(capturedPath).toBe(join(flushDir, FEATURE, "my-run.jsonl"));
      _promptAuditorDeps.write = orig;
    });
  });

  test("flush() writes <ts>-<sessionName>.txt alongside JSONL for entries with sessionName", async () => {
    await withTempDir(async (dir) => {
      const flushDir = join(dir, "audit");
      const paths: string[] = [];
      const orig = _promptAuditorDeps.write;
      _promptAuditorDeps.write = async (p, _d) => { paths.push(p); return 0; };
      const aud = new PromptAuditor("my-run", flushDir, FEATURE);
      aud.record(makeEntry({ ts: 1234567890000, sessionName: "nax-abc12345-my-feature-us-000-run" }));
      await aud.flush();
      expect(paths).toHaveLength(2);
      expect(paths[0]).toBe(join(flushDir, FEATURE, "my-run.jsonl"));
      expect(paths[1]).toBe(join(flushDir, FEATURE, "1234567890000-nax-abc12345-my-feature-us-000-run.txt"));
      _promptAuditorDeps.write = orig;
    });
  });

  test("flush() txt content includes prompt and response separated by === RESPONSE ===", async () => {
    await withTempDir(async (dir) => {
      const flushDir = join(dir, "audit");
      let txtContent = "";
      const orig = _promptAuditorDeps.write;
      _promptAuditorDeps.write = async (p, d) => {
        if (p.endsWith(".txt")) txtContent = String(d);
        return 0;
      };
      const aud = new PromptAuditor("my-run", flushDir, FEATURE);
      aud.record(makeEntry({ sessionName: "nax-abc-my-feature-us-000-run", prompt: "hello", response: "world" }));
      await aud.flush();
      expect(txtContent).toContain("hello");
      expect(txtContent).toContain("=== RESPONSE ===");
      expect(txtContent).toContain("world");
      _promptAuditorDeps.write = orig;
    });
  });

  test("recordError() entries appear in JSONL but produce no txt file", async () => {
    await withTempDir(async (dir) => {
      const paths: string[] = [];
      let captured = "";
      const orig = _promptAuditorDeps.write;
      _promptAuditorDeps.write = async (p, d) => { paths.push(p); captured = String(d); return 0; };
      const aud = new PromptAuditor("r-001", join(dir, "audit"), FEATURE);
      aud.recordError({ ts: Date.now(), runId: "r-001", agentName: "claude", errorCode: "TIMEOUT", durationMs: 50 });
      await aud.flush();
      expect(paths).toHaveLength(1);
      expect(paths[0]).toEndWith(".jsonl");
      const parsed = JSON.parse(captured.trim());
      expect(parsed.errorCode).toBe("TIMEOUT");
      _promptAuditorDeps.write = orig;
    });
  });

  test("flush() captures entries recorded during async write (in-flight buffer)", async () => {
    await withTempDir(async (dir) => {
      const flushDir = join(dir, "audit");
      const written: string[] = [];
      let resolveWrite!: (n: number) => void;
      const writePromise = new Promise<number>((r) => { resolveWrite = r; });
      const orig = _promptAuditorDeps.write;
      _promptAuditorDeps.write = async (_p, d) => { written.push(String(d)); return writePromise; };
      const aud = new PromptAuditor("r-test", flushDir, FEATURE);
      aud.record(makeEntry({ ts: 1000, prompt: "first" }));

      const flushTask = aud.flush();
      aud.record(makeEntry({ ts: 2000, prompt: "second" }));
      resolveWrite(0);
      await flushTask;

      // entries without sessionName → only JSONL writes (2 total: initial + merged)
      const jsonlWrites = written.filter((_, i) => i === 0 || i === 1);
      const allLines = jsonlWrites[1].trim().split("\n").filter(Boolean);
      expect(allLines).toHaveLength(2);
      expect(JSON.parse(allLines[0]).prompt).toBe("first");
      expect(JSON.parse(allLines[1]).prompt).toBe("second");
      _promptAuditorDeps.write = orig;
    });
  });

  test("flush() captures error entries recorded during async write", async () => {
    await withTempDir(async (dir) => {
      const flushDir = join(dir, "audit");
      const written: string[] = [];
      let resolveWrite!: (n: number) => void;
      const writePromise = new Promise<number>((r) => { resolveWrite = r; });
      const orig = _promptAuditorDeps.write;
      _promptAuditorDeps.write = async (_p, d) => { written.push(String(d)); return writePromise; };
      const aud = new PromptAuditor("r-test", flushDir, FEATURE);
      aud.record(makeEntry({ ts: 1000, prompt: "first" }));

      const flushTask = aud.flush();
      aud.recordError({ ts: 2000, runId: "r-test", agentName: "claude", errorCode: "TIMEOUT", durationMs: 50 });
      resolveWrite(0);
      await flushTask;

      // initial entry has no sessionName → JSONL only; error also JSONL only
      // written[1] is the merged JSONL re-write
      const allLines = written[1].trim().split("\n").filter(Boolean);
      expect(allLines).toHaveLength(2);
      expect(JSON.parse(allLines[1]).errorCode).toBe("TIMEOUT");
      _promptAuditorDeps.write = orig;
    });
  });
});
