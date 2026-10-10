/** A1 advisor types. Type-only module: no runtime code, no value imports. */
export type AdviceQuestionKind = "finish-judgment" | "fix-cycle-give-up" | "uncategorised-failure" | "finish-approval";

export interface AdviceEvidence {
  source: "finding" | "ac" | "spec" | "test-output" | "diff" | "agent-diagnosis" | "review-round" | "gate" | "decision";
  ref?: string;
  text: string;
}

export type SupersedeTarget = { kind: "ac"; storyId: string; acId: string } | { kind: "spec"; section: string };

export type AdviceAction =
  | { type: "fix"; instruction: string }
  | { type: "waive"; reason: string }
  | { type: "supersede"; target: SupersedeTarget; newText: string }
  | { type: "retry"; instruction: string }
  | { type: "retarget"; to: "test" | "source"; instruction: string }
  | { type: "retry-as-lite" }
  | { type: "escalate-tier"; reason: string }
  | { type: "defer"; reason: string }
  | { type: "approve" }
  | { type: "re-review"; phase: "spec" | "quality" }
  | { type: "hold"; reason: string };

export type AdviceActionType = AdviceAction["type"];

/** Parameters the menu fixes; the advisor never chooses these. */
export interface AdviceOptionFixed {
  to?: "test" | "source";
  phase?: "spec" | "quality";
  target?: SupersedeTarget;
}

export interface AdviceOption {
  id: string;
  type: AdviceActionType;
  label: string;
  fixed?: AdviceOptionFixed;
}

export interface AdviceQuestion {
  id: string;
  kind: AdviceQuestionKind;
  feature: string;
  storyId?: string;
  dedupeKey?: string;
  askedAtSha: string;
  summary: string;
  evidence: AdviceEvidence[];
  options: AdviceOption[];
  /** Severity of the finding the question is about, for the forced-confirm rule. */
  findingSeverity?: string;
}

export type AdviceConfidence = "high" | "medium" | "low";

/** The advisor's validated reply (text fields the option type requires are present). */
export interface AdvisorReply {
  optionId: string;
  instruction?: string;
  reason?: string;
  newText?: string;
  rationale: string;
  confidence: AdviceConfidence;
  reversible: boolean;
  needsHumanConfirm: boolean;
}

export interface AdviceDecision {
  id: string;
  questionId: string;
  kind: AdviceQuestionKind;
  storyId?: string;
  dedupeKey?: string;
  chosenOptionId: string;
  action: AdviceAction;
  rationale: string;
  confidence: AdviceConfidence;
  reversible: boolean;
  needsHumanConfirm: boolean;
  reusedFrom?: string;
  decidedAt: string;
  model: string;
  memoryMode: "stateless" | "warm";
  auditRef: string;
}

export interface AdviceResult {
  decision: AdviceDecision | null;
  fallbackReason?: string;
}

/** Facts a caller supplies so `buildMenu` can decide which options are legal. */
export type MenuFacts =
  | {
      kind: "finish-judgment";
      citesAc?: { storyId: string; acId: string };
      citesSpecSection?: string;
      acceptanceEnabledForStory: boolean;
    }
  | {
      kind: "fix-cycle-give-up";
      isThreeSession: boolean;
      gaveUpTarget: "source" | "test";
      retryAvailable: boolean;
      retargetAvailable: boolean;
      budgetLeft: boolean;
      citesAc?: { storyId: string; acId: string };
      acceptanceEnabledForStory: boolean;
    }
  | { kind: "uncategorised-failure"; isThreeSession: boolean; isLite: boolean }
  | {
      kind: "finish-approval";
      allPhasesComplete: boolean;
      gatesGreen: boolean;
      reReviewUsed: boolean;
      reReviewPhase: "spec" | "quality";
    };
