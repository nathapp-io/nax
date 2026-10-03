import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";
import {
  assertPublishRepo,
  buildStagedManifest,
  missingStageInputs,
  STAGE_INPUTS,
  // biome-ignore lint/style/noRestrictedImports: the staging lib is a script, not part of the package's importable surface; tests reach it by path
} from "../../../scripts/lib/stage-manifest.ts";

const source = {
  name: "@nathapp/nax-agent",
  version: "0.0.0",
  private: true,
  description: "nax's native coding agent.",
  license: "MIT",
  author: "William Khoo",
  homepage: "https://github.com/nathapp-io/nax/tree/main/packages/nax-agent",
  bugs: { url: "https://github.com/nathapp-io/nax/issues" },
  keywords: ["agent", "coding-agent", "llm", "sandbox", "tools"],
  type: "module",
  exports: { ".": "./src/index.ts" },
  imports: { "#src/*": "./src/*.ts" },
  scripts: { build: "bun x tsc -p tsconfig.build.json" },
  dependencies: { "@nathapp/nax-ai": "0.1.16", "@anthropic-ai/sandbox-runtime": "0.0.77", zod: "^4.3.6" },
  devDependencies: { typescript: "7.0.2" },
};

const OPTS = { repository: "git+https://github.com/nathapp-io/nax.git", directory: "packages/nax-agent" };

describe("buildStagedManifest", () => {
  test("emits exactly the publish manifest", () => {
    expect(buildStagedManifest(source, OPTS)).toEqual({
      name: "@nathapp/nax-agent",
      version: "0.0.0",
      description: "nax's native coding agent.",
      license: "MIT",
      author: "William Khoo",
      homepage: "https://github.com/nathapp-io/nax/tree/main/packages/nax-agent",
      bugs: { url: "https://github.com/nathapp-io/nax/issues" },
      keywords: ["agent", "coding-agent", "llm", "sandbox", "tools"],
      repository: { type: "git", url: "git+https://github.com/nathapp-io/nax.git", directory: "packages/nax-agent" },
      type: "module",
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        "./internal": { types: "./dist/internal.d.ts", import: "./dist/internal.js" },
      },
      imports: { "#src/*": { types: "./dist/*.d.ts", default: "./dist/*.js" } },
      engines: { node: ">=22.19.0" },
      dependencies: source.dependencies,
      publishConfig: { access: "public", registry: "https://registry.npmjs.org/", provenance: true, tag: "latest" },
    });
  });

  test("drops private, scripts, devDependencies and source-pointing exports", () => {
    const manifest = buildStagedManifest(source, OPTS);
    for (const key of ["private", "scripts", "devDependencies"]) expect(key in manifest).toBe(false);
    expect(JSON.stringify(manifest)).not.toContain("./src/");
    expect(JSON.stringify(manifest)).not.toContain("test/helpers");
  });

  test("every types target the manifest advertises is a staging input", () => {
    const text = JSON.stringify(buildStagedManifest(source, OPTS));
    const inputs: readonly string[] = STAGE_INPUTS;
    for (const target of ["dist/index.d.ts", "dist/internal.d.ts"]) {
      expect(text).toContain(`"types":"./${target}"`);
      expect(inputs.includes(target)).toBe(true);
    }
  });
});

describe("missingStageInputs", () => {
  test("requires both emitted files for every nested source module", () => {
    const dir = makeTempDir("stage-partial-");
    try {
      for (const rel of [...STAGE_INPUTS, "src/command-safety/index.ts", "src/ambient.d.ts"]) {
        const full = join(dir, rel);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, "");
      }
      expect(missingStageInputs(dir)).toEqual(["dist/command-safety/index.js", "dist/command-safety/index.d.ts"]);
      mkdirSync(join(dir, "dist/command-safety"), { recursive: true });
      writeFileSync(join(dir, "dist/command-safety/index.js"), "");
      expect(missingStageInputs(dir)).toEqual(["dist/command-safety/index.d.ts"]);
      writeFileSync(join(dir, "dist/command-safety/index.d.ts"), "");
      expect(missingStageInputs(dir)).toEqual([]);
      rmSync(join(dir, "dist/command-safety/index.js"));
      mkdirSync(join(dir, "dist/command-safety/index.js"));
      expect(missingStageInputs(dir)).toEqual(["dist/command-safety/index.js"]);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("names every missing input on an empty package dir and none once they exist", () => {
    const dir = makeTempDir("stage-inputs-");
    try {
      expect(missingStageInputs(dir)).toEqual([...STAGE_INPUTS]);
      for (const rel of STAGE_INPUTS) {
        const full = join(dir, rel);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, "");
      }
      expect(missingStageInputs(dir)).toEqual([]);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("assertPublishRepo", () => {
  test("accepts unset or the publishing repo and rejects another", () => {
    expect(() => assertPublishRepo(undefined)).not.toThrow();
    expect(() => assertPublishRepo("nathapp-io/nax")).not.toThrow();
    expect(() => assertPublishRepo("someone/fork")).toThrow(/nathapp-io\/nax/);
  });
});
