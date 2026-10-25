import { isAbsolute, win32 } from "node:path";
import { getSafeLogger } from "../logger";

/** Validate data-only directories before the registry resolves them. */
export function validateResourceProvider(pluginName: string, extension: unknown): boolean {
  if (typeof extension !== "object" || extension === null || Array.isArray(extension)) {
    getSafeLogger()?.warn("plugins", `Plugin '${pluginName}' validation failed: resources extension must be an object`);
    return false;
  }
  for (const field of ["skills", "commands", "agents"] as const) {
    if (!(field in extension)) continue;
    const value = Reflect.get(extension, field);
    if (
      typeof value !== "string" ||
      !value.trim() ||
      isAbsolute(value) ||
      win32.isAbsolute(value) ||
      value.split(/[\\/]/).includes("..")
    ) {
      getSafeLogger()?.warn(
        "plugins",
        `Plugin '${pluginName}' validation failed: resources.${field} must be a non-empty relative path without '..' segments`,
      );
      return false;
    }
  }
  return true;
}
