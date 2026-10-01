import { join } from "node:path";
import type { RepoAnalysis } from "./setup-types";

const TYPE_CHECK_KEY = "type-check";
const TYPE_CHECK_SCRIPT = "tsc --noEmit -p tsconfig.json";
const TYPE_CHECK_TURBO_PASSTHROUGH = "turbo run type-check";

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
  writeFile: async (path: string, content: string): Promise<void> => {
    await Bun.write(path, content);
  },
};

async function addScriptToPackageJson(pkgJsonPath: string, key: string, value: string): Promise<void> {
  const pkg = (await _fillScriptsDeps.readJson(pkgJsonPath)) ?? {};
  const scripts = (pkg.scripts as Record<string, string> | undefined) ?? {};
  if (key in scripts) return;
  const updated = { ...pkg, scripts: { ...scripts, [key]: value } };
  await _fillScriptsDeps.writeFile(pkgJsonPath, JSON.stringify(updated, null, 2));
}

async function addTurboTask(turboJsonPath: string, taskKey: string): Promise<void> {
  const turbo = (await _fillScriptsDeps.readJson(turboJsonPath)) ?? {};
  const field = "pipeline" in turbo ? "pipeline" : "tasks";
  const existing = (turbo[field] as Record<string, unknown> | undefined) ?? {};
  if (taskKey in existing) return;
  const updated = { ...turbo, [field]: { ...existing, [taskKey]: {} } };
  await _fillScriptsDeps.writeFile(turboJsonPath, JSON.stringify(updated, null, 2));
}

export async function fillScripts(workdir: string, analysis: RepoAnalysis): Promise<void> {
  const { shape, packages, orchestrator } = analysis;

  if (shape === "single") {
    const rootPkg = packages[0];
    if (rootPkg?.missingScripts.includes(TYPE_CHECK_KEY)) {
      await addScriptToPackageJson(join(workdir, "package.json"), TYPE_CHECK_KEY, TYPE_CHECK_SCRIPT);
    }
    return;
  }

  // mono: fill each member package
  for (const pkg of packages) {
    if (!pkg.missingScripts.includes(TYPE_CHECK_KEY)) continue;
    await addScriptToPackageJson(join(workdir, pkg.relativeDir, "package.json"), TYPE_CHECK_KEY, TYPE_CHECK_SCRIPT);
  }

  // turbo: add task to turbo.json + passthrough to root package.json
  if (orchestrator === "turbo" && packages.some((p) => p.missingScripts.includes(TYPE_CHECK_KEY))) {
    await addTurboTask(join(workdir, "turbo.json"), TYPE_CHECK_KEY);
    await addScriptToPackageJson(join(workdir, "package.json"), TYPE_CHECK_KEY, TYPE_CHECK_TURBO_PASSTHROUGH);
  }
}
