import { describe, expect, test } from "bun:test";
import { formatProgress } from "../src/execution/helpers";
import type { StoryCounts } from "../src/execution/helpers";

describe("formatProgress", () => {
  test("formats progress with all stories pending", () => {
    const counts: StoryCounts = {
      total: 12,
      passed: 0,
      failed: 0,
      pending: 12,
    };

    const progress = formatProgress(counts, 0, 5.0, 0, 12);

    expect(progress).toContain("0/12 stories");
    expect(progress).toContain("✅ 0 passed");
    expect(progress).toContain("❌ 0 failed");
    expect(progress).toContain("$0.00/$5.00");
    expect(progress).toContain("calculating...");
  });

  test("formats progress with some stories completed", () => {
    const counts: StoryCounts = {
      total: 12,
      passed: 5,
      failed: 1,
      pending: 6,
    };

    // 10 minutes elapsed (600000 ms), 6 stories completed
    // avg = 600000 / 6 = 100000 ms per story
    // remaining = 6 stories * 100000 = 600000 ms = 10 minutes
    const progress = formatProgress(counts, 0.45, 5.0, 600000, 12);

    expect(progress).toContain("6/12 stories");
    expect(progress).toContain("✅ 5 passed");
    expect(progress).toContain("❌ 1 failed");
    expect(progress).toContain("$0.45/$5.00");
    expect(progress).toContain("~10 min remaining");
  });

  test("formats progress when all stories are complete", () => {
    const counts: StoryCounts = {
      total: 12,
      passed: 10,
      failed: 2,
      pending: 0,
    };

    const progress = formatProgress(counts, 1.23, 5.0, 1200000, 12);

    expect(progress).toContain("12/12 stories");
    expect(progress).toContain("✅ 10 passed");
    expect(progress).toContain("❌ 2 failed");
    expect(progress).toContain("$1.23/$5.00");
    expect(progress).toContain("complete");
  });

  test("calculates ETA correctly for fast stories", () => {
    const counts: StoryCounts = {
      total: 20,
      passed: 10,
      failed: 0,
      pending: 10,
    };

    // 2 minutes elapsed (120000 ms) for 10 stories
    // avg = 120000 / 10 = 12000 ms per story
    // remaining = 10 stories * 12000 = 120000 ms = 2 minutes
    const progress = formatProgress(counts, 0.5, 10.0, 120000, 20);

    expect(progress).toContain("~2 min remaining");
  });

  test("rounds ETA to nearest minute", () => {
    const counts: StoryCounts = {
      total: 10,
      passed: 3,
      failed: 0,
      pending: 7,
    };

    // 8.5 minutes elapsed (510000 ms) for 3 stories
    // avg = 510000 / 3 = 170000 ms per story
    // remaining = 7 stories * 170000 = 1190000 ms ≈ 19.8 minutes → rounds to 20
    const progress = formatProgress(counts, 0.3, 5.0, 510000, 10);

    expect(progress).toContain("~20 min remaining");
  });

  test("includes cost information with proper formatting", () => {
    const counts: StoryCounts = {
      total: 5,
      passed: 2,
      failed: 0,
      pending: 3,
    };

    const progress = formatProgress(counts, 1.2345, 10.0, 300000, 5);

    // Should round cost to 2 decimal places
    expect(progress).toContain("$1.23/$10.00");
  });

  test("handles zero elapsed time gracefully", () => {
    const counts: StoryCounts = {
      total: 10,
      passed: 0,
      failed: 0,
      pending: 10,
    };

    const progress = formatProgress(counts, 0, 5.0, 0, 10);

    expect(progress).toContain("calculating...");
    expect(progress).not.toContain("NaN");
    expect(progress).not.toContain("Infinity");
  });

  test("includes all required emoji indicators", () => {
    const counts: StoryCounts = {
      total: 10,
      passed: 3,
      failed: 1,
      pending: 6,
    };

    const progress = formatProgress(counts, 0.5, 5.0, 300000, 10);

    expect(progress).toContain("📊"); // Progress emoji
    expect(progress).toContain("✅"); // Passed emoji
    expect(progress).toContain("❌"); // Failed emoji
    expect(progress).toContain("💰"); // Cost emoji
    expect(progress).toContain("⏱️"); // Time emoji
  });
});
