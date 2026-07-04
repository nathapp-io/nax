/**
 * discoverRun — Registry-backed run discovery for replay
 *
 * AC-1:  @/replay exposes `discoverRun`.
 * AC-2:  resolves to { meta, jsonlPath } where meta.feature equals registry
 *        feature and jsonlPath ends in `.jsonl` for an exact-match query.
 * AC-3:  resolves to the same run via prefix matching.
 * AC-4:  with no argument, resolves to the lexicographically greatest runId
 *        across two registry entries.
 * AC-5:  throws NaxError with code RUN_NOT_FOUND when no registry entry matches.
 * AC-6:  throws NaxError with code RUN_NOT_FOUND when more than one entry
 *        matches the supplied prefix.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NaxError } from "@/errors";
import { discoverRun } from "@/replay";

const TMP_ROOT = join(import.meta.dir, "../../..", "tmp", "replay-discovery-test");

function setupRunsDir(): string {
  rmSync(TMP_ROOT, { recursive: true, force: true });
  mkdirSync(TMP_ROOT, { recursive: true });
  return TMP_ROOT;
}

function writeRunDir(
  runsDir: string,
  entryName: string,
  meta: {
    runId: string;
    project?: string;
    feature?: string;
    eventsDir?: string;
  } & Record<string, unknown>,
  jsonlRelativePath: string,
): void {
  const entryDir = join(runsDir, entryName);
  mkdirSync(entryDir, { recursive: true });
  const jsonlPath = join(entryDir, jsonlRelativePath);
  const eventsDir = jsonlPath.substring(0, jsonlPath.lastIndexOf("/"));
  mkdirSync(eventsDir, { recursive: true });
  writeFileSync(jsonlPath, "{}\n");
  const fullMeta = {
    project: "demo",
    feature: "feat-x",
    workdir: "/tmp",
    statusPath: "/tmp/status.json",
    eventsDir,
    registeredAt: "2026-01-01T00:00:00.000Z",
    ...meta,
  };
  writeFileSync(join(entryDir, "meta.json"), JSON.stringify(fullMeta, null, 2));
}

function deps(runsDir: string) {
  return { getRunsDir: () => runsDir };
}

// ---------------------------------------------------------------------------
// AC-1: barrel export
// ---------------------------------------------------------------------------

describe("discoverRun — barrel export", () => {
  test("AC1: is exported from @/replay as a callable function", () => {
    expect(typeof discoverRun).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// AC-2: exact-runId match returns { meta, jsonlPath }
// ---------------------------------------------------------------------------

describe("discoverRun — AC2: exact runId resolution", () => {
  let runsDir: string;
  beforeEach(() => {
    runsDir = setupRunsDir();
  });
  afterEach(() => {
    rmSync(runsDir, { recursive: true, force: true });
  });

  test("AC2: meta.feature equals registry feature for exact runId match", async () => {
    writeRunDir(
      runsDir,
      "demo-feat-x-run-2026-07-04T10-51-37-987Z",
      {
        runId: "run-2026-07-04T10-51-37-987Z",
        feature: "feat-x",
      },
      "events/run-2026-07-04T10-51-37-987Z.jsonl",
    );

    const result = await discoverRun("run-2026-07-04T10-51-37-987Z", deps(runsDir));

    expect(result.meta.feature).toBe("feat-x");
  });

  test("AC2: jsonlPath ends in .jsonl for exact runId match", async () => {
    writeRunDir(
      runsDir,
      "demo-feat-x-run-2026-07-04T10-51-37-987Z",
      {
        runId: "run-2026-07-04T10-51-37-987Z",
        feature: "feat-x",
      },
      "events/run-2026-07-04T10-51-37-987Z.jsonl",
    );

    const result = await discoverRun("run-2026-07-04T10-51-37-987Z", deps(runsDir));

    expect(result.jsonlPath.endsWith(".jsonl")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-3: prefix match resolves to the same run
// ---------------------------------------------------------------------------

describe("discoverRun — AC3: prefix match", () => {
  let runsDir: string;
  beforeEach(() => {
    runsDir = setupRunsDir();
  });
  afterEach(() => {
    rmSync(runsDir, { recursive: true, force: true });
  });

  test("AC3: resolves to the same run via prefix when runId starts with the query", async () => {
    writeRunDir(
      runsDir,
      "demo-feat-x-run-2026-07-04T10-51-37-987Z",
      {
        runId: "run-2026-07-04T10-51-37-987Z",
        feature: "feat-x",
      },
      "events/run-2026-07-04T10-51-37-987Z.jsonl",
    );

    const full = await discoverRun("run-2026-07-04T10-51-37-987Z", deps(runsDir));
    const prefix = await discoverRun("run-2026-07-04", deps(runsDir));

    expect(prefix.meta.runId).toBe(full.meta.runId);
    expect(prefix.meta.feature).toBe(full.meta.feature);
  });
});

// ---------------------------------------------------------------------------
// AC-4: no-argument call resolves to lexicographically greatest runId
// ---------------------------------------------------------------------------

describe("discoverRun — AC4: latest default (no argument)", () => {
  let runsDir: string;
  beforeEach(() => {
    runsDir = setupRunsDir();
  });
  afterEach(() => {
    rmSync(runsDir, { recursive: true, force: true });
  });

  test("AC4: resolves to the entry whose runId is lexicographically greatest when called with no argument", async () => {
    writeRunDir(
      runsDir,
      "demo-feat-x-run-2026-01-01T00-00-00-000Z",
      {
        runId: "run-2026-01-01T00-00-00-000Z",
        feature: "feat-x",
      },
      "events/run-2026-01-01T00-00-00-000Z.jsonl",
    );
    writeRunDir(
      runsDir,
      "demo-feat-x-run-2026-12-31T23-59-59-999Z",
      {
        runId: "run-2026-12-31T23-59-59-999Z",
        feature: "feat-x",
      },
      "events/run-2026-12-31T23-59-59-999Z.jsonl",
    );

    const result = await discoverRun(undefined, deps(runsDir));

    expect(result.meta.runId).toBe("run-2026-12-31T23-59-59-999Z");
  });
});

// ---------------------------------------------------------------------------
// AC-5: no matches → NaxError with RUN_NOT_FOUND
// ---------------------------------------------------------------------------

describe("discoverRun — AC5: no-match error", () => {
  let runsDir: string;
  beforeEach(() => {
    runsDir = setupRunsDir();
  });
  afterEach(() => {
    rmSync(runsDir, { recursive: true, force: true });
  });

  test("AC5: throws NaxError with code RUN_NOT_FOUND when no entry matches", async () => {
    writeRunDir(
      runsDir,
      "demo-feat-x-run-2026-01-01T00-00-00-000Z",
      {
        runId: "run-2026-01-01T00-00-00-000Z",
        feature: "feat-x",
      },
      "events/run-2026-01-01T00-00-00-000Z.jsonl",
    );

    await expect(discoverRun("run-does-not-exist", deps(runsDir))).rejects.toBeInstanceOf(NaxError);
    try {
      await discoverRun("run-does-not-exist", deps(runsDir));
    } catch (err) {
      expect((err as NaxError).code).toBe("RUN_NOT_FOUND");
    }
  });
});

// ---------------------------------------------------------------------------
// AC-6: ambiguous prefix → NaxError with RUN_NOT_FOUND
// ---------------------------------------------------------------------------

describe("discoverRun — AC6: ambiguous-prefix error", () => {
  let runsDir: string;
  beforeEach(() => {
    runsDir = setupRunsDir();
  });
  afterEach(() => {
    rmSync(runsDir, { recursive: true, force: true });
  });

  test("AC6: throws NaxError with code RUN_NOT_FOUND when more than one entry matches the prefix", async () => {
    writeRunDir(
      runsDir,
      "demo-feat-x-run-2026-07-04T10-00-00-000Z",
      {
        runId: "run-2026-07-04T10-00-00-000Z",
        feature: "feat-x",
      },
      "events/run-2026-07-04T10-00-00-000Z.jsonl",
    );
    writeRunDir(
      runsDir,
      "demo-feat-x-run-2026-07-04T11-00-00-000Z",
      {
        runId: "run-2026-07-04T11-00-00-000Z",
        feature: "feat-x",
      },
      "events/run-2026-07-04T11-00-00-000Z.jsonl",
    );

    await expect(discoverRun("run-2026-07-04", deps(runsDir))).rejects.toBeInstanceOf(NaxError);
    try {
      await discoverRun("run-2026-07-04", deps(runsDir));
    } catch (err) {
      expect((err as NaxError).code).toBe("RUN_NOT_FOUND");
    }
  });
});
