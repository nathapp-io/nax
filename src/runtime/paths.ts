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

/**
 * Claim the project identity for the given projectKey and workdir.
 *
 * - First call: writes the identity file under ~/.nax/<projectKey>/.identity
 * - Same workdir on subsequent calls: updates lastSeen only (idempotent)
 * - Different workdir: no-op (collision detection is the responsibility of nax init)
 */
export async function claimProjectIdentity(
  projectKey: string,
  workdir: string,
  remoteUrl: string | null,
): Promise<void> {
  const existing = await readProjectIdentity(projectKey);
  const now = new Date().toISOString();

  if (existing) {
    if (existing.workdir === workdir) {
      await writeProjectIdentity(projectKey, { ...existing, lastSeen: now });
      return;
    }
    throw new NaxError(
      [
        `Project name collision: "${projectKey}" is already claimed by a different project.`,
        `  This project:    ${workdir}`,
        `  Registered to:  ${existing.workdir}  (last seen: ${existing.lastSeen})`,
        "  Resolve:",
        "    1. Rename: set a different name in .nax/config.json",
        `    2. Reclaim: nax migrate --reclaim ${projectKey}`,
        `    3. Merge:   nax migrate --merge ${projectKey}`,
      ].join("\n"),
      "RUN_NAME_COLLISION",
      { stage: "setup", projectKey, existingWorkdir: existing.workdir },
    );
  }

  // First claim — Bun.write() creates parent dirs automatically
  await writeProjectIdentity(projectKey, {
    name: projectKey,
    workdir,
    remoteUrl,
    createdAt: now,
    lastSeen: now,
  });
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
