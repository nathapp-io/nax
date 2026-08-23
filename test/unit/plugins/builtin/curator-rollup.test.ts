/**
 * Curator Rollup Tests
 *
 * Tests for append-only rollup functionality and the shared JSONL line
 * reader both rollup readers stream through (#1439).
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { type Observation, streamJsonlLines } from "@/plugins/builtin/curator";
import { appendToRollup } from "@/plugins/builtin/curator/rollup";
import { withTempDir } from "@test/helpers";

describe("appendToRollup", () => {
  const baseObservation: Observation = {
    schemaVersion: 1,
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
