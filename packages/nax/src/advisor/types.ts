/** A1 advisor types. Type-only module: no runtime code, no value imports. */
export type AdviceQuestionKind =
  | "finish-judgment"
  | "fix-cycle-give-up"
  | "uncategorised-failure"
  | "finish-approval"
  | "preflight"
  | "implementer-question"
  | "residual";

export interface AdviceEvidence {
  source: "finding" | "ac" | "spec" | "test-output" | "diff" | "agent-diagnosis" | "review-round" | "gate" | "decision";
  ref?: string;
  text: string;
}

export type SupersedeTarget = { kind: "ac"; storyId: string; acId: string } | { kind: "spec"; section: string };

export type AdviceAction =
  | { type: "fix"; instruction: string; updateAcs?: string[] }
  | { type: "waive"; reason: string }
  | { type: "supersede"; target: SupersedeTarget; newText: string }
  | { type: "retry"; instruction: string }
  | { type: "retarget"; to: "test" | "source"; instruction: string }
  | { type: "retry-as-lite" }
  | { type: "escalate-tier"; reason: string }
  | { type: "defer"; reason: string }
  | { type: "approve" }
  | { type: "re-review"; phase: "spec" | "quality" }
  | { type: "hold"; reason: string }
  | { type: "answer"; text: string }
  | { type: "carry"; instruction: string; toStories: string[] };

export type AdviceActionType = AdviceAction["type"];

/** Parameters the menu fixes; the advisor never chooses these. */
export interface AdviceOptionFixed {
  to?: "test" | "source";
  phase?: "spec" | "quality";
  target?: SupersedeTarget;
  /** Finish B 5.2: acceptance tests a fix-and-update ruling allows to change. */
  updateAcs?: string[];
  /** A5 PR3: the stories a carry option sends its instruction to. */
  toStories?: string[];
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
  /** Finish B §3.2: the ruled finding's `file`, copied onto the decision so later findings can match it. */
  anchorFile?: string;
  /** Finish B §3.2: the ruled finding's title, copied onto the decision. */
  rulingTitle?: string;
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
  /** Severity of the finding the question was about (finish judgment / give-up), when known. */
  findingSeverity?: string;
  /** Finish B §3.2: copied from the question; absent on lines written before finish B. */
  anchorFile?: string;
  rulingTitle?: string;
  /** Finish B 6.4: the acceptance tests a fix-and-update ruling allows to change. */
  acceptanceChanges?: string[];
  /** A5 PR3: the stories this ruling applies to (pre-flight conflict stories, or a carry's toStories). */
  appliesTo?: string[];
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
      pinnedAcs?: string[];
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
    }
  | { kind: "implementer-question" }
  | { kind: "residual"; dependents: string[]; scope?: "story" | "branch" }
  | { kind: "preflight"; acRef?: { storyId: string; acId: string }; specSection?: string };
