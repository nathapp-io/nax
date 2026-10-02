import { describe, expect, test } from "bun:test";
import {
  assertDistinctNamespaces,
  isPublicModule,
  namespaceExportName,
  packageImportSpec,
  renderHelperBarrel,
  renderHelperShim,
  renderIndex,
  renderInternal,
} from "@scripts/lib/s1-move/entries";
import { agentBiomeJson, agentPackageJson, withAgentDevDependency } from "@scripts/lib/s1-move/scaffold";

describe("entries", () => {
  test("the public entry is the contract directory plus the listed barrels", () => {
    expect(isPublicModule("src/session/session-types.ts")).toBe(true);
    expect(isPublicModule("src/tools/index.ts")).toBe(true);
    expect(isPublicModule("src/tools/git.ts")).toBe(false);
    expect(isPublicModule("src/infra/index.ts")).toBe(false);
  });

  test("package import specifiers keep /index and drop the extension", () => {
    expect(packageImportSpec("src/tools/index.ts")).toBe("#src/tools/index");
    expect(packageImportSpec("test/helpers/temp.ts")).toBe("#test/helpers/temp");
  });

  test("namespace export names come from the file, or the directory of an index", () => {
    expect(namespaceExportName("src/native/session/transcript-store.ts")).toBe("transcriptStoreModule");
    expect(namespaceExportName("src/cost/core/index.ts")).toBe("coreModule");
  });

  test("renderIndex re-exports the public modules, the slots and the settled ambiguity", () => {
    const text = renderIndex(["src/tools/git.ts", "src/tools/index.ts", "src/session/session-types.ts"]);
    expect(text).toContain('export * from "#src/session/session-types";\nexport * from "#src/tools/index";\n');
    expect(text).not.toContain("#src/tools/git");
    expect(text).toContain('export { configureCredentials, setAgentLogger } from "#src/infra/index";');
    expect(text).toContain('export { NO_OP_INTERACTION_HANDLER } from "#src/session/interaction-handler";');
  });

  test("renderInternal re-exports the needed modules and namespaces", () => {
    const text = renderInternal(new Set(["src/internal/sort.ts"]), new Map([["src/tools/git.ts", "gitModule"]]));
    expect(text).toContain('export * from "#src/internal/sort";\nexport * as gitModule from "#src/tools/git";\n');
  });

  test("two modules cannot share a namespace export name", () => {
    const errors = assertDistinctNamespaces(
      new Map([
        ["src/a/git.ts", "gitModule"],
        ["src/b/git.ts", "gitModule"],
      ]),
    );
    expect(errors).toEqual(["namespace export gitModule would name both src/a/git.ts and src/b/git.ts"]);
  });

  test("the helper barrel keeps nax's statements for the helpers that moved", () => {
    const barrel = 'export { a } from "./temp";\nexport { type B, c } from "./config";\n';
    expect(renderHelperBarrel(barrel, ["test/helpers/temp.ts"])).toContain('export { a } from "./temp";\n');
    expect(renderHelperBarrel(barrel, ["test/helpers/temp.ts"])).not.toContain("config");
  });

  test("a helper shim re-exports the moved helper through the package", () => {
    expect(renderHelperShim("test/helpers/temp.ts")).toContain('export * from "@nathapp/nax-agent/test/helpers/temp";');
  });
});

describe("scaffold", () => {
  const nax = {
    dependencies: { "@anthropic-ai/sandbox-runtime": "0.0.77", "@nathapp/nax-ai": "0.1.16", zod: "^4.3.6", ink: "^6" },
    devDependencies: {
      "@biomejs/biome": "2.5.10",
      "@types/bun": "^1.3.8",
      "bun-types": "^1.3.9",
      typescript: "^7.0.2",
    },
  };

  test("nax-agent's package.json copies nax's versions and declares the entries", () => {
    const pkg = JSON.parse(agentPackageJson(nax));
    expect(pkg.name).toBe("@nathapp/nax-agent");
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies).toEqual({
      "@anthropic-ai/sandbox-runtime": "0.0.77",
      "@nathapp/nax-ai": "0.1.16",
      zod: "^4.3.6",
    });
    expect(pkg.exports["./internal"]).toBe("./src/internal.ts");
    expect(pkg.imports).toEqual({ "#src/*": "./src/*.ts", "#test/*": "./test/*.ts" });
  });

  test("a dependency nax does not declare stops the scaffold", () => {
    expect(() => agentPackageJson({ dependencies: {}, devDependencies: nax.devDependencies })).toThrow(
      "declares no version",
    );
  });

  test("nax-agent's biome config is nax's rule set with nax-only overrides dropped", () => {
    const config = JSON.parse(
      agentBiomeJson({
        root: false,
        plugins: ["./biome-plugins/no-as-never.grit"],
        linter: { rules: { recommended: true } },
        overrides: [
          { includes: ["src/**", "!src/cli/**"], plugins: ["./biome-plugins/no-process-cwd.grit"] },
          { includes: ["bin/**", "scripts/**"], linter: {} },
          { includes: ["**/test/**"], plugins: ["./biome-plugins/no-absent-value.grit"] },
        ],
      }),
    );
    expect(config.plugins).toEqual(["../nax/biome-plugins/no-as-never.grit"]);
    expect(config.linter).toEqual({ rules: { recommended: true } });
    expect(config.overrides).toEqual([
      { includes: ["src/**"], plugins: ["../nax/biome-plugins/no-process-cwd.grit"] },
      { includes: ["**/test/**"], plugins: ["../nax/biome-plugins/no-absent-value.grit"] },
    ]);
  });

  test("nax takes nax-agent as a workspace devDependency, never a dependency", () => {
    const pkg = JSON.parse(withAgentDevDependency(JSON.stringify(nax)));
    expect(pkg.devDependencies["@nathapp/nax-agent"]).toBe("workspace:*");
    expect(pkg.dependencies["@nathapp/nax-agent"]).toBeUndefined();
  });
});
