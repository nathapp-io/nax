import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import {
  assertClientNotEmpty,
  assertPublishRepo,
  buildStagedManifest,
  missingStageInputs,
  peerRangeFor,
  STAGE_INPUTS,
  // biome-ignore lint/style/noRestrictedImports: the staging lib is a script, not part of the package's importable surface; tests reach it by path
} from "../../../scripts/lib/stage-manifest.ts";

const source = {
  name: "@nathapp/nax-agent-acp",
  version: "0.3.0",
  private: true,
  description: "ACP backend.",
  license: "MIT",
  author: "William Khoo",
  homepage: "https://github.com/nathapp-io/nax/tree/main/packages/nax-agent-acp",
  bugs: { url: "https://github.com/nathapp-io/nax/issues" },
  keywords: ["acp"],
  type: "module",
  exports: { "./client": "./src/client/index.ts", "./server": "./src/server/index.ts" },
  scripts: { build: "tsc" },
  dependencies: { "@agentclientprotocol/sdk": "~1.7.0", "@modelcontextprotocol/sdk": "^1.30.0", zod: "^4.3.6" },
  peerDependencies: { "@nathapp/nax-agent": "workspace:*" },
  devDependencies: { "@nathapp/nax-agent": "workspace:*", typescript: "7.0.2" },
};
const opts = {
  repository: "git+https://github.com/nathapp-io/nax.git",
  directory: "packages/nax-agent-acp",
  naxAgentVersion: "0.3.0",
};

describe("peerRangeFor", () => {
  test("caret on the shared version", () => {
    expect(peerRangeFor("0.3.0", "0.3.0")).toBe("^0.3.0");
    expect(peerRangeFor("0.3.1-canary.2", "0.3.1-canary.2")).toBe("^0.3.1-canary.2");
  });

  test.each([
    ["0.2.0", "0.3.0"],
    ["0.3.1", "0.3.0"],
    ["0.3.0", "0.3.0-canary.1"],
  ])("refuses nax-agent %s next to nax-agent-acp %s (R10 lockstep)", (agent, own) => {
    expect(() => peerRangeFor(agent, own)).toThrow(/lockstep/);
  });
});

describe("buildStagedManifest", () => {
  const staged = buildStagedManifest(source, opts);

  test("points both entries at dist and rewrites the peer to the caret range", () => {
    expect(staged.exports).toEqual({
      "./client": { types: "./dist/client/index.d.ts", import: "./dist/client/index.js" },
      "./server": { types: "./dist/server/index.d.ts", import: "./dist/server/index.js" },
    });
    expect(staged.peerDependencies).toEqual({ "@nathapp/nax-agent": "^0.3.0" });
    expect(staged.dependencies).toEqual(source.dependencies);
    expect(staged.engines).toEqual({ node: ">=22.19.0" });
    expect(staged.repository).toEqual({ type: "git", url: opts.repository, directory: opts.directory });
    expect(staged.publishConfig).toEqual({
      access: "public",
      registry: "https://registry.npmjs.org/",
      provenance: true,
      tag: "latest",
    });
  });

  test("drops workspace-only fields, and no workspace: protocol survives anywhere", () => {
    for (const key of ["private", "scripts", "devDependencies"]) expect(staged).not.toHaveProperty(key);
    expect(JSON.stringify(staged)).not.toContain("workspace:");
  });

  test("ships the nax-agent bin", () => {
    expect(staged.bin).toEqual({ "nax-agent": "./bin/nax-agent.js" });
  });

  test("a workspace: protocol in dependencies is refused rather than shipped", () => {
    const leaky = { ...source, dependencies: { ...source.dependencies, "@nathapp/nax-agent": "workspace:*" } };
    expect(() => buildStagedManifest(leaky, opts)).toThrow(/workspace:/);
  });
});

describe("assertClientNotEmpty", () => {
  test("refuses the bare scaffold entry and accepts an entry that exports something", () => {
    expect(() => assertClientNotEmpty("export {};\n")).toThrow(/not releasable before S4 acceptance/);
    expect(() => assertClientNotEmpty("export declare function acpBackend(): unknown;\n")).not.toThrow();
  });

  test("refuses the real emitted scaffold: doc comment before the empty export", () => {
    expect(() =>
      assertClientNotEmpty(
        [
          "/**",
          " * `@nathapp/nax-agent-acp/client`: the ACP backend for nax-agent sessions.",
          " *",
          " * Empty until S4-2, which adds `acpBackend()`. Nothing is released before S4-6,",
          " * so this partial entry is never published.",
          " */",
          "export {};",
          "",
        ].join("\n"),
      ),
    ).toThrow(/not releasable before S4 acceptance/);
    expect(() => assertClientNotEmpty("")).toThrow(/not releasable before S4 acceptance/);
    expect(() => assertClientNotEmpty("export {};\nexport { };")).toThrow(/not releasable before S4 acceptance/);
  });
});

describe("staging inputs and repository", () => {
  test("lists both entries' JS and declarations plus the docs, and every emitted module", () => {
    const dir = makeTempDir("acp-stage-");
    try {
      expect(missingStageInputs(dir)).toEqual([...STAGE_INPUTS]);
      mkdirSync(join(dir, "src/client"), { recursive: true });
      writeFileSync(join(dir, "src/client/registry.ts"), "export {};\n");
      expect(missingStageInputs(dir)).toContain(join("dist", "client", "registry.js"));
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("the bin is a staging input", () => {
    expect(STAGE_INPUTS).toContain("bin/nax-agent.js");
  });

  test("refuses to stage from a fork; allows local runs", () => {
    expect(() => assertPublishRepo("someone/nax")).toThrow(/nathapp-io\/nax/);
    expect(() => assertPublishRepo(undefined)).not.toThrow();
    expect(() => assertPublishRepo("nathapp-io/nax")).not.toThrow();
  });
});
