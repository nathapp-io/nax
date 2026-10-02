/**
 * packages/nax-agent's own files (S1 spec section 4.1), derived from
 * packages/nax's where they must agree: dependency versions and the Biome rule
 * set. Returns path (relative to packages/nax-agent) -> content.
 */

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

interface BiomeOverride {
  includes?: string[];
  plugins?: string[];
  [key: string]: unknown;
}

interface BiomeConfig {
  plugins?: string[];
  overrides?: BiomeOverride[];
  [key: string]: unknown;
}

const RUNTIME_DEPS = ["@anthropic-ai/sandbox-runtime", "@nathapp/nax-ai", "zod"] as const;
const DEV_DEPS = ["@biomejs/biome", "@types/bun", "bun-types", "typescript"] as const;

/** Gates that guard moved code, run from nax's scripts against this package (spec section 7). */
const LINT_CHECKS = [
  "bun ../nax/scripts/check-nax-error.ts --package=.",
  "bun ../nax/scripts/check-file-sizes.ts --package=.",
  "bun ../nax/scripts/check-complexity.ts --package=.",
  "bun ../nax/scripts/check-import-cycles.ts --package=.",
  "bun ../nax/scripts/check-test-as-unknown-as.ts --package=.",
  "bun ../nax/scripts/check-test-escape-hatches.ts --package=.",
  "bun ../nax/scripts/check-no-control-bytes.ts",
  "bun ../nax/scripts/check-no-real-global-nax.ts",
  "bun ../nax/scripts/check-permission-mode-ssot.ts",
  "bun ../nax/scripts/check-feature-dir-ssot.ts",
  "bun ../nax/scripts/check-package-frame-derivation.ts",
  "bun ../nax/scripts/check-git-spawn-env.ts .",
  "bun ../nax/scripts/check-sandbox-imports.ts .",
  "bun ../nax/scripts/check-nax-ai-imports.ts .",
];

function pick(source: Record<string, string> | undefined, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const version = source?.[name];
    if (version === undefined) throw new Error(`packages/nax/package.json declares no version for ${name}`);
    out[name] = version;
  }
  return out;
}

