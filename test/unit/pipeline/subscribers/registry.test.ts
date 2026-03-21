import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { PipelineEventBus } from "../../../../src/pipeline/event-bus";
import { type MetaJson, wireRegistry } from "../../../../src/pipeline/subscribers/registry";

describe("wireRegistry", () => {
  let workdir: string;
  let feature: string;
  let runId: string;
  let runDir: string;
  let metaFile: string;

  beforeEach(() => {
    workdir = join("/tmp", `nax-regtest-${Date.now()}`);
    feature = "auth-system";
    runId = `run-${Date.now()}`;
    const project = basename(workdir);
    runDir = join(homedir(), ".nax", "runs", `${project}-${feature}-${runId}`);
    metaFile = join(runDir, "meta.json");
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
    mock.restore();
  });

  test("returns an UnsubscribeFn", () => {
    const bus = new PipelineEventBus();
    const unsub = wireRegistry(bus, feature, runId, workdir);
    expect(typeof unsub).toBe("function");
    unsub();
  });

  test("creates meta.json on run:started", async () => {
    const bus = new PipelineEventBus();
    wireRegistry(bus, feature, runId, workdir);

    bus.emit({ type: "run:started", feature, totalStories: 3, workdir });

    await Bun.sleep(50);
    const text = await readFile(metaFile, "utf8");
    const meta = JSON.parse(text) as MetaJson;
    expect(meta).toBeDefined();
  });

  test("meta.json contains all required fields", async () => {
    const bus = new PipelineEventBus();
    wireRegistry(bus, feature, runId, workdir);

    bus.emit({ type: "run:started", feature, totalStories: 1, workdir });

    await Bun.sleep(50);
    const meta = JSON.parse(await readFile(metaFile, "utf8")) as MetaJson;

    expect(meta.runId).toBe(runId);
    expect(meta.project).toBe(basename(workdir));
    expect(meta.feature).toBe(feature);
    expect(meta.workdir).toBe(workdir);
    expect(typeof meta.statusPath).toBe("string");
    expect(typeof meta.eventsDir).toBe("string");
    expect(typeof meta.registeredAt).toBe("string");
  });

  test("statusPath points to <workdir>/.nax/features/<feature>/status.json", async () => {
    const bus = new PipelineEventBus();
    wireRegistry(bus, feature, runId, workdir);

    bus.emit({ type: "run:started", feature, totalStories: 1, workdir });

    await Bun.sleep(50);
    const meta = JSON.parse(await readFile(metaFile, "utf8")) as MetaJson;

    expect(meta.statusPath).toBe(join(workdir, ".nax", "features", feature, "status.json"));
  });

  test("eventsDir points to <workdir>/.nax/features/<feature>/runs", async () => {
    const bus = new PipelineEventBus();
    wireRegistry(bus, feature, runId, workdir);

    bus.emit({ type: "run:started", feature, totalStories: 1, workdir });

    await Bun.sleep(50);
    const meta = JSON.parse(await readFile(metaFile, "utf8")) as MetaJson;

    expect(meta.eventsDir).toBe(join(workdir, ".nax", "features", feature, "runs"));
  });

  test("registeredAt is valid ISO8601", async () => {
    const bus = new PipelineEventBus();
    wireRegistry(bus, feature, runId, workdir);

    bus.emit({ type: "run:started", feature, totalStories: 1, workdir });

    await Bun.sleep(50);
    const meta = JSON.parse(await readFile(metaFile, "utf8")) as MetaJson;

    expect(() => new Date(meta.registeredAt).toISOString()).not.toThrow();
  });

  test("write failure does not throw or crash", async () => {
    const bus = new PipelineEventBus();
    // Point to an unwritable path to trigger write failure
    const badWorkdir = "/dev/null/nonexistent-project";
    wireRegistry(bus, "feat-err", "run-err", badWorkdir);

    expect(() => {
      bus.emit({ type: "run:started", feature: "feat-err", totalStories: 0, workdir: badWorkdir });
    }).not.toThrow();

    await Bun.sleep(50);
    // No crash — test passes if we reach here
  });

  test("MetaJson interface is exported", () => {
    // Verify that MetaJson can be used as a type annotation
    const meta: MetaJson = {
      runId: "r1",
      project: "proj",
      feature: "feat",
      workdir: "/tmp/proj",
      statusPath: "/tmp/proj/.nax/features/feat/status.json",
      eventsDir: "/tmp/proj/.nax/features/feat/runs",
      registeredAt: new Date().toISOString(),
    };
    expect(meta.runId).toBe("r1");
  });

  test("unsubscribe stops further writes", async () => {
    const bus = new PipelineEventBus();
    const unsub = wireRegistry(bus, feature, runId, workdir);

    unsub();

    bus.emit({ type: "run:started", feature, totalStories: 1, workdir });

    await Bun.sleep(50);
    // File should not exist since we unsubscribed before event
    let exists = false;
    try {
      await readFile(metaFile, "utf8");
      exists = true;
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });
});
