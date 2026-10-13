/**
 * Closed option menus and deterministic guardrails for the A1 advisor (spec §4.3, §12).
 * Pure: no I/O, no clock. The advisor only ever picks one of these options.
 */
import type { AdviceAction, AdviceActionType, AdviceOption, AdviceOptionFixed, AdvisorReply, MenuFacts } from "./types";

const OPTION_IDS = "ABCDEFGHIJ";

const LABELS: Record<AdviceActionType, string> = {
  fix: "Fix it, with the approach you describe",
  waive: "Waive it: keep the code as is (state the spec- or scope-backed reason)",
  supersede: "Supersede: the spec/AC is wrong and the code is right (give the corrected text)",
  retry: "Retry the same fix strategy once more, with your ruling as guidance",
  retarget: "Hand it across the TDD boundary to the other fixer, with your ruling",
  "retry-as-lite": "Retry the story in three-session-tdd-lite mode",
  "escalate-tier": "Escalate the story to the next model tier",
  defer: "Defer to a human (pause the story), with your diagnosis",
  approve: "Approve: promote the PR",
  "re-review": "Run one more review pass before deciding",
  hold: "Hold: escalate to a human instead of proceeding",
  answer: "Answer the implementer's question (put the answer in instruction)",
  carry: "Load-bearing: carry an instruction into the dependent stories",
};

/** Text field each action needs from the advisor's reply; null = none. */
export const REQUIRED_TEXT_FIELD: Record<AdviceActionType, "instruction" | "reason" | "newText" | null> = {
  fix: "instruction",
  waive: "reason",
  supersede: "newText",
  retry: "instruction",
  retarget: "instruction",
  "retry-as-lite": null,
  "escalate-tier": "reason",
  defer: "reason",
  approve: null,
  "re-review": null,
  hold: "reason",
  answer: "instruction",
  carry: "instruction",
};

type Draft = { type: AdviceActionType; fixed?: AdviceOptionFixed; label?: string; id?: string };

function withIds(drafts: readonly Draft[]): AdviceOption[] {
  return drafts.map((d, i) => ({
    id: d.id ?? OPTION_IDS[i] ?? String(i),
    type: d.type,
    label: d.label ?? LABELS[d.type],
    ...(d.fixed ? { fixed: d.fixed } : {}),
  }));
}

export const PREFLIGHT_OPTION_IDS = { followAc: "A", followSpec: "B", reconcile: "C", flag: "D" } as const;

function preflightDrafts(f: Extract<MenuFacts, { kind: "preflight" }>): Draft[] {
  const followAc: Draft[] = f.specSection
    ? [
        {
          id: PREFLIGHT_OPTION_IDS.followAc,
          type: "supersede",
          fixed: { target: { kind: "spec", section: f.specSection } },
          label: "Follow the AC: supersede the spec section (give the corrected spec text)",
        },
      ]
    : [];
  const acTarget = f.acRef ? { target: { kind: "ac" as const, ...f.acRef } } : undefined;
  const onAc: Draft[] = acTarget
    ? [
        {
          id: PREFLIGHT_OPTION_IDS.followSpec,
          type: "supersede",
          fixed: acTarget,
          label: "Follow the spec: supersede the AC (give the corrected AC text)",
        },
        {
          id: PREFLIGHT_OPTION_IDS.reconcile,
          type: "supersede",
          fixed: acTarget,
          label: "Reconcile: rewrite the AC so it satisfies both (give the text)",
        },
      ]
    : [];
  return [
    ...followAc,
    ...onAc,
    {
      id: PREFLIGHT_OPTION_IDS.flag,
      type: "hold",
      label: "Flag for a human: the story runs under a stated default (put the default in reason)",
    },
  ];
}

function supersedeDraft(
  citesAc: { storyId: string; acId: string } | undefined,
  citesSpecSection: string | undefined,
  acceptanceEnabledForStory: boolean,
): Draft[] {
  if (citesAc && !acceptanceEnabledForStory) {
    return [{ type: "supersede", fixed: { target: { kind: "ac", ...citesAc } } }];
  }
  if (citesSpecSection) return [{ type: "supersede", fixed: { target: { kind: "spec", section: citesSpecSection } } }];
  return [];
}

function giveUpDrafts(f: Extract<MenuFacts, { kind: "fix-cycle-give-up" }>): Draft[] {
  if (!f.budgetLeft) return [{ type: "escalate-tier" }, { type: "defer" }];
  const retarget: Draft[] =
    f.retargetAvailable && (f.gaveUpTarget === "test" || f.isThreeSession)
      ? [{ type: "retarget", fixed: { to: f.gaveUpTarget === "source" ? "test" : "source" } }]
      : [];
  return [
    ...(f.retryAvailable ? [{ type: "retry" as const }] : []),
    ...retarget,
    { type: "waive" },
    ...supersedeDraft(f.citesAc, undefined, f.acceptanceEnabledForStory),
    { type: "escalate-tier" },
    { type: "defer" },
  ];
}

