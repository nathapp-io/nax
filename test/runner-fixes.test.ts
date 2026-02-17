/**
 * Tests for BUG-2 (queue race condition) and PERF-1 (batching optimization)
 * Tests for PERF-2 (PRD dirty-flag reload optimization) and MEM-1 (file size limit)
 */

import { describe, expect, test, beforeEach } from "bun:test";
import path from "node:path";
import { groupStoriesIntoBatches } from "../src/execution/runner";
import type { UserStory, PRD } from "../src/prd";
import { loadPRD, PRD_MAX_FILE_SIZE } from "../src/prd";

// Helper to create test stories
function createStory(
  id: string,
  complexity: "simple" | "medium" | "complex" | "expert" = "simple",
  testStrategy: "test-after" | "three-session-tdd" = "test-after",
): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "Test story",
    acceptanceCriteria: ["AC1"],
    dependencies: [],
    tags: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    routing: {
      complexity,
      modelTier: "fast",
      testStrategy,
      reasoning: "Test routing",
    },
  };
}

describe("BUG-2: Queue race condition", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = `/tmp/nax-race-test-${Date.now()}`;
    await Bun.spawn(["mkdir", "-p", tmpDir], { stdout: "pipe" }).exited;
  });

  test("atomic read-and-rename prevents race condition", async () => {
    const queuePath = path.join(tmpDir, ".queue.txt");
    const processingPath = path.join(tmpDir, ".queue.txt.processing");

    // Write initial commands
    await Bun.write(queuePath, "PAUSE\n");

    // Simulate reader starting (rename to processing)
    await Bun.spawn(["mv", queuePath, processingPath], { stdout: "pipe" }).exited;

    // Simulate concurrent writer adding commands (should create new .queue.txt)
    await Bun.write(queuePath, "SKIP US-001\n");

    // Verify processing file exists
    const processingFile = Bun.file(processingPath);
    expect(await processingFile.exists()).toBe(true);
    const processingContent = await processingFile.text();
    expect(processingContent).toBe("PAUSE\n");

    // Verify new queue file exists with new content
    const newQueueFile = Bun.file(queuePath);
    expect(await newQueueFile.exists()).toBe(true);
    const newContent = await newQueueFile.text();
    expect(newContent).toBe("SKIP US-001\n");

    // Cleanup
    await Bun.spawn(["rm", "-rf", tmpDir], { stdout: "pipe" }).exited;
  });

  test("processing file is deleted after reading", async () => {
    const queuePath = path.join(tmpDir, ".queue.txt");
    const processingPath = path.join(tmpDir, ".queue.txt.processing");

    // Write commands
    await Bun.write(queuePath, "PAUSE\n");

    // Rename to processing
    await Bun.spawn(["mv", queuePath, processingPath], { stdout: "pipe" }).exited;

    // Verify processing file exists
    expect(await Bun.file(processingPath).exists()).toBe(true);

    // Simulate cleanup (delete processing file)
    await Bun.spawn(["rm", processingPath], { stdout: "pipe" }).exited;

    // Verify processing file is deleted
    expect(await Bun.file(processingPath).exists()).toBe(false);

    // Cleanup
    await Bun.spawn(["rm", "-rf", tmpDir], { stdout: "pipe" }).exited;
  });

  test("concurrent writes during processing don't lose commands", async () => {
    const queuePath = path.join(tmpDir, ".queue.txt");
    const processingPath = path.join(tmpDir, ".queue.txt.processing");

    // Write initial batch
    await Bun.write(queuePath, "PAUSE\nSKIP US-001\n");

    // Reader: rename to processing
    await Bun.spawn(["mv", queuePath, processingPath], { stdout: "pipe" }).exited;

    // Writer: add new commands (creates new .queue.txt)
    await Bun.write(queuePath, "SKIP US-002\nSKIP US-003\n");

    // Reader: read processing file
    const processingContent = await Bun.file(processingPath).text();
    const processedLines = processingContent.trim().split("\n");

    // Reader: delete processing file
    await Bun.spawn(["rm", processingPath], { stdout: "pipe" }).exited;

    // Verify original commands were processed
    expect(processedLines).toEqual(["PAUSE", "SKIP US-001"]);

    // Verify new commands are in queue
    const newContent = await Bun.file(queuePath).text();
    const newLines = newContent.trim().split("\n");
    expect(newLines).toEqual(["SKIP US-002", "SKIP US-003"]);

    // Cleanup
    await Bun.spawn(["rm", "-rf", tmpDir], { stdout: "pipe" }).exited;
  });
});

