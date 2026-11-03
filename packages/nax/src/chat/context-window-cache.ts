/**
 * The chat host's per-model catalog context-window cache (US-013).
 *
 * Remember the session model's catalog context window, read once per model
 * string: a mode switch reopens on the same model, whose window cannot have
 * changed, and re-reading it per switch would cost a catalog load per toggle.
 *
 * A model string with no non-empty `<provider>/` prefix names no catalog entry,
 * so it is not looked up at all, and an ACP model names no nax-ai entry either:
 * the agent owns its context window. `undefined` in the map is therefore a
 * remembered answer ("the catalog cannot state this window"), never a miss.
 *
 * The lookup arrives as a getter so the host's `_chatHostDeps` seam keeps
 * working: a stub installed after the cache was built is still the one called.
 */
import type { lookupContextWindow } from "@/agents/catalog";
import { isChatAcpModel } from "./acp";

/** Whether a model string names a nax-ai catalog entry at all, and if so, its two halves. */
function catalogModel(model: string): { readonly provider: string; readonly name: string } | undefined {
  const split = model.indexOf("/");
  if (split <= 0 || isChatAcpModel(model)) return undefined;
  return { provider: model.slice(0, split), name: model.slice(split + 1) };
}

/** One host's windows, keyed by the model string a session reports. */
export interface ContextWindowCache {
  /** The window last primed for this model; a miss and an unknown window both read `undefined`. */
  get(model: string): number | undefined;
  /** Resolve and remember this model's window; a model already primed costs nothing. */
  prime(model: string): Promise<void>;
}

/** Build a cache over `lookup`, read through the getter on every prime. */
export function createContextWindowCache(lookup: () => typeof lookupContextWindow): ContextWindowCache {
  const windows = new Map<string, number | undefined>();
  return {
    get: (model) => windows.get(model),
    async prime(model) {
      if (windows.has(model)) return;
      const entry = catalogModel(model);
      if (entry === undefined) {
        windows.set(model, undefined);
        return;
      }
      let contextWindow: number | undefined;
      try {
        contextWindow = await lookup()(entry.provider, entry.name);
      } catch {
        // Fail-open (US-003 AC-8): an unavailable catalog leaves the window
        // unknown rather than failing the session operation that read it.
      }
      windows.set(model, contextWindow);
    },
  };
}
