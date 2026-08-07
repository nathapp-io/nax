import type { SourceRoot } from "@/analyze";
import type { NaxConfig } from "@/config";
import type { PlanConfig } from "@/config/selectors";
import type { DebateRunner, DebateRunnerOptions } from "@/debate";
import type { InteractionBridge } from "@/interaction/bridge-builder";
import type { InteractionChain } from "@/interaction/chain";
import type { PackageSummary } from "@/prompts";
import type { NaxRuntime } from "@/runtime";

export interface PlanCommandOptions {
  readonly from: string;
  readonly feature: string;
  readonly auto?: boolean;
  readonly branch?: string;
}

export interface PlanDeps {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  mkdirp: (path: string) => Promise<void>;
  existsSync: (path: string) => boolean;
  readPackageJson: (workdir: string) => Promise<Record<string, unknown> | null>;
  readPackageJsonAt: (path: string) => Promise<Record<string, unknown> | null>;
  scanSourceRoots: (workdir: string) => Promise<SourceRoot[]>;
  spawnSync: (cmd: string[], opts?: { cwd?: string }) => { stdout: Buffer; exitCode: number | null };
  initInteractionChain: (cfg: NaxConfig, headless: boolean) => Promise<InteractionChain | null>;
  createInteractionBridge: () => InteractionBridge;
  createDebateRunner: (opts: DebateRunnerOptions) => DebateRunner;
  getLogger: () => ReturnType<typeof import("@/logger").getLogger>;
}

export interface PlanModeContext {
  readonly workdir: string;
  readonly naxDir: string;
  readonly outputDir: string;
  readonly outputPath: string;
  readonly specContent: string;
  readonly codebaseContext: string;
  readonly normalizedRoots: SourceRoot[];
  readonly relativePackages: string[];
  readonly packageDetails: PackageSummary[];
  readonly projectName: string;
  readonly branchName: string;
  readonly timeoutSeconds: number;
  readonly config: PlanConfig;
  /** Config-profile name recorded on the PRD root for run-side drift detection. */
  readonly profileName: string | undefined;
  readonly options: PlanCommandOptions;
  readonly runtime: NaxRuntime;
  readonly interactionChain: InteractionChain | null;
  readonly interactionBridge: InteractionBridge;
  readonly deps: PlanDeps;
}

/**
 * Why a PRD is a degraded result — the plan threw and was recovered from the
 * agent-written file on disk rather than produced by the strategy's own path.
 */
export interface PlanDegradation {
  /** The original error that diverted the strategy onto its recovery branch. */
  readonly reason: string;
}

/**
 * A strategy's outcome. Carries `degraded` so the CLI can say so — a recovered
 * PRD used to be indistinguishable from a clean one at every layer above the
 * strategy, which is half of why #1494 went unnoticed.
 */
export interface PlanResult {
  readonly outputPath: string;
  readonly degraded?: PlanDegradation;
}

export interface IPlanStrategy {
  readonly mode: "single" | "pipeline" | "debate" | "refine";
  execute(ctx: PlanModeContext): Promise<PlanResult>;
}
