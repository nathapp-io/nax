/**
 * `chat.compaction` (US-006, chat-job-panel): the chat session's own compaction
 * policy. Kept separate from the shared `execution.compaction` schema (US-005) --
 * the chat defaults must never be installed on that shared setting.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CHAT_COMPACT_AT_TOKENS,
  DEFAULT_CONFIG,
  DEFAULT_IDLE_COMPACT_AFTER_MINUTES,
  NaxConfigSchema,
} from "@/config";
import { ExecutionConfigSchema } from "@/config/schemas-execution";

/** Every issue path a rejected config reports, dotted -- the shape the operator sees. */
function issuePaths(input: unknown): string[] {
  const parsed = NaxConfigSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join("."));
}

/** The message at one issue path, for the cases where the wording is the contract. */
function issueMessage(input: unknown, path: string): string | undefined {
  const parsed = NaxConfigSchema.safeParse(input);
  if (parsed.success) return undefined;
  return parsed.error.issues.find((issue) => issue.path.join(".") === path)?.message;
}

describe("chat.compaction defaults", () => {
  test("AC-1: an empty compaction resolves compactAtTokens to 200000", () => {
    const parsed = NaxConfigSchema.parse({ chat: { compaction: {} } });
    expect(parsed.chat?.compaction?.compactAtTokens).toBe(200_000);
    expect(DEFAULT_CHAT_COMPACT_AT_TOKENS).toBe(200_000);
  });

  test("AC-2: an empty compaction resolves idleCompactAfterMinutes to 55", () => {
    const parsed = NaxConfigSchema.parse({ chat: { compaction: {} } });
    expect(parsed.chat?.compaction?.idleCompactAfterMinutes).toBe(55);
    expect(DEFAULT_IDLE_COMPACT_AFTER_MINUTES).toBe(55);
  });

  test("no chat block leaves the key absent, so chat defaults stay resolver-side", () => {
    expect(Object.hasOwn(NaxConfigSchema.parse({}), "chat")).toBe(false);
  });

  test("an explicit value wins over the default", () => {
    const parsed = NaxConfigSchema.parse({
      chat: { compaction: { compactAtTokens: 100_000, idleCompactAfterMinutes: 0 } },
    });
    expect(parsed.chat?.compaction).toEqual({ compactAtTokens: 100_000, idleCompactAfterMinutes: 0 });
  });
});

describe("chat.compaction validation", () => {
  test("AC-3: rejects idleCompactAfterMinutes 1441", () => {
    expect(issuePaths({ chat: { compaction: { idleCompactAfterMinutes: 1441 } } })).toContain(
      "chat.compaction.idleCompactAfterMinutes",
    );
  });

  test("AC-4: rejects compactAtTokens -5", () => {
    expect(issuePaths({ chat: { compaction: { compactAtTokens: -5 } } })).toContain("chat.compaction.compactAtTokens");
  });

  test("AC-5: rejects compactAtTokens 5000 naming the 10000 floor", () => {
    expect(issueMessage({ chat: { compaction: { compactAtTokens: 5_000 } } }, "chat.compaction.compactAtTokens")).toBe(
      "compactAtTokens must be 0 (off) or at least 10000",
    );
  });

  test("accepts 0 (off) and the exact floor for both fields", () => {
    const parsed = NaxConfigSchema.safeParse({
      chat: { compaction: { compactAtTokens: 10_000, idleCompactAfterMinutes: 0 } },
    });
    expect(parsed.success).toBe(true);
  });

  test("accepts the 1440 idle ceiling", () => {
    expect(NaxConfigSchema.safeParse({ chat: { compaction: { idleCompactAfterMinutes: 1440 } } }).success).toBe(true);
  });
});

describe("execution.compaction stays the shared setting", () => {
  /** The rest of ExecutionConfig's required fields, so only compaction is under test. */
  const base = {
    iterationDelayMs: 0,
    costLimit: 10,
    maxStoriesPerFeature: 10,
    rectification: {},
    regressionGate: {},
    smartTestRunner: {},
  };
  const executionDefault = structuredClone(DEFAULT_CONFIG.execution);

  test("AC-6: keeps an explicit execution compactAtTokens at 150000", () => {
    const parsed = NaxConfigSchema.parse({
      execution: {
        ...executionDefault,
        compaction: { enabled: true, compactAtPercent: 90, keepRecentPercent: 30, compactAtTokens: 150_000 },
      },
    });
    expect(parsed.execution.compaction.compactAtTokens).toBe(150_000);
  });

  test("does not install the chat default on execution.compaction", () => {
    // The chat cap is chat policy: the shared setting keeps its own defaults and gains no cap.
    const shared = ExecutionConfigSchema.parse(base).compaction;
    expect(shared).toEqual({ enabled: true, compactAtPercent: 90, keepRecentPercent: 30 });
    expect(shared).not.toHaveProperty("compactAtTokens");
  });
});
