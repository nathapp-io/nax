import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";
// biome-ignore lint/style/noRestrictedImports: bootstrap verification is a script, outside the source surface
import { assertBootstrapArtifact } from "../../../scripts/lib/bootstrap-artifact.ts";

function fixture(): { dir: string; staged: string; packed: string } {
  const dir = makeTempDir("bootstrap-artifact-");
  const staged = join(dir, "staged");
  const packed = join(dir, "package");
  for (const target of [staged, packed]) {
    mkdirSync(join(target, "dist"), { recursive: true });
    writeFileSync(join(target, "dist/index.js"), "export const answer = 42;\n");
    writeFileSync(join(target, "dist/index.d.ts"), "export declare const answer = 42;\n");
    writeFileSync(join(target, "README.md"), "The agent\n");
    writeFileSync(
      join(target, "package.json"),
      JSON.stringify({
        name: "@nathapp/nax-agent",
        version: "0.1.0",
        dependencies: { "@nathapp/nax-ai": "0.1.16" },
        engines: { node: ">=22.19.0" },
        repository: { url: "git+https://github.com/nathapp-io/nax.git" },
        exports: { ".": "./dist/index.js" },
        publishConfig: { provenance: target === staged, tag: "latest" },
      }),
    );
  }
  return { dir, staged, packed };
}

describe("bootstrap artifact verification", () => {
  test("does not normalize malformed provenance metadata", () => {
    const f = fixture();
    try {
      const path = join(f.packed, "package.json");
      const original = JSON.parse(readFileSync(path, "utf8"));
      original.publishConfig.provenance = "wrong";
      writeFileSync(path, JSON.stringify(original));
      expect(() => assertBootstrapArtifact(f.staged, f.packed)).toThrow("provenance");
    } finally {
      cleanupTempDir(f.dir);
    }
  });
  test("accepts only the manual provenance metadata difference, ignoring JSON key order", () => {
    const f = fixture();
    try {
      const path = join(f.packed, "package.json");
      const original = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, JSON.stringify(Object.fromEntries(Object.entries(original).reverse())));
      expect(() => assertBootstrapArtifact(f.staged, f.packed)).not.toThrow();
    } finally {
      cleanupTempDir(f.dir);
    }
  });

  test.each(["dist/index.js", "dist/index.d.ts", "README.md"])("rejects changed bytes in %s", (file) => {
    const f = fixture();
    try {
      writeFileSync(join(f.packed, file), "wrong content");
      expect(() => assertBootstrapArtifact(f.staged, f.packed)).toThrow(file);
    } finally {
      cleanupTempDir(f.dir);
    }
  });

  test.each(["missing", "extra"])("rejects %s payload files", (kind) => {
    const f = fixture();
    try {
      if (kind === "missing") rmSync(join(f.packed, "README.md"));
      else writeFileSync(join(f.packed, "extra.js"), "");
      expect(() => assertBootstrapArtifact(f.staged, f.packed)).toThrow();
    } finally {
      cleanupTempDir(f.dir);
    }
  });

  test.each(["version", "dependencies", "repository", "exports", "engines"])("rejects different %s metadata", (key) => {
    const f = fixture();
    try {
      const path = join(f.packed, "package.json");
      const original = JSON.parse(readFileSync(path, "utf8"));
      original[key] = "wrong";
      writeFileSync(path, JSON.stringify(original));
      expect(() => assertBootstrapArtifact(f.staged, f.packed)).toThrow("package.json");
    } finally {
      cleanupTempDir(f.dir);
    }
  });
});
