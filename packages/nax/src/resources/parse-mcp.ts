import { isResourceObject, readResourceJson, resourceError } from "./parse-shared";
import type { ResourceScanResult } from "./scan-dirs";
import type { McpServerResource, ResourceOrigin } from "./types";

function transportOf(entry: unknown): McpServerResource["transport"] | undefined {
  if (!isResourceObject(entry)) return undefined;
  if (entry.type === "http" || entry.type === "sse") return entry.type;
  return typeof entry.command === "string" ? "stdio" : undefined;
}

/** Catalog metadata only; never connect to servers or run their commands. */
export function parseMcpJson(
  path: string,
  text: string,
  origin: ResourceOrigin,
): ResourceScanResult<McpServerResource> {
  const result: ResourceScanResult<McpServerResource> = { resources: [], diagnostics: [] };
  const parsed = readResourceJson(path, text, origin);
  if ("diagnostic" in parsed) return { resources: [], diagnostics: [parsed.diagnostic] };
  if (!isResourceObject(parsed.data)) {
    result.diagnostics.push(resourceError(path, origin, `Expected MCP JSON object in ${path}`).diagnostic);
    return result;
  }
  const servers = parsed.data.mcpServers;
  if (servers === undefined) return result;
  if (!isResourceObject(servers)) {
    result.diagnostics.push(resourceError(path, origin, `mcpServers must be an object in ${path}`).diagnostic);
    return result;
  }
  for (const [name, entry] of Object.entries(servers)) {
    const transport = transportOf(entry);
    if (transport) result.resources.push({ kind: "mcp", name, transport, path, origin });
    else
      result.diagnostics.push({
        severity: "warn",
        path,
        origin,
        message: `[resources] Unsupported MCP entry ${name} in ${path}`,
      });
  }
  return result;
}
