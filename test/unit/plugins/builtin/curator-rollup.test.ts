/**
 * Curator Rollup Tests
 *
 * Tests for append-only rollup functionality and the shared JSONL line
 * reader both rollup readers stream through (#1439).
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { assertDefined, withTempDir } from "@test/helpers";
import { type Observation, streamJsonlLines } from "@/plugins/builtin/curator";
import type { CuratorThresholds } from "@/plugins/builtin/curator/heuristics";
import { runHeuristics } from "@/plugins/builtin/curator/heuristics";
import { appendToRollup } from "@/plugins/builtin/curator/rollup";

describe("appendToRollup", () => {
  const baseObservation: Observation = {
    schemaVersion: 1,
    projectKey: "test-proj",
    runId: "run-1",
    featureId: "feat-1",
    storyId: "story-1",
    stage: "review",
    ts: "2026-05-04T00:00:00Z",
    kind: "review-finding",
    payload: {
      ruleId: "rule1",
      severity: "error",
      file: "src/index.ts",
      line: 10,
      message: "test error",
    },
  };

  test("creates parent directory if it does not exist", async () => {
    await withTempDir(async (dir) => {
      const rollupPath = path.join(dir, "curator", "nested", "rollup.jsonl");
      const obs: Observation[] = [baseObservation];

      await appendToRollup(obs, rollupPath);

      const file = Bun.file(rollupPath);
      expect(await file.exists()).toBe(true);
    });
  });

  // RACE-46 (D-29): concurrent appendToRollup() vs pruneRollup() used to
  // lose observations appended between GC's read pass and its
  // rename(tmpPath, rollupPath). The shared path-file-lock serializes
  // them; an interleaved append must land AFTER the rename completes
  // (so on the new inode), not get destroyed by it.
  test("RACE-46: appendToRollup does not leave a stale lock candidate behind", async () => {
    await withTempDir(async (dir) => {
      const rollupPath = path.join(dir, "rollup.jsonl");
      await appendToRollup([baseObservation], rollupPath);

      // After the call, no lock candidate must remain — the lock is
      // released in its `finally` block on the success path.
      const entries = await Array.fromAsync(new Bun.Glob(`${"rollup.jsonl"}.lock.*`).scan({ cwd: dir }));
      expect(entries.length).toBe(0);

      // Subsequent calls still work (lock isn't held by a zombie).
      await appendToRollup([baseObservation], rollupPath);
      const content = await Bun.file(rollupPath).text();
      expect(content.split("\n").filter((l) => l.trim()).length).toBe(2);
    });
  });

  test("appends one JSON line per observation", async () => {
    await withTempDir(async (dir) => {
      const rollupPath = path.join(dir, "rollup.jsonl");

      const obs1: Observation[] = [baseObservation, { ...baseObservation, storyId: "story-2" }];
      await appendToRollup(obs1, rollupPath);

      const file = Bun.file(rollupPath);
      const text = await file.text();
      const lines = text.split("\n").filter((l) => l.trim());

      expect(lines).toHaveLength(2);
    });
  });

  test("preserves existing content on subsequent appends", async () => {
    await withTempDir(async (dir) => {
      const rollupPath = path.join(dir, "rollup.jsonl");

      const obs1: Observation[] = [baseObservation];
      await appendToRollup(obs1, rollupPath);

      const obs2: Observation[] = [{ ...baseObservation, storyId: "story-2" }];
      await appendToRollup(obs2, rollupPath);

      const file = Bun.file(rollupPath);
      const text = await file.text();
      const lines = text.split("\n").filter((l) => l.trim());

      expect(lines).toHaveLength(2);
    });
  });

  test("writes valid JSON lines", async () => {
    await withTempDir(async (dir) => {
      const rollupPath = path.join(dir, "rollup.jsonl");

      const obs: Observation[] = [baseObservation];
      await appendToRollup(obs, rollupPath);

      const file = Bun.file(rollupPath);
      const text = await file.text();
      const lines = text.split("\n").filter((l) => l.trim());

      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(parsed.schemaVersion).toBe(1);
        expect(parsed.runId).toBeDefined();
        expect(parsed.kind).toBeDefined();
      }
    });
  });

  test("preserves observation data in rollup", async () => {
    await withTempDir(async (dir) => {
      const rollupPath = path.join(dir, "rollup.jsonl");

      const obs: Observation[] = [
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-123",
          featureId: "feat-abc",
          storyId: "story-xyz",
          stage: "review",
          ts: "2026-05-04T10:30:00Z",
          kind: "review-finding",
          payload: {
            ruleId: "custom-rule",
            severity: "warning",
            file: "src/custom.ts",
            line: 42,
            message: "custom message",
          },
        },
      ];

      await appendToRollup(obs, rollupPath);

      const file = Bun.file(rollupPath);
      const text = await file.text();
      const line = text.trim();
      const parsed = JSON.parse(line);

      expect(parsed.runId).toBe("run-123");
      expect(parsed.featureId).toBe("feat-abc");
      expect(parsed.storyId).toBe("story-xyz");
      expect(parsed.payload.ruleId).toBe("custom-rule");
      expect(parsed.payload.message).toBe("custom message");
    });
  });

  test("handles empty observation array", async () => {
    await withTempDir(async (dir) => {
      const rollupPath = path.join(dir, "rollup.jsonl");

      await appendToRollup([], rollupPath);

      const file = Bun.file(rollupPath);
      const text = await file.text();

      expect(text).toBe("");
    });
  });

  test("handles multiple observations in single call", async () => {
    await withTempDir(async (dir) => {
      const rollupPath = path.join(dir, "rollup.jsonl");

      const obs: Observation[] = [
        baseObservation,
        {
          ...baseObservation,
          storyId: "story-2",
          kind: "chunk-included",
          payload: { chunkId: "c1", label: "chunk", tokens: 100 },
        },
        { ...baseObservation, storyId: "story-3", kind: "escalation", payload: { from: "fast", to: "balanced" } },
      ];

      await appendToRollup(obs, rollupPath);

      const file = Bun.file(rollupPath);
      const text = await file.text();
      const lines = text.split("\n").filter((l) => l.trim());

      expect(lines).toHaveLength(3);
    });
  });

  test("never throws on write errors (graceful failure)", async () => {
    // This is tricky to test without actually breaking I/O
    // For now, we test that normal operations don't throw
    await withTempDir(async (dir) => {
      const rollupPath = path.join(dir, "rollup.jsonl");
      const obs: Observation[] = [baseObservation];

      expect(async () => {
        await appendToRollup(obs, rollupPath);
      }).not.toThrow();
    });
  });

  test("appends to existing file without overwriting", async () => {
    await withTempDir(async (dir) => {
      const rollupPath = path.join(dir, "rollup.jsonl");

      const obs1: Observation[] = [{ ...baseObservation, runId: "run-first" }];
      await appendToRollup(obs1, rollupPath);

      const obs2: Observation[] = [{ ...baseObservation, runId: "run-second" }];
      await appendToRollup(obs2, rollupPath);

      const file = Bun.file(rollupPath);
      const text = await file.text();
      const lines = text.split("\n").filter((l) => l.trim());

      const firstRun = JSON.parse(lines[0]);
      const secondRun = JSON.parse(lines[1]);

      expect(firstRun.runId).toBe("run-first");
      expect(secondRun.runId).toBe("run-second");
    });
  });

  test("maintains JSONL format with newlines", async () => {
    await withTempDir(async (dir) => {
      const rollupPath = path.join(dir, "rollup.jsonl");

      const obs: Observation[] = [baseObservation, baseObservation];
      await appendToRollup(obs, rollupPath);

      const file = Bun.file(rollupPath);
      const text = await file.text();

      const lines = text.split("\n");
      // Should have at least 2 lines (one per obs) plus possible empty line at end
      expect(lines.length).toBeGreaterThanOrEqual(2);
    });
  });

  test("preserves all observation types", async () => {
    await withTempDir(async (dir) => {
      const rollupPath = path.join(dir, "rollup.jsonl");

      const obs: Observation[] = [
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "context",
          ts: "2026-05-04T00:00:00Z",
          kind: "chunk-included",
          payload: { chunkId: "c1", label: "chunk", tokens: 100 },
        },
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "context",
          ts: "2026-05-04T00:01:00Z",
          kind: "chunk-excluded",
          payload: { chunkId: "c2", label: "chunk", reason: "stale" },
        },
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "escalation",
          ts: "2026-05-04T00:02:00Z",
          kind: "escalation",
          payload: { from: "fast", to: "balanced" },
        },
      ];

      await appendToRollup(obs, rollupPath);

      const file = Bun.file(rollupPath);
      const text = await file.text();
      const lines = text.split("\n").filter((l) => l.trim());

      const kinds = lines.map((l) => JSON.parse(l).kind);
      expect(kinds).toContain("chunk-included");
      expect(kinds).toContain("chunk-excluded");
      expect(kinds).toContain("escalation");
    });
  });
});

/** Rows padded past any plausible chunk size, so every row straddles a boundary. */
const CHUNK_STRADDLING_PAD = 200_000;

