/** Exact-floor proof before S2–8 adds the full Node contract suite. */
import assert from "node:assert/strict";
import { globSync } from "node:fs";
import { glob } from "node:fs/promises";
// biome-ignore lint/style/noRestrictedImports: standalone Node floor runner uses local source without workspace installation
import { GLOB_CASES } from "../../../test-kit/src/cases/glob-cases.ts";
// biome-ignore lint/style/noRestrictedImports: runtime source must run before S2-6 introduces a Node build
import { nodeGlob, nodeGlobSync } from "../../src/runtime/node-glob.ts";

assert.equal(process.versions.bun, undefined, "must run on native Node");
if (process.argv[2] !== undefined) assert.equal(process.versions.node, process.argv[2], "wrong Node floor");
assert.equal(typeof globSync, "function");
assert.equal(typeof glob, "function");
const globWarnings = [];
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && /glob/i.test(warning.message)) globWarnings.push(warning.message);
});
for (const c of GLOB_CASES) await c.run({ glob: nodeGlob, globSync: nodeGlobSync });
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(globWarnings, [], "glob must be stable at the Node floor");
console.log(`glob floor ok: ${process.versions.node} (${GLOB_CASES.length} cases)`);
