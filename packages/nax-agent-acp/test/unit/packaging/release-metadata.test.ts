import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
// biome-ignore lint/style/noRestrictedImports: release staging is a script, outside the package source surface
import { buildStagedManifest } from "../../../scripts/lib/stage-manifest.ts";

test("the real manifest stages with a caret peer on its own version and keeps workspace exports on source", () => {
  const source = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
  expect(source.private).toBe(true);
  expect(source.exports).toEqual({ "./client": "./src/client/index.ts", "./server": "./src/server/index.ts" });
  expect(source.peerDependencies).toEqual({ "@nathapp/nax-agent": "workspace:*" });
  expect(Object.keys(source.dependencies).sort()).toEqual([
    "@agentclientprotocol/sdk",
    "@modelcontextprotocol/sdk",
    "zod",
  ]);
  const staged = buildStagedManifest(source, {
    repository: "git+https://github.com/nathapp-io/nax.git",
    directory: "packages/nax-agent-acp",
    naxAgentVersion: source.version,
  });
  expect(staged.version).toBe(source.version);
  expect(staged.peerDependencies).toEqual({ "@nathapp/nax-agent": `^${source.version}` });
});
