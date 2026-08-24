/**
 * Unit tests for curatorGc (src/commands/curator.ts)
 *
 * Covers run retention (keep N most recent runIds), project scoping (#1429 — one
 * project may not evict another's rows), the streaming prune and atomic rewrite
 * (#1430), and the opt-in machine-wide sweep of unattributed pre-#1429 rows.
 *
 * Split out of curator.test.ts on the 800-line test-file limit.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _curatorCmdDeps as _deps, curatorCommit, curatorDryrun, curatorGc, curatorStatus } from "@/commands";
import type { ResolvedProject } from "@/commands/common";
import type { NaxConfig } from "@/config";
import type { Observation } from "@/plugins/builtin/curator/types";
import { type DeepPartial, makeNaxConfig, makeTempDir } from "@test/helpers";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildCuratorConfig(overrides: DeepPartial<NaxConfig> = {}): NaxConfig {
  return makeNaxConfig({
    name: "test-proj",
    curator: {
      enabled: true,
      thresholds: {
        repeatedFinding: 2,
        emptyKeyword: 2,
        rectifyAttempts: 2,
        escalationChain: 2,
        staleChunkRuns: 2,
        unchangedOutcome: 2,
      },
    },
    ...overrides,
  });
}

function makeResolvedProject(projectDir: string): ResolvedProject {
  return {
    projectDir,
    configPath: join(projectDir, ".nax", "config.json"),
  };
}

function makeObservation(kind: Observation["kind"], runId = "run-001", projectKey = "test-proj"): Observation {
  return {
    schemaVersion: 3,
    projectKey,
    runId,
    featureId: "feat-1",
    storyId: "US-001",
    stage: "review",
    ts: "2026-01-01T00:00:00.000Z",
    kind,
    payload: {},
  } as unknown as Observation;
}

function writeObservations(runDir: string, observations: Observation[]): void {
  const content = `${observations.map((o) => JSON.stringify(o)).join("\n")}\n`;
  writeFileSync(join(runDir, "observations.jsonl"), content);
}

function writeProposalsMd(runDir: string, content: string): void {
  writeFileSync(join(runDir, "curator-proposals.md"), content);
}

function writeRollup(rollupPath: string, observations: Observation[]): void {
  const content = `${observations.map((o) => JSON.stringify(o)).join("\n")}\n`;
  mkdirSync(join(rollupPath, ".."), { recursive: true });
  writeFileSync(rollupPath, content);
}

// ─── Shared state ─────────────────────────────────────────────────────────────

let tmpDir: string;
let outputDir: string;
let globalDir: string;
let rollupPath: string;
let capturedOutput: string[];

const originalResolveProject = _deps.resolveProject;
const originalLoadConfig = _deps.loadConfig;
const originalProjectOutputDir = _deps.projectOutputDir;
const originalGlobalOutputDir = _deps.globalOutputDir;
const originalCuratorRollupPath = _deps.curatorRollupPath;
const originalReadFile = _deps.readFile;
const originalWriteFile = _deps.writeFile;
const originalAppendFile = _deps.appendFile;
const originalRemoveFile = _deps.removeFile;
const originalOpenInEditor = _deps.openInEditor;
const originalLog = console.log;

beforeEach(() => {
  tmpDir = makeTempDir("nax-curator-test-");
  outputDir = join(tmpDir, "output");
  globalDir = join(tmpDir, "global");
  rollupPath = join(globalDir, "curator", "rollup.jsonl");
  mkdirSync(join(outputDir, "runs"), { recursive: true });
  mkdirSync(join(globalDir, "curator"), { recursive: true });

  capturedOutput = [];
  console.log = (...args: unknown[]) => {
    capturedOutput.push(args.map(String).join(" "));
  };

  _deps.resolveProject = mock(async (_opts?) => makeResolvedProject(tmpDir));
  _deps.loadConfig = mock(async (_dir?) => buildCuratorConfig());
  _deps.projectOutputDir = mock((_key: string, _override?: string) => outputDir);
  _deps.globalOutputDir = mock(() => globalDir);
  _deps.curatorRollupPath = mock((_globalDir: string, _override?: string) => rollupPath);
  _deps.readFile = mock(async (p: string) => {
    const file = Bun.file(p);
    return file.text();
  });
  _deps.writeFile = mock(async (p: string, content: string) => {
    await Bun.write(p, content);
  });
  _deps.appendFile = mock(async (p: string, content: string) => {
    const existing = Bun.file(p);
    const prev = (await existing.exists()) ? await existing.text() : "";
    await Bun.write(p, prev + content);
  });
  _deps.removeFile = mock(async (p: string) => {
    const { unlink: fsUnlink } = await import("node:fs/promises");
    try {
      await fsUnlink(p);
    } catch {
      // ignore
    }
  });
  _deps.openInEditor = mock(async (_p: string) => {});
});

afterEach(() => {
  console.log = originalLog;
  _deps.resolveProject = originalResolveProject;
  _deps.loadConfig = originalLoadConfig;
  _deps.projectOutputDir = originalProjectOutputDir;
  _deps.globalOutputDir = originalGlobalOutputDir;
  _deps.curatorRollupPath = originalCuratorRollupPath;
  _deps.readFile = originalReadFile;
  _deps.writeFile = originalWriteFile;
  _deps.appendFile = originalAppendFile;
  _deps.removeFile = originalRemoveFile;
  _deps.openInEditor = originalOpenInEditor;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Rows currently in the rollup on disk. `curatorGc` streams + renames, so the
 *  file itself is the observable — not an intercepted `writeFile` call. */
