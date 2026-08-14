import { describe, expect, test } from "bun:test";
import { formatJsonl } from "@/logger";
import type { LogEntry } from "@/logger";

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: "2026-02-20T10:30:00.123Z",
    level: "info",
    stage: "routing",
    message: "Task classified",
    ...overrides,
  };
}

describe("formatJsonl", () => {
  test("serializes a normal entry as a single-line JSON string", () => {
    const line = formatJsonl(makeEntry({ data: { complexity: "simple" } }));
    const parsed = JSON.parse(line);
    expect(parsed.stage).toBe("routing");
    expect(parsed.data.complexity).toBe("simple");
  });

  // MED-02: plain JSON.stringify throws "Do not know how to serialize a
  // BigInt" — a single log line with one lost the whole entry.
  describe("BigInt values (MED-02)", () => {
    test("does not throw when data contains a top-level BigInt", () => {
      const entry = makeEntry({ data: { count: 10n } });

      expect(() => formatJsonl(entry)).not.toThrow();
      const parsed = JSON.parse(formatJsonl(entry));
      expect(parsed.data.count).toBe("[BigInt] 10");
    });

    test("does not throw when a BigInt is nested inside an array", () => {
      const entry = makeEntry({ data: { ids: [1n, 2n, 3n] } });

      expect(() => formatJsonl(entry)).not.toThrow();
      const parsed = JSON.parse(formatJsonl(entry));
      expect(parsed.data.ids).toEqual(["[BigInt] 1", "[BigInt] 2", "[BigInt] 3"]);
    });

    test("preserves the rest of the entry alongside the coerced BigInt", () => {
      const entry = makeEntry({ storyId: "US-001", data: { count: 5n, label: "ok" } });

      const parsed = JSON.parse(formatJsonl(entry));
      expect(parsed.storyId).toBe("US-001");
      expect(parsed.data.label).toBe("ok");
      expect(parsed.data.count).toBe("[BigInt] 5");
    });
  });

  describe("circular references", () => {
    test("does not throw and produces a fallback line instead of losing the entry", () => {
      const circular: Record<string, unknown> = { name: "story" };
      circular.self = circular;
      const entry = makeEntry({ data: circular });

      expect(() => formatJsonl(entry)).not.toThrow();
      const parsed = JSON.parse(formatJsonl(entry));
      expect(parsed.level).toBe("error");
      expect(parsed.message).toBe("Failed to serialize log entry");
      expect(parsed.data.originalMessage).toBe("Task classified");
    });
  });
});
