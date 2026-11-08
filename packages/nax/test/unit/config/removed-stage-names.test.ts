// test/unit/config/removed-stage-names.test.ts
//
// US-005 — warn-and-strip compatibility for the stage names no operation runs
// in since pipeline mode was removed: `rectification`, `regression` and
// `acceptance`.
//
// Two config surfaces carry those names:
//   - `mcp.servers.<id>.stages` — the stages an MCP server attaches to.
//   - `execution.permissions.<stage>` — a per-stage permission block.
//
// A config naming a removed stage still loads: the value is dropped and one
// warning per dropped item names it. A permission block another block INHERITS
// is kept — dropping it would break the inheriting block — and the inheritance
// is judged against the INPUT, before any block is dropped, so a template whose
// only user is a block that is itself removed stays.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _clearRootConfigCache, loadConfig, loadConfigForWorkdir } from "@/config/loader";
import { REMOVED_STAGE_NAMES, stripRemovedConfig, stripRemovedStageNames } from "@/config/removed-stage-names";
import { addSink, initLogger, resetLogger } from "@/logger";

const tempDirs: string[] = [];

/** Write a project `.nax/config.json` and return the project root. */
async function writeProjectConfig(contents: object): Promise<string> {
  const root = makeTempDir("nax-removed-stage-");
  tempDirs.push(root);
  const naxDir = join(root, ".nax");
  await mkdir(naxDir, { recursive: true });
  await Bun.write(join(naxDir, "config.json"), JSON.stringify(contents, null, 2));
  return root;
}

/** Run `fn` with a logger sink capturing every warning message it emits. */
async function captureWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; messages: string[] }> {
  const messages: string[] = [];
  resetLogger();
  initLogger({ level: "warn" });
  const removeSink = addSink((entry) => messages.push(entry.message));
  try {
    const result = await fn();
    return { result, messages };
  } finally {
    removeSink();
    resetLogger();
  }
}

/** Narrow an unknown value to a plain record, without a cast. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `mcp.servers` map of a config, or undefined when there is none. */
function serversOf(config: Record<string, unknown>): Record<string, unknown> | undefined {
  const mcp = config.mcp;
  if (!isRecord(mcp)) return undefined;
  const servers = mcp.servers;
  return isRecord(servers) ? servers : undefined;
}

