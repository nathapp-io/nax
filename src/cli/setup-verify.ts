import type { NaxConfig } from "../config";

export const _setupVerifyDeps = {
  spawn: Bun.spawn.bind(Bun) as typeof Bun.spawn,
};

export async function runSetupGate(_workdir: string, _config: NaxConfig): Promise<number> {
  throw new Error("not implemented");
}
