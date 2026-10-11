import type { OwnedBashCandidate, OwnedPathsPolicy } from "@nathapp/nax-agent";
import { realOrRaw } from "@nathapp/nax-agent/internal";
import { isNaxConfigFile, naxOwnedKind } from "./nax-owned-writes";

export const NAX_CONFIG_READ_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Grep",
  "Glob",
  "ScratchpadRead",
  "ScratchpadList",
]);

export const NAX_CONFIG_WRITE_REFUSAL =
  "is nax configuration; access is refused read-only for non-mutating tools. " +
  "`quality.commands` and `acceptance.command` run through a shell without passing the permission gate, " +
  "so editing this file could run an ungated command on the next run.";

export const NAX_CONFIG_READ_DISABLED_SUFFIX = " -- reads are disabled for this dispatch.";
export const NAX_CONFIG_SECRET_READ_DISABLED_REASON =
  "reads are disabled because config contains a secret; run `nax doctor` for details";

function isConfigRel(rel: string): boolean {
  const segments = rel.split("/");
  return (
    segments[0] === ".nax" &&
    segments[segments.length - 1] === "config.json" &&
    (segments.length === 2 || (segments.length >= 4 && segments[1] === "mono"))
  );
}

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
  disabledReason?: string,
): OwnedPathsPolicy {
  return {
    ...base,
    configRefusal: (root, resolved) => {
      const canonical = realOrRaw(resolved);
      if (!isNaxConfigFile(root, canonical)) return base.configRefusal(root, resolved);
      if (configReadable) return undefined;
      const refusal = base.configRefusal(root, canonical);
      const detail = disabledReason === undefined ? NAX_CONFIG_READ_DISABLED_SUFFIX : ` -- ${disabledReason}.`;
      return refusal === undefined ? undefined : `${refusal}${detail}`;
    },
    writeRefusal: (tool, rel, ctx) => {
      if (!isConfigRel(rel)) return base.writeRefusal(tool, rel, ctx);
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
