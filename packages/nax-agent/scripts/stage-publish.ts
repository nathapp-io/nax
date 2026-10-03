#!/usr/bin/env bun
/**
 * Builds `.publish/`, the exact directory `npm publish` ships (S2 spec §5.2).
 * The workspace manifest points at `.ts` sources (R6), so the published
 * manifest is generated here instead.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertPublishRepo, buildStagedManifest, missingStageInputs } from "./lib/stage-manifest.ts";

const PKG = resolve(import.meta.dir, "..");
const OUT = join(PKG, ".publish");
const REPOSITORY = "git+https://github.com/nathapp-io/nax.git";
const DIRECTORY = "packages/nax-agent";

function main(): void {
  const missing = missingStageInputs(PKG);
  if (missing.length > 0) {
    throw new Error(`stage-publish: missing ${missing.join(", ")} — run \`bun run build\` first`);
  }
  assertPublishRepo(process.env.GITHUB_REPOSITORY);
  const source = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as Record<string, unknown>;
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  cpSync(join(PKG, "dist"), join(OUT, "dist"), { recursive: true });
  for (const file of ["README.md", "CHANGELOG.md", "LICENSE"]) cpSync(join(PKG, file), join(OUT, file));
  const manifest = buildStagedManifest(source, { repository: REPOSITORY, directory: DIRECTORY });
  writeFileSync(join(OUT, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`staged ${OUT}`);
}

main();
