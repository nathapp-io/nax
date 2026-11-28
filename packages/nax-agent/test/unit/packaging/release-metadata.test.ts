import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
// biome-ignore lint/style/noRestrictedImports: release staging is a script, outside the package source surface
import { buildStagedManifest } from "../../../scripts/lib/stage-manifest.ts";

test("release staging carries a real release version and preserves dependency pins", () => {
  const source = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
  expect(source.version).not.toBe("0.0.0");
  const staged = buildStagedManifest(source, {
    repository: "git+https://github.com/nathapp-io/nax.git",
    directory: "packages/nax-agent",
  });
  expect(staged.version).toBe(source.version);
  expect(staged.dependencies).toEqual(source.dependencies);
  expect(source.private).toBe(true);
  expect(source.exports).toEqual({
    ".": "./src/index.ts",
    "./internal": "./src/internal.ts",
    "./mcp": "./src/mcp/index.ts",
    "./credentials": "./src/light/credentials.ts",
    "./runtime": "./src/light/runtime.ts",
    "./redact": "./src/light/redact.ts",
  });
  expect(staged.exports).toEqual({
    ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    "./internal": { types: "./dist/internal.d.ts", import: "./dist/internal.js" },
    "./mcp": { types: "./dist/mcp/index.d.ts", import: "./dist/mcp/index.js" },
    "./credentials": { types: "./dist/light/credentials.d.ts", import: "./dist/light/credentials.js" },
    "./runtime": { types: "./dist/light/runtime.d.ts", import: "./dist/light/runtime.js" },
    "./redact": { types: "./dist/light/redact.d.ts", import: "./dist/light/redact.js" },
  });
  expect(staged.engines).toEqual({ node: ">=22.19.0" });
  expect(staged.publishConfig).toMatchObject({ provenance: true, tag: "latest" });
  for (const key of ["private", "scripts", "devDependencies"]) expect(staged).not.toHaveProperty(key);
});
