/**
 * Context.md Generation (INIT-002)
 *
 * Generates context.md from filesystem scan with optional LLM enhancement.
 * Default mode: template from scan (zero LLM cost)
 * AI mode (--ai flag): LLM-powered narrative context
 */

import { mkdir, readdir } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { NaxError } from "../errors";
import { getLogger } from "../logger";
import { isRelativeAndSafe } from "../utils/path-security";

const EXCLUDED_DIR_NAMES = new Set(["node_modules", ".git", "dist"]);

async function bunFileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

async function mkdirp(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/** Project scan results */
export interface ProjectScan {
  projectName: string;
  fileTree: string[];
  packageManifest: {
    name?: string;
    description?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
  } | null;
  readmeSnippet: string | null;
  entryPoints: string[];
  configFiles: string[];
}

/** Package manifest structure */
interface PackageManifest {
  name?: string;
  description?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
}

/** initContext options */
export interface InitContextOptions {
  force?: boolean;
}

/**
 * Recursively find all files in a directory, excluding certain paths.
 * Returns repo-relative paths, limited to maxFiles entries.
 */
async function findFiles(dir: string, maxFiles = 200): Promise<string[]> {
  const files: string[] = [];
  await walkDir(dir, dir, files, maxFiles);
  return files;
}

async function walkDir(root: string, current: string, out: string[], maxFiles: number): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    // Fail-open: directory unreadable yields no entries, matching the prior
    // behavior of the `find` shell-out swallowing its own failure.
    return;
  }

  for (const entry of entries) {
    if (out.length >= maxFiles) return;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      await walkDir(root, join(current, entry.name), out, maxFiles);
    } else if (entry.isFile()) {
      // Normalize to forward slashes — `relative` returns platform-native
      // separators, so on Windows this would otherwise emit `nested\\deep\\a.ts`
      // and break the repo-relative contract.
      out.push(relative(root, join(current, entry.name)).replaceAll(sep, "/"));
    }
  }
}

/**
 * Read and parse package.json if it exists
 */
async function readPackageManifest(projectRoot: string): Promise<PackageManifest | null> {
  const packageJsonPath = join(projectRoot, "package.json");

  if (!(await bunFileExists(packageJsonPath))) {
    return null;
  }

  try {
    const content = await Bun.file(packageJsonPath).text();
    const manifest = JSON.parse(content) as PackageManifest;
    return {
      name: manifest.name,
      description: manifest.description,
      scripts: manifest.scripts,
      dependencies: manifest.dependencies,
    };
  } catch {
    return null;
  }
}

/**
 * Read first 100 lines of README.md if it exists
 */
async function readReadmeSnippet(projectRoot: string): Promise<string | null> {
  const readmePath = join(projectRoot, "README.md");

  if (!(await bunFileExists(readmePath))) {
    return null;
  }

  try {
    const content = await Bun.file(readmePath).text();
    const lines = content.split("\n");
    return lines.slice(0, 100).join("\n");
  } catch {
    return null;
  }
}

/**
 * Detect entry points in the project
 */
async function detectEntryPoints(projectRoot: string): Promise<string[]> {
  const candidates = ["src/index.ts", "src/main.ts", "main.go", "src/lib.rs"];
  const found: string[] = [];

  for (const candidate of candidates) {
    const path = join(projectRoot, candidate);
    if (await bunFileExists(path)) {
      found.push(candidate);
    }
  }

  return found;
}

/**
 * Detect config files in the project
 */
async function detectConfigFiles(projectRoot: string): Promise<string[]> {
  const candidates = ["tsconfig.json", "biome.json", "turbo.json", ".env.example"];
  const found: string[] = [];

  for (const candidate of candidates) {
    const path = join(projectRoot, candidate);
    if (await bunFileExists(path)) {
      found.push(candidate);
    }
  }

  return found;
}

/**
 * Scan a project for context information
 */
export async function scanProject(projectRoot: string): Promise<ProjectScan> {
  const fileTree = await findFiles(projectRoot, 200);
  const packageManifest = await readPackageManifest(projectRoot);
  const readmeSnippet = await readReadmeSnippet(projectRoot);
  const entryPoints = await detectEntryPoints(projectRoot);
  const configFiles = await detectConfigFiles(projectRoot);

  // Determine project name from package.json or directory basename
  const projectName = packageManifest?.name || basename(projectRoot);

  return {
    projectName,
    fileTree,
    packageManifest,
    readmeSnippet,
    entryPoints,
    configFiles,
  };
}

/**
 * Generate a markdown template for context.md from scan results
 */
