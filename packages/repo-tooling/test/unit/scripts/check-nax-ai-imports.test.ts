/**
 * The wire-isolation gate.
 *
 * nax-ai is replaceable only while every import of it sits behind one
 * directory. This mirrors check-adapter-no-config-import.sh, and nax-ai's own
 * check-pi-ai-imports, for the same reason.
 *
 * The gate is proven by violating it: a gate never seen to fail is not a gate.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../../scripts/check-nax-ai-imports.ts");

function runGate(root: string): { code: number; out: string } {
  const proc = Bun.spawnSync(["bun", "run", SCRIPT, root]);
  return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
}

const AGENT_PACKAGE_JSON = JSON.stringify({ name: "@nathapp/nax-agent" });

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "nax-gate-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body, "utf8");
  }
  return root;
}

describe("check-nax-ai-imports", () => {
  // S1-5: the native loop is no longer nax's, so the gate reads the scanned
  // package's own name from its package.json and admits src/native/ instead.
  test("nax-agent: passes when nax-ai is imported only from src/native", () => {
    const root = tree({
      "package.json": AGENT_PACKAGE_JSON,
      "src/native/client.ts": 'import { createClient } from "@nathapp/nax-ai";\n',
      "src/session/session-types.ts": 'import type { NativeSessionAdapter } from "#src/native/index";\n',
    });
    const { code } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).toBe(0);
  });

  test("fails when nax-ai is imported from outside that directory", () => {
    const root = tree({
      "package.json": JSON.stringify({ name: "@nathapp/nax" }),
      "src/agents/manager.ts": 'import { createClient } from "@nathapp/nax-ai";\n',
    });
    const { code, out } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).not.toBe(0);
    expect(out).toContain("src/agents/manager.ts");
  });

  test("ignores the import name inside a comment", () => {
    const root = tree({
      "package.json": JSON.stringify({ name: "@nathapp/nax" }),
      "src/agents/manager.ts": "// see @nathapp/nax-ai for the client\nexport const x = 1;\n",
    });
    const { code } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).toBe(0);
  });

  // US-001: the gate admits a second prefix (`src/agents/catalog/`) so the
  // non-native side of nax can hold the @nathapp/nax-ai boundary without
  // creating a cost <-> native cycle. Without this assertion the catalogue's
  // own import would silently fail the gate.
  test("passes when nax-ai is imported only from src/agents/catalog", () => {
    const root = tree({
      "package.json": JSON.stringify({ name: "@nathapp/nax" }),
      "src/agents/catalog/lookup.ts": 'import { defaultProviders } from "@nathapp/nax-ai";\n',
      "src/agents/registry.ts": 'import { CatalogLookup } from "./catalog";\n',
    });
    const { code, out } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(out).toContain("clean");
  });

  test("nax: src/agents/native is no longer an allowed site, since the native agent moved to nax-agent", () => {
    const root = tree({
      "package.json": JSON.stringify({ name: "@nathapp/nax" }),
      "src/agents/native/client.ts": 'import { createClient } from "@nathapp/nax-ai";\n',
      "src/agents/catalog/lookup.ts": 'import { defaultProviders } from "@nathapp/nax-ai";\n',
    });
    const { code, out } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).not.toBe(0);
    expect(out).toContain("src/agents/native/client.ts");
    expect(out).not.toContain("src/agents/catalog/lookup.ts:");
  });

  test("nax-agent: passes for the R3 re-export file", () => {
    const root = tree({
      "package.json": AGENT_PACKAGE_JSON,
      "src/cost/standard-types.ts": 'export type { TokenUsage } from "@nathapp/nax-ai";\n',
    });
    const { code } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).toBe(0);
  });

  test("nax-agent: still fails for a sibling of the re-export file", () => {
    const root = tree({
      "package.json": AGENT_PACKAGE_JSON,
      "src/cost/estimate.ts": 'import type { Pricing } from "@nathapp/nax-ai";\n',
    });
    const { code } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).not.toBe(0);
  });

  // src/tools/types.ts names the package only to explain why it does NOT
  // import it. The allow-list is for real imports, so that file must not be
  // listed: an entry here would be dead weight that reads as permission.
  test("nax-agent: a doc comment naming the package is not an import site, so none is needed for it", () => {
    const root = tree({
      "package.json": AGENT_PACKAGE_JSON,
      "src/tools/types.ts":
        "/**\n * Deliberately free of any transport type: none of which may see `@nathapp/nax-ai`\n */\nexport const x = 1;\n",
      "src/native/index.ts": 'export { client } from "./client";\n',
    });
    const { code, out } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(out).toContain("clean");
  });

  // Default-deny, like the RULES map in check-package-boundaries.ts: a package
  // with no rule must fail the gate, not inherit nax's allow-list (#2323 item 3).
  test("fails closed for a package with no allow-list rule", () => {
    const root = tree({
      "package.json": JSON.stringify({ name: "@nathapp/nax-repo-tooling" }),
      "src/index.ts": "export const x = 1;\n",
    });
    const { code, out } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).not.toBe(0);
    expect(out).toContain("no nax-ai allow-list");
  });

  test("fails closed when the tree has no package.json", () => {
    const root = tree({ "src/index.ts": "export const x = 1;\n" });
    const { code, out } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).not.toBe(0);
    expect(out).toContain("no nax-ai allow-list");
  });
});
