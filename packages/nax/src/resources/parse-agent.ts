import { errorMessage } from "@nathapp/nax-agent/internal";
import { readResourceFrontmatter } from "./frontmatter";
import { qualifyResourceName, resourceError } from "./parse-shared";
import type { AgentResource, ResourceDiagnostic, ResourceOrigin } from "./types";

function parseTools(value: unknown): string[] | undefined {
  if (typeof value === "string")
    return value
      .split(",")
      .map((tool) => tool.trim())
      .filter(Boolean);
  if (Array.isArray(value) && value.every((tool): tool is string => typeof tool === "string")) return value;
  return undefined;
}

/** Metadata only: agent instructions are neither delivered nor executed. */
export function parseAgentFile(
  path: string,
  text: string,
  origin: ResourceOrigin,
): { resource: AgentResource } | { diagnostic: ResourceDiagnostic } {
  try {
    const parsed = readResourceFrontmatter(text);
    if ("error" in parsed) return resourceError(path, origin, parsed.error);
    const { name, description, model, tools } = parsed.data;
    if (typeof name !== "string" || !name.trim() || typeof description !== "string" || !description.trim()) {
      return resourceError(path, origin, `Agent name and description are required in ${path}`);
    }
    if (model !== undefined && typeof model !== "string") {
      return resourceError(path, origin, `Agent model must be a string in ${path}`);
    }
    const parsedTools = parseTools(tools);
    if (tools !== undefined && parsedTools === undefined) {
      return resourceError(path, origin, `Agent tools must be a comma-separated string or string list in ${path}`);
    }
    return {
      resource: {
        kind: "agent",
        name,
        qualifiedName: qualifyResourceName(name, origin),
        description,
        path,
        origin,
        ...(model !== undefined ? { model } : {}),
        ...(parsedTools !== undefined ? { tools: parsedTools } : {}),
      },
    };
  } catch (error) {
    return resourceError(path, origin, `Cannot parse ${path}: ${errorMessage(error)}`);
  }
}
