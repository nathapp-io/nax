/**
 * US-011 (memory-compaction) — the compaction operation and its structural plan parser.
 *
 * The parser is deliberately structural: it answers "is this reply the shape a plan has?" and
 * nothing else. Whether a named slug is a candidate, whether a merge's sources share one type
 * and whether a target slug is free needs the mirror, and that is `validateMemoryCompactionPlan`
 * (US-002). Every malformed reply comes back as `null`, never as a throw, because the caller
 * (`compactProjectMemory`, US-014) turns `null` into the `unparseable` outcome.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { MemoryNote } from "@nathapp/nax-agent";
import type { MemoryCompactionPlan } from "@nathapp/nax-agent/internal";
import { makeNaxConfig, makeTestRuntime, opSelector } from "@test/helpers";
import { memoryCompactConfigSelector } from "@/config";
import type { MemoryCompactInput } from "@/operations";
import { memoryCompactOp, parseMemoryCompactionPlan } from "@/operations";
import { buildMemoryCompactPrompt } from "@/prompts";
import type { NaxRuntime } from "@/runtime";

const runtimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
  runtimes.length = 0;
});

function buildCtx() {
  const runtime = makeTestRuntime();
  runtimes.push(runtime);
  const packageView = runtime.packages.repo();
  return { packageView, config: packageView.select(memoryCompactConfigSelector) };
}

const note: MemoryNote = {
  id: "note-1",
  slug: "a-note",
  type: "project",
  scope: "project",
  description: "a fact",
  source: "nax-chat",
  updatedAt: "2026-01-01T00:00:00Z",
  status: "active",
  body: "the body",
};

const input: MemoryCompactInput = {
  notes: [note],
  features: [{ name: "memory-compaction", passed: 11, total: 21 }],
  branches: ["main"],
  commits: ["feat: something"],
  fillPercent: 84,
  targetPercent: 80,
};

const retire = { slug: "old-note", reason: "its subject shipped" };
const merge = {
  from: ["a-note", "b-note"],
  into: { slug: "merged-note", type: "project", description: "one line", body: "what is still true" },
} satisfies MemoryCompactionPlan["merge"][number];

const fenced = (value: unknown): string => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

describe("parseMemoryCompactionPlan", () => {
  test("AC-1: returns the plan for a fenced JSON reply with one retire and one merge", () => {
    expect(parseMemoryCompactionPlan(fenced({ retire: [retire], merge: [merge] }))).toEqual({
      retire: [retire],
      merge: [merge],
    });
  });

  test("AC-2: reads an absent merge array as []", () => {
    expect(parseMemoryCompactionPlan(JSON.stringify({ retire: [retire] }))).toEqual({ retire: [retire], merge: [] });
  });

  test("AC-3: reads an absent retire array as []", () => {
    expect(parseMemoryCompactionPlan(JSON.stringify({ merge: [merge] }))).toEqual({ retire: [], merge: [merge] });
  });

  test("AC-4: returns null for a reply that is not JSON", () => {
    expect(parseMemoryCompactionPlan("I could not find anything worth retiring.")).toBeNull();
  });

  test("AC-5: returns null when retire is present but is not an array", () => {
    expect(parseMemoryCompactionPlan(JSON.stringify({ retire }))).toBeNull();
  });

  test("AC-6: returns null when a retire entry's reason is not a string", () => {
    expect(parseMemoryCompactionPlan(JSON.stringify({ retire: [{ slug: "old-note", reason: 7 }] }))).toBeNull();
  });

  test.each([["a string"], [["a-note", 7]], [["a-note", null]]])(
    "AC-7: returns null when a merge's from is not an array of strings: %j",
    (from) => {
      expect(parseMemoryCompactionPlan(JSON.stringify({ merge: [{ from, into: merge.into }] }))).toBeNull();
    },
  );

  test("AC-8: returns null when a merge's into lacks a string body", () => {
    const noBody = { slug: merge.into.slug, type: merge.into.type, description: merge.into.description };
    expect(parseMemoryCompactionPlan(JSON.stringify({ merge: [{ from: merge.from, into: noBody }] }))).toBeNull();
    expect(
      parseMemoryCompactionPlan(JSON.stringify({ merge: [{ from: merge.from, into: { ...merge.into, body: 1 } }] })),
    ).toBeNull();
  });
});

describe("memoryCompactOp", () => {
  test("AC-9: has kind complete and name memory-compact", () => {
    expect(memoryCompactOp.kind).toBe("complete");
    expect(memoryCompactOp.name).toBe("memory-compact");
  });

  test("AC-10: has stage plan", () => {
    expect(memoryCompactOp.stage).toBe("plan");
  });

  test("AC-11: config is memoryCompactConfigSelector, which selects the memory block", () => {
    const config = makeNaxConfig();
    expect(memoryCompactOp.config).toBe(memoryCompactConfigSelector);
    expect(opSelector(memoryCompactOp.config).select(config)).toEqual({ memory: config.memory });
  });

  test("AC-12: model(input) returns input.model when it is set", () => {
    const model = memoryCompactOp.model;
    if (typeof model !== "function") throw new Error("Expected a model resolver");
    const pinned = { agent: "native", model: "openai/gpt-5" } as const;
    expect(model({ ...input, model: pinned }, buildCtx())).toEqual(pinned);
  });

  test("AC-13: model(input) returns balanced when input.model is absent", () => {
    const model = memoryCompactOp.model;
    if (typeof model !== "function") throw new Error("Expected a model resolver");
    expect(model(input, buildCtx())).toBe("balanced");
  });

  test("AC-14: build(input) puts buildMemoryCompactPrompt(input) in its task section", () => {
    const built = memoryCompactOp.build(input, buildCtx());
    expect(built.task.content).toBe(buildMemoryCompactPrompt(input));
  });

  test("AC-15: parse returns null rather than throwing for an unusable reply", () => {
    const ctx = buildCtx();
    expect(() => memoryCompactOp.parse("not a plan", input, ctx)).not.toThrow();
    expect(memoryCompactOp.parse("not a plan", input, ctx)).toBeNull();
    expect(memoryCompactOp.parse(JSON.stringify({ retire: "everything" }), input, ctx)).toBeNull();
  });

  test("AC-16: memoryCompactOp and parseMemoryCompactionPlan are importable from @/operations", async () => {
    const barrel = await import("@/operations");
    expect(barrel.memoryCompactOp.name).toBe("memory-compact");
    expect(typeof barrel.parseMemoryCompactionPlan).toBe("function");
  });
});
