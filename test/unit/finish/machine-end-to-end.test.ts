/**
 * The finish state machine driven end to end over the real `createFinishOps`.
 *
 * Every other finish test stubs a single module. This one wires the real ops
 * factory into the real machine and fakes only the three process boundaries:
 * the git subprocess (`_finishGitDeps.git`), the forge CLI (`forge.run`) and
 * the LLM call (`_finishOpsDeps.callOp`). The artifacts the ops read —
 * `prd.json`, `status.json`, `spec.md` — are written into a real temp dir and
 * read through the untouched `_finishPrDeps.readText`, so the pr-body loader
 * sees real files and the rendered PR body is built from them. If the machine,
 * the ops and the body builder disagree about a shape, this suite is where it
 * surfaces rather than in plan 5's wiring.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "@/config";
import type { NaxConfig } from "@/config";
import type { ForgeDeps } from "@/forge";
import type { CallContext } from "@/operations";
import {
  _acceptanceGateDeps,
  _finishGitDeps,
  _finishOpsDeps,
  _finishPrDeps,
  _qualityGateDeps,
  createFinishOps,
  createFinishState,
  resultPath,
  runFinishMachine,
} from "@/finish";
import type { FinishContext, FinishMachineDeps, FinishState } from "@/finish";
import { withTempDir } from "@test/helpers";

const PR_URL = "https://forge.example/pr/1";
const RUN_ID = "run-1";
const FEATURE = "feat";

const originalGit = _finishGitDeps.git;
const originalAcceptanceRun = _acceptanceGateDeps.run;
const originalQuality = { ..._qualityGateDeps };
const originalOps = { ..._finishOpsDeps };
const originalPrRun = _finishPrDeps.run;

afterEach(() => {
  _finishGitDeps.git = originalGit;
  _acceptanceGateDeps.run = originalAcceptanceRun;
  _qualityGateDeps.run = originalQuality.run;
  _qualityGateDeps.loadConfig = originalQuality.loadConfig;
  _qualityGateDeps.loadPackageOverride = originalQuality.loadPackageOverride;
  Object.assign(_finishOpsDeps, originalOps);
  _finishPrDeps.run = originalPrRun;
});

function configWithCommands(commands: NaxConfig["quality"]["commands"]): NaxConfig {
  return { ...DEFAULT_CONFIG, quality: { ...DEFAULT_CONFIG.quality, commands } };
}

function baseContext(specPath: string): FinishContext {
  return {
    base: "origin/main",
    specPath,
    acceptanceStatus: "ok",
    groups: [{ packageDir: "", testPath: "test/acceptance/feat.test.ts", exists: true, cwd: "" }],
    testFileRegex: ["\\.test\\.ts$"],
    commitsAhead: 3,
    route: "proceed",
  };
}

/** Clean git tree: `status --porcelain` empty, so no commit, but push still runs. */
function installGitStub(): void {
  _finishGitDeps.git = async (args: string[]) => {
    const cmd = args[0];
    if (cmd === "status") return { exitCode: 0, stdout: "", stderr: "" };
    if (cmd === "rev-parse") return { exitCode: 0, stdout: "sha1", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

function installAcceptanceGateStub(): void {
  _acceptanceGateDeps.run = async () => ({
    commandName: "acceptance",
    command: "bun test",
    success: true,
    exitCode: 0,
    output: "acceptance ok",
    durationMs: 1,
    timedOut: false,
  });
}

function installQualityGateStub(): void {
  _qualityGateDeps.loadConfig = async () => configWithCommands({ test: "true" });
  _qualityGateDeps.loadPackageOverride = async () => null;
  _qualityGateDeps.run = async () => ({
    commandName: "test",
    command: "true",
    success: true,
    exitCode: 0,
    output: "ok",
    durationMs: 1,
    timedOut: false,
  });
}

/** The diffstat subprocesses `loadFinishPrContext` runs; everything else is unreachable. */
function installPrRunStub(): void {
  _finishPrDeps.run = async (cmd: string[]) => {
    if (cmd.includes("--shortstat")) {
      return { exitCode: 0, stdout: " 2 files changed, 40 insertions(+)\n", stderr: "" };
    }
    return { exitCode: 0, stdout: " src/a.ts | 5 ++++-\n src/b.ts | 2 +-\n", stderr: "" };
  };
}

interface ForgeRecorder {
  calls: string[][];
  editBodies: string[];
  commentBodies: string[];
  draftCreates: number;
}

/**
 * The forge CLI, routed by `gh pr <action>`. `view` always reports an open
 * draft so the promote path goes list -> create(draft) -> ready -> edit, and
 * `postEscalation` always finds an existing PR and posts a comment.
 */
function installForgeStub(): { forge: ForgeDeps; recorder: ForgeRecorder } {
  const recorder: ForgeRecorder = { calls: [], editBodies: [], commentBodies: [], draftCreates: 0 };
  const forge: ForgeDeps = {
    run: async (cmd: string[]) => {
      recorder.calls.push(cmd);
      switch (cmd[2]) {
        case "list":
          return { exitCode: 0, stdout: "[]", stderr: "" };
        case "view":
          return { exitCode: 0, stdout: JSON.stringify({ isDraft: true, url: PR_URL }), stderr: "" };
        case "create": {
          if (cmd.includes("--draft")) recorder.draftCreates += 1;
          return { exitCode: 0, stdout: PR_URL, stderr: "" };
        }
        case "ready":
          return { exitCode: 0, stdout: "", stderr: "" };
        case "edit": {
          const body = cmd[cmd.indexOf("--body") + 1];
          if (body !== undefined) recorder.editBodies.push(body);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        case "comment": {
          const body = cmd[cmd.indexOf("--body") + 1];
          if (body !== undefined) recorder.commentBodies.push(body);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        default:
          return { exitCode: 0, stdout: "", stderr: "" };
      }
    },
    readText: async () => null,
  };
  return { forge, recorder };
}

function installCallOpStub(opts: { specReviewThrows?: boolean; narrativeThrows?: boolean }): void {
  _finishOpsDeps.callOp = (async (ctx: CallContext, op: { name: string }, _input: unknown) => {
    if (op.name === "finish-review") {
      if (opts.specReviewThrows && ctx.sessionOverride?.role === "finish-review-spec") {
        throw new Error("spec review agent exploded");
      }
      return {
        findings: [],
        gaps: [],
        touchpoints: [],
        walk: [],
        sawNoFindings: true,
        sawTouchpointsSection: true,
        sawWalkSection: true,
      };
    }
    if (op.name === "finish-fix") return { dispositions: [] };
    if (op.name === "finish-narrative") {
      if (opts.narrativeThrows) throw new Error("narrator agent exploded");
      return { narrative: "Implements the demo feature end to end.", title: "feat: demo" };
    }
    return {};
  }) as typeof _finishOpsDeps.callOp;
}

/** Write the feature's run artifacts so the untouched `_finishPrDeps.readText` reads them. */
async function writeArtifacts(dir: string): Promise<string> {
  const featureDirPath = join(dir, ".nax", "features", FEATURE);
  await mkdir(featureDirPath, { recursive: true });
  await writeFile(
    join(featureDirPath, "prd.json"),
    JSON.stringify({
      userStories: [{ id: "US-001", title: "First story", acceptanceCriteria: ["a", "b", "c"] }],
      outOfScope: ["not in scope"],
    }),
  );
  await writeFile(
    join(featureDirPath, "status.json"),
    JSON.stringify({
      postRun: { acceptance: { status: "passed" }, regression: { status: "passed" } },
      durationMs: 42_000,
      progress: { passed: 3, total: 3 },
    }),
  );
  const specPath = join(featureDirPath, "spec.md");
  await writeFile(specPath, "## Summary\nShips the feature end to end.\n");
  return specPath;
}

interface MakeMachineResult {
  deps: FinishMachineDeps;
  state: FinishState;
  recorder: ForgeRecorder;
}

function makeMachine(
  dir: string,
  specPath: string,
  opts: { specReviewThrows?: boolean; narrativeThrows?: boolean } = {},
): MakeMachineResult {
  installGitStub();
  installAcceptanceGateStub();
  installQualityGateStub();
  installPrRunStub();
  installCallOpStub(opts);
  const { forge, recorder } = installForgeStub();
  const audit = { auditDir: join(dir, "audit"), runId: RUN_ID };
  const ops = createFinishOps({ callCtx: {} as CallContext, forge, forgeKind: "github" as const, audit });
  let tick = 0;
  const deps: FinishMachineDeps = {
    context: baseContext(specPath),
    ops,
    audit,
    now: () => `2026-08-19T00:00:${String(tick++).padStart(2, "0")}.000Z`,
  };
  const state = createFinishState({
    feature: FEATURE,
    workdir: dir,
    branch: "feat/finish-pr-escalate",
    runId: RUN_ID,
    base: "origin/main",
    specPath,
  });
  return { deps, state, recorder };
}

describe("machine-end-to-end", () => {
  test("a clean run reaches promoted with a PR body built from artifacts", async () => {
    await withTempDir(async (dir) => {
      const specPath = await writeArtifacts(dir);
      const { deps, state, recorder } = makeMachine(dir, specPath);

      const result = await runFinishMachine(state, deps);

      expect(result.status).toBe("promoted");
      expect(recorder.draftCreates).toBe(1);
      expect(recorder.editBodies.length).toBeGreaterThan(0);
      const lastEditBody = recorder.editBodies[recorder.editBodies.length - 1];
      expect(lastEditBody).toContain("## Verification");
      expect(lastEditBody).toContain("| US-001 | First story | 3 |");
      // D4.12 — the gates the machine actually ran must survive to the rendered
      // body; an unwired `state.gatesRan` would silently render no line at all.
      expect(lastEditBody).toContain("- Gates: test");
    });
  });

  test("a review that throws escalates with a comment and a written result file", async () => {
    await withTempDir(async (dir) => {
      const specPath = await writeArtifacts(dir);
      const { deps, state, recorder } = makeMachine(dir, specPath, { specReviewThrows: true });

      const result = await runFinishMachine(state, deps);

      expect(result.status).toBe("escalated");
      expect(result.escalationReason).toContain("spec review agent exploded");
      expect(recorder.commentBodies).toHaveLength(1);
      expect(recorder.commentBodies[0]).toContain("nax-finish escalation");
      const onDisk = JSON.parse(await readFile(resultPath(deps.audit), "utf8")) as { status?: string };
      expect(onDisk.status).toBe("escalated");
    });
  });

  test("a narrator failure leaves the run promoted", async () => {
    await withTempDir(async (dir) => {
      const specPath = await writeArtifacts(dir);
      const { deps, state, recorder } = makeMachine(dir, specPath, { narrativeThrows: true });

      const result = await runFinishMachine(state, deps);

      expect(result.status).toBe("promoted");
      expect(recorder.commentBodies).toHaveLength(0);
    });
  });
});
