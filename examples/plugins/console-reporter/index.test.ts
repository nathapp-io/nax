/**
 * Console Reporter Plugin Tests
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type {
  RunStartEvent,
  StoryCompleteEvent,
  RunEndEvent,
} from "../../../src/plugins/types";
import { validatePlugin } from "../../../src/plugins/validator";
import consoleReporterPlugin from "./index";

describe("Console Reporter Plugin", () => {
  let consoleOutput: string[] = [];
  const originalLog = console.log;

  beforeEach(() => {
    consoleOutput = [];
    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  test("plugin structure passes validation", () => {
    const validated = validatePlugin(consoleReporterPlugin);
    expect(validated).not.toBeNull();
    expect(validated?.name).toBe("console-reporter");
    expect(validated?.version).toBe("1.0.0");
    expect(validated?.provides).toEqual(["reporter"]);
  });

  test("plugin has required fields", () => {
    expect(consoleReporterPlugin.name).toBe("console-reporter");
    expect(consoleReporterPlugin.version).toBe("1.0.0");
    expect(consoleReporterPlugin.provides).toContain("reporter");
    expect(consoleReporterPlugin.setup).toBeDefined();
    expect(consoleReporterPlugin.teardown).toBeDefined();
    expect(consoleReporterPlugin.extensions.reporter).toBeDefined();
  });

  test("setup() reads config.verbose", async () => {
    await consoleReporterPlugin.setup?.({ verbose: true });
    expect(consoleOutput.some(line => line.includes("verbose mode enabled"))).toBe(true);

    consoleOutput = [];
    await consoleReporterPlugin.setup?.({ verbose: false });
    expect(consoleOutput.some(line => line.includes("verbose mode enabled"))).toBe(false);
  });

  test("setup() defaults verbose to false", async () => {
    await consoleReporterPlugin.setup?.({});
    expect(consoleOutput.some(line => line.includes("verbose mode enabled"))).toBe(false);
  });

  test("onRunStart prints banner with run details", async () => {
    const event: RunStartEvent = {
      runId: "run-123",
      feature: "test-feature",
      totalStories: 5,
      startTime: "2026-02-27T10:00:00Z",
    };

    const reporter = consoleReporterPlugin.extensions.reporter;
    await reporter?.onRunStart?.(event);

    const output = consoleOutput.join("\n");
    expect(output).toContain("Starting Run: test-feature");
    expect(output).toContain("Run ID: run-123");
    expect(output).toContain("Total Stories: 5");
    expect(output).toContain("Start Time: 2026-02-27T10:00:00Z");
    expect(output).toContain("=".repeat(60));
  });

  test("onStoryComplete prints status line with ✓ for completed", async () => {
    const event: StoryCompleteEvent = {
      runId: "run-123",
      storyId: "US-001",
      status: "completed",
      durationMs: 1500,
      cost: 0.0123,
      tier: "balanced",
      testStrategy: "three-session-tdd",
    };

    const reporter = consoleReporterPlugin.extensions.reporter;
    await reporter?.onStoryComplete?.(event);

    const output = consoleOutput.join("\n");
    expect(output).toContain("✓");
    expect(output).toContain("US-001");
    expect(output).toContain("Tier: balanced");
    expect(output).toContain("Strategy: three-session-tdd");
    expect(output).toContain("Duration: 1500ms");
    expect(output).toContain("Cost: $0.0123");
  });

  test("onStoryComplete prints status line with ✗ for failed", async () => {
    const event: StoryCompleteEvent = {
      runId: "run-123",
      storyId: "US-002",
      status: "failed",
      durationMs: 2500,
      cost: 0.0456,
      tier: "powerful",
      testStrategy: "three-session-tdd-lite",
    };

    const reporter = consoleReporterPlugin.extensions.reporter;
    await reporter?.onStoryComplete?.(event);

    const output = consoleOutput.join("\n");
    expect(output).toContain("✗");
    expect(output).toContain("US-002");
    expect(output).toContain("Tier: powerful");
    expect(output).toContain("Strategy: three-session-tdd-lite");
  });

  test("onRunEnd prints summary table", async () => {
    const event: RunEndEvent = {
      runId: "run-123",
      totalDurationMs: 5000,
      totalCost: 0.0789,
      storySummary: {
        completed: 3,
        failed: 1,
        skipped: 0,
        paused: 1,
      },
    };

    const reporter = consoleReporterPlugin.extensions.reporter;
    await reporter?.onRunEnd?.(event);

    const output = consoleOutput.join("\n");
    expect(output).toContain("Run Summary");
    expect(output).toContain("Run ID: run-123");
    expect(output).toContain("Completed: 3/5");
    expect(output).toContain("Failed:    1/5");
    expect(output).toContain("Skipped:   0/5");
    expect(output).toContain("Paused:    1/5");
    expect(output).toContain("Total Duration: 5.00s");
    expect(output).toContain("Total Cost:     $0.0789");
  });

  test("verbose mode adds extra output in onStoryComplete", async () => {
    await consoleReporterPlugin.setup?.({ verbose: true });
    consoleOutput = [];

    const event: StoryCompleteEvent = {
      runId: "run-123",
      storyId: "US-001",
      status: "completed",
      durationMs: 1500,
      cost: 0.0123,
      tier: "balanced",
      testStrategy: "three-session-tdd",
    };

    const reporter = consoleReporterPlugin.extensions.reporter;
    await reporter?.onStoryComplete?.(event);

    const output = consoleOutput.join("\n");
    expect(output).toContain("[verbose]");
    expect(output).toContain("Run ID: run-123");
    expect(output).toContain("Status: completed");
  });

  test("verbose mode adds extra output in onRunEnd", async () => {
    await consoleReporterPlugin.setup?.({ verbose: true });
    consoleOutput = [];

    const event: RunEndEvent = {
      runId: "run-123",
      totalDurationMs: 5000,
      totalCost: 0.0789,
      storySummary: {
        completed: 3,
        failed: 1,
        skipped: 0,
        paused: 1,
      },
    };

    const reporter = consoleReporterPlugin.extensions.reporter;
    await reporter?.onRunEnd?.(event);

    const output = consoleOutput.join("\n");
    expect(output).toContain("Run completed in verbose mode");
  });

  test("reporter has required methods", () => {
    const reporter = consoleReporterPlugin.extensions.reporter;
    expect(reporter?.name).toBe("console-reporter");
    expect(typeof reporter?.onRunStart).toBe("function");
    expect(typeof reporter?.onStoryComplete).toBe("function");
    expect(typeof reporter?.onRunEnd).toBe("function");
  });

  test("teardown completes without errors", async () => {
    await expect(consoleReporterPlugin.teardown?.()).resolves.toBeUndefined();
  });
});
