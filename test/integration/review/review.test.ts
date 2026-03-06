/**
 * Review Phase Tests
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview } from "../../../src/review";
import type { ReviewConfig } from "../../../src/review";

describe("Review Phase", () => {
  test("runReview - all checks pass", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nax-review-test-"));

    const config: ReviewConfig = {
      enabled: true,
      checks: ["test"],
      commands: {
        test: "echo 'Tests passed'",
      },
    };

    const result = await runReview(config, tempDir);

    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].check).toBe("test");
    expect(result.checks[0].success).toBe(true);
    expect(result.checks[0].exitCode).toBe(0);
    expect(result.failureReason).toBeUndefined();
  });

  test("runReview - check fails", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nax-review-test-"));

    const config: ReviewConfig = {
      enabled: true,
      checks: ["typecheck"],
      commands: {
        typecheck: "sh -c 'exit 1'",
      },
    };

    const result = await runReview(config, tempDir);

    expect(result.success).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].check).toBe("typecheck");
    expect(result.checks[0].success).toBe(false);
    expect(result.checks[0].exitCode).not.toBe(0);
    expect(result.failureReason).toContain("typecheck failed");
  });

  test("runReview - multiple checks, stop on first failure", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nax-review-test-"));

    const config: ReviewConfig = {
      enabled: true,
      checks: ["typecheck", "lint", "test"],
      commands: {
        typecheck: "echo 'typecheck ok'",
        lint: "sh -c 'exit 1'",
        test: "echo 'test ok'",
      },
    };

    const result = await runReview(config, tempDir);

    expect(result.success).toBe(false);
    // Should only run typecheck and lint, not test (fail-fast)
    expect(result.checks).toHaveLength(2);
    expect(result.checks[0].check).toBe("typecheck");
    expect(result.checks[0].success).toBe(true);
    expect(result.checks[1].check).toBe("lint");
    expect(result.checks[1].success).toBe(false);
    expect(result.failureReason).toContain("lint failed");
  });

  test("runReview - uses review config commands when specified", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nax-review-test-"));

    const config: ReviewConfig = {
      enabled: true,
      checks: ["test"],
      commands: {
        test: "echo 'custom test command'",
      },
    };

    const result = await runReview(config, tempDir);

    // Custom command from config.review.commands
    expect(result.checks[0].command).toBe("echo 'custom test command'");
  });

  test("runReview - empty checks array", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nax-review-test-"));

    const config: ReviewConfig = {
      enabled: true,
      checks: [],
      commands: {},
    };

    const result = await runReview(config, tempDir);

    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(0);
    expect(result.failureReason).toBeUndefined();
  });

  test("runReview - captures command output", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nax-review-test-"));

    const config: ReviewConfig = {
      enabled: true,
      checks: ["test"],
      commands: {
        test: "echo 'Test output line 1' && echo 'Test output line 2'",
      },
    };

    const result = await runReview(config, tempDir);

    expect(result.success).toBe(true);
    expect(result.checks[0].output).toContain("Test output line 1");
    expect(result.checks[0].output).toContain("Test output line 2");
  });

  test("runReview - records duration", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nax-review-test-"));

    const config: ReviewConfig = {
      enabled: true,
      checks: ["test"],
      commands: {
        test: "echo 'done'",
      },
    };

    const result = await runReview(config, tempDir);

    expect(result.success).toBe(true);
    expect(result.checks[0].durationMs).toBeGreaterThan(0);
    expect(result.totalDurationMs).toBeGreaterThan(0);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(result.checks[0].durationMs);
  });
});
