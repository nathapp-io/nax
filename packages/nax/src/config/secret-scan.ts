import { join } from "node:path";
import { redactSecrets } from "@nathapp/nax-agent/internal";

export type ConfigSecretKind = "literal-header" | "secret-env" | "token-shape" | "unscannable";

export interface ConfigSecretFinding {
  readonly file: string;
  readonly pointer: string;
  readonly kind: ConfigSecretKind;
}

export interface ConfigSecretScan {
  readonly clean: boolean;
  readonly files: readonly string[];
  readonly findings: readonly ConfigSecretFinding[];
}

const ENV_REFERENCE = /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/g;
const SAFE_HEADERS = new Set(["content-type", "accept", "user-agent", "http-referer", "x-title"]);

/** Scan nax's root and package configs for literal secret-bearing values. */
export async function scanConfigSecrets(repoRoot: string): Promise<ConfigSecretScan> {
  const candidates = await configPaths(repoRoot);
  const files = candidates.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const findings: ConfigSecretFinding[] = [];
  for (const file of files) {
    const absolute = join(repoRoot, ...file.split("/"));
    try {
      const value: unknown = JSON.parse(await Bun.file(absolute).text());
      if (!isObject(value)) {
        findings.push({ file, pointer: "", kind: "unscannable" });
        continue;
      }
      scanValue(value, file, [], [], findings);
    } catch {
      findings.push({ file, pointer: "", kind: "unscannable" });
    }
  }
  return { clean: findings.length === 0, files, findings };
}

async function configPaths(repoRoot: string): Promise<string[]> {
  const paths: string[] = [];
  const rootConfig = join(repoRoot, ".nax", "config.json");
  if (await Bun.file(rootConfig).exists()) paths.push(".nax/config.json");
  const monoRoot = join(repoRoot, ".nax", "mono");
  try {
    for await (const path of new Bun.Glob("**/config.json").scan({ cwd: monoRoot, onlyFiles: true })) {
      if (path !== "config.json" && path.split(/[\\/]/).length >= 2) {
        paths.push(`.nax/mono/${path.split(/[\\/]/).join("/")}`);
      }
    }
  } catch {
    // A missing mono directory is an empty scan; unreadable individual files are
    // still included by the glob and reported as unscannable below.
  }
  return paths;
}

function scanValue(
  value: Record<string, unknown> | unknown[],
  file: string,
  segments: readonly string[],
  ancestors: readonly string[],
  findings: ConfigSecretFinding[],
): void {
  for (const [key, child] of Object.entries(value)) {
    const path = [...segments, key];
    if (typeof child === "string") {
      const kind = classifyString(child, key, ancestors);
      if (kind !== undefined) findings.push({ file, pointer: `/${path.map(escapePointer).join("/")}`, kind });
    } else if (isObject(child) || Array.isArray(child)) {
      scanValue(child, file, path, [...ancestors, key], findings);
    }
  }
}

function classifyString(value: string, key: string, ancestors: readonly string[]): ConfigSecretKind | undefined {
  const hasReference = ENV_REFERENCE.test(value);
  ENV_REFERENCE.lastIndex = 0;
  if (ancestors.includes("headers") && !SAFE_HEADERS.has(key.toLowerCase()) && !hasReference) {
    return "literal-header";
  }
  if (ancestors.includes("env") && !hasReference && redactSecrets({ [key]: value })[key] !== value) {
    return "secret-env";
  }
  const stripped = value.replace(ENV_REFERENCE, "");
  ENV_REFERENCE.lastIndex = 0;
  if (redactSecrets(stripped) !== stripped) return "token-shape";
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
