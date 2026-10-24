// Pure policies for canonical, repo-relative Git paths (forward-slash separated).

/** Root-anchored agent-config paths; each entry also covers its descendants. */
export const BASE_PINNED_PATHS = [
  ".nax/rules",
  ".claude",
  ".cursor",
  ".mcp.json",
  ".github/copilot-instructions.md",
  ".opencode",
  "opencode.json",
  ".gemini",
  ".codex",
  ".pi",
  ".aider.conf.yml",
  ".windsurfrules",
] as const;

/** Exact agent-instruction basenames pinned at any repository depth. */
export const BASE_PINNED_NAMES = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "codex.md",
  ".cursorrules",
  "AGENTS.override.md",
  "CLAUDE.local.md",
] as const;

/** Agent configuration: root paths and their descendants, or exact basenames at any depth. */
export function isPinnedPath(file: string): boolean {
  return (
    BASE_PINNED_PATHS.some((path) => file === path || file.startsWith(`${path}/`)) ||
    BASE_PINNED_NAMES.some((name) => fileName(file) === name)
  );
}
const CONTROL_DIRECTORIES = [".nax/", ".github/", ".gitlab/"];
const SENSITIVE_NAMES = new Set(["package.json", ".npmrc", "bunfig.toml"]);

function isControlPath(file: string): boolean {
  return file === ".gitlab-ci.yml" || CONTROL_DIRECTORIES.some((prefix) => file.startsWith(prefix));
}

function fileName(file: string): string {
  return file.slice(file.lastIndexOf("/") + 1);
}

function isAgentConfigOrHookPath(file: string): boolean {
  return isPinnedPath(file) || file.startsWith(".husky/");
}

/** Files the review summary should flag, preserving input order and spelling. */
export function sensitivePaths(files: readonly string[]): string[] {
  return files.filter(
    (file) => isControlPath(file) || isAgentConfigOrHookPath(file) || SENSITIVE_NAMES.has(fileName(file)),
  );
}

/** Files a fix must never change; manifests alone are deliberately not protected. */
export function fixProtectedPaths(files: readonly string[]): string[] {
  return files.filter((file) => {
    const name = fileName(file);
    return (
      isControlPath(file) ||
      isAgentConfigOrHookPath(file) ||
      name === ".env" ||
      name.startsWith(".env.") ||
      name === ".npmrc" ||
      name.endsWith(".pem") ||
      name.endsWith(".key") ||
      name.startsWith("id_rsa")
    );
  });
}
