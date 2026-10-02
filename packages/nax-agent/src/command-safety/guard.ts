/**
 * The P5 flag-for-review guard (US-003).
 *
 * The shadow observes every command. The guard, when configured, composes a
 * score from the same rule result and the same classifier promise the shadow
 * awaits, decides whether to flag, and names the dominant category. It is
 * total by construction — it never rejects, never asks, never denies; the
 * caller (US-004's tool ask routing) decides what a flag means downstream.
 *
 * `scoreGuard` is the pure decision table `assess` composes. It is exported
 * so two rules `assess` alone cannot express — the temp-only exemption's
 * `outside_project` skip and the harm-tie-breaker — stay unit-testable.
 */
import { isTempOnly } from "./temp-only";
import type { CommandGuard, GuardDecision, GuardInput, ModelResult, QuestionId, RuleResult } from "./types";
import { QUESTION_IDS } from "./types";

/**
 * The first category in `QUESTION_IDS` order that `hits` sets to true.
 * `skip` removes categories the caller has already accounted for
 * (temp-only drops `outside_project`).
 */
function firstHit(
  hits: Readonly<Record<QuestionId, boolean>>,
  skip: ReadonlySet<QuestionId> = new Set(),
): QuestionId | undefined {
  for (const id of QUESTION_IDS) {
    if (skip.has(id)) continue;
    if (hits[id]) return id;
  }
  return undefined;
}

/**
 * `harm = 1 - P(none)`; `noulMax = max P(yes)` over the six noul questions;
 * `modelScore = (harm + noulMax) / 2`.
 *
 * The harm category other than `none` with the highest probability names
 * the decision; ties go to `QUESTION_IDS` order. Both halves are bounded
 * by `[0, 1]`, so the score is too.
 */
function scoreFromAnswer(answer: Extract<ModelResult, { status: "answered" }>): {
  score: number;
  category: QuestionId | undefined;
} {
  const harm = 1 - answer.answers.harm.none;
  const noulMax = Math.max(...QUESTION_IDS.map((id) => answer.answers.noul[id]));
  let topProb = -Infinity;
  let topId: QuestionId | undefined;
  for (const id of QUESTION_IDS) {
    const p = answer.answers.harm[id];
    if (p > topProb) {
      topProb = p;
      topId = id;
    }
  }
  return { score: (harm + noulMax) / 2, category: topId };
}

/** True when any of the six rule categories hits. `outside_project` is included. */
function ruleScore(rules: RuleResult): number {
  return QUESTION_IDS.some((id) => rules.hits[id]) ? 1 : 0;
}

/**
 * Temp-only variant of `ruleScore`: `outside_project` is skipped, since the
 * temp-only exemption routes around it. A path entirely outside the project
 * is acceptable while the sandbox confines temp writes; the classifier is
 * not consulted for the assessment.
 */
function ruleScoreTempOnly(rules: RuleResult): number {
  return QUESTION_IDS.some((id) => id !== "outside_project" && rules.hits[id]) ? 1 : 0;
}

/**
 * The pure scorer: rules + classifier + temp-only state + threshold.
 *
 * `model` is `undefined` when the temp-only check skipped the classifier
 * (the shadow's row still classifies, but the guard does not consult it).
 * The temp-only basis still applies the rule score — a temp-only command
 * that trips a non-`outside_project` rule (e.g. `rm -rf /tmp/x` hits
 * `deletes_data`) flags, while `outside_project` alone scores 0.
 */
