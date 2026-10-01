/**
 * Assembling the reviewer and fixer prompts from the generated prose.
 *
 * Ported from `flows/nax-finish/review-prompts.ts` (D5). The prose itself
 * (`SPEC_REVIEW_DIMENSIONS`, `QUALITY_REVIEW_DIMENSIONS`,
 * `WORKER_PROTOCOL_MECHANICS`, `FINDING_BLOCK_SHAPE`) does not move here — it
 * is generated onto `./prompts.gen` from `src/finish/review/references/*.md`
 * and this module only imports it. What ports is the assembly logic: the
 * reply contract, the classifier line, and the two prompt builders.
 */
import type { Finding, FinishPhase } from "../types";
import {
  FINDING_BLOCK_SHAPE,
  QUALITY_REVIEW_DIMENSIONS,
  SPEC_REVIEW_DIMENSIONS,
  WORKER_PROTOCOL_MECHANICS,
} from "./prompts.gen";

const CLASSIFIER = [
  "Mark a finding for human judgment — and only such a finding — by adding a",
  "`Judgment: yes — <why>` line to its block. Use it when the finding is a spec",
  "conflict, or a design/judgment call with no safe mechanical fix. Everything",
  "else will be fixed and re-verified automatically, so a finding with a clear,",
  "low-risk fix must NOT carry the marker.",
].join("\n");

/**
 * The reply contract.
 *
 * The only reply contract this module assembles. `WORKER_PROTOCOL_MECHANICS`
 * (unlike the skill's `WORKER_PROTOCOL`) carries no output-format section of
 * its own, so there is nothing here for `outputContract`'s `## FINDINGS` to
 * contradict — the #1625 regression this guards against.
 *
 * The two sections before `## FINDINGS` are what this module adds, because
 * nax-finish — unlike the skill's dispatcher — has no human reading the reply
 * and so must be able to check the obligations itself.
 *
 * There is no JSON. A reply constrained to one JSON object has nowhere to put
 * the per-AC and per-function enumerations both dimension references depend
 * on, and an unreadable object used to discard the entire review (#1614).
 */
function outputContract(phase: "spec" | "quality"): string {
  const walk =
    phase === "spec"
      ? "one line per AC in the spec: `AC-3 Covered|Partial|Missing — <one clause>`"
      : "one line per file the diff adds or changes: `path.ts — earns its place|concern: <one clause>`";
  return `# Reply contract — your reply must be these three sections, in this order

## TOUCHPOINTS
One line per external touchpoint whose definition you actually opened:
\`- path/to/file.ts:symbol — why you opened it\`. If the diff genuinely has none,
the single line \`- none — <justification>\`. The paths are checked against the
repo: a list whose paths do not exist is treated as an incomplete review, not a
clean one, and you will be asked again.

## WALK
${walk}. This is the enumeration your dimension reference requires. One line each,
no prose. A missing or empty WALK section is an incomplete review.

## FINDINGS
One block per finding, in exactly this shape:

${FINDING_BLOCK_SHAPE}

Or the literal line \`No findings.\` if you found none. This section is the only
thing that becomes a finding; the two above are the evidence that you were in a
position to write it.`;
}

/**
 * Build the reviewer prompt.
 *
 * With `since` set this is a **re-review**: the same reviewer already read the
 * whole branch and raised `priorFindings`, a fix was applied and committed, and
 * the only new material is `since..HEAD`. Re-reading the full branch diff every
 * round made reviews 58% of the flow's wall clock, most of it re-reading code an
 * earlier round had already cleared. The narrowed round still has the full repo
 * available — it is told to open whatever the fix touches — it just is not asked
 * to re-derive a verdict on unchanged code.
 *
 * `since` is the parent of the *first* commit that landed after the previous
 * verdict, not of the latest one (see `incrementalSince`) — the acceptance loop
 * can commit between a spec fix and its re-review, and the window has to span
 * both. So `since..HEAD` provably contains every change made since that
 * verdict, however many commits that took, and it is never supplied at all when
 * no commit landed.
 */
