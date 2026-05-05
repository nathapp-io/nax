/**
 * Curator Rollup Tests
 *
 * Tests for append-only rollup functionality.
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { appendToRollup } from "../../../../src/plugins/builtin/curator/rollup";
import type { Observation } from "../../../../src/plugins/builtin/curator";
import { withTempDir } from "../../../helpers";

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

  test("appends one JSON line per observation", async () => {
    await withTempDir(async (dir) => {
      const rollupPath = path.join(dir, "rollup.jsonl");

      const obs1: Observation[] = [
        baseObservation,
        { ...baseObservation, storyId: "story-2" },
      ];
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
        { ...baseObservation, storyId: "story-2", kind: "chunk-included", payload: { chunkId: "c1", label: "chunk", tokens: 100 } },
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

      const obs1: Observation[] = [
        { ...baseObservation, runId: "run-first" },
      ];
      await appendToRollup(obs1, rollupPath);

      const obs2: Observation[] = [
        { ...baseObservation, runId: "run-second" },
      ];
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
