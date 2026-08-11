import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { NaxConfigSchema } from "../../../src/config";
import type { NaxConfig } from "../../../src/config";
import { contextManifestPath, rebuildManifestPath } from "../../../src/context/engine/manifest-store";
import {
  MAX_MANIFEST_SCAN,
  _manifestPurgeDeps,
  purgeStaleManifests,
} from "../../../src/context/engine/manifest-purge";
import {
  _runCompletionDeps,
  handleRunCompletion,
  type RunCompletionOptions,
} from "../../../src/execution/lifecycle/run-completion";
import * as loggerModule from "../../../src/logger";
import { makeMockRuntime, makeNaxConfig, makePRD, makeStory } from "../../../test/helpers";

const DAY_MS = 86_400_000;

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem fixtures for purgeStaleManifests (real disk — the injectable seam
// is exercised separately for the failure-isolation and scan-cap ACs).
// ─────────────────────────────────────────────────────────────────────────────

async function makeTempProjectDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "nax-manifest-retention-"));
}

async function ageFile(filePath: string, ageDays: number | undefined): Promise<void> {
  if (ageDays === undefined) return;
  const t = new Date(Date.now() - ageDays * DAY_MS);
  await utimes(filePath, t, t);
}

async function writeContextManifestFile(
  projectDir: string,
  featureId: string,
  storyId: string,
  stage: string,
  ageDays?: number,
): Promise<string> {
  const filePath = contextManifestPath(projectDir, featureId, storyId, stage);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ stage }));
  await ageFile(filePath, ageDays);
  return filePath;
}

async function writeRebuildManifestFile(
  projectDir: string,
  featureId: string,
  storyId: string,
  ageDays?: number,
): Promise<string> {
  const filePath = rebuildManifestPath(projectDir, featureId, storyId);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ rebuild: true }));
  await ageFile(filePath, ageDays);
  return filePath;
}