export function buildReviewPrompt(
  phase: "spec" | "quality",
  args: {
    base: string;
    specPath: string;
    since?: string | null;
    priorFindings?: Finding[];
    gaps?: string[];
  },
): string {
  const dims = phase === "spec" ? SPEC_REVIEW_DIMENSIONS : QUALITY_REVIEW_DIMENSIONS;
  const gapNotice =
    args.gaps && args.gaps.length > 0
      ? [
          [
            "IMPORTANT — your previous review was not accepted, because it skipped a required section:",
            ...args.gaps.map((g) => `- ${g}`),
            "Do the reading this time and emit all three sections. A verdict without them is not a review.",
          ].join("\n"),
        ]
      : [];
  if (!args.since) {
    const specNotice =
      phase === "spec" && args.specPath ? [`The spec/requirements source is: ${args.specPath}. Read it in full.`] : [];
    return [
      ...gapNotice,
      `You are the ${phase.toUpperCase()} reviewer for a completed feature.`,
      ...specNotice,
      `Fetch and review the diff: \`git diff ${args.base}...HEAD\` (also \`--name-only\` for the file list).`,
      WORKER_PROTOCOL_MECHANICS,
      dims,
      CLASSIFIER,
      outputContract(phase),
    ].join("\n\n");
  }
  const reReviewBody = [
    `You are the ${phase.toUpperCase()} reviewer for a completed feature, continuing a review you already started.`,
    `On your previous pass over \`git diff ${args.base}...HEAD\` you raised the findings below, and they have since been fixed and committed. Everything else in that diff you already judged acceptable — do not re-derive a verdict on it.`,
    `Your findings from the previous pass:\n${JSON.stringify(args.priorFindings ?? [], null, 2)}`,
    `The fix is \`git diff ${args.since}..HEAD\` — this is the only code that has changed since your last verdict. Review it, and only it, for two questions:`,
    [
      "1. **Resolved?** Does the fix actually resolve each finding above? A finding that was papered over (assertion weakened, test deleted, check disabled) is NOT resolved — re-raise it.",
      "2. **Broken?** Did the fix introduce a new problem, in the changed lines or in the unchanged code they now call into?",
      "",
      ...(phase === "spec" && args.specPath
        ? [
            `Read whatever files you need — the spec is at ${args.specPath} and the whole repo is available. Scope means *what you judge*, not *what you may read*.`,
          ]
        : [
            "Read whatever files you need — the whole repo is available. Scope means *what you judge*, not *what you may read*.",
          ]),
    ].join("\n"),
    WORKER_PROTOCOL_MECHANICS,
    dims,
    CLASSIFIER,
    outputContract(phase),
  ];
  return [...gapNotice, ...reReviewBody].join("\n\n");
}

/**
 * The fix node's contract.
 *
 * For the two review phases it is no longer "apply these". Every finding used
 * to be implemented unconditionally, so a false positive was always built —
 * and on the diff behind #1614 the comparison review raised one finding a
 * human withdrew, because the change it proposed contradicted a test
 * deliberately pinning the current behaviour. `quality_gates` would then have
 * proved the resulting suite green. Reporting more findings without a way to
 * reject one scales the false-positive exposure with the true-positive one, so
 * the two ship together.
 *
 * A rejection must cite the file:line that pins the behaviour: an unevidenced
 * "I disagree" is how a real finding gets waived, and `commit_<phase>` checks
 * that the cited path exists.
 *
 * Reshaped from the flow's `fixPrompt(phase, { outputs })` — which read an
 * acpx `ctx.outputs` bag keyed by node name — into explicit arguments, since
 * there is no acpx graph here. The `gate`/`acceptance` branch reads
 * `gateOutput`/`acceptanceOutput`; the `spec`/`quality` branch numbers
 * `findings` 1-based, in the order given. That numbering is the contract a
 * later `## DISPOSITIONS` reply indexes rejections by — get it wrong and a
 * rejection silently attaches to the wrong finding.
 */
export function buildFixPrompt(
  phase: FinishPhase,
  args: { findings?: Finding[]; gateOutput?: string; acceptanceOutput?: string },
): string {
  if (phase === "gate" || phase === "acceptance") {
    const detail = phase === "gate" ? (args.gateOutput ?? "") : (args.acceptanceOutput ?? "");
    return [
      `Apply the recommended fixes for the ${phase} phase, directly in the repo.`,
      "Do not commit, push, or open PRs — nax-finish commits and pushes your edits itself.",
      `Context:\n${detail}`,
      "After fixing, re-run the feature's acceptance tests and the relevant checks; only proceed when they pass.",
      'Return exactly {"route":"proceed"} when done and green.',
    ].join("\n\n");
  }
  const findings = args.findings ?? [];
  const numbered = findings
    .map((f, i) => `[${i + 1}] [${f.severity}] ${f.title}\n  Problem: ${f.problem}\n  Fix: ${f.fix}`)
    .join("\n");
  return [
    `Resolve the ${phase} review findings below, directly in the repo.`,
    "Do not commit, push, or open PRs — nax-finish commits and pushes your edits itself.",
    numbered,
    [
      "A finding may be REJECTED rather than fixed — but only on evidence, not on preference.",
      "Reject when the change it asks for would contradict an existing test that deliberately",
      "pins the current behaviour, or a spec statement that requires it. Cite the `file:line`.",
      "Anything else you fix.",
    ].join("\n"),
    [
      "After fixing, re-run the feature's acceptance tests and the relevant checks; only proceed when they pass.",
      "Then end your reply with one line per finding, in this exact shape:",
      "",
      "## DISPOSITIONS",
      "[1] fixed",
      "[2] rejected — evidence: test/unit/foo.test.ts:42",
    ].join("\n"),
  ].join("\n\n");
}
