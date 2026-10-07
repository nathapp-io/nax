/**
 * Whether a registered agent can be launched on this machine (S4b spec §6.8):
 * the same candidate resolution the backend uses at spawn (§6.10), exposed so an
 * embedder's "is installed" check never duplicates the candidate list. "npx"
 * means only the npx fallback resolves: the first open downloads the launcher.
 */
import { pickCandidate } from "#src/client/launch";
import { type AcpAgentName, registryEntry } from "#src/client/registry";

export type LaunchCandidateKind = "local" | "npx";

export function launchCandidateKind(
  agent: AcpAgentName,
  env: Readonly<Record<string, string | undefined>> = process.env,
): LaunchCandidateKind | undefined {
  const found = pickCandidate(registryEntry(agent)?.launch ?? [], env.PATH);
  if (found === undefined) return undefined;
  return found.command === "npx" ? "npx" : "local";
}

export function isAgentLaunchable(
  agent: AcpAgentName,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return launchCandidateKind(agent, env) !== undefined;
}