// ─────────────────────────────────────────────────────────────────────────────
// US-001 — config schema: context.v2.manifest.retentionDays
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001: context.v2.manifest config", () => {
  test("AC-1: NaxConfigSchema.parse({}) leaves context.v2.manifest undefined (not null, not {})", () => {
    const result = NaxConfigSchema.parse({});
    expect(result.context.v2.manifest).toBeUndefined();
    expect(result.context.v2.manifest).not.toBeNull();
  });

  test("AC-2: context.v2.manifest.retentionDays round-trips to 30", () => {
    const result = NaxConfigSchema.parse({
      context: { v2: { manifest: { retentionDays: 30 } } },
    });
    expect(result.context.v2.manifest?.retentionDays).toBe(30);
  });

  test("AC-3: context.v2.manifest.retentionDays: 0 throws a schema validation error", () => {
    expect(() =>
      NaxConfigSchema.parse({
        context: { v2: { manifest: { retentionDays: 0 } } },
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-001 — purgeStaleManifests: filesystem sweep behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001: purgeStaleManifests — filesystem sweep", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await makeTempProjectDir();
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  test("AC-4: returns 0 when the project directory has no .nax/features directory", async () => {
    const count = await purgeStaleManifests(projectDir, 30);
    expect(count).toBe(0);
  });

  test("AC-5: deletes a context-manifest-*.json file whose mtime is 31 days old (retentionDays=30)", async () => {
    const filePath = await writeContextManifestFile(projectDir, "F", "S", "context", 31);
    await purgeStaleManifests(projectDir, 30);
    expect(existsSync(filePath)).toBe(false);
  });

  test("AC-6: leaves a context-manifest-*.json file whose mtime is 29 days old (retentionDays=30)", async () => {
    const filePath = await writeContextManifestFile(projectDir, "F", "S", "context", 29);
    await purgeStaleManifests(projectDir, 30);
    expect(existsSync(filePath)).toBe(true);
  });

  test("AC-7: returns the exact integer count of manifest files it deleted", async () => {
    const stale1 = await writeContextManifestFile(projectDir, "F1", "S1", "context", 40);
    const stale2 = await writeRebuildManifestFile(projectDir, "F2", "S2", 45);
    const fresh = await writeContextManifestFile(projectDir, "F3", "S3", "context", 5);

    const count = await purgeStaleManifests(projectDir, 30);

    expect(Number.isInteger(count)).toBe(true);
    expect(count).toBeGreaterThanOrEqual(0);
    expect(count).toBe(2);
    expect(existsSync(stale1)).toBe(false);
    expect(existsSync(stale2)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("AC-8: deletes a rebuild-manifest.json file whose mtime is 31 days old (retentionDays=30)", async () => {
    const filePath = await writeRebuildManifestFile(projectDir, "F", "S", 31);
    await purgeStaleManifests(projectDir, 30);
    expect(existsSync(filePath)).toBe(false);
  });

  test("AC-11: removes the story directory once its only (stale) manifest is deleted", async () => {
    const filePath = await writeContextManifestFile(projectDir, "F", "S", "context", 31);
    const storyDir = dirname(filePath);

    await purgeStaleManifests(projectDir, 30);

    expect(existsSync(storyDir)).toBe(false);
  });

  test("AC-12: preserves the story directory and a non-manifest file alongside a stale manifest", async () => {
    const filePath = await writeContextManifestFile(projectDir, "F", "S", "context", 31);
    const storyDir = dirname(filePath);
    const otherFile = join(storyDir, "other.txt");
    await writeFile(otherFile, "keep me");

    await purgeStaleManifests(projectDir, 30);

    expect(existsSync(storyDir)).toBe(true);
    expect(existsSync(otherFile)).toBe(true);
    expect(existsSync(filePath)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-001 — purgeStaleManifests: statMtime failure isolation (_manifestPurgeDeps)
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001: purgeStaleManifests — statMtime failure isolation", () => {
  let projectDir: string;
  let origStatMtime: typeof _manifestPurgeDeps.statMtime;

  beforeEach(async () => {
    projectDir = await makeTempProjectDir();
    origStatMtime = _manifestPurgeDeps.statMtime;
  });

  afterEach(async () => {
    _manifestPurgeDeps.statMtime = origStatMtime;
    await rm(projectDir, { recursive: true, force: true });
  });

  test("AC-9: leaves a manifest on disk when the injected statMtime throws for it", async () => {
    const filePath = await writeContextManifestFile(projectDir, "F", "S", "context", 31);
    _manifestPurgeDeps.statMtime = async () => {
      throw new Error("stat failed");
    };

    await purgeStaleManifests(projectDir, 30);

    expect(existsSync(filePath)).toBe(true);
  });

  test("AC-10: excludes a statMtime-failure manifest from the returned deletion count", async () => {
    await writeContextManifestFile(projectDir, "F", "S", "context", 31);
    _manifestPurgeDeps.statMtime = async () => {
      throw new Error("stat failed");
    };

    const count = await purgeStaleManifests(projectDir, 30);

    expect(count).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-001 — purgeStaleManifests: MAX_MANIFEST_SCAN cap
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001: purgeStaleManifests — MAX_MANIFEST_SCAN cap", () => {
  let origDeps: typeof _manifestPurgeDeps;

  beforeEach(() => {
    origDeps = { ..._manifestPurgeDeps };
  });

  afterEach(() => {
    Object.assign(_manifestPurgeDeps, origDeps);
    mock.restore();
  });

  test("AC-13: stops after MAX_MANIFEST_SCAN entries and logs a debug record naming the constant", async () => {
    const overflowCount = MAX_MANIFEST_SCAN + 5;
    const scannedPaths = Array.from(
      { length: overflowCount },
      (_, i) => `features/F/stories/S${i}/context-manifest-context.json`,
    );

    _manifestPurgeDeps.scan = async () => scannedPaths;
    const statMtimeCalls: string[] = [];
    _manifestPurgeDeps.statMtime = async (path: string) => {
      statMtimeCalls.push(path);
      return Date.now() - 60 * DAY_MS;
    };
    const unlinkCalls: string[] = [];
    _manifestPurgeDeps.unlink = async (path: string) => {
      unlinkCalls.push(path);
    };
    _manifestPurgeDeps.rmdirIfEmpty = async () => {};

    const debugSpy = spyOn(loggerModule.getSafeLogger()!, "debug");

    const count = await purgeStaleManifests("/fake/project", 30);

    expect(statMtimeCalls.length).toBe(MAX_MANIFEST_SCAN);
    expect(unlinkCalls.length).toBe(MAX_MANIFEST_SCAN);
    expect(count).toBe(MAX_MANIFEST_SCAN);

    const loggedCap = debugSpy.mock.calls.some((call) =>
      call.some((arg) => typeof arg === "string" && arg.includes(String(MAX_MANIFEST_SCAN))),
    );
    expect(loggedCap).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-002 — handleRunCompletion wiring
// ─────────────────────────────────────────────────────────────────────────────

function makeCompletionStatusWriter() {
  return {
    setPrd: mock(() => {}),
    setCurrentStory: mock(() => {}),
    setRunStatus: mock(() => {}),
    setPostRunPhase: mock((_phase: string, _update: Record<string, unknown>) => {}),
    update: mock(async () => {}),
    writeFeatureStatus: mock(async () => {}),
  };
}

function makeCompletionConfig(retentionDays?: number): NaxConfig {
  return makeNaxConfig(
    retentionDays === undefined
      ? {}
      : { context: { v2: { manifest: { retentionDays } } } },
  );
}

function makeCompletionOpts(overrides: Partial<RunCompletionOptions> = {}): RunCompletionOptions {
  const prd = makePRD({ userStories: [makeStory({ id: "US-001", status: "passed", passes: true })] });
  return {
    runId: "run-manifest-retention",
    feature: "test-feature",
    startedAt: new Date().toISOString(),
    prd,
    allStoryMetrics: [],
    totalCost: 0,
    storiesCompleted: 1,
    iterations: 1,
    startTime: Date.now() - 1000,
    workdir: "/tmp/nax-manifest-retention-workdir",
    statusWriter: makeCompletionStatusWriter() as unknown as RunCompletionOptions["statusWriter"],
    config: makeCompletionConfig(),
    runtime: makeMockRuntime(),
    ...overrides,
  };
}

describe("US-002: handleRunCompletion — manifest retention wiring", () => {
  const origRunCompletionDeps = { ..._runCompletionDeps };

  afterEach(() => {
    Object.assign(_runCompletionDeps, origRunCompletionDeps);
    mock.restore();
  });

  test("AC-14: invokes purgeStaleManifests exactly once with [projectDir, retentionDays]", async () => {
    const purgeMock = mock(async () => 0);
    _runCompletionDeps.purgeStaleManifests = purgeMock;

    await handleRunCompletion(
      makeCompletionOpts({
        projectDir: "/abs/test/project-dir",
        config: makeCompletionConfig(30),
      }),
    );

    expect(purgeMock.mock.calls.length).toBe(1);
    expect(purgeMock.mock.calls[0]).toEqual(["/abs/test/project-dir", 30]);
  });

  test("AC-15: never invokes purgeStaleManifests when context.v2.manifest is unset", async () => {
    const purgeMock = mock(async () => 0);
    _runCompletionDeps.purgeStaleManifests = purgeMock;

    await handleRunCompletion(
      makeCompletionOpts({
        projectDir: "/abs/test/project-dir",
        config: makeCompletionConfig(),
      }),
    );

    expect(purgeMock.mock.calls.length).toBe(0);
  });

  test("AC-16: resolves with a normal completion result when purgeStaleManifests rejects", async () => {
    _runCompletionDeps.purgeStaleManifests = mock(async (): Promise<number> => {
      throw new Error("purgeStaleManifests failed");
    });

    const result = await handleRunCompletion(
      makeCompletionOpts({
        projectDir: "/abs/test/project-dir",
        config: makeCompletionConfig(30),
      }),
    );

    expect(result).toBeDefined();
    expect(typeof result.durationMs).toBe("number");
    expect(result.finalCounts).toBeDefined();
    expect(result.pluginGateFailed).toBe(false);
  });

  test("AC-17: emits a warn-level log recording the purge failure", async () => {
    _runCompletionDeps.purgeStaleManifests = mock(async (): Promise<number> => {
      throw new Error("purgeStaleManifests failed");
    });
    const warnSpy = spyOn(loggerModule.getSafeLogger()!, "warn");

    await handleRunCompletion(
      makeCompletionOpts({
        projectDir: "/abs/test/project-dir",
        config: makeCompletionConfig(30),
      }),
    );

    const matched = warnSpy.mock.calls.some((call) =>
      JSON.stringify(call).toLowerCase().includes("purgestalemanifests"),
    );
    expect(matched).toBe(true);
  });

  test("AC-18: emits an info-level log carrying the returned purge count", async () => {
    _runCompletionDeps.purgeStaleManifests = mock(async () => 777);
    const infoSpy = spyOn(loggerModule.getSafeLogger()!, "info");

    await handleRunCompletion(
      makeCompletionOpts({
        projectDir: "/abs/test/project-dir",
        config: makeCompletionConfig(30),
      }),
    );

    const matched = infoSpy.mock.calls.some((call) => JSON.stringify(call).includes("777"));
    expect(matched).toBe(true);
  });
});