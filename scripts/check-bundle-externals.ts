#!/usr/bin/env bun
/**
 * Gate: the two build-time resolution invariants the published bundle depends on.
 *
 * Both are the same class of trap -- a packaging decision whose breakage shows up
 * only in `dist/nax.js`, never in the test suite, because the suite runs from
 * source where neither bug can reproduce.
 *
 * 1. `@nathapp/nax-ai` must stay `--external`.
 *
 *    pi-ai loads each OAuth flow through a dynamic import built from a *variable*
 *    specifier, deliberately, so that bundlers cannot follow it into Node-only
 *    flow code. That resolution is relative to `import.meta.url`. Bundled, that
 *    is `dist/nax.js` and the flow module is not beside it, so every OAuth login
 *    from the bundle dies with:
 *
 *      Cannot find module './openai-codex.js' imported from dist/nax.js
 *
 *    Keeping nax-ai external means it -- and pi-ai beneath it -- load as real
 *    modules from node_modules, so `import.meta.url` is the actual file on disk
 *    and the relative import resolves exactly as it does from source.
 *
 * 2. `react-devtools-core` must resolve to the in-repo stub, and must never be
 *    the real package.
 *
 *    ink declares it an *optional* peer, so it is not installed by default. But
 *    `ink/build/reconciler.js` reaches it via `await import('./devtools.js')` --
 *    a static specifier -- and `devtools.js` imports it at module scope. Three
 *    outcomes, only one of which works:
 *
 *      - absent            -> `bun run build` fails outright with
 *                             `Could not resolve: "react-devtools-core"`.
 *                             This is what broke the v0.82.0-canary.8 release,
 *                             after nax#1976 dropped the package.
 *      - `--external`      -> builds, then every `nax` invocation dies at load:
 *                             the module *body* stays lazy behind
 *                             `process.env.DEV === 'true'`, but bun hoists the
 *                             import *binding* to a top-level ESM import.
 *      - local stub        -> builds, loads, and carries no devtools payload.
 *
 *    Reinstalling the real package is not an option: every published version
 *    through 8.0.0 depends on `ws@^7` and `shell-quote@^1.6.1`, which is exactly
 *    the critical + high advisory pair nax#1976 removed it to escape. A future
 *    dependency tidy-up that deletes the stub entry as "unused" reproduces the
 *    canary.8 failure -- `rg react-devtools-core` finds no source reference,
 *    because the consumer is inside node_modules. Hence this gate.
 *
 * Usage:
 *   bun scripts/check-bundle-externals.ts
 *
 * Exit codes:
 *   0 -- both invariants hold
 *   1 -- one of them is broken
 */
import { existsSync, readFileSync } from "node:fs";

const REQUIRED_EXTERNAL = '--external "@nathapp/nax-ai"';
const STUB_SPECIFIER = "file:./stubs/react-devtools-core";
const STUB_ENTRY = "stubs/react-devtools-core/index.js";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const failures: string[] = [];

const build = pkg.scripts?.build;
if (build === undefined) {
  failures.push("no build script found in package.json");
} else if (!build.includes(REQUIRED_EXTERNAL)) {
  failures.push(
    `the build script must pass ${REQUIRED_EXTERNAL}.\n` +
      "Without it, pi-ai's OAuth flow modules cannot be resolved from the\n" +
      "bundle and `nax auth login <oauth-provider>` fails with\n" +
      `"Cannot find module './<provider>.js'".\nFound: ${build}`,
  );
}

const declared = pkg.devDependencies?.["react-devtools-core"] ?? pkg.dependencies?.["react-devtools-core"];
if (declared === undefined) {
  failures.push(
    `devDependencies must declare "react-devtools-core": "${STUB_SPECIFIER}".\n` +
      "It looks unused -- no source file imports it -- but ink does, from inside\n" +
      "node_modules, and dropping it breaks `bun run build`. See the header.",
  );
} else if (declared !== STUB_SPECIFIER) {
  failures.push(
    `"react-devtools-core" must resolve to the in-repo stub (${STUB_SPECIFIER}),\n` +
      `not ${declared}. Every published version depends on ws@7 and shell-quote,\n` +
      "the advisories nax#1976 removed it to escape.",
  );
}

if (!existsSync(STUB_ENTRY)) {
  failures.push(`the stub entry point ${STUB_ENTRY} is missing.`);
}

if (failures.length > 0) {
  for (const f of failures) console.error(`check-bundle-externals: ${f}\n`);
  process.exit(1);
}

console.log("check-bundle-externals: nax-ai stays external; react-devtools-core resolves to the stub");