async function collect(file: Bun.BunFile): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of streamJsonlLines(file)) lines.push(line);
  return lines;
}

describe("streamJsonlLines", () => {
  test("reassembles rows that straddle chunk boundaries", async () => {
    await withTempDir(async (dir) => {
      const p = path.join(dir, "rollup.jsonl");
      const rows = Array.from({ length: 12 }, (_, i) => ({ i, pad: "x".repeat(CHUNK_STRADDLING_PAD) }));
      await Bun.write(p, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);

      const lines = await collect(Bun.file(p));

      expect(lines).toHaveLength(12);
      expect(lines.map((l) => (JSON.parse(l) as { i: number }).i)).toEqual(rows.map((r) => r.i));
    });
  });

  test("preserves multi-byte characters split across a chunk boundary", async () => {
    // The reason the decoder is driven with `{ stream: true }`. Reviewer prose
    // in the rollup is full of `—`, `·` and `→`; decoding each chunk
    // independently replaces whichever one lands on the seam with U+FFFD.
    //
    // The padding itself must be multi-byte. A row of ASCII padding carrying a
    // few non-ASCII characters in one small field passes either way — no chunk
    // boundary ever lands inside those few bytes, so the test proves nothing.
    // Filling the row with 3-byte characters makes a split mid-character
    // certain rather than lucky.
    await withTempDir(async (dir) => {
      const p = path.join(dir, "rollup.jsonl");
      const pad = "→".repeat(CHUNK_STRADDLING_PAD / 2);
      const rows = Array.from({ length: 12 }, (_, i) => ({ i, pad }));
      await Bun.write(p, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);

      const lines = await collect(Bun.file(p));

      expect(lines).toHaveLength(12);
      for (const line of lines) {
        expect((JSON.parse(line) as { pad: string }).pad).toBe(pad);
      }
      expect(lines.join("")).not.toContain("�");
    });
  });

  test("a byte-sliced start yields exactly one leading fragment, then intact rows", async () => {
    // `readHeuristicWindow` reads a tail by byte offset, so the first line is a
    // fragment of a row whose start was never read — and `parseTail` drops
    // exactly one line on that basis. If the reader ever yielded zero or two
    // fragments, that caller would silently drop a good row or admit a broken one.
    await withTempDir(async (dir) => {
      const p = path.join(dir, "rollup.jsonl");
      const rows = Array.from({ length: 12 }, (_, i) => ({ i, pad: "x".repeat(CHUNK_STRADDLING_PAD) }));
      await Bun.write(p, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);

      // Mid-row by construction: rows are ~200 KB, so this lands inside row 1.
      const lines = await collect(Bun.file(p).slice(CHUNK_STRADDLING_PAD / 2));

      const parses = lines.map((l) => {
        try {
          JSON.parse(l);
          return true;
        } catch {
          return false;
        }
      });
      expect(parses[0]).toBe(false);
      expect(parses.slice(1).every(Boolean)).toBe(true);
    });
  });

  test("yields a final row that has no trailing newline", async () => {
    await withTempDir(async (dir) => {
      const p = path.join(dir, "rollup.jsonl");
      await Bun.write(p, '{"i":1}\n{"i":2}');

      expect(await collect(Bun.file(p))).toEqual(['{"i":1}', '{"i":2}']);
    });
  });

  test("yields nothing for an empty source rather than one empty line", async () => {
    // `pruneRollup` counts every yielded line; a phantom row would inflate its
    // kept/dropped tallies on an empty rollup.
    await withTempDir(async (dir) => {
      const p = path.join(dir, "rollup.jsonl");
      await Bun.write(p, "");

      expect(await collect(Bun.file(p))).toEqual([]);
    });
  });

  test("preserves blank lines rather than collapsing them", async () => {
    // Callers decide what a blank line means (both skip it via `.trim()`); the
    // reader must not make that decision for them by silently dropping rows.
    await withTempDir(async (dir) => {
      const p = path.join(dir, "rollup.jsonl");
      await Bun.write(p, '{"i":1}\n\n{"i":2}\n');

      expect(await collect(Bun.file(p))).toEqual(['{"i":1}', "", '{"i":2}']);
    });
  });
});

