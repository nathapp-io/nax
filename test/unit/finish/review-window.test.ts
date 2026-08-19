/**
 * Coverage for the re-review window (`reviewSince`) and gap notice
 * (`reviewGaps`) added to `FinishPhaseState` — the state this plan's later
 * prompts read `since`/`gaps` from (D3.1/D3.2).
 *
 * Drives `runFinishMachine` with stub `FinishOps` exactly like
 * `machine-loops.test.ts` / `machine-invariants.test.ts`: assertions read the
 * `FinishState` the ops saw at call time, the returned `FinishResult`, or a
 * plain `createFinishState`/`serializeFinishState` round trip — never machine
 * internals.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { AcceptanceGroupResult } from "@/cli";
import { DEFAULT_CONFIG } from "@/config";
import type { NaxConfig } from "@/config";
import {
  _acceptanceGateDeps,
  _finishGitDeps,
  _qualityGateDeps,
  createFinishState,
  runFinishMachine,
  serializeFinishState,
} from "@/finish";
import type { AuditTarget, Finding, FinishContext, FinishMachineDeps, FinishOps, FinishState } from "@/finish";
import type { QualityCommandOptions, QualityCommandResult } from "@/quality";
import { withTempDir } from "@test/helpers";

const originalGit = _finishGitDeps.git;
const originalAcceptanceRun = _acceptanceGateDeps.run;
const originalQuality = { ..._qualityGateDeps };
afterEach(() => {
  _finishGitDeps.git = originalGit;
  _acceptanceGateDeps.run = originalAcceptanceRun;
  _qualityGateDeps.run = originalQuality.run;
  _qualityGateDeps.loadConfig = originalQuality.loadConfig;
  _qualityGateDeps.loadPackageOverride = originalQuality.loadPackageOverride;
});

const FINDING: Finding = { severity: "HIGH", title: "fix me", problem: "p", fix: "f" };

function baseContext(overrides: Partial<FinishContext> = {}): FinishContext {
  const group: AcceptanceGroupResult = {
    packageDir: "",
    testPath: "test/acceptance/feat.test.ts",
    exists: true,
    cwd: "",
  };
  return {
    base: "origin/main",
    specPath: ".nax/features/feat/spec.md",
    acceptanceStatus: "ok",
    groups: [group],
    testFileRegex: ["\\.test\\.ts$"],
    commitsAhead: 3,
    route: "proceed",
    ...overrides,
  };
}

function baseState(): FinishState {
  return createFinishState({
    feature: "feat",
    workdir: "/repo",
    branch: "feat/x",
    runId: "run-1",
    base: "origin/main",
    specPath: ".nax/features/feat/spec.md",
  });
}

/** Every "status" call in call order says dirty or clean; extra calls default to clean. */
function installGitStub(dirtySequence: boolean[]): void {
  let shaCounter = 0;
  let statusCall = 0;
  _finishGitDeps.git = async (args: string[]) => {
    const cmd = args[0];
    if (cmd === "rev-parse") {
      shaCounter += 1;
      return { stdout: `sha${shaCounter}`, stderr: "", exitCode: 0 };
    }
    if (cmd === "status") {
      const dirty = dirtySequence[statusCall] ?? false;
      statusCall += 1;
      return { stdout: dirty ? " M file.ts\n" : "", stderr: "", exitCode: 0 };
    }
    if (cmd === "add") return { stdout: "", stderr: "", exitCode: 0 };
    if (cmd === "commit") return { stdout: "", stderr: "", exitCode: 0 };
    if (cmd === "show") return { stdout: "src/prod.ts\n", stderr: "", exitCode: 0 };
    if (cmd === "push") return { stdout: "", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  };
}

/** Every acceptance-gate run in call order returns this exit code; extra calls default to passing. */
function installAcceptanceGateStub(exitCodes: number[]): void {
  let call = 0;
  _acceptanceGateDeps.run = async () => {
    const exitCode = exitCodes[call] ?? 0;
    call += 1;
    return {
      commandName: "acceptance",
      command: "bun test",
      success: exitCode === 0,
      exitCode,
      output: "acceptance output",
      durationMs: 1,
      timedOut: false,
    };
  };
}

function installQualityGateStub(commands: NaxConfig["quality"]["commands"] = { test: "true" }): void {
  _qualityGateDeps.loadConfig = async () => ({ ...DEFAULT_CONFIG, quality: { ...DEFAULT_CONFIG.quality, commands } });
  _qualityGateDeps.loadPackageOverride = async () => null;
  _qualityGateDeps.run = async (o: QualityCommandOptions): Promise<QualityCommandResult> => ({
    commandName: o.commandName,
    command: o.command,
    success: true,
    exitCode: 0,
    output: "ok",
    durationMs: 1,
    timedOut: false,
  });
}

function makeDeps(context: Partial<FinishContext>, ops: FinishOps, auditDir: string): FinishMachineDeps {
  let tick = 0;
  return {
    context: baseContext(context),
    ops,
    audit: { auditDir, runId: "run-1" } satisfies AuditTarget,
    now: () => {
      tick += 1;
      return `2026-08-18T00:00:${String(tick).padStart(2, "0")}.000Z`;
    },
  };
}

describe("review window and gap notice", () => {
  test("a commit made by the acceptance loop during a spec-fix round sets phases.spec.reviewSince to " +
    "that commit's shaBefore, a second commit in the same round does not overwrite it, and the next " +
    "spec review observes it then loses it on the following call", async () => {
    await withTempDir(async (dir) => {
      // 1 spec fix commit that lands empty (no window) + 2 acceptance-loop
      // fix commits that both land (the first must win).
      installGitStub([false, true, true]);
      // step-2 gate passes; the spec-fix I8 reverify fails twice then
      // passes; gate-zero (inside the quality-gate loop) passes.
      installAcceptanceGateStub([0, 1, 1, 0, 0]);
      installQualityGateStub();

      const specObservations: Array<{ reviewSince?: string; reviewGaps?: string[] }> = [];
      let specReviewCalls = 0;
      const ops: FinishOps = {
        review: async (phase, req) => {
          if (phase !== "spec") return { findings: [], gaps: [] };
          specReviewCalls += 1;
          specObservations.push({
            reviewSince: req.state.phases.spec.reviewSince,
            reviewGaps: req.state.phases.spec.reviewGaps,
          });
          return specReviewCalls === 1 ? { findings: [FINDING], gaps: [] } : { findings: [], gaps: [] };
        },
        fix: async () => ({}),
        openDraftPr: async () => ({ url: "https://forge.example/pr/1" }),
        promotePr: async () => ({ status: "opened" as const }),
        escalate: async () => ({}),
      };

      const deps = makeDeps({}, ops, dir);
      const result = await runFinishMachine(baseState(), deps);

      expect(result.status).not.toBe("escalated");
      expect(specObservations).toHaveLength(2);
      // First spec review call: nothing has landed since its last verdict yet.
      expect(specObservations[0]).toEqual({ reviewSince: undefined, reviewGaps: undefined });
      // Second call: sees the *first* acceptance-loop commit's shaBefore,
      // not the second one that landed after it in the same round.
      expect(specObservations[1]).toEqual({ reviewSince: "sha2", reviewGaps: undefined });
    });
  });

  test("an incomplete verdict puts its gaps on state, the next review call sees them, and they clear after", async () => {
    await withTempDir(async (dir) => {
      installGitStub([]);
      installAcceptanceGateStub([0, 0]);
      installQualityGateStub();

      const specObservations: Array<{ reviewGaps?: string[] }> = [];
      let specReviewCalls = 0;
      const ops: FinishOps = {
        review: async (phase, req) => {
          if (phase !== "spec") return { findings: [], gaps: [] };
          specReviewCalls += 1;
          specObservations.push({ reviewGaps: req.state.phases.spec.reviewGaps });
          if (specReviewCalls === 1) return { findings: [], gaps: ["never opened the touchpoint it cited"] };
          return { findings: [], gaps: [] };
        },
        fix: async () => ({}),
        openDraftPr: async () => ({ url: "https://forge.example/pr/1" }),
        promotePr: async () => ({ status: "opened" as const }),
        escalate: async () => ({}),
      };

      const deps = makeDeps({}, ops, dir);
      const result = await runFinishMachine(baseState(), deps);

      expect(result.status).not.toBe("escalated");
      expect(specObservations).toHaveLength(2);
      expect(specObservations[0]?.reviewGaps).toBeUndefined();
      // The gap set by the first (incomplete) call survives to the retry...
      expect(specObservations[1]?.reviewGaps).toEqual(["never opened the touchpoint it cited"]);
    });
  });

  test("a fresh state serializes with neither reviewSince nor reviewGaps present", () => {
    const state = baseState();
    expect(state.phases.spec.reviewSince).toBeUndefined();
    expect(state.phases.spec.reviewGaps).toBeUndefined();
    expect(state.phases.quality.reviewSince).toBeUndefined();
    expect(state.phases.quality.reviewGaps).toBeUndefined();

    const json = serializeFinishState(state);
    expect(json).not.toContain("reviewSince");
    expect(json).not.toContain("reviewGaps");
  });
});
