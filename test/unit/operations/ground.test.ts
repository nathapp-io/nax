import { afterEach, describe, expect, test } from "bun:test";
import { makeNaxConfig, makeTestRuntime, opModelResolver, opSelector } from "@test/helpers";
import type { RetryStrategy } from "@/agents";
import { ParseValidationError } from "@/agents";
import { NaxError } from "@/errors";
import { groundOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

function makeBuildCtx(grounderOverrides?: { model?: unknown; timeoutSeconds?: number }) {
  const base = grounderOverrides ? ({ debate: { grounder: grounderOverrides } } as any) : {};
  const config = makeNaxConfig(base);
  const runtime = makeTestRuntime({ config });
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(opSelector(groundOp.config)) };
}

describe("groundOp — identity", () => {
  test("kind/name/stage/session-role/session-lifetime/noFallback are correct", () => {
    expect(groundOp.kind).toBe("run");
    expect(groundOp.name).toBe("ground");
    expect(groundOp.stage).toBe("plan");
    expect(groundOp.session.role).toBe("grounder");
    expect(groundOp.session.lifetime).toBe("fresh");
    expect(groundOp.noFallback).toBe(true);
  });
});

describe("groundOp — model resolution", () => {
  const input = {
    specContent: "spec",
    codebaseContext: "ctx",
    workdir: "/tmp",
  };

  test("model resolver returns tier string, ConfiguredModelObject, or default 'fast'; GrounderInput has no model field", () => {
    expect(opModelResolver(groundOp)(input, makeBuildCtx({ model: "balanced" }))).toBe("balanced");
    const modelObj = { agent: "claude", model: "claude-opus-4-7" };
    expect(opModelResolver(groundOp)(input, makeBuildCtx({ model: modelObj }))).toEqual(modelObj);
    expect(opModelResolver(groundOp)(input, makeBuildCtx())).toBe("fast");
    expect(Object.keys(input)).not.toContain("model");
  });
});

describe("groundOp — timeoutMs", () => {
  const input = { specContent: "s", codebaseContext: "c", workdir: "/tmp" };

  test("timeoutMs returns timeoutSeconds * 1000; defaults to 1800s from DEFAULT_CONFIG", () => {
    expect(groundOp.timeoutMs?.(input, makeBuildCtx({ timeoutSeconds: 120 }))).toBe(120_000);
    expect(groundOp.timeoutMs?.(input, makeBuildCtx())).toBe(1_800_000);
  });
});

describe("groundOp — parse", () => {
  const inp = { specContent: "s", codebaseContext: "c", workdir: "/w" };

  test("parse returns FactsManifest for empty, entries-filled, and markdown-fenced JSON", () => {
    const ctx = makeBuildCtx();
    expect(groundOp.parse(JSON.stringify({ repoFacts: [], specClaims: [], gaps: [] }), inp, ctx)).toMatchObject({
      repoFacts: [],
      specClaims: [],
      gaps: [],
    });

    const manifest = {
      repoFacts: [{ id: "F-001", kind: "file", evidence: "e", summary: "s" }],
      specClaims: [
        { id: "S-001", specSpan: "span", claim: "claim", kind: "factual", verification: { status: "verified" } },
      ],
      gaps: [{ id: "G-001", kind: "missing-context", note: "note" }],
    };
    const r = groundOp.parse(JSON.stringify(manifest), inp, makeBuildCtx());
    expect(r.repoFacts[0]?.id).toBe("F-001");
    expect(r.specClaims[0]?.id).toBe("S-001");
    expect(r.gaps[0]?.id).toBe("G-001");

    const fenced = `\`\`\`json\n${JSON.stringify({ repoFacts: [], specClaims: [], gaps: [] })}\n\`\`\``;
    expect(groundOp.parse(fenced, inp, makeBuildCtx()).repoFacts).toEqual([]);
  });

  test("parse throws GROUNDER_PARSE_FAILED for non-JSON, schema-violating id, and empty required field", () => {
    const invalids = [
      "not json at all",
      JSON.stringify({ repoFacts: [{ id: "X-999", kind: "file", evidence: "e", summary: "s" }] }),
      JSON.stringify({ repoFacts: [{ id: "F-001", kind: "file", evidence: "", summary: "s" }] }),
    ];
    for (const bad of invalids) {
      let caught: unknown;
      try {
        groundOp.parse(bad, inp, makeBuildCtx());
      } catch (err) {
        caught = err;
      }
      expect(caught instanceof NaxError, bad).toBe(true);
      if (caught instanceof NaxError) expect(caught.code, bad).toBe("GROUNDER_PARSE_FAILED");
    }
  });
});

describe("groundOp — retry", () => {
  const input = { specContent: "spec", codebaseContext: "ctx", workdir: "/tmp" };

  test("retry has shouldRetry; returns retry=true for invalid JSON and for schema-invalid JSON with null fields", () => {
    const ctx = makeBuildCtx();
    const retryResult = (typeof groundOp.retry === "function" ? groundOp.retry(input, ctx) : groundOp.retry) as
      | RetryStrategy
      | undefined;
    expect(retryResult).toBeDefined();
    expect(typeof retryResult?.shouldRetry).toBe("function");

    const base = { site: "run" as const, agentName: "claude", stage: "plan" as const, storyId: "US-001" };
    expect(retryResult?.shouldRetry(new ParseValidationError("probe"), 0, { ...base, lastOutput: "not json" })).toEqual(
      {
        retry: true,
        delayMs: 0,
        nextPrompt: expect.stringContaining("Response was not valid JSON"),
      },
    );

    const invalidManifest = JSON.stringify({
      repoFacts: [{ id: "F-001", kind: "file", evidence: "src/x.ts:1", summary: "summary" }],
      specClaims: [
        {
          id: "S-001",
          specSpan: "span",
          claim: "claim",
          kind: "factual",
          verification: { status: "verified", factId: null, evidence: null },
        },
      ],
      gaps: [{ id: "G-001", kind: "missing-context", note: "note", evidence: null }],
    });
    expect(
      retryResult?.shouldRetry(new ParseValidationError("probe"), 0, { ...base, lastOutput: invalidManifest }),
    ).toEqual({
      retry: true,
      delayMs: 0,
      nextPrompt: expect.stringContaining("Do NOT use null"),
    });
  });
});

describe("groundOp — build", () => {
  test("build returns non-empty role and task; includes specContent in prompt", () => {
    const ctx = makeBuildCtx();
    const r1 = groundOp.build({ specContent: "spec content", codebaseContext: "codebase ctx", workdir: "/tmp" }, ctx);
    expect(r1.role).toBeTruthy();
    expect(r1.task).toBeTruthy();
    expect(r1.task.content).toBeTruthy();

    const r2 = groundOp.build(
      { specContent: "UNIQUE_SPEC_CONTENT", codebaseContext: "ctx", workdir: "/tmp" },
      makeBuildCtx(),
    );
    expect(r2.role.content + r2.task.content).toContain("UNIQUE_SPEC_CONTENT");
  });
});

describe("groundOp — export from operations barrel", () => {
  test("groundOp is exported from src/operations/index.ts", async () => {
    const ops = await import("@/operations");
    expect(ops.groundOp).toBeDefined();
    expect(ops.groundOp.name).toBe("ground");
  });
});
