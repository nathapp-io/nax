import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipelineEventBus } from "../../../../src/pipeline/event-bus";
import { wireEventsWriter } from "../../../../src/pipeline/subscribers/events-writer";
import { waitForFile } from "../../../../test/helpers/fs";
import { makeTempDir } from "../../../helpers/temp";

// Minimal UserStory stub for event payloads
const stubStory = { id: "US-001", title: "Test story" } as never;

describe("wireEventsWriter", () => {
  let workdir: string;
  let eventsFile: string;

  beforeEach(() => {
    // Use a temp workdir with a known basename so we can locate the events file
    workdir = makeTempDir("nax-evtest-");
    const project = workdir.split("/").pop()!;
    eventsFile = join(process.env.HOME ?? tmpdir(), ".nax", "events", project, "events.jsonl");
  });

  afterEach(async () => {
    // Clean up the events file written under ~/.nax/events/<project>/
    const project = workdir.split("/").pop()!;
    const dir = join(process.env.HOME ?? tmpdir(), ".nax", "events", project);
    await rm(dir, { recursive: true, force: true });
    mock.restore();
  });

  async function readLines(): Promise<object[]> {
    // Poll until the file exists using waitForFile helper
    try {
      await waitForFile(eventsFile, 500);
    } catch {
      throw new Error(`Events file not created within 500ms: ${eventsFile}`);
    }
    const text = await readFile(eventsFile, "utf8");
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  test("returns an UnsubscribeFn", () => {
    const bus = new PipelineEventBus();
    const unsub = wireEventsWriter(bus, "my-feature", "run-001", workdir);
    expect(typeof unsub).toBe("function");
    unsub();
  });

  test("creates events.jsonl and writes run:started line", async () => {
    const bus = new PipelineEventBus();
    wireEventsWriter(bus, "feat-a", "run-abc", workdir);

    bus.emit({ type: "run:started", feature: "feat-a", totalStories: 3, workdir });

    const lines = await readLines();
    expect(lines.length).toBe(1);
    const line = lines[0] as Record<string, unknown>;
    expect(line.event).toBe("run:started");
    expect(line.runId).toBe("run-abc");
    expect(line.feature).toBe("feat-a");
    expect(typeof line.project).toBe("string");
    expect(typeof line.ts).toBe("string");
    // ts must be valid ISO8601
    expect(() => new Date(line.ts as string).toISOString()).not.toThrow();
  });

  test("each line has required fields: ts, event, runId, feature, project", async () => {
    const bus = new PipelineEventBus();
    wireEventsWriter(bus, "feat-b", "run-xyz", workdir);

    bus.emit({ type: "run:started", feature: "feat-b", totalStories: 1, workdir });

    const lines = await readLines();
    const line = lines[0] as Record<string, unknown>;
    for (const field of ["ts", "event", "runId", "feature", "project"]) {
      expect(line[field]).toBeDefined();
    }
  });

  test("run:completed writes event=on-complete", async () => {
    const bus = new PipelineEventBus();
    wireEventsWriter(bus, "feat-c", "run-001", workdir);

    bus.emit({
      type: "run:completed",
      totalStories: 1,
      passedStories: 1,
      failedStories: 0,
      durationMs: 100,
      totalCost: 0.01,
    });

    const lines = await readLines();
    const line = lines[0] as Record<string, unknown>;
    expect(line.event).toBe("on-complete");
  });

  test("story:started includes storyId", async () => {
    const bus = new PipelineEventBus();
    wireEventsWriter(bus, "feat-d", "run-001", workdir);

    bus.emit({
      type: "story:started",
      storyId: "US-042",
      story: stubStory,
      workdir,
    });

    const lines = await readLines();
    const line = lines[0] as Record<string, unknown>;
    expect(line.event).toBe("story:started");
    expect(line.storyId).toBe("US-042");
  });

  test("story:completed includes storyId", async () => {
    const bus = new PipelineEventBus();
    wireEventsWriter(bus, "feat-d", "run-001", workdir);

    bus.emit({
      type: "story:completed",
      storyId: "US-042",
      story: stubStory,
      passed: true,
      durationMs: 500,
    });

    const lines = await readLines();
    const line = lines[0] as Record<string, unknown>;
    expect(line.event).toBe("story:completed");
    expect(line.storyId).toBe("US-042");
  });

  test("story:failed includes storyId", async () => {
    const bus = new PipelineEventBus();
    wireEventsWriter(bus, "feat-d", "run-001", workdir);

    bus.emit({
      type: "story:failed",
      storyId: "US-042",
      story: stubStory,
      reason: "tests failed",
      countsTowardEscalation: true,
    });

    const lines = await readLines();
    const line = lines[0] as Record<string, unknown>;
    expect(line.event).toBe("story:failed");
    expect(line.storyId).toBe("US-042");
  });

  test("run:paused is written", async () => {
    const bus = new PipelineEventBus();
    wireEventsWriter(bus, "feat-e", "run-001", workdir);

    bus.emit({ type: "run:paused", reason: "cost limit", cost: 5.0 });

    const lines = await readLines();
    const line = lines[0] as Record<string, unknown>;
    expect(line.event).toBe("run:paused");
  });

  test("multiple events produce multiple JSONL lines", async () => {
    const bus = new PipelineEventBus();
    wireEventsWriter(bus, "feat-f", "run-multi", workdir);

    // Use emitAsync so each async write completes before reading the file.
    // bus.emit() is fire-and-forget for async subscribers — reads would race.
    await bus.emitAsync({ type: "run:started", feature: "feat-f", totalStories: 2, workdir });
    await bus.emitAsync({ type: "story:started", storyId: "US-001", story: stubStory, workdir });
    await bus.emitAsync({
      type: "story:completed",
      storyId: "US-001",
      story: stubStory,
      passed: true,
      durationMs: 100,
    });
    await bus.emitAsync({
      type: "run:completed",
      totalStories: 1,
      passedStories: 1,
      failedStories: 0,
      durationMs: 200,
    });

    const lines = await readLines();
    expect(lines.length).toBe(4);
  });

  test("write failure does not throw or crash", async () => {
    const bus = new PipelineEventBus();
    // Use a workdir whose project name would conflict with a file (simulate write error)
    // by pointing to an invalid path — we patch mkdir to throw
    const originalMkdir = (await import("node:fs/promises")).mkdir;

    const callCount = 0;
    const _fsMod = await import("node:fs/promises");
    // Inject a failing write by pointing to a path that won't be writable
    // We rely on the subscriber catching the error gracefully
    const badWorkdir = "/dev/null/nonexistent-project";
    const badBus = new PipelineEventBus();
    wireEventsWriter(badBus, "feat-err", "run-err", badWorkdir);

    // Should not throw
    expect(() => {
      badBus.emit({ type: "run:started", feature: "feat-err", totalStories: 0, workdir: badWorkdir });
    }).not.toThrow();

    // Give async time to attempt write and swallow error
    await Promise.resolve();
    // No assertion on file existence — the point is no crash/throw
  });

  test("unsubscribe stops further writes", async () => {
    const bus = new PipelineEventBus();
    const unsub = wireEventsWriter(bus, "feat-g", "run-unsub", workdir);

    bus.emit({ type: "run:started", feature: "feat-g", totalStories: 1, workdir });
    await Promise.resolve();

    unsub();

    bus.emit({
      type: "run:completed",
      totalStories: 1,
      passedStories: 1,
      failedStories: 0,
      durationMs: 100,
    });

    await Promise.resolve();
    const lines = await readLines();
    // Only the first event should be written
    expect(lines.length).toBe(1);
    expect((lines[0] as Record<string, unknown>).event).toBe("run:started");
  });
});