export function generateContextTemplate(scan: ProjectScan): string {
  const lines: string[] = [];

  lines.push(`# ${scan.projectName}\n`);

  if (scan.packageManifest?.description) {
    lines.push(`${scan.packageManifest.description}\n`);
  } else {
    lines.push("<!-- TODO: Add project description -->\n");
  }

  if (scan.entryPoints.length > 0) {
    lines.push("## Entry Points\n");
    for (const ep of scan.entryPoints) {
      lines.push(`- ${ep}`);
    }
    lines.push("");
  } else {
    lines.push("## Entry Points\n");
    lines.push("<!-- TODO: Document entry points -->\n");
  }

  if (scan.fileTree.length > 0) {
    lines.push("## Project Structure\n");
    lines.push("```");
    for (const file of scan.fileTree.slice(0, 20)) {
      lines.push(file);
    }
    if (scan.fileTree.length > 20) {
      lines.push(`... and ${scan.fileTree.length - 20} more files`);
    }
    lines.push("```\n");
  } else {
    lines.push("## Project Structure\n");
    lines.push("<!-- TODO: Document project structure -->\n");
  }

  if (scan.configFiles.length > 0) {
    lines.push("## Configuration Files\n");
    for (const cf of scan.configFiles) {
      lines.push(`- ${cf}`);
    }
    lines.push("");
  } else {
    lines.push("## Configuration Files\n");
    lines.push("<!-- TODO: Document configuration files -->\n");
  }

  if (scan.packageManifest?.scripts) {
    const hasScripts = Object.keys(scan.packageManifest.scripts).length > 0;
    if (hasScripts) {
      lines.push("## Scripts\n");
      for (const [name, command] of Object.entries(scan.packageManifest.scripts)) {
        lines.push(`- **${name}**: \`${command}\``);
      }
      lines.push("");
    }
  }

  if (scan.packageManifest?.dependencies) {
    const deps = Object.keys(scan.packageManifest.dependencies);
    if (deps.length > 0) {
      lines.push("## Dependencies\n");
      lines.push("<!-- TODO: Document key dependencies and their purpose -->\n");
    }
  }

  lines.push("## Development Guidelines\n");
  lines.push("<!-- TODO: Document development guidelines and conventions -->\n");

  return `${lines.join("\n").trim()}\n`;
}

/**
 * Generate a minimal package context.md template.
 *
 * @param packagePath - Relative path of the package (e.g. "packages/api")
 */
export function generatePackageContextTemplate(packagePath: string): string {
  const packageName = packagePath.split("/").pop() ?? packagePath;
  return `# ${packageName} — Context

<!-- Package-specific conventions. Root context.md provides shared rules. -->

## Tech Stack

<!-- TODO: Document this package's tech stack -->

## Commands

| Command | Purpose |
|:--------|:--------|
| \`bun test\` | Unit tests |

## Development Guidelines

<!-- TODO: Document package-specific guidelines -->
`;
}

/**
 * Initialize per-package context.md scaffold.
 *
 * Creates `.nax/mono/<packagePath>/context.md` under the repo root.
 * Does not overwrite an existing file unless force is set.
 *
 * @param repoRoot - Absolute path to repo root
 * @param packagePath - Relative path of the package (e.g. "packages/api")
 * @param force - Overwrite existing file
 */
export async function initPackage(repoRoot: string, packagePath: string, force = false): Promise<void> {
  if (!isRelativeAndSafe(packagePath)) {
    throw new NaxError(
      `initPackage: packagePath "${packagePath}" is not a safe relative path (must be non-empty, relative, and free of ".." segments)`,
      "INVALID_PACKAGE_PATH",
      { stage: "init-context", packagePath },
    );
  }

  const logger = getLogger();
  const naxDir = join(repoRoot, ".nax", "mono", packagePath);
  const contextPath = join(naxDir, "context.md");

  if ((await bunFileExists(contextPath)) && !force) {
    logger.info("init", "Package context.md already exists (use --force to overwrite)", {
      storyId: "init-context",
      path: contextPath,
    });
    return;
  }

  // mkdir(..., { recursive: true }) throws EEXIST when the path is a regular
  // file — surface it as a typed NaxError, mirroring initContext. Call it
  // unconditionally: a bunFileExists(naxDir) guard would return true (and
  // skip this) when naxDir itself is a regular file — exactly the case this
  // must catch — since Bun.file(path).exists() is true for a regular file.
  try {
    await mkdirp(naxDir);
  } catch (err) {
    throw new NaxError(`initPackage: failed to create ${naxDir}: ${(err as Error).message}`, "INIT_ERROR", {
      stage: "init-context",
      path: naxDir,
      cause: err,
    });
  }

  const content = generatePackageContextTemplate(packagePath);
  await Bun.write(contextPath, content);
  logger.info("init", "Created package context.md", { storyId: "init-context", path: contextPath });
}

/**
 * Initialize context.md for a project
 */
export async function initContext(projectRoot: string, options: InitContextOptions = {}): Promise<void> {
  const logger = getLogger();
  const naxDir = join(projectRoot, ".nax");
  const contextPath = join(naxDir, "context.md");

  // Check if context.md already exists
  if ((await bunFileExists(contextPath)) && !options.force) {
    logger.info("init", "context.md already exists, skipping (use --force to overwrite)", {
      storyId: "init-context",
      path: contextPath,
    });
    return;
  }

  // Create nax directory. mkdir(..., { recursive: true }) throws EEXIST when
  // the path is a regular file — that is exactly the failure mode that the
  // previous spawn-and-ignore-exit-code path was silently turning into an
  // empty-success result. Surface it as a typed NaxError instead.
  try {
    await mkdirp(naxDir);
  } catch (err) {
    throw new NaxError(`initContext: failed to create ${naxDir}: ${(err as Error).message}`, "INIT_ERROR", {
      stage: "init-context",
      path: naxDir,
      cause: err,
    });
  }

  // Scan the project
  const scan = await scanProject(projectRoot);

  // Generate content from template
  const content = generateContextTemplate(scan);

  // Write context.md
  await Bun.write(contextPath, content);
  logger.info("init", "Generated .nax/context.md template from project scan", {
    storyId: "init-context",
    path: contextPath,
  });
}
