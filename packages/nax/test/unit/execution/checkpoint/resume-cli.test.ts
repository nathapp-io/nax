/**
 * applyResumeModeDeps — US-004 CLI seam.
 *
 * The CLI command (`nax run`, `nax resume`) needs to override the orchestrator's
 * `_storyOrchestratorDeps.loadCheckpoints` stub at run start:
 *
 *   - `resumeMode === "auto"` (or undefined): wire to the real reader so the
 *     orchestrator can seed its in-memory skip state from a prior checkpoint.
 *   - `resumeMode === "fresh"` / `"no-resume"`: wire to a function that returns
 *     an empty Map so the orchestrator seeds no skip phases — every incomplete
 *     story runs from the top.
 *
 * AC4 — `nax run` calls `loadCheckpoints` with the feature's `featureDir`.
 * AC5 — `nax run --fresh` (or `--no-resume`) yields no skip phases for any story.
 * AC6 — `--no-resume` is behaviorally identical to `--fresh`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _storyOrchestratorDeps, applyResumeModeDeps } from "@/execution";

function writeCheckpoint(featureDir: string, storyIds: string[]): void {
  const cpPath = join(featureDir, "checkpoint.jsonl");
  const lines = storyIds.flatMap((storyId, i) => [
    JSON.stringify({
      storyId,
      phase: "test-writer",
      headSha: `sha-${i}`,
      dirtyDigest: `dig-${i}`,
      runId: "run-1",
      ts: 1700000000000 + i,
    }),
    JSON.stringify({
      storyId,
      phase: "implementer",
      headSha: `sha-${i}-b`,
      dirtyDigest: `dig-${i}-b`,
      runId: "run-1",
      ts: 1700000000001 + i,
    }),
  ]);
  writeFileSync(cpPath, `${lines.join("\n")}\n`);
}

describe("applyResumeModeDeps — AC4: auto mode wires loadCheckpoints to the real reader", () => {
  let featureDir: string;

  beforeEach(() => {
    featureDir = makeTempDir("nax-resume-mode-auto-");
  });

  afterEach(() => {
    cleanupTempDir(featureDir);
  });

  test("AC4: auto mode overrides loadCheckpoints with a function that reads checkpoint.jsonl via real reader", async () => {
    writeCheckpoint(featureDir, ["US-001", "US-002"]);

    const origLoad = _storyOrchestratorDeps.loadCheckpoints;
    try {
      applyResumeModeDeps(featureDir, "auto");

      // After wiring, calling the orchestrator's loadCheckpoints should read the
      // real checkpoint.jsonl and return the parsed map.
      const result = await _storyOrchestratorDeps.loadCheckpoints(featureDir);
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(2);
      expect(result.get("US-001")?.greenPhases).toEqual(["test-writer", "implementer"]);
    } finally {
      _storyOrchestratorDeps.loadCheckpoints = origLoad;
    }
  });

  test("AC4: auto mode is the default — omitting resumeMode behaves identically to 'auto'", async () => {
    writeCheckpoint(featureDir, ["US-001"]);

    const origLoad = _storyOrchestratorDeps.loadCheckpoints;
    try {
      applyResumeModeDeps(featureDir);

      const result = await _storyOrchestratorDeps.loadCheckpoints(featureDir);
      expect(result.size).toBe(1);
      expect(result.get("US-001")?.greenPhases).toEqual(["test-writer", "implementer"]);
    } finally {
      _storyOrchestratorDeps.loadCheckpoints = origLoad;
    }
  });

  test("AC4: auto mode with missing checkpoint.jsonl still returns an empty Map (no throw)", async () => {
    const origLoad = _storyOrchestratorDeps.loadCheckpoints;
    try {
      applyResumeModeDeps(featureDir, "auto");

      const result = await _storyOrchestratorDeps.loadCheckpoints(featureDir);
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    } finally {
      _storyOrchestratorDeps.loadCheckpoints = origLoad;
    }
  });
});

describe("applyResumeModeDeps — AC5: fresh mode yields no skip phases", () => {
  let featureDir: string;

  beforeEach(() => {
    featureDir = makeTempDir("nax-resume-mode-fresh-");
  });

  afterEach(() => {
    cleanupTempDir(featureDir);
  });

  test("AC5: fresh mode overrides loadCheckpoints with a function that returns an empty Map regardless of checkpoint contents", async () => {
    // Write a real checkpoint that would otherwise populate skip phases.
    writeCheckpoint(featureDir, ["US-001", "US-002", "US-003"]);

    const origLoad = _storyOrchestratorDeps.loadCheckpoints;
    try {
      applyResumeModeDeps(featureDir, "fresh");

      const result = await _storyOrchestratorDeps.loadCheckpoints(featureDir);
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    } finally {
      _storyOrchestratorDeps.loadCheckpoints = origLoad;
    }
  });

  test("AC5: fresh mode produces an empty Map even when no checkpoint.jsonl exists", async () => {
    const origLoad = _storyOrchestratorDeps.loadCheckpoints;
    try {
      applyResumeModeDeps(featureDir, "fresh");

      const result = await _storyOrchestratorDeps.loadCheckpoints(featureDir);
      expect(result.size).toBe(0);
    } finally {
      _storyOrchestratorDeps.loadCheckpoints = origLoad;
    }
  });
});

describe("applyResumeModeDeps — AC6: no-resume mode is identical to fresh", () => {
  let featureDir: string;

  beforeEach(() => {
    featureDir = makeTempDir("nax-resume-mode-noresume-");
  });

  afterEach(() => {
    cleanupTempDir(featureDir);
  });

  test("AC6: no-resume mode overrides loadCheckpoints with a function that returns an empty Map regardless of checkpoint contents", async () => {
    writeCheckpoint(featureDir, ["US-001", "US-002"]);

    const origLoad = _storyOrchestratorDeps.loadCheckpoints;
    try {
      applyResumeModeDeps(featureDir, "no-resume");

      const result = await _storyOrchestratorDeps.loadCheckpoints(featureDir);
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    } finally {
      _storyOrchestratorDeps.loadCheckpoints = origLoad;
    }
  });

  test("AC6: fresh and no-resume both produce empty Maps — behaviorally indistinguishable for the orchestrator", async () => {
    writeCheckpoint(featureDir, ["US-001"]);

    const origLoad = _storyOrchestratorDeps.loadCheckpoints;
    try {
      applyResumeModeDeps(featureDir, "fresh");
      const freshResult = await _storyOrchestratorDeps.loadCheckpoints(featureDir);

      applyResumeModeDeps(featureDir, "no-resume");
      const noResumeResult = await _storyOrchestratorDeps.loadCheckpoints(featureDir);

      expect(freshResult.size).toBe(0);
      expect(noResumeResult.size).toBe(0);
      expect(freshResult.size).toBe(noResumeResult.size);
    } finally {
      _storyOrchestratorDeps.loadCheckpoints = origLoad;
    }
  });
});
