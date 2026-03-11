/**
 * Prompts Init Command
 *
 * Initialize nax template files for prompt overrides.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildRoleTaskSection } from "../prompts/sections/role-task";

export interface PromptsInitCommandOptions {
  /** Working directory (project root) */
  workdir: string;
  /** Overwrite existing files if true */
  force?: boolean;
  /** Auto-wire prompts.overrides in nax.config.json (default: true) */
  autoWireConfig?: boolean;
}

const TEMPLATE_ROLES = [
  { file: "test-writer.md", role: "test-writer" as const },
  { file: "implementer.md", role: "implementer" as const, variant: "standard" as const },
  { file: "verifier.md", role: "verifier" as const },
  { file: "single-session.md", role: "single-session" as const },
  { file: "tdd-simple.md", role: "tdd-simple" as const },
] as const;

const TEMPLATE_HEADER = `<!--
  This file controls the role-body section of the nax prompt for this role.
  Edit the content below to customize the task instructions given to the agent.

  NON-OVERRIDABLE SECTIONS (always injected by nax, cannot be changed here):
    - Isolation rules (scope, file access boundaries)
    - Story context (acceptance criteria, description, dependencies)
    - Conventions (project coding standards)

  To activate overrides, add to your nax/config.json:
    { "prompts": { "overrides": { "<role>": "nax/templates/<role>.md" } } }
-->

`;

/**
 * Execute the `nax prompts --init` command.
 *
 * Creates nax/templates/ and writes 5 default role-body template files
 * (test-writer, implementer, verifier, single-session, tdd-simple).
 * Auto-wires prompts.overrides in nax.config.json if the file exists and overrides are not already set.
 * Returns the list of file paths written. Returns empty array if files
 * already exist and force is not set.
 *
 * @param options - Command options
 * @returns Array of file paths written
 */
export async function promptsInitCommand(options: PromptsInitCommandOptions): Promise<string[]> {
  const { workdir, force = false, autoWireConfig = true } = options;
  const templatesDir = join(workdir, "nax", "templates");

  mkdirSync(templatesDir, { recursive: true });

  // Check for existing files
  const existingFiles = TEMPLATE_ROLES.map((t) => t.file).filter((f) => existsSync(join(templatesDir, f)));

  if (existingFiles.length > 0 && !force) {
    console.warn(
      `[WARN] nax/templates/ already contains files: ${existingFiles.join(", ")}. No files overwritten.\n       Pass --force to overwrite existing templates.`,
    );
    return [];
  }

  const written: string[] = [];

  for (const template of TEMPLATE_ROLES) {
    const filePath = join(templatesDir, template.file);
    const roleBody =
      template.role === "implementer"
        ? buildRoleTaskSection(template.role, template.variant)
        : buildRoleTaskSection(template.role);
    const content = TEMPLATE_HEADER + roleBody;
    await Bun.write(filePath, content);
    written.push(filePath);
  }

  console.log(`[OK] Written ${written.length} template files to nax/templates/:`);
  for (const filePath of written) {
    console.log(`  - ${filePath.replace(`${workdir}/`, "")}`);
  }

  // Auto-wire prompts.overrides in nax.config.json (if enabled)
  if (autoWireConfig) {
    await autoWirePromptsConfig(workdir);
  }

  return written;
}

/**
 * Auto-wire prompts.overrides in nax.config.json after template init.
 *
 * If nax.config.json exists and prompts.overrides is not already set,
 * add the override paths. If overrides are already set, print a note.
 * If nax.config.json doesn't exist, print manual instructions.
 *
 * @param workdir - Project working directory
 */
async function autoWirePromptsConfig(workdir: string): Promise<void> {
  const configPath = join(workdir, "nax.config.json");

  // If config file doesn't exist, print manual instructions
  if (!existsSync(configPath)) {
    const exampleConfig = JSON.stringify(
      {
        prompts: {
          overrides: {
            "test-writer": "nax/templates/test-writer.md",
            implementer: "nax/templates/implementer.md",
            verifier: "nax/templates/verifier.md",
            "single-session": "nax/templates/single-session.md",
            "tdd-simple": "nax/templates/tdd-simple.md",
          },
        },
      },
      null,
      2,
    );
    console.log(`\nNo nax.config.json found. To activate overrides, create nax/config.json with:\n${exampleConfig}`);
    return;
  }

  // Read existing config
  const configFile = Bun.file(configPath);
  const configContent = await configFile.text();
  const config = JSON.parse(configContent);

  // Check if prompts.overrides is already set
  if (config.prompts?.overrides && Object.keys(config.prompts.overrides).length > 0) {
    console.log(
      "[INFO] prompts.overrides already configured in nax.config.json. Skipping auto-wiring.\n" +
        "       To reset overrides, remove the prompts.overrides section and re-run this command.",
    );
    return;
  }

  // Build the override paths
  const overrides = {
    "test-writer": "nax/templates/test-writer.md",
    implementer: "nax/templates/implementer.md",
    verifier: "nax/templates/verifier.md",
    "single-session": "nax/templates/single-session.md",
    "tdd-simple": "nax/templates/tdd-simple.md",
  };

  // Add or update prompts section
  if (!config.prompts) {
    config.prompts = {};
  }
  config.prompts.overrides = overrides;

  // Write config with custom formatting that avoids 4-space indentation
  // by putting the overrides object on a single line
  const updatedConfig = formatConfigJson(config);
  await Bun.write(configPath, updatedConfig);

  console.log("[OK] Auto-wired prompts.overrides in nax.config.json");
}

/**
 * Format config JSON with 2-space indentation, keeping overrides object inline.
 *
 * This avoids 4-space indentation by putting the overrides object on the same line.
 *
 * @param config - Configuration object
 * @returns Formatted JSON string
 */
function formatConfigJson(config: Record<string, unknown>): string {
  const lines: string[] = ["{"];

  const keys = Object.keys(config);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = config[key];
    const isLast = i === keys.length - 1;

    if (key === "prompts" && typeof value === "object" && value !== null) {
      // Special handling for prompts object - keep overrides inline
      const promptsObj = value as Record<string, unknown>;
      if (promptsObj.overrides) {
        const overridesJson = JSON.stringify(promptsObj.overrides);
        lines.push(`  "${key}": { "overrides": ${overridesJson} }${isLast ? "" : ","}`);
      } else {
        lines.push(`  "${key}": ${JSON.stringify(value)}${isLast ? "" : ","}`);
      }
    } else {
      lines.push(`  "${key}": ${JSON.stringify(value)}${isLast ? "" : ","}`);
    }
  }

  lines.push("}");
  return lines.join("\n");
}
