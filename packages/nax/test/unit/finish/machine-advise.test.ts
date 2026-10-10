/** A1 — finish machine with the advisor wired (callers 1 + 4). Scaffolding copied from machine-loops.test.ts. */
import { afterEach, describe, expect, test } from "bun:test";
import { withTempDir } from "@test/helpers";
import type { AdviceDecision, AdviceResult } from "@/advisor";
import type { AcceptanceGroupResult } from "@/cli";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config";
import type {
  AuditTarget,
  Finding,
  FinishAdvisor,
  FinishContext,
  FinishMachineDeps,
  FinishOps,
  FinishState,
} from "@/finish";
import { _acceptanceGateDeps, _finishGitDeps, _qualityGateDeps, createFinishState, runFinishMachine } from "@/finish";
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

const _FINDING: Finding = { severity: "HIGH", title: "fix me", problem: "p", fix: "f" };

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
      command: o.command as string,
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

const judged: Finding = {
  severity: "HIGH",
  title: "judged",
  problem: "p",
  fix: "f",
  judgment: true,
  judgmentReason: "design call",
};
const plain: Finding = { severity: "LOW", title: "plain", problem: "p2", fix: "f2" };

function dec(action: AdviceDecision["action"], id = "D-1"): AdviceResult {
  return {
    decision: {
      id,
      questionId: "Q",
      kind: "finish-judgment",
      chosenOptionId: "A",
      action,
      rationale: "advisor says so",
      confidence: "high",
      reversible: true,
      needsHumanConfirm: false,
      decidedAt: "t",
      model: "m",
      memoryMode: "stateless",
      auditRef: "a",
    },
  };
}

/** A scripted FinishAdvisor: judged findings get `judgedAction`, approvals pop from `approvals`. */
function fakeFinishAdvisor(
  trail: string[],
  o: { judged?: (f: Finding) => "fix" | "waive" | "hold" | "none"; approvals?: AdviceResult[] },
): FinishAdvisor {
  const approvals = [...(o.approvals ?? [])];
  return {
    judgedEnabled: o.judged !== undefined,
    approvalEnabled: o.approvals !== undefined,
    async judged(_phase, judgedFindings) {
      trail.push("advise:judged");
      const toFix: Finding[] = [];
      const out = { toFix, advice: [{ decisionId: "D-1", optionId: "A", reused: false }] };
      for (const f of judgedFindings) {
        const kind = o.judged?.(f) ?? "none";
        if (kind === "hold") return { ...out, hold: "needs a human" };
        if (kind === "none") return { ...out, fallback: "no-json" };
        if (kind === "fix") out.toFix.push({ ...f, fix: `${f.fix} + ruling` });
      }
      return out;
    },
    async approval() {
      trail.push("advise:approval");
      return approvals.shift() ?? { decision: null, fallbackReason: "script exhausted" };
    },
    async commitLedger() {
      trail.push("commitLedger");
    },
  };
}

/** A review op that reports `first` once, then clean. */
function reviewOnce(trail: string[], phase: "spec" | "quality", first: Finding[]): Partial<FinishOps> {
  let n = 0;
  return {
    review: async (p) => {
      trail.push(`review:${p}`);
      if (p === phase && n++ === 0) return { findings: first, gaps: [] };
      return { findings: [], gaps: [] };
    },
  };
}

