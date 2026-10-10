import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import type { AdviceDecision } from "@/advisor";
import { appendDecision } from "@/advisor";
import { AdvisorDecisionsProvider } from "@/context/engine/providers/advisor-decisions";
import { STAGE_CONTEXT_MAP } from "@/context/engine/stage-config";
import type { ContextRequest } from "@/context/engine/types";

type Draft = Omit<AdviceDecision, "id" | "auditRef">;
const base: Draft = {
  questionId: "Q",
  kind: "fix-cycle-give-up",
  storyId: "US-1",
  chosenOptionId: "A",
  action: { type: "retry", instruction: "follow AC-3 literally" },
  rationale: "the AC wins",
  confidence: "high",
  reversible: true,
  needsHumanConfirm: false,
  decidedAt: "t",
  model: "m",
  memoryMode: "stateless",
};

/** A decision the advisor really wrote: ledger line + its audit artifact under outputDir. */
async function write(dir: string, d: Partial<Draft>, trusted = true): Promise<void> {
  const rec = await appendDecision(dir, "feat", (id) => ({ ...base, ...d, auditRef: `advisor-audit/feat/${id}.json` }));
  if (trusted) await Bun.write(join(dir, "out", rec.auditRef), "{}");
}

function req(dir: string, over: Partial<ContextRequest> = {}): ContextRequest {
  return {
    storyId: "US-1",
    featureId: "feat",
    repoRoot: dir,
    outputDir: join(dir, "out"),
    packageDir: dir,
    stage: "rectify",
    role: "implementer",
    budgetTokens: 8_000,
    ...over,
  };
}

const texts = async (dir: string, over: Partial<ContextRequest> = {}) =>
  (await new AdvisorDecisionsProvider().fetch(req(dir, over))).chunks.map((c) => c.content);

describe("AdvisorDecisionsProvider", () => {
  test("emits this story's decisions as feature-kind (floor-included) chunks", async () => {
    await withTempDir(async (dir) => {
      await write(dir, {});
      const r = await new AdvisorDecisionsProvider().fetch(req(dir));
      expect(r.chunks).toHaveLength(1);
      expect(r.chunks[0]?.kind).toBe("feature");
      expect(r.chunks[0]?.content).toContain("Advisor decision D-1 (retry): the AC wins");
      expect(r.chunks[0]?.content).toContain("follow AC-3 literally");
    });
  });

  test("a spec supersede reaches every story; an AC supersede reaches its story", async () => {
    await withTempDir(async (dir) => {
      await write(dir, {
        storyId: "US-9",
        action: { type: "supersede", target: { kind: "spec", section: "Design" }, newText: "two methods" },
      });
      await write(dir, {
        storyId: "US-9",
        action: { type: "supersede", target: { kind: "ac", storyId: "US-1", acId: "AC-3" }, newText: "returns 0" },
      });
      await write(dir, { storyId: "US-9", action: { type: "retry", instruction: "x" } });
      const out = await texts(dir);
      expect(out).toHaveLength(2);
      expect(out.join("\n")).toContain("spec § Design is superseded by advisor decision D-1: two methods");
      expect(out.join("\n")).toContain("US-1 AC-3 is superseded by advisor decision D-2: returns 0");
    });
  });

  test("a waive of a blocking finding is never handed to an agent as settled (same rule as the review prompt)", async () => {
    await withTempDir(async (dir) => {
      await write(dir, { action: { type: "waive", reason: "x" }, findingSeverity: "error" });
      await write(dir, { action: { type: "waive", reason: "y" }, findingSeverity: "warning" });
      const out = await texts(dir);
      expect(out).toHaveLength(1);
      expect(out[0]).toContain("D-2");
    });
  });

  test("an untrusted ledger line (no audit artifact) never reaches a prompt", async () => {
    await withTempDir(async (dir) => {
      await write(dir, {}, false);
      expect(await texts(dir)).toEqual([]);
    });
  });

  test("no feature, no outputDir, or no ledger → empty, never throws", async () => {
    await withTempDir(async (dir) => {
      expect(await texts(dir)).toEqual([]);
      await write(dir, {});
      expect(await texts(dir, { featureId: undefined })).toEqual([]);
      expect(await texts(dir, { outputDir: undefined })).toEqual([]);
    });
  });

  test("is wired into the implementer, test-writer, rectify and review stages", () => {
    for (const key of [
      "rectify",
      "tdd-implementer",
      "tdd-test-writer",
      "single-session",
      "review-semantic",
      "review-adversarial",
    ] as const) {
      expect(STAGE_CONTEXT_MAP[key].providerIds).toContain("advisor-decisions");
    }
    expect(STAGE_CONTEXT_MAP.plan.providerIds).not.toContain("advisor-decisions");
  });
});

describe("AdvisorDecisionsProvider — through the default orchestrator (rectify stage)", () => {
  test("a ruling written to the ledger appears in the next rectify bundle's prompt text", async () => {
    const { createDefaultOrchestrator } = await import("@/context/engine");
    const { makeNaxConfig, makeStory } = await import("@test/helpers");
    await withTempDir(async (dir) => {
      await write(dir, { action: { type: "retry", instruction: "make the page-2 window ascending per AC-4" } });
      const orchestrator = createDefaultOrchestrator(makeStory({ id: "US-1" }), makeNaxConfig());
      const bundle = await orchestrator.assemble({
        ...req(dir),
        providerIds: ["advisor-decisions"],
        touchedFiles: [],
        storyScratchDirs: [],
      });
      expect(bundle.pushMarkdown).toContain("make the page-2 window ascending per AC-4");
    });
  });
});
