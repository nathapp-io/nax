import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeMockCallContext, makeNaxConfig, makeTempDir, makeTestRuntime } from "@test/helpers";
import type { AdvisorCallContext } from "@/advisor";
import { _advisorServiceDeps, adviseBatch, buildMenu, readDecisions } from "@/advisor";
import { adviseBatchOp } from "@/operations";

const original = { ..._advisorServiceDeps };
const dirs: string[] = [];
afterEach(async () => {
  Object.assign(_advisorServiceDeps, original);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

function setup(fallbackModels: string[] = []): AdvisorCallContext {
  const root = makeTempDir("adv-batch-");
  dirs.push(root);
  const config = makeNaxConfig({ advisor: { enabled: true, model: "powerful", fallbackModels } });
  const runtime = makeTestRuntime({ config });
  _advisorServiceDeps.captureWorktreePatch = async () => ({ sha: "abc", patch: "", patchTruncated: false });
  _advisorServiceDeps.readPrdText = async () => "{}";
  return {
    callCtx: makeMockCallContext({ runtime, config }),
    repoRoot: root,
    outputDir: join(root, "out"),
    feature: "f",
    runId: "r",
    specPath: "spec.md",
    workdir: root,
  };
}

const residual = (n: number) => ({
  kind: "residual" as const,
  storyId: "US-3",
  summary: "cap",
  redGates: ["full-suite"],
  items: Array.from({ length: n }, (_, i) => ({
    kind: "residual" as const,
    feature: "f",
    storyId: "US-3",
    summary: `F${i + 1}`,
    evidence: [],
    options: buildMenu({ kind: "residual", dependents: ["US-4"] }),
  })),
});
const ok = { rationale: "r", confidence: "high" as const, reversible: true, needsHumanConfirm: false };

describe("adviseBatch residual", () => {
  test("valid answers become decisions; a missing or invalid one falls back alone (Review Focus 1)", async () => {
    const actx = setup();
    _advisorServiceDeps.callOp = (async (_c: unknown, op: { name: string }, input: { items: { id: string }[] }) => {
      expect(op.name).toBe(adviseBatchOp.name);
      const [a, b] = input.items;
      return {
        ok: true,
        answers: [
          { itemId: a?.id, reply: { optionId: "C", instruction: "Keep lock order", ...ok }, raw: {} },
          { itemId: b?.id, error: "optionId Z is not on the menu", raw: {} },
          { itemId: input.items[2]?.id, error: "no answer for this item", raw: null },
        ],
        diagnoses: { "full-suite": "port clash" },
        conflicts: [],
        overlap: [],
      };
    }) as typeof _advisorServiceDeps.callOp;
    const out = await adviseBatch(actx, residual(3));
    if (out.kind !== "residual") throw new Error("kind");
    expect(out.items.map((i) => i.decision?.action.type ?? null)).toEqual(["carry", null, null]);
    expect(out.items[0]?.decision?.appliesTo).toEqual(["US-4"]);
    expect(out.items[1]?.fallbackReason).toContain("not on the menu");
    expect(out.diagnoses).toEqual({ "full-suite": "port clash" });
    expect((await readDecisions(actx.repoRoot, "f")).map((d) => d.kind)).toEqual(["residual"]);
    expect(await Bun.file(join(actx.outputDir, "advisor-audit", "f", "D-1.json")).exists()).toBe(true);
  });

  test("every ladder model fails -> every item falls back, no throw, no decisions (Review Focus 2)", async () => {
    const actx = setup(["balanced"]);
    const tried: unknown[] = [];
    _advisorServiceDeps.callOp = (async (_c: unknown, _op: unknown, input: { model?: unknown }) => {
      tried.push(input.model);
      throw new Error("429 usage limit reached");
    }) as typeof _advisorServiceDeps.callOp;
    const out = await adviseBatch(actx, residual(2));
    expect(tried).toEqual(["powerful", "balanced"]);
    expect(out.items.every((i) => i.decision === null && (i.fallbackReason ?? "").includes("usage limit"))).toBe(true);
    expect(await readDecisions(actx.repoRoot, "f")).toEqual([]);
  });

  test("ok:false from the op tries the next model", async () => {
    const actx = setup(["balanced"]);
    let n = 0;
    _advisorServiceDeps.callOp = (async (_c: unknown, _op: unknown, input: { items: { id: string }[] }) => {
      n += 1;
      if (n === 1) return { ok: false, error: "no-json", preview: "" };
      return {
        ok: true,
        answers: input.items.map((it) => ({
          itemId: it.id,
          reply: { optionId: "A", reason: "spec allows", ...ok },
          raw: {},
        })),
        diagnoses: {},
        conflicts: [],
        overlap: [],
      };
    }) as typeof _advisorServiceDeps.callOp;
    const out = await adviseBatch(actx, residual(1));
    expect(out.items[0]?.decision?.action.type).toBe("waive");
    expect(out.items[0]?.decision?.model).toBe("balanced");
  });
});

describe("adviseBatch preflight", () => {
  test("conflicts validated against the built menu; appliesTo = known story ids (Review Focus 5)", async () => {
    const actx = setup();
    _advisorServiceDeps.callOp = (async () => ({
      ok: true,
      answers: [],
      diagnoses: {},
      overlap: [{ storyId: "US-1", specSections: ["3.2"] }],
      conflicts: [
        {
          storyIds: ["US-2", "US-9"],
          acRef: { storyId: "US-2", acId: "AC-3" },
          specSection: "4.1",
          description: "30d vs 14d",
          raw: { optionId: "B", newText: "14 days", ...ok },
        },
        {
          storyIds: ["US-2"],
          specSection: "4.1",
          description: "spec-only conflict",
          raw: { optionId: "B", newText: "x", ...ok },
        },
        {
          storyIds: ["US-9"],
          specSection: "5",
          description: "unknown story only",
          raw: { optionId: "A", newText: "y", ...ok },
        },
      ],
    })) as typeof _advisorServiceDeps.callOp;
    const out = await adviseBatch(actx, { kind: "preflight", summary: "pf", storyIds: ["US-1", "US-2"] });
    if (out.kind !== "preflight") throw new Error("kind");
    expect(out.overlap).toEqual([{ storyId: "US-1", specSections: ["3.2"] }]);
    expect(out.items).toHaveLength(2);
    expect(out.items[0]?.decision?.action).toEqual({
      type: "supersede",
      target: { kind: "ac", storyId: "US-2", acId: "AC-3" },
      newText: "14 days",
    });
    expect(out.items[0]?.decision?.appliesTo).toEqual(["US-2"]);
    expect(out.items[1]?.decision).toBeNull(); // option B needs an acRef the conflict lacks
  });

  test("zero conflicts -> empty items, no decisions", async () => {
    const actx = setup();
    _advisorServiceDeps.callOp = (async () => ({
      ok: true,
      answers: [],
      diagnoses: {},
      overlap: [],
      conflicts: [],
    })) as typeof _advisorServiceDeps.callOp;
    const out = await adviseBatch(actx, { kind: "preflight", summary: "pf", storyIds: ["US-1"] });
    expect(out.items).toEqual([]);
  });
});

describe("adviseBatch hardening", () => {
  test("batch decisions and audits record memoryMode stateless even when memory is warm (M1)", async () => {
    const actx = setup();
    const config = makeNaxConfig({ advisor: { enabled: true, model: "powerful", fallbackModels: [], memory: "warm" } });
    const warm = { ...actx, callCtx: makeMockCallContext({ runtime: makeTestRuntime({ config }), config }) };
    _advisorServiceDeps.callOp = (async (_c: unknown, _op: unknown, input: { items: { id: string }[] }) => ({
      ok: true,
      answers: input.items.map((it) => ({ itemId: it.id, reply: { optionId: "A", reason: "r", ...ok }, raw: {} })),
      diagnoses: {},
      conflicts: [],
      overlap: [],
    })) as typeof _advisorServiceDeps.callOp;
    const out = await adviseBatch(warm, residual(1));
    expect(out.items[0]?.decision?.memoryMode).toBe("stateless");
    const audit = JSON.parse(await Bun.file(join(actx.outputDir, "advisor-audit", "f", "D-1.json")).text());
    expect(audit.memoryMode).toBe("stateless");
  });

  test("a throwing heads-up channel never nulls decisions or skips audits (M7)", async () => {
    const actx = setup();
    const flagged = { ...ok, needsHumanConfirm: true };
    _advisorServiceDeps.callOp = (async (_c: unknown, _op: unknown, input: { items: { id: string }[] }) => ({
      ok: true,
      answers: input.items.map((it) => ({ itemId: it.id, reply: { optionId: "A", reason: "r", ...flagged }, raw: {} })),
      diagnoses: {},
      conflicts: [],
      overlap: [],
    })) as typeof _advisorServiceDeps.callOp;
    const throwing: AdvisorCallContext = {
      ...actx,
      headsUp: () => {
        throw new Error("channel down");
      },
    };
    const out = await adviseBatch(throwing, residual(2));
    expect(out.items.map((i) => i.decision?.id)).toEqual(["D-1", "D-2"]);
    expect(out.fallbackReason).toBeUndefined();
    for (const id of ["D-1", "D-2"]) {
      expect(await Bun.file(join(actx.outputDir, "advisor-audit", "f", `${id}.json`)).exists()).toBe(true);
    }
  });

  test("a pre-flight AC target in a story outside the batch is dropped (M3)", async () => {
    const actx = setup();
    _advisorServiceDeps.callOp = (async () => ({
      ok: true,
      answers: [],
      diagnoses: {},
      overlap: [],
      conflicts: [
        {
          storyIds: ["US-2"],
          acRef: { storyId: "US-999", acId: "AC-9" },
          specSection: "4.1",
          description: "has a spec section",
          raw: { optionId: "A", newText: "spec text", ...ok },
        },
        {
          storyIds: ["US-2"],
          acRef: { storyId: "US-999", acId: "AC-9" },
          description: "nothing left",
          raw: { optionId: "D", reason: "flag", ...ok },
        },
      ],
    })) as typeof _advisorServiceDeps.callOp;
    const out = await adviseBatch(actx, { kind: "preflight", summary: "pf", storyIds: ["US-2"] });
    if (out.kind !== "preflight") throw new Error("kind");
    expect(out.items).toHaveLength(1);
    expect(out.items[0]?.question.options.map((o) => o.id)).toEqual(["A", "D"]);
    expect(out.items[0]?.decision?.action).toEqual({
      type: "supersede",
      target: { kind: "spec", section: "4.1" },
      newText: "spec text",
    });
  });
});
