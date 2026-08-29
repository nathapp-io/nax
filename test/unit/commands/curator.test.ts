/**
 * Unit tests for src/commands/curator.ts
 *
 * Tests all acceptance criteria:
 * - curatorStatus: project resolution, observation counts, proposal markdown, latest/explicit run
 * - curatorCommit: checked [x] parsing, drops before adds, canonical writes, editor open, no git commit
 * - curatorDryrun: re-runs heuristics, prints to stdout, no canonical file writes
 *
 * curatorGc lives in curator-gc.test.ts.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertDefined, type DeepPartial, makeNaxConfig, makeTempDir } from "@test/helpers";
import type { ResolvedProject } from "@/commands/common";
import { _curatorCmdDeps as _deps, curatorCommit, curatorDryrun, curatorStatus } from "@/commands/curator";
import type { NaxConfig } from "@/config";
import type { Observation } from "@/plugins/builtin/curator/types";

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

/** `Observation` is a union keyed on `kind` with a per-variant `payload`; these tests use only these three. */
type TestKind = "verdict" | "review-finding" | "escalation";

function makeObservation(kind: TestKind, runId = "run-001", projectKey = "test-proj"): Observation {
  const base = {
    schemaVersion: 3 as const,
    projectKey,
    runId,
    featureId: "feat-1",
    storyId: "US-001",
    stage: "review",
    ts: "2026-01-01T00:00:00.000Z",
  };
  switch (kind) {
    case "verdict":
      return { ...base, kind, payload: { status: "completed", cost: 0, tokens: 0 } };
    case "review-finding":
      return { ...base, kind, payload: { ruleId: "rule-1", severity: "warning", file: "a.ts", line: 1, message: "m" } };
    case "escalation":
      return { ...base, kind, payload: { from: "fast", to: "balanced" } };
  }
}

function writeObservations(runDir: string, observations: Observation[]): void {
  const content = `${observations.map((o) => JSON.stringify(o)).join("\n")}\n`;
  writeFileSync(join(runDir, "observations.jsonl"), content);
}

function writeProposalsMd(runDir: string, content: string): void {
  writeFileSync(join(runDir, "curator-proposals.md"), content);
}

