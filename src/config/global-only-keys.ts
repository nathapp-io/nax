import { NaxError } from "../errors";

export { readGlobalAuthConfig } from "./auth";

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
  return layerConf;
}