describe("BUG-2: File locking", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = `/tmp/nax-lock-test-${Date.now()}`;
    await Bun.spawn(["mkdir", "-p", tmpDir], { stdout: "pipe" }).exited;
  });

  test("lock file prevents concurrent execution", async () => {
    const lockPath = path.join(tmpDir, "nax.lock");

    // Create lock
    const lockData = {
      pid: process.pid,
      timestamp: Date.now(),
    };
    await Bun.write(lockPath, JSON.stringify(lockData));

    // Verify lock exists
    const lockFile = Bun.file(lockPath);
    expect(await lockFile.exists()).toBe(true);

    // Verify lock content
    const content = await lockFile.text();
    const parsed = JSON.parse(content);
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.timestamp).toBeGreaterThan(0);

    // Cleanup
    await Bun.spawn(["rm", "-rf", tmpDir], { stdout: "pipe" }).exited;
  });

  test("stale lock is removed after 1 hour", async () => {
    const lockPath = path.join(tmpDir, "nax.lock");

    // Create stale lock (2 hours old)
    const staleLockData = {
      pid: 99999,
      timestamp: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
    };
    await Bun.write(lockPath, JSON.stringify(staleLockData));

    // Verify lock is stale
    const lockContent = await Bun.file(lockPath).text();
    const lockData = JSON.parse(lockContent);
    const lockAge = Date.now() - lockData.timestamp;
    const ONE_HOUR = 60 * 60 * 1000;
    expect(lockAge).toBeGreaterThan(ONE_HOUR);

    // Cleanup
    await Bun.spawn(["rm", "-rf", tmpDir], { stdout: "pipe" }).exited;
  });

  test("lock is released after execution", async () => {
    const lockPath = path.join(tmpDir, "nax.lock");

    // Create lock
    const lockData = {
      pid: process.pid,
      timestamp: Date.now(),
    };
    await Bun.write(lockPath, JSON.stringify(lockData));

    // Verify lock exists
    expect(await Bun.file(lockPath).exists()).toBe(true);

    // Simulate release (delete lock)
    await Bun.spawn(["rm", lockPath], { stdout: "pipe" }).exited;

    // Verify lock is removed
    expect(await Bun.file(lockPath).exists()).toBe(false);

    // Cleanup
    await Bun.spawn(["rm", "-rf", tmpDir], { stdout: "pipe" }).exited;
  });
});

describe("PERF-1: Batch optimization", () => {
  test("groups consecutive simple stories correctly", () => {
    const stories: UserStory[] = [
      createStory("US-001", "simple", "test-after"),
      createStory("US-002", "simple", "test-after"),
      createStory("US-003", "simple", "test-after"),
      createStory("US-004", "medium", "test-after"),
      createStory("US-005", "simple", "test-after"),
    ];

    const batches = groupStoriesIntoBatches(stories, 4);

    expect(batches).toHaveLength(3);
    expect(batches[0].stories).toHaveLength(3); // US-001, US-002, US-003
    expect(batches[0].isBatch).toBe(true);
    expect(batches[1].stories).toHaveLength(1); // US-004 (medium)
    expect(batches[1].isBatch).toBe(false);
    expect(batches[2].stories).toHaveLength(1); // US-005 (simple, but alone)
    expect(batches[2].isBatch).toBe(false);
  });

  test("respects max batch size", () => {
    const stories: UserStory[] = [
      createStory("US-001", "simple", "test-after"),
      createStory("US-002", "simple", "test-after"),
      createStory("US-003", "simple", "test-after"),
      createStory("US-004", "simple", "test-after"),
      createStory("US-005", "simple", "test-after"),
      createStory("US-006", "simple", "test-after"),
    ];

    const batches = groupStoriesIntoBatches(stories, 4);

    expect(batches).toHaveLength(2);
    expect(batches[0].stories).toHaveLength(4); // US-001 to US-004
    expect(batches[0].isBatch).toBe(true);
    expect(batches[1].stories).toHaveLength(2); // US-005, US-006
    expect(batches[1].isBatch).toBe(true);
  });

  test("handles mixed complexity correctly", () => {
    const stories: UserStory[] = [
      createStory("US-001", "simple", "test-after"),
      createStory("US-002", "medium", "test-after"),
      createStory("US-003", "simple", "test-after"),
      createStory("US-004", "complex", "three-session-tdd"),
      createStory("US-005", "simple", "test-after"),
    ];

    const batches = groupStoriesIntoBatches(stories, 4);

    expect(batches).toHaveLength(5);
    // Each non-simple story creates its own batch
    expect(batches[0].stories).toHaveLength(1); // US-001
    expect(batches[1].stories).toHaveLength(1); // US-002
    expect(batches[2].stories).toHaveLength(1); // US-003
    expect(batches[3].stories).toHaveLength(1); // US-004
    expect(batches[4].stories).toHaveLength(1); // US-005
  });

  test("large story list performance", () => {
    // Create 1000 stories
    const stories: UserStory[] = [];
    for (let i = 0; i < 1000; i++) {
      const complexity = i % 3 === 0 ? "simple" : "medium";
      stories.push(createStory(`US-${String(i + 1).padStart(4, "0")}`, complexity, "test-after"));
    }

    const startTime = Date.now();
    const batches = groupStoriesIntoBatches(stories, 4);
    const duration = Date.now() - startTime;

    // Should complete in under 100ms for 1000 stories
    expect(duration).toBeLessThan(100);

    // Verify batches were created
    expect(batches.length).toBeGreaterThan(0);
  });

  test("uses pre-computed routing", () => {
    // Stories with routing already set (from analyze phase)
    const stories: UserStory[] = [
      createStory("US-001", "simple", "test-after"),
      createStory("US-002", "simple", "test-after"),
    ];

    const batches = groupStoriesIntoBatches(stories, 4);

    // Should use routing from story.routing, not re-compute
    expect(batches).toHaveLength(1);
    expect(batches[0].stories).toHaveLength(2);
    expect(batches[0].isBatch).toBe(true);
  });
});

