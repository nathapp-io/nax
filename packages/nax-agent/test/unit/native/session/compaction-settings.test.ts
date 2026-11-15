import { describe, expect, test } from "bun:test";
import {
  compactionSettingsSchema,
  DEFAULT_COMPACTION,
  resolveCompaction,
} from "#src/native/session/compaction-settings";

describe("compaction settings", () => {
  test("the defaults are enabled at 90% with 30% kept", () => {
    expect(DEFAULT_COMPACTION).toEqual({ enabled: true, compactAtPercent: 90, keepRecentPercent: 30 });
  });

  test("resolveCompaction applies the defaults to an absent or partial input", () => {
    expect(resolveCompaction()).toEqual(DEFAULT_COMPACTION);
    expect(resolveCompaction(undefined)).toEqual(DEFAULT_COMPACTION);
    expect(resolveCompaction({})).toEqual(DEFAULT_COMPACTION);
    expect(resolveCompaction({ enabled: false })).toEqual({ ...DEFAULT_COMPACTION, enabled: false });
    expect(resolveCompaction({ compactAtPercent: 80 })).toEqual({ ...DEFAULT_COMPACTION, compactAtPercent: 80 });
  });

  test("resolveCompaction does not hand out the shared default object", () => {
    expect(resolveCompaction()).not.toBe(DEFAULT_COMPACTION);
  });

  test("compactAtPercent must be an integer from 50 to 99", () => {
    for (const compactAtPercent of [49, 100, 75.5]) {
      expect(compactionSettingsSchema.safeParse({ compactAtPercent }).success).toBe(false);
    }
    expect(compactionSettingsSchema.safeParse({ compactAtPercent: 50, keepRecentPercent: 30 }).success).toBe(true);
    expect(compactionSettingsSchema.safeParse({ compactAtPercent: 99 }).success).toBe(true);
  });

  test("keepRecentPercent must be an integer from 5 to 79", () => {
    for (const keepRecentPercent of [4, 80, 10.5]) {
      expect(compactionSettingsSchema.safeParse({ compactAtPercent: 99, keepRecentPercent }).success).toBe(false);
    }
    expect(compactionSettingsSchema.safeParse({ keepRecentPercent: 5 }).success).toBe(true);
    expect(compactionSettingsSchema.safeParse({ compactAtPercent: 99, keepRecentPercent: 79 }).success).toBe(true);
  });

  test("keepRecentPercent must sit at least 20 points below compactAtPercent", () => {
    const bad = compactionSettingsSchema.safeParse({ compactAtPercent: 50, keepRecentPercent: 60 });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toBe("keepRecentPercent must be at least 20 points below compactAtPercent");
    expect(compactionSettingsSchema.safeParse({ compactAtPercent: 90, keepRecentPercent: 70 }).success).toBe(true);
    expect(compactionSettingsSchema.safeParse({ compactAtPercent: 90, keepRecentPercent: 71 }).success).toBe(false);
  });

  test("resolveCompaction throws on an invalid input", () => {
    expect(() => resolveCompaction({ compactAtPercent: 10 })).toThrow();
  });

  test("a non-boolean enabled is rejected", () => {
    expect(compactionSettingsSchema.safeParse({ enabled: "yes" }).success).toBe(false);
  });

  test("AC-10: resolveCompaction carries an explicit token cap with the default percentages", () => {
    expect(resolveCompaction({ compactAtTokens: 200_000 })).toEqual({
      ...DEFAULT_COMPACTION,
      compactAtTokens: 200_000,
    });
  });

  test("AC-11: resolveCompaction(undefined) has no token cap", () => {
    expect(resolveCompaction(undefined)).not.toHaveProperty("compactAtTokens");
  });

  test("AC-12: a negative token cap is rejected", () => {
    expect(compactionSettingsSchema.safeParse({ compactAtTokens: -1 }).success).toBe(false);
  });

  test("AC-13: a cap below the minimum is rejected with the documented message", () => {
    const bad = compactionSettingsSchema.safeParse({ compactAtTokens: 5_000 });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toBe("compactAtTokens must be 0 (off) or at least 10000");
  });

  test("AC-14: a cap of 0 (off) is accepted", () => {
    expect(compactionSettingsSchema.safeParse({ compactAtTokens: 0 }).success).toBe(true);
    expect(compactionSettingsSchema.safeParse({ compactAtTokens: 10_000 }).success).toBe(true);
    expect(compactionSettingsSchema.safeParse({ compactAtTokens: 10_000.5 }).success).toBe(false);
  });
});
