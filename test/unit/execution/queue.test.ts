import { describe, expect, test } from "bun:test";
import { parseQueueFile } from "@/queue/manager";

describe("parseQueueFile", () => {
  test("parses PAUSE command (case-insensitive)", () => {
    const content = "PAUSE\n";
    const result = parseQueueFile(content);

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toEqual({ type: "PAUSE" });
    expect(result.guidance).toHaveLength(0);
  });

  test("parses ABORT command (case-insensitive)", () => {
    const content = "abort\n";
    const result = parseQueueFile(content);

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toEqual({ type: "ABORT" });
    expect(result.guidance).toHaveLength(0);
  });

  test("parses SKIP command with story ID", () => {
    const content = "SKIP US-042\n";
    const result = parseQueueFile(content);

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toEqual({ type: "SKIP", storyId: "US-042" });
    expect(result.guidance).toHaveLength(0);
  });

  test("parses SKIP command case-insensitive", () => {
    const content = "skip US-001\n";
    const result = parseQueueFile(content);

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toEqual({ type: "SKIP", storyId: "US-001" });
  });

  test("parses multiple commands", () => {
    const content = "SKIP US-001\nSKIP US-002\nPAUSE\n";
    const result = parseQueueFile(content);

    expect(result.commands).toHaveLength(3);
    expect(result.commands[0]).toEqual({ type: "SKIP", storyId: "US-001" });
    expect(result.commands[1]).toEqual({ type: "SKIP", storyId: "US-002" });
    expect(result.commands[2]).toEqual({ type: "PAUSE" });
  });

  test("separates commands from guidance text", () => {
    const content = `--- PENDING ---
PAUSE
Some guidance text here
More guidance on another line`;

    const result = parseQueueFile(content);

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toEqual({ type: "PAUSE" });
    expect(result.guidance).toHaveLength(2);
    expect(result.guidance[0]).toBe("Some guidance text here");
    expect(result.guidance[1]).toBe("More guidance on another line");
  });

  test("mixed commands and guidance", () => {
    const content = `ABORT
--- PENDING ---
Focus on error handling
SKIP US-003
Ensure test coverage`;

    const result = parseQueueFile(content);

    expect(result.commands).toHaveLength(2);
    expect(result.commands[0]).toEqual({ type: "ABORT" });
    expect(result.commands[1]).toEqual({ type: "SKIP", storyId: "US-003" });
    expect(result.guidance).toHaveLength(2);
    expect(result.guidance[0]).toBe("Focus on error handling");
    expect(result.guidance[1]).toBe("Ensure test coverage");
  });

  test("empty content returns empty result", () => {
    const result = parseQueueFile("");

    expect(result.commands).toHaveLength(0);
    expect(result.guidance).toHaveLength(0);
  });

  test("only guidance text (no commands)", () => {
    const content = `--- PENDING ---
Just some guidance
No commands here`;

    const result = parseQueueFile(content);

    expect(result.commands).toHaveLength(0);
    expect(result.guidance).toHaveLength(2);
  });

  test("ignores whitespace-only lines", () => {
    const content = `PAUSE


ABORT
`;

    const result = parseQueueFile(content);

    expect(result.commands).toHaveLength(2);
    expect(result.commands[0]).toEqual({ type: "PAUSE" });
    expect(result.commands[1]).toEqual({ type: "ABORT" });
  });

  test("handles SKIP without story ID gracefully", () => {
    const content = "SKIP\n";
    const result = parseQueueFile(content);

    // Should treat as guidance text if no story ID provided
    expect(result.commands).toHaveLength(0);
    expect(result.guidance).toHaveLength(1);
  });

  test("trims whitespace from story IDs", () => {
    const content = "SKIP   US-042   \n";
    const result = parseQueueFile(content);

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toEqual({ type: "SKIP", storyId: "US-042" });
  });

  test("parses RETRY command with story ID", () => {
    const content = "RETRY US-042\n";
    const result = parseQueueFile(content);

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toEqual({ type: "RETRY", storyId: "US-042" });
  });

  test("parses RETRY command case-insensitive and trims story ID", () => {
    const content = "retry   US-001   \n";
    const result = parseQueueFile(content);

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toEqual({ type: "RETRY", storyId: "US-001" });
  });

  test("handles RETRY without story ID gracefully", () => {
    const content = "RETRY\n";
    const result = parseQueueFile(content);

    expect(result.commands).toHaveLength(0);
    expect(result.guidance).toHaveLength(1);
  });

  test("parses PRIORITY command with story ID and value", () => {
    const content = "PRIORITY US-042 10\n";
    const result = parseQueueFile(content);

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toEqual({ type: "PRIORITY", storyId: "US-042", value: 10 });
  });

  test("parses PRIORITY command case-insensitive with negative value", () => {
    const content = "priority US-001 -5\n";
    const result = parseQueueFile(content);

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toEqual({ type: "PRIORITY", storyId: "US-001", value: -5 });
  });

  test("handles PRIORITY with missing value gracefully", () => {
    const content = "PRIORITY US-001\n";
    const result = parseQueueFile(content);

    expect(result.commands).toHaveLength(0);
    expect(result.guidance).toHaveLength(1);
  });

  test("handles PRIORITY with non-numeric value gracefully", () => {
    const content = "PRIORITY US-001 high\n";
    const result = parseQueueFile(content);

    expect(result.commands).toHaveLength(0);
    expect(result.guidance).toHaveLength(1);
  });

  test("handles PRIORITY with no arguments gracefully", () => {
    const content = "PRIORITY\n";
    const result = parseQueueFile(content);

    expect(result.commands).toHaveLength(0);
    expect(result.guidance).toHaveLength(1);
  });

  test("parses INJECT command with a story file path", () => {
    const content = "INJECT .nax/inject/new-story.json\n";
    const result = parseQueueFile(content);

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toEqual({ type: "INJECT", storyFile: ".nax/inject/new-story.json" });
  });

  test("parses INJECT command case-insensitive and trims path", () => {
    const content = "inject   ./story.json   \n";
    const result = parseQueueFile(content);

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toEqual({ type: "INJECT", storyFile: "./story.json" });
  });

  test("handles INJECT without a file path gracefully", () => {
    const content = "INJECT\n";
    const result = parseQueueFile(content);

    expect(result.commands).toHaveLength(0);
    expect(result.guidance).toHaveLength(1);
  });
});
