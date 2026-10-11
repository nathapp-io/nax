import type { AcceptanceGroupResult } from "@/cli";
import type { FinishContext, FinishOps, FinishReviewOutput, FinishState } from "@/finish";
import { createFinishState } from "@/finish";

export function makeFinishContext(overrides: Partial<FinishContext> = {}): FinishContext {
  const group: AcceptanceGroupResult = {
    packageDir: "",
    testPath: "test/acceptance/feat.test.ts",
    exists: true,
    cwd: "",
  };
  return {
    base: "origin/main",
    specPath: ".nax/features/feat/spec.md",
    acceptanceStatus: "ok",
    groups: [group],
    testFileRegex: ["\\.test\\.ts$"],
    commitsAhead: 3,
    route: "proceed",
    ...overrides,
  };
}

export function makeFinishState(overrides: Partial<FinishState> = {}): FinishState {
  const state = createFinishState({
    feature: "feat",
    workdir: "/repo",
    branch: "feat/x",
    runId: "run-1",
    base: "origin/main",
    specPath: ".nax/features/feat/spec.md",
  });
  return { ...state, ...overrides };
}

export const CLEAN_REVIEW: FinishReviewOutput = { findings: [], covered: [] };

/** Scripted A4 ops: each review call shifts the next scripted output (default clean). Records a call trail. */
export function makeFinishOps(
  trail: string[],
  script: { spec?: FinishReviewOutput[]; quality?: FinishReviewOutput[] } = {},
  overrides: Partial<FinishOps> = {},
): FinishOps {
  const spec = [...(script.spec ?? [])];
  const quality = [...(script.quality ?? [])];
  return {
    // Old ops members stay on FinishOps until Task 13 removes them; they must never run.
    review: async () => {
      throw new Error("old review path called");
    },
    narrate: async () => {
      throw new Error("old narrate path called");
    },
    escalate: async () => {
      throw new Error("old escalate path called");
    },
    reviewSpec: async () => {
      trail.push("review:spec");
      return spec.shift() ?? CLEAN_REVIEW;
    },
    reviewBranch: async () => {
      trail.push("review:quality");
      return quality.shift() ?? CLEAN_REVIEW;
    },
    fix: async (phase) => {
      trail.push(`fix:${phase}`);
      return {};
    },
    openDraftPr: async () => {
      trail.push("openDraftPr");
      return { url: "https://x/pr/1" };
    },
    promotePr: async () => {
      trail.push("promotePr");
      return { status: "promoted", url: "https://x/pr/1" };
    },
    finalizeDraftPr: async () => {
      trail.push("finalizeDraftPr");
      return { status: "draft", url: "https://x/pr/1" };
    },
    ...overrides,
  };
}