export function agentPackageJson(nax: PackageJson): string {
  const pkg = {
    name: "@nathapp/nax-agent",
    version: "0.0.0",
    private: true,
    description:
      "nax's native coding agent: session contract, native loop, tools, permissions, sandbox, command-safety.",
    type: "module",
    exports: {
      ".": "./src/index.ts",
      "./internal": "./src/internal.ts",
      "./test/helpers/*": "./test/helpers/*.ts",
    },
    imports: { "#src/*": "./src/*.ts", "#test/*": "./test/*.ts" },
    scripts: {
      typecheck: "bun x tsc --noEmit",
      lint: "bun run lint:biome && bun run lint:checks",
      "lint:biome": "bun x biome check --error-on-warnings --diagnostic-level=warn src/ test/",
      "lint:fix": "bun x biome check --write src/ test/",
      "lint:checks": LINT_CHECKS.join(" && "),
      test: "bun test ./test/unit/ --timeout=60000 && bun test ./test/integration/ --timeout=60000",
      "check:all": "bun run --silent lint",
    },
    dependencies: pick(nax.dependencies, RUNTIME_DEPS),
    devDependencies: pick(nax.devDependencies, DEV_DEPS),
    license: "MIT",
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

const REMAPPED_PLUGIN_DIR = "../nax/biome-plugins/";

function remapPlugins(plugins: string[] | undefined): string[] | undefined {
  return plugins?.map((p) => p.replace(/^\.\/biome-plugins\//, REMAPPED_PLUGIN_DIR));
}

function agentOverride(override: BiomeOverride): BiomeOverride | null {
  const includes = override.includes ?? [];
  if (includes.includes("bin/**")) return null; // nax's noConsole carve-outs: no such paths here
  const scoped = includes[0] === "src/**" ? ["src/**"] : includes; // nax's src exclusions name nax dirs
  return { ...override, includes: scoped, plugins: remapPlugins(override.plugins) };
}

/** nax's rule set, with plugin paths pointing at nax's .grit files and nax-only overrides dropped. */
export function agentBiomeJson(nax: BiomeConfig): string {
  const overrides = (nax.overrides ?? []).map(agentOverride).filter((o): o is BiomeOverride => o !== null);
  const config = { ...nax, plugins: remapPlugins(nax.plugins), overrides };
  return `${JSON.stringify(config, null, 2)}\n`;
}

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext"],
    "types": ["bun-types"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"],
  "exclude": ["node_modules"]
}
`;

const BUNFIG = `# Bun test configuration for nax-agent (mirrors packages/nax/bunfig.toml).

[test]
smol = true
root = "./test"
timeout = 5000
preload = ["./test/preload.ts"]
`;

const PRELOAD = `/**
 * Bun test preload for nax-agent: runs once before any test file.
 *
 * The parts of packages/nax/test/preload.ts the moved tests rely on: global state
 * redirected to a temp directory, the credentials slot filled the way nax's CLI
 * fills it, provider keys scrubbed from the environment, console silenced, and a
 * sentinel on the native client builder so no test caches a real nax-ai client.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CredentialAuthConfig, configureCredentials } from "#src/infra/index";
import { _clientDeps } from "#src/native/client";

const isolatedGlobalDir = mkdtempSync(join(tmpdir(), "nax-agent-test-global-"));
process.env.NAX_GLOBAL_CONFIG_DIR = isolatedGlobalDir;
delete process.env.NAX_RUNS_DIR;

const configDir = (): string => process.env.NAX_GLOBAL_CONFIG_DIR || isolatedGlobalDir;

/** nax's global auth section with its schema defaults (packages/nax/src/config/schemas-auth.ts). */
async function readAuthConfig(): Promise<CredentialAuthConfig> {
  const file = Bun.file(join(configDir(), "config.json"));
  const config: { auth?: Partial<CredentialAuthConfig> } = (await file.exists()) ? await file.json() : {};
  const auth = config.auth ?? {};
  const exec = auth.exec === undefined ? undefined : { ...auth.exec, timeoutMs: auth.exec.timeoutMs ?? 10_000 };
  return { source: auth.source ?? "file", onChange: auth.onChange ?? "warn", ...(exec === undefined ? {} : { exec }) };
}

configureCredentials({ configDir, readAuthConfig });

for (const key of Object.keys(process.env)) {
  if (/_API_KEY$/.test(key)) delete process.env[key];
}

console.log = () => {};
console.warn = () => {};
console.error = () => {};

_clientDeps.build = () => {
  throw new Error(
    "[test-preload] _clientDeps.build called without a mock: it would build a real nax-ai client " +
      "and cache it for the rest of the process. Mock it in your describe block and call _resetNativeClient() after.",
  );
};
`;

const GITIGNORE = "coverage/\ntest/tmp/\nnode_modules/\n";
const NAXIGNORE = "# nax - scanning exclusions\ncoverage/\nnode_modules/\n";

export function scaffoldFiles(nax: PackageJson, naxBiome: BiomeConfig): Map<string, string> {
  return new Map([
    ["package.json", agentPackageJson(nax)],
    ["biome.json", agentBiomeJson(naxBiome)],
    ["tsconfig.json", TSCONFIG],
    ["bunfig.toml", BUNFIG],
    ["test/preload.ts", PRELOAD],
    [".gitignore", GITIGNORE],
    [".naxignore", NAXIGNORE],
  ]);
}

/** nax's package.json with the workspace devDependency (spec section 4.1: never under dependencies). */
export function withAgentDevDependency(naxPackageJsonText: string): string {
  const pkg = JSON.parse(naxPackageJsonText) as PackageJson;
  const devDependencies = { ...pkg.devDependencies, "@nathapp/nax-agent": "workspace:*" };
  return `${JSON.stringify({ ...pkg, devDependencies }, null, 2)}\n`;
}
