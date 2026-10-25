import { errorMessage } from "@nathapp/nax-agent/internal";
import { isResourceObject, readResourceJson, resourceError } from "./parse-shared";
import type { HookResource, ResourceDiagnostic, ResourceOrigin } from "./types";

export type HookParseResult =
  | { resource: HookResource }
  | { diagnostic: ResourceDiagnostic }
  | { resource?: never; diagnostic?: never };

/** Extract event names only, never inspect or execute hook actions. */
export function hooksFromSettings(path: string, settings: unknown, origin: ResourceOrigin): HookParseResult {
  try {
    if (!isResourceObject(settings)) return resourceError(path, origin, `Expected settings object in ${path}`);
    if (!Object.hasOwn(settings, "hooks")) return {};
    if (!isResourceObject(settings.hooks)) return resourceError(path, origin, `Hooks must be an object in ${path}`);
    return { resource: { kind: "hooks", events: Object.keys(settings.hooks), path, origin } };
  } catch (error) {
    return resourceError(path, origin, `Cannot parse hooks in ${path}: ${errorMessage(error)}`);
  }
}

/** Plugin hooks/hooks.json uses the same hooks envelope as settings.json. */
export function parseHooksJson(path: string, text: string, origin: ResourceOrigin): HookParseResult {
  const parsed = readResourceJson(path, text, origin);
  return "diagnostic" in parsed ? parsed : hooksFromSettings(path, parsed.data, origin);
}
