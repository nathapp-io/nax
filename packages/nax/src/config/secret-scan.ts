import { join } from "node:path";
import { redactSecrets } from "@nathapp/nax-agent/internal";

export type ConfigSecretKind = "literal-header" | "secret-env" | "secret-key" | "token-shape" | "unscannable";

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
/**
 * Key names that point at a secret rather than hold one (`apiKeyEnv`, `tokenFile`,
 * `credentialsPath`): the value is an env-var name or a path, so the key-aware check
 * skips them (token-shape still applies). A survey of this repo's JSON, ~/.nax profiles
 * and every project .nax/config.json found no real key needing this today; it keeps a
 * future pointer-style key from becoming a false positive.
 */
const POINTER_KEY_SUFFIX = /(?:Env|EnvVar|File|Path|_env|_file|_path)$/;
const KEY_PROBE_VALUE = "x";
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
  const stripped = value.replace(ENV_REFERENCE, "");
  ENV_REFERENCE.lastIndex = 0;
  const hasReference = stripped !== value;
  // Only a value that is nothing but references ("${VAR}", "$A$B") is exempt from the
  // literal checks; a literal next to a reference is still a literal secret.
  const onlyReferences = hasReference && stripped.trim() === "";
  const inHeaders = ancestors.includes("headers");
  if (inHeaders && !SAFE_HEADERS.has(key.toLowerCase()) && !hasReference) {
    return "literal-header";
  }
  // Header values keep the header rule above ("Bearer ${TOKEN}" under Authorization is fine).
  if (!inHeaders && !onlyReferences && !POINTER_KEY_SUFFIX.test(key)) {
    // Under env the whole pair is checked (a token-shaped value is a secret-env finding); elsewhere
    // only the key name is probed so a token-shaped value keeps its token-shape classification.
    if (ancestors.includes("env")) {
      if (redactSecrets({ [key]: value })[key] !== value) return "secret-env";
    } else if (redactSecrets({ [key]: KEY_PROBE_VALUE })[key] !== KEY_PROBE_VALUE) {
      return "secret-key";
    }
  }
  if (redactSecrets(stripped) !== stripped) return "token-shape";
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
