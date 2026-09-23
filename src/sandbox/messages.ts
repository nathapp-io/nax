/**
 * Every sentence the agent reads about the sandbox (spec 5.5), in one place so
 * descriptions, refusals and result notes cannot drift apart. The agent must
 * always know whether it is sandboxed and what it may write (spec S5).
 */

export const LIKELY_SANDBOX_DENIAL = /Operation not permitted|Read-only file system/;

function describeNetwork(network: "open" | readonly string[]): string {
  if (network === "open") return "network access is unrestricted";
  if (network.length === 0) return "network access is disabled";
  return `network access is limited to ${network.join(", ")}`;
}

export function sandboxSentence(network: "open" | readonly string[]): string {
  return (
    "inside an OS sandbox: writes are allowed only under the repository root, the system temp directories and " +
    "package-manager caches; credential files (~/.ssh, ~/.aws, ~/.npmrc, nax credentials and similar) are unreadable; " +
    `${describeNetwork(network)}. A write anywhere else fails with "Operation not permitted" or "Read-only file system" ` +
    "-- that is the sandbox, not a bug in your command."
  );
}

export function unsandboxedSentence(reason: string): string {
  return `Commands are NOT sandboxed on this machine (${reason}).`;
}

export function rawBashRefusalReason(reason: string): string {
  return (
    `sandbox unavailable (${reason}): raw bash requires the sandbox when execution.sandbox.enabled is true -- ` +
    "set this stage's bashApproval to gated or escalate, or disable the sandbox."
  );
}

export function denialHintLine(writeRoots: readonly string[]): string {
  return `note: this command ran in the nax sandbox; that failure may be a sandbox denial -- writable roots: ${writeRoots.join(", ")}.`;
}
