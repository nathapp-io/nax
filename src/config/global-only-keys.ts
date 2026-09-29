import { NaxError } from "../errors";

export { readGlobalAuthConfig } from "./auth";

/** Rejects settings that are only trusted when supplied by the global operator config. */
export function rejectGlobalOnlyKeys<T extends Record<string, unknown>>(layerConf: T, layerName: string): T {
  if (Object.hasOwn(layerConf, "auth")) {
    throw new NaxError(`auth is global-only and cannot be set in ${layerName}`, "AUTH_CONFIG_NOT_GLOBAL", {
      stage: "config",
      layerName,
    });
  }
  return layerConf;
}
