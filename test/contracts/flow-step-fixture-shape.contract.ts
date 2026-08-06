/**
 * Type-level contract: the flow-step fixtures must stay assignable to acpx's
 * real `FlowStepRecord` and to `FlowRunState["steps"]`.
 *
 * Why this file exists rather than relying on the annotations in the factory
 * itself: `tsconfig.json` excludes `test`, so nothing under `test/unit/` or
 * `test/helpers/` is compiled by `bun run typecheck` — the annotations there are
 * editor-time only. `test/contracts/` IS compiled (`tsconfig.contracts.json`),
 * and tsc follows these imports, so pulling the factory in here is what turns
 * "the fixtures match acpx's shape" from a comment into a CI gate.
 *
 * If acpx renames, retypes or adds a required field on `FlowStepRecord`, this
 * file fails to compile — which is the whole point of building the fixtures out
 * of the real type instead of `{ nodeId, output }` literals cast `as never`.
 */
import type { FlowRunState, FlowStepRecord } from "acpx/flows";
import { makeFlowCtx, makeFlowStep, makeFlowSteps, reviewRounds } from "../helpers/flow-steps";

const _step: FlowStepRecord = makeFlowStep("review_spec");
const _overridden: FlowStepRecord = makeFlowStep("commit_spec", { output: { shaBefore: "abc" } });
const _steps: FlowStepRecord[] = makeFlowSteps(["review_spec", ["commit_spec", { shaBefore: "abc" }]]);
const _rounds: FlowStepRecord[] = reviewRounds("quality", 1, { route: "reprompt", findings: [] });
const _ctxSteps: FlowRunState["steps"] = makeFlowCtx({ steps: _steps }).state.steps;

void _step;
void _overridden;
void _steps;
void _rounds;
void _ctxSteps;
