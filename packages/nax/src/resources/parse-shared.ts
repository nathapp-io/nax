import { errorMessage } from "@nathapp/nax-agent/internal";
import type { ResourceDiagnostic, ResourceOrigin } from "./types";

export function isResourceObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readResourceJson(
  path: string,
  text: string,
  origin: ResourceOrigin,
): { data: unknown } | { diagnostic: ResourceDiagnostic } {
  try {
    return { data: JSON.parse(text) };
  } catch (error) {
    return resourceError(path, origin, `Cannot parse JSON in ${path}: ${errorMessage(error)}`);
  }
}

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
