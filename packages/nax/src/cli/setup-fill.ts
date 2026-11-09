import { join } from "node:path";
import type { RepoAnalysis } from "./setup-types";

const TYPE_CHECK_KEY = "type-check";
const TYPE_CHECK_SCRIPT = "tsc --noEmit -p tsconfig.json";
const TYPE_CHECK_TURBO_PASSTHROUGH = "turbo run type-check";

/** Non-fatal setup reporter — setup forwards this to stderr. */
export type SetupWarn = (message: string) => void;

/**
 * The single warning text for a manifest that exists but will not parse.
 * Exported so tests pin the wording without duplicating it.
 */
export function unreadableManifestWarning(path: string): string {
  return `[setup] ${path} could not be read as JSON; left unchanged`;
}

export const _fillScriptsDeps = {
  readJson: async (path: string): Promise<Record<string, unknown> | null> => {
    try {
      const f = Bun.file(path);
      if (!(await f.exists())) return null;
      return JSON.parse(await f.text()) as Record<string, unknown>;
    } catch {
      return null;
    }
  },
  exists: async (path: string): Promise<boolean> => Bun.file(path).exists(),
  writeFile: async (path: string, content: string): Promise<void> => {
    await Bun.write(path, content);
  },
};

/**
 * Read a manifest about to be edited.
 *
 * Returns the parsed object, `{}` when the file is simply absent (it is then
 * created), and `null` when the file exists but does not parse — the caller
 * must leave it untouched, because rewriting it would drop whatever the
 * original held (M18: a trailing comma cost a package.json its name, version,
 * dependencies and workspaces). `readJson` cannot tell the two null cases
 * apart, so the distinction comes from `exists`.
 */
async function readManifest(path: string, warn?: SetupWarn): Promise<Record<string, unknown> | null> {
  const parsed = await _fillScriptsDeps.readJson(path);
  if (parsed !== null) return parsed;
  if (await _fillScriptsDeps.exists(path)) {
    warn?.(unreadableManifestWarning(path));
    return null;
  }
  return {};
}

/** @returns `false` when the manifest exists but is unreadable and was left unchanged. */
async function addScriptToPackageJson(
  pkgJsonPath: string,
  key: string,
  value: string,
  warn?: SetupWarn,
): Promise<boolean> {
  const pkg = await readManifest(pkgJsonPath, warn);
  if (pkg === null) return false;
  const scripts = (pkg.scripts as Record<string, string> | undefined) ?? {};
  if (key in scripts) return true;
  const updated = { ...pkg, scripts: { ...scripts, [key]: value } };
  await _fillScriptsDeps.writeFile(pkgJsonPath, JSON.stringify(updated, null, 2));
  return true;
}

/** @returns `false` when turbo.json exists but is unreadable and was left unchanged. */
async function addTurboTask(turboJsonPath: string, taskKey: string, warn?: SetupWarn): Promise<boolean> {
  const turbo = await readManifest(turboJsonPath, warn);
  if (turbo === null) return false;
  const field = "pipeline" in turbo ? "pipeline" : "tasks";
  const existing = (turbo[field] as Record<string, unknown> | undefined) ?? {};
  if (taskKey in existing) return true;
  const updated = { ...turbo, [field]: { ...existing, [taskKey]: {} } };
  await _fillScriptsDeps.writeFile(turboJsonPath, JSON.stringify(updated, null, 2));
  return true;
}

export async function fillScripts(workdir: string, analysis: RepoAnalysis, warn?: SetupWarn): Promise<void> {
  const { shape, packages, orchestrator } = analysis;

  if (shape === "single") {
    const rootPkg = packages[0];
    if (rootPkg?.missingScripts.includes(TYPE_CHECK_KEY)) {
      await addScriptToPackageJson(join(workdir, "package.json"), TYPE_CHECK_KEY, TYPE_CHECK_SCRIPT, warn);
    }
    return;
  }

  // mono: fill each member package
  for (const pkg of packages) {
    if (!pkg.missingScripts.includes(TYPE_CHECK_KEY)) continue;
    await addScriptToPackageJson(
      join(workdir, pkg.relativeDir, "package.json"),
      TYPE_CHECK_KEY,
      TYPE_CHECK_SCRIPT,
      warn,
    );
  }

  // turbo: add task to turbo.json + passthrough to root package.json — the
  // passthrough is meaningless without the task, so a skipped turbo.json skips
  // it too.
  if (orchestrator === "turbo" && packages.some((p) => p.missingScripts.includes(TYPE_CHECK_KEY))) {
    const turboWritten = await addTurboTask(join(workdir, "turbo.json"), TYPE_CHECK_KEY, warn);
    if (turboWritten) {
      await addScriptToPackageJson(join(workdir, "package.json"), TYPE_CHECK_KEY, TYPE_CHECK_TURBO_PASSTHROUGH, warn);
    }
  }
}
