/**
 * Curator Config Schema Tests
 */

import { describe, expect, test } from "bun:test";
import { CuratorConfigSchema, CuratorThresholdsSchema } from "../../../src/config/schemas-infra";

describe("CuratorThresholdsSchema", () => {
  test("should parse valid thresholds", () => {
    const data = {
      repeatedFinding: 3,
      emptyKeyword: 2,
      rectifyAttempts: 3,
      escalationChain: 2,
      staleChunkRuns: 5,
      unchangedOutcome: 2,
    };

    const result = CuratorThresholdsSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.repeatedFinding).toBe(3);
      expect(result.data.emptyKeyword).toBe(2);
    }
  });

  test("should provide default values for missing thresholds", () => {
    const result = CuratorThresholdsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.repeatedFinding).toBe(2);
      expect(result.data.emptyKeyword).toBe(2);
      expect(result.data.rectifyAttempts).toBe(2);
      expect(result.data.escalationChain).toBe(2);
      expect(result.data.staleChunkRuns).toBe(2);
      expect(result.data.unchangedOutcome).toBe(2);
    }
  });

  test("should reject negative values", () => {
    const data = {
      repeatedFinding: -1,
      emptyKeyword: 2,
      rectifyAttempts: 3,
      escalationChain: 2,
      staleChunkRuns: 5,
      unchangedOutcome: 2,
    };

    const result = CuratorThresholdsSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  test("should reject non-integer values", () => {
    const data = {
      repeatedFinding: 3.5,
      emptyKeyword: 2,
      rectifyAttempts: 3,
      escalationChain: 2,
      staleChunkRuns: 5,
      unchangedOutcome: 2,
    };

    const result = CuratorThresholdsSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});

describe("CuratorConfigSchema", () => {
  test("should parse minimal curator config", () => {
    const data = {};
    const result = CuratorConfigSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  test("should have enabled field with default true", () => {
    const result = CuratorConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
    }
  });

  test("should parse enabled: false", () => {
    const data = { enabled: false };
    const result = CuratorConfigSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
    }
  });

  test("should parse rollupPath", () => {
    const data = { rollupPath: "/home/user/.nax/global/curator/rollup.jsonl" };
    const result = CuratorConfigSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rollupPath).toBe("/home/user/.nax/global/curator/rollup.jsonl");
    }
  });

  test("should accept rollupPath starting with ~/", () => {
    const data = { rollupPath: "~/.nax/global/curator/rollup.jsonl" };
    const result = CuratorConfigSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  test("should reject rollupPath with relative path", () => {
    const data = { rollupPath: "relative/path/rollup.jsonl" };
    const result = CuratorConfigSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  test("should parse thresholds", () => {
    const data = {
      thresholds: {
        repeatedFinding: 5,
        emptyKeyword: 3,
        rectifyAttempts: 4,
        escalationChain: 3,
        staleChunkRuns: 6,
        unchangedOutcome: 3,
      },
    };
    const result = CuratorConfigSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.thresholds.repeatedFinding).toBe(5);
    }
  });

  test("should provide default thresholds when missing", () => {
    const result = CuratorConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.thresholds).toBeDefined();
      expect(result.data.thresholds.repeatedFinding).toBe(2);
      expect(result.data.thresholds.emptyKeyword).toBe(2);
    }
  });

  test("should support full curator config", () => {
    const data = {
      enabled: true,
      rollupPath: "/home/user/.nax/curator/rollup.jsonl",
      thresholds: {
        repeatedFinding: 4,
        emptyKeyword: 2,
        rectifyAttempts: 3,
        escalationChain: 2,
        staleChunkRuns: 5,
        unchangedOutcome: 2,
      },
    };
    const result = CuratorConfigSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.rollupPath).toBe("/home/user/.nax/curator/rollup.jsonl");
      expect(result.data.thresholds.repeatedFinding).toBe(4);
    }
  });
});
