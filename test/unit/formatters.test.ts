import { describe, expect, test } from "bun:test";
import { formatConsole, formatJsonl } from "../../src/logger/formatters.js";
import type { LogEntry } from "../../src/logger/types.js";

describe("formatConsole", () => {
  test("formats basic log entry with timestamp, stage, and message", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-20T10:30:00.123Z",
      level: "info",
      stage: "routing",
      message: "Task classified",
    };

    const output = formatConsole(entry);

    // Should contain timestamp in HH:MM:SS format
    expect(output).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
    expect(output).toContain("[routing]");
    expect(output).toContain("Task classified");
  });

  test("includes storyId when present", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-20T10:30:00.123Z",
      level: "info",
      stage: "agent.start",
      storyId: "user-auth-001",
      message: "Starting agent session",
    };

    const output = formatConsole(entry);

    expect(output).toContain("[user-auth-001]");
    expect(output).toContain("Starting agent session");
  });

  test("omits storyId when not present", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-20T10:30:00.123Z",
      level: "info",
      stage: "routing",
      message: "Task classified",
    };

    const output = formatConsole(entry);

    // Should not contain brackets around storyId
    const bracketCount = (output.match(/\[/g) || []).length;
    expect(bracketCount).toBe(2); // Only timestamp and stage
  });

  test("formats data as pretty JSON on new line", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-20T10:30:00.123Z",
      level: "info",
      stage: "routing",
      message: "Task classified",
      data: {
        complexity: "simple",
        model: "claude-sonnet-4-5",
      },
    };

    const output = formatConsole(entry);

    expect(output).toContain("complexity");
    expect(output).toContain("simple");
    expect(output).toContain("model");
    expect(output).toContain("claude-sonnet-4-5");
    // Data should be on separate line
    expect(output).toContain("\n");
  });

  test("omits data section when data is undefined", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-20T10:30:00.123Z",
      level: "info",
      stage: "routing",
      message: "Task classified",
    };

    const output = formatConsole(entry);

    expect(output).not.toContain("complexity");
    expect(output.split("\n").length).toBe(1); // Single line
  });

  test("omits data section when data is empty object", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-20T10:30:00.123Z",
      level: "info",
      stage: "routing",
      message: "Task classified",
      data: {},
    };

    const output = formatConsole(entry);

    expect(output.split("\n").length).toBe(1); // Single line
  });

  test("applies formatting for error level", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-20T10:30:00.123Z",
      level: "error",
      stage: "agent.error",
      message: "Agent failed",
    };

    const output = formatConsole(entry);

    // Should contain all required components
    expect(output).toContain("[agent.error]");
    expect(output).toContain("Agent failed");
  });

  test("applies formatting for warn level", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-20T10:30:00.123Z",
      level: "warn",
      stage: "verification",
      message: "Tests failed",
    };

    const output = formatConsole(entry);

    // Should contain all required components
    expect(output).toContain("[verification]");
    expect(output).toContain("Tests failed");
  });

  test("applies formatting for info level", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-20T10:30:00.123Z",
      level: "info",
      stage: "routing",
      message: "Task classified",
    };

    const output = formatConsole(entry);

    // Should contain all required components
    expect(output).toContain("[routing]");
    expect(output).toContain("Task classified");
  });

  test("applies formatting for debug level", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-20T10:30:00.123Z",
      level: "debug",
      stage: "context",
      message: "Building context",
    };

    const output = formatConsole(entry);

    // Should contain all required components
    expect(output).toContain("[context]");
    expect(output).toContain("Building context");
  });

  test("formats complex nested data structures", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-20T10:30:00.123Z",
      level: "info",
      stage: "routing",
      message: "Complex data",
      data: {
        nested: {
          array: [1, 2, 3],
          object: { key: "value" },
        },
        number: 42,
        boolean: true,
        null: null,
      },
    };

    const output = formatConsole(entry);

    expect(output).toContain("nested");
    expect(output).toContain("array");
    expect(output).toContain("object");
    expect(output).toContain("number");
    expect(output).toContain("42");
    expect(output).toContain("true");
    expect(output).toContain("null");
  });

  test("handles timestamps in different formats", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-20T23:59:59.999Z",
      level: "info",
      stage: "test",
      message: "Late night message",
    };

    const output = formatConsole(entry);

    // Should format timestamp correctly (depends on local timezone)
    expect(output).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
  });

  test("formats complete log entry with all fields", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-20T10:30:00.123Z",
      level: "info",
      stage: "agent.complete",
      storyId: "user-auth-001",
      message: "Agent completed successfully",
      data: {
        duration: 45.2,
        cost: 0.12,
        model: "claude-sonnet-4-5",
      },
    };

    const output = formatConsole(entry);

    expect(output).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
    expect(output).toContain("[agent.complete]");
    expect(output).toContain("[user-auth-001]");
    expect(output).toContain("Agent completed successfully");
    expect(output).toContain("duration");
    expect(output).toContain("45.2");
    expect(output).toContain("cost");
    expect(output).toContain("0.12");
    expect(output).toContain("claude-sonnet-4-5");
  });
});