describe("finish machine — advisor (A1 callers 1 + 4)", () => {
  test("plain + judged: the advisor rules fix → one fix round carrying both", async () => {
    await withTempDir(async (dir) => {
      const t: string[] = [];
      const fixed: Finding[][] = [];
      const { deps, trail } = makeDeps({
        auditDir: dir,
        ops: {
          ...reviewOnce(t, "quality", [plain, judged]),
          fix: async (_p, req) => {
            fixed.push(req.findings ?? []);
            return {};
          },
        },
      });
      deps.advise = fakeFinishAdvisor(trail, { judged: () => "fix" });
      const result = await runFinishMachine(baseState(), deps);
      expect(result.status).toBe("opened");
      expect(fixed[0]?.map((f) => f.title)).toEqual(["plain", "judged"]);
      expect(fixed[0]?.[1]?.fix).toContain("+ ruling");
    });
  });

  test("judged-only + waive: round advised, re-review clean, PR promoted", async () => {
    await withTempDir(async (dir) => {
      const t: string[] = [];
      const { deps, trail } = makeDeps({ auditDir: dir, ops: reviewOnce(t, "quality", [judged]) });
      deps.advise = fakeFinishAdvisor(trail, { judged: () => "waive" });
      const state = baseState();
      const result = await runFinishMachine(state, deps);
      expect(result.status).toBe("opened");
      expect(t.filter((e) => e === "review:quality")).toHaveLength(2);
      expect(state.phases.quality.adviseRounds).toBe(1);
    });
  });

  test("hold escalates with the advisor's rationale", async () => {
    await withTempDir(async (dir) => {
      const t: string[] = [];
      const { deps, trail } = makeDeps({ auditDir: dir, ops: reviewOnce(t, "spec", [judged]) });
      deps.advise = fakeFinishAdvisor(trail, { judged: () => "hold" });
      const result = await runFinishMachine(baseState(), deps);
      expect(result.status).toBe("escalated");
      expect(result.escalationReason).toBe("advisor hold: needs a human");
    });
  });

  test("advisor unavailable escalates with today's judgment reason", async () => {
    await withTempDir(async (dir) => {
      const t: string[] = [];
      const { deps, trail } = makeDeps({ auditDir: dir, ops: reviewOnce(t, "spec", [judged]) });
      deps.advise = fakeFinishAdvisor(trail, { judged: () => "none" });
      const result = await runFinishMachine(baseState(), deps);
      expect(result.status).toBe("escalated");
      expect(result.escalationReason).toBe("design call (advisor unavailable: no-json)");
    });
  });

  test("approval approve → ledger committed, PR promoted", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail } = makeDeps({ auditDir: dir });
      deps.advise = fakeFinishAdvisor(trail, { approvals: [dec({ type: "approve" })] });
      const result = await runFinishMachine(baseState(), deps);
      expect(result.status).toBe("opened");
      expect(trail).toContain("advise:approval");
      expect(trail).toContain("commitLedger");
      expect(trail.indexOf("commitLedger")).toBeLessThan(trail.indexOf("promotePr"));
    });
  });

  test("approval re-review with a fix commit re-runs the gates before asking again", async () => {
    await withTempDir(async (dir) => {
      const t: string[] = [];
      let reviews = 0;
      const { deps, trail } = makeDeps({
        auditDir: dir,
        ops: {
          review: async (p) => {
            t.push(`review:${p}`);
            reviews += 1;
            // spec, quality pass; the approval's re-review of quality finds one plain finding once.
            return p === "quality" && reviews === 3 ? { findings: [plain], gaps: [] } : { findings: [], gaps: [] };
          },
        },
      });
      deps.advise = fakeFinishAdvisor(trail, {
        approvals: [dec({ type: "re-review", phase: "quality" }), dec({ type: "approve" }, "D-2")],
      });
      const result = await runFinishMachine(baseState(), deps);
      expect(result.status).toBe("opened");
      expect(trail.filter((e) => e === "advise:approval")).toHaveLength(2);
      const approvals = trail
        .map((e, i) => [e, i] as const)
        .filter(([e]) => e === "advise:approval")
        .map(([, i]) => i);
      const gateRunsBetween = trail.slice(approvals[0], approvals[1]).filter((e) => e.startsWith("quality-run:"));
      expect(gateRunsBetween.length).toBeGreaterThan(0);
    });
  });

  test("approval unavailable escalates and NEVER promotes (fails closed)", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail } = makeDeps({ auditDir: dir });
      deps.advise = fakeFinishAdvisor(trail, { approvals: [] });
      const result = await runFinishMachine(baseState(), deps);
      expect(result.status).toBe("escalated");
      expect(result.escalationReason).toContain("advisor approval unavailable");
      expect(trail).not.toContain("promotePr");
    });
  });

  test("no advisor: the trail is unchanged from today", async () => {
    await withTempDir(async (dir) => {
      const a = makeDeps({ auditDir: dir });
      await runFinishMachine(baseState(), a.deps);
      expect(a.trail).not.toContain("advise:judged");
      expect(a.trail).not.toContain("advise:approval");
      expect(a.trail.filter((e) => e === "promotePr")).toHaveLength(1);
    });
  });
});
