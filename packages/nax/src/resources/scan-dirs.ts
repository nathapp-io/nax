import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { parseAgentFile } from "./parse-agent";
import { parseCommandFile } from "./parse-command";
import { resourceError } from "./parse-shared";
import { parseSkillFile } from "./parse-skill";
import type { AgentResource, CommandResource, ResourceDiagnostic, ResourceOrigin, SkillResource } from "./types";

/** Agent definitions are top-level markdown files, parsed for listing only. */
export function scanAgentsDir(dir: string, origin: ResourceOrigin): Promise<ResourceScanResult<AgentResource>> {
  return scanDir({ dir, origin, pattern: "*.md", parse: parseAgentFile });
}

export const MAX_RESOURCE_FILES_PER_DIR = 500;

export const _resourceFsDeps = {
  async listFiles(dir: string, pattern: string): Promise<string[]> {
    return Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: dir, onlyFiles: true, dot: false }));
  },
  readFile(path: string): Promise<string> {
    return Bun.file(path).text();
  },
};

export interface ResourceScanResult<T> {
  resources: T[];
  diagnostics: ResourceDiagnostic[];
}

type Parser<T> = (
  path: string,
  text: string,
  origin: ResourceOrigin,
) => { resource: T } | { diagnostic: ResourceDiagnostic };

async function scanDir<T>(options: {
  dir: string;
  origin: ResourceOrigin;
  pattern: string;
  parse: Parser<T>;
}): Promise<ResourceScanResult<T>> {
  const { dir, origin, pattern, parse } = options;
  const result: ResourceScanResult<T> = { resources: [], diagnostics: [] };
  let files: string[];
  try {
    files = (await _resourceFsDeps.listFiles(dir, pattern)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
      result.diagnostics.push(resourceError(dir, origin, `Cannot list ${dir}: ${errorMessage(error)}`).diagnostic);
    }
    return result;
  }
  if (files.length > MAX_RESOURCE_FILES_PER_DIR) {
    result.diagnostics.push({
      severity: "warn",
      path: dir,
      origin,
      message: `[resources] Truncated ${dir} to ${MAX_RESOURCE_FILES_PER_DIR} files`,
    });
  }
  for (const file of files.slice(0, MAX_RESOURCE_FILES_PER_DIR)) {
    const path = join(dir, file);
    try {
      const parsed = parse(path, await _resourceFsDeps.readFile(path), origin);
      if ("resource" in parsed) result.resources.push(parsed.resource);
      else result.diagnostics.push(parsed.diagnostic);
    } catch (error) {
      result.diagnostics.push(resourceError(path, origin, `Cannot read ${path}: ${errorMessage(error)}`).diagnostic);
    }
  }
  return result;
}

/** Read visible one-level skill directories, never nested skills. */
export function scanSkillsDir(dir: string, origin: ResourceOrigin): Promise<ResourceScanResult<SkillResource>> {
  return scanDir({ dir, origin, pattern: "*/SKILL.md", parse: parseSkillFile });
}

/** Command templates are top-level markdown files; their contents are not expanded here. */
export function scanCommandsDir(dir: string, origin: ResourceOrigin): Promise<ResourceScanResult<CommandResource>> {
  return scanDir({ dir, origin, pattern: "*.md", parse: parseCommandFile });
}
