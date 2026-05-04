import os from "node:os";
import path from "node:path";
import { NaxError } from "../errors";

export interface ProjectIdentity {
  name: string;
  workdir: string;
  remoteUrl: string | null;
  createdAt: string;
  lastSeen: string;
}

export function projectInputDir(workdir: string): string {
  return path.join(workdir, ".nax");
}

export function projectOutputDir(projectKey: string, outputDirOverride: string | undefined): string {
  if (!outputDirOverride) {
    return path.join(os.homedir(), ".nax", projectKey);
  }
  if (outputDirOverride.startsWith("~/")) {
    return path.join(os.homedir(), outputDirOverride.slice(2));
  }
  if (path.isAbsolute(outputDirOverride)) {
    return outputDirOverride;
  }
  throw new NaxError("outputDir must be absolute or start with ~/", "CONFIG_INVALID", {
    stage: "runtime",
    field: "outputDir",
    value: outputDirOverride,
  });
}

export function globalOutputDir(): string {
  return path.join(os.homedir(), ".nax", "global");
}

export function identityPath(projectKey: string): string {
  return path.join(os.homedir(), ".nax", projectKey, ".identity");
}

export async function readProjectIdentity(projectKey: string): Promise<ProjectIdentity | null> {
  const p = identityPath(projectKey);
  const file = Bun.file(p);
  if (!(await file.exists())) return null;
  try {
    const data = (await file.json()) as Record<string, unknown>;
    if (
      typeof data.name !== "string" ||
      typeof data.workdir !== "string" ||
      typeof data.createdAt !== "string" ||
      typeof data.lastSeen !== "string"
    ) {
      return null;
    }
    return data as unknown as ProjectIdentity;
  } catch {
    return null;
  }
}

export async function writeProjectIdentity(projectKey: string, identity: ProjectIdentity): Promise<void> {
  const p = identityPath(projectKey);
  await Bun.write(p, JSON.stringify(identity, null, 2));
}

export function curatorRollupPath(globalDir: string, rollupPathOverride: string | undefined): string {
  if (!rollupPathOverride) {
    return path.join(globalDir, "curator", "rollup.jsonl");
  }
  if (rollupPathOverride.startsWith("~/")) {
    return path.join(os.homedir(), rollupPathOverride.slice(2));
  }
  if (path.isAbsolute(rollupPathOverride)) {
    return rollupPathOverride;
  }
  throw new NaxError("curator.rollupPath must be absolute or start with ~/", "CONFIG_INVALID", {
    stage: "runtime",
    field: "curator.rollupPath",
    value: rollupPathOverride,
  });
}
