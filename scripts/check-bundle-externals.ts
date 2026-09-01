#!/usr/bin/env bun
/**
 * Gate: the bundle must keep `@nathapp/nax-ai` external.
 *
 * pi-ai loads each OAuth flow through a dynamic import built from a *variable*
 * specifier, deliberately, so that bundlers cannot follow it into Node-only
 * flow code. That resolution is relative to `import.meta.url`. Bundled, that
 * is `dist/nax.js` and the flow module is not beside it, so every OAuth login
 * from the bundle dies with:
 *
 *   Cannot find module './openai-codex.js' imported from dist/nax.js
 *
 * Keeping nax-ai external means it — and pi-ai beneath it — load as real
 * modules from node_modules, so `import.meta.url` is the actual file on disk
 * and the relative import resolves exactly as it does from source.
 *
 * This costs nothing here: `@nathapp/nax-ai` is a declared dependency and nax
 * ships via npm, so an installed nax always has it. It would only matter for a
 * standalone `bun build --compile` binary, which this repo does not produce.
 *
 * Dropping the flag looks like a harmless bundling win and silently breaks
 * OAuth login for every user of the published CLI, with no test failure — the
 * suite runs from source, where the bug cannot reproduce. Hence a gate.
 *
 * Usage:
 *   bun scripts/check-bundle-externals.ts
 *
 * Exit codes:
 *   0 — the build keeps nax-ai external
 *   1 — the flag is missing
 */
import { readFileSync } from "node:fs";

const REQUIRED = '--external "@nathapp/nax-ai"';

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts?: Record<string, string>;
};
const build = pkg.scripts?.build;

if (build === undefined) {
  console.error("check-bundle-externals: no build script found in package.json");
  process.exit(1);
}

if (!build.includes(REQUIRED)) {
  console.error(
    `check-bundle-externals: the build script must pass ${REQUIRED}.\n` +
      "Without it, pi-ai's OAuth flow modules cannot be resolved from the\n" +
      "bundle and `nax auth login <oauth-provider>` fails with\n" +
      "\"Cannot find module './<provider>.js'\". See the header of this script.\n" +
      `Found: ${build}`,
  );
  process.exit(1);
}

console.log("check-bundle-externals: nax-ai stays external");
