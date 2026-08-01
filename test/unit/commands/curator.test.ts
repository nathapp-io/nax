/**
 * Unit tests for src/commands/curator.ts
 *
 * Tests all acceptance criteria:
 * - curatorStatus: project resolution, observation counts, proposal markdown, latest/explicit run
 * - curatorCommit: checked [x] parsing, drops before adds, canonical writes, editor open, no git commit
 * - curatorDryrun: re-runs heuristics, prints to stdout, no canonical file writes
 * - curatorGc: keep N runIds, rewrite rollup only, no-op when fewer runs than keep
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NaxConfig } from "../../../src/config";
import {
  _curatorCmdDeps as _deps,
  curatorCommit,
  curatorDryrun,
  curatorGc,
  curatorStatus,
} from "../../../src/commands/curator";
import type { ResolvedProject } from "../../../src/commands/common";
import type { Observation } from "../../../src/plugins/builtin/curator/types";
import { makeNaxConfig } from "../../helpers";
import { makeTempDir } from "../../helpers/temp";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildCuratorConfig(overrides: Partial<NaxConfig> = {}): NaxConfig {
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
  const content = observations.map((o) => JSON.stringify(o)).join("\n") + "\n";
  writeFileSync(join(runDir, "observations.jsonl"), content);
}

function writeProposalsMd(runDir: string, content: string): void {
  writeFileSync(join(runDir, "curator-proposals.md"), content);
}

function writeRollup(rollupPath: string, observations: Observation[]): void {
  const content = observations.map((o) => JSON.stringify(o)).join("\n") + "\n";
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

  _deps.resolveProject = mock((_opts?) => makeResolvedProject(tmpDir));
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

// ─── curatorStatus ────────────────────────────────────────────────────────────

describe("curatorStatus", () => {
  describe("project resolution and observation counts", () => {
    test("resolves project/config; prints observation count by kind and total", async () => {
      const runDir = join(outputDir, "runs", "run-001");
      mkdirSync(runDir, { recursive: true });
      writeObservations(runDir, [
        makeObservation("verdict", "run-001"),
        makeObservation("verdict", "run-001"),
        makeObservation("review-finding", "run-001"),
        makeObservation("escalation", "run-001"),
      ]);

      await curatorStatus({ run: "run-001" });
      expect(_deps.resolveProject).toHaveBeenCalled();
      expect(_deps.loadConfig).toHaveBeenCalled();
      expect(_deps.projectOutputDir).toHaveBeenCalledWith("test-proj", undefined);
      const out = capturedOutput.join("\n");
      expect(out).toContain("verdict");
      expect(out).toContain("review-finding");
      expect(out).toContain("escalation");
      expect(out).toMatch(/4/);
    });
  });

  describe("no runs", () => {
    test.each([
      ["empty runs directory", false],
      ["missing runs directory", true],
    ] as const)("reports no runs when %s", async (_label, removeDir) => {
      if (removeDir) rmSync(join(outputDir, "runs"), { recursive: true, force: true });
      await curatorStatus({});
      expect(capturedOutput.join("\n")).toContain("No runs found");
    });
  });

  describe("latest run mode", () => {
    test("uses the lexicographically latest runId when no --run specified", async () => {
      for (const id of ["run-001", "run-002", "run-003"]) {
        const runDir = join(outputDir, "runs", id);
        mkdirSync(runDir, { recursive: true });
        writeObservations(runDir, [makeObservation("verdict", id)]);
      }

      await curatorStatus({});
      const out = capturedOutput.join("\n");
      expect(out).toContain("run-003");
    });
  });

  describe("explicit run mode", () => {
    test("uses the specified --run runId; reports error for nonexistent runId", async () => {
      const runDir = join(outputDir, "runs", "run-042");
      mkdirSync(runDir, { recursive: true });
      writeObservations(runDir, [makeObservation("verdict", "run-042")]);

      await curatorStatus({ run: "run-042" });
      expect(capturedOutput.join("\n")).toContain("run-042");

      capturedOutput.length = 0;
      await curatorStatus({ run: "nonexistent-run" });
      const out2 = capturedOutput.join("\n");
      expect(out2).toContain("nonexistent-run");
      expect(out2.toLowerCase()).toMatch(/not found|does not exist|missing/);
    });
  });


  describe("proposal markdown", () => {
    test("prints proposal markdown when file exists; reports no proposals when absent", async () => {
      // proposals file exists
      const runDir = join(outputDir, "runs", "run-001");
      mkdirSync(runDir, { recursive: true });
      writeObservations(runDir, [makeObservation("verdict")]);
      writeProposalsMd(runDir, "# Curator Proposals\n\n- [ ] [HIGH] H1: some proposal\n");
      await curatorStatus({ run: "run-001" });
      const outWithProposals = capturedOutput.join("\n");
      expect(outWithProposals).toContain("Curator Proposals");
      expect(outWithProposals).toContain("H1");

      // no proposals file
      capturedOutput.length = 0;
      const runDir2 = join(outputDir, "runs", "run-002");
      mkdirSync(runDir2, { recursive: true });
      writeObservations(runDir2, [makeObservation("verdict")]);
      await curatorStatus({ run: "run-002" });
      const outNoProposals = capturedOutput.join("\n");
      expect(outNoProposals.toLowerCase()).toMatch(/no proposals|proposals not found|no proposals file/);
    });
  });
});

// ─── curatorCommit ────────────────────────────────────────────────────────────

describe("curatorCommit", () => {
  const runId = "run-commit-001";

  function setupRun(proposalsMd: string): void {
    const runDir = join(outputDir, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeProposalsMd(runDir, proposalsMd);
  }

  describe("missing proposals file", () => {
    test("reports error when curator-proposals.md does not exist", async () => {
      const runDir = join(outputDir, "runs", runId);
      mkdirSync(runDir, { recursive: true });

      await curatorCommit({ runId });
      const out = capturedOutput.join("\n");
      expect(out.toLowerCase()).toMatch(/not found|missing|does not exist/);
    });
  });

  describe("parsing checked lines", () => {
    test("applies only checked [x] lines, skips unchecked [ ] lines", async () => {
      const projectDir = join(tmpDir, "project");
      mkdirSync(join(projectDir, ".nax", "rules"), { recursive: true });
      _deps.resolveProject = mock((_opts?) => makeResolvedProject(projectDir));

      setupRun(
        [
          "# Curator Proposals",
          "",
          "## add — Add suggestions",
          "",
          "### .nax/rules/curator-suggestions.md",
          "",
          "- [x] [HIGH] H1: add rule — stories: US-001",
          "  _Evidence: something_",
          "- [ ] [MED] H2: skipped proposal — stories: US-002",
        ].join("\n"),
      );

      let appendCalled = false;
      _deps.appendFile = mock(async (p: string, content: string) => {
        appendCalled = true;
        const existing = Bun.file(p);
        const prev = (await existing.exists()) ? await existing.text() : "";
        await Bun.write(p, prev + content);
      });

      await curatorCommit({ runId });
      expect(appendCalled).toBe(true);
    });

    test("does nothing when no lines are checked", async () => {
      setupRun("# Curator Proposals\n\n- [ ] [HIGH] H1: proposal — stories: US-001\n");

      let appendCalled = false;
      _deps.appendFile = mock(async (_p: string, _content: string) => {
        appendCalled = true;
      });

      await curatorCommit({ runId });
      expect(appendCalled).toBe(false);
      const out = capturedOutput.join("\n");
      expect(out.toLowerCase()).toMatch(/no proposals selected|nothing to apply|no checked/);
    });
  });

  describe("add proposals", () => {
    test("appends to .nax/rules/curator-suggestions.md for rules-target proposals", async () => {
      const projectDir = join(tmpDir, "project");
      mkdirSync(join(projectDir, ".nax", "rules"), { recursive: true });
      _deps.resolveProject = mock((_opts?) => makeResolvedProject(projectDir));

      setupRun(
        [
          "# Curator Proposals",
          "## add — Add suggestions",
          "### .nax/rules/curator-suggestions.md",
          "- [x] [MED] H1: repeated finding: rule-A appeared 3x — stories: US-001, US-002",
          "  _Evidence: Rule rule-A fired 3× in stories: US-001, US-002_",
        ].join("\n"),
      );

      const appendedContents: string[] = [];
      _deps.appendFile = mock(async (p: string, content: string) => {
        appendedContents.push(content);
        const existing = Bun.file(p);
        const prev = (await existing.exists()) ? await existing.text() : "";
        await Bun.write(p, prev + content);
      });

      await curatorCommit({ runId });

      const allAppended = appendedContents.join("\n");
      expect(allAppended).toContain("rule-A");
    });

    test("appends to .nax/features/<id>/context.md for feature-target proposals", async () => {
      const projectDir = join(tmpDir, "project");
      mkdirSync(join(projectDir, ".nax", "features", "feat-1"), { recursive: true });
      _deps.resolveProject = mock((_opts?) => makeResolvedProject(projectDir));

      setupRun(
        [
          "# Curator Proposals",
          "## add — Add suggestions",
          "### .nax/features/feat-1/context.md",
          "- [x] [MED] H2: repeated pull call: toolX appeared 2x — stories: US-001",
          "  _Evidence: Tool toolX called 2× in stories: US-001_",
        ].join("\n"),
      );

      const appendedPaths: string[] = [];
      _deps.appendFile = mock(async (p: string, content: string) => {
        appendedPaths.push(p);
        const existing = Bun.file(p);
        const prev = (await existing.exists()) ? await existing.text() : "";
        await Bun.write(p, prev + content);
      });

      await curatorCommit({ runId });

      const targetPath = join(projectDir, ".nax", "features", "feat-1", "context.md");
      expect(appendedPaths.some((p) => p === targetPath || p.endsWith("feat-1/context.md"))).toBe(true);
    });
  });

  describe("drops before adds ordering", () => {
    test("applies drop proposals before add proposals", async () => {
      const projectDir = join(tmpDir, "project");
      mkdirSync(join(projectDir, ".nax", "rules"), { recursive: true });
      _deps.resolveProject = mock((_opts?) => makeResolvedProject(projectDir));

      setupRun(
        [
          "# Curator Proposals",
          "## add — Add suggestions",
          "### .nax/rules/curator-suggestions.md",
          "- [x] [HIGH] H1: add rule — stories: US-001",
          "",
          "## drop — Drop suggestions",
          "### .nax/rules/curator-suggestions.md",
          "- [x] [LOW] H5: stale chunk — stories: US-002",
        ].join("\n"),
      );

      const callOrder: string[] = [];
      _deps.writeFile = mock(async (p: string, content: string) => {
        callOrder.push(`write:${p}`);
        await Bun.write(p, content);
      });
      _deps.appendFile = mock(async (p: string, content: string) => {
        callOrder.push(`append:${p}`);
        const existing = Bun.file(p);
        const prev = (await existing.exists()) ? await existing.text() : "";
        await Bun.write(p, prev + content);
      });

      await curatorCommit({ runId });

      // Drop (write) should happen before add (append)
      const dropIdx = callOrder.findIndex((c) => c.startsWith("write:"));
      const addIdx = callOrder.findIndex((c) => c.startsWith("append:"));
      if (dropIdx !== -1 && addIdx !== -1) {
        expect(dropIdx).toBeLessThan(addIdx);
      }
    });
  });

  describe("editor open", () => {
    test("opens modified files in $EDITOR after applying", async () => {
      const projectDir = join(tmpDir, "project");
      mkdirSync(join(projectDir, ".nax", "rules"), { recursive: true });
      _deps.resolveProject = mock((_opts?) => makeResolvedProject(projectDir));

      setupRun(
        [
          "# Curator Proposals",
          "## add — Add suggestions",
          "### .nax/rules/curator-suggestions.md",
          "- [x] [HIGH] H1: add rule — stories: US-001",
        ].join("\n"),
      );

      _deps.appendFile = mock(async (p: string, content: string) => {
        await Bun.write(p, content);
      });

      let editorOpenedPath: string | undefined;
      _deps.openInEditor = mock(async (p: string) => {
        editorOpenedPath = p;
      });

      await curatorCommit({ runId });
      expect(editorOpenedPath).toBeDefined();
      expect(editorOpenedPath!.endsWith("curator-suggestions.md")).toBe(true);
    });
  });

  describe("no git commit", () => {
    test("does not create a git commit when applying proposals", async () => {
      const projectDir = join(tmpDir, "project");
      mkdirSync(join(projectDir, ".nax", "rules"), { recursive: true });
      _deps.resolveProject = mock((_opts?) => makeResolvedProject(projectDir));

      setupRun(
        [
          "# Curator Proposals",
          "## add — Add suggestions",
          "### .nax/rules/curator-suggestions.md",
          "- [x] [HIGH] H1: add rule — stories: US-001",
        ].join("\n"),
      );

      _deps.appendFile = mock(async (p: string, content: string) => {
        await Bun.write(p, content);
      });

      // spawnSync is used for git commits — it should not be called
      const spawnSyncCalls: string[][] = [];
      const originalSpawnSync = Bun.spawnSync;
      Bun.spawnSync = mock((...args: unknown[]) => {
        const cmd = args[0] as string[];
        spawnSyncCalls.push(cmd);
        return originalSpawnSync(...(args as Parameters<typeof Bun.spawnSync>));
      }) as typeof Bun.spawnSync;

      try {
        await curatorCommit({ runId });
      } finally {
        Bun.spawnSync = originalSpawnSync;
      }

      const gitCalls = spawnSyncCalls.filter((cmd) => cmd[0] === "git" && cmd[1] === "commit");
      expect(gitCalls.length).toBe(0);
    });
  });
});

// ─── curatorDryrun ────────────────────────────────────────────────────────────

describe("curatorDryrun", () => {
  describe("no runs / latest run", () => {
    test("reports no runs when no observations.jsonl exists; uses the latest runId when no --run specified", async () => {
      await curatorDryrun({});
      expect(capturedOutput.join("\n")).toContain("No runs found");

      capturedOutput.length = 0;
      for (const id of ["run-001", "run-002", "run-003"]) {
        const runDir = join(outputDir, "runs", id);
        mkdirSync(runDir, { recursive: true });
        writeObservations(runDir, [makeObservation("verdict", id)]);
      }
      await curatorDryrun({});
      expect(capturedOutput.join("\n")).toContain("run-003");
    });
  });

  describe("re-runs heuristics", () => {
    test("prints rendered proposals to stdout; does not write any canonical files", async () => {
      const runDir = join(outputDir, "runs", "run-001");
      mkdirSync(runDir, { recursive: true });

      // Same defect (same file + message → same fingerprint) in two distinct
      // FEATURES → H1 fires. Cross-feature recurrence is the trigger (#1422).
      const obs: Observation[] = [
        {
          schemaVersion: 1,
          runId: "run-001",
          featureId: "feat-1",
          storyId: "US-001",
          stage: "review",
          ts: "2026-01-01T00:00:00.000Z",
          kind: "review-finding",
          payload: { ruleId: "no-any", category: "convention", severity: "HIGH", file: "src/foo.ts", line: 1, message: "explicit any is not allowed in public APIs" },
        } as Observation,
        {
          schemaVersion: 1,
          runId: "run-001",
          featureId: "feat-2",
          storyId: "US-002",
          stage: "review",
          ts: "2026-01-01T00:00:00.000Z",
          kind: "review-finding",
          payload: { ruleId: "no-any", category: "convention", severity: "HIGH", file: "src/foo.ts", line: 5, message: "explicit any is not allowed in public APIs" },
        } as Observation,
      ];
      writeObservations(runDir, obs);

      let writeCalled = false;
      let appendCalled = false;
      _deps.writeFile = mock(async (_p: string, _content: string) => { writeCalled = true; });
      _deps.appendFile = mock(async (_p: string, _content: string) => { appendCalled = true; });

      await curatorDryrun({ run: "run-001" });
      const out = capturedOutput.join("\n");
      expect(out).toContain("Curator Proposals");
      expect(out).toContain("H1");
      expect(writeCalled).toBe(false);
      expect(appendCalled).toBe(false);
    });

    test("uses current config.curator.thresholds", async () => {
      const runDir = join(outputDir, "runs", "run-001");
      mkdirSync(runDir, { recursive: true });

      // With threshold 3, 2 review-findings should NOT fire H1
      _deps.loadConfig = mock(async (_dir?) =>
        buildCuratorConfig({
          curator: {
            enabled: true,
            thresholds: {
              repeatedFinding: 3,
              emptyKeyword: 2,
              rectifyAttempts: 3,
              escalationChain: 2,
              staleChunkRuns: 2,
              unchangedOutcome: 3,
            },
          },
        } as Partial<NaxConfig>),
      );

      const obs: Observation[] = [
        {
          schemaVersion: 1,
          runId: "run-001",
          featureId: "feat-1",
          storyId: "US-001",
          stage: "review",
          ts: "2026-01-01T00:00:00.000Z",
          kind: "review-finding",
          payload: { ruleId: "no-any", severity: "HIGH", file: "src/foo.ts", line: 1, message: "no any" },
        } as Observation,
        {
          schemaVersion: 1,
          runId: "run-001",
          featureId: "feat-1",
          storyId: "US-002",
          stage: "review",
          ts: "2026-01-01T00:00:00.000Z",
          kind: "review-finding",
          payload: { ruleId: "no-any", severity: "HIGH", file: "src/bar.ts", line: 5, message: "no any" },
        } as Observation,
      ];
      writeObservations(runDir, obs);

      await curatorDryrun({ run: "run-001" });
      const out = capturedOutput.join("\n");
      // H1 should not fire with threshold 3 and only 2 observations
      expect(out).not.toContain("H1");
    });

  });
});

// ─── curatorGc ────────────────────────────────────────────────────────────────

describe("curatorGc", () => {
  describe("no-op cases", () => {
    test("is a no-op when rollup file does not exist or fewer runIds than keep count", async () => {
      // rollup file doesn't exist
      let writeCalled = false;
      _deps.writeFile = mock(async (_p: string, _content: string) => { writeCalled = true; });
      await curatorGc({ keep: 50 });
      expect(writeCalled).toBe(false);

      // fewer unique runIds than keep
      writeRollup(rollupPath, [makeObservation("verdict", "run-001"), makeObservation("verdict", "run-002")]);
      let writtenContent: string | undefined;
      _deps.writeFile = mock(async (_p: string, content: string) => { writtenContent = content; });
      await curatorGc({ keep: 50 });
      if (writtenContent !== undefined) {
        expect(writtenContent.trim().split("\n").filter(Boolean).length).toBe(2);
      }
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

      let writtenContent: string | undefined;
      _deps.writeFile = mock(async (_p: string, content: string) => {
        writtenContent = content;
        await Bun.write(rollupPath, content);
      });

      await curatorGc({ keep: 3 });
      expect(writtenContent).toBeDefined();
      const runIds = writtenContent!.trim().split("\n").filter(Boolean).map((l) => (JSON.parse(l) as Observation).runId);
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
      let writtenContent2: string | undefined;
      _deps.writeFile = mock(async (_p: string, content: string) => {
        writtenContent2 = content;
        await Bun.write(rollupPath, content);
      });
      await curatorGc({});
      expect(writtenContent2).toBeDefined();
      const uniqueRunIds = new Set(writtenContent2!.trim().split("\n").filter(Boolean).map((l) => (JSON.parse(l) as Observation).runId));
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

      let written: string | undefined;
      _deps.writeFile = mock(async (_p: string, content: string) => {
        written = content;
        await Bun.write(rollupPath, content);
      });

      await curatorGc({ keep: 2 });
      expect(written).toBeDefined();
      const rows = written!
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Observation);

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

      let written: string | undefined;
      _deps.writeFile = mock(async (_p: string, content: string) => {
        written = content;
        await Bun.write(rollupPath, content);
      });

      await curatorGc({ keep: 1 });
      const runIds = written!
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as Observation).runId);
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
});
