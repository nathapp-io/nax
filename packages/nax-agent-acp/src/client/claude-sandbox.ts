/**
 * nax#2500: nax's sandbox policy as the Claude Agent SDK `sandbox` session option
 * (SDK 0.3.286 SandboxSettings; claude-agent-acp 0.85.1 passes it through and
 * rebuilds the session when it changes). Same srt engine as nax's own launcher.
 * Network: nax's absent allow-list means open, so no `network` key is sent and the
 * permission layer answers Claude's network requests (permissions.ts).
 */
import type { SandboxPolicy } from "@nathapp/nax-agent";

export function claudeSandboxOptions(policy: SandboxPolicy): Readonly<Record<string, unknown>> {
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    filesystem: {
      allowWrite: [...policy.writeRoots],
      denyWrite: [...policy.denyWrite],
      denyRead: [...policy.denyRead],
    },
    ...(policy.network.allowedDomains === undefined
      ? {}
      : { network: { allowedDomains: [...policy.network.allowedDomains] } }),
  };
}
