/**
 * Tier 1 — Python Framework Config Parsers (pytest)
 *
 * Extracts test-file patterns from pytest configuration sources.
 * Called by the main framework-configs.ts orchestrator.
 */

import { _frameworkConfigDeps } from "./framework-configs-deps";
import type { DetectionSource } from "./types";

/** Directories always excluded from produced globs */
const EXCLUDE_DIRS = ["node_modules", "dist", "build", ".nax", "coverage", ".git"];

function filterExcluded(patterns: string[]): string[] {
  return patterns.filter((p) => !EXCLUDE_DIRS.some((d) => p.includes(`/${d}/`) || p.startsWith(`${d}/`)));
}

/**
 * Parse pyproject.toml for pytest test configuration.
 * Extracts testpaths and python_files from [tool.pytest.ini_options].
 */
export async function parsePyprojectToml(workdir: string): Promise<DetectionSource | null> {
  const path = `${workdir}/pyproject.toml`;
  const text = await _frameworkConfigDeps.readText(path);
  if (!text) return null;

  try {
    const parsed = _frameworkConfigDeps.parseToml(text) as Record<string, unknown>;
    const tool = parsed?.tool as Record<string, unknown> | undefined;
    const pytest = tool?.pytest as Record<string, unknown> | undefined;
    const iniOptions = (pytest?.ini_options ?? tool?.["pytest.ini_options"]) as Record<string, unknown> | undefined;

    if (!iniOptions) {
      // pyproject.toml exists but no pytest config section
      return null;
    }

    const patterns: string[] = [];

    // testpaths: ["tests", "src"] → "tests/**/*.py"
    const testpaths = iniOptions.testpaths;
    if (Array.isArray(testpaths)) {
      for (const p of testpaths) {
        if (typeof p === "string") patterns.push(`${p}/**/*.py`);
      }
    }

    // python_files: ["test_*.py", "*_test.py"]
    const pythonFiles = iniOptions.python_files;
    if (Array.isArray(pythonFiles)) {
      for (const p of pythonFiles) {
        if (typeof p === "string") patterns.push(p);
      }
    } else if (typeof pythonFiles === "string") {
      patterns.push(pythonFiles);
    }

    // Default pytest patterns when config exists but no explicit patterns
    if (patterns.length === 0) {
      patterns.push("test_*.py", "*_test.py");
    }

    return { type: "framework-config", framework: "pytest", path, patterns: filterExcluded(patterns) };
  } catch {
    return null;
  }
}

/**
 * Parse pytest.ini or setup.cfg for test configuration.
 */
export async function parsePytestIni(workdir: string): Promise<DetectionSource | null> {
  const candidates = ["pytest.ini", "setup.cfg"];
  for (const name of candidates) {
    const path = `${workdir}/${name}`;
    const text = await _frameworkConfigDeps.readText(path);
    if (!text) continue;

    if (!text.includes("[pytest]") && !text.includes("[tool:pytest]")) continue;

    const patterns: string[] = [];

    // testpaths = tests src
    const testpathsMatch = text.match(/testpaths\s*=\s*([^\n]+)/);
    if (testpathsMatch) {
      for (const p of testpathsMatch[1].trim().split(/\s+/)) {
        if (p) patterns.push(`${p}/**/*.py`);
      }
    }

    // python_files = test_*.py *_test.py
    const pyFilesMatch = text.match(/python_files\s*=\s*([^\n]+)/);
    if (pyFilesMatch) {
      for (const p of pyFilesMatch[1].trim().split(/\s+/)) {
        if (p) patterns.push(p);
      }
    }

    if (patterns.length === 0) patterns.push("test_*.py", "*_test.py");
    return { type: "framework-config", framework: "pytest", path, patterns: filterExcluded(patterns) };
  }
  return null;
}
