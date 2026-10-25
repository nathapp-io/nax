import { errorMessage } from "@nathapp/nax-agent/internal";
import { parseMcpServers } from "./parse-mcp";
import { isResourceObject, readResourceJson, resourceError } from "./parse-shared";
import { _resourceFsDeps } from "./scan-dirs";
import type { McpServerResource, ResourceDiagnostic, ResourceOrigin } from "./types";

const USER_ORIGIN: ResourceOrigin = { kind: "claude-user" };
const PROJECT_ORIGIN: ResourceOrigin = { kind: "claude-project" };

export interface ClaudeJsonMcp {
  user: McpServerResource[];
  local: McpServerResource[];
  /** Diagnostics for the user-scope servers and for the file itself. */
  userDiagnostics: ResourceDiagnostic[];
  /** Diagnostics for the repo's local-scope servers; a malformed `projects` value goes on the user package. */
  projectDiagnostics: ResourceDiagnostic[];
}

async function readText(path: string, diagnostics: ResourceDiagnostic[]): Promise<string | undefined> {
  try {
    return await _resourceFsDeps.readFile(path);
  } catch (error) {
    const missing = isResourceObject(error) && error.code === "ENOENT";
    if (!missing)
      diagnostics.push(resourceError(path, USER_ORIGIN, `Cannot read ${path}: ${errorMessage(error)}`).diagnostic);
    return undefined;
  }
}

function serversOf(options: {
  path: string;
  value: unknown;
  origin: ResourceOrigin;
  scope: "user" | "local";
  label: string;
  diagnostics: ResourceDiagnostic[];
}): McpServerResource[] {
  const { path, value, origin, scope, label, diagnostics } = options;
  if (value === undefined) return [];
  if (!isResourceObject(value)) {
    diagnostics.push(resourceError(path, origin, `${label} must be an object in ${path}`).diagnostic);
    return [];
  }
  const parsed = parseMcpServers(path, value, origin, scope);
  diagnostics.push(...parsed.diagnostics);
  return parsed.resources;
}

function localServers(
  path: string,
  data: Record<string, unknown>,
  repoRoot: string,
  result: ClaudeJsonMcp,
): McpServerResource[] {
  const { projects } = data;
  const diagnostics = result.projectDiagnostics;
  if (projects === undefined) return [];
  if (!isResourceObject(projects)) {
    result.userDiagnostics.push(resourceError(path, USER_ORIGIN, `projects must be an object in ${path}`).diagnostic);
    return [];
  }
  if (!Object.hasOwn(projects, repoRoot)) return [];
  const entry = projects[repoRoot];
  if (!isResourceObject(entry)) {
    diagnostics.push(
      resourceError(path, PROJECT_ORIGIN, `projects entry for ${repoRoot} must be an object`).diagnostic,
    );
    return [];
  }
  return serversOf({
    path,
    value: entry.mcpServers,
    origin: PROJECT_ORIGIN,
    scope: "local",
    label: `projects[${repoRoot}].mcpServers`,
    diagnostics,
  });
}

/** One read of Claude Code's .claude.json: user-scope and this repo's local-scope MCP servers. */
export async function readClaudeJsonMcp(path: string, repoRoot: string): Promise<ClaudeJsonMcp> {
  const result: ClaudeJsonMcp = { user: [], local: [], userDiagnostics: [], projectDiagnostics: [] };
  const text = await readText(path, result.userDiagnostics);
  if (text === undefined) return result;
  const parsed = readResourceJson(path, text, USER_ORIGIN);
  if ("diagnostic" in parsed) {
    result.userDiagnostics.push(parsed.diagnostic);
    return result;
  }
  if (!isResourceObject(parsed.data)) {
    result.userDiagnostics.push(resourceError(path, USER_ORIGIN, `Expected JSON object in ${path}`).diagnostic);
    return result;
  }
  result.user = serversOf({
    path,
    value: parsed.data.mcpServers,
    origin: USER_ORIGIN,
    scope: "user",
    label: "mcpServers",
    diagnostics: result.userDiagnostics,
  });
  result.local = localServers(path, parsed.data, repoRoot, result);
  return result;
}
