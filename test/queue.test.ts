import { describe, expect, test } from "bun:test";
import { QueueManager } from "../src/queue/manager";

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
});