describe("formatJsonl", () => {
  test("formats basic log entry as single-line JSON", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-20T10:30:00.123Z",
      level: "info",
      stage: "routing",
      message: "Task classified",
    };

    const output = formatJsonl(entry);

    // Should be single line
    expect(output).not.toContain("\n");

    // Should be valid JSON
    const parsed = JSON.parse(output);
    expect(parsed).toEqual(entry);
  });

  test("includes all fields when present", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-20T10:30:00.123Z",
      level: "info",
      stage: "agent.start",
      storyId: "user-auth-001",
      message: "Starting agent",
      data: { model: "claude-sonnet-4-5" },
    };

    const output = formatJsonl(entry);

    const parsed = JSON.parse(output);
    expect(parsed.timestamp).toBe("2026-02-20T10:30:00.123Z");
    expect(parsed.level).toBe("info");
    expect(parsed.stage).toBe("agent.start");
    expect(parsed.storyId).toBe("user-auth-001");
    expect(parsed.message).toBe("Starting agent");
    expect(parsed.data).toEqual({ model: "claude-sonnet-4-5" });
  });

  test("omits optional fields when not present", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-20T10:30:00.123Z",
      level: "info",
      stage: "routing",
      message: "Task classified",
    };

    const output = formatJsonl(entry);

    const parsed = JSON.parse(output);
    expect(parsed.timestamp).toBe("2026-02-20T10:30:00.123Z");
    expect(parsed.level).toBe("info");
    expect(parsed.stage).toBe("routing");
    expect(parsed.message).toBe("Task classified");
    expect(parsed.storyId).toBeUndefined();
    expect(parsed.data).toBeUndefined();
  });

  test("preserves complex data structures", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-20T10:30:00.123Z",
      level: "info",
      stage: "test",
      message: "Complex data",
      data: {
        nested: {
          array: [1, 2, 3],
          object: { key: "value" },
        },
        number: 42,
        boolean: true,
        null: null,
      },
    };

    const output = formatJsonl(entry);

    const parsed = JSON.parse(output);
    expect(parsed.data).toEqual(entry.data);
    expect(parsed.data.nested.array).toEqual([1, 2, 3]);
    expect(parsed.data.nested.object).toEqual({ key: "value" });
    expect(parsed.data.number).toBe(42);
    expect(parsed.data.boolean).toBe(true);
    expect(parsed.data.null).toBe(null);
  });

  test("handles all log levels", () => {
    const levels: Array<"error" | "warn" | "info" | "debug"> = ["error", "warn", "info", "debug"];

    for (const level of levels) {
      const entry: LogEntry = {
        timestamp: "2026-02-20T10:30:00.123Z",
        level,
        stage: "test",
        message: `${level} message`,
      };

      const output = formatJsonl(entry);
      const parsed = JSON.parse(output);

      expect(parsed.level).toBe(level);
    }
  });

  test("escapes special characters in strings", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-20T10:30:00.123Z",
      level: "info",
      stage: "test",
      message: 'Message with "quotes" and \n newlines',
      data: {
        text: "Special chars: \t\r\n\"'\\",
      },
    };

    const output = formatJsonl(entry);

    // Should be valid JSON despite special characters
    const parsed = JSON.parse(output);
    expect(parsed.message).toBe('Message with "quotes" and \n newlines');
    expect(parsed.data.text).toBe("Special chars: \t\r\n\"'\\");
  });

  test("handles empty data object", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-20T10:30:00.123Z",
      level: "info",
      stage: "test",
      message: "Empty data",
      data: {},
    };

    const output = formatJsonl(entry);

    const parsed = JSON.parse(output);
    expect(parsed.data).toEqual({});
  });

  test("produces consistent output for same input", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-20T10:30:00.123Z",
      level: "info",
      stage: "routing",
      message: "Task classified",
      data: { complexity: "simple" },
    };

    const output1 = formatJsonl(entry);
    const output2 = formatJsonl(entry);

    expect(output1).toBe(output2);
  });

  test("formats complete log entry with all fields", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-20T10:30:00.123Z",
      level: "debug",
      stage: "context.built",
      storyId: "user-auth-001",
      message: "Context built successfully",
      data: {
        fileCount: 12,
        totalLines: 1234,
        relevantModules: ["auth", "user", "session"],
      },
    };

    const output = formatJsonl(entry);

    // Verify it's valid JSON
    expect(() => JSON.parse(output)).not.toThrow();

    // Verify all fields preserved
    const parsed = JSON.parse(output);
    expect(parsed).toEqual(entry);
  });

  test("handles unicode characters correctly", () => {
    const entry: LogEntry = {
      timestamp: "2026-02-20T10:30:00.123Z",
      level: "info",
      stage: "test",
      message: "Unicode: 你好 🚀 émojis",
      data: {
        emoji: "✅",
        chinese: "测试",
        accent: "café",
      },
    };

    const output = formatJsonl(entry);

    const parsed = JSON.parse(output);
    expect(parsed.message).toBe("Unicode: 你好 🚀 émojis");
    expect(parsed.data.emoji).toBe("✅");
    expect(parsed.data.chinese).toBe("测试");
    expect(parsed.data.accent).toBe("café");
  });

  test("multiple JSONL lines are independently parseable", () => {
    const entries: LogEntry[] = [
      {
        timestamp: "2026-02-20T10:30:00.123Z",
        level: "info",
        stage: "routing",
        message: "First entry",
      },
      {
        timestamp: "2026-02-20T10:30:01.456Z",
        level: "debug",
        stage: "context",
        message: "Second entry",
        data: { test: true },
      },
      {
        timestamp: "2026-02-20T10:30:02.789Z",
        level: "error",
        stage: "agent.error",
        storyId: "story-123",
        message: "Third entry",
      },
    ];

    const lines = entries.map((entry) => formatJsonl(entry));

    // Each line should be independently parseable
    lines.forEach((line, index) => {
      const parsed = JSON.parse(line);
      expect(parsed).toEqual(entries[index]);
    });

    // Concatenated lines should be parseable as JSONL
    const jsonlContent = lines.join("\n");
    const parsedLines = jsonlContent.split("\n").map((line) => JSON.parse(line));
    expect(parsedLines).toEqual(entries);
  });
});
