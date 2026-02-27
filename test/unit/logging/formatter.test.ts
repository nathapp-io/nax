/**
 * Tests for human-friendly logging formatter
 */

import { describe, test, expect } from "bun:test";
import { formatLogEntry, formatRunSummary, formatTimestamp, formatDuration, formatCost } from "../../../src/logging/formatter.js";
import { EMOJI, type FormatterOptions, type RunSummary } from "../../../src/logging/types.js";
import type { LogEntry } from "../../../src/logger/types.js";

describe("formatTimestamp", () => {
  test("formats ISO timestamp to HH:MM:SS", () => {
    const result = formatTimestamp("2026-02-27T14:30:45.123Z");
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  test("handles different timezones", () => {
    const result = formatTimestamp("2026-02-27T00:00:00.000Z");
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

describe("formatDuration", () => {
  test("formats milliseconds", () => {
    expect(formatDuration(500)).toBe("500ms");
  });

  test("formats seconds", () => {
    expect(formatDuration(5000)).toBe("5.0s");
    expect(formatDuration(5500)).toBe("5.5s");
  });

  test("formats minutes and seconds", () => {
    expect(formatDuration(65000)).toBe("1m 5s");
    expect(formatDuration(125000)).toBe("2m 5s");
  });
});

describe("formatCost", () => {
  test("formats cost with 4 decimal places", () => {
    expect(formatCost(0.1234)).toBe("$0.1234");
    expect(formatCost(1.5)).toBe("$1.5000");
    expect(formatCost(0.00001)).toBe("$0.0000");
  });
});

describe("formatLogEntry - story start", () => {
  const options: FormatterOptions = { mode: "normal", useColor: false };

  test("renders story start with title, complexity, and tier", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-27T14:30:00Z",
      level: "info",
      stage: "story.start",
      storyId: "US-001",
      message: "Starting story",
      data: {
        storyId: "US-001",
        storyTitle: "Add authentication",
        complexity: "medium",
        modelTier: "balanced",
      },
    };

    const result = formatLogEntry(entry, options);
    expect(result.shouldDisplay).toBe(true);
    expect(result.output).toContain("US-001");
    expect(result.output).toContain("Add authentication");
    expect(result.output).toContain("medium");
    expect(result.output).toContain("balanced");
    expect(result.output).toContain(EMOJI.storyStart);
  });

  test("shows retry indicator for attempts > 1", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-27T14:30:00Z",
      level: "info",
      stage: "iteration.start",
      storyId: "US-001",
      message: "Starting iteration",
      data: {
        storyId: "US-001",
        storyTitle: "Add auth",
        complexity: "complex",
        modelTier: "powerful",
        attempt: 2,
      },
    };

    const result = formatLogEntry(entry, options);
    expect(result.output).toContain("attempt #2");
    expect(result.output).toContain(EMOJI.retry);
  });

  test("verbose mode includes tree-style metadata", () => {
    const verboseOptions: FormatterOptions = { mode: "verbose", useColor: false };
    const entry: LogEntry = {
      timestamp: "2026-02-27T14:30:00Z",
      level: "info",
      stage: "story.start",
      storyId: "US-001",
      message: "Starting",
      data: {
        storyId: "US-001",
        storyTitle: "Add feature",
        complexity: "simple",
        modelTier: "fast",
      },
    };

    const result = formatLogEntry(entry, verboseOptions);
    expect(result.output).toContain("├─");
    expect(result.output).toContain("└─");
    expect(result.output).toContain("Complexity:");
    expect(result.output).toContain("Tier:");
  });
});

describe("formatLogEntry - story complete", () => {
  const options: FormatterOptions = { mode: "normal", useColor: false };

  test("renders pass with appropriate emoji", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-27T14:35:00Z",
      level: "info",
      stage: "story.complete",
      storyId: "US-001",
      message: "Story completed",
      data: {
        storyId: "US-001",
        success: true,
        cost: 0.1234,
        durationMs: 30000,
      },
    };

    const result = formatLogEntry(entry, options);
    expect(result.output).toContain(EMOJI.success);
    expect(result.output).toContain("PASSED");
    expect(result.output).toContain("US-001");
  });

  test("renders failure with appropriate emoji", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-27T14:35:00Z",
      level: "error",
      stage: "agent.complete",
      storyId: "US-002",
      message: "Failed",
      data: {
        storyId: "US-002",
        success: false,
        finalAction: "fail",
        cost: 0.05,
      },
    };

    const result = formatLogEntry(entry, options);
    expect(result.output).toContain(EMOJI.failure);
    expect(result.output).toContain("FAILED");
  });

  test("renders escalation with retry emoji", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-27T14:35:00Z",
      level: "warn",
      stage: "agent.complete",
      storyId: "US-003",
      message: "Escalated",
      data: {
        storyId: "US-003",
        success: false,
        finalAction: "escalate",
        cost: 0.02,
      },
    };

    const result = formatLogEntry(entry, options);
    expect(result.output).toContain(EMOJI.retry);
    expect(result.output).toContain("ESCALATED");
  });

  test("includes cost and duration in normal mode", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-27T14:35:00Z",
      level: "info",
      stage: "story.complete",
      storyId: "US-001",
      message: "Done",
      data: {
        storyId: "US-001",
        success: true,
        cost: 0.2567,
        durationMs: 45000,
      },
    };

    const result = formatLogEntry(entry, options);
    expect(result.output).toContain(EMOJI.cost);
    expect(result.output).toContain("$0.2567");
    expect(result.output).toContain(EMOJI.duration);
    expect(result.output).toContain("45.0s");
  });
});

