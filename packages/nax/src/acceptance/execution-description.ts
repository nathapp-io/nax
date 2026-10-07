import path from "node:path";
import { shellQuoteArg } from "@nathapp/nax-agent/internal";
import type { PipelineContext } from "../pipeline/types";
import { storyExecRoot } from "../runtime/packages";
import { storyPackageDir } from "../utils/path-frame";
import { buildAcceptanceRunCommand, effectiveAcceptanceFramework } from "./generator";

export interface AcceptanceExecution {
  testPath: string;
  cwd: string;
  command: string;
  storyIds: string[];
  acIds: string[];
  filtered: boolean;
}

export const _acceptanceExecutionDeps = {
  async readFile(filePath: string, metadataOnly = false): Promise<{ exists: boolean; text: string }> {
    const file = Bun.file(filePath);
    const exists = await file.exists();
    return { exists, text: exists && !metadataOnly ? await file.text() : "" };
  },
};

function mappedIds(text: string, storyIds: string[]): string[] {
  try {
    const data: unknown = JSON.parse(text);
    if (!Array.isArray(data)) return [];
    return [
      ...new Set(
        data.flatMap((item: unknown) => {
          if (typeof item !== "object" || item === null) return [];
          const entry = item as { acId?: unknown; storyId?: unknown; testable?: unknown };
          return typeof entry.acId === "string" &&
            /^AC-\d+$/.test(entry.acId) &&
            typeof entry.storyId === "string" &&
            storyIds.includes(entry.storyId) &&
            entry.testable !== false
            ? [entry.acId]
            : [];
        }),
      ),
    ];
  } catch {
    // Optional mapping may be absent or malformed; explicitly run unfiltered.
    return [];
  }
}

function scopedCommand(command: string, framework: string | undefined, ids: string[]): string | undefined {
  if (ids.length === 0 || /[;&|\n]/.test(command)) return undefined;
  // Delimiters exclude numeric prefixes such as AC-580 and embedded identifiers.
  const pattern = `(^|[^A-Za-z0-9_-])(${ids.join("|")})([^A-Za-z0-9_-]|$)`;
  switch (framework?.toLowerCase()) {
    case "jest":
      return `${command} --testNamePattern ${shellQuoteArg(pattern)}`;
    case "vitest":
      return `${command} --testNamePattern ${shellQuoteArg(pattern)}`;
    case "bun":
    case "bun-test":
    case undefined:
      return `${command} --test-name-pattern ${shellQuoteArg(pattern)}`;
    default:
      return undefined;
  }
}

function executionPaths(opts: {
  entry: { packageDir: string; testPath: string };
  originalRoot: string;
  root: string;
}): { cwd: string; testPath: string } {
  const { entry, originalRoot, root } = opts;
  const rebase = (value: string) => {
    if (path.isAbsolute(value) && (value === root || value.startsWith(`${root}${path.sep}`))) return value;
    return path.resolve(root, path.isAbsolute(value) ? path.relative(originalRoot, value) : value);
  };
  return { cwd: rebase(entry.packageDir), testPath: rebase(entry.testPath) };
}

function executionCommand(opts: {
  entry: { testFramework?: string; commandOverride?: string };
  config: PipelineContext["config"];
  cwd: string;
  testPath: string;
  acIds: string[];
}): { command: string; filtered: boolean } {
  const { entry, config, cwd, testPath, acIds } = opts;
  const framework = effectiveAcceptanceFramework(config, entry.testFramework);
  const override = entry.commandOverride ?? config.acceptance?.command;
  const command = buildAcceptanceRunCommand(path.relative(cwd, testPath), framework, override, cwd);
  const scoped = scopedCommand(command, framework ?? (override ? "unknown" : "bun"), acIds);
  return { command: scoped ?? command, filtered: scoped !== undefined };
}

/** Resolve execution metadata without reading or embedding generated test source. */
export async function resolveAcceptanceExecution(
  ctx: PipelineContext,
  deps = _acceptanceExecutionDeps,
): Promise<AcceptanceExecution[]> {
  if (ctx.config.acceptance?.enabled === false || !ctx.acceptanceTestPaths?.length) return [];
  const originalRoot = ctx.projectDir ?? ctx.workdir;
  const root = storyExecRoot({ repoRoot: originalRoot, packageDir: path.relative(originalRoot, ctx.workdir) });
  const stories = ctx.stories.length > 1 ? ctx.stories : [ctx.story];
  const mapping = ctx.featureDir
    ? await deps.readFile(path.join(ctx.featureDir, "acceptance-refined.json"))
    : undefined;
  const results: AcceptanceExecution[] = [];
  for (const entry of ctx.acceptanceTestPaths) {
    if (entry.acceptanceEnabled === false) continue;
    const { cwd, testPath } = executionPaths({ entry, originalRoot, root });
    const matching = stories.filter((story) => path.resolve(root, storyPackageDir(story) ?? ".") === cwd);
    if (matching.length === 0) continue;
    if (!(await deps.readFile(testPath, true)).exists) continue;
    const storyIds = matching.map((story) => story.id);
    const acIds = mappedIds(mapping?.text ?? "", storyIds);
    const { command, filtered } = executionCommand({ entry, config: ctx.config, cwd, testPath, acIds });
    results.push({
      testPath: path.relative(root, testPath),
      cwd: path.relative(root, cwd) || ".",
      command,
      storyIds,
      acIds,
      filtered,
    });
  }
  return results;
}
