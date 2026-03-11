/**
 * Config Display
 *
 * Format and display configuration with descriptions and explanations.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { findProjectDir, globalConfigPath } from "../config/loader";
import type { NaxConfig } from "../config/schema";
import { FIELD_DESCRIPTIONS } from "./config-descriptions";
import { deepDiffConfigs } from "./config-diff";
import { loadGlobalConfig, loadProjectConfig } from "./config-get";

export { FIELD_DESCRIPTIONS };

/** Options for config command */
export interface ConfigCommandOptions {
  /** Show field explanations */
  explain?: boolean;
  /** Show only fields where project overrides global */
  diff?: boolean;
}

/**
 * Display effective configuration with optional explanations.
 *
 * @param config - Loaded configuration
 * @param options - Command options
 */
export async function configCommand(config: NaxConfig, options: ConfigCommandOptions = {}): Promise<void> {
  const { explain = false, diff = false } = options;

  // Validate mutually exclusive flags
  if (explain && diff) {
    console.error("Error: --explain and --diff are mutually exclusive");
    process.exit(1);
  }

  // Determine sources
  const sources = determineConfigSources();

  if (diff) {
    // Diff mode: show only fields where project overrides global
    const projectConf = await loadProjectConfig();

    if (!projectConf) {
      console.log("No project config found — using global defaults");
      return;
    }

    const globalConf = await loadGlobalConfig();
    const diffs = deepDiffConfigs(globalConf, projectConf);

    if (diffs.length === 0) {
      console.log("No differences between project and global config");
      return;
    }

    console.log("# Config Differences (Project overrides Global)");
    console.log();
    console.log("─".repeat(80));
    console.log(`${"Field".padEnd(40)}${"Project Value".padEnd(20)}Global Value`);
    console.log("─".repeat(80));

    for (const diff of diffs) {
      const path = diff.path.padEnd(40);
      const projectVal = formatValueForTable(diff.projectValue);
      const globalVal = formatValueForTable(diff.globalValue);

      console.log(`${path}${projectVal.padEnd(20)}${globalVal}`);

      // Show description if available
      const description = FIELD_DESCRIPTIONS[diff.path];
      if (description) {
        console.log(`${"".padEnd(40)}↳ ${description}`);
      }
    }

    console.log("─".repeat(80));
  } else if (explain) {
    console.log("# nax Configuration");
    console.log("#");
    console.log("# Resolution order: defaults → global → project → CLI overrides");
    console.log(`# Global config: ${sources.global ? sources.global : "(not found)"}`);
    console.log(`# Project config: ${sources.project ? sources.project : "(not found)"}`);
    console.log();

    // Recursively display config with descriptions
    displayConfigWithDescriptions(config, [], sources);
  } else {
    // Default view: JSON with header showing config sources
    console.log("// nax Configuration");
    console.log("// Resolution order: defaults → global → project → CLI overrides");
    console.log(`// Global config: ${sources.global ? sources.global : "(not found)"}`);
    console.log(`// Project config: ${sources.project ? sources.project : "(not found)"}`);
    console.log();
    console.log(JSON.stringify(config, null, 2));
  }
}

/**
 * Determine which config files are present.
 *
 * @returns Paths to global and project config files (null if not found)
 */
function determineConfigSources(): { global: string | null; project: string | null } {
  const globalPath = globalConfigPath();
  const projectDir = findProjectDir();
  const projectPath = projectDir ? join(projectDir, "config.json") : null;

  return {
    global: fileExists(globalPath) ? globalPath : null,
    project: projectPath && fileExists(projectPath) ? projectPath : null,
  };
}

/**
 * Check if a file exists.
 *
 * @param path - File path to check
 * @returns True if file exists, false otherwise
 */
function fileExists(path: string): boolean {
  return existsSync(path);
}

/**
 * Display configuration with descriptions and source annotations.
 *
 * @param obj - Configuration object or value
 * @param path - Current path in config tree
 * @param sources - Config source paths
 * @param indent - Current indentation level
 */
