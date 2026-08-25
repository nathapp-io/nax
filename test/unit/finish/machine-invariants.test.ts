/**
 * One named test per I1-I8 invariant from the Task 8 brief, each driving
 * `runFinishMachine` end to end with stub `FinishOps` and stubbed `_deps`
 * seams (`_finishGitDeps`, `_acceptanceGateDeps`, `_qualityGateDeps`) rather
 * than reaching into machine internals. Every assertion reads either the
 * returned `FinishResult`, the audit trail on disk (`readRounds`), or a call
 * trail recorded by the stubs themselves.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { withTempDir } from "@test/helpers";
import type { AcceptanceGroupResult } from "@/cli";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config";
import type {
  AuditTarget,
  Finding,
  FinishContext,
  FinishMachineDeps,
  FinishOps,
  FinishState,
  ReviewOutcome,
} from "@/finish";
import {
  _acceptanceGateDeps,
  _finishGitDeps,
  _qualityGateDeps,
  createFinishState,
  gateCommitRoute,
  MAX_FIX_ATTEMPTS,
  readRounds,
  runFinishMachine,
} from "@/finish";
import type { QualityCommandOptions, QualityCommandResult } from "@/quality";

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

interface GitHandlers {
  onCommit?: () => void;
  filesInCommit?: string[];
}

function installGitStub(trail: string[], handlers: GitHandlers = {}): void {
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
      handlers.onCommit?.();
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (cmd === "show")
      return { stdout: (handlers.filesInCommit ?? ["src/prod.ts"]).join("\n"), stderr: "", exitCode: 0 };
    if (cmd === "push") return { stdout: "", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  };
}

type GateRunFn = () => { exitCode: number; output?: string };

function installAcceptanceGateStub(trail: string[], run?: GateRunFn): void {
  const runFn: GateRunFn = run ?? (() => ({ exitCode: 0 }));
  _acceptanceGateDeps.run = async () => {
    trail.push("acceptance-run");
    const r = runFn();
    return {
      commandName: "acceptance",
      command: "bun test",
      success: r.exitCode === 0,
      exitCode: r.exitCode,
      output: r.output ?? "acceptance output",
      durationMs: 1,
      timedOut: false,
    };
  };
}

function installQualityGateStub(
  trail: string[],
  opts: { commands?: NaxConfig["quality"]["commands"]; run?: GateRunFn } = {},
): void {
  const commands = opts.commands ?? { test: "true" };
  _qualityGateDeps.loadConfig = async () => configWithCommands(commands);
  _qualityGateDeps.loadPackageOverride = async () => null;
  const runFn: GateRunFn = opts.run ?? (() => ({ exitCode: 0 }));
  _qualityGateDeps.run = async (o: QualityCommandOptions): Promise<QualityCommandResult> => {
    trail.push(`quality-run:${o.commandName}`);
    const r = runFn();
    return {
      commandName: o.commandName,
      command: o.command,
      success: r.exitCode === 0,
      exitCode: r.exitCode,
      output: r.output ?? "gate output",
      durationMs: 1,
      timedOut: false,
    };
  };
}

interface MakeDepsOpts {
  auditDir: string;
  context?: Partial<FinishContext>;
  ops?: Partial<FinishOps>;
  signal?: AbortSignal;
  git?: GitHandlers;
  acceptanceRun?: () => { exitCode: number; output?: string };
  qualityCommands?: NaxConfig["quality"]["commands"];
  qualityRun?: () => { exitCode: number; output?: string };
}

function makeDeps(opts: MakeDepsOpts): { deps: FinishMachineDeps; trail: string[] } {
  const trail: string[] = [];
  installGitStub(trail, opts.git ?? {});
  installAcceptanceGateStub(trail, opts.acceptanceRun);
  installQualityGateStub(trail, { commands: opts.qualityCommands, run: opts.qualityRun });
  const ops = makeOps(trail, opts.ops);
  const audit: AuditTarget = { auditDir: opts.auditDir, runId: "run-1" };
  let tick = 0;
  const deps: FinishMachineDeps = {
    context: baseContext(opts.context),
    ops,
    audit,
    signal: opts.signal,
    now: () => {
      tick += 1;
      return `2026-08-18T00:00:${String(tick).padStart(2, "0")}.000Z`;
    },
  };
  return { deps, trail };
}

function assertFixImmediatelyFollowedByCommit(trail: string[]): void {
  trail.forEach((entry, i) => {
    if (entry.startsWith("fix:")) {
      expect(trail[i + 1]).toBe("commit");
    }
  });
}

describe("I1 — nothing verified is not a pass (two distinct bugs)", () => {
  test("empty acceptance groups escalate", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail } = makeDeps({ auditDir: dir, context: { groups: [] } });
      const result = await runFinishMachine(baseState(), deps);
      expect(result.status).toBe("escalated");
      expect(result.escalationReason).toMatch(/nothing verified/i);
      expect(trail.some((e) => e.startsWith("fix:"))).toBe(false);
    });
  });

  test("no gate commands anywhere escalates", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail } = makeDeps({ auditDir: dir, qualityCommands: {} });
      const result = await runFinishMachine(baseState(), deps);
      expect(result.status).toBe("escalated");
      expect(result.escalationReason).toMatch(/no quality\.commands configured/i);
      expect(trail.some((e) => e.startsWith("fix:gate"))).toBe(false);
    });
  });
});

test("I2 — every ops.fix call is followed by a commit before the next ops.review call", async () => {
  await withTempDir(async (dir) => {
    let qualityCalls = 0;
    const { deps, trail } = makeDeps({
      auditDir: dir,
      ops: {
        review: async (phase) => {
          trail.push(`review:${phase}`);
          if (phase !== "quality") return { findings: [], gaps: [] };
          qualityCalls += 1;
          return qualityCalls === 1 ? { findings: [FINDING], gaps: [] } : { findings: [], gaps: [] };
        },
      },
    });
    const result = await runFinishMachine(baseState(), deps);
    expect(result.status).not.toBe("escalated");
    assertFixImmediatelyFollowedByCommit(trail);
    expect(trail.filter((e) => e === "commit").length).toBeGreaterThan(0);
  });
});

describe("I3 — the fix-attempt cap comes from the loop, never from the model", () => {
  test("a reviewer returning findings forever escalates after exactly MAX_FIX_ATTEMPTS fixes", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail } = makeDeps({
        auditDir: dir,
        ops: {
          review: async (phase) => {
            trail.push(`review:${phase}`);
            return phase === "quality" ? { findings: [FINDING], gaps: [] } : { findings: [], gaps: [] };
          },
        },
      });
      const result = await runFinishMachine(baseState(), deps);
      expect(result.status).toBe("escalated");
      expect(trail.filter((e) => e === "fix:quality").length).toBe(MAX_FIX_ATTEMPTS);
    });
  });

  test("a reviewer claiming 'clean' out of band while still returning findings does not shorten the loop", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail } = makeDeps({
        auditDir: dir,
        ops: {
          review: async (phase) => {
            trail.push(`review:${phase}`);
            if (phase !== "quality") return { findings: [], gaps: [] };
            // A misbehaving op stashing an extra field claiming "clean" —
            // routeReview must derive the route only from findings/gaps.
            // Assigned to a variable (not returned as a fresh literal) so the
            // excess `route` property is accepted without widening the
            // declared ReviewOutcome return type.
            const outcomeWithExtraRoute: ReviewOutcome & { route: string } = {
              findings: [FINDING],
              gaps: [],
              route: "clean",
            };
            return outcomeWithExtraRoute;
          },
        },
      });
      const result = await runFinishMachine(baseState(), deps);
      expect(result.status).toBe("escalated");
      expect(trail.filter((e) => e === "fix:quality").length).toBe(MAX_FIX_ATTEMPTS);
    });
  });
});

describe("I4 — every committed gate fix re-enters quality review, test-only included (#1510)", () => {
  test.each([
    ["production code", ["src/prod.ts"], "changed"],
    ["test files only", ["test/unit/foo.test.ts"], "tests-only"],
  ] as const)("a gate fix committing %s re-enters ops.review('quality')", async (_label, files, expectedRoute) => {
    await withTempDir(async (dir) => {
      let gateRunCount = 0;
      const { deps, trail } = makeDeps({
        auditDir: dir,
        git: { filesInCommit: [...files] },
        qualityRun: () => {
          gateRunCount += 1;
          return { exitCode: gateRunCount === 1 ? 1 : 0 };
        },
      });
      const result = await runFinishMachine(baseState(), deps);
      expect(result.status).not.toBe("escalated");
      const fixIdx = trail.indexOf("fix:gate");
      expect(fixIdx).toBeGreaterThanOrEqual(0);
      expect(trail.slice(fixIdx).includes("review:quality")).toBe(true);
      expect(gateCommitRoute(true, [...files], ["\\.test\\.ts$"])).toBe(expectedRoute);
    });
  });
});

test("I5 — acceptance runs again inside the quality-gate step, before any repo gate command", async () => {
  await withTempDir(async (dir) => {
    const { deps, trail } = makeDeps({ auditDir: dir });
    await runFinishMachine(baseState(), deps);
    const acceptanceIndices = trail
      .map((e, i) => ({ e, i }))
      .filter((x) => x.e === "acceptance-run")
      .map((x) => x.i);
    const qualityIdx = trail.indexOf("quality-run:test");
    // First acceptance-run is step 2; the second is gate zero, and must
    // precede the repo gate command.
    expect(acceptanceIndices.length).toBeGreaterThanOrEqual(2);
    expect(acceptanceIndices[1]).toBeLessThan(qualityIdx);
  });
});

test("I6 — a machine aborted after the first commit still leaves that round in the trail", async () => {
  await withTempDir(async (dir) => {
    const controller = new AbortController();
    let firstReview = true;
    const { deps } = makeDeps({
      auditDir: dir,
      signal: controller.signal,
      git: { onCommit: () => controller.abort() },
      ops: {
        review: async (phase) => {
          if (phase === "quality" && firstReview) {
            firstReview = false;
            return { findings: [FINDING], gaps: [] };
          }
          return { findings: [], gaps: [] };
        },
      },
    });
    const result = await runFinishMachine(baseState(), deps);
    expect(result.status).toBe("escalated");
    expect(result.escalationReason).toMatch(/abort/i);

    const rounds = await readRounds(deps.audit);
    const committedQuality = rounds.filter((r) => r.phase === "quality" && r.committed);
    expect(committedQuality).toHaveLength(1);
    expect(committedQuality[0]?.outcome).toBe("fixed");
  });
});

describe("I7 — a throw from any op or gate-running function reaches ops.escalate", () => {
  const targets: string[] = ["review", "fix", "openDraftPr", "promotePr", "acceptanceGate", "qualityGate"];

  test.each(targets)("a throw from %s reaches ops.escalate via the single outer catch", async (target) => {
    await withTempDir(async (dir) => {
      const err = new Error(`boom from ${target}`);
      const opsOverrides: Partial<FinishOps> = {};
      let acceptanceRun: (() => { exitCode: number }) | undefined;
      let qualityRun: (() => { exitCode: number }) | undefined;

      if (target === "review") {
        opsOverrides.review = async () => {
          throw err;
        };
      } else if (target === "fix") {
        opsOverrides.review = async (phase) =>
          phase === "spec" ? { findings: [FINDING], gaps: [] } : { findings: [], gaps: [] };
        opsOverrides.fix = async () => {
          throw err;
        };
      } else if (target === "openDraftPr") {
        opsOverrides.openDraftPr = async () => {
          throw err;
        };
      } else if (target === "promotePr") {
        opsOverrides.promotePr = async () => {
          throw err;
        };
      } else if (target === "acceptanceGate") {
        acceptanceRun = () => {
          throw err;
        };
      } else if (target === "qualityGate") {
        qualityRun = () => {
          throw err;
        };
      }

      const { deps } = makeDeps({ auditDir: dir, ops: opsOverrides, acceptanceRun, qualityRun });
      const result = await runFinishMachine(baseState(), deps);
      expect(result.status).toBe("escalated");
      expect(result.escalationReason).toContain(`boom from ${target}`);
    });
  });
});

test("I8 — a spec fix re-runs the acceptance gate before the spec re-review", async () => {
  await withTempDir(async (dir) => {
    let specCalls = 0;
    const { deps, trail } = makeDeps({
      auditDir: dir,
      ops: {
        review: async (phase) => {
          trail.push(`review:${phase}`);
          if (phase !== "spec") return { findings: [], gaps: [] };
          specCalls += 1;
          return specCalls === 1 ? { findings: [FINDING], gaps: [] } : { findings: [], gaps: [] };
        },
      },
    });
    const result = await runFinishMachine(baseState(), deps);
    expect(result.status).not.toBe("escalated");

    const fixIdx = trail.indexOf("fix:spec");
    expect(fixIdx).toBeGreaterThanOrEqual(0);
    expect(trail[fixIdx + 1]).toBe("commit");

    const afterCommit = trail.slice(fixIdx + 2);
    expect(afterCommit[0]).toBe("acceptance-run");
    expect(afterCommit.indexOf("review:spec")).toBeGreaterThan(afterCommit.indexOf("acceptance-run"));
  });
});
