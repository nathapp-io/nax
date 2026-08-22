/**
 * Happy-path and edge-route coverage for `runFinishMachine`, complementing
 * `machine-invariants.test.ts`. These drive the same stub `FinishOps` /
 * `_deps` seams end to end and assert on the observable call trail and the
 * returned `FinishResult` — never on machine internals.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { AcceptanceGroupResult } from "@/cli";
import { DEFAULT_CONFIG } from "@/config";
import type { NaxConfig } from "@/config";
import {
  MAX_INCOMPLETE_ATTEMPTS,
  _acceptanceGateDeps,
  _finishGitDeps,
  _qualityGateDeps,
  createFinishState,
  runFinishMachine,
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

function configWithCommands(commands: NaxConfig["quality"]["commands"]): NaxConfig {
  return { ...DEFAULT_CONFIG, quality: { ...DEFAULT_CONFIG.quality, commands } };
}

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

function baseState(overrides: Partial<FinishState> = {}): FinishState {
  const state = createFinishState({
    feature: "feat",
    workdir: "/repo",
    branch: "feat/x",
    runId: "run-1",
    base: "origin/main",
    specPath: ".nax/features/feat/spec.md",
  });
  return { ...state, ...overrides };
}

function makeOps(trail: string[], overrides: Partial<FinishOps> = {}): FinishOps {
  return {
    review: async (phase) => {
      trail.push(`review:${phase}`);
      return { findings: [], gaps: [] };
    },
    fix: async (phase) => {
      trail.push(`fix:${phase}`);
      return {};
    },
    openDraftPr: async () => {
      trail.push("openDraftPr");
      return { url: "https://forge.example/pr/1" };
    },
    promotePr: async () => {
      trail.push("promotePr");
      return { status: "opened" as const };
    },
    escalate: async (_state, reason) => {
      trail.push(`escalate:${reason}`);
      return {};
    },
    ...overrides,
  };
}

function installGitStub(trail: string[]): void {
  let shaCounter = 0;
  _finishGitDeps.git = async (args: string[]) => {
    const cmd = args[0];
    if (cmd === "rev-parse") {
      shaCounter += 1;
      return { stdout: `sha${shaCounter}`, stderr: "", exitCode: 0 };
    }
    if (cmd === "status") return { stdout: " M file.ts\n", stderr: "", exitCode: 0 };
    if (cmd === "add") return { stdout: "", stderr: "", exitCode: 0 };
    if (cmd === "commit") {
      trail.push("commit");
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (cmd === "show") return { stdout: "src/prod.ts\n", stderr: "", exitCode: 0 };
    if (cmd === "push") return { stdout: "", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  };
}

function installAcceptanceGateStub(trail: string[], run?: () => { exitCode: number }): void {
  const runFn = run ?? (() => ({ exitCode: 0 }));
  _acceptanceGateDeps.run = async () => {
    trail.push("acceptance-run");
    const r = runFn();
    return {
      commandName: "acceptance",
      command: "bun test",
      success: r.exitCode === 0,
      exitCode: r.exitCode,
      output: "acceptance output",
      durationMs: 1,
      timedOut: false,
    };
  };
}

function installQualityGateStub(trail: string[], commands: NaxConfig["quality"]["commands"] = { test: "true" }): void {
  _qualityGateDeps.loadConfig = async () => configWithCommands(commands);
  _qualityGateDeps.loadPackageOverride = async () => null;
  _qualityGateDeps.run = async (o: QualityCommandOptions): Promise<QualityCommandResult> => {
    trail.push(`quality-run:${o.commandName}`);
    return {
      commandName: o.commandName,
      command: o.command,
      success: true,
      exitCode: 0,
      output: "ok",
      durationMs: 1,
      timedOut: false,
    };
  };
}

interface MakeDepsOpts {
  auditDir: string;
  context?: Partial<FinishContext>;
  ops?: Partial<FinishOps>;
  acceptanceRun?: () => { exitCode: number };
  qualityCommands?: NaxConfig["quality"]["commands"];
}

function makeDeps(opts: MakeDepsOpts): { deps: FinishMachineDeps; trail: string[] } {
  const trail: string[] = [];
  installGitStub(trail);
  installAcceptanceGateStub(trail, opts.acceptanceRun);
  installQualityGateStub(trail, opts.qualityCommands);
  const ops = makeOps(trail, opts.ops);
  const audit: AuditTarget = { auditDir: opts.auditDir, runId: "run-1" };
  let tick = 0;
  const deps: FinishMachineDeps = {
    context: baseContext(opts.context),
    ops,
    audit,
    now: () => {
      tick += 1;
      return `2026-08-18T00:00:${String(tick).padStart(2, "0")}.000Z`;
    },
  };
  return { deps, trail };
}

describe("machine-loops", () => {
  test("happy path: opens a draft PR after acceptance, and promotes it at the end", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail } = makeDeps({ auditDir: dir });
      const state = baseState();
      const result = await runFinishMachine(state, deps);

      expect(result.status).toBe("opened");
      expect(state.prUrl).toBe("https://forge.example/pr/1");
      expect(trail.filter((e) => e === "openDraftPr")).toHaveLength(1);
      expect(trail.filter((e) => e === "promotePr")).toHaveLength(1);
      expect(trail.indexOf("openDraftPr")).toBeLessThan(trail.indexOf("promotePr"));
      // Draft opens right after the first (only) successful acceptance pass,
      // before either reviewer ever runs.
      expect(trail.indexOf("openDraftPr")).toBeLessThan(trail.indexOf("review:spec"));
    });
  });

  test("a terminal result carries headSha/branch for the ledger (#1674 part 1)", async () => {
    await withTempDir(async (dir) => {
      const { deps } = makeDeps({ auditDir: dir });
      const state = baseState();
      const result = await runFinishMachine(state, deps);

      expect(result.branch).toBe("feat/x");
      expect(result.headSha).toBeDefined();
      expect(typeof result.headSha).toBe("string");
    });
  });

  test("nothing-to-finish: never calls a reviewer, never opens a PR", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail } = makeDeps({ auditDir: dir, context: { route: "nothing-to-finish" } });
      const state = baseState();
      const result = await runFinishMachine(state, deps);

      expect(result.status).toBe("nothing-to-finish");
      expect(result.url).toBeUndefined();
      // A plain zero-commits preflight carries neither marker — only the
      // merged-PR short-circuit below does.
      expect(result.skipReason).toBeUndefined();
      expect(trail).toHaveLength(0);
    });
  });

  test("merged-PR route (#1674 part 2): nothing-to-finish carrying skipReason and the PR url", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail } = makeDeps({
        auditDir: dir,
        context: { route: "nothing-to-finish", skipReason: "pr-merged", prUrl: "https://forge.example/pr/7" },
      });
      const result = await runFinishMachine(baseState(), deps);

      expect(result.status).toBe("nothing-to-finish");
      expect(result.skipReason).toBe("pr-merged");
      expect(result.url).toBe("https://forge.example/pr/7");
      // Nothing ran: no reviewer, no fixer, no commit onto a merged branch.
      expect(trail).toHaveLength(0);
    });
  });

  test("already-finished route (#1674 part 1 ledger hit): never calls a reviewer, reports skipReason", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail } = makeDeps({
        auditDir: dir,
        context: { route: "already-finished", prUrl: "https://forge.example/pr/5" },
      });
      const state = baseState();
      const result = await runFinishMachine(state, deps);

      expect(result.status).toBe("nothing-to-finish");
      expect(result.skipReason).toBe("already-finished");
      expect(result.url).toBe("https://forge.example/pr/5");
      expect(trail).toHaveLength(0);
    });
  });

  test("closed-PR escalate route (#1674 part 2) passes push:false through to ops.escalate", async () => {
    await withTempDir(async (dir) => {
      const seen: Array<{ push?: boolean } | undefined> = [];
      const { deps } = makeDeps({
        auditDir: dir,
        context: { route: "escalate", escalateWithoutPush: true, reason: "the PR is closed" },
        ops: {
          escalate: async (_state, _reason, _findings, options) => {
            seen.push(options);
            return {};
          },
        },
      });
      const result = await runFinishMachine(baseState(), deps);

      expect(result.status).toBe("escalated");
      expect(seen).toEqual([{ push: false }]);
    });
  });

  test("an ordinary escalate route leaves ops.escalate's push alone", async () => {
    await withTempDir(async (dir) => {
      const seen: Array<{ push?: boolean } | undefined> = [];
      const { deps } = makeDeps({
        auditDir: dir,
        context: { route: "escalate", reason: "base ref not fetched locally" },
        ops: {
          escalate: async (_state, _reason, _findings, options) => {
            seen.push(options);
            return {};
          },
        },
      });
      await runFinishMachine(baseState(), deps);

      expect(seen).toEqual([undefined]);
    });
  });

  test("escalate route: escalates immediately, no reviewer, no PR", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail } = makeDeps({
        auditDir: dir,
        context: { route: "escalate", reason: "base ref not fetched locally" },
      });
      const result = await runFinishMachine(baseState(), deps);

      expect(result.status).toBe("escalated");
      expect(result.escalationReason).toBe("base ref not fetched locally");
      expect(trail.filter((e) => e.startsWith("review:") || e === "openDraftPr")).toHaveLength(0);
    });
  });

  test("disabled acceptance status: skips both acceptance runs, still runs the repo gates", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail } = makeDeps({ auditDir: dir, context: { acceptanceStatus: "disabled" } });
      const result = await runFinishMachine(baseState(), deps);

      expect(result.status).toBe("opened");
      expect(trail.filter((e) => e === "acceptance-run")).toHaveLength(0);
      expect(trail.filter((e) => e === "quality-run:test")).toHaveLength(1);
    });
  });

  test("green gate pass records the gate names on state.gatesRan", async () => {
    await withTempDir(async (dir) => {
      const { deps } = makeDeps({ auditDir: dir });
      const state = baseState();
      await runFinishMachine(state, deps);
      expect(state.gatesRan).toEqual(["test"]);
    });
  });

  test("incomplete route: re-reviews exactly once (MAX_INCOMPLETE_ATTEMPTS) then escalates", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail } = makeDeps({
        auditDir: dir,
        ops: {
          review: async (phase) => {
            trail.push(`review:${phase}`);
            if (phase !== "spec") return { findings: [], gaps: [] };
            return { findings: [], gaps: ["never opened the touchpoint it cited"] };
          },
        },
      });
      const result = await runFinishMachine(baseState(), deps);

      expect(result.status).toBe("escalated");
      expect(result.escalationReason).toMatch(/reading obligations/i);
      const specReviews = trail.filter((e) => e === "review:spec");
      expect(specReviews).toHaveLength(MAX_INCOMPLETE_ATTEMPTS + 1);
      expect(trail.some((e) => e === "fix:spec")).toBe(false);
    });
  });
});
