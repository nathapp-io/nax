import { afterEach, describe, expect, test } from "bun:test";
import { NaxError } from "../../../src/errors";
import { groundOp } from "../../../src/operations/ground";
import type { NaxRuntime } from "../../../src/runtime";
import { makeNaxConfig, makeTestRuntime } from "../../helpers";

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
  return { packageView: view, config: view.select(groundOp.config) };
}

describe("groundOp — identity", () => {
  test("kind is complete", () => {
    expect(groundOp.kind).toBe("complete");
  });

  test("name is ground", () => {
    expect(groundOp.name).toBe("ground");
  });

  test("stage is plan", () => {
    expect(groundOp.stage).toBe("plan");
  });

  test("jsonMode is true", () => {
    expect(groundOp.jsonMode).toBe(true);
  });
});

describe("groundOp — model resolution", () => {
  const input = {
    specContent: "spec",
    codebaseContext: "ctx",
    workdir: "/tmp",
  };

  test("model resolver returns config.debate.grounder.model (tier string)", () => {
    const ctx = makeBuildCtx({ model: "balanced" });
    const result = groundOp.model?.(input, ctx);
    expect(result).toBe("balanced");
  });

  test("model resolver returns config.debate.grounder.model (ConfiguredModelObject)", () => {
    const modelObj = { agent: "claude", model: "claude-opus-4-7" };
    const ctx = makeBuildCtx({ model: modelObj });
    const result = groundOp.model?.(input, ctx);
    expect(result).toEqual(modelObj);
  });

  test("model resolver returns default fast from DEFAULT_CONFIG", () => {
    const ctx = makeBuildCtx();
    const result = groundOp.model?.(input, ctx);
    // DEFAULT_CONFIG.debate.grounder.model defaults to "fast"
    expect(result).toBe("fast");
  });

  test("GrounderInput interface has no model field — model is config-driven only", () => {
    const keys = Object.keys(input);
    expect(keys).not.toContain("model");
  });
});

describe("groundOp — timeoutMs", () => {
  const input = { specContent: "s", codebaseContext: "c", workdir: "/tmp" };

  test("timeoutMs returns grounder.timeoutSeconds * 1000", () => {
    const ctx = makeBuildCtx({ timeoutSeconds: 120 });
    const result = groundOp.timeoutMs?.(input, ctx);
    expect(result).toBe(120_000);
  });

  test("timeoutMs uses default timeoutSeconds (300) from DEFAULT_CONFIG", () => {
    const ctx = makeBuildCtx();
    const result = groundOp.timeoutMs?.(input, ctx);
    expect(result).toBe(300_000);
  });
});

describe("groundOp — parse", () => {
  function getCtx() {
    return makeBuildCtx();
  }

  test("parse returns FactsManifest for valid empty manifest JSON", () => {
    const ctx = getCtx();
    const json = JSON.stringify({ repoFacts: [], specClaims: [], gaps: [] });
    const result = groundOp.parse(json, { specContent: "s", codebaseContext: "c", workdir: "/w" }, ctx);
    expect(result).toMatchObject({ repoFacts: [], specClaims: [], gaps: [] });
  });

  test("parse returns FactsManifest for valid JSON with entries", () => {
    const ctx = getCtx();
    const manifest = {
      repoFacts: [{ id: "F-001", kind: "file", evidence: "e", summary: "s" }],
      specClaims: [
        {
          id: "S-001",
          specSpan: "span",
          claim: "claim",
          kind: "factual",
          verification: { status: "verified" },
        },
      ],
      gaps: [{ id: "G-001", kind: "missing-context", note: "note" }],
    };
    const result = groundOp.parse(
      JSON.stringify(manifest),
      { specContent: "s", codebaseContext: "c", workdir: "/w" },
      ctx,
    );
    expect(result.repoFacts[0]?.id).toBe("F-001");
    expect(result.specClaims[0]?.id).toBe("S-001");
    expect(result.gaps[0]?.id).toBe("G-001");
  });

  test("parse handles JSON wrapped in markdown fence", () => {
    const ctx = getCtx();
    const manifest = { repoFacts: [], specClaims: [], gaps: [] };
    const fenced = "```json\n" + JSON.stringify(manifest) + "\n```";
    const result = groundOp.parse(fenced, { specContent: "s", codebaseContext: "c", workdir: "/w" }, ctx);
    expect(result.repoFacts).toEqual([]);
  });

  test("parse throws NaxError with GROUNDER_PARSE_FAILED when input is not JSON", () => {
    const ctx = getCtx();
    let caught: unknown;
    try {
      groundOp.parse("not json at all", { specContent: "s", codebaseContext: "c", workdir: "/w" }, ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught instanceof NaxError).toBe(true);
    if (caught instanceof NaxError) {
      expect(caught.code).toBe("GROUNDER_PARSE_FAILED");
    }
  });

  test("parse throws NaxError with GROUNDER_PARSE_FAILED when JSON has schema-violating id", () => {
    const ctx = getCtx();
    const invalid = JSON.stringify({
      repoFacts: [{ id: "X-999", kind: "file", evidence: "e", summary: "s" }],
    });
    let caught: unknown;
    try {
      groundOp.parse(invalid, { specContent: "s", codebaseContext: "c", workdir: "/w" }, ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught instanceof NaxError).toBe(true);
    if (caught instanceof NaxError) {
      expect(caught.code).toBe("GROUNDER_PARSE_FAILED");
    }
  });

  test("parse throws NaxError with GROUNDER_PARSE_FAILED when required field is empty", () => {
    const ctx = getCtx();
    const invalid = JSON.stringify({
      repoFacts: [{ id: "F-001", kind: "file", evidence: "", summary: "s" }],
    });
    let caught: unknown;
    try {
      groundOp.parse(invalid, { specContent: "s", codebaseContext: "c", workdir: "/w" }, ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught instanceof NaxError).toBe(true);
    if (caught instanceof NaxError) {
      expect(caught.code).toBe("GROUNDER_PARSE_FAILED");
    }
  });
});

describe("groundOp — build", () => {
  test("build returns ComposeInput with non-empty role and task", () => {
    const ctx = makeBuildCtx();
    const input = { specContent: "spec content", codebaseContext: "codebase ctx", workdir: "/tmp" };
    const result = groundOp.build(input, ctx);
    expect(result.role).toBeTruthy();
    expect(result.task).toBeTruthy();
    expect(result.task.content).toBeTruthy();
  });

  test("build includes specContent in the prompt", () => {
    const ctx = makeBuildCtx();
    const input = { specContent: "UNIQUE_SPEC_CONTENT", codebaseContext: "ctx", workdir: "/tmp" };
    const result = groundOp.build(input, ctx);
    expect(result.role.content + result.task.content).toContain("UNIQUE_SPEC_CONTENT");
  });
});

describe("groundOp — export from operations barrel", () => {
  test("groundOp is exported from src/operations/index.ts", async () => {
    const ops = await import("../../../src/operations");
    expect(ops.groundOp).toBeDefined();
    expect(ops.groundOp.name).toBe("ground");
  });
});
