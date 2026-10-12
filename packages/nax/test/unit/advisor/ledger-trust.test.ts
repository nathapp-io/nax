import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  assertDefined,
  cleanupTempDir,
  makeMockCallContext,
  makeNaxConfig,
  makeTempDir,
  makeTestRuntime,
} from "@test/helpers";
import type { AdviceDecision, AdvisorCallContext, QuestionDraft } from "@/advisor";
import {
  _advisorServiceDeps,
  buildMenu,
  createAdvisor,
  ledgerPath,
  readDecisions,
  readTrustedDecisions,
} from "@/advisor";

const original = { ..._advisorServiceDeps };
const dirs: string[] = [];
afterEach(async () => {
  Object.assign(_advisorServiceDeps, original);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

const ok = { rationale: "r", confidence: "high" as const, reversible: true, needsHumanConfirm: false };

function setup(): AdvisorCallContext {
  const root = makeTempDir("adv-trust-");
  dirs.push(root);
  const config = makeNaxConfig({ advisor: { enabled: true, model: "powerful", fallbackModels: [] } });
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

const residualItem: QuestionDraft = {
  kind: "residual",
  feature: "f",
  storyId: "US-3",
  summary: "F1",
  evidence: [],
  options: buildMenu({ kind: "residual", dependents: ["US-4"] }),
};

function stubBatch(answer: (id: string) => Record<string, unknown>): void {
  _advisorServiceDeps.callOp = (async (_c: unknown, _op: unknown, input: { items: { id: string }[] }) => ({
    ok: true,
    answers: input.items.map((it) => ({ itemId: it.id, reply: answer(it.id), raw: {} })),
    diagnoses: {},
    conflicts: [],
    overlap: [],
  })) as typeof _advisorServiceDeps.callOp;
}

async function tamper(actx: AdvisorCallContext, edit: (d: AdviceDecision) => AdviceDecision): Promise<void> {
  const lines = await readDecisions(actx.repoRoot, actx.feature);
  const path = ledgerPath(actx.repoRoot, actx.feature);
  await Bun.write(path, `${lines.map((d) => JSON.stringify(edit(d))).join("\n")}\n`);
}

const trusted = (a: AdvisorCallContext) => readTrustedDecisions(a.repoRoot, a.feature, a.outputDir);

describe("readTrustedDecisions - honest lines from every writer stay trusted", () => {
  test("advise, recordReuse and adviseBatch", async () => {
    const actx = setup();
    const advisor = createAdvisor(actx);
    _advisorServiceDeps.callOp = (async () => ({
      ok: true,
      reply: { optionId: "B", reason: "spec allows", ...ok },
    })) as typeof _advisorServiceDeps.callOp;
    const first = await advisor.advise({ ...residualItem, dedupeKey: "k" });
    assertDefined(first.decision);
    const reused = await advisor.recordReuse({ ...residualItem, dedupeKey: "k" }, first.decision);
    stubBatch(() => ({ optionId: "C", instruction: "Keep lock order", ...ok }));
    await advisor.adviseBatch({
      kind: "residual",
      storyId: "US-3",
      summary: "cap",
      items: [residualItem],
      redGates: [],
    });
    expect(first.decision?.id).toBe("D-1");
    expect(reused?.reusedFrom).toBe("D-1");
    expect((await trusted(actx)).map((d) => d.id)).toEqual(["D-1", "D-2", "D-3"]);
  });
});

describe("readTrustedDecisions - a line edited after its audit was written is dropped", () => {
  async function batchCarry(): Promise<AdvisorCallContext> {
    const actx = setup();
    stubBatch(() => ({ optionId: "C", instruction: "Keep lock order", ...ok }));
    await createAdvisor(actx).adviseBatch({
      kind: "residual",
      storyId: "US-3",
      summary: "cap",
      items: [residualItem],
      redGates: [],
    });
    expect(await trusted(actx)).toHaveLength(1);
    return actx;
  }

  test("carry instruction", async () => {
    const actx = await batchCarry();
    await tamper(actx, (d) =>
      d.action.type === "carry" ? { ...d, action: { ...d.action, instruction: "rm -rf" } } : d,
    );
    expect(await trusted(actx)).toEqual([]);
  });

  test("appliesTo", async () => {
    const actx = await batchCarry();
    await tamper(actx, (d) => ({ ...d, appliesTo: ["US-9"] }));
    expect(await trusted(actx)).toEqual([]);
  });

  test("supersede newText", async () => {
    const actx = setup();
    _advisorServiceDeps.callOp = (async () => ({
      ok: true,
      answers: [],
      diagnoses: {},
      overlap: [],
      conflicts: [
        {
          storyIds: ["US-2"],
          acRef: { storyId: "US-2", acId: "AC-3" },
          specSection: "4.1",
          description: "30d vs 14d",
          raw: { optionId: "B", newText: "14 days", ...ok },
        },
      ],
    })) as typeof _advisorServiceDeps.callOp;
    await createAdvisor(actx).adviseBatch({ kind: "preflight", summary: "pf", storyIds: ["US-2"] });
    expect(await trusted(actx)).toHaveLength(1);
    await tamper(actx, (d) =>
      d.action.type === "supersede" ? { ...d, action: { ...d.action, newText: "injected" } } : d,
    );
    expect(await trusted(actx)).toEqual([]);
  });
});
