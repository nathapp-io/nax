/**
 * Queue Manager
 *
 * Manages priority queue for user stories.
 * Supports dependency-based ordering and multi-agent execution.
 */

import type { QueueCommand, QueueFileResult, QueueItem, QueueItemStatus, QueueStats } from "./types";

export class QueueManager {
  private items: QueueItem[] = [];

  /**
   * Add a story to the queue.
   * Priority is used for ordering (higher = more urgent).
   */
  enqueue(storyId: string, title: string, priority: number): void {
    const existing = this.items.find((item) => item.storyId === storyId);
    if (existing) {
      throw new Error(`Story ${storyId} already in queue`);
    }

    const item: QueueItem = {
      storyId,
      title,
      priority,
      status: "pending",
      attempts: 0,
      addedAt: new Date(),
    };

    this.items.push(item);
    // Sort by priority (descending) — higher priority first
    this.items.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get the next pending item (highest priority).
   * Returns null if no pending items.
   */
  dequeue(): QueueItem | null {
    const pending = this.items.find((item) => item.status === "pending");
    return pending ?? null;
  }

  /**
   * Peek at the next pending item without removing it.
   */
  peek(): QueueItem | null {
    return this.dequeue();
  }

  /**
   * Mark a story as in-progress and assign it to an agent.
   */
  markInProgress(storyId: string, assignedAgent: string): void {
    const item = this.items.find((i) => i.storyId === storyId);
    if (!item) {
      throw new Error(`Story ${storyId} not found in queue`);
    }

    item.status = "in-progress";
    item.assignedAgent = assignedAgent;
    item.startedAt = new Date();
    item.attempts += 1;
  }

  /**
   * Mark a story as completed.
   */
  markComplete(storyId: string): void {
    const item = this.items.find((i) => i.storyId === storyId);
    if (!item) {
      throw new Error(`Story ${storyId} not found in queue`);
    }

    item.status = "completed";
    item.completedAt = new Date();
  }

  /**
   * Mark a story as failed with an error message.
   */
  markFailed(storyId: string, error: string): void {
    const item = this.items.find((i) => i.storyId === storyId);
    if (!item) {
      throw new Error(`Story ${storyId} not found in queue`);
    }

    item.status = "failed";
    item.error = error;
    item.completedAt = new Date();
  }

  /**
   * Reset a story back to pending (e.g., for retry).
   */
  resetToPending(storyId: string): void {
    const item = this.items.find((i) => i.storyId === storyId);
    if (!item) {
      throw new Error(`Story ${storyId} not found in queue`);
    }

    item.status = "pending";
    item.assignedAgent = undefined;
    item.startedAt = undefined;
    item.completedAt = undefined;
    item.error = undefined;
    // Re-sort after status change
    this.items.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get all items with a specific status.
   */
  getByStatus(status: QueueItemStatus): QueueItem[] {
    return this.items.filter((item) => item.status === status);
  }

  /**
   * Get a specific item by story ID.
   */
  getItem(storyId: string): QueueItem | null {
    return this.items.find((i) => i.storyId === storyId) ?? null;
  }

  /**
   * Get all items in the queue.
   */
  getAllItems(): QueueItem[] {
    return [...this.items];
  }

  /**
   * Get queue statistics.
   */
  getStats(): QueueStats {
    return {
      total: this.items.length,
      pending: this.items.filter((i) => i.status === "pending").length,
      inProgress: this.items.filter((i) => i.status === "in-progress").length,
      completed: this.items.filter((i) => i.status === "completed").length,
      failed: this.items.filter((i) => i.status === "failed").length,
      skipped: this.items.filter((i) => i.status === "skipped").length,
    };
  }

  /**
   * Remove a story from the queue entirely.
   */
  remove(storyId: string): void {
    const index = this.items.findIndex((i) => i.storyId === storyId);
    if (index === -1) {
      throw new Error(`Story ${storyId} not found in queue`);
    }
    this.items.splice(index, 1);
  }

  /**
   * Clear all items from the queue.
   */
  clear(): void {
    this.items = [];
  }

  /**
   * Check if the queue is empty.
   */
  isEmpty(): boolean {
    return this.items.length === 0;
  }

  /**
   * Check if there are any pending items.
   */
  hasPending(): boolean {
    return this.items.some((i) => i.status === "pending");
  }

  /**
   * Mark a story as skipped.
   */
  markSkipped(storyId: string): void {
    const item = this.items.find((i) => i.storyId === storyId);
    if (!item) {
      throw new Error(`Story ${storyId} not found in queue`);
    }

    item.status = "skipped";
    item.error = "Skipped by user command";
    item.completedAt = new Date();
  }
}

/**
 * Parse queue file content into commands and guidance.
 *
 * Commands:
 * - PAUSE: Pause execution after current story
 * - ABORT: Mark all remaining stories as skipped and stop
 * - SKIP US-XXX: Skip a specific story
 *
 * Everything else after "--- PENDING ---" is treated as guidance text.
 */
export function parseQueueFile(content: string): QueueFileResult {
  const commands: QueueCommand[] = [];
  const guidance: string[] = [];

  const lines = content.split("\n");
  let inPendingSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) {
      continue;
    }

    // Check for pending section marker
    if (trimmed === "--- PENDING ---") {
      inPendingSection = true;
      continue;
    }

    // Parse commands (case-insensitive)
    const upper = trimmed.toUpperCase();

    if (upper === "PAUSE") {
      commands.push({ type: "PAUSE" });
    } else if (upper === "ABORT") {
      commands.push({ type: "ABORT" });
    } else if (upper.startsWith("SKIP ")) {
      // Extract story ID after "SKIP"
      const storyId = trimmed.substring(5).trim();
      if (storyId) {
        commands.push({ type: "SKIP", storyId });
      } else {
        // No story ID, treat as guidance
        guidance.push(trimmed);
      }
    } else if (upper === "SKIP") {
      // SKIP with no story ID, treat as guidance
      guidance.push(trimmed);
    } else {
      // Not a command, treat as guidance if in pending section
      if (inPendingSection) {
        guidance.push(trimmed);
      }
    }
  }

  return { commands, guidance };
}
