/**
 * The light entry points (#3079): `./credentials`, `./runtime` and `./redact`
 * let an always-on embedder install the process-wide slots and redact log
 * lines without loading the session, tool, sandbox or provider code.
 *
 * Each entry's module graph is pinned file by file. A new import in one of
 * these files is a deliberate change to what an idle embedder loads: update
 * the list here only after checking the cost.
 *
 * The walk reads import statements, so it cannot see a computed `import(name)`
 * or a `createRequire` call. None of the pinned files uses either.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import * as pub from "@nathapp/nax-agent";
import * as credentials from "@nathapp/nax-agent/credentials";
import * as redact from "@nathapp/nax-agent/redact";
import * as runtime from "@nathapp/nax-agent/runtime";
import { byCodePoint } from "#src/internal/sort";

const PKG = resolve(import.meta.dir, "../../..");
const SRC = join(PKG, "src");

interface Graph {
  /** Source files reached from the entry, relative to src/, sorted. */
  readonly files: string[];
  /** Specifiers that are neither a package source file nor a `node:` builtin. */
  readonly external: string[];
}

function resolveSpecifier(from: string, specifier: string): string | null {
  if (specifier.startsWith("#src/")) return join(SRC, `${specifier.slice("#src/".length)}.ts`);
  if (specifier.startsWith(".")) return resolve(dirname(from), specifier);
  return null;
}

/** Every module the entry loads at runtime: type-only imports are erased and so not followed. */
function runtimeGraph(entry: string): Graph {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const seen = new Set<string>();
  const external = new Set<string>();
  const queue = [join(SRC, entry)];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { path } of transpiler.scanImports(readFileSync(file, "utf8"))) {
      const target = resolveSpecifier(file, path);
      if (target !== null) queue.push(target);
      else if (!path.startsWith("node:")) external.add(path);
    }
  }
  return {
    files: [...seen].map((file) => relative(SRC, file)).sort(byCodePoint),
    external: [...external].sort(byCodePoint),
  };
}

const LIGHT_ENTRIES = [
  {
    subpath: "./credentials",
    entry: "light/credentials.ts",
    files: ["infra/credentials-config.ts", "infra/nax-error.ts", "light/credentials.ts"],
  },
  {
    subpath: "./redact",
    entry: "light/redact.ts",
    files: ["internal/redact-structured.ts", "internal/redact.ts", "light/redact.ts"],
  },
  {
    subpath: "./runtime",
    entry: "light/runtime.ts",
    files: [
      "light/runtime.ts",
      "runtime/index.ts",
      "runtime/node-glob.ts",
      "runtime/node-runtime.ts",
      "runtime/slot.ts",
      "runtime/which.ts",
    ],
  },
] as const;

describe("light entry points", () => {
  test("package.json maps each subpath to its entry file", () => {
    const pkg: { exports: Record<string, string> } = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
    for (const { subpath, entry } of LIGHT_ENTRIES) {
      expect(pkg.exports[subpath]).toBe(`./src/${entry}`);
      expect(existsSync(join(SRC, entry))).toBe(true);
    }
  });

  for (const { subpath, entry, files } of LIGHT_ENTRIES) {
    test(`${subpath} loads exactly its pinned modules and no dependency`, () => {
      const graph = runtimeGraph(entry);
      expect(graph.external).toEqual([]);
      expect(graph.files).toEqual([...files]);
    });
  }

  test("the graph walk sees the heavy code behind the root entry", () => {
    // Guards the walker itself: a walk that followed nothing would pass every pin above.
    const graph = runtimeGraph("index.ts");
    expect(graph.files.length).toBeGreaterThan(100);
    expect(graph.external).toContain("@nathapp/nax-ai");
  });

  test("each entry exports exactly its names", () => {
    expect(Object.keys(credentials).sort(byCodePoint)).toEqual(["configureCredentials"]);
    expect(Object.keys(redact).sort(byCodePoint)).toEqual(["capStrings", "redactSecrets"]);
    expect(Object.keys(runtime).sort(byCodePoint)).toEqual(["getAgentRuntime", "nodeRuntime", "setAgentRuntime"]);
  });

  test("the exports are the very objects the root entry exports", () => {
    // A copy would give the light entry its own slot, invisible to the session code.
    expect(credentials.configureCredentials).toBe(pub.configureCredentials);
    expect(runtime.getAgentRuntime).toBe(pub.getAgentRuntime);
    expect(runtime.setAgentRuntime).toBe(pub.setAgentRuntime);
    expect(runtime.nodeRuntime).toBe(pub.nodeRuntime);
    expect(redact.redactSecrets).toBe(pub.redactSecrets);
    expect(redact.capStrings).toBe(pub.capStrings);
  });
});
