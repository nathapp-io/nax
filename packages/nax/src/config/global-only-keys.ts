import { NaxError } from "../errors";

export { readGlobalAuthConfig } from "./auth";

/**
 * koda settings a non-global layer may not choose: the API root and the headers
 * that carry the agent key. `memory.koda.project` is deliberately absent — that
 * is what `nax memory link` writes into the project config.
 */
const KODA_GLOBAL_ONLY_KEYS = ["url", "headers"] as const;

/** A nested plain-object block, or null when the key is absent or holds any other shape. */
function objectAt(parent: Record<string, unknown>, key: string): Record<string, unknown> | null {
  if (!Object.hasOwn(parent, key)) return null;
  const value = parent[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * `memory.koda.url` and `memory.koda.headers` are the operator's credentials, not the
 * repository's: a project (or profile, or per-package override) declaring either would
 * let a repository point nax — and the agent key it sends — at a host of its choosing.
 *
 * Only the key's path reaches the refusal; never the value, which may be a bearer token.
 */
function rejectNonGlobalKodaKeys(layerConf: Record<string, unknown>, layerName: string): void {
  const memory = objectAt(layerConf, "memory");
  if (memory === null) return;
  const koda = objectAt(memory, "koda");
  if (koda === null) return;
  for (const key of KODA_GLOBAL_ONLY_KEYS) {
    if (!Object.hasOwn(koda, key)) continue;
    throw new NaxError(
      `memory.koda.${key} belongs in ~/.nax/config.json and cannot be set in ${layerName}`,
      "MEMORY_KODA_CONFIG_NOT_GLOBAL",
      { stage: "config", layerName, path: `memory.koda.${key}` },
    );
  }
}

/** Rejects settings that are only trusted when supplied by the global operator config. */
export function rejectGlobalOnlyKeys<T extends Record<string, unknown>>(layerConf: T, layerName: string): T {
  // `trust` is a consent decision the operator makes about THIS repository. A
  // project (or a profile, or a package override) declaring its own trust would
  // be the repository granting itself the right to run its code on the host.
  if (Object.hasOwn(layerConf, "trust")) {
    throw new NaxError(`trust is global-only and cannot be set in ${layerName}`, "TRUST_CONFIG_NOT_GLOBAL", {
      stage: "config",
      layerName,
    });
  }
  if (Object.hasOwn(layerConf, "auth")) {
    throw new NaxError(`auth is global-only and cannot be set in ${layerName}`, "AUTH_CONFIG_NOT_GLOBAL", {
      stage: "config",
      layerName,
    });
  }
  rejectNonGlobalKodaKeys(layerConf, layerName);
  return layerConf;
}