/** Parse a JSON fixture into a config object, without a cast. */
function parseConfig(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error("fixture is not a JSON object");
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// stripRemovedStageNames — direct unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("stripRemovedStageNames — MCP server stage lists", () => {
  test("AC-1: drops a removed stage from mcp.servers.<id>.stages", () => {
    const result = stripRemovedStageNames({
      mcp: { servers: { graph: { command: "g", stages: ["run", "acceptance"] } } },
    });

    expect(result.mcp).toEqual({ servers: { graph: { command: "g", stages: ["run"] } } });
  });

  test("AC-2: warns exactly once, naming the removed stage value", () => {
    const captured: string[] = [];

    stripRemovedStageNames({ mcp: { servers: { graph: { command: "g", stages: ["run", "acceptance"] } } } }, (msg) =>
      captured.push(msg),
    );

    expect(captured).toEqual([
      'Config value "acceptance" in mcp.servers.graph.stages has been removed — ' +
        "no nax operation runs in this stage since pipeline mode was removed. Remove it from your config.",
    ]);
  });

  test("AC-3: a server whose stages were all removed keeps an empty list and its other fields", () => {
    const result = stripRemovedStageNames({
      mcp: { servers: { graph: { command: "g", args: ["--x"], stages: ["regression"] } } },
    });

    expect(result.mcp).toEqual({ servers: { graph: { command: "g", args: ["--x"], stages: [] } } });
  });

  test("a surviving stage list is left untouched and unwarned", () => {
    const captured: string[] = [];

    const result = stripRemovedStageNames(
      { mcp: { servers: { graph: { command: "g", stages: ["run", "review"] } } } },
      (msg) => captured.push(msg),
    );

    expect(result.mcp).toEqual({ servers: { graph: { command: "g", stages: ["run", "review"] } } });
    expect(captured).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stripRemovedStageNames — execution.permissions blocks
// ─────────────────────────────────────────────────────────────────────────────

describe("stripRemovedStageNames — execution.permissions blocks", () => {
  test("AC-4: drops an un-inherited removed permission block", () => {
    const result = stripRemovedStageNames({
      execution: { permissions: { rectification: { allow: ["Read"] }, review: { allow: ["Read"] } } },
    });

    expect(result.execution).toEqual({ permissions: { review: { allow: ["Read"] } } });
  });

  test("AC-5: warns exactly once, naming the removed permission key", () => {
    const captured: string[] = [];

    stripRemovedStageNames(
      { execution: { permissions: { rectification: { allow: ["Read"] }, review: { allow: ["Read"] } } } },
      (msg) => captured.push(msg),
    );

    expect(captured).toEqual([
      'Config key "execution.permissions.rectification" has been removed — ' +
        "no nax operation runs in this stage since pipeline mode was removed. Remove it from your config.",
    ]);
  });

  test("AC-6: keeps a removed block another block inherits", () => {
    const result = stripRemovedStageNames({
      execution: { permissions: { acceptance: { allow: ["Read"] }, review: { inherit: "acceptance" } } },
    });

    expect(result.execution).toEqual({
      permissions: { acceptance: { allow: ["Read"] }, review: { inherit: "acceptance" } },
    });
  });

  test("AC-7: warns nothing when the removed block is inherited", () => {
    const captured: string[] = [];

    stripRemovedStageNames(
      { execution: { permissions: { acceptance: { allow: ["Read"] }, review: { inherit: "acceptance" } } } },
      (msg) => captured.push(msg),
    );

    expect(captured).toHaveLength(0);
  });

  test("AC-8: inheritance is judged against the input, so an unused template stays", () => {
    const result = stripRemovedStageNames({
      execution: {
        permissions: {
          rectification: { inherit: "regression" },
          regression: { allow: ["Read"] },
          other: null,
        },
      },
    });

    expect(result.execution).toEqual({
      permissions: { regression: { allow: ["Read"] }, other: null },
    });
  });

  test("AC-9: warns exactly once for the removed block whose user is itself removed", () => {
    const captured: string[] = [];

    stripRemovedStageNames(
      {
        execution: {
          permissions: {
            rectification: { inherit: "regression" },
            regression: { allow: ["Read"] },
            other: null,
          },
        },
      },
      (msg) => captured.push(msg),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("execution.permissions.rectification");
    expect(captured[0]).toContain("has been removed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stripRemovedStageNames — defensive shapes
// ─────────────────────────────────────────────────────────────────────────────

describe("stripRemovedStageNames — defensive shapes", () => {
  test("AC-10: a non-object mcp and a non-object permissions block are returned unchanged", () => {
    const input = { mcp: 7, execution: { permissions: "x" } };

    const result = stripRemovedStageNames(input);

    expect(result).toEqual(input);
  });

  test("AC-11: warns nothing for a non-object mcp and a non-object permissions block", () => {
    const captured: string[] = [];

    stripRemovedStageNames({ mcp: 7, execution: { permissions: "x" } }, (msg) => captured.push(msg));

    expect(captured).toHaveLength(0);
  });

  test("AC-12: the input object is not mutated", () => {
    const input = { mcp: 7, execution: { permissions: "x" } };
    const before = structuredClone(input);

    stripRemovedStageNames(input, () => {});

    expect(input).toEqual(before);
  });

  test("a missing mcp, servers, server and stages are all left alone", () => {
    const captured: string[] = [];
    const input = { mcp: { servers: { graph: { command: "g" } } } };

    const result = stripRemovedStageNames(input, (msg) => captured.push(msg));

    expect(result).toEqual(input);
    expect(captured).toHaveLength(0);
  });

  test("a non-array stages value is left alone", () => {
    const captured: string[] = [];
    const input = { mcp: { servers: { graph: { command: "g", stages: "review" } } } };

    const result = stripRemovedStageNames(input, (msg) => captured.push(msg));

    expect(result).toEqual(input);
    expect(captured).toHaveLength(0);
  });

  test("REMOVED_STAGE_NAMES lists the three stages no operation runs in", () => {
    expect(REMOVED_STAGE_NAMES).toEqual(["rectification", "regression", "acceptance"]);
  });

  test("a server id that is a prototype key keeps its own entry", () => {
    // The raw config reaches the strip BEFORE the schema validates the server
    // id, so a project can declare one. Rebuilding the map with a plain
    // assignment would set the prototype instead of adding a key, and the
    // server would vanish from the config — turning a clear schema error into
    // a silent loss.
    const input = parseConfig('{"mcp":{"servers":{"__proto__":{"command":"g","stages":["regression"]}}}}');

    const result = stripRemovedStageNames(input);

    const servers = serversOf(result) ?? {};
    expect(Object.getOwnPropertyNames(servers)).toEqual(["__proto__"]);
    expect(Reflect.get(servers, "__proto__")).toEqual({ command: "g", stages: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stripRemovedConfig — the no-op strip plus the removed-stage strip
// ─────────────────────────────────────────────────────────────────────────────

describe("stripRemovedConfig — no-op keys and removed stage names", () => {
  test("strips a removed no-op key and a removed stage name in one pass", () => {
    const captured: string[] = [];

    const result = stripRemovedConfig(
      {
        tdd: { autoVerifyIsolation: false },
        mcp: { servers: { graph: { command: "g", stages: ["review", "regression"] } } },
      },
      (msg) => captured.push(msg),
    );

    expect(result.tdd).toEqual({});
    expect(result.mcp).toEqual({ servers: { graph: { command: "g", stages: ["review"] } } });
    expect(captured).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadConfig / loadConfigForWorkdir — the seam the loader actually uses
// ─────────────────────────────────────────────────────────────────────────────

describe("stripRemovedStageNames via loadConfig — end-to-end", () => {
  beforeEach(() => {
    _clearRootConfigCache();
    tempDirs.splice(0, tempDirs.length);
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      cleanupTempDir(dir);
    }
  });

  test("AC-13: loadConfig drops a removed stage from an MCP server's stage list", async () => {
    const root = await writeProjectConfig({
      mcp: { servers: { graph: { command: "g", stages: ["review", "regression"] } } },
    });

    const config = await loadConfig(root);

    expect(config.mcp?.servers.graph.stages).toEqual(["review"]);
  });

  test("AC-14: loadConfig warns once, naming the removed MCP stage", async () => {
    const root = await writeProjectConfig({
      mcp: { servers: { graph: { command: "g", stages: ["review", "regression"] } } },
    });

    const { messages } = await captureWarnings(() => loadConfig(root));

    const relevant = messages.filter((msg) =>
      msg.includes('Config value "regression" in mcp.servers.graph.stages has been removed'),
    );
    expect(relevant).toHaveLength(1);
  });

  test("AC-15: loadConfigForWorkdir drops a removed stage declared by a package profile", async () => {
    const root = makeTempDir("nax-removed-stage-mono-");
    tempDirs.push(root);
    const naxDir = join(root, ".nax");
    await mkdir(naxDir, { recursive: true });
    await Bun.write(join(naxDir, "config.json"), JSON.stringify({}));
    const monoDir = join(naxDir, "mono", "packages", "app");
    await mkdir(monoDir, { recursive: true });
    await Bun.write(join(monoDir, "config.json"), JSON.stringify({ profile: "p" }));
    const profileDir = join(root, "packages", "app", ".nax", "profiles");
    await mkdir(profileDir, { recursive: true });
    await Bun.write(
      join(profileDir, "p.json"),
      JSON.stringify({ mcp: { servers: { graph: { command: "g", stages: ["review", "regression"] } } } }),
    );

    const config = await loadConfigForWorkdir(join(naxDir, "config.json"), "packages/app");

    expect(config.mcp?.servers.graph.stages).toEqual(["review"]);
  });

  test("AC-16: loadConfig drops an un-inherited removed permission block", async () => {
    const root = await writeProjectConfig({ execution: { permissions: { rectification: { allow: ["Read"] } } } });

    const config = await loadConfig(root);

    expect(config.execution.permissions?.rectification).toBeUndefined();
  });

  test("AC-17: loadConfig warns once, naming the removed permission key", async () => {
    const root = await writeProjectConfig({ execution: { permissions: { rectification: { allow: ["Read"] } } } });

    const { messages } = await captureWarnings(() => loadConfig(root));

    const relevant = messages.filter((msg) =>
      msg.includes('Config key "execution.permissions.rectification" has been removed'),
    );
    expect(relevant).toHaveLength(1);
  });

  test("AC-18: loadConfig keeps a removed permission block another block inherits", async () => {
    const root = await writeProjectConfig({
      execution: { permissions: { acceptance: { allow: ["Read"] }, review: { inherit: "acceptance" } } },
    });

    const config = await loadConfig(root);

    expect(config.execution.permissions?.acceptance).toBeDefined();
  });

  test("AC-19: loadConfig warns nothing for an inherited removed permission block", async () => {
    const root = await writeProjectConfig({
      execution: { permissions: { acceptance: { allow: ["Read"] }, review: { inherit: "acceptance" } } },
    });

    const { messages } = await captureWarnings(() => loadConfig(root));

    const relevant = messages.filter(
      (msg) => msg.includes("execution.permissions.acceptance") && msg.includes("has been removed"),
    );
    expect(relevant).toHaveLength(0);
  });
});
