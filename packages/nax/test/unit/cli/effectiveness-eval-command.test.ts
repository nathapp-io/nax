/**
 * US-001: `nax context effectiveness eval` — CLI command tests
 *
 * Mirrors the CLI-level ACs (AC10-AC15):
 *  AC10 — fixture-meets-baseline path → exit 0
 *  AC11 — nonexistent labels path → exit 2, stderr names the path
 *  AC12 — unreadable labels file → exit 2, stderr states the read failure
 *  AC13 — schema-invalid labels file → exit 2, stderr names the reason, no partial scoring
 *  AC14 — --json: stdout is one parseable object, no table rows
 *
 * Per-case resilience (AC15) lives with the `scoreEffectiveness` unit tests
 * in `test/unit/context/engine/effectiveness-eval.test.ts` because it is
 * exercised at the scorer level; the CLI just propagates the report.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { _effectivenessEvalDeps, effectivenessEvalCommand, formatEffectivenessReport } from "@/cli";
import { type LabelCase, loadLabelSet } from "@/context/engine/effectiveness-eval";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Path to the committed synthetic fixture, used by AC10 and AC14. */
const COMMITTED_FIXTURE = join(import.meta.dir, "..", "..", "fixtures", "effectiveness", "labels.sample.json");

interface CapturedStreams {
  stdout: string[];
  stderr: string[];
}