function _writeRollup(rollupPath: string, observations: Observation[]): void {
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
      _deps.resolveProject = mock(async (_opts?) => makeResolvedProject(projectDir));

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
      _deps.resolveProject = mock(async (_opts?) => makeResolvedProject(projectDir));

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
      _deps.resolveProject = mock(async (_opts?) => makeResolvedProject(projectDir));

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

  describe("target path containment", () => {
    test("skips (does not write) a proposal whose ### heading escapes the allowed targets via path traversal", async () => {
      const projectDir = join(tmpDir, "project");
      mkdirSync(join(projectDir, ".nax", "rules"), { recursive: true });
      _deps.resolveProject = mock(async (_opts?) => makeResolvedProject(projectDir));

      setupRun(
        [
          "# Curator Proposals",
          "## add — Add suggestions",
          "### ../../../etc/whatever.md",
          "- [x] [MED] H1: escape attempt — stories: US-001",
          "  _Evidence: n/a_",
        ].join("\n"),
      );

      let writeCalled = false;
      _deps.appendFile = mock(async () => {
        writeCalled = true;
      });
      _deps.writeFile = mock(async () => {
        writeCalled = true;
      });

      await curatorCommit({ runId });
      expect(writeCalled).toBe(false);
      const out = capturedOutput.join("\n");
      expect(out).toMatch(/\[skip\].*not an allowed curator target/);
    });

    test("skips a proposal targeting a shape outside .nax/rules/ or .nax/features/*/context.md", async () => {
      // e.g. .nax/config.json — inside .nax/ but not one of the two shapes
      // curator actually writes.
      const projectDir = join(tmpDir, "project");
      mkdirSync(join(projectDir, ".nax"), { recursive: true });
      _deps.resolveProject = mock(async (_opts?) => makeResolvedProject(projectDir));

      setupRun(
        [
          "# Curator Proposals",
          "## add — Add suggestions",
          "### .nax/config.json",
          "- [x] [MED] H1: not a rules or context target — stories: US-001",
          "  _Evidence: n/a_",
        ].join("\n"),
      );

      let writeCalled = false;
      _deps.appendFile = mock(async () => {
        writeCalled = true;
      });

      await curatorCommit({ runId });
      expect(writeCalled).toBe(false);
    });

    test("allows a proposal targeting .nax/features/<id>/context.md (not just .nax/rules/)", async () => {
      const projectDir = join(tmpDir, "project");
      mkdirSync(join(projectDir, ".nax", "features", "feat-1"), { recursive: true });
      _deps.resolveProject = mock(async (_opts?) => makeResolvedProject(projectDir));

      setupRun(
        [
          "# Curator Proposals",
          "## add — Add suggestions",
          "### .nax/features/feat-1/context.md",
          "- [x] [MED] H2: legit feature-scoped target — stories: US-001",
          "  _Evidence: n/a_",
        ].join("\n"),
      );

      let appendCalled = false;
      _deps.appendFile = mock(async (p: string, content: string) => {
        appendCalled = true;
        await Bun.write(p, content);
      });

      await curatorCommit({ runId });
      expect(appendCalled).toBe(true);
    });
  });

  describe("content neutrality lint before append", () => {
    test("skips (does not append) a rules-store add proposal whose content fails the neutrality linter", async () => {
      const projectDir = join(tmpDir, "project");
      mkdirSync(join(projectDir, ".nax", "rules"), { recursive: true });
      _deps.resolveProject = mock(async (_opts?) => makeResolvedProject(projectDir));

      // The description text lands verbatim in the appended HTML comment
      // (buildAddContent) — an emoji here would otherwise break the
      // canonical rules store the next time it loads.
      setupRun(
        [
          "# Curator Proposals",
          "## add — Add suggestions",
          "### .nax/rules/curator-suggestions.md",
          "- [x] [HIGH] H1: ship it 🚀 always — stories: US-001",
          "  _Evidence: n/a_",
        ].join("\n"),
      );

      let writeCalled = false;
      _deps.appendFile = mock(async () => {
        writeCalled = true;
      });

      await curatorCommit({ runId });
      expect(writeCalled).toBe(false);
      const out = capturedOutput.join("\n");
      expect(out).toMatch(/\[skip\].*neutrality linter/);
    });

    test("one proposal failing lint does not block other valid proposals in the same commit", async () => {
      const projectDir = join(tmpDir, "project");
      mkdirSync(join(projectDir, ".nax", "rules"), { recursive: true });
      mkdirSync(join(projectDir, ".nax", "features", "feat-1"), { recursive: true });
      _deps.resolveProject = mock(async (_opts?) => makeResolvedProject(projectDir));

      setupRun(
        [
          "# Curator Proposals",
          "## add — Add suggestions",
          "### .nax/rules/curator-suggestions.md",
          "- [x] [HIGH] H1: ship it 🚀 always — stories: US-001",
          "  _Evidence: n/a_",
          "### .nax/features/feat-1/context.md",
          "- [x] [MED] H2: a valid unrelated proposal — stories: US-002",
          "  _Evidence: n/a_",
        ].join("\n"),
      );

      const appendedPaths: string[] = [];
      _deps.appendFile = mock(async (p: string, content: string) => {
        appendedPaths.push(p);
        await Bun.write(p, content);
      });

      await curatorCommit({ runId });
      expect(appendedPaths.some((p) => p.endsWith("feat-1/context.md"))).toBe(true);
      expect(appendedPaths.some((p) => p.endsWith("curator-suggestions.md"))).toBe(false);
    });

    test("does NOT lint add proposals targeting .nax/features/<id>/context.md", async () => {
      // Feature context.md isn't the canonical rules store the orchestrator
      // fails closed on — lint scope is intentionally narrower than
      // path-containment scope.
      const projectDir = join(tmpDir, "project");
      mkdirSync(join(projectDir, ".nax", "features", "feat-1"), { recursive: true });
      _deps.resolveProject = mock(async (_opts?) => makeResolvedProject(projectDir));

      setupRun(
        [
          "# Curator Proposals",
          "## add — Add suggestions",
          "### .nax/features/feat-1/context.md",
          "- [x] [HIGH] H1: ship it 🚀 always — stories: US-001",
          "  _Evidence: n/a_",
        ].join("\n"),
      );

      let appendCalled = false;
      _deps.appendFile = mock(async (p: string, content: string) => {
        appendCalled = true;
        await Bun.write(p, content);
      });

      await curatorCommit({ runId });
      expect(appendCalled).toBe(true);
    });
  });

  describe("drops before adds ordering", () => {
    test("applies drop proposals before add proposals", async () => {
      const projectDir = join(tmpDir, "project");
      mkdirSync(join(projectDir, ".nax", "rules"), { recursive: true });
      _deps.resolveProject = mock(async (_opts?) => makeResolvedProject(projectDir));

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
      _deps.resolveProject = mock(async (_opts?) => makeResolvedProject(projectDir));

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
      assertDefined(editorOpenedPath, "editorOpenedPath");
      expect(editorOpenedPath.endsWith("curator-suggestions.md")).toBe(true);
    });
  });

  describe("no git commit", () => {
    test("does not create a git commit when applying proposals", async () => {
      const projectDir = join(tmpDir, "project");
      mkdirSync(join(projectDir, ".nax", "rules"), { recursive: true });
      _deps.resolveProject = mock(async (_opts?) => makeResolvedProject(projectDir));

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
          payload: {
            ruleId: "no-any",
            category: "convention",
            severity: "HIGH",
            file: "src/foo.ts",
            line: 1,
            message: "explicit any is not allowed in public APIs",
          },
        } as Observation,
        {
          schemaVersion: 1,
          runId: "run-001",
          featureId: "feat-2",
          storyId: "US-002",
          stage: "review",
          ts: "2026-01-01T00:00:00.000Z",
          kind: "review-finding",
          payload: {
            ruleId: "no-any",
            category: "convention",
            severity: "HIGH",
            file: "src/foo.ts",
            line: 5,
            message: "explicit any is not allowed in public APIs",
          },
        } as Observation,
      ];
      writeObservations(runDir, obs);

      let writeCalled = false;
      let appendCalled = false;
      _deps.writeFile = mock(async (_p: string, _content: string) => {
        writeCalled = true;
      });
      _deps.appendFile = mock(async (_p: string, _content: string) => {
        appendCalled = true;
      });

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
        }),
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
