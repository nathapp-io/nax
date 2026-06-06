import { join } from "node:path";
import { NaxError } from "../errors";
import type { NaxConfig } from "../config";
import type { CallContext } from "../operations/types";
import type { SetupPlan } from "../operations/setup-generate";
import { analyzeRepo } from "./setup-analyze";
import { fillScripts } from "./setup-fill";
import { generateSetupPlan as _generateSetupPlan } from "./setup-llm";
import { runSetupGate } from "./setup-verify";
import type { RepoAnalysis } from "./setup-types";

export interface SetupOptions {
  dir?: string;
  agent?: string;
  dryRun?: boolean;
  force?: boolean;
  fillScripts?: boolean;
}

export const _setupDeps = {
  analyzeRepo: analyzeRepo as (workdir: string) => Promise<RepoAnalysis>,
  fillScripts: fillScripts as (workdir: string, analysis: RepoAnalysis) => Promise<void>,
  buildCallContext: async (
    workdir: string,
    agentName?: string,
  ): Promise<{ ctx: CallContext; close: () => Promise<void> }> => {
    const { loadConfig } = await import("../config");
    const { createRuntime } = await import("../runtime");
    const config = await loadConfig(workdir);
    const rt = createRuntime(config, workdir);
    return {
      ctx: {
        runtime: rt,
        packageView: rt.packages.resolve(),
        packageDir: workdir,
        agentName: agentName ?? rt.agentManager.getDefault(),
      },
      close: () => rt.close(),
    };
  },
  generateSetupPlan: (ctx: CallContext, analysis: RepoAnalysis): Promise<SetupPlan> =>
    _generateSetupPlan(ctx, analysis),
  runGate: (workdir: string, config: NaxConfig): Promise<number> =>
    runSetupGate(workdir, config),
  fileExists: (path: string): Promise<boolean> => Bun.file(path).exists(),
  writeFile: (path: string, content: string): Promise<void> => Bun.write(path, content).then(() => {}),
  mkdir: async (path: string): Promise<void> => {
    const proc = Bun.spawn(["mkdir", "-p", path]);
    await proc.exited;
  },
  stdout: (msg: string): void => { process.stdout.write(`${msg}\n`); },
  stderr: (msg: string): void => { process.stderr.write(`${msg}\n`); },
};

export async function setupCommand(options: SetupOptions = {}): Promise<number> {
  const workdir = options.dir ?? process.cwd();
  const naxDir = join(workdir, ".nax");
  const naxConfigPath = join(naxDir, "config.json");

  // Collision check — refuse if config exists and --force not set
  const exists = await _setupDeps.fileExists(naxConfigPath);
  if (exists && !options.force) {
    _setupDeps.stderr("[setup] .nax/config.json already exists. Use --force to overwrite.");
    return 1;
  }

  const analysis = await _setupDeps.analyzeRepo(workdir);

  const { ctx, close } = await _setupDeps.buildCallContext(workdir, options.agent);
  let plan: SetupPlan;
  try {
    try {
      plan = await _setupDeps.generateSetupPlan(ctx, analysis);
    } catch (err) {
      if (err instanceof NaxError && err.code === "SETUP_PLAN_INVALID") {
        _setupDeps.stderr(`[setup] ${err.message}`);
        return 1;
      }
      throw err;
    }

    if (options.dryRun) {
      _setupDeps.stdout(`[setup] Dry run — planned root config:\n${JSON.stringify(plan.config, null, 2)}`);
      return 0;
    }

    for (const gap of plan.gaps) {
      _setupDeps.stderr(`[setup] gap: ${gap}`);
    }

    if (options.fillScripts) {
      await _setupDeps.fillScripts(workdir, analysis);
    }

    await _setupDeps.mkdir(naxDir);
    await _setupDeps.writeFile(naxConfigPath, JSON.stringify(plan.config, null, 2));

    for (const mc of plan.monoConfigs) {
      const monoDir = join(naxDir, "mono", mc.relativeDir);
      await _setupDeps.mkdir(monoDir);
      await _setupDeps.writeFile(join(monoDir, "config.json"), JSON.stringify(mc.config, null, 2));
    }

    const gateResult = await _setupDeps.runGate(workdir, plan.config);
    if (gateResult !== 0) {
      return gateResult;
    }

    return 0;
  } finally {
    await close();   // called exactly once, always
  }
}
