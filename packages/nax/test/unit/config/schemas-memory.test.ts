/**
 * US-001 — the `memory` config block.
 *
 * Pins the repository-wide memory defaults, the `.strict()` rejections that keep
 * a future feature's key (`stages`) out until its schema owns it, the
 * `memoryConfigOf` accessor every reader goes through (`NaxConfig.memory` is
 * optional on the hand-written interface), and the `FIELD_DESCRIPTIONS`
 * entries that make the block discoverable in `nax config`.
 *
 * The `inRun` block (`memory-run-stages` US-001) covers the workflow-run
 * switch: it defaults on, an explicit `false` survives the parse, a
 * non-boolean fails on its own path, and `stages` stays an unknown key now that
 * the run switch exists.
 *
 * The `memory.koda` block (`memory-koda-provider` US-001) covers the third
 * provider: `"koda"` is a valid `memory.provider`, a complete koda block parses
 * with `headers` defaulted, and an incomplete one is reported at the missing
 * key. `koda` no longer appears among the rejections — its schema owns the key.
 */

import { describe, expect, test } from "bun:test";
import { FIELD_DESCRIPTIONS } from "@/cli/config-descriptions";
import {
  KODA_PROJECT_SLUG_RE,
  MemoryConfigSchema,
  MemoryKodaConfigSchema,
  memoryConfigOf,
  NaxConfigSchema,
} from "@/config";

const DEFAULT_MEMORY = {
  enabled: true,
  provider: "local",
  writeMode: "direct",
  indexBytes: 24576,
  askOnSave: true,
  inRun: true,
} as const;

/**
 * Parses `{ memory: input }` against the root schema and returns the issue
 * paths. Asserts the parse failed — a schema that silently accepts a value the
 * AC rejects would otherwise return an empty list and read as "no issues".
 */
function memoryIssuePaths(input: Record<string, unknown>): PropertyKey[][] {
  const result = NaxConfigSchema.safeParse({ memory: input });
  expect(result.success).toBe(false);
  return result.success ? [] : result.error.issues.map((issue) => issue.path);
}

/**
 * The complete koda config of memory-koda-provider US-001: the global `url` a
 * user puts in `~/.nax/config.json`, and the `project` `nax memory link` writes
 * into the project layer.
 */
const KODA_CONFIG = {
  memory: { provider: "koda", koda: { url: "https://koda.example/api", project: "rs-stock" } },
} as const;

describe("memory config defaults (AC-1)", () => {
  test("NaxConfigSchema.parse({}).memory equals the documented defaults", () => {
    expect(NaxConfigSchema.parse({}).memory).toEqual(DEFAULT_MEMORY);
  });
});

describe("memory config validation (AC-2..AC-6)", () => {
  // memory-koda-provider US-001 AC-1 replaced the "koda is not a provider"
  // rejection: the enum accepts "koda" once memory.koda names a url and a project.
  test("AC-2: provider 'koda' with memory.koda url and project parses", () => {
    const result = NaxConfigSchema.safeParse(KODA_CONFIG);
    expect(result.success).toBe(true);
    expect(result.success && result.data.memory.provider).toBe("koda");
  });

  test("AC-3: writeMode 'auto' fails on ['memory', 'writeMode']", () => {
    expect(memoryIssuePaths({ writeMode: "auto" })).toContainEqual(["memory", "writeMode"]);
  });

  test("AC-4: indexBytes 100 (below the floor) fails on ['memory', 'indexBytes']", () => {
    expect(memoryIssuePaths({ indexBytes: 100 })).toContainEqual(["memory", "indexBytes"]);
  });

  test("AC-5: indexBytes 300000 (above the ceiling) fails on ['memory', 'indexBytes']", () => {
    expect(memoryIssuePaths({ indexBytes: 300000 })).toContainEqual(["memory", "indexBytes"]);
  });

  test("AC-6: an unknown key (stages) fails — memory is strict", () => {
    const paths = memoryIssuePaths({ stages: ["run"] });
    expect(paths).toContainEqual(["memory"]);
  });
});

describe("memory config partial overrides (AC-7)", () => {
  test("AC-7: setting writeMode keeps askOnSave at its default", () => {
    expect(NaxConfigSchema.parse({ memory: { writeMode: "proposal" } }).memory.askOnSave).toBe(true);
  });
});