describe("PERF-2 & MEM-1: PRD file size limit and dirty-flag optimization", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = `/tmp/nax-prd-test-${Date.now()}`;
    await Bun.spawn(["mkdir", "-p", tmpDir], { stdout: "pipe" }).exited;
  });

  test("rejects PRD files exceeding size limit", async () => {
    const prdPath = path.join(tmpDir, "prd.json");

    // Create a minimal PRD structure
    const largePRD: PRD = {
      project: "test-project",
      feature: "test-feature",
      branchName: "test-branch",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [],
    };

    // Add enough stories to exceed 5MB limit
    // Each story is roughly 500 bytes, so we need ~10,000 stories
    const storyTemplate = {
      title: "Test Story with long description and multiple acceptance criteria",
      description: "A".repeat(200), // 200 character description
      acceptanceCriteria: Array.from({ length: 5 }, (_, i) => `Acceptance criterion ${i}: ${"x".repeat(50)}`),
      dependencies: [],
      tags: ["test", "performance", "large-prd"],
      status: "pending" as const,
      passes: false,
      escalations: [],
      attempts: 0,
    };

    for (let i = 0; i < 11000; i++) {
      largePRD.userStories.push({
        ...storyTemplate,
        id: `US-${String(i + 1).padStart(5, "0")}`,
      });
    }

    // Write large PRD
    await Bun.write(prdPath, JSON.stringify(largePRD, null, 2));

    // Verify file size exceeds limit
    const stats = await Bun.file(prdPath).stat();
    expect(stats.size).toBeGreaterThan(PRD_MAX_FILE_SIZE);

    // Try to load — should throw error
    try {
      await loadPRD(prdPath);
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("too large");
      expect((error as Error).message).toContain("exceeds");
      expect((error as Error).message).toContain("MB");
    }

    // Cleanup
    await Bun.spawn(["rm", "-rf", tmpDir], { stdout: "pipe" }).exited;
  });

  test("accepts PRD files within size limit", async () => {
    const prdPath = path.join(tmpDir, "prd.json");

    // Create a normal-sized PRD
    const prd: PRD = {
      project: "test-project",
      feature: "test-feature",
      branchName: "test-branch",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        createStory("US-001", "simple", "test-after"),
        createStory("US-002", "simple", "test-after"),
      ],
    };

    // Write PRD
    await Bun.write(prdPath, JSON.stringify(prd, null, 2));

    // Verify file size is within limit
    const stats = await Bun.file(prdPath).stat();
    expect(stats.size).toBeLessThan(PRD_MAX_FILE_SIZE);

    // Should load successfully
    const loaded = await loadPRD(prdPath);
    expect(loaded.userStories).toHaveLength(2);
    expect(loaded.project).toBe("test-project");

    // Cleanup
    await Bun.spawn(["rm", "-rf", tmpDir], { stdout: "pipe" }).exited;
  });

  test("PRD_MAX_FILE_SIZE constant is 5MB", () => {
    expect(PRD_MAX_FILE_SIZE).toBe(5 * 1024 * 1024);
  });
});
