/**
 * flow-handoff-input.ts — the handoff form of `nax-flow__send`: one feature the
 * chat already ran, handed to koda to publish and finish.
 *
 * The specs of such a feature are already on the branch and its run record is
 * local, so the form carries no spec paths: just the feature name, beside the same
 * two role models and the same cap the spec form sends. The role and cost-cap
 * checks come from `flow-input.ts` rather than being restated, because koda bills
 * one cap against one pair of model strings whatever the form — a second copy would
 * drift from the first.
 *
 * Like the spec form, this collects every violation instead of stopping at the
 * first, so one round of retries fixes a request with several mistakes.
 */
import {
  type Collected,
  collectCostCap,
  collectRoles,
  FLOW_FEATURE_NAME_RE,
  type FlowSendRoles,
  isRecord,
  quoted,
  unknownKeys,
} from "./flow-input";

/**
 * The qualified tool name a chain step's argv starts with. Spelled here rather than
 * imported from `flow-provider.ts`: the provider is the caller of this fixed leaf, so
 * an import back would close a cycle.
 */
const HANDOFF_TOOL_NAME = "nax-flow__send";
/** The flag that makes a chain step the handoff form rather than a spec-form send. */
const HANDOFF_FLAG = "--handoff";
/** The three flags that carry the roles and the cap, as the step's argv spells them. */
const REVIEWER_FLAG = "--reviewer";
const SUPERVISOR_FLAG = "--supervisor";
const COST_CAP_FLAG = "--cost-cap";
/** The keys the handoff form declares at the top level: the feature, the roles, the cap. */
const HANDOFF_INPUT_KEYS = ["handoff", "roles", "costCapUsd"] as const;
/** The handoff object declares the feature and nothing else: a spec path is the other form's. */
const HANDOFF_KEYS = ["feature"] as const;

/** One feature handed to koda, with the roles and cap its flow runs under. */
export interface FlowHandoffInput {
  readonly feature: string;
  readonly roles: FlowSendRoles;
  readonly costCapUsd: number;
}

/** The parsed handoff, or every rule it broke. */
export type FlowHandoffParseResult = FlowHandoffInput | { readonly errors: string[] };

/** The feature's name: the charset koda accepts, named as the handoff's own field. */
function handoffFeatureErrors(value: unknown): string[] {
  const where = "handoff.feature";
  if (typeof value !== "string") return [`${where} must be a string`];
  return FLOW_FEATURE_NAME_RE.test(value)
    ? []
    : [`${where} ${quoted(value)} must match ${FLOW_FEATURE_NAME_RE.source}`];
}

/** The `handoff` object: its declared keys, then the feature name. */
function collectHandoff(value: unknown): Collected<string> {
  if (!isRecord(value)) return { value: "", errors: ["handoff must be an object"] };
  const feature = value.feature;
  const errors = [...unknownKeys(value, HANDOFF_KEYS, "handoff"), ...handoffFeatureErrors(feature)];
  return { value: typeof feature === "string" ? feature : "", errors };
}

/**
 * Check a handoff-form `nax-flow__send` request before anything is read or pushed.
 *
 * @param raw - The tool input as the model produced it; the shape is checked here
 * @returns The parsed handoff, or every error it must be retried with
 */
export function parseFlowHandoffInput(raw: Record<string, unknown>): FlowHandoffParseResult {
  const handoff = collectHandoff(raw.handoff);
  const roles = collectRoles(raw.roles);
  const costCap = collectCostCap(raw.costCapUsd);
  const errors = [
    ...unknownKeys(raw, HANDOFF_INPUT_KEYS, "the handoff input"),
    ...handoff.errors,
    ...roles.errors,
    ...costCap.errors,
  ];
  if (errors.length > 0) return { errors };
  return { feature: handoff.value, roles: roles.value, costCapUsd: costCap.value };
}

/**
 * The token list a chain step and the tool call are compared by: the handoff form's
 * input as the argv a `handoff` step declares, so admission compares one spelling.
 *
 * @param input - A parsed handoff input
 */
export function handoffStepArgv(input: FlowHandoffInput): readonly string[] {
  return [
    HANDOFF_TOOL_NAME,
    HANDOFF_FLAG,
    input.feature,
    REVIEWER_FLAG,
    input.roles.reviewer,
    SUPERVISOR_FLAG,
    input.roles.supervisor,
    COST_CAP_FLAG,
    String(input.costCapUsd),
  ];
}