describe("memoryConfigOf (AC-8, AC-9)", () => {
  test("AC-8: absent memory returns the schema default", () => {
    expect(memoryConfigOf({})).toEqual(DEFAULT_MEMORY);
  });

  test("AC-9: a configured memory block is returned as given", () => {
    const configured = {
      enabled: false,
      provider: "local",
      writeMode: "direct",
      indexBytes: 4096,
      askOnSave: false,
      inRun: false,
    } as const;
    expect(memoryConfigOf({ memory: configured })).toEqual(configured);
  });

  test("memoryConfigOf({}) matches MemoryConfigSchema.parse({}) — one source of truth", () => {
    expect(memoryConfigOf({})).toEqual(MemoryConfigSchema.parse({}));
  });
});

describe("memory run switch — defaults (US-001 AC-1, AC-5)", () => {
  test("US-001 AC-1: NaxConfigSchema.parse({}).memory.inRun is true", () => {
    expect(NaxConfigSchema.parse({}).memory.inRun).toBe(true);
  });

  test("US-001 AC-1: inRun stays true when memory.enabled is false", () => {
    expect(NaxConfigSchema.parse({ memory: { enabled: false } }).memory.inRun).toBe(true);
  });

  test("US-001 AC-5: memoryConfigOf({}).inRun is true", () => {
    expect(memoryConfigOf({}).inRun).toBe(true);
  });
});

describe("memory run switch — explicit false (US-001 AC-2)", () => {
  test("US-001 AC-2: inRun false parses to false and every other key keeps its default", () => {
    const parsed = NaxConfigSchema.parse({ memory: { inRun: false } }).memory;
    expect(parsed.inRun).toBe(false);
    expect(parsed).toEqual({ ...DEFAULT_MEMORY, inRun: false });
  });

  test("US-001 AC-2: memoryConfigOf returns a configured inRun false unchanged", () => {
    expect(memoryConfigOf({ memory: { ...DEFAULT_MEMORY, inRun: false } }).inRun).toBe(false);
  });
});

describe("memory run switch — validation (US-001 AC-3, AC-4)", () => {
  test("US-001 AC-3: inRun 'yes' fails on ['memory', 'inRun']", () => {
    expect(memoryIssuePaths({ inRun: "yes" })).toContainEqual(["memory", "inRun"]);
  });

  test("US-001 AC-4: stages is still an unknown key, beside a valid inRun", () => {
    expect(memoryIssuePaths({ stages: ["run"] })).toContainEqual(["memory"]);
    expect(NaxConfigSchema.safeParse({ memory: { inRun: true, stages: ["run"] } }).success).toBe(false);
  });
});

describe("FIELD_DESCRIPTIONS memory.inRun (US-001 AC-6)", () => {
  const description = FIELD_DESCRIPTIONS["memory.inRun"];

  test("US-001 AC-6: memory.inRun is a non-empty string", () => {
    expect(description).toBeString();
    expect(description?.trim().length).toBeGreaterThan(0);
  });

  test("US-001 AC-6: the description names the run stage and its documented default", () => {
    expect(description?.toLowerCase()).toContain("run");
    // The default, not the word "true" anywhere: `(default: true)` is the doc's own
    // spelling of it, so a description that drops or flips the default fails here.
    expect(description).toContain("(default: true)");
  });
});

describe("FIELD_DESCRIPTIONS memory entries (AC-10..AC-15)", () => {
  test.each([
    ["memory"],
    ["memory.enabled"],
    ["memory.provider"],
    ["memory.writeMode"],
    ["memory.indexBytes"],
    ["memory.askOnSave"],
  ])("%s is a non-empty string", (key) => {
    expect(FIELD_DESCRIPTIONS[key]).toBeString();
    expect(FIELD_DESCRIPTIONS[key]?.trim().length).toBeGreaterThan(0);
  });
});

/** The MCP memory config of memory-mcp-provider US-001: one server `om` defined in `mcp.servers`. */
const MCP_SERVERS = { servers: { om: { url: "http://localhost:8765/mcp" } } };

function mcpConfig(memory: Record<string, unknown> = {}, mcp: Record<string, unknown> | undefined = MCP_SERVERS) {
  return { memory: { provider: "mcp", mcp: { server: "om" }, ...memory }, ...(mcp === undefined ? {} : { mcp }) };
}

/** `memory.mcp` with the given keys merged over `{ server: "om" }`. */
function mcpBlock(extra: Record<string, unknown>) {
  return mcpConfig({ mcp: { server: "om", ...extra } });
}