describe("formatLogEntry - verbosity modes", () => {
  const baseEntry: LogEntry = {
    timestamp: "2026-02-27T14:30:00Z",
    level: "debug",
    stage: "routing",
    message: "Task classified",
    data: { complexity: "simple" },
  };

  test("quiet mode only shows critical events", () => {
    const options: FormatterOptions = { mode: "quiet", useColor: false };

    // Should show run start
    const runStart: LogEntry = {
      ...baseEntry,
      stage: "run.start",
      level: "info",
    };
    expect(formatLogEntry(runStart, options).shouldDisplay).toBe(true);

    // Should show story complete
    const storyComplete: LogEntry = {
      ...baseEntry,
      stage: "story.complete",
      level: "info",
    };
    expect(formatLogEntry(storyComplete, options).shouldDisplay).toBe(true);

    // Should NOT show debug logs
    expect(formatLogEntry(baseEntry, options).shouldDisplay).toBe(false);
  });

  test("normal mode filters debug logs", () => {
    const options: FormatterOptions = { mode: "normal", useColor: false };

    // Should NOT show debug
    const debugEntry: LogEntry = { ...baseEntry, level: "debug" };
    expect(formatLogEntry(debugEntry, options).shouldDisplay).toBe(false);

    // Should show info
    const infoEntry: LogEntry = { ...baseEntry, level: "info" };
    expect(formatLogEntry(infoEntry, options).shouldDisplay).toBe(true);

    // Should show warn
    const warnEntry: LogEntry = { ...baseEntry, level: "warn" };
    expect(formatLogEntry(warnEntry, options).shouldDisplay).toBe(true);

    // Should show error
    const errorEntry: LogEntry = { ...baseEntry, level: "error" };
    expect(formatLogEntry(errorEntry, options).shouldDisplay).toBe(true);
  });

  test("verbose mode shows all logs including debug", () => {
    const options: FormatterOptions = { mode: "verbose", useColor: false };

    expect(formatLogEntry(baseEntry, options).shouldDisplay).toBe(true);
    expect(formatLogEntry({ ...baseEntry, level: "info" }, options).shouldDisplay).toBe(true);
  });

  test("verbose mode includes routing, tokens, and context data", () => {
    const options: FormatterOptions = { mode: "verbose", useColor: false };
    const entry: LogEntry = {
      timestamp: "2026-02-27T14:30:00Z",
      level: "debug",
      stage: "routing",
      message: "Task classified",
      data: {
        complexity: "medium",
        modelTier: "balanced",
        tokens: 1500,
        contextFiles: ["src/main.ts", "src/utils.ts"],
      },
    };

    const result = formatLogEntry(entry, options);
    expect(result.shouldDisplay).toBe(true);
    // Data should be included in verbose mode
    expect(result.output).toContain("tokens");
    expect(result.output).toContain("contextFiles");
  });

  test("json mode passes through raw JSONL", () => {
    const options: FormatterOptions = { mode: "json" };
    const entry: LogEntry = {
      timestamp: "2026-02-27T14:30:00Z",
      level: "info",
      stage: "routing",
      message: "Test",
      data: { key: "value" },
    };

    const result = formatLogEntry(entry, options);
    expect(result.shouldDisplay).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.timestamp).toBe(entry.timestamp);
    expect(parsed.level).toBe(entry.level);
    expect(parsed.stage).toBe(entry.stage);
    expect(parsed.message).toBe(entry.message);
    expect(parsed.data).toEqual(entry.data);
  });
});

