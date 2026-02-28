/**
 * Manual demo of the logging formatter
 *
 * Run with: bun run test/manual/logging-formatter-demo.ts
 */

import type { LogEntry } from "../../src/logger/types.js";
import { formatLogEntry, formatRunSummary } from "../../src/logging/formatter.js";
import type { RunSummary } from "../../src/logging/types.js";

console.log("\n=== LOGGING FORMATTER DEMO ===\n");

// Run start
const runStart: LogEntry = {
  timestamp: new Date().toISOString(),
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

console.log(formatLogEntry(runStart, { mode: "normal", useColor: true }).output);

// Story start
const storyStart: LogEntry = {
  timestamp: new Date().toISOString(),
  level: "info",
  stage: "story.start",
  storyId: "US-001",
  message: "Starting story",
  data: {
    storyId: "US-001",
    storyTitle: "Add user authentication with JWT",
    complexity: "medium",
    modelTier: "balanced",
  },
};

console.log(formatLogEntry(storyStart, { mode: "normal", useColor: true }).output);

// TDD session
const tddSession: LogEntry = {
  timestamp: new Date().toISOString(),
  level: "info",
  stage: "tdd",
  message: "→ Session: test-writer",
  data: {
    role: "test-writer",
    storyId: "US-001",
  },
};

console.log(formatLogEntry(tddSession, { mode: "normal", useColor: true }).output);

// Routing (verbose only)
const routing: LogEntry = {
  timestamp: new Date().toISOString(),
  level: "debug",
  stage: "routing",
  message: "Task classified",
  data: {
    complexity: "medium",
    modelTier: "balanced",
    tokens: 1500,
    contextFiles: ["src/auth.ts", "src/middleware.ts"],
  },
};

console.log("\n--- Normal mode (should hide debug) ---");
console.log(formatLogEntry(routing, { mode: "normal", useColor: true }).output);

console.log("\n--- Verbose mode (should show debug with data) ---");
console.log(formatLogEntry(routing, { mode: "verbose", useColor: true }).output);

// Story complete - success
const storySuccess: LogEntry = {
  timestamp: new Date().toISOString(),
  level: "info",
  stage: "story.complete",
  storyId: "US-001",
  message: "Story completed",
  data: {
    storyId: "US-001",
    success: true,
    cost: 0.2567,
    durationMs: 45000,
  },
};

console.log("\n");
console.log(formatLogEntry(storySuccess, { mode: "normal", useColor: true }).output);

// Story complete - escalation
const storyEscalate: LogEntry = {
  timestamp: new Date().toISOString(),
  level: "warn",
  stage: "agent.complete",
  storyId: "US-002",
  message: "Escalated",
  data: {
    storyId: "US-002",
    success: false,
    finalAction: "escalate",
    cost: 0.12,
    durationMs: 30000,
  },
};

console.log(formatLogEntry(storyEscalate, { mode: "normal", useColor: true }).output);

// Story complete - failure
const storyFail: LogEntry = {
  timestamp: new Date().toISOString(),
  level: "error",
  stage: "story.complete",
  storyId: "US-003",
  message: "Failed",
  data: {
    storyId: "US-003",
    success: false,
    finalAction: "fail",
    reason: "Test suite failed after 3 attempts",
    cost: 0.35,
    durationMs: 120000,
  },
};

console.log(formatLogEntry(storyFail, { mode: "verbose", useColor: true }).output);

// Run summary
const summary: RunSummary = {
  total: 10,
  passed: 8,
  failed: 1,
  skipped: 1,
  durationMs: 300000,
  totalCost: 1.2345,
  startedAt: "2026-02-27T14:00:00Z",
  completedAt: "2026-02-27T14:05:00Z",
};

console.log(formatRunSummary(summary, { mode: "normal", useColor: true }));

console.log("\n=== JSON MODE ===\n");
console.log(formatLogEntry(storyStart, { mode: "json" }).output);
console.log(formatRunSummary(summary, { mode: "json" }));

console.log("\n=== QUIET MODE (only shows critical events) ===\n");
console.log("Run start:", formatLogEntry(runStart, { mode: "quiet" }).shouldDisplay);
console.log("Story start:", formatLogEntry(storyStart, { mode: "quiet" }).shouldDisplay);
console.log("TDD session:", formatLogEntry(tddSession, { mode: "quiet" }).shouldDisplay);
console.log("Routing debug:", formatLogEntry(routing, { mode: "quiet" }).shouldDisplay);
console.log("Story complete:", formatLogEntry(storySuccess, { mode: "quiet" }).shouldDisplay);
