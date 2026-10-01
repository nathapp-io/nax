import { describe, expect, test } from "bun:test";
import type { LogEntry } from "@/logger";
import { formatConsole, formatJsonl } from "@/logger";

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

// STYLE-21: legacy console formatters must strip ESC/control bytes from
// agent-controlled or PRD-authored display strings before they reach stdout
// (see src/log-format/formatter.ts:285 for the hardened path).
describe("formatConsole (STYLE-21)", () => {
  test("strips an OSC escape sequence from entry.message", () => {
    const entry = makeEntry({ message: "before\x1b]0;evil\x07after" });
    const out = formatConsole(entry);
    expect(out).not.toContain("\x1b");
    expect(out).toContain("beforeafter");
  });

  test("strips a CSI cursor-move sequence from entry.message", () => {
    const entry = makeEntry({ message: "ok\x1b[2Jdone" });
    const out = formatConsole(entry);
    expect(out).not.toContain("\x1b");
    expect(out).toContain("okdone");
  });

  test("preserves ordinary whitespace (tab, newline, CR) inside message", () => {
    const entry = makeEntry({ message: "line1\nline2\tcol\r" });
    const out = formatConsole(entry);
    expect(out).toContain("line1\nline2\tcol\r");
  });
});