function displayConfigWithDescriptions(
  obj: unknown,
  path: string[],
  sources: { global: string | null; project: string | null },
  indent = 0,
): void {
  const indentStr = "  ".repeat(indent);
  const pathStr = path.join(".");

  // Handle primitives and arrays
  if (obj === null || obj === undefined || typeof obj !== "object" || Array.isArray(obj)) {
    const description = FIELD_DESCRIPTIONS[pathStr];
    const value = formatValue(obj);

    if (description) {
      console.log(`${indentStr}# ${description}`);
    }

    const key = path[path.length - 1] || "";
    console.log(`${indentStr}${key}: ${value}`);
    console.log();
    return;
  }

  // Handle objects
  const entries = Object.entries(obj as Record<string, unknown>);

  // Special handling for prompts section: always show overrides documentation
  const objAsRecord = obj as Record<string, unknown>;
  const isPromptsSection = path.join(".") === "prompts";
  if (isPromptsSection && !objAsRecord.overrides) {
    // Add prompts.overrides documentation even if not in config
    const description = FIELD_DESCRIPTIONS["prompts.overrides"];
    if (description) {
      console.log(`${indentStr}# prompts.overrides: ${description}`);
    }

    // Show role examples
    const roles = ["test-writer", "implementer", "verifier", "single-session"];
    console.log(`${indentStr}overrides:`);
    for (const role of roles) {
      const roleDesc = FIELD_DESCRIPTIONS[`prompts.overrides.${role}`];
      if (roleDesc) {
        console.log(`${indentStr}  # ${roleDesc}`);
        // Extract the example path from description
        const match = roleDesc.match(/e\.g\., "([^"]+)"/);
        if (match) {
          console.log(`${indentStr}  # ${role}: "${match[1]}"`);
        }
      }
    }
    console.log();
    return;
  }

  for (let i = 0; i < entries.length; i++) {
    const [key, value] = entries[i];
    const currentPath = [...path, key];
    const currentPathStr = currentPath.join(".");
    const description = FIELD_DESCRIPTIONS[currentPathStr];

    // Display description comment if available
    if (description) {
      // Include path for direct subsections of key configuration sections
      // (to improve clarity of important configs like multi-agent setup)
      const pathParts = currentPathStr.split(".");
      // Only show path for 2-level paths (e.g., "autoMode.enabled", "models.fast")
      // to keep deeply nested descriptions concise
      const isDirectSubsection = pathParts.length === 2;
      const isKeySection = ["prompts", "autoMode", "models", "routing"].includes(pathParts[0]);
      const shouldIncludePath = isKeySection && isDirectSubsection;
      const comment = shouldIncludePath ? `${currentPathStr}: ${description}` : description;
      console.log(`${indentStr}# ${comment}`);
    }

    // Handle nested objects
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      console.log(`${indentStr}${key}:`);
      displayConfigWithDescriptions(value, currentPath, sources, indent + 1);
    } else {
      // Display value
      const formattedValue = formatValue(value);
      console.log(`${indentStr}${key}: ${formattedValue}`);

      // Add blank line after each top-level section
      if (indent === 0 && i < entries.length - 1) {
        console.log();
      }
    }
  }
}

/**
 * Format a config value for display.
 *
 * @param value - Value to format
 * @returns Formatted string
 */
function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.length <= 3) {
      return `[${value.map((v) => formatValue(v)).join(", ")}]`;
    }
    return `[${value
      .slice(0, 3)
      .map((v) => formatValue(v))
      .join(", ")}, ... (${value.length} items)]`;
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Format a config value for table display (shorter format).
 *
 * @param value - Value to format
 * @returns Formatted string (max ~18 chars)
 */
function formatValueForTable(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    if (value.length > 15) {
      return `"${value.slice(0, 12)}..."`;
    }
    return `"${value}"`;
  }
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[...${value.length}]`;
  }
  if (typeof value === "object") {
    const str = JSON.stringify(value);
    if (str.length > 15) {
      return "{...}";
    }
    return str;
  }
  return String(value);
}
