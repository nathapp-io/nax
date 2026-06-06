import { join } from "node:path";
import { NaxError } from "../errors";
import { analyzeRepo } from "./setup-analyze";
import type { RepoAnalysis } from "./setup-types";
import type { SetupPlan } from "../operations/setup-generate";

export interface SetupOptions {
  dir?: string;
  agent?: string;
  dryRun?: boolean;
  force?: boolean;
}

export const _setupDeps = {
  analyzeRepo: analyzeRepo as (workdir: string) => Promise<RepoAnalysis>,
  generateSetupPlan: (_analysis: RepoAnalysis): Promise<SetupPlan> => {
    throw new NaxError("generateSetupPlan: wire to callOp before production use", "SETUP_PLAN_INVALID");
  },
  runGate: (): Promise<number> => Promise.resolve(0),
  fileExists: (path: string): Promise<boolean> => Bun.file(path).exists(),
  writeFile: (path: string, content: string): Promise<void> => Bun.write(path, content).then(() => {}),
  mkdir: (path: string): Promise<void> =>
    import("node:fs/promises").then((m) => m.mkdir(path, { recursive: true }).then(() => {})),
  stdout: console.log.bind(console) as (msg: string) => void,
  stderr: console.error.bind(console) as (msg: string) => void,
};

export async function setupCommand(options: SetupOptions = {}): Promise<number> {
  const workdir = options.dir ?? process.cwd();
  const naxDir = join(workdir, ".nax");
  const naxConfigPath = join(naxDir, "config.json");

  // AC6: collision check — refuse if config exists and --force not set
  const exists = await _setupDeps.fileExists(naxConfigPath);
  if (exists && !options.force) {
    _setupDeps.stderr(`[setup] .nax/config.json already exists. Use --force to overwrite.`);
    return 1;
  }

  // AC11: analyzeRepo called once with resolved workdir
  const analysis = await _setupDeps.analyzeRepo(workdir);

  // AC5, AC11: generateSetupPlan called with analysis; SETUP_PLAN_INVALID → exit 1
  let plan: SetupPlan;
  try {
    plan = await _setupDeps.generateSetupPlan(analysis);
  } catch (err) {
    if (err instanceof NaxError && err.code === "SETUP_PLAN_INVALID") {
      _setupDeps.stderr(`[setup] ${err.message}`);
      return 1;
    }
    throw err;
  }

  // AC4: dry-run exits 0 with no writes
  if (options.dryRun) {
    _setupDeps.stdout(`[setup] Dry run — planned root config:\n${JSON.stringify(plan.config, null, 2)}`);
    return 0;
  }

  // AC8: emit each gap as a stderr warning
  for (const gap of plan.gaps) {
    _setupDeps.stderr(`[setup] gap: ${gap}`);
  }

  // AC1: write root .nax/config.json
  await _setupDeps.mkdir(naxDir);
  await _setupDeps.writeFile(naxConfigPath, JSON.stringify(plan.config, null, 2));

  // AC2: write .nax/mono/<relativeDir>/config.json per member package
  for (const mc of plan.monoConfigs) {
    const monoDir = join(naxDir, "mono", mc.relativeDir);
    await _setupDeps.mkdir(monoDir);
    await _setupDeps.writeFile(join(monoDir, "config.json"), JSON.stringify(mc.config, null, 2));
  }

  // AC9: invoke verification gate exactly once
  const gateResult = await _setupDeps.runGate();

  // AC10: gate non-zero → propagate failure
  if (gateResult !== 0) {
    return gateResult;
  }

  return 0;
}
