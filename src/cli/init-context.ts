/**
 * Context.md Generation (INIT-002)
 *
 * Generates context.md from filesystem scan with optional LLM enhancement.
 * Default mode: template from scan (zero LLM cost)
 * AI mode (--ai flag): LLM-powered narrative context
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { getLogger } from "../logger";

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
  ai?: boolean;
  force?: boolean;
}

/** Dependency injection for testing */
export const _deps = {
  callLLM: async (_prompt: string): Promise<string> => {
    // Placeholder implementation
    // In production, this would call the nax LLM infrastructure
    throw new Error("callLLM not implemented");
  },
};

/**
 * Recursively find all files in a directory, excluding certain paths.
 * Returns relative paths, limited to maxFiles entries.
 */
async function findFiles(dir: string, maxFiles = 200): Promise<string[]> {
  // Use find command to locate files, excluding common directories
  try {
    const proc = Bun.spawnSync(
      [
        "find",
        dir,
        "-type",
        "f",
        "-not",
        "-path",
        "*/node_modules/*",
        "-not",
        "-path",
        "*/.git/*",
        "-not",
        "-path",
        "*/dist/*",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    if (proc.success) {
      const output = new TextDecoder().decode(proc.stdout);
      const files = output
        .trim()
        .split("\n")
        .filter((f) => f.length > 0)
        .map((f) => f.replace(`${dir}/`, ""))
        .slice(0, maxFiles);
      return files;
    }
  } catch {
    // find command failed, use fallback
  }

  return [];
}

/**
 * Read and parse package.json if it exists
 */
async function readPackageManifest(projectRoot: string): Promise<PackageManifest | null> {
  const packageJsonPath = join(projectRoot, "package.json");

  if (!existsSync(packageJsonPath)) {
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

  if (!existsSync(readmePath)) {
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
    if (existsSync(path)) {
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
    if (existsSync(path)) {
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
 * Generate context.md with LLM enhancement
 */
async function generateContextWithLLM(scan: ProjectScan): Promise<string> {
  const logger = getLogger();

  // Build LLM prompt from scan results
  const scanSummary = `
Project: ${scan.projectName}
Entry Points: ${scan.entryPoints.join(", ") || "None detected"}
Config Files: ${scan.configFiles.join(", ") || "None detected"}
Total Files: ${scan.fileTree.length}
Description: ${scan.packageManifest?.description || "Not provided"}
`;

  const prompt = `
You are a technical documentation expert. Generate a concise, well-structured context.md file for a software project based on this scan:

${scanSummary}

The context.md should include:
1. Project overview (name, purpose, key technologies)
2. Entry points and main modules
3. Key dependencies and why they're used
4. Development setup and common commands
5. Architecture overview (brief)
6. Development guidelines

Keep it under 2000 tokens. Use markdown formatting. Be specific to the detected stack and structure.
`;

  try {
    const result = await _deps.callLLM(prompt);
    logger.info("init", "Generated context.md with LLM");
    return result;
  } catch (err) {
    logger.warn(
      "init",
      `LLM context generation failed, falling back to template: ${err instanceof Error ? err.message : String(err)}`,
    );
    return generateContextTemplate(scan);
  }
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
 * Creates `.nax/packages/<packagePath>/context.md` under the repo root.
 * Does not overwrite an existing file unless force is set.
 *
 * @param repoRoot - Absolute path to repo root
 * @param packagePath - Relative path of the package (e.g. "packages/api")
 * @param force - Overwrite existing file
 */
export async function initPackage(repoRoot: string, packagePath: string, force = false): Promise<void> {
  const logger = getLogger();
  const naxDir = join(repoRoot, ".nax", "packages", packagePath);
  const contextPath = join(naxDir, "context.md");

  if (existsSync(contextPath) && !force) {
    logger.info("init", "Package context.md already exists (use --force to overwrite)", { path: contextPath });
    return;
  }

  if (!existsSync(naxDir)) {
    await mkdir(naxDir, { recursive: true });
  }

  const content = generatePackageContextTemplate(packagePath);
  await Bun.write(contextPath, content);
  logger.info("init", "Created package context.md", { path: contextPath });
}

/**
 * Initialize context.md for a project
 */
export async function initContext(projectRoot: string, options: InitContextOptions = {}): Promise<void> {
  const logger = getLogger();
  const naxDir = join(projectRoot, ".nax");
  const contextPath = join(naxDir, "context.md");

  // Check if context.md already exists
  if (existsSync(contextPath) && !options.force) {
    logger.info("init", "context.md already exists, skipping (use --force to overwrite)", { path: contextPath });
    return;
  }

  // Create nax directory if needed
  if (!existsSync(naxDir)) {
    await mkdir(naxDir, { recursive: true });
  }

  // Scan the project
  const scan = await scanProject(projectRoot);

  // Generate content (template or LLM-enhanced)
  let content: string;
  if (options.ai) {
    content = await generateContextWithLLM(scan);
  } else {
    content = generateContextTemplate(scan);
  }

  // Write context.md
  await Bun.write(contextPath, content);
  logger.info("init", "Generated .nax/context.md template from project scan", { path: contextPath });
}