async function readRollupRows(p: string): Promise<Observation[]> {
  const text = await Bun.file(p).text();
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Observation);
}

// ─── curatorGc ────────────────────────────────────────────────────────────────

describe("curatorGc", () => {
  describe("no-op cases", () => {
    test("is a no-op when rollup file does not exist or fewer runIds than keep count", async () => {
      // rollup file doesn't exist — must not create one
      await curatorGc({ keep: 50 });
      expect(existsSync(rollupPath)).toBe(false);

      // fewer unique runIds than keep — file left byte-identical
      writeRollup(rollupPath, [makeObservation("verdict", "run-001"), makeObservation("verdict", "run-002")]);
      const before = await Bun.file(rollupPath).text();
      await curatorGc({ keep: 50 });
      expect(await Bun.file(rollupPath).text()).toBe(before);
    });
  });

  describe("pruning", () => {
    test("keeps rows for the most recent N runIds; defaults to keep=50 when unspecified", async () => {
      // Sub-scenario 1: keep 3 of 5 runs
      const obs: Observation[] = [
        { ...makeObservation("verdict", "run-001"), ts: "2026-01-01T00:00:00.000Z" },
        { ...makeObservation("verdict", "run-002"), ts: "2026-01-02T00:00:00.000Z" },
        { ...makeObservation("verdict", "run-003"), ts: "2026-01-03T00:00:00.000Z" },
        { ...makeObservation("verdict", "run-004"), ts: "2026-01-04T00:00:00.000Z" },
        { ...makeObservation("verdict", "run-005"), ts: "2026-01-05T00:00:00.000Z" },
      ];
      writeRollup(rollupPath, obs);

      await curatorGc({ keep: 3 });
      const runIds = (await readRollupRows(rollupPath)).map((r) => r.runId);
      expect(runIds).toContain("run-003");
      expect(runIds).toContain("run-004");
      expect(runIds).toContain("run-005");
      expect(runIds).not.toContain("run-001");
      expect(runIds).not.toContain("run-002");

      // Sub-scenario 2: default keep=50 with 60 runs
      const obsFixed: Observation[] = Array.from({ length: 60 }, (_, i) => ({
        ...makeObservation("verdict", `run-${String(i + 1).padStart(3, "0")}`),
        ts: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      }));
      writeRollup(rollupPath, obsFixed);
      await curatorGc({});
      const uniqueRunIds = new Set((await readRollupRows(rollupPath)).map((r) => r.runId));
      expect(uniqueRunIds.size).toBe(50);
    });

    test("prunes only this project's runs, leaving a neighbour project's rows untouched", async () => {
      // The rollup defaults to one global file for the whole machine (#1429).
      // An unscoped `--keep N` lets a busy project evict a quiet one entirely.
      const obs: Observation[] = [
        { ...makeObservation("verdict", "mine-001"), ts: "2026-01-01T00:00:00.000Z" },
        { ...makeObservation("verdict", "other-001", "neighbour"), ts: "2026-01-02T00:00:00.000Z" },
        { ...makeObservation("verdict", "other-002", "neighbour"), ts: "2026-01-03T00:00:00.000Z" },
        { ...makeObservation("verdict", "mine-002"), ts: "2026-01-04T00:00:00.000Z" },
        { ...makeObservation("verdict", "mine-003"), ts: "2026-01-05T00:00:00.000Z" },
      ];
      writeRollup(rollupPath, obs);

      await curatorGc({ keep: 2 });
      const rows = await readRollupRows(rollupPath);

      // Two most recent of MINE kept, my oldest dropped.
      expect(rows.filter((r) => r.projectKey === "test-proj").map((r) => r.runId)).toEqual(["mine-002", "mine-003"]);
      // The neighbour is not mine to prune — both rows survive.
      expect(rows.filter((r) => r.projectKey === "neighbour").map((r) => r.runId)).toEqual(["other-001", "other-002"]);
    });

    test("rows predating project attribution are preserved, not pruned on one project's behalf", async () => {
      // Pre-#1429 rows carry no projectKey. They belong to no project, so no
      // project's gc may delete them; retention for them is #1430's problem.
      const { projectKey: _unattributed, ...legacy } = makeObservation("verdict", "legacy-001");
      const obs: Observation[] = [
        { ...legacy, ts: "2026-01-01T00:00:00.000Z" } as Observation,
        { ...makeObservation("verdict", "mine-001"), ts: "2026-01-02T00:00:00.000Z" },
        { ...makeObservation("verdict", "mine-002"), ts: "2026-01-03T00:00:00.000Z" },
      ];
      writeRollup(rollupPath, obs);

      await curatorGc({ keep: 1 });
      const runIds = (await readRollupRows(rollupPath)).map((r) => r.runId);
      expect(runIds).toEqual(["legacy-001", "mine-002"]);
    });

    test("deletes observations.jsonl and curator-proposals.md from pruned per-run dirs", async () => {
      // Create 5 runs in rollup and matching per-run dirs
      const obs: Observation[] = [
        { ...makeObservation("verdict", "run-001"), ts: "2026-01-01T00:00:00.000Z" },
        { ...makeObservation("verdict", "run-002"), ts: "2026-01-02T00:00:00.000Z" },
        { ...makeObservation("verdict", "run-003"), ts: "2026-01-03T00:00:00.000Z" },
        { ...makeObservation("verdict", "run-004"), ts: "2026-01-04T00:00:00.000Z" },
        { ...makeObservation("verdict", "run-005"), ts: "2026-01-05T00:00:00.000Z" },
      ];
      writeRollup(rollupPath, obs);

      // Create per-run dirs with curator artifacts for all 5 runs
      for (const { runId } of obs) {
        const runDir = join(outputDir, "runs", runId);
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, "observations.jsonl"), JSON.stringify(makeObservation("verdict", runId)));
        writeFileSync(join(runDir, "curator-proposals.md"), `# proposals for ${runId}`);
      }

      _deps.writeFile = mock(async (p: string, content: string) => {
        await Bun.write(p, content);
      });

      await curatorGc({ keep: 3 });

      // run-001 and run-002 are pruned — their curator files should be gone
      expect(existsSync(join(outputDir, "runs", "run-001", "observations.jsonl"))).toBe(false);
      expect(existsSync(join(outputDir, "runs", "run-001", "curator-proposals.md"))).toBe(false);
      expect(existsSync(join(outputDir, "runs", "run-002", "observations.jsonl"))).toBe(false);
      expect(existsSync(join(outputDir, "runs", "run-002", "curator-proposals.md"))).toBe(false);

      // run-003, run-004, run-005 are kept — their files should remain
      expect(existsSync(join(outputDir, "runs", "run-003", "observations.jsonl"))).toBe(true);
      expect(existsSync(join(outputDir, "runs", "run-004", "observations.jsonl"))).toBe(true);
      expect(existsSync(join(outputDir, "runs", "run-005", "observations.jsonl"))).toBe(true);
    });

    test("rewrites only the rollup file, not canonical feature files", async () => {
      writeRollup(rollupPath, [
        makeObservation("verdict", "run-001"),
        makeObservation("verdict", "run-002"),
        makeObservation("verdict", "run-003"),
      ]);

      const writtenPaths: string[] = [];
      _deps.writeFile = mock(async (p: string, content: string) => {
        writtenPaths.push(p);
        await Bun.write(p, content);
      });

      await curatorGc({ keep: 1 });

      // All write calls should target the rollup path only
      for (const p of writtenPaths) {
        expect(p).toBe(rollupPath);
      }
    });
  });

  // ── #1430: streaming prune + the machine-wide sweep ──────────────────────

  describe("streaming prune (#1430)", () => {
    test("prunes a rollup far larger than any single buffer", async () => {
      // The point of the rewrite: the old implementation read the whole file
      // into a string, sliced it per line and JSON.parsed every line, all live
      // at once. This fixture crosses the 4 MB flush boundary so the streaming
      // path actually flushes more than once.
      const rows: Observation[] = [];
      const padding = "x".repeat(2000);
      for (let i = 0; i < 4000; i++) {
        const row = {
          ...makeObservation("verdict", `run-${String(i % 8).padStart(3, "0")}`),
          ts: new Date(2026, 0, 1, 0, 0, i % 8).toISOString(),
          detail: padding,
        };
        rows.push(row as Observation);
      }
      writeRollup(rollupPath, rows);
      expect(Bun.file(rollupPath).size).toBeGreaterThan(4 * 1024 * 1024);

      await curatorGc({ keep: 3 });

      const kept = await readRollupRows(rollupPath);
      expect(new Set(kept.map((r) => r.runId)).size).toBe(3);
      // Every surviving row is intact JSON — a mid-chunk split would corrupt one.
      expect(kept.every((r) => (r as unknown as { detail: string }).detail === padding)).toBe(true);
    });

    test("leaves the original intact when the rewrite throws", async () => {
      writeRollup(rollupPath, [
        { ...makeObservation("verdict", "run-001"), ts: "2026-01-01T00:00:00.000Z" },
        { ...makeObservation("verdict", "run-002"), ts: "2026-01-02T00:00:00.000Z" },
      ]);
      const before = await Bun.file(rollupPath).text();

      const origPrune = _deps.pruneRollup;
      _deps.pruneRollup = mock(async () => {
        throw new Error("disk full");
      }) as typeof _deps.pruneRollup;

      await expect(curatorGc({ keep: 1 })).rejects.toThrow("disk full");
      // Write-to-tmp + rename means a failed prune cannot truncate the rollup.
      expect(await Bun.file(rollupPath).text()).toBe(before);
      _deps.pruneRollup = origPrune;
    });

    test("--sweep-unattributed drops pre-#1429 rows; default keeps them", async () => {
      const { projectKey: _dropped, ...legacy } = makeObservation("verdict", "legacy-001");
      const build = (): Observation[] => [
        { ...legacy, ts: "2026-01-01T00:00:00.000Z" } as Observation,
        { ...makeObservation("verdict", "mine-001"), ts: "2026-01-02T00:00:00.000Z" },
        { ...makeObservation("verdict", "mine-002"), ts: "2026-01-03T00:00:00.000Z" },
      ];

      // Default: unattributed rows survive even while this project is pruned.
      writeRollup(rollupPath, build());
      await curatorGc({ keep: 1 });
      expect((await readRollupRows(rollupPath)).map((r) => r.runId)).toEqual(["legacy-001", "mine-002"]);

      // Opt-in: they go.
      writeRollup(rollupPath, build());
      await curatorGc({ keep: 1, sweepUnattributed: true });
      expect((await readRollupRows(rollupPath)).map((r) => r.runId)).toEqual(["mine-002"]);
    });

    test("--sweep-unattributed runs even when no run-level pruning is due", async () => {
      // The sweep is machine-wide cleanup, not a side effect of exceeding keep.
      const { projectKey: _dropped, ...legacy } = makeObservation("verdict", "legacy-001");
      writeRollup(rollupPath, [
        { ...legacy, ts: "2026-01-01T00:00:00.000Z" } as Observation,
        { ...makeObservation("verdict", "mine-001"), ts: "2026-01-02T00:00:00.000Z" },
      ]);

      await curatorGc({ keep: 50, sweepUnattributed: true });

      expect((await readRollupRows(rollupPath)).map((r) => r.runId)).toEqual(["mine-001"]);
    });

    test("--sweep-unattributed empties a rollup that is entirely pre-#1429 history", async () => {
      // The motivating case: a 618 MB rollup written before project scoping, so
      // NO row is attributable and `keepRunIds` is empty. Every row is dropped,
      // which means the prune buffer never fills and the temp file is never
      // created — the rename must still land on an empty rollup, not ENOENT.
      const { projectKey: _dropped, ...legacy } = makeObservation("verdict", "legacy-001");
      writeRollup(rollupPath, [
        { ...legacy, ts: "2026-01-01T00:00:00.000Z" } as Observation,
        { ...legacy, runId: "legacy-002", ts: "2026-01-02T00:00:00.000Z" } as Observation,
      ]);

      await curatorGc({ keep: 50, sweepUnattributed: true });

      expect(await Bun.file(rollupPath).exists()).toBe(true);
      expect(await Bun.file(rollupPath).text()).toBe("");
      expect(existsSync(`${rollupPath}.gc-tmp`)).toBe(false);
    });

    test("keeps rows that fail to parse rather than silently dropping them", async () => {
      // We cannot tell whose a corrupt row is, so deleting it is not ours to do.
      writeRollup(rollupPath, [
        { ...makeObservation("verdict", "mine-001"), ts: "2026-01-01T00:00:00.000Z" },
        { ...makeObservation("verdict", "mine-002"), ts: "2026-01-02T00:00:00.000Z" },
      ]);
      const existing = await Bun.file(rollupPath).text();
      await Bun.write(rollupPath, `${existing}{ this is not json\n`);

      await curatorGc({ keep: 1 });

      const text = await Bun.file(rollupPath).text();
      expect(text).toContain("{ this is not json");
      expect(text).toContain("mine-002");
      expect(text).not.toContain("mine-001");
    });
  });
});