/** Asserts the parse failed and returns the issues as `{ path, message }`. */
function issuesOf(input: unknown): { path: PropertyKey[]; message: string }[] {
  const result = NaxConfigSchema.safeParse(input);
  expect(result.success).toBe(false);
  return result.success ? [] : result.error.issues.map(({ path, message }) => ({ path, message }));
}

describe("memory.mcp provider (memory-mcp-provider US-001 AC-1, AC-2, AC-5)", () => {
  test("AC-1: provider 'mcp' parses to 'mcp'", () => {
    expect(NaxConfigSchema.parse(mcpConfig()).memory.provider).toBe("mcp");
  });

  test("AC-2: memory.mcp { server } parses to the full defaults", () => {
    expect(NaxConfigSchema.parse(mcpConfig()).memory.mcp).toEqual({
      server: "om",
      tools: { search: "search_memory", add: "add_memories" },
      args: { query: "query", text: "text" },
    });
  });

  test("AC-5: the default memory block has no mcp key", () => {
    expect("mcp" in NaxConfigSchema.parse({}).memory).toBe(false);
  });
});

describe("memory.mcp forget tool (US-001 AC-3, AC-4)", () => {
  test("AC-3: tools.forget without args.id fails at ['memory','mcp','args','id']", () => {
    expect(issuesOf(mcpBlock({ tools: { forget: "delete_memory" } }))).toContainEqual({
      path: ["memory", "mcp", "args", "id"],
      message: "memory.mcp.args.id is required when memory.mcp.tools.forget is set",
    });
  });

  test("AC-4: tools.forget with args.id succeeds and keeps both", () => {
    const result = NaxConfigSchema.safeParse(
      mcpBlock({ tools: { forget: "delete_memory" }, args: { id: "memory_id" } }),
    );
    expect(result.success).toBe(true);
    expect(result.success && result.data.memory.mcp?.tools.forget).toBe("delete_memory");
    expect(result.success && result.data.memory.mcp?.args.id).toBe("memory_id");
  });
});

describe("memory.mcp cross-section rules (US-001 AC-6..AC-9)", () => {
  test("AC-6: provider 'mcp' without memory.mcp fails at ['memory','mcp']", () => {
    expect(issuesOf({ memory: { provider: "mcp" } })).toContainEqual({
      path: ["memory", "mcp"],
      message: 'memory.provider "mcp" needs a memory.mcp block naming the server',
    });
  });

  test("AC-7: a server not in mcp.servers fails at ['memory','mcp','server']", () => {
    const input = { memory: { provider: "mcp", mcp: { server: "om" } } };
    expect(issuesOf(input)).toContainEqual({
      path: ["memory", "mcp", "server"],
      message: 'memory.mcp.server "om" is not defined in mcp.servers',
    });
  });

  test("AC-7: a server missing from a non-empty mcp.servers also fails", () => {
    const input = mcpConfig({}, { servers: { other: { url: "http://localhost:1/mcp" } } });
    expect(issuesOf(input).map((issue) => issue.path)).toContainEqual(["memory", "mcp", "server"]);
  });

  test("AC-8: provider 'mcp' with writeMode 'proposal' fails at ['memory','writeMode']", () => {
    expect(issuesOf(mcpConfig({ writeMode: "proposal" }))).toContainEqual({
      path: ["memory", "writeMode"],
      message: 'memory.writeMode "proposal" needs a provider that holds pending writes; provider "mcp" does not',
    });
  });

  test("AC-9: an unused memory.mcp block under provider 'local' is valid", () => {
    expect(NaxConfigSchema.safeParse(mcpConfig({ provider: "local" })).success).toBe(true);
  });

  test("the four rules are independent: one config raises several issues", () => {
    const issues = issuesOf({
      memory: { provider: "mcp", writeMode: "proposal", mcp: { server: "om", tools: { forget: "rm" } } },
    });
    expect(issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        ["memory", "writeMode"],
        ["memory", "mcp", "server"],
        ["memory", "mcp", "args", "id"],
      ]),
    );
  });
});

