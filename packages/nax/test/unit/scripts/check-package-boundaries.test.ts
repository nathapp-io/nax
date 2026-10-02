import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findBoundaryViolations } from "@scripts/check-package-boundaries";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

let root = "";
afterEach(() => {
  if (root) cleanupTempDir(root);
  root = "";
});

function write(rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}

/** A clean three-package workspace; each test adds one violation. */
function workspace(): void {
  root = makeTempDir("package-boundaries-");
  write("packages/nax/package.json", JSON.stringify({ name: "@nathapp/nax" }));
  write(
    "packages/nax-agent/package.json",
    JSON.stringify({ name: "@nathapp/nax-agent", dependencies: { zod: "^4", "@nathapp/nax-ai": "0.1.16" } }),
  );
  write("packages/nax-ai/package.json", JSON.stringify({ name: "@nathapp/nax-ai" }));
  write(
    "packages/nax/src/a.ts",
    'import { x } from "@nathapp/nax-agent";\nimport { y } from "@nathapp/nax-agent/internal";\n',
  );
  write("packages/nax/test/a.test.ts", 'import { t } from "@nathapp/nax-agent/test/helpers/temp";\n');
  write(
    "packages/nax-agent/src/tools/index.ts",
    'import { z } from "zod";\nimport { join } from "node:path";\nimport { s } from "#src/internal/sort";\nimport { r } from "./runtime";\n',
  );
  write(
    "packages/nax-agent/test/unit/a.test.ts",
    'import { test } from "bun:test";\nimport { h } from "#test/helpers/temp";\n',
  );
  write("packages/nax-ai/src/index.ts", 'import { p } from "@earendil-works/pi-ai";\n');
}

function whys(): string[] {
  return findBoundaryViolations(root).map((v) => `${v.file} ${v.spec} ${v.why}`);
}

describe("check-package-boundaries", () => {
  test("a clean workspace passes", () => {
    workspace();
    expect(whys()).toEqual([]);
  });

  test("nax-agent may not use a tsconfig alias, import nax, or import an undeclared package", () => {
    workspace();
    write(
      "packages/nax-agent/src/bad.ts",
      'import { a } from "@/config";\nimport { n } from "@nathapp/nax";\nimport { c } from "chalk";\n',
    );
    expect(whys()).toEqual([
      "packages/nax-agent/src/bad.ts @/config tsconfig alias",
      "packages/nax-agent/src/bad.ts @nathapp/nax imports nax",
      "packages/nax-agent/src/bad.ts chalk undeclared dependency chalk",
    ]);
  });

  test("nax-agent's src may not import a devDependency; its tests may", () => {
    workspace();
    write(
      "packages/nax-agent/package.json",
      JSON.stringify({ name: "@nathapp/nax-agent", dependencies: { zod: "^4" }, devDependencies: { chalk: "^5" } }),
    );
    write("packages/nax-agent/src/bad.ts", 'import { c } from "chalk";\n');
    write("packages/nax-agent/test/unit/ok.test.ts", 'import { c } from "chalk";\n');
    expect(whys()).toEqual(["packages/nax-agent/src/bad.ts chalk devDependency chalk imported outside test/"]);
  });

  test("nax-agent may not reach out of the package by a relative path", () => {
    workspace();
    write("packages/nax-agent/src/bad.ts", 'import { a } from "../../nax/src/config";\n');
    expect(whys()).toEqual(["packages/nax-agent/src/bad.ts ../../nax/src/config relative import leaves the package"]);
  });

  test("nax may use only the two entries, and the test helpers only from test/", () => {
    workspace();
    write(
      "packages/nax/src/bad.ts",
      'import { g } from "@nathapp/nax-agent/src/tools/git";\nimport { t } from "@nathapp/nax-agent/test/helpers/temp";\n',
    );
    expect(whys()).toHaveLength(2);
  });

  test("nax may not reach nax-agent by a relative path", () => {
    workspace();
    write("packages/nax/src/bad.ts", 'import { g } from "../../nax-agent/src/tools/git";\n');
    expect(whys()).toEqual([
      "packages/nax/src/bad.ts ../../nax-agent/src/tools/git relative import leaves the package",
    ]);
  });

  test("nax-ai imports neither nax nor nax-agent", () => {
    workspace();
    write("packages/nax-ai/src/bad.ts", 'import { a } from "@nathapp/nax-agent";\nimport { n } from "@nathapp/nax";\n');
    expect(whys()).toHaveLength(2);
  });
});
