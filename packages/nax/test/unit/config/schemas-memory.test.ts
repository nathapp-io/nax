/**
 * US-001 — the `memory` config block.
 *
 * Pins the repository-wide memory defaults, the `.strict()` rejections that keep
 * a future feature's keys (`stages`, `koda`) out until its schema owns them, the
 * `memoryConfigOf` accessor every reader goes through (`NaxConfig.memory` is
 * optional on the hand-written interface), and the `FIELD_DESCRIPTIONS`
 * entries that make the block discoverable in `nax config`.
 *
 * The `inRun` block (`memory-run-stages` US-001) covers the workflow-run
 * switch: it defaults on, an explicit `false` survives the parse, a
 * non-boolean fails on its own path, and `stages` stays an unknown key now that
 * the run switch exists.
 */

import { describe, expect, test } from "bun:test";
import { FIELD_DESCRIPTIONS } from "@/cli/config-descriptions";
import { MemoryConfigSchema, memoryConfigOf, NaxConfigSchema } from "@/config";

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

describe("memory config defaults (AC-1)", () => {
  test("NaxConfigSchema.parse({}).memory equals the documented defaults", () => {
    expect(NaxConfigSchema.parse({}).memory).toEqual(DEFAULT_MEMORY);
  });
});

describe("memory config rejections (AC-2..AC-6)", () => {
  test("AC-2: provider 'koda' fails on ['memory', 'provider']", () => {
    expect(memoryIssuePaths({ provider: "koda" })).toContainEqual(["memory", "provider"]);
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

describe("config barrel exports (AC-16)", () => {
  test("memoryConfigOf and MemoryConfigSchema are importable from @/config", () => {
    expect(typeof memoryConfigOf).toBe("function");
    expect(typeof MemoryConfigSchema.parse).toBe("function");
    expect(MemoryConfigSchema.parse({})).toEqual(DEFAULT_MEMORY);
  });
});
