import type { OwnedBashCandidate, OwnedPathsPolicy } from "@nathapp/nax-agent";
import { realOrRaw } from "@nathapp/nax-agent/internal";
import { isNaxConfigFile, isNaxConfigSegments, naxOwnedKind } from "./nax-owned-writes";

export const NAX_CONFIG_READ_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Grep",
  "Glob",
  "ScratchpadRead",
  "ScratchpadList",
]);

export const NAX_CONFIG_WRITE_REFUSAL =
  "is nax configuration; only Read, Grep and Glob may open it, and no tool may modify it. " +
  "`quality.commands` and `acceptance.command` run through a shell without passing the permission gate, " +
  "so editing this file could run an ungated command on the next run.";

export const NAX_CONFIG_READ_DISABLED_SUFFIX = " -- reads are disabled for this dispatch; run `nax doctor` for details.";

function configCandidatesOnly(root: string, candidates: readonly OwnedBashCandidate[]): boolean {
  let foundConfig = false;
  for (const candidate of candidates) {
    if (isNaxConfigFile(root, realOrRaw(candidate.lexical))) {
      foundConfig = true;
      continue;
    }
    const kind = candidate.rel === null ? undefined : naxOwnedKind(candidate.rel);
    if (kind !== undefined) return false;
  }
  return foundConfig;
}

/** Wrap the base owned-path policy with dispatch-specific config read access. */
export function createConfigReadGatePolicy(
  base: OwnedPathsPolicy,
  configReadable: boolean,
): OwnedPathsPolicy {
  return {
    ...base,
    configRefusal: (root, resolved) => {
      const canonical = realOrRaw(resolved);
      if (!isNaxConfigFile(root, canonical)) return base.configRefusal(root, resolved);
      if (configReadable) return undefined;
      const refusal = base.configRefusal(root, canonical);
      return refusal === undefined ? undefined : `${refusal}${NAX_CONFIG_READ_DISABLED_SUFFIX}`;
    },
    writeRefusal: (tool, rel, ctx) => {
      if (!isNaxConfigSegments(rel.split("/"))) return base.writeRefusal(tool, rel, ctx);
      if (!configReadable) return base.writeRefusal(tool, rel, ctx);
      if (NAX_CONFIG_READ_TOOLS.has(tool)) return undefined;
      return `"${rel}" ${NAX_CONFIG_WRITE_REFUSAL}`;
    },
    bashRefusal: (tool, token, candidates, ctx) => {
      if (configReadable && ctx.verb === "names" && ctx.sandboxWrapped && configCandidatesOnly(ctx.root, candidates)) {
        return undefined;
      }
      return base.bashRefusal(tool, token, candidates, ctx);
    },
  };
}
