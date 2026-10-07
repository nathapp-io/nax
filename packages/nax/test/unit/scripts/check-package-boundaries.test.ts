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
  write(
    "packages/nax/package.json",
    JSON.stringify({
      name: "@nathapp/nax",
      devDependencies: { "@nathapp/nax-test-kit": "workspace:*", "@nathapp/nax-repo-tooling": "workspace:*" },
    }),
  );
  write(
    "packages/nax-agent/package.json",
    JSON.stringify({ name: "@nathapp/nax-agent", dependencies: { zod: "^4", "@nathapp/nax-ai": "0.1.16" } }),
  );
  write("packages/nax-ai/package.json", JSON.stringify({ name: "@nathapp/nax-ai" }));
  write(
    "packages/nax/src/a.ts",
    'import { x } from "@nathapp/nax-agent";\nimport { y } from "@nathapp/nax-agent/internal";\n',
  );
  write("packages/nax/test/a.test.ts", 'import { t } from "@nathapp/nax-test-kit/bun/temp";\n');
  write("packages/nax/scripts/gate.ts", 'import { c } from "@nathapp/nax-repo-tooling/scripts/check-import-cycles";\n');
  write("packages/test-kit/package.json", JSON.stringify({ name: "@nathapp/nax-test-kit" }));
  write(
    "packages/test-kit/src/bun/temp.ts",
    'import { mkdtempSync } from "node:fs";\nimport { mock } from "bun:test";\n',
  );
  write(
    "packages/repo-tooling/package.json",
    JSON.stringify({ name: "@nathapp/nax-repo-tooling", devDependencies: { "@nathapp/nax-test-kit": "workspace:*" } }),
  );
  write(
    "packages/repo-tooling/scripts/check-x.ts",
    'import { Glob } from "bun";\nimport { r } from "#scripts/lib/package-root";\n',
  );
  write("packages/repo-tooling/test/unit/x.test.ts", 'import { t } from "@nathapp/nax-test-kit/bun/temp";\n');
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

  test("nax-agent src/ may not import itself by package name", () => {
    workspace();
    write("packages/nax-agent/src/drift.ts", 'import { x } from "@nathapp/nax-agent/internal";\n');
    const violations = findBoundaryViolations(root);
    expect(violations).toContainEqual(
      expect.objectContaining({
        file: expect.stringContaining("src/drift.ts"),
        why: expect.stringContaining("self-import"),
      }),
    );
  });

  test("nax-agent test/ may import the public entry by name (the packaging tests)", () => {
    workspace();
    write(
      "packages/nax-agent/test/unit/surface.test.ts",
      'import * as pub from "@nathapp/nax-agent";\nimport * as internal from "@nathapp/nax-agent/internal";\n',
    );
    expect(findBoundaryViolations(root)).toEqual([]);
  });

  test("an explicit .ts relative path is judged by where it lands, not by its extension", () => {
    workspace();
    write(
      "packages/nax-agent/src/ok.ts",
      'import { r } from "./tools/index.ts";\nexport * from "../src/tools/index.ts";\n',
    );
    write("packages/nax-agent/src/bad.ts", 'import { a } from "../../nax/src/config.ts";\n');
    expect(whys()).toEqual([
      "packages/nax-agent/src/bad.ts ../../nax/src/config.ts relative import leaves the package",
    ]);
  });

  test("nax may use only the two entries; no nax-agent test helper subpath, even from test/", () => {
    workspace();
    write(
      "packages/nax/src/bad.ts",
      'import { g } from "@nathapp/nax-agent/src/tools/git";\nimport { s } from "@nathapp/nax-agent/test/helpers/sandbox";\n',
    );
    write(
      "packages/nax/test/bad.test.ts",
      'import { s } from "@nathapp/nax-agent/test/helpers/sandbox";\nimport { t } from "@nathapp/nax-agent/test/helpers/temp";\n',
    );
    expect(whys()).toHaveLength(4);
  });

  test("nax may import test-kit only from test/ and repo-tooling only from scripts/ and test/", () => {
    workspace();
    write(
      "packages/nax/src/bad.ts",
      'import { t } from "@nathapp/nax-test-kit/bun/temp";\nimport { c } from "@nathapp/nax-repo-tooling/scripts/check-import-cycles";\n',
    );
    expect(whys()).toEqual([
      "packages/nax/src/bad.ts @nathapp/nax-test-kit/bun/temp @nathapp/nax-test-kit imported outside test/",
      "packages/nax/src/bad.ts @nathapp/nax-repo-tooling/scripts/check-import-cycles @nathapp/nax-repo-tooling imported outside scripts/ and test/",
    ]);
  });

  test("test-kit imports no nax package", () => {
    workspace();
    write(
      "packages/test-kit/src/bun/bad.ts",
      'import { a } from "@nathapp/nax-agent/internal";\nimport { r } from "@nathapp/nax-repo-tooling/scripts/x";\n',
    );
    expect(whys()).toEqual([
      "packages/test-kit/src/bun/bad.ts @nathapp/nax-agent/internal @nathapp/nax-test-kit imports @nathapp/nax-agent",
      "packages/test-kit/src/bun/bad.ts @nathapp/nax-repo-tooling/scripts/x @nathapp/nax-test-kit imports @nathapp/nax-repo-tooling",
    ]);
  });

  test("repo-tooling imports no nax package, and test-kit only from test/", () => {
    workspace();
    write(
      "packages/repo-tooling/scripts/bad.ts",
      'import { a } from "@nathapp/nax-agent/internal";\nimport { t } from "@nathapp/nax-test-kit/bun/temp";\nimport { x } from "../../nax/scripts/y";\n',
    );
    expect(whys()).toEqual([
      "packages/repo-tooling/scripts/bad.ts @nathapp/nax-agent/internal @nathapp/nax-repo-tooling imports @nathapp/nax-agent",
      "packages/repo-tooling/scripts/bad.ts @nathapp/nax-test-kit/bun/temp @nathapp/nax-repo-tooling imports @nathapp/nax-test-kit",
      "packages/repo-tooling/scripts/bad.ts ../../nax/scripts/y relative import leaves the package",
    ]);
  });

  test("repo-tooling cannot import a nax package from tests even if it is a devDependency", () => {
    workspace();
    write(
      "packages/repo-tooling/package.json",
      JSON.stringify({
        name: "@nathapp/nax-repo-tooling",
        devDependencies: {
          "@nathapp/nax-test-kit": "workspace:*",
          "@nathapp/nax-agent": "workspace:*",
        },
      }),
    );
    write("packages/repo-tooling/test/unit/bad.test.ts", 'import { secret } from "@nathapp/nax-agent/internal";\n');

    expect(whys()).toEqual([
      "packages/repo-tooling/test/unit/bad.test.ts @nathapp/nax-agent/internal @nathapp/nax-repo-tooling imports @nathapp/nax-agent",
    ]);
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

  test("require() is a specifier the rules see, not an invisible hole", () => {
    workspace();
    write(
      "packages/nax-agent/src/bad.ts",
      'const n = require("@nathapp/nax");\nconst c = require("../../nax/src/config");\n',
    );
    expect(whys()).toEqual([
      "packages/nax-agent/src/bad.ts @nathapp/nax imports nax",
      "packages/nax-agent/src/bad.ts ../../nax/src/config relative import leaves the package",
    ]);
  });

  test("a package with no boundary rule fails the gate instead of being skipped", () => {
    workspace();
    // No src/, no imports at all: the package a rule is missing for is exactly the
    // one the gate would otherwise scan for nothing and still report green on.
    write("packages/nax-extra/package.json", JSON.stringify({ name: "@nathapp/nax-extra" }));
    expect(() => whys()).toThrow(
      /no boundary rule for these packages, so the gate cannot enforce them: @nathapp\/nax-extra/,
    );
  });
});

