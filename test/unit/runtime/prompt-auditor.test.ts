import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { _promptAuditorDeps, type PromptAuditEntry, PromptAuditor } from "@/runtime/prompt-auditor";

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
      _promptAuditorDeps.appendLine = async (_p: string, d: string) => {
        appendedLines.push(d);
      };
      const aud = new PromptAuditor("r-001", flushDir, FEATURE);
      aud.record(makeEntry({ prompt: "immediate" }));
      // Drain the queue deterministically — flush() awaits the chain head.
      await aud.flush();
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
    _promptAuditorDeps.write = async (p) => {
      writes.push(p);
      return 0;
    };
    _promptAuditorDeps.appendLine = async (p) => {
      appends.push(p);
    };
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
      _promptAuditorDeps.appendLine = async (_p: string, d: string) => {
        appendedData.push(d);
      };
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
      _promptAuditorDeps.appendLine = async (p: string) => {
        capturedPath = p;
      };
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

  test("flush() writes legacy session-style run filename alongside JSONL for entries with sessionName", async () => {
    await withTempDir(async (dir) => {
      const flushDir = join(dir, "audit");
      const txtPaths: string[] = [];
      const origWrite = _promptAuditorDeps.write;
      const origAppend = _promptAuditorDeps.appendLine;
      _promptAuditorDeps.write = async (p: string) => {
        txtPaths.push(p);
        return 0;
      };
      _promptAuditorDeps.appendLine = async () => {};
      const aud = new PromptAuditor("my-run", flushDir, FEATURE);
      aud.record(
        makeEntry({
          ts: 1234567890000,
          callType: "run",
          stage: "run",
          sessionName: "nax-abc12345-my-feature-us-000-implementer",
          roundTrips: 1,
        }),
      );
      await aud.flush();
      expect(txtPaths).toHaveLength(1);
      expect(txtPaths[0]).toBe(
        join(flushDir, FEATURE, "1234567890000-nax-abc12345-my-feature-us-000-implementer-run-t01.txt"),
      );
      _promptAuditorDeps.write = origWrite;
      _promptAuditorDeps.appendLine = origAppend;
    });
  });

  test("flush() writes legacy session-style complete filename for complete entries", async () => {
    await withTempDir(async (dir) => {
      const flushDir = join(dir, "audit");
      const txtPaths: string[] = [];
      const origWrite = _promptAuditorDeps.write;
      const origAppend = _promptAuditorDeps.appendLine;
      _promptAuditorDeps.write = async (p: string) => {
        txtPaths.push(p);
        return 0;
      };
      _promptAuditorDeps.appendLine = async () => {};
      const aud = new PromptAuditor("my-run", flushDir, FEATURE);
      aud.record(
        makeEntry({
          ts: 1234567890000,
          callType: "complete",
          stage: "acceptance",
          sessionName: "nax-abc12345-my-feature-us-000-refine",
        }),
      );
      await aud.flush();
      expect(txtPaths).toHaveLength(1);
      // US-002 AC1: a complete entry with a stage puts the stage into the
      // suffix — timestamp, session name, stage, then `complete`.
      expect(txtPaths[0]).toBe(
        join(flushDir, FEATURE, "1234567890000-nax-abc12345-my-feature-us-000-refine-acceptance-complete.txt"),
      );
      _promptAuditorDeps.write = origWrite;
      _promptAuditorDeps.appendLine = origAppend;
    });
  });

  // US-002 AC1: a complete audit entry with a session name and a stage writes
  // a file whose name ends with -<stage>-complete.txt.
  test("US-002 AC1: complete entry with stage acceptance produces -acceptance-complete.txt suffix", async () => {
    await withTempDir(async (dir) => {
      const flushDir = join(dir, "audit");
      const paths: string[] = [];
      const origWrite = _promptAuditorDeps.write;
      const origAppend = _promptAuditorDeps.appendLine;
      _promptAuditorDeps.write = async (p: string) => {
        paths.push(p);
        return 0;
      };
      _promptAuditorDeps.appendLine = async () => {};
      const aud = new PromptAuditor("r-002-ac1", flushDir, FEATURE);
      aud.record(
        makeEntry({
          ts: 1234567890000,
          callType: "complete",
          stage: "acceptance",
          sessionName: "nax-abc12345-my-feature-us-000-refine",
        }),
      );
      await aud.flush();
      expect(paths).toHaveLength(1);
      expect(paths[0]).toEndWith("-acceptance-complete.txt");
      _promptAuditorDeps.write = origWrite;
      _promptAuditorDeps.appendLine = origAppend;
    });
  });

  // US-002 AC2: a complete audit entry with a session name and NO stage writes
  // a file whose name ends with -complete.txt, with no empty segment before
  // that suffix. So no `-unknown-complete.txt` or similar fallback leakage.
  test("US-002 AC2: complete entry without stage produces bare -complete.txt suffix", async () => {
    await withTempDir(async (dir) => {
      const flushDir = join(dir, "audit");
      const paths: string[] = [];
      const origWrite = _promptAuditorDeps.write;
      const origAppend = _promptAuditorDeps.appendLine;
      _promptAuditorDeps.write = async (p: string) => {
        paths.push(p);
        return 0;
      };
      _promptAuditorDeps.appendLine = async () => {};
      const aud = new PromptAuditor("r-002-ac2", flushDir, FEATURE);
      aud.record(
        makeEntry({
          ts: 1234567890000,
          callType: "complete",
          sessionName: "nax-abc12345-my-feature-us-002-naked",
        }),
      );
      await aud.flush();
      expect(paths).toHaveLength(1);
      const name = paths[0];
      expect(name).toBeDefined();
      expect(name).toEndWith("-complete.txt");
      // No empty segment before -complete.txt — i.e. there must not be a
      // dangling "-.txt" or "-complete" left behind from a missing stage.
      // Strip the timestamp+sessionName+stage path components and assert.
      const basename = name?.split("/").pop();
      expect(basename).toBeDefined();
      const segments = basename?.split("-");
      expect(segments).toBeDefined();
      // last segment is "complete.txt", second-to-last is the bare "complete".
      expect(segments?.[segments.length - 1]).toBe("complete.txt");
      // The tail of segments must read "complete.txt" with no empty preceding
      // segment — i.e. there must not be a segment whose value is "".
      expect(segments?.every((s) => s.length > 0)).toBe(true);
      _promptAuditorDeps.write = origWrite;
      _promptAuditorDeps.appendLine = origAppend;
    });
  });

  // US-002 AC3: a run audit entry with stage run and turn 1 still produces
  // -run-t01.txt, preserving the existing run branch's suffix unchanged.
  test("US-002 AC3: run entry with stage run and turn 1 still produces -run-t01.txt suffix", async () => {
    await withTempDir(async (dir) => {
      const flushDir = join(dir, "audit");
      const paths: string[] = [];
      const origWrite = _promptAuditorDeps.write;
      const origAppend = _promptAuditorDeps.appendLine;
      _promptAuditorDeps.write = async (p: string) => {
        paths.push(p);
        return 0;
      };
      _promptAuditorDeps.appendLine = async () => {};
      const aud = new PromptAuditor("r-002-ac3", flushDir, FEATURE);
      aud.record(
        makeEntry({
          ts: 1234567890000,
          callType: "run",
          stage: "run",
          sessionName: "nax-abc12345-my-feature-us-002-implementer",
        }),
      );
      await aud.flush();
      expect(paths).toHaveLength(1);
      expect(paths[0]).toEndWith("-run-t01.txt");
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

  test("record() redacts secrets embedded in prompt/response before writing JSONL and txt", async () => {
    await withTempDir(async (dir) => {
      const flushDir = join(dir, "audit");
      let jsonlLine = "";
      let txtContent = "";
      const origAppend = _promptAuditorDeps.appendLine;
      const origWrite = _promptAuditorDeps.write;
      _promptAuditorDeps.appendLine = async (_p, d) => {
        jsonlLine = d;
      };
      _promptAuditorDeps.write = async (p, d) => {
        if (p.endsWith(".txt")) txtContent = String(d);
        return 0;
      };
      const aud = new PromptAuditor("r-secret", flushDir, FEATURE);
      aud.record(
        makeEntry({
          sessionName: "nax-abc-my-feature-us-000-run",
          prompt: "connect to postgres://admin:s3cret@db.internal:5432/prod",
          response: "GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }),
      );
      await aud.flush();
      expect(jsonlLine).not.toContain("s3cret");
      expect(jsonlLine).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect(jsonlLine).toContain("[REDACTED]");
      expect(txtContent).not.toContain("s3cret");
      expect(txtContent).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect(txtContent).toContain("[REDACTED]");
      _promptAuditorDeps.appendLine = origAppend;
      _promptAuditorDeps.write = origWrite;
    });
  });

  describe("interactions (issue #1226)", () => {
    test("appends an === INTERACTIONS === section with question, reply, and turn index", async () => {
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
        aud.record(
          makeEntry({
            sessionName: "nax-abc-my-feature-us-004-implementer",
            callType: "run",
            stage: "run",
            roundTrips: 2,
            prompt: "outer prompt",
            response: "the user wants me to raise an escalation",
            interactions: [
              {
                turnIndex: 2,
                question: "fix the test fixture or accept 15/17?",
                reply: "please raise the testEditDeclaration to escalation to test-writer",
              },
            ],
          }),
        );
        await aud.flush();
        expect(txtContent).toContain("=== INTERACTIONS ===");
        expect(txtContent).toContain("fix the test fixture or accept 15/17?");
        expect(txtContent).toContain("please raise the testEditDeclaration to escalation to test-writer");
        // Correlatable to the enclosing round-trip index (AC3).
        expect(txtContent).toContain("turn 2");
        // Existing prompt/response content remains intact.
        expect(txtContent).toContain("outer prompt");
        expect(txtContent).toContain("=== RESPONSE ===");
        _promptAuditorDeps.write = orig;
        _promptAuditorDeps.appendLine = origAppend;
      });
    });

    test("no === INTERACTIONS === section when entry has no interactions (existing output unchanged)", async () => {
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
        aud.record(
          makeEntry({ sessionName: "nax-abc-my-feature-us-004-implementer", prompt: "hello", response: "world" }),
        );
        await aud.flush();
        expect(txtContent).not.toContain("=== INTERACTIONS ===");
        _promptAuditorDeps.write = orig;
        _promptAuditorDeps.appendLine = origAppend;
      });
    });

    test("interactions are serialized into the JSONL line", async () => {
      await withTempDir(async (dir) => {
        const flushDir = join(dir, "audit");
        const appended: string[] = [];
        const origAppend = _promptAuditorDeps.appendLine;
        const orig = _promptAuditorDeps.write;
        _promptAuditorDeps.appendLine = async (_p: string, d: string) => {
          appended.push(d);
        };
        _promptAuditorDeps.write = async () => 0;
        const aud = new PromptAuditor("my-run", flushDir, FEATURE);
        aud.record(
          makeEntry({
            sessionName: "nax-abc-my-feature-us-004-implementer",
            interactions: [{ turnIndex: 1, question: "Q?", reply: "A." }],
          }),
        );
        await aud.flush();
        expect(appended).toHaveLength(1);
        const parsed = JSON.parse(appended[0].trim());
        expect(parsed.interactions).toEqual([{ turnIndex: 1, question: "Q?", reply: "A." }]);
        _promptAuditorDeps.appendLine = origAppend;
        _promptAuditorDeps.write = orig;
      });
    });
  });

  describe("deriveTxtFilename fallback (no sessionName)", () => {
    test("uses <ts>-<callType>-<stage>-<storyId>.txt when all fields present", async () => {
      await withTempDir(async (dir) => {
        const paths: string[] = [];
        const origWrite = _promptAuditorDeps.write;
        const origAppend = _promptAuditorDeps.appendLine;
        _promptAuditorDeps.write = async (p: string) => {
          paths.push(p);
          return 0;
        };
        _promptAuditorDeps.appendLine = async () => {};
        const aud = new PromptAuditor("r-001", join(dir, "audit"), FEATURE);
        aud.record(makeEntry({ ts: 1777301912062, callType: "complete", stage: "acceptance", storyId: "US-001" }));
        await aud.flush();
        expect(paths).toHaveLength(1);
        expect(paths[0]).toEndWith("1777301912062-complete-acceptance-US-001.txt");
        _promptAuditorDeps.write = origWrite;
        _promptAuditorDeps.appendLine = origAppend;
      });
    });

    test("omits storyId segment when storyId absent", async () => {
      await withTempDir(async (dir) => {
        const paths: string[] = [];
        const origWrite = _promptAuditorDeps.write;
        const origAppend = _promptAuditorDeps.appendLine;
        _promptAuditorDeps.write = async (p: string) => {
          paths.push(p);
          return 0;
        };
        _promptAuditorDeps.appendLine = async () => {};
        const aud = new PromptAuditor("r-001", join(dir, "audit"), FEATURE);
        aud.record(makeEntry({ ts: 1777301880073, callType: "complete", stage: "acceptance" }));
        await aud.flush();
        expect(paths).toHaveLength(1);
        expect(paths[0]).toEndWith("1777301880073-complete-acceptance.txt");
        _promptAuditorDeps.write = origWrite;
        _promptAuditorDeps.appendLine = origAppend;
      });
    });

    test("writes txt even when response is empty (e.g. crashed regen)", async () => {
      await withTempDir(async (dir) => {
        const writes: Array<[string, string]> = [];
        const origWrite = _promptAuditorDeps.write;
        const origAppend = _promptAuditorDeps.appendLine;
        _promptAuditorDeps.write = async (p: string, d: string) => {
          writes.push([p, String(d)]);
          return 0;
        };
        _promptAuditorDeps.appendLine = async () => {};
        const aud = new PromptAuditor("r-001", join(dir, "audit"), FEATURE);
        aud.record(
          makeEntry({
            ts: 1777302229409,
            callType: "complete",
            stage: "acceptance",
            prompt: "Generate tests",
            response: "",
          }),
        );
        await aud.flush();
        expect(writes).toHaveLength(1);
        expect(writes[0][0]).toEndWith("1777302229409-complete-acceptance.txt");
        expect(writes[0][1]).toContain("Generate tests");
        _promptAuditorDeps.write = origWrite;
        _promptAuditorDeps.appendLine = origAppend;
      });
    });
  });

  test("write failure does not break the queue — subsequent entries still write", async () => {
    await withTempDir(async (dir) => {
      const appends: string[] = [];
      const origAppend = _promptAuditorDeps.appendLine;
      let calls = 0;
      _promptAuditorDeps.appendLine = async (_p: string, d: string) => {
        calls++;
        if (calls === 1) {
          const err = new Error("disk full") as NodeJS.ErrnoException;
          err.code = "ENOSPC";
          err.errno = -28;
          err.syscall = "write";
          throw err;
        }
        appends.push(d);
      };
      const aud = new PromptAuditor("r-001", join(dir, "audit"), FEATURE);
      aud.record(makeEntry({ ts: 1, prompt: "first (will fail)" }));
      aud.record(makeEntry({ ts: 2, prompt: "second (should succeed)" }));
      await aud.flush();
      expect(appends).toHaveLength(1);
      expect(appends[0]).toContain("second");
      _promptAuditorDeps.appendLine = origAppend;
    });
  });

  test("txt-phase failure does not block JSONL — JSONL line is still persisted", async () => {
    await withTempDir(async (dir) => {
      const appends: string[] = [];
      const origAppend = _promptAuditorDeps.appendLine;
      const origWrite = _promptAuditorDeps.write;
      _promptAuditorDeps.appendLine = async (_p: string, d: string) => {
        appends.push(d);
      };
      _promptAuditorDeps.write = async () => {
        throw new Error("txt write failed");
      };
      const aud = new PromptAuditor("r-001", join(dir, "audit"), FEATURE);
      aud.record(makeEntry({ ts: 100, prompt: "txt-fail" }));
      await aud.flush();
      // JSONL was appended before txt write was attempted.
      expect(appends).toHaveLength(1);
      expect(appends[0]).toContain("txt-fail");
      _promptAuditorDeps.appendLine = origAppend;
      _promptAuditorDeps.write = origWrite;
    });
  });

  test("recordError() entries appear in JSONL but produce no txt file", async () => {
    await withTempDir(async (dir) => {
      const appends: string[] = [];
      const paths: string[] = [];
      const origAppend = _promptAuditorDeps.appendLine;
      const origWrite = _promptAuditorDeps.write;
      _promptAuditorDeps.appendLine = async (_p: string, d: string) => {
        appends.push(d);
      };
      _promptAuditorDeps.write = async (p: string) => {
        paths.push(p);
        return 0;
      };
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

  test("a first turn renders as t01 regardless of its round-trip count", async () => {
    await withTempDir(async (dir) => {
      const written: Array<{ path: string; data: string }> = [];
      const orig = _promptAuditorDeps.write;
      _promptAuditorDeps.write = async (path: string, data: string) => {
        written.push({ path, data });
        return 0;
      };
      const aud = new PromptAuditor("r-001", join(dir, "audit"), FEATURE);
      aud.record(makeEntry({ callType: "run", sessionName: "sess-a", stage: "run", roundTrips: 4 }));
      await aud.flush();
      _promptAuditorDeps.write = orig;
      const txt = written.find((w) => w.path.endsWith(".txt"));
      expect(txt?.path).toContain("-run-t01.txt");
      expect(txt?.data).toContain("Turn:       1");
    });
  });

  test("numbers turns sequentially within one recordId, across differing session names", async () => {
    await withTempDir(async (dir) => {
      const written: Array<{ path: string; data: string }> = [];
      const orig = _promptAuditorDeps.write;
      _promptAuditorDeps.write = async (path: string, data: string) => {
        written.push({ path, data });
        return 0;
      };
      const aud = new PromptAuditor("r-001", join(dir, "audit"), FEATURE);
      // Same logical conversation, different display names and stages — this is
      // the run -> rectification case. Keying on sessionName would restart at 1.
      aud.record(makeEntry({ callType: "run", sessionName: "sess-a", stage: "run", recordId: "rec-1", roundTrips: 4 }));
      aud.record(makeEntry({ callType: "run", sessionName: "sess-a", stage: "run", recordId: "rec-1", roundTrips: 1 }));
      aud.record(
        makeEntry({ callType: "run", sessionName: "sess-b", stage: "rectification", recordId: "rec-1", roundTrips: 1 }),
      );
      await aud.flush();
      _promptAuditorDeps.write = orig;
      const txts = written.filter((w) => w.path.endsWith(".txt"));
      expect(txts[0]?.path).toContain("-run-t01.txt");
      expect(txts[1]?.path).toContain("-run-t02.txt");
      expect(txts[2]?.path).toContain("-rectification-t03.txt");
      expect(txts[0]?.data).toContain("Turn:       1");
      expect(txts[2]?.data).toContain("Turn:       3");
    });
  });

  test("a different recordId restarts the numbering", async () => {
    await withTempDir(async (dir) => {
      const written: Array<{ path: string; data: string }> = [];
      const orig = _promptAuditorDeps.write;
      _promptAuditorDeps.write = async (path: string, data: string) => {
        written.push({ path, data });
        return 0;
      };
      const aud = new PromptAuditor("r-001", join(dir, "audit"), FEATURE);
      aud.record(makeEntry({ callType: "run", sessionName: "sess-a", recordId: "rec-1", roundTrips: 1 }));
      aud.record(makeEntry({ callType: "run", sessionName: "sess-a", recordId: "rec-2", roundTrips: 1 }));
      await aud.flush();
      _promptAuditorDeps.write = orig;
      const txts = written.filter((w) => w.path.endsWith(".txt"));
      expect(txts[0]?.data).toContain("Turn:       1");
      expect(txts[1]?.data).toContain("Turn:       1");
    });
  });

  test("falls back to sessionName when no recordId is present", async () => {
    await withTempDir(async (dir) => {
      const written: Array<{ path: string; data: string }> = [];
      const orig = _promptAuditorDeps.write;
      _promptAuditorDeps.write = async (path: string, data: string) => {
        written.push({ path, data });
        return 0;
      };
      const aud = new PromptAuditor("r-001", join(dir, "audit"), FEATURE);
      aud.record(makeEntry({ callType: "run", sessionName: "sess-a", roundTrips: 1 }));
      aud.record(makeEntry({ callType: "run", sessionName: "sess-a", roundTrips: 1 }));
      await aud.flush();
      _promptAuditorDeps.write = orig;
      const txts = written.filter((w) => w.path.endsWith(".txt"));
      expect(txts[1]?.data).toContain("Turn:       2");
    });
  });

  test("renders the round-trip count under a label naming its unit", async () => {
    await withTempDir(async (dir) => {
      const written: Array<{ path: string; data: string }> = [];
      const orig = _promptAuditorDeps.write;
      _promptAuditorDeps.write = async (path: string, data: string) => {
        written.push({ path, data });
        return 0;
      };
      const aud = new PromptAuditor("r-001", join(dir, "audit"), FEATURE);
      aud.record(
        makeEntry({ callType: "run", sessionName: "n", recordId: "r-n", roundTrips: 8, roundTripUnit: "model-call" }),
      );
      aud.record(
        makeEntry({ callType: "run", sessionName: "a", recordId: "r-a", roundTrips: 2, roundTripUnit: "agent-run" }),
      );
      await aud.flush();
      _promptAuditorDeps.write = orig;
      const txts = written.filter((w) => w.path.endsWith(".txt"));
      expect(txts[0]?.data).toContain("ModelCalls: 8");
      expect(txts[0]?.data).not.toContain("AgentRuns:");
      expect(txts[1]?.data).toContain("AgentRuns:  2");
      expect(txts[1]?.data).not.toContain("ModelCalls:");
    });
  });
});
