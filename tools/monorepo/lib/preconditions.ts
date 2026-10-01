// tools/monorepo/lib/preconditions.ts
export interface RepoState { branch: string; dirty: boolean; hasPackagesDir: boolean; hasPrepareScript: boolean }

export function assertPreconditions(s: RepoState, expectedBranch: string): void {
  if (s.branch !== expectedBranch) throw new Error(`convert-s0a: on branch ${s.branch}, expected ${expectedBranch}`);
  if (s.dirty) throw new Error("convert-s0a: working tree is dirty; commit or stash first");
  if (s.hasPackagesDir) throw new Error("convert-s0a: packages/ exists — repo already converted");
  if (s.hasPrepareScript) throw new Error("convert-s0a: prepare script still present — merge PR 1 (hook removal) first");
}
