#!/usr/bin/env bun
/**
 * Builds `.publish/`, the exact directory `npm publish` ships (S4 spec §8).
 * The workspace manifest points at `.ts` sources and a `workspace:*` peer, so the
 * published manifest is generated here, with the peer range taken from nax-agent.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assertClientNotEmpty,
  assertPublishRepo,
  buildStagedManifest,
  missingStageInputs,
} from "./lib/stage-manifest.ts";

const PKG = resolve(import.meta.dir, "..");
const OUT = join(PKG, ".publish");
const REPOSITORY = "git+https://github.com/nathapp-io/nax.git";
const DIRECTORY = "packages/nax-agent-acp";

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function main(): void {
  const missing = missingStageInputs(PKG);
  if (missing.length > 0) {
    throw new Error(`stage-publish: missing ${missing.join(", ")}; run \`bun run build\` first`);
  }
  assertPublishRepo(process.env.GITHUB_REPOSITORY);
  const source = readJson(join(PKG, "package.json"));
  assertClientNotEmpty(readFileSync(join(PKG, "dist/client/index.d.ts"), "utf8"));
  const naxAgentVersion = String(readJson(join(PKG, "../nax-agent/package.json")).version);
  const manifest = buildStagedManifest(source, { repository: REPOSITORY, directory: DIRECTORY, naxAgentVersion });
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  cpSync(join(PKG, "dist"), join(OUT, "dist"), { recursive: true });
  cpSync(join(PKG, "bin"), join(OUT, "bin"), { recursive: true });
  for (const file of ["README.md", "CHANGELOG.md", "LICENSE"]) cpSync(join(PKG, file), join(OUT, file));
  writeFileSync(join(OUT, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`staged ${OUT}`);
}

main();
