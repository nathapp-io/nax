import type { IAgentManager } from "@/agents";
import { AgentManager } from "@/agents/manager";
import type { AgentRegistry } from "@/agents/registry";

/**
 * Private surface of `AgentManager` that the call-op retry tests drive
 * directly: `_resolveRegistry` is swapped for a stub registry returning a
 * canned adapter. The cast is contained here once instead of at every site —
 * see #1514 §11 Group A. *
 * `biome.json` turns off `complexity/useLiteralKeys` for `test/helpers/*-internals.ts`:
 * the rule wants `p.field`, but element access is precisely what makes a
 * `private` member reachable, so its "fix" would not compile. Biome marks that
 * fix unsafe for the same reason.
 */
export type AgentManagerInternals = {
  _resolveRegistry: () => { getAgent: (name: string) => unknown };
  /** Lazily created on first getAgent() call — undefined until then. */
  _registry: AgentRegistry | undefined;
};

/**
 * TypeScript's `private` is compile-time only, and element access (`m["_x"]`)
 * is its sanctioned way through it — so once `instanceof` has narrowed the
 * interface to the real class, this live view needs no assertion. The guard
 * also makes a wrong argument fail loudly instead of silently reading
 * `undefined` off a stub, which the old cast could not do.
 */
export function agentManagerInternals(m: IAgentManager): AgentManagerInternals {
  if (!(m instanceof AgentManager)) {
    throw new Error("[test] agentManagerInternals requires a real AgentManager instance");
  }
  return {
    get _registry() {
      return m["_registry"];
    },
    set _registry(registry) {
      m["_registry"] = registry;
    },
    get _resolveRegistry() {
      return m["_resolveRegistry"];
    },
    set _resolveRegistry(resolve) {
      m["_resolveRegistry"] = resolve;
    },
  };
}