// ---------------------------------------------------------------------------
// H1 heuristic — cross-feature recurrence (#1422) and #942 bucket guards.
// Absorbed from curator-heuristics-h1.test.ts.
// ---------------------------------------------------------------------------

function makeReviewFindingObs942(
  storyId: string,
  ruleId: string,
  severity: string,
  message = "msg",
  category?: string,
): Observation {
  return {
    schemaVersion: 1,
    projectKey: "test-proj",
    runId: "run-test",
    featureId: `feat-${storyId}`,
    storyId,
    stage: "review",
    ts: "2026-05-07T00:00:00.000Z",
    kind: "review-finding",
    payload: { ruleId, checkId: ruleId, severity, category, file: "src/foo.ts", line: 1, message },
  };
}

describe("H1 — sample messages in evidence", () => {
  test("evidence includes up to two sample messages drawn from the group", () => {
    const observations: Observation[] = [
      makeReviewFindingObs942(
        "US-001",
        "input:listener-arg-not-validated",
        "warning",
        "Listener argument is not validated as a function (register path)",
      ),
      makeReviewFindingObs942(
        "US-002",
        "input:listener-arg-not-validated",
        "warning",
        "Listener argument is not validated as a function (handler path)",
      ),
      makeReviewFindingObs942(
        "US-003",
        "input:listener-arg-not-validated",
        "warning",
        "Listener argument is not validated as a function (third example should not appear)",
      ),
    ];

    const proposals = runHeuristics(observations, { repeatedFinding: 2 } as CuratorThresholds);
    const h1 = proposals.find((p) => p.id === "H1");
    assertDefined(h1, "H1 proposal");

    expect(h1).toBeDefined();
    expect(h1.evidence).toContain("(register path)");
    expect(h1.evidence).toContain("(handler path)");
    expect(h1.evidence).not.toContain("third example should not appear");
  });

  test("evidence omits sample section when all messages are empty", () => {
    const observations: Observation[] = [
      makeReviewFindingObs942("US-001", "input:listener-arg-not-validated", "warning", ""),
      makeReviewFindingObs942("US-002", "input:listener-arg-not-validated", "warning", ""),
    ];

    const proposals = runHeuristics(observations, { repeatedFinding: 2 } as CuratorThresholds);
    const h1 = proposals.find((p) => p.id === "H1");
    assertDefined(h1, "H1 proposal");
    expect(h1).toBeDefined();
    expect(h1.evidence).not.toContain("Examples:");
  });

  test("sample uses only the first line of a multi-line message", () => {
    const observations: Observation[] = [
      makeReviewFindingObs942(
        "US-001",
        "review:null-check",
        "warning",
        "Null check missing\n→ Add a guard before access",
      ),
      makeReviewFindingObs942(
        "US-002",
        "review:null-check",
        "warning",
        "Null check missing\n→ Add a guard before access",
      ),
    ];

    const proposals = runHeuristics(observations, { repeatedFinding: 2 } as CuratorThresholds);
    const h1 = proposals.find((p) => p.id === "H1");
    assertDefined(h1, "H1 proposal");
    expect(h1.evidence).toContain("Null check missing");
    expect(h1.evidence).not.toContain("→ Add a guard");
  });

  test("a blank-looking first message does not suppress a later real sample", () => {
    const observations: Observation[] = [
      makeReviewFindingObs942("US-001", "review:null-check", "warning", "\nNull check missing"),
      makeReviewFindingObs942("US-002", "review:null-check", "warning", "Null check missing"),
    ];

    const h1 = runHeuristics(observations, { repeatedFinding: 2 } as CuratorThresholds).find((p) => p.id === "H1");
    expect(h1).toBeDefined();
    expect(h1?.evidence).toContain("Null check missing");
  });
});

