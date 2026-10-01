/**
 * Unit tests for formatRunSummary's accounting of stories that ended in
 * neither passed, failed nor skipped.
 *
 * A story that stops at "Human review needed" is paused: the pipeline emits
 * `pipeline Story paused` and moves on, and none of the three counters claim
 * it. formatRunSummary printed Failed and Skipped only when non-zero, so an
 * observed run whose last two stories both hit a provider 429 rendered as:
 *
 *     Total: 4    Passed: 2    Success: 50.0%
 *
 * with no line at all for the two that stopped — an operator reading only the
 * footer could not tell the run had hit a quota wall. The residual is derived
 * here rather than added to RunSummary so it stays correct for any terminal
 * state the three counters do not model.
 */

import { describe, expect, test } from "bun:test";
import { formatLogEntry } from "@/log-format/formatter";
import { formatRunSummary } from "@/log-format/summary";
import type { RunSummary } from "@/log-format/types";

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    total: 4,
    passed: 2,
    failed: 0,
    skipped: 0,
    durationMs: 10_992_000,
    totalCost: 7.9039,
    ...over,
  } as RunSummary;
}

const OPTS = { mode: "normal" as const, useColor: false };

describe("formatRunSummary — unresolved stories", () => {
  test("reports the residual when the counters do not add up to total", () => {
    const output = formatRunSummary(summary(), OPTS);
    expect(output).toContain("Unresolved:");
    expect(output).toMatch(/Unresolved:\s+2/);
  });

  test("says why an unresolved story is unresolved", () => {
    const output = formatRunSummary(summary(), OPTS);
    expect(output.toLowerCase()).toContain("paused");
  });

  test("prints no residual line when every story is accounted for", () => {
    const output = formatRunSummary(summary({ total: 4, passed: 3, failed: 1 }), OPTS);
    expect(output).not.toContain("Unresolved:");
  });

  test("prints no residual line for a clean sweep", () => {
    const output = formatRunSummary(summary({ total: 2, passed: 2 }), OPTS);
    expect(output).not.toContain("Unresolved:");
  });

  test("does not go negative if the counters overshoot total", () => {
    const output = formatRunSummary(summary({ total: 1, passed: 2, failed: 1 }), OPTS);
    expect(output).not.toContain("Unresolved:");
  });

  test("still reports the residual alongside failures and skips", () => {
    const output = formatRunSummary(summary({ total: 6, passed: 2, failed: 1, skipped: 1 }), OPTS);
    expect(output).toMatch(/Unresolved:\s+2/);
    expect(output).toContain("Failed:");
    expect(output).toContain("Skipped:");
  });

  test("json mode is unchanged", () => {
    const output = formatRunSummary(summary(), { mode: "json", useColor: false });
    expect(JSON.parse(output).total).toBe(4);
  });
});

/**
 * A warn/error line is the operator's cue to act, so withholding its numbers
 * until `--verbose` defeats it. `static-rules` warned 19 times in one observed
 * run that rule sections had been truncated and never once printed how many
 * were dropped, though `droppedCount` was in the record the whole time.
 */
describe("formatLogEntry — numeric payload on warn/error lines", () => {
  const warned = (data: Record<string, unknown>) => ({
    timestamp: "2026-09-06T07:30:39.000Z",
    level: "warn" as const,
    stage: "static-rules",
    message: "Rule sections truncated by static rules budget",
    data,
  });

  test("renders unconsumed numeric fields inline", () => {
    const { output } = formatLogEntry(warned({ droppedCount: 7, budgetTokens: 4000 }), {
      mode: "normal",
      useColor: false,
    });
    expect(output).toContain("droppedCount=7");
    expect(output).toContain("budgetTokens=4000");
  });

  test("renders booleans too", () => {
    const { output } = formatLogEntry(warned({ truncated: true }), { mode: "normal", useColor: false });
    expect(output).toContain("truncated=true");
  });

  test("does not repeat a field already rendered by the meta builder", () => {
    const { output } = formatLogEntry(warned({ durationMs: 3600, droppedCount: 2 }), {
      mode: "normal",
      useColor: false,
    });
    expect(output).not.toContain("durationMs=3600");
    expect(output).toContain("droppedCount=2");
  });

  test("skips storyId, which is already rendered as a tag", () => {
    const entryWithStory = { ...warned({ droppedCount: 1 }), storyId: "US-001" };
    const { output } = formatLogEntry(entryWithStory, { mode: "normal", useColor: false });
    expect(output).toContain("[US-001]");
    expect(output).not.toContain("storyId=");
  });

  test("leaves strings out, so paths and commands do not bloat the line", () => {
    const { output } = formatLogEntry(warned({ command: "bun run lint", droppedCount: 1 }), {
      mode: "normal",
      useColor: false,
    });
    expect(output).not.toContain("bun run lint");
  });

  test("an info line is unaffected", () => {
    const info = { ...warned({ droppedCount: 7 }), level: "info" as const };
    const { output } = formatLogEntry(info, { mode: "normal", useColor: false });
    expect(output).not.toContain("droppedCount=7");
  });

  test("quiet mode is unaffected", () => {
    const err = { ...warned({ droppedCount: 7 }), level: "error" as const };
    const { output } = formatLogEntry(err, { mode: "quiet", useColor: false });
    expect(output).not.toContain("droppedCount=7");
  });
});
