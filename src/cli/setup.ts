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
    throw new Error("stub: generateSetupPlan not implemented");
  },
  runGate: (_workdir: string, _cmd: string): Promise<number> => Promise.resolve(0),
  fileExists: (path: string): Promise<boolean> => Bun.file(path).exists(),
  writeFile: (path: string, content: string): Promise<void> => Bun.write(path, content).then(() => {}),
  mkdir: (_path: string): Promise<void> => Promise.resolve(),
  stdout: console.log.bind(console) as (msg: string) => void,
  stderr: console.error.bind(console) as (msg: string) => void,
};

export async function setupCommand(_options: SetupOptions = {}): Promise<number> {
  throw new Error("not implemented");
}
