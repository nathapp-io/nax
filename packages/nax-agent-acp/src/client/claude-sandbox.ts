/**
 * nax#2500: nax's sandbox policy as the Claude Agent SDK `sandbox` session option
 * (SDK 0.3.286 SandboxSettings; claude-agent-acp 0.85.1 passes it through and
 * rebuilds the session when it changes). Same srt engine as nax's own launcher.
 * Network: nax's absent allow-list means open, so no `network` key is sent and the
 * permission layer answers Claude's network requests (permissions.ts) — unless
 * the policy carries the loopback grant alone (#2538), which still needs sending.
 */
import type { SandboxNetworkPolicy, SandboxPolicy } from "@nathapp/nax-agent";

/**
 * nax#2538: the SDK's `network` option, sent when the policy says anything about
 * the network. An all-empty policy keeps today's behaviour: no key at all, which
 * is what "open, decided by the permission layer" means to this SDK.
 */
function networkOption(network: SandboxNetworkPolicy): Record<string, unknown> {
  if (network.allowedDomains === undefined && network.allowLocalBinding === undefined) return {};
  return {
    network: {
      ...(network.allowedDomains === undefined ? {} : { allowedDomains: [...network.allowedDomains] }),
      ...(network.allowLocalBinding === undefined ? {} : { allowLocalBinding: network.allowLocalBinding }),
    },
  };
}

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
    ...networkOption(policy.network),
  };
}
