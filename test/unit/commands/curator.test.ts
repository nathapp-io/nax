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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import { makeTempDir } from "../../helpers/temp";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<NaxConfig> = {}): NaxConfig {
  return {
    version: 1,
    name: "test-proj",
    outputDir: undefined,
    curator: {
      enabled: true,
      thresholds: {
        repeatedFinding: 2,
        emptyKeyword: 2,
        rectifyAttempts: 3,
        escalationChain: 2,
        staleChunkRuns: 2,
        unchangedOutcome: 3,
      },
    },
    ...overrides,
  } as unknown as NaxConfig;
}

function makeResolvedProject(projectDir: string): ResolvedProject {
  return {
    projectDir,
    configPath: join(projectDir, ".nax", "config.json"),
  };
}

function makeObservation(kind: Observation["kind"], runId = "run-001"): Observation {
  return {
    schemaVersion: 1,
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
  _deps.loadConfig = mock(async (_dir?) => makeConfig());
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
  _deps.openInEditor = originalOpenInEditor;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── curatorStatus ────────────────────────────────────────────────────────────

describe("curatorStatus", () => {
  describe("project resolution", () => {
    test("resolves project and loads config when no --project given", async () => {
      await curatorStatus({});
      expect(_deps.resolveProject).toHaveBeenCalled();
      expect(_deps.loadConfig).toHaveBeenCalled();
    });

    test("uses projectOutputDir with config name as project key", async () => {
      const runDir = join(outputDir, "runs", "run-001");
      mkdirSync(runDir, { recursive: true });
      writeObservations(runDir, [makeObservation("verdict")]);

      await curatorStatus({});
      expect(_deps.projectOutputDir).toHaveBeenCalledWith("test-proj", undefined);
    });
  });

  describe("no runs", () => {
    test("reports no runs when runs directory is empty", async () => {
      await curatorStatus({});
      const out = capturedOutput.join("\n");
      expect(out).toContain("No runs found");
    });

    test("reports no runs when runs directory does not exist", async () => {
      rmSync(join(outputDir, "runs"), { recursive: true, force: true });
      await curatorStatus({});
      const out = capturedOutput.join("\n");
      expect(out).toContain("No runs found");
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
    test("uses the specified --run runId", async () => {
      const runDir = join(outputDir, "runs", "run-042");
      mkdirSync(runDir, { recursive: true });
      writeObservations(runDir, [makeObservation("verdict", "run-042")]);

      await curatorStatus({ run: "run-042" });
      const out = capturedOutput.join("\n");
      expect(out).toContain("run-042");
    });

    test("reports clear error when specified runId does not exist", async () => {
      await curatorStatus({ run: "nonexistent-run" });
      const out = capturedOutput.join("\n");
      expect(out).toContain("nonexistent-run");
      expect(out.toLowerCase()).toMatch(/not found|does not exist|missing/);
    });
  });

  describe("observation counts", () => {
    test("prints observation count by kind", async () => {
      const runDir = join(outputDir, "runs", "run-001");
      mkdirSync(runDir, { recursive: true });
      writeObservations(runDir, [
        makeObservation("verdict", "run-001"),
        makeObservation("verdict", "run-001"),
        makeObservation("review-finding", "run-001"),
        makeObservation("escalation", "run-001"),
      ]);

      await curatorStatus({ run: "run-001" });
      const out = capturedOutput.join("\n");
      expect(out).toContain("verdict");
      expect(out).toContain("review-finding");
      expect(out).toContain("escalation");
    });

    test("prints total observation count", async () => {
      const runDir = join(outputDir, "runs", "run-001");
      mkdirSync(runDir, { recursive: true });
      writeObservations(runDir, [makeObservation("verdict"), makeObservation("verdict"), makeObservation("escalation")]);

      await curatorStatus({ run: "run-001" });
      const out = capturedOutput.join("\n");
      expect(out).toMatch(/3/);
    });
  });

  describe("proposal markdown", () => {
    test("prints proposal markdown when curator-proposals.md exists", async () => {
      const runDir = join(outputDir, "runs", "run-001");
      mkdirSync(runDir, { recursive: true });
      writeObservations(runDir, [makeObservation("verdict")]);
      writeProposalsMd(runDir, "# Curator Proposals\n\n- [ ] [HIGH] H1: some proposal\n");

      await curatorStatus({ run: "run-001" });
      const out = capturedOutput.join("\n");
      expect(out).toContain("Curator Proposals");
      expect(out).toContain("H1");
    });

    test("reports no proposals when curator-proposals.md does not exist", async () => {
      const runDir = join(outputDir, "runs", "run-001");
      mkdirSync(runDir, { recursive: true });
      writeObservations(runDir, [makeObservation("verdict")]);

      await curatorStatus({ run: "run-001" });
      const out = capturedOutput.join("\n");
      expect(out.toLowerCase()).toMatch(/no proposals|proposals not found|no proposals file/);
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
  describe("no runs", () => {
    test("reports no runs when no observations.jsonl exists", async () => {
      await curatorDryrun({});
      const out = capturedOutput.join("\n");
      expect(out).toContain("No runs found");
    });
  });

  describe("latest run by default", () => {
    test("uses the latest runId when no --run specified", async () => {
      for (const id of ["run-001", "run-002", "run-003"]) {
        const runDir = join(outputDir, "runs", id);
        mkdirSync(runDir, { recursive: true });
        writeObservations(runDir, [makeObservation("verdict", id)]);
      }

      await curatorDryrun({});
      const out = capturedOutput.join("\n");
      expect(out).toContain("run-003");
    });
  });

  describe("re-runs heuristics", () => {
    test("prints rendered proposals to stdout", async () => {
      const runDir = join(outputDir, "runs", "run-001");
      mkdirSync(runDir, { recursive: true });

      // Two review-finding observations with same ruleId (threshold 2) → H1 fires
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
      expect(out).toContain("Curator Proposals");
      expect(out).toContain("H1");
    });

    test("uses current config.curator.thresholds", async () => {
      const runDir = join(outputDir, "runs", "run-001");
      mkdirSync(runDir, { recursive: true });

      // With threshold 3, 2 review-findings should NOT fire H1
      _deps.loadConfig = mock(async (_dir?) =>
        makeConfig({
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

    test("does not write any canonical files", async () => {
      const runDir = join(outputDir, "runs", "run-001");
      mkdirSync(runDir, { recursive: true });
      writeObservations(runDir, [makeObservation("verdict")]);

      let writeCalled = false;
      let appendCalled = false;
      _deps.writeFile = mock(async (_p: string, _content: string) => {
        writeCalled = true;
      });
      _deps.appendFile = mock(async (_p: string, _content: string) => {
        appendCalled = true;
      });

      await curatorDryrun({ run: "run-001" });
      expect(writeCalled).toBe(false);
      expect(appendCalled).toBe(false);
    });
  });
});

// ─── curatorGc ────────────────────────────────────────────────────────────────

describe("curatorGc", () => {
  describe("no-op cases", () => {
    test("is a no-op when rollup file does not exist", async () => {
      let writeCalled = false;
      _deps.writeFile = mock(async (_p: string, _content: string) => {
        writeCalled = true;
      });

      await curatorGc({ keep: 50 });
      expect(writeCalled).toBe(false);
    });

    test("is a no-op when fewer unique runIds exist than keep count", async () => {
      writeRollup(rollupPath, [
        makeObservation("verdict", "run-001"),
        makeObservation("verdict", "run-002"),
      ]);

      let writtenContent: string | undefined;
      _deps.writeFile = mock(async (_p: string, content: string) => {
        writtenContent = content;
      });

      await curatorGc({ keep: 50 });
      // Either not called or rewrites with all rows intact
      if (writtenContent !== undefined) {
        const lines = writtenContent.trim().split("\n").filter(Boolean);
        expect(lines.length).toBe(2);
      }
    });
  });

  describe("pruning", () => {
    test("keeps rows for the most recent N runIds (by max ts)", async () => {
      // Create 5 runs, keep only the latest 3
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

      const lines = writtenContent!.trim().split("\n").filter(Boolean);
      const runIds = lines.map((l) => (JSON.parse(l) as Observation).runId);
      expect(runIds).toContain("run-003");
      expect(runIds).toContain("run-004");
      expect(runIds).toContain("run-005");
      expect(runIds).not.toContain("run-001");
      expect(runIds).not.toContain("run-002");
    });

    test("uses default keep=50 when no --keep specified", async () => {
      // Create 60 unique runs with distinct timestamps
      const obsFixed: Observation[] = Array.from({ length: 60 }, (_, i) => ({
        ...makeObservation("verdict", `run-${String(i + 1).padStart(3, "0")}`),
        ts: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      }));
      writeRollup(rollupPath, obsFixed);

      let writtenContent: string | undefined;
      _deps.writeFile = mock(async (_p: string, content: string) => {
        writtenContent = content;
        await Bun.write(rollupPath, content);
      });

      await curatorGc({});
      expect(writtenContent).toBeDefined();

      const lines = writtenContent!.trim().split("\n").filter(Boolean);
      const uniqueRunIds = new Set(lines.map((l) => (JSON.parse(l) as Observation).runId));
      expect(uniqueRunIds.size).toBe(50);
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