describe("formatRunSummary", () => {
  const options: FormatterOptions = { mode: "normal", useColor: false };

  test("renders pass/fail/duration/cost stats", () => {
    const summary: RunSummary = {
      total: 10,
      passed: 8,
      failed: 2,
      skipped: 0,
      durationMs: 300000,
      totalCost: 1.2345,
      startedAt: "2026-02-27T14:00:00Z",
      completedAt: "2026-02-27T14:05:00Z",
    };

    const result = formatRunSummary(summary, options);
    expect(result).toContain("RUN SUMMARY");
    expect(result).toContain("Total:");
    expect(result).toContain("10");
    expect(result).toContain("Passed:");
    expect(result).toContain("8");
    expect(result).toContain("Failed:");
    expect(result).toContain("2");
    expect(result).toContain("80.0%"); // success rate
    expect(result).toContain(EMOJI.duration);
    expect(result).toContain("5m 0s");
    expect(result).toContain(EMOJI.cost);
    expect(result).toContain("$1.2345");
  });

  test("shows skipped count when present", () => {
    const summary: RunSummary = {
      total: 10,
      passed: 7,
      failed: 1,
      skipped: 2,
      durationMs: 100000,
      totalCost: 0.5,
      startedAt: "2026-02-27T14:00:00Z",
    };

    const result = formatRunSummary(summary, options);
    expect(result).toContain("Skipped:");
    expect(result).toContain("2");
    expect(result).toContain(EMOJI.skip);
  });

  test("handles zero stories", () => {
    const summary: RunSummary = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      durationMs: 0,
      totalCost: 0,
      startedAt: "2026-02-27T14:00:00Z",
    };

    const result = formatRunSummary(summary, options);
    expect(result).toContain("0.0%"); // success rate
    expect(result).toContain("$0.0000");
  });

  test("json mode outputs raw JSON", () => {
    const jsonOptions: FormatterOptions = { mode: "json" };
    const summary: RunSummary = {
      total: 5,
      passed: 5,
      failed: 0,
      skipped: 0,
      durationMs: 50000,
      totalCost: 0.25,
      startedAt: "2026-02-27T14:00:00Z",
    };

    const result = formatRunSummary(summary, jsonOptions);
    const parsed = JSON.parse(result);
    expect(parsed.total).toBe(5);
    expect(parsed.passed).toBe(5);
    expect(parsed.totalCost).toBe(0.25);
  });
});

describe("formatLogEntry - run start", () => {
  test("renders run header with feature, runId, and workdir", () => {
    const options: FormatterOptions = { mode: "normal", useColor: false };
    const entry: LogEntry = {
      timestamp: "2026-02-27T14:00:00Z",
      level: "info",
      stage: "run.start",
      message: "Starting feature",
      data: {
        runId: "run-2026-02-27T14-00-00-000Z",
        feature: "authentication",
        workdir: "/Users/test/project",
        totalStories: 5,
      },
    };

    const result = formatLogEntry(entry, options);
    expect(result.shouldDisplay).toBe(true);
    expect(result.output).toContain("NAX RUN STARTED");
    expect(result.output).toContain("authentication");
    expect(result.output).toContain("run-2026-02-27T14-00-00-000Z");
    expect(result.output).toContain("/Users/test/project");
    expect(result.output).toContain(EMOJI.storyStart);
  });
});

describe("formatLogEntry - TDD sessions", () => {
  test("renders TDD session starts", () => {
    const options: FormatterOptions = { mode: "normal", useColor: false };
    const entry: LogEntry = {
      timestamp: "2026-02-27T14:30:00Z",
      level: "info",
      stage: "tdd",
      message: "→ Session: test-writer",
      data: {
        role: "test-writer",
        storyId: "US-001",
      },
    };

    const result = formatLogEntry(entry, options);
    expect(result.shouldDisplay).toBe(true);
    expect(result.output).toContain(EMOJI.tdd);
    expect(result.output).toContain("Test Writer");
  });

  test("quiet mode hides TDD sessions", () => {
    const options: FormatterOptions = { mode: "quiet", useColor: false };
    const entry: LogEntry = {
      timestamp: "2026-02-27T14:30:00Z",
      level: "info",
      stage: "tdd",
      message: "→ Session: implementer",
      data: { role: "implementer" },
    };

    const result = formatLogEntry(entry, options);
    expect(result.shouldDisplay).toBe(false);
  });
});
