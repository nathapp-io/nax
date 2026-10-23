import type { SandboxConfig } from "../config/schemas-sandbox.ts";

/** Explicit loopback settings win; an allow-list (including []) defaults on. */
export function effectiveAllowLocalBinding(network: SandboxConfig["network"]): boolean {
  return typeof network.allowLocalBinding === "boolean"
    ? network.allowLocalBinding
    : network.allowedDomains !== undefined;
}