test("agent production Bun imports fail while retained Bun tests and nax runtime pass", () => {
  workspace();
  write("packages/nax-agent/src/bun.ts", 'import { Glob } from "bun";\nimport { test } from "bun:test";\n');
  write("packages/nax-agent/test/bun.test.ts", 'import { test } from "bun:test";\n');
  write("packages/nax/src/agent-runtime/bun-runtime.ts", 'import { Glob } from "bun";\n');
  expect(whys()).toEqual([
    "packages/nax-agent/src/bun.ts bun Bun import outside test/",
    "packages/nax-agent/src/bun.ts bun:test Bun import outside test/",
  ]);
});

describe("nax-agent-acp", () => {
  function acp(): void {
    workspace();
    write(
      "packages/nax-agent-acp/package.json",
      JSON.stringify({
        name: "@nathapp/nax-agent-acp",
        dependencies: { "@agentclientprotocol/sdk": "~1.7.0", "@modelcontextprotocol/sdk": "^1.30.0", zod: "^4" },
        peerDependencies: { "@nathapp/nax-agent": "workspace:*" },
        devDependencies: { "@nathapp/nax-agent": "workspace:*", "@nathapp/nax-test-kit": "workspace:*", vitest: "4" },
      }),
    );
    write(
      "packages/nax-agent-acp/src/client/ok.ts",
      [
        'import { AgentSessionError } from "@nathapp/nax-agent";',
        'import type { SessionBackend } from "@nathapp/nax-agent";',
        'import { ClientSideConnection } from "@agentclientprotocol/sdk";',
        'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
        'import { z } from "zod";',
        'import { join } from "node:path";',
        'import { r } from "#src/client/registry";',
        'import { s } from "./sibling.ts";',
        "",
      ].join("\n"),
    );
    write(
      "packages/nax-agent-acp/test/unit/ok.test.ts",
      'import { test } from "bun:test";\nimport { t } from "@nathapp/nax-test-kit/bun/temp";\nimport { c } from "@nathapp/nax-agent-acp/client";\n',
    );
    write("packages/nax-agent-acp/test/node/ok.test.ts", 'import { test } from "vitest";\n');
  }

  test("a clean acp package passes", () => {
    acp();
    expect(whys()).toEqual([]);
  });

  test("acp may reach nax-agent only through its public entry, from src/ and test/ alike", () => {
    acp();
    write(
      "packages/nax-agent-acp/src/bad.ts",
      [
        'import { _clientDeps } from "@nathapp/nax-agent/internal";',
        'import type { X } from "@nathapp/nax-agent/internal";',
        'const m = await import("@nathapp/nax-agent/internal");',
        'import { y } from "@nathapp/nax-agent/src/index.ts";',
        "",
      ].join("\n"),
    );
    write("packages/nax-agent-acp/test/unit/bad.test.ts", 'import { s } from "@nathapp/nax-agent/internal";\n');
    expect(whys()).toEqual([
      "packages/nax-agent-acp/src/bad.ts @nathapp/nax-agent/internal only @nathapp/nax-agent (never ./internal or a deep path)",
      "packages/nax-agent-acp/src/bad.ts @nathapp/nax-agent/internal only @nathapp/nax-agent (never ./internal or a deep path)",
      "packages/nax-agent-acp/src/bad.ts @nathapp/nax-agent/internal only @nathapp/nax-agent (never ./internal or a deep path)",
      "packages/nax-agent-acp/src/bad.ts @nathapp/nax-agent/src/index.ts only @nathapp/nax-agent (never ./internal or a deep path)",
      "packages/nax-agent-acp/test/unit/bad.test.ts @nathapp/nax-agent/internal only @nathapp/nax-agent (never ./internal or a deep path)",
    ]);
  });

  test("acp src/ may import only the SDK root, the MCP SDK, zod and node builtins", () => {
    acp();
    write(
      "packages/nax-agent-acp/package.json",
      JSON.stringify({
        name: "@nathapp/nax-agent-acp",
        // chalk is declared, so only the src/ allowlist can reject it; the rest matches acp() so ok.ts stays clean.
        dependencies: {
          "@agentclientprotocol/sdk": "~1.7.0",
          "@modelcontextprotocol/sdk": "^1.30.0",
          zod: "^4",
          chalk: "^5",
        },
        devDependencies: { "@nathapp/nax-agent": "workspace:*", "@nathapp/nax-test-kit": "workspace:*", vitest: "4" },
      }),
    );
    write(
      "packages/nax-agent-acp/src/bad.ts",
      [
        'import { c } from "chalk";',
        'import { e } from "@agentclientprotocol/sdk/experimental";',
        'import { v } from "vitest";',
        'import { n } from "@nathapp/nax";',
        'import { a } from "@nathapp/nax-ai";',
        'import { B } from "bun";',
        'import { p } from "../../nax-agent/src/index.ts";',
        "",
      ].join("\n"),
    );
    expect(whys()).toEqual([
      "packages/nax-agent-acp/src/bad.ts chalk nax-agent-acp src/ may import only @agentclientprotocol/sdk, @modelcontextprotocol/sdk, zod",
      "packages/nax-agent-acp/src/bad.ts @agentclientprotocol/sdk/experimental only the @agentclientprotocol/sdk root",
      "packages/nax-agent-acp/src/bad.ts vitest devDependency vitest imported outside test/",
      "packages/nax-agent-acp/src/bad.ts @nathapp/nax imports nax",
      "packages/nax-agent-acp/src/bad.ts @nathapp/nax-ai imports nax-ai (reach it through @nathapp/nax-agent)",
      "packages/nax-agent-acp/src/bad.ts bun Bun import outside test/",
      "packages/nax-agent-acp/src/bad.ts ../../nax-agent/src/index.ts relative import leaves the package",
    ]);
  });

  test("no other package may import nax-agent-acp before S4b", () => {
    acp();
    write("packages/nax/src/bad.ts", 'import { c } from "@nathapp/nax-agent-acp/client";\n');
    write("packages/nax-agent/src/bad.ts", 'import { c } from "@nathapp/nax-agent-acp/client";\n');
    write("packages/nax-ai/src/bad.ts", 'import { c } from "@nathapp/nax-agent-acp/client";\n');
    write("packages/test-kit/src/bun/bad.ts", 'import { c } from "@nathapp/nax-agent-acp/client";\n');
    // Package directories are scanned in code-point order: nax, nax-agent, nax-agent-acp, nax-ai, ..., test-kit.
    expect(whys()).toEqual([
      "packages/nax/src/bad.ts @nathapp/nax-agent-acp/client nax does not depend on nax-agent-acp until S4b",
      "packages/nax-agent/src/bad.ts @nathapp/nax-agent-acp/client nax-agent imports nax-agent-acp",
      "packages/nax-ai/src/bad.ts @nathapp/nax-agent-acp/client nax-ai imports @nathapp/nax-agent-acp",
      "packages/test-kit/src/bun/bad.ts @nathapp/nax-agent-acp/client @nathapp/nax-test-kit imports @nathapp/nax-agent-acp",
    ]);
  });
});
