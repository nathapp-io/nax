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
  readonly options: PlanCommandOptions;
  readonly runtime: NaxRuntime;
  readonly interactionChain: InteractionChain | null;
  readonly interactionBridge: InteractionBridge;
  readonly deps: PlanDeps;
}

export interface IPlanStrategy {
  readonly mode: "single" | "pipeline" | "debate" | "refine";
  execute(ctx: PlanModeContext): Promise<string>;
}
