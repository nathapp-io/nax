import { isResourceObject, readResourceJson, resourceError } from "./parse-shared";
import type { ResourceScanResult } from "./scan-dirs";
import type { McpServerResource, McpServerScope, McpServerSpec, ResourceOrigin } from "./types";

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return {};
  if (!isResourceObject(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) return undefined;
  return Object.fromEntries(entries);
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === "string") ? [...value] : undefined;
}

function specOf(entry: unknown): McpServerSpec | undefined {
  if (!isResourceObject(entry)) return undefined;
  if (entry.type === "http" || entry.type === "sse") {
    const headers = stringRecord(entry.headers);
    if (typeof entry.url !== "string" || !headers) return undefined;
    return { transport: entry.type, url: entry.url, headers };
  }
  if (typeof entry.command !== "string") return undefined;
  const args = stringArray(entry.args);
  const env = stringRecord(entry.env);
  return args && env ? { transport: "stdio", command: entry.command, args, env } : undefined;
}

/** Parse an already-decoded mcpServers object. Catalog metadata only; never connects or runs commands. */
export function parseMcpServers(
  path: string,
  servers: Record<string, unknown>,
  origin: ResourceOrigin,
  scope: McpServerScope,
): ResourceScanResult<McpServerResource> {
  const result: ResourceScanResult<McpServerResource> = { resources: [], diagnostics: [] };
  for (const [name, entry] of Object.entries(servers)) {
    const server = specOf(entry);
    if (server) result.resources.push({ kind: "mcp", name, transport: server.transport, scope, server, path, origin });
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

export function parseMcpJson(
  path: string,
  text: string,
  origin: ResourceOrigin,
  scope: McpServerScope,
): ResourceScanResult<McpServerResource> {
  const parsed = readResourceJson(path, text, origin);
  if ("diagnostic" in parsed) return { resources: [], diagnostics: [parsed.diagnostic] };
  if (!isResourceObject(parsed.data)) {
    return {
      resources: [],
      diagnostics: [resourceError(path, origin, `Expected MCP JSON object in ${path}`).diagnostic],
    };
  }
  const servers = parsed.data.mcpServers;
  if (servers === undefined) return { resources: [], diagnostics: [] };
  if (!isResourceObject(servers)) {
    return {
      resources: [],
      diagnostics: [resourceError(path, origin, `mcpServers must be an object in ${path}`).diagnostic],
    };
  }
  return parseMcpServers(path, servers, origin, scope);
}
