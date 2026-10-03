/**
 * The generated manifest and staging inputs for `bun run stage-publish`
 * (S2 spec §5.2). Pure so the pack smoke and the unit tests can pin it.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export const STAGE_INPUTS = ["dist/index.js", "dist/internal.js", "README.md", "CHANGELOG.md", "LICENSE"] as const;

export function missingStageInputs(pkgDir: string): string[] {
  return STAGE_INPUTS.filter((rel) => !existsSync(join(pkgDir, rel)));
}

export function assertPublishRepo(githubRepository: string | undefined): void {
  if (githubRepository !== undefined && githubRepository !== "nathapp-io/nax") {
    throw new Error(`stage-publish: refusing to stage from ${githubRepository}; provenance requires nathapp-io/nax`);
  }
}

type Json = Record<string, unknown>;

export interface StageManifestOptions {
  readonly repository: string;
  readonly directory: string;
}

export function buildStagedManifest(source: Json, opts: StageManifestOptions): Json {
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
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./internal": { types: "./dist/internal.d.ts", import: "./dist/internal.js" },
    },
    imports: { "#src/*": { types: "./dist/*.d.ts", default: "./dist/*.js" } },
    engines: { node: ">=22.19.0" },
    dependencies: source.dependencies,
    publishConfig: {
      access: "public",
      registry: "https://registry.npmjs.org/",
      provenance: true,
      tag: "latest",
    },
  };
}