describe("memory.mcp field validation (US-001 AC-10..AC-13)", () => {
  test("AC-10: an unknown key in memory.mcp fails", () => {
    expect(NaxConfigSchema.safeParse(mcpBlock({ extra: 1 })).success).toBe(false);
    expect(NaxConfigSchema.safeParse({ memory: { mcp: { server: "om", extra: 1 } }, mcp: MCP_SERVERS }).success).toBe(
      false,
    );
  });

  test("AC-11: server 'Bad Id' fails under ['memory','mcp','server']", () => {
    const paths = issuesOf(mcpBlock({ server: "Bad Id" })).map((issue) => issue.path.slice(0, 3));
    expect(paths).toContainEqual(["memory", "mcp", "server"]);
  });

  test("a server id containing '__' fails under ['memory','mcp','server']", () => {
    const paths = issuesOf(mcpBlock({ server: "a__b" })).map((issue) => issue.path.slice(0, 3));
    expect(paths).toContainEqual(["memory", "mcp", "server"]);
  });

  test("AC-12: tools.add '' fails under ['memory','mcp','tools','add']", () => {
    const paths = issuesOf(mcpBlock({ tools: { add: "" } })).map((issue) => issue.path.slice(0, 4));
    expect(paths).toContainEqual(["memory", "mcp", "tools", "add"]);
  });

  test("an empty args.text fails under ['memory','mcp','args','text']", () => {
    const paths = issuesOf(mcpBlock({ args: { text: "" } })).map((issue) => issue.path.slice(0, 4));
    expect(paths).toContainEqual(["memory", "mcp", "args", "text"]);
  });

  test("AC-13: provider 'koda' with no memory.koda fails at ['memory','koda','url'] (memory-koda-provider AC-4)", () => {
    expect(issuesOf({ memory: { provider: "koda" } })).toContainEqual({
      path: ["memory", "koda", "url"],
      message: 'memory.provider "koda" needs memory.koda.url in ~/.nax/config.json',
    });
  });

  test("custom tool and argument names survive the parse", () => {
    const parsed = NaxConfigSchema.parse(
      mcpBlock({ tools: { search: "s", add: "a" }, args: { query: "q", text: "t" } }),
    );
    expect(parsed.memory.mcp).toEqual({
      server: "om",
      tools: { search: "s", add: "a" },
      args: { query: "q", text: "t" },
    });
  });
});

describe("FIELD_DESCRIPTIONS memory.mcp entries (US-001 AC-14..AC-16)", () => {
  test.each([
    ["memory.mcp.server"],
    ["memory.mcp.tools.search"],
    ["memory.mcp.tools.add"],
    ["memory.mcp.tools.forget"],
    ["memory.mcp.args.query"],
    ["memory.mcp.args.text"],
    ["memory.mcp.args.id"],
  ])("%s is a non-empty string", (key) => {
    expect(FIELD_DESCRIPTIONS[key]).toBeString();
    expect(FIELD_DESCRIPTIONS[key]?.trim().length).toBeGreaterThan(0);
  });

  test("memory.provider no longer says only local is accepted", () => {
    expect(FIELD_DESCRIPTIONS["memory.provider"]).toContain("mcp");
    expect(FIELD_DESCRIPTIONS["memory.provider"]).not.toContain("Only");
  });
});

describe("config barrel exports (AC-16)", () => {
  test("memoryConfigOf and MemoryConfigSchema are importable from @/config", () => {
    expect(typeof memoryConfigOf).toBe("function");
    expect(typeof MemoryConfigSchema.parse).toBe("function");
    expect(MemoryConfigSchema.parse({})).toEqual(DEFAULT_MEMORY);
  });
});

/** `{ memory: { provider: "koda", koda } }` — the koda config under test, with the block as given. */
function kodaInput(koda: Record<string, unknown>, memory: Record<string, unknown> = {}) {
  return { memory: { provider: "koda", koda, ...memory } };
}

/**
 * The koda provider block (memory-koda-provider US-001). `"koda"` is a valid
 * `memory.provider` now, and `validateMemoryProvider` requires the url and the
 * project that make it reachable. AC-1 and AC-4 live in the two replaced tests
 * above ("memory config validation" / "memory.mcp field validation").
 */