function captureStreams(): { streams: CapturedStreams; restore: () => void } {
  const streams: CapturedStreams = { stdout: [], stderr: [] };
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => streams.stdout.push(args.map((a) => String(a)).join(" "));
  console.error = (...args: unknown[]) => streams.stderr.push(args.map((a) => String(a)).join(" "));
  return {
    streams,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

/** Write a labels JSON file with the given body to the temp dir. */
function writeLabelsFile(dir: string, fileName: string, body: unknown): string {
  const path = join(dir, fileName);
  writeFileSync(path, JSON.stringify(body), "utf8");
  return path;
}

function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
  return s.replace(/\x1B\[[0-9;]*m/g, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// AC11 — nonexistent labels path → exit 2 + stderr names the path
// ─────────────────────────────────────────────────────────────────────────────

describe("effectivenessEvalCommand (AC11)", () => {
  let exitMock: { exit: typeof process.exit };
  let originalProcessExit: typeof process.exit;

  beforeEach(() => {
    originalProcessExit = process.exit;
    const exitFn = mock((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    exitMock = { exit: exitFn as typeof process.exit };
    process.exit = exitMock.exit;
  });

  afterEach(() => {
    process.exit = originalProcessExit;
    mock.restore();
  });

  test("[AC11] exits 2 when the labels path does not exist", async () => {
    const { streams, restore } = captureStreams();
    let exitCode = -1;
    const exitSpy = mock((code?: number | string | null) => {
      exitCode = typeof code === "number" ? code : 0;
      throw new Error(`process.exit(${code})`);
    });
    exitMock.exit = exitSpy as typeof process.exit;
    process.exit = exitMock.exit;
    try {
      await withTempDir(async (dir) => {
        const phantom = join(dir, "does-not-exist.json");
        try {
          await effectivenessEvalCommand({ labels: phantom, dir });
        } catch (_err) {
          // The command calls process.exit(2) on missing-path; let the mock catch it.
        }
        expect(exitCode).toBe(2);
        const stderrJoined = streams.stderr.join("\n");
        expect(stderrJoined).toContain(phantom);
      });
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC12 — unreadable labels file → exit 2 + stderr states the read failure
// ─────────────────────────────────────────────────────────────────────────────

describe("effectivenessEvalCommand (AC12)", () => {
  let originalProcessExit: typeof process.exit;

  beforeEach(() => {
    originalProcessExit = process.exit;
  });

  afterEach(() => {
    process.exit = originalProcessExit;
    mock.restore();
  });

  test("[AC12] exits 2 when the labels file cannot be read, stderr states the read failure", async () => {
    const { streams, restore } = captureStreams();
    let exitCode = -1;
    process.exit = mock((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;

    try {
      await withTempDir(async (dir) => {
        const path = join(dir, "labels.json");
        // Override readLabels to throw a realistic read failure.
        const originalReadLabels = _effectivenessEvalDeps.readLabels;
        _effectivenessEvalDeps.readLabels = async () => {
          throw new Error("EACCES: permission denied");
        };
        try {
          // Make the file exist so the existence check passes; the read
          // failure then triggers AC12.
          mkdirSync(dir, { recursive: true });
          writeFileSync(path, "{}", "utf8");
          try {
            await effectivenessEvalCommand({ labels: path, dir });
          } catch {
            // Swallowed; we asserted the mock's captured exit code.
          }
          expect(exitCode).toBe(2);
          const stderrJoined = streams.stderr.join("\n");
          // Stderr must state the read failure (not the path) — the AC
          // distinguishes "file missing" (AC11) from "file unreadable"
          // (AC12) by the message.
          expect(stderrJoined.toLowerCase()).toMatch(/read|permission|eacces|denied/);
        } finally {
          _effectivenessEvalDeps.readLabels = originalReadLabels;
        }
      });
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC13 — schema-invalid labels file → exit 2 + stderr names the reason, no partial scoring
// ─────────────────────────────────────────────────────────────────────────────

describe("effectivenessEvalCommand (AC13)", () => {
  let originalProcessExit: typeof process.exit;

  beforeEach(() => {
    originalProcessExit = process.exit;
  });

  afterEach(() => {
    process.exit = originalProcessExit;
    mock.restore();
  });

  test("[AC13] exits 2 on schema-invalid labels, stderr names the reason, no partial scoring output", async () => {
    const { streams, restore } = captureStreams();
    let exitCode = -1;
    process.exit = mock((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;

    try {
      await withTempDir(async (dir) => {
        const path = writeLabelsFile(dir, "bad.json", { version: 1, cases: "not-an-array" });

        // Override the deps so the file reads but the validator will reject it.
        const originalReadLabels = _effectivenessEvalDeps.readLabels;
        _effectivenessEvalDeps.readLabels = async (p: string) => {
          // Read the file content via Bun for realism
          return await Bun.file(p).text();
        };
        try {
          try {
            await effectivenessEvalCommand({ labels: path, dir });
          } catch {
            // The mock exits; we assert against the captured code.
          }
          expect(exitCode).toBe(2);
          const stderrJoined = streams.stderr.join("\n");
          // AC13: stderr must name the validation reason (not the file path).
          // The reason contains the field name; a generic "invalid" is acceptable.
          expect(stderrJoined.toLowerCase()).toMatch(/invalid|schema|validation|cases/);
          // No partial score: stdout must NOT contain a parseable EvalReport.
          const stdoutJoined = streams.stdout.join("\n");
          const stripped = stripAnsi(stdoutJoined);
          const parsed = safeParseJson(stripped);
          // The command must not have written a partial report to stdout.
          expect(parsed).toBeNull();
        } finally {
          _effectivenessEvalDeps.readLabels = originalReadLabels;
        }
      });
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC14 — --json: stdout is one parseable object, no table rows
// ─────────────────────────────────────────────────────────────────────────────

describe("effectivenessEvalCommand (AC14)", () => {
  let originalProcessExit: typeof process.exit;

  beforeEach(() => {
    originalProcessExit = process.exit;
  });

  afterEach(() => {
    process.exit = originalProcessExit;
    mock.restore();
  });

  test("[AC14] with --json, stdout is one parseable object including perSignal and sizeCorrelation", async () => {
    const { streams, restore } = captureStreams();
    try {
      await withTempDir(async (_dir) => {
        // Stub the deps so we can drive the command end-to-end without
        // running the real classifier. The implementer will wire these
        // to the production loader and scorer.
        const originalReadLabels = _effectivenessEvalDeps.readLabels;
        _effectivenessEvalDeps.readLabels = async (_p: string) =>
          JSON.stringify({
            version: 1,
            cases: [
              {
                caseId: "c1",
                chunkId: "x",
                chunkSummary: "summary",
                diffText: "diff",
                label: "followed",
              },
            ],
          });
        try {
          await effectivenessEvalCommand({ labels: COMMITTED_FIXTURE, json: true, dir: _dir });
        } catch {
          // Stub always returns -1; we still check stdout for the would-be JSON.
        } finally {
          _effectivenessEvalDeps.readLabels = originalReadLabels;
        }

        const stdout = streams.stdout.join("\n").trim();
        const parsed = safeParseJson(stdout);
        // AC14: stdout MUST be one parseable object. The stub currently
        // writes a log line, not JSON, so this assertion fails for the
        // right reason.
        expect(parsed).not.toBeNull();
        expect(typeof parsed).toBe("object");
        expect(Array.isArray(parsed)).toBe(false);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          expect(parsed).toHaveProperty("perSignal");
          expect(parsed).toHaveProperty("sizeCorrelation");
        }
      });
    } finally {
      restore();
    }
  });

  test("[AC14] with --json, stdout contains no table rows (no pipe-aligned numeric columns)", async () => {
    const { streams, restore } = captureStreams();
    try {
      await withTempDir(async (_dir) => {
        const originalReadLabels = _effectivenessEvalDeps.readLabels;
        _effectivenessEvalDeps.readLabels = async (_p: string) =>
          JSON.stringify({
            version: 1,
            cases: [
              {
                caseId: "c1",
                chunkId: "x",
                chunkSummary: "summary",
                diffText: "diff",
                label: "followed",
              },
            ],
          });
        try {
          await effectivenessEvalCommand({ labels: COMMITTED_FIXTURE, json: true, dir: _dir });
        } catch {
          // Stub returns -1; we still check the absence of table rows.
        } finally {
          _effectivenessEvalDeps.readLabels = originalReadLabels;
        }

        const stdout = streams.stdout.join("\n");
        // The human-readable table header is "signal       precision  recall     f1".
        // --json must not emit that header.
        expect(stdout).not.toMatch(/signal\s+precision\s+recall/);
      });
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC10 — fixture-meets-baseline → exit 0
// ─────────────────────────────────────────────────────────────────────────────

describe("effectivenessEvalCommand (AC10)", () => {
  test("[AC10] exits 0 with the committed fixture when the classifier meets every baseline threshold", async () => {
    // This test is integration-level: it requires a real classifier wired
    // into the harness. Until the implementer wires the stub to a real
    // `scoreEffectiveness` and the AC6 baseline, the stub returns -1 and
    // this test fails — which is the point.
    let exitCode = -1;
    const originalProcessExit = process.exit;
    process.exit = mock((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
    try {
      try {
        const result = await effectivenessEvalCommand({ labels: COMMITTED_FIXTURE });
        // If the command returned rather than exiting, use that.
        if (result !== undefined) exitCode = result;
      } catch {
        // The mock exit threw; we asserted above.
      }
      expect(exitCode).toBe(0);
    } finally {
      process.exit = originalProcessExit;
      mock.restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatEffectivenessReport — pure formatter contract
// ─────────────────────────────────────────────────────────────────────────────

describe("formatEffectivenessReport", () => {
  test("returns a string array with at least 4 lines (header + 3 signal rows + baseline + size)", () => {
    const report = {
      perSignal: {
        followed: { precision: 0.8, recall: 0.7, f1: 0.74 },
        ignored: { precision: 0.6, recall: 0.5, f1: 0.55 },
        contradicted: { precision: 0.4, recall: 0.3, f1: 0.34 },
      },
      baseline: { precision: 0.2, recall: 1.0, f1: 0.33 },
      sizeCorrelation: 0.1,
      scoredCount: 4,
      excludedCount: 1,
    };
    const lines = formatEffectivenessReport(report);
    expect(Array.isArray(lines)).toBe(true);
    // The stub returns ["not implemented"] (1 line). The real formatter
    // emits a header row + three signal rows + a baseline row + a
    // size-correlation row — at least 4 lines.
    expect(lines.length).toBeGreaterThanOrEqual(4);
  });

  test("table output includes 'signal', 'precision', 'recall', 'f1' headers", () => {
    const report = {
      perSignal: {
        followed: { precision: 0.8, recall: 0.7, f1: 0.74 },
        ignored: { precision: 0.6, recall: 0.5, f1: 0.55 },
        contradicted: { precision: 0.4, recall: 0.3, f1: 0.34 },
      },
      baseline: { precision: 0.2, recall: 1.0, f1: 0.33 },
      sizeCorrelation: 0.1,
      scoredCount: 4,
      excludedCount: 1,
    };
    const lines = formatEffectivenessReport(report).map(stripAnsi);
    const joined = lines.join("\n").toLowerCase();
    expect(joined).toContain("signal");
    expect(joined).toContain("precision");
    expect(joined).toContain("recall");
    expect(joined).toContain("f1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003 AC14 — `nax context effectiveness eval` invokes the scoreEffectiveness
// seam exactly once with the fixture's full case list. This test stubs the
// `_effectivenessEvalDeps.scoreEffectiveness` seam so the CLI's call is
// observable without depending on the real classifier.
// ─────────────────────────────────────────────────────────────────────────────

describe("effectivenessEvalCommand (US-003 AC14)", () => {
  let originalProcessExit: typeof process.exit;

  beforeEach(() => {
    originalProcessExit = process.exit;
  });

  afterEach(() => {
    process.exit = originalProcessExit;
    mock.restore();
  });

  test("[AC14] invokes the scoreEffectiveness seam exactly once with the fixture's full case list", async () => {
    let capturedCases: readonly LabelCase[] = [];
    let callCount = 0;
    const originalScore = _effectivenessEvalDeps.scoreEffectiveness;
    _effectivenessEvalDeps.scoreEffectiveness = (cases, _classifier) => {
      callCount++;
      capturedCases = cases;
      return {
        perSignal: {
          followed: { precision: 1, recall: 1, f1: 1 },
          ignored: { precision: 1, recall: 1, f1: 1 },
          contradicted: { precision: 1, recall: 1, f1: 1 },
        },
        baseline: { precision: 1, recall: 1, f1: 1 },
        sizeCorrelation: 0,
        scoredCount: cases.length,
        excludedCount: 0,
      };
    };

    process.exit = mock(() => {
      throw new Error("process.exit");
    }) as typeof process.exit;

    try {
      try {
        await effectivenessEvalCommand({ labels: COMMITTED_FIXTURE });
      } catch {
        // The stub returns a perfect report; the CLI will exit 0. The mock
        // exit throws regardless — we only care about the captured calls.
      }
    } finally {
      _effectivenessEvalDeps.scoreEffectiveness = originalScore;
    }

    expect(callCount).toBe(1);

    // The captured cases must equal the committed fixture's case list, in
    // the same order — the seam must not filter, slice, or reorder.
    const raw = await Bun.file(COMMITTED_FIXTURE).text();
    const labelSet = loadLabelSet(raw);
    expect(capturedCases.length).toBe(labelSet.cases.length);
    for (let i = 0; i < capturedCases.length; i++) {
      expect(capturedCases[i].caseId).toBe(labelSet.cases[i].caseId);
    }
  });

  test("[AC14, boundary] does not invoke scoreEffectiveness when the labels path is missing (read fails before scoring)", async () => {
    let callCount = 0;
    const originalScore = _effectivenessEvalDeps.scoreEffectiveness;
    _effectivenessEvalDeps.scoreEffectiveness = (() => {
      callCount++;
      return {
        perSignal: {
          followed: { precision: 0, recall: 0, f1: 0 },
          ignored: { precision: 0, recall: 0, f1: 0 },
          contradicted: { precision: 0, recall: 0, f1: 0 },
        },
        baseline: { precision: 0, recall: 0, f1: 0 },
        sizeCorrelation: 0,
        scoredCount: 0,
        excludedCount: 0,
      };
    }) as typeof _effectivenessEvalDeps.scoreEffectiveness;

    process.exit = mock(() => {
      throw new Error("process.exit");
    }) as typeof process.exit;

    try {
      try {
        await effectivenessEvalCommand({ labels: "/nonexistent/labels.json" });
      } catch {
        // expected — process.exit mocked
      }
    } finally {
      _effectivenessEvalDeps.scoreEffectiveness = originalScore;
    }

    // The seam must not have been called — the missing-path exit fires
    // before any scoring happens.
    expect(callCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — JSON parsing (tolerant of stray log lines around the report)
// ─────────────────────────────────────────────────────────────────────────────

function safeParseJson(s: string): unknown | null {
  const trimmed = s.trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Try to extract the first {...} block.
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    const candidate = trimmed.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }
}