// Retired by #1861. This describe block ("H1 — issue #942 AC-5: ruleId
// buckets are not single-word collapses") hand-authored ruleIds in the
// category:slug shape ("input:listener-arg", "input:timeout-bound") that no
// live producer ever emits — LLM findings on the audit path carry no
// ruleId/rule/checkId, so `findingRuleId()` falls back to bare `category`
// ("input" for both), collapsing them to ONE bucket in production. The test
// was green against a shape production never writes. #1861 rules that a
// bare-category ruleId is the ceiling for prose findings, not a defect;
// whether H1 can be made to group more finely is #1863, not this issue.
// Grouping is still per-defect via `crossFeatureKey(category, message)` (see
// the `H1 — cross-feature recurrence (#1422)` describe block below), and the
// per-proposal description/evidence line (category + files + gist samples)
// still distinguishes two same-category proposals on the checkbox line — see
// `runHeuristics()`'s H1 comment for the pointer to #1863.

// ─── #1422: cross-feature recurrence ──────────────────────────────────────────

describe("H1 — cross-feature recurrence (#1422)", () => {
  const thresholds: CuratorThresholds = {
    repeatedFinding: 3,
    emptyKeyword: 2,
    rectifyAttempts: 3,
    escalationChain: 2,
    staleChunkRuns: 2,
    unchangedOutcome: 3,
  };

  function finding(
    featureId: string,
    storyId: string,
    over: Partial<{ category: string; file: string; message: string }> = {},
  ): Observation {
    return {
      schemaVersion: 1,
      projectKey: "test-proj",
      runId: "run-1",
      featureId,
      storyId,
      stage: "review",
      ts: "2026-08-01T00:00:00Z",
      kind: "review-finding",
      payload: {
        ruleId: "test-gap:missing-runtime-assertion",
        category: over.category ?? "test-gap",
        severity: "error",
        file: over.file ?? "src/api.ts",
        line: 10,
        message: over.message ?? "Test asserts a pattern exists in the file instead of invoking the code",
      },
    };
  }

  test("proposes when the same finding recurs across enough DISTINCT features", () => {
    const obs = [finding("feat-a", "US-001"), finding("feat-b", "US-002"), finding("feat-c", "US-003")];
    const h1 = runHeuristics(obs, thresholds).find((p) => p.id === "H1");
    expect(h1).toBeDefined();
    expect(h1?.description).toContain("3 features");
    expect(h1?.evidence).toContain("feat-a");
    expect(h1?.evidence).toContain("feat-c");
  });

  test("fires when the SAME defect appears in DIFFERENT files across features", () => {
    const obs = [
      finding("feat-a", "US-001", { file: "src/auth.ts" }),
      finding("feat-b", "US-002", { file: "src/billing.ts" }),
      finding("feat-c", "US-003", { file: "src/cart.ts" }),
    ];
    const h1 = runHeuristics(obs, thresholds).find((p) => p.id === "H1");
    expect(h1).toBeDefined();
    expect(h1?.description).toContain("3 features");
    expect(h1?.evidence).toContain("src/auth.ts");
    expect(h1?.evidence).toContain("src/cart.ts");
  });

  test("description never collapses to a bare category (#942 regression guard)", () => {
    const obs = ["a", "b", "c"].map((f) =>
      finding(`feat-${f}`, "US-001", { file: "", message: "Assumes the env var is always set before boot" }),
    );
    const h1 = runHeuristics(obs, thresholds).find((p) => p.id === "H1");
    expect(h1).toBeDefined();
    expect(h1?.description).toContain("Assumes the env var is always set");
    expect(h1?.description).not.toMatch(/^Recurring review finding \(test-gap\)$/);
  });

  test("two distinct defects in the same file produce distinguishable descriptions", () => {
    const a = ["a", "b", "c"].map((f) =>
      finding(`feat-${f}`, "US-001", { message: "Placeholder assertion expect(true) covers AC 2" }),
    );
    const b = ["a", "b", "c"].map((f) =>
      finding(`feat-${f}`, "US-002", { message: "Source-inspection test reads the file instead of running it" }),
    );
    const h1s = runHeuristics([...a, ...b], thresholds).filter((p) => p.id === "H1");
    expect(h1s).toHaveLength(2);
    expect(h1s[0].description).not.toBe(h1s[1].description);
  });

  test("story IDs are qualified by feature, since US-001 exists in every feature", () => {
    const obs = ["a", "b", "c"].map((f) => finding(`feat-${f}`, "US-001"));
    const h1 = runHeuristics(obs, thresholds).find((p) => p.id === "H1");
    expect(h1?.storyIds).toEqual(["feat-a/US-001", "feat-b/US-001", "feat-c/US-001"]);
  });

  test("does NOT propose when one feature repeats the same finding many times", () => {
    const obs = Array.from({ length: 12 }, (_, i) => finding("feat-a", `US-${i}`));
    expect(runHeuristics(obs, thresholds).find((p) => p.id === "H1")).toBeUndefined();
  });

  test("separates distinct defects that share a category and file", () => {
    const a = [1, 2, 3].map((i) => finding(`feat-${i}`, "US-001", { message: "Placeholder assertion expect(true)" }));
    const b = [1, 2, 3].map((i) =>
      finding(`feat-${i}`, "US-002", { message: "Source-inspection test reads the file" }),
    );
    const h1s = runHeuristics([...a, ...b], thresholds).filter((p) => p.id === "H1");
    expect(h1s).toHaveLength(2);
  });

  test("groups the same defect reported at different lines and stories", () => {
    const obs = ["feat-a", "feat-b", "feat-c"].map((f) => finding(f, "US-001"));
    expect(runHeuristics(obs, thresholds).filter((p) => p.id === "H1")).toHaveLength(1);
  });

  test("severity is relative to the configured threshold, not a fixed spread", () => {
    const spread = (n: number) => Array.from({ length: n }, (_, i) => finding(`feat-${i}`, "US-001"));
    expect(runHeuristics(spread(3), thresholds).find((p) => p.id === "H1")?.severity).toBe("MED");
    expect(runHeuristics(spread(6), thresholds).find((p) => p.id === "H1")?.severity).toBe("HIGH");

    const strict = { ...thresholds, repeatedFinding: 8 };
    expect(runHeuristics(spread(8), strict).find((p) => p.id === "H1")?.severity).toBe("MED");
    expect(runHeuristics(spread(16), strict).find((p) => p.id === "H1")?.severity).toBe("HIGH");
  });

  test("acknowledgement-shaped findings cannot form a proposal on their own", () => {
    const obs = ["a", "b", "c"].map((f) =>
      finding(`feat-${f}`, "US-001", {
        category: "",
        file: "",
        message: "Prior finding 1: addressed. No action required.",
      }),
    );
    expect(runHeuristics(obs, thresholds).find((p) => p.id === "H1")).toBeUndefined();
  });
});
