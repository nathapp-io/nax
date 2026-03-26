/**
 * Precheck Tier 2 Warnings
 *
 * Extracted from checks.ts: individual check implementations for Tier 2 warnings.
 * These checks produce warnings but do not block execution.
 */

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { NaxConfig } from "../config";
import type { ProjectProfile } from "../config/runtime-types";
import type { PRD } from "../prd/types";
import type { Check } from "./types";

/** Injectable Bun.which for testability */
export const _languageToolsDeps = {
  which: (name: string): Promise<string | null> => {
    // Bun.which is synchronous, so we wrap it to match test expectations
    const result = Bun.which(name);
    return Promise.resolve(result);
  },
};

/**
 * Check if CLAUDE.md exists.
 */
export async function checkClaudeMdExists(workdir: string): Promise<Check> {
  const claudeMdPath = `${workdir}/CLAUDE.md`;
  const passed = existsSync(claudeMdPath);

  return {
    name: "claude-md-exists",
    tier: "warning",
    passed,
    message: passed ? "CLAUDE.md found" : "CLAUDE.md not found (recommended for project context)",
  };
}

/**
 * Check if disk space is above 1GB.
 */
export async function checkDiskSpace(): Promise<Check> {
  const proc = Bun.spawn(["df", "-k", "."], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    return {
      name: "disk-space-sufficient",
      tier: "warning",
      passed: false,
      message: "Unable to check disk space",
    };
  }

  // Parse df output (second line, fourth column is available space in KB)
  const lines = output.trim().split("\n");
  if (lines.length < 2) {
    return {
      name: "disk-space-sufficient",
      tier: "warning",
      passed: false,
      message: "Unable to parse disk space output",
    };
  }

  const parts = lines[1].split(/\s+/);
  const availableKB = Number.parseInt(parts[3], 10);
  const availableGB = availableKB / 1024 / 1024;
  const passed = availableGB >= 1;

  return {
    name: "disk-space-sufficient",
    tier: "warning",
    passed,
    message: passed
      ? `Disk space: ${availableGB.toFixed(2)}GB available`
      : `Low disk space: ${availableGB.toFixed(2)}GB available`,
  };
}

/**
 * Check if PRD has pending stories.
 */
export async function checkPendingStories(prd: PRD): Promise<Check> {
  const pendingStories = prd.userStories.filter((s) => s.status === "pending");
  const passed = pendingStories.length > 0;

  return {
    name: "has-pending-stories",
    tier: "warning",
    passed,
    message: passed ? `${pendingStories.length} pending stories found` : "no pending stories to execute",
  };
}

/**
 * Check if optional commands are configured.
 */
export async function checkOptionalCommands(config: NaxConfig, workdir: string): Promise<Check> {
  const missing: string[] = [];

  // Check quality.commands first, then execution config, then package.json fallback
  const hasLint =
    config.quality?.commands?.lint || config.execution?.lintCommand || (await hasPackageScript(workdir, "lint"));
  const hasTypecheck =
    config.quality?.commands?.typecheck ||
    config.execution?.typecheckCommand ||
    (await hasPackageScript(workdir, "typecheck"));

  if (!hasLint) missing.push("lint");
  if (!hasTypecheck) missing.push("typecheck");

  const passed = missing.length === 0;

  return {
    name: "optional-commands-configured",
    tier: "warning",
    passed,
    message: passed ? "All optional commands configured" : `Optional commands not configured: ${missing.join(", ")}`,
  };
}

/** Check if package.json has a script by name */
async function hasPackageScript(workdir: string, name: string): Promise<boolean> {
  try {
    const pkg = await Bun.file(`${workdir}/package.json`).json();
    return Boolean(pkg?.scripts?.[name]);
  } catch {
    return false;
  }
}

/**
 * Check if .gitignore covers nax runtime files.
 * Patterns: nax.lock, runs/, status.json, .nax-pids, .nax-wt/
 */
export async function checkGitignoreCoversNax(workdir: string): Promise<Check> {
  const gitignorePath = `${workdir}/.gitignore`;
  const exists = existsSync(gitignorePath);

  if (!exists) {
    return {
      name: "gitignore-covers-nax",
      tier: "warning",
      passed: false,
      message: ".gitignore not found",
    };
  }

  const file = Bun.file(gitignorePath);
  const content = await file.text();
  const patterns = [
    "nax.lock",
    ".nax/**/runs/",
    ".nax/metrics.json",
    ".nax/features/*/status.json",
    ".nax-pids",
    ".nax-wt/",
  ];
  const missing = patterns.filter((pattern) => !content.includes(pattern));
  const passed = missing.length === 0;

  return {
    name: "gitignore-covers-nax",
    tier: "warning",
    passed,
    message: passed ? ".gitignore covers nax runtime files" : `.gitignore missing patterns: ${missing.join(", ")}`,
  };
}

/**
 * Check if configured prompt override files exist.
 *
 * For each role in config.prompts.overrides, verify the file exists.
 * Emits one warning per missing file (non-blocking).
 * Returns empty array if config.prompts is absent or overrides is empty.
 *
 * @param config - nax configuration
 * @param workdir - working directory for resolving relative paths
 * @returns Array of warning checks (one per missing file)
 */
export async function checkPromptOverrideFiles(config: NaxConfig, workdir: string): Promise<Check[]> {
  // Skip if prompts config is absent or overrides is empty
  if (!config.prompts?.overrides || Object.keys(config.prompts.overrides).length === 0) {
    return [];
  }

  const checks: Check[] = [];

  // Check each override file
  for (const [role, relativePath] of Object.entries(config.prompts.overrides)) {
    const resolvedPath = `${workdir}/${relativePath}`;
    const exists = existsSync(resolvedPath);

    if (!exists) {
      checks.push({
        name: `prompt-override-${role}`,
        tier: "warning",
        passed: false,
        message: `Prompt override file not found for role ${role}: ${resolvedPath}`,
      });
    }
  }

  return checks;
}

