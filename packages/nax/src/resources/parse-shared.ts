import type { ResourceDiagnostic, ResourceOrigin } from "./types";

export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function qualifyResourceName(name: string, origin: ResourceOrigin): string {
  return "plugin" in origin ? `${origin.plugin}:${name}` : name;
}

export function resourceError(
  path: string,
  origin: ResourceOrigin,
  message: string,
): { diagnostic: ResourceDiagnostic } {
  return { diagnostic: { severity: "error", path, origin, message: `[resources] ${message}` } };
}