describe("memory.koda provider (memory-koda-provider US-001 AC-2, AC-3, AC-5..AC-11)", () => {
  test("koda AC-2: memory.koda parses to { url, project, headers: {} }", () => {
    expect(NaxConfigSchema.parse(KODA_CONFIG).memory.koda).toEqual({
      url: "https://koda.example/api",
      project: "rs-stock",
      headers: {},
    });
  });

  test("koda AC-3: the default memory block has no koda key", () => {
    expect("koda" in NaxConfigSchema.parse({}).memory).toBe(false);
  });

  test("koda AC-5: provider 'koda' with a url but no project fails at ['memory','koda','project']", () => {
    expect(issuesOf(kodaInput({ url: "https://koda.example/api" }))).toContainEqual({
      path: ["memory", "koda", "project"],
      message: 'memory.provider "koda" needs memory.koda.project (run nax memory link <koda-project>)',
    });
  });

  test("koda AC-6: provider 'koda' with no memory.koda raises both the url and the project issue", () => {
    const paths = issuesOf({ memory: { provider: "koda" } }).map((issue) => issue.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        ["memory", "koda", "url"],
        ["memory", "koda", "project"],
      ]),
    );
  });

  test("koda AC-7: url 'ftp://koda.example' fails under ['memory','koda','url']", () => {
    const paths = issuesOf(kodaInput({ url: "ftp://koda.example", project: "rs-stock" })).map((issue) =>
      issue.path.slice(0, 3),
    );
    expect(paths).toContainEqual(["memory", "koda", "url"]);
  });

  test("koda AC-8: project 'RS_Stock' fails under ['memory','koda','project']", () => {
    const paths = issuesOf(kodaInput({ url: "https://koda.example/api", project: "RS_Stock" })).map((issue) =>
      issue.path.slice(0, 3),
    );
    expect(paths).toContainEqual(["memory", "koda", "project"]);
  });

  test("koda AC-9: an extra key memory.koda.token fails — the block is strict", () => {
    const koda = { url: "https://koda.example/api", project: "rs-stock", token: "secret" };
    expect(NaxConfigSchema.safeParse(kodaInput(koda)).success).toBe(false);
  });

  test("koda AC-10: writeMode 'proposal' is valid with provider 'koda'", () => {
    expect(
      NaxConfigSchema.safeParse(
        kodaInput({ url: "https://koda.example/api", project: "rs-stock" }, { writeMode: "proposal" }),
      ).success,
    ).toBe(true);
  });

  test("koda AC-11: a koda block under provider 'local' is valid and unused", () => {
    expect(NaxConfigSchema.safeParse({ memory: { provider: "local", koda: { project: "rs-stock" } } }).success).toBe(
      true,
    );
  });
});

describe("memory.koda url rules (memory-koda-provider US-001 AC-15, AC-16)", () => {
  test("koda AC-15: a remote plain-http url reports the https-unless-loopback message", () => {
    expect(issuesOf(kodaInput({ url: "http://koda.example/api", project: "rs-stock" }))).toContainEqual({
      path: ["memory", "koda", "url"],
      message: "memory.koda.url must use https unless the host is loopback",
    });
  });

  test("koda AC-16: a loopback plain-http url is accepted", () => {
    expect(
      NaxConfigSchema.safeParse(kodaInput({ url: "http://localhost:8030/api", project: "rs-stock" })).success,
    ).toBe(true);
  });
});

describe("memory defaults survive the koda provider (memory-koda-provider US-001 AC-17, AC-18)", () => {
  test("koda AC-17: the default memory block keeps the existing local defaults", () => {
    expect(NaxConfigSchema.parse({}).memory).toEqual(DEFAULT_MEMORY);
  });

  test("koda AC-18: an MCP config with writeMode 'proposal' still fails at ['memory','writeMode']", () => {
    expect(issuesOf(mcpConfig({ writeMode: "proposal" }))).toContainEqual({
      path: ["memory", "writeMode"],
      message: 'memory.writeMode "proposal" needs a provider that holds pending writes; provider "mcp" does not',
    });
  });
});

describe("memory.koda exports from @/config (memory-koda-provider US-001 AC-12..AC-14)", () => {
  test("koda AC-12: KODA_PROJECT_SLUG_RE accepts 'rs-stock'", () => {
    expect(KODA_PROJECT_SLUG_RE.test("rs-stock")).toBe(true);
  });

  test("koda AC-13: KODA_PROJECT_SLUG_RE rejects '-rs'", () => {
    expect(KODA_PROJECT_SLUG_RE.test("-rs")).toBe(false);
  });

  test("koda AC-14: MemoryKodaConfigSchema parses { project } to { project, headers: {} }", () => {
    expect(MemoryKodaConfigSchema.parse({ project: "rs-stock" })).toEqual({ project: "rs-stock", headers: {} });
  });
});