/** Branch adjudication has no later review step, so a real defect can only be accepted or flagged (#2496). */
function residualDrafts(f: Extract<MenuFacts, { kind: "residual" }>): Draft[] {
  if (f.scope === "branch") {
    return [
      { type: "waive", label: "Accept the risk: say in reason why it is safe to ship" },
      { type: "hold", label: "A human must decide before this is marked ready" },
    ];
  }
  return [
    { type: "waive", label: "Park: the reviewer is wrong (say why in reason)" },
    { type: "defer", label: "Park: real, but defer it to the branch review (say why in reason)" },
    ...(f.dependents.length > 0
      ? [
          {
            type: "carry" as const,
            fixed: { toStories: f.dependents },
            label: `Load-bearing: carry an instruction into ${f.dependents.join(", ")}`,
          },
        ]
      : []),
    { type: "hold", label: "Flag for a human" },
  ];
}

function fixDrafts(pinnedAcs: string[] | undefined): Draft[] {
  if (!pinnedAcs || pinnedAcs.length === 0) return [{ type: "fix" }];
  return [
    { type: "fix", label: "Fix without changing the acceptance tests" },
    {
      type: "fix",
      fixed: { updateAcs: pinnedAcs },
      label: `Fix, and update acceptance tests ${pinnedAcs.join(", ")} (say what changes in them)`,
    },
  ];
}

export function buildMenu(facts: MenuFacts): AdviceOption[] {
  switch (facts.kind) {
    case "finish-judgment":
      return withIds([
        ...fixDrafts(facts.pinnedAcs),
        { type: "waive" },
        ...supersedeDraft(facts.citesAc, facts.citesSpecSection, facts.acceptanceEnabledForStory),
        { type: "hold" },
      ]);
    case "fix-cycle-give-up":
      return withIds(giveUpDrafts(facts));
    case "uncategorised-failure":
      return withIds([
        ...(facts.isThreeSession && !facts.isLite ? [{ type: "retry-as-lite" as const }] : []),
        { type: "escalate-tier" },
        { type: "defer" },
      ]);
    case "finish-approval":
      return withIds([
        ...(facts.allPhasesComplete && facts.gatesGreen ? [{ type: "approve" as const }] : []),
        ...(facts.reReviewUsed ? [] : [{ type: "re-review" as const, fixed: { phase: facts.reReviewPhase } }]),
        { type: "hold" },
      ]);
    case "implementer-question":
      return withIds([
        { type: "answer" },
        { type: "hold", label: "No answer: the implementer goes on to review with its concern" },
      ]);
    case "residual":
      return withIds(residualDrafts(facts));
    case "preflight":
      return withIds(preflightDrafts(facts));
  }
}

/** Merge the option's fixed parameters with the reply's text into a concrete action. */
export function toAction(option: AdviceOption, reply: AdvisorReply): AdviceAction {
  const text = (k: "instruction" | "reason" | "newText"): string => reply[k] ?? "";
  switch (option.type) {
    case "fix":
      return {
        type: "fix",
        instruction: text("instruction"),
        ...(option.fixed?.updateAcs ? { updateAcs: option.fixed.updateAcs } : {}),
      };
    case "retry":
      return { type: "retry", instruction: text("instruction") };
    case "retarget":
      return { type: "retarget", to: option.fixed?.to ?? "source", instruction: text("instruction") };
    case "waive":
    case "escalate-tier":
    case "defer":
    case "hold":
      return { type: option.type, reason: text("reason") };
    case "supersede":
      return {
        type: "supersede",
        target: option.fixed?.target ?? { kind: "spec", section: "unspecified" },
        newText: text("newText"),
      };
    case "re-review":
      return { type: "re-review", phase: option.fixed?.phase ?? "quality" };
    case "answer":
      return { type: "answer", text: text("instruction") };
    case "carry":
      return { type: "carry", instruction: text("instruction"), toStories: option.fixed?.toStories ?? [] };
    case "retry-as-lite":
    case "approve":
      return { type: option.type };
  }
}

const BLOCKING_SEVERITIES = new Set(["HIGH", "CRITICAL", "error", "critical"]);

/** Spec §4.3: flags nax forces on regardless of what the advisor reported. */
export function forcedConfirm(action: AdviceAction, reply: AdvisorReply, findingSeverity?: string): boolean {
  if (reply.needsHumanConfirm || reply.confidence === "low" || !reply.reversible) return true;
  if (action.type === "supersede" || action.type === "defer" || action.type === "hold") return true;
  return action.type === "waive" && findingSeverity !== undefined && BLOCKING_SEVERITIES.has(findingSeverity);
}