export function scoreGuard(input: {
  readonly rules: RuleResult;
  readonly model: ModelResult | undefined;
  readonly tempOnly: boolean;
  readonly threshold: number;
}): GuardDecision {
  const { rules, model, tempOnly, threshold } = input;

  // Temp-only path: the classifier is skipped. A rule hit scores 1;
  // `outside_project` is exempt. An empty hit set scores 0. The basis
  // names the exemption even when a rule carries the flag.
  if (tempOnly) {
    const score = ruleScoreTempOnly(rules);
    const flagged = score >= threshold;
    // Per spec: category is present when a rule hit carries the flag.
    // `outside_project` is exempt under the temp-only check, so it never
    // names a temp-only decision.
    const category = flagged ? firstHit(rules.hits, new Set<QuestionId>(["outside_project"])) : undefined;
    return {
      flagged,
      score,
      threshold,
      basis: "temp-only",
      ...(category !== undefined ? { category } : {}),
    };
  }

  // Classifier unreachable / oversized / rejected / unavailable: rules-only.
  if (model === undefined || model.status === "oversize" || model.status === "unavailable") {
    const score = ruleScore(rules);
    const flagged = score >= threshold;
    const category = flagged ? firstHit(rules.hits) : undefined;
    return {
      flagged,
      score,
      threshold,
      basis: "rules",
      ...(category !== undefined ? { category } : {}),
    };
  }

  if (model.status === "blocked") {
    // The server refuses to score; the guard treats that as a hard flag.
    // A rule hit still carries its category.
    const category = firstHit(rules.hits);
    return {
      flagged: true,
      score: 1,
      threshold,
      basis: "model",
      ...(category !== undefined ? { category } : {}),
    };
  }

  // Answered. The model score composites over the rule score; the higher
  // wins. The category names the dominant harm, never an `outside_project`
  // temp-only skip (the temp-only branch above has already exited).
  const { score: modelScore, category: modelCategory } = scoreFromAnswer(model);
  const rs = ruleScore(rules);
  const score = Math.max(rs, modelScore);
  const flagged = score >= threshold;
  // Rule hits always name the decision (first hit in QUESTION_IDS order);
  // the harm top otherwise carries it — but the spec drops the category on
  // any unflagged decision, so a benign answered row never names a harm.
  const category = rs === 1 ? firstHit(rules.hits) : flagged ? modelCategory : undefined;
  return {
    flagged,
    score,
    threshold,
    basis: "model",
    ...(category !== undefined ? { category } : {}),
  };
}

/**
 * Build a `CommandGuard` from the shadow's rule scorer and the cached
 * classifier promise it shares with the shadow.
 *
 * The guard never throws: every step of `assess` (rule scoring, the temp-
 * only check, the cached classify, the decision table) is wrapped in a
 * single try/catch that falls through to a no-rule / no-model rules-only
 * decision with score 0. The shadow classifies once per command; `assess`
 * awaits the cached promise rather than re-classifying.
 */
export function createCommandGuard(opts: {
  readonly threshold: number;
  readonly scoreRules: (command: string, cwd: string | undefined) => RuleResult;
  /** Returns the cached classifier promise for `command`. */
  readonly classifyCached: (command: string) => Promise<ModelResult>;
}): CommandGuard {
  const { threshold, scoreRules: rules, classifyCached } = opts;

  async function assess(input: GuardInput): Promise<GuardDecision> {
    // Safe defaults for the catch path: no rule hit, no classifier consulted,
    // so the rules-only branch scores 0 with no category. Anything that
    // throws — an injected scoreRules that rejects, lexBashCommand on a
    // non-string command, a malformed ModelResult passed directly — lands
    // here without ever propagating a rejection to the caller.
    const fallback: RuleResult = { version: 0, hits: emptyHits() };
    try {
      const scoredRules = rules(input.command, input.cwd);
      const tempOnly = input.tempConfined && isTempOnly(input.command, input.cwd);
      let model: ModelResult | undefined;
      if (!tempOnly) {
        // `classifyCached` is total by contract (a synchronous throw inside
        // the shadow already maps to `unavailable/threw`); the try is the
        // belt for a genuine rejection.
        model = await classifyCached(input.command);
      }
      return scoreGuard({ rules: scoredRules, model, tempOnly, threshold });
    } catch {
      return scoreGuard({ rules: fallback, model: undefined, tempOnly: false, threshold });
    }
  }

  return { threshold, assess };
}

/** Six `false` rule hits, kept here so the catch path never reaches for
 *  partial state. `version` is `0` to mark the result as "did not score". */
function emptyHits(): Readonly<Record<QuestionId, boolean>> {
  return Object.freeze(Object.fromEntries(QUESTION_IDS.map((id) => [id, false]))) as Readonly<
    Record<QuestionId, boolean>
  >;
}
