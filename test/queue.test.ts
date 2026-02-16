import { describe, expect, test } from "bun:test";
import { QueueManager, parseQueueFile } from "../src/queue/manager";

describe("QueueManager", () => {
  test("enqueue and dequeue in priority order (highest first)", () => {
    const qm = new QueueManager();
    qm.enqueue("US-001", "Low priority", 1);
    qm.enqueue("US-002", "High priority", 10);
    qm.enqueue("US-003", "Medium priority", 5);

    const first = qm.dequeue();
    expect(first?.storyId).toBe("US-002"); // highest priority
  });

  test("peek returns next without removing", () => {
    const qm = new QueueManager();
    qm.enqueue("US-001", "Task", 1);

    expect(qm.peek()?.storyId).toBe("US-001");
    expect(qm.peek()?.storyId).toBe("US-001"); // still there
  });

  test("markComplete changes status", () => {
    const qm = new QueueManager();
    qm.enqueue("US-001", "Task", 1);
    qm.markComplete("US-001");

    const item = qm.getItem("US-001");
    expect(item?.status).toBe("completed");
    expect(qm.hasPending()).toBe(false);
  });

  test("markFailed stores error", () => {
    const qm = new QueueManager();
    qm.enqueue("US-001", "Task", 1);
    qm.markFailed("US-001", "Agent crashed");

    const item = qm.getItem("US-001");
    expect(item?.status).toBe("failed");
    expect(item?.error).toBe("Agent crashed");
  });

  test("empty queue returns null", () => {
    const qm = new QueueManager();
    expect(qm.dequeue()).toBeNull();
    expect(qm.peek()).toBeNull();
    expect(qm.isEmpty()).toBe(true);
  });

  test("getStats returns correct counts", () => {
    const qm = new QueueManager();
    qm.enqueue("US-001", "A", 1);
    qm.enqueue("US-002", "B", 2);
    qm.enqueue("US-003", "C", 3);
    qm.markComplete("US-001");
    qm.markFailed("US-002", "err");

    const stats = qm.getStats();
    expect(stats.total).toBe(3);
    expect(stats.pending).toBe(1);
    expect(stats.completed).toBe(1);
    expect(stats.failed).toBe(1);
  });

  test("throws on duplicate enqueue", () => {
    const qm = new QueueManager();
    qm.enqueue("US-001", "Task", 1);
    expect(() => qm.enqueue("US-001", "Dupe", 2)).toThrow("already in queue");
  });

  test("resetToPending allows retry", () => {
    const qm = new QueueManager();
    qm.enqueue("US-001", "Task", 1);
    qm.markFailed("US-001", "err");
    qm.resetToPending("US-001");

    expect(qm.getItem("US-001")?.status).toBe("pending");
    expect(qm.hasPending()).toBe(true);
  });

  test("markSkipped sets status to skipped", () => {
    const qm = new QueueManager();
    qm.enqueue("US-001", "Task", 1);
    qm.markSkipped("US-001");

    const item = qm.getItem("US-001");
    expect(item?.status).toBe("skipped");
    expect(item?.error).toBe("Skipped by user command");
    expect(item?.completedAt).toBeDefined();
  });

  test("getStats tracks skipped count separately", () => {
    const qm = new QueueManager();
    qm.enqueue("US-001", "A", 1);
    qm.enqueue("US-002", "B", 2);
    qm.enqueue("US-003", "C", 3);
    qm.enqueue("US-004", "D", 4);
    qm.markComplete("US-001");
    qm.markFailed("US-002", "err");
    qm.markSkipped("US-003");

    const stats = qm.getStats();
    expect(stats.total).toBe(4);
    expect(stats.pending).toBe(1);
    expect(stats.completed).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.skipped).toBe(1);
  });
});

describe("parseQueueFile", () => {
  test("parses PAUSE command (case-insensitive)", () => {
    const content = "PAUSE\n";
    const result = parseQueueFile(content);

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toBe("PAUSE");
    expect(result.guidance).toHaveLength(0);
  });

  test("parses ABORT command (case-insensitive)", () => {
    const content = "abort\n";
    const result = parseQueueFile(content);

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toBe("ABORT");
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
    expect(result.commands[2]).toBe("PAUSE");
  });

  test("separates commands from guidance text", () => {
    const content = `--- PENDING ---
PAUSE
Some guidance text here
More guidance on another line`;

    const result = parseQueueFile(content);

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toBe("PAUSE");
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
    expect(result.commands[0]).toBe("ABORT");
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
    expect(result.commands[0]).toBe("PAUSE");
    expect(result.commands[1]).toBe("ABORT");
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
});
