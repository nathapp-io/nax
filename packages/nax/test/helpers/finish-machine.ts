import type { AcceptanceGroupResult } from "@/cli";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config";
import type {
  AuditTarget,
  FinishAdvisor,
  FinishContext,
  FinishMachineDeps,
  FinishOps,
  FinishReviewOutput,
  FinishState,
} from "@/finish";
import { _acceptanceGateDeps, _finishGitDeps, _qualityGateDeps, createFinishState } from "@/finish";
import type { QualityCommandOptions, QualityCommandResult } from "@/quality";

export function makeFinishContext(overrides: Partial<FinishContext> = {}): FinishContext {
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

export function makeFinishState(overrides: Partial<FinishState> = {}): FinishState {
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

export const CLEAN_REVIEW: FinishReviewOutput = { findings: [], covered: [] };

/** Scripted A4 ops: each review call shifts the next scripted output (default clean). Records a call trail. */
export function makeFinishOps(
  trail: string[],
  script: { spec?: FinishReviewOutput[]; quality?: FinishReviewOutput[] } = {},
  overrides: Partial<FinishOps> = {},
): FinishOps {
  const spec = [...(script.spec ?? [])];
  const quality = [...(script.quality ?? [])];
  return {
    reviewSpec: async () => {
      trail.push("review:spec");
      return spec.shift() ?? CLEAN_REVIEW;
    },
    reviewBranch: async () => {
      trail.push("review:quality");
      return quality.shift() ?? CLEAN_REVIEW;
    },
    fix: async (phase) => {
      trail.push(`fix:${phase}`);
      return {};
    },
    openDraftPr: async () => {
      trail.push("openDraftPr");
      return { url: "https://x/pr/1" };
    },
    promotePr: async () => {
      trail.push("promotePr");
      return { status: "promoted", url: "https://x/pr/1" };
    },
    finalizeDraftPr: async () => {
      trail.push("finalizeDraftPr");
      return { status: "draft", url: "https://x/pr/1" };
    },
    ...overrides,
  };
}

/** Mutable git model behind {@link installFinishGit}: HEAD advances on every commit; a fixer sets `dirty`. */
export interface FinishGitModel {
  dirty: boolean;
  head: number;
  /** What `git show --name-only` reports for a fix commit (newline-separated). Default: one production file. */
  files?: string;
}

/**
 * Stubs `_finishGitDeps.git` so `commitFixes` commits exactly when `model.dirty` is set.
 * Returns a restore function for `afterEach`. A `commit` is appended to `trail` when given.
 */
export function installFinishGit(model: FinishGitModel, trail?: string[]): () => void {
  const original = _finishGitDeps.git;
  _finishGitDeps.git = async (args) => {
    const [cmd] = args;
    if (cmd === "rev-parse") return { exitCode: 0, stdout: `sha${model.head}\n`, stderr: "" };
    if (cmd === "status") return { exitCode: 0, stdout: model.dirty ? " M a.ts\n" : "", stderr: "" };
    if (cmd === "diff" && args.includes("--cached")) return { exitCode: model.dirty ? 1 : 0, stdout: "", stderr: "" };
    if (cmd === "commit") {
      trail?.push("commit");
      model.head += 1;
      model.dirty = false;
    }
    if (cmd === "show") return { exitCode: 0, stdout: `${model.files ?? "src/prod.ts"}\n`, stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return () => {
    _finishGitDeps.git = original;
  };
}

export interface MachineHarnessOpts {
  auditDir: string;
  context?: Partial<FinishContext>;
  /** Scripted review outputs per lens, one per round (default clean). */
  script?: { spec?: FinishReviewOutput[]; quality?: FinishReviewOutput[] };
  ops?: Partial<FinishOps>;
  advise?: FinishAdvisor;
  signal?: AbortSignal;
  runSignal?: AbortSignal;
  /** Exit code of each acceptance run, by call number (1-based). Default 0. */
  acceptanceExit?: (call: number) => number;
  /** Exit code of each quality command run, by its call number across the finish (1-based). Default 0. */
  qualityExit?: (call: number) => number;
  /** Throws from the acceptance runner / quality runner instead of returning a result. */
  acceptanceThrows?: string;
  qualityThrows?: string;
  /** `quality.commands` the gate resolver sees. Default: one `test` command. */
  qualityCommands?: NaxConfig["quality"]["commands"];
  /** When true the fixer edits nothing, so `commitFixes` commits nothing. */
  fixIsNoop?: boolean;
  gitFiles?: string;
}

export interface MachineHarness {
  deps: FinishMachineDeps;
  trail: string[];
  git: FinishGitModel;
  state: FinishState;
}

const restorers: Array<() => void> = [];

/** Restores every seam a harness patched. Call from `afterEach`. */
export function restoreFinishMachineStubs(): void {
  for (const restore of restorers.splice(0).reverse()) restore();
}

function qualityConfig(commands: NaxConfig["quality"]["commands"] = { test: "true" }): NaxConfig {
  return { ...DEFAULT_CONFIG, quality: { ...DEFAULT_CONFIG.quality, commands } };
}

function installGateStubs(opts: MachineHarnessOpts, trail: string[]): void {
  const originalAcceptance = _acceptanceGateDeps.run;
  const originalQuality = { ..._qualityGateDeps };
  restorers.push(() => {
    _acceptanceGateDeps.run = originalAcceptance;
    Object.assign(_qualityGateDeps, originalQuality);
  });
  let acceptanceCalls = 0;
  _acceptanceGateDeps.run = async () => {
    trail.push("acceptance-run");
    acceptanceCalls += 1;
    if (opts.acceptanceThrows) throw new Error(opts.acceptanceThrows);
    const exitCode = opts.acceptanceExit?.(acceptanceCalls) ?? 0;
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
  let qualityCalls = 0;
  _qualityGateDeps.loadConfig = async () => qualityConfig(opts.qualityCommands);
  _qualityGateDeps.loadPackageOverride = async () => null;
  _qualityGateDeps.run = async (o: QualityCommandOptions): Promise<QualityCommandResult> => {
    trail.push(`quality-run:${o.commandName}`);
    qualityCalls += 1;
    if (opts.qualityThrows) throw new Error(opts.qualityThrows);
    const exitCode = opts.qualityExit?.(qualityCalls) ?? 0;
    return {
      commandName: o.commandName,
      command: String(o.command),
      success: exitCode === 0,
      exitCode,
      output: exitCode === 0 ? "ok" : "gate output",
      durationMs: 1,
      timedOut: false,
    };
  };
}

/**
 * Everything a `runFinishMachine` test needs: scripted ops with a call trail, a git model whose commits
 * follow the fixer's edits, stubbed acceptance and quality runners, and an audit dir. Call
 * {@link restoreFinishMachineStubs} from `afterEach`.
 */
export function makeMachineHarness(opts: MachineHarnessOpts): MachineHarness {
  const trail: string[] = [];
  const git: FinishGitModel = { dirty: false, head: 1, ...(opts.gitFiles ? { files: opts.gitFiles } : {}) };
  restorers.push(installFinishGit(git, trail));
  installGateStubs(opts, trail);
  const userFix = opts.ops?.fix;
  const ops = makeFinishOps(trail, opts.script, {
    ...opts.ops,
    fix: async (phase, req) => {
      git.dirty = opts.fixIsNoop !== true;
      if (userFix) return userFix(phase, req);
      trail.push(`fix:${phase}`);
      return {};
    },
  });
  const audit: AuditTarget = { auditDir: opts.auditDir, runId: "run-1" };
  let tick = 0;
  const deps: FinishMachineDeps = {
    context: makeFinishContext(opts.context),
    ops,
    audit,
    ...(opts.advise ? { advise: opts.advise } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.runSignal ? { runSignal: opts.runSignal } : {}),
    now: () => {
      tick += 1;
      return `2026-10-11T00:00:${String(tick).padStart(2, "0")}.000Z`;
    },
  };
  return { deps, trail, git, state: makeFinishState() };
}