/**
 * Check if HOME env is set and is an absolute path.
 * An unexpanded "~" in HOME causes agent spawns to create a literal ~/
 * directory inside the repo cwd instead of resolving to the user home dir.
 */
export async function checkHomeEnvValid(): Promise<Check> {
  const home = process.env.HOME ?? "";
  const passed = home !== "" && isAbsolute(home);
  return {
    name: "home-env-valid",
    tier: "warning",
    passed,
    message: passed
      ? `HOME env is valid: ${home}`
      : home === ""
        ? "HOME env is not set — agent may write files to unexpected locations"
        : `HOME env is not an absolute path ("${home}") — may cause literal "~" directories in repo`,
  };
}

/**
 * Tool configuration for a language
 */
type ToolConfig =
  | {
      type: "standard" | "python" | "java";
      required: string[];
      installHint: string;
      pythonBinaries?: never;
      buildTools?: never;
    }
  | {
      type: "python";
      required: string[];
      installHint: string;
      pythonBinaries: string[];
      buildTools?: never;
    }
  | {
      type: "java";
      required: string[];
      installHint: string;
      buildTools: string[];
      pythonBinaries?: never;
    };

/**
 * Check if language-specific tool binaries are available in PATH.
 * Returns a warning (non-blocking) when tools required for the detected
 * language are missing. When profile is undefined or language is unsupported,
 * returns passed: true (no warning).
 *
 * Language→tools mapping:
 * - go: [go, golangci-lint]
 * - rust: [cargo, rustfmt]
 * - python: [python3 or python, pytest, ruff]
 * - ruby: [ruby, rubocop]
 * - java: [java, mvn or gradle]
 */
export async function checkLanguageTools(profile: ProjectProfile | undefined, workdir: string): Promise<Check> {
  // Skip check if no profile or language not set
  if (!profile || !profile.language) {
    return {
      name: "language-tools-available",
      tier: "warning",
      passed: true,
      message: "No language specified in profile",
    };
  }

  const { language } = profile;

  // Define required tools per language
  const toolsByLanguage: Record<string, ToolConfig> = {
    go: {
      type: "standard",
      required: ["go", "golangci-lint"],
      installHint:
        "Install Go: https://golang.org/doc/install (brew install go && go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest)",
    },
    rust: {
      type: "standard",
      required: ["cargo", "rustfmt"],
      installHint: "Install Rust: https://rustup.rs/ (curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh)",
    },
    python: {
      type: "python",
      required: ["pytest", "ruff"],
      pythonBinaries: ["python3", "python"],
      installHint:
        "Install Python 3: https://www.python.org/downloads/ (brew install python3 && pip install pytest ruff)",
    },
    ruby: {
      type: "standard",
      required: ["ruby", "rubocop"],
      installHint: "Install Ruby: https://www.ruby-lang.org/en/downloads/ (brew install ruby && gem install rubocop)",
    },
    java: {
      type: "java",
      required: ["java"],
      buildTools: ["mvn", "gradle"],
      installHint:
        "Install Java: https://www.oracle.com/java/technologies/downloads/ (brew install openjdk && brew install maven)",
    },
  };

  // Check if language is supported
  const toolConfig = toolsByLanguage[language];
  if (!toolConfig) {
    return {
      name: "language-tools-available",
      tier: "warning",
      passed: true,
      message: `Language '${language}' not checked (language not checked for tool availability)`,
    };
  }

  const missing: string[] = [];

  // Check for Python binary (python3 or python)
  if (toolConfig.type === "python" && toolConfig.pythonBinaries) {
    const pythonFound = await Promise.all(toolConfig.pythonBinaries.map((bin) => _languageToolsDeps.which(bin))).then(
      (results) => results.some((r) => r !== null),
    );

    if (!pythonFound) {
      missing.push("python3 or python");
    }

    // Check other required tools (pytest, ruff)
    const otherTools = toolConfig.required.filter((t) => !toolConfig.pythonBinaries.includes(t));
    for (const tool of otherTools) {
      const found = await _languageToolsDeps.which(tool);
      if (!found) {
        missing.push(tool);
      }
    }
  } else if (toolConfig.type === "java" && toolConfig.buildTools) {
    // Java case: check java + (mvn or gradle)
    for (const tool of toolConfig.required) {
      const found = await _languageToolsDeps.which(tool);
      if (!found) {
        missing.push(tool);
      }
    }

    const buildToolFound = await Promise.all(toolConfig.buildTools.map((bin) => _languageToolsDeps.which(bin))).then(
      (results) => results.some((r) => r !== null),
    );

    if (!buildToolFound) {
      missing.push(`${toolConfig.buildTools.join(" or ")}`);
    }
  } else {
    // Standard check: all required tools must be present
    for (const tool of toolConfig.required) {
      const found = await _languageToolsDeps.which(tool);
      if (!found) {
        missing.push(tool);
      }
    }
  }

  if (missing.length === 0) {
    return {
      name: "language-tools-available",
      tier: "warning",
      passed: true,
      message: `${language} tools available (${toolConfig.required.join(", ")})`,
    };
  }

  return {
    name: "language-tools-available",
    tier: "warning",
    passed: false,
    message: `Missing ${language} tools: ${missing.join(", ")}. ${toolConfig.installHint}`,
  };
}
