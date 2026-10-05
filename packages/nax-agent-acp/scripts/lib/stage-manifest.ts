/**
 * The generated manifest and staging inputs for `bun run stage-publish` (S4 spec §8).
 * Pure so the unit tests can pin it. nax-agent's own staging lib has the same shape;
 * a third publishing package is the point to lift the shared parts into repo-tooling.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const STAGE_INPUTS = [
  "dist/client/index.js",
  "dist/client/index.d.ts",
  "dist/server/index.js",
  "dist/server/index.d.ts",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
] as const;

export function missingStageInputs(pkgDir: string): string[] {
  const src = join(pkgDir, "src");
  const emitted = existsSync(src)
    ? readdirSync(src, { recursive: true, encoding: "utf8" })
        .filter((rel) => rel.endsWith(".ts") && !rel.endsWith(".d.ts") && statSync(join(src, rel)).isFile())
        .flatMap((rel) => [join("dist", rel.replace(/\.ts$/, ".js")), join("dist", rel.replace(/\.ts$/, ".d.ts"))])
    : [];
  return [...new Set([...STAGE_INPUTS, ...emitted])].filter(
    (rel) => !existsSync(join(pkgDir, rel)) || !statSync(join(pkgDir, rel)).isFile(),
  );
}

export function assertPublishRepo(githubRepository: string | undefined): void {
  if (githubRepository !== undefined && githubRepository !== "nathapp-io/nax") {
    throw new Error(`stage-publish: refusing to stage from ${githubRepository}; provenance requires nathapp-io/nax`);
  }
}

/**
 * Nothing is released before S4 acceptance (spec §10). Until S4-2 adds `acpBackend()`,
 * the built client entry is the bare `export {};` and staging refuses it. The maintainer's
 * S4-6 approval stays the real gate for S4-2 to S4-5.
 */
export function assertClientNotEmpty(clientDts: string): void {
  const exportLines = clientDts
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("export "));
  // Refused when there is no exported declaration at all, or when every export
  // is an empty-object export ("export {};" / "export { }"). tsc's emitted
  // scaffold carries a doc comment before `export {};`, so the comment is ignored.
  if (exportLines.every((line) => /^export\s*\{\s*};?$/.test(line))) {
    throw new Error(
      "stage-publish: ./client exports nothing yet; nax-agent-acp is not releasable before S4 acceptance",
    );
  }
}

/** R10: both packages share one version, so the peer range is a caret on it. */
export function peerRangeFor(naxAgentVersion: string, ownVersion: string): string {
  if (naxAgentVersion !== ownVersion) {
    throw new Error(
      `stage-publish: nax-agent ${naxAgentVersion} and nax-agent-acp ${ownVersion} must share one version (R10 lockstep)`,
    );
  }
  return `^${ownVersion}`;
}

type Json = Record<string, unknown>;

export interface StageManifestOptions {
  readonly repository: string;
  readonly directory: string;
  readonly naxAgentVersion: string;
}

const entry = (name: string) => ({ types: `./dist/${name}/index.d.ts`, import: `./dist/${name}/index.js` });

export function buildStagedManifest(source: Json, opts: StageManifestOptions): Json {
  const dependencies = (source.dependencies ?? {}) as Record<string, string>;
  const leaked = Object.entries(dependencies).filter(([, range]) => range.startsWith("workspace:"));
  if (leaked.length > 0) {
    throw new Error(`stage-publish: workspace: dependencies cannot ship: ${leaked.map(([name]) => name).join(", ")}`);
  }
  return {
    name: source.name,
    version: source.version,
    description: source.description,
    license: source.license,
    author: source.author,
    homepage: source.homepage,
    bugs: source.bugs,
    keywords: source.keywords,
    repository: { type: "git", url: opts.repository, directory: opts.directory },
    type: "module",
    exports: { "./client": entry("client"), "./server": entry("server") },
    imports: { "#src/*": { types: "./dist/*.d.ts", default: "./dist/*.js" } },
    engines: { node: ">=22.19.0" },
    dependencies,
    peerDependencies: { "@nathapp/nax-agent": peerRangeFor(opts.naxAgentVersion, String(source.version)) },
    publishConfig: {
      access: "public",
      registry: "https://registry.npmjs.org/",
      provenance: true,
      tag: "latest",
    },
  };
}
